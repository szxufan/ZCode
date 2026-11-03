import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

import {
  parseRelayV3OutgoingMessage,
  RELAY_V3_WS_PATH,
  type RelayV3AuthInit,
  type RelayV3IncomingMessage,
  type RelayV3Meta,
  type RelayV3Role,
} from "@zcode/shared/remote-relay-v3";

import type { DeviceRow } from "../db.js";
import { RELAY_LIMITS } from "../limits.js";
import type { RelayPresence } from "../presence.js";
import type { RelayRuntime } from "../runtime.js";

// §5.2 WebSocket 配对。relay 是设备、一次性 token、连接与 (SID, role) 当前
// owner 的唯一事实源：先验证归属，再替换同角色旧 owner（device 侧 KICKED；
// terminal 侧单 active terminal，旧 terminal 收 waiting 并被关闭）；旧连接异步
// close 不得移除新 owner。数据只发给同 SID 的另一角色，relay 不读取、不解析
// payload 内容（仅校验为合法 JSON 对象且长度在预算内）。

interface Connection {
  id: string;
  socket: WebSocket;
  accountId: string;
  role: RelayV3Role;
  deviceSid?: string;
  terminalSid: string;
  meta: RelayV3Meta;
  presenceMeta: { meta: Record<string, unknown> };
  authed: boolean;
  lastSeen: number;
  queue: string[];
  queueSaturatedSince?: number;
  handshakeTimer?: ReturnType<typeof setTimeout>;
  pingTimer?: ReturnType<typeof setInterval>;
  closed: boolean;
}

export function attachRelayWebSocket(
  app: FastifyInstance,
  deps: {
    db: DatabaseSync;
    runtime: RelayRuntime;
    presence: RelayPresence;
  },
): void {
  const { db, runtime, presence } = deps;
  const connections = new Set<Connection>();
  const owners = new Map<string, Partial<Record<RelayV3Role, Connection>>>();
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: RELAY_LIMITS.wsMaxMessageBytes,
  });
  // 出站队列排空泵：ws 无 drain 事件，统一以低频定时器冲刷。
  const flushTimer = setInterval(() => {
    for (const connection of connections) flushQueue(connection);
  }, 50);

  const now = () => runtime.now();

  /** 入队发送；队满且持续 2s 无法入队即丢弃该帧（§8）。 */
  const send = (connection: Connection, message: RelayV3IncomingMessage): boolean => {
    const text = JSON.stringify({ ...message, server_ts: Math.floor(now() / 1000) });
    if (connection.socket.readyState !== WebSocket.OPEN) return false;
    if (
      connection.socket.bufferedAmount < RELAY_LIMITS.wsOutboundBufferBytes &&
      connection.queue.length === 0
    ) {
      connection.socket.send(text);
      return true;
    }
    if (connection.queue.length >= RELAY_LIMITS.wsOutboundQueueLimit) {
      if (connection.queueSaturatedSince === undefined) {
        connection.queueSaturatedSince = now();
      } else if (now() - connection.queueSaturatedSince >= RELAY_LIMITS.wsOutboundSaturatedDropMs) {
        // 持续饱和：丢弃该帧（心跳/状态类小帧，丢帧后由客户端重连语义兜底）。
        return false;
      }
    }
    connection.queue.push(text);
    return true;
  };

  function flushQueue(connection: Connection): void {
    if (connection.queue.length === 0) return;
    if (connection.socket.readyState !== WebSocket.OPEN) {
      connection.queue = [];
      connection.queueSaturatedSince = undefined;
      return;
    }
    while (
      connection.queue.length > 0 &&
      connection.socket.bufferedAmount < RELAY_LIMITS.wsOutboundBufferBytes
    ) {
      const text = connection.queue.shift();
      if (text === undefined) break;
      connection.socket.send(text);
    }
    if (connection.queue.length === 0) connection.queueSaturatedSince = undefined;
  }

  const peer = (connection: Connection) =>
    owners.get(connection.deviceSid ?? "")?.[connection.role === "device" ? "terminal" : "device"];

  const closeConnection = (connection: Connection) => {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.handshakeTimer);
    clearInterval(connection.pingTimer);
    connections.delete(connection);
    try {
      connection.socket.close();
    } catch {
      connection.socket.terminate();
    }
    if (!connection.deviceSid) return;
    // 释放必须传注册时的同一对象（identity 比较），旧连接异步 close 不得移除新 owner。
    presence.releaseRole(connection.deviceSid, connection.role, connection.presenceMeta);
    // 被替换连接的 close 晚于新认证完成，必须按连接身份释放，不能只按 SID/role 删除。
    const roles = owners.get(connection.deviceSid);
    if (roles?.[connection.role] !== connection) return;
    delete roles[connection.role];
    const other = peer(connection);
    if (other) {
      send(other, { type: "pair_status_ack", pair_status: "waiting", terminal_sid: "" });
      if (connection.role === "device") {
        send(other, { type: "error", code: "DEVICE_OFFLINE" });
        closeConnection(other);
      }
    }
    if (roles && !roles.device && !roles.terminal) owners.delete(connection.deviceSid);
  };

  const handleAuthInit = (connection: Connection, parsed: RelayV3AuthInit) => {
    if (connection.authed) {
      send(connection, { type: "error", code: "WRONG_PARAM" });
      closeConnection(connection);
      return;
    }
    const row = db
      .prepare("SELECT * FROM devices WHERE sid = ? AND deleted_at IS NULL")
      .get(parsed.device_sid) as DeviceRow | undefined;
    if (!row || row.account_id !== connection.accountId) {
      send(connection, { type: "error", code: "AUTH_FAILED" });
      closeConnection(connection);
      return;
    }
    // 角色与 auth_init 形态必须匹配（token 绑定角色，§5.2）。
    const terminalPublicKey =
      "terminal_public_key" in parsed ? parsed.terminal_public_key : undefined;
    if (connection.role === "terminal" && !terminalPublicKey) {
      send(connection, { type: "error", code: "WRONG_PARAM" });
      closeConnection(connection);
      return;
    }
    if (connection.role === "device" && terminalPublicKey) {
      send(connection, { type: "error", code: "WRONG_PARAM" });
      closeConnection(connection);
      return;
    }
    connection.deviceSid = parsed.device_sid;
    connection.authed = true;
    clearTimeout(connection.handshakeTimer);
    if ("meta" in parsed && parsed.meta) connection.meta = parsed.meta;
    connection.presenceMeta = { meta: connection.meta as Record<string, unknown> };
    presence.setRole(parsed.device_sid, connection.role, connection.presenceMeta);

    const roles = owners.get(parsed.device_sid) ?? {};
    if (connection.role === "device") {
      const old = roles.device;
      roles.device = connection;
      if (old && old !== connection) {
        send(old, { type: "error", code: "KICKED" });
        closeConnection(old);
      }
    } else {
      // 单 active terminal：新 terminal 配对成功后旧 terminal 收 waiting 并被关闭（§5.2）。
      const old = roles.terminal;
      roles.terminal = connection;
      if (old && old !== connection) {
        send(old, { type: "pair_status_ack", pair_status: "waiting", terminal_sid: "" });
        closeConnection(old);
      }
    }
    owners.set(parsed.device_sid, roles);

    const other = peer(connection);
    const pairStatus = other ? "matched" : "waiting";
    if (other) {
      if (connection.role === "terminal") {
        send(other, {
          type: "pair_status_ack",
          pair_status: "matched",
          terminal_sid: connection.terminalSid,
          terminal_public_key: terminalPublicKey!,
        });
      } else {
        send(other, {
          type: "pair_status_ack",
          pair_status: "matched",
          terminal_sid: other.terminalSid,
        });
      }
    }
    send(connection, {
      type: "auth_ack",
      device_sid: parsed.device_sid,
      terminal_sid: connection.terminalSid,
      pair_status: pairStatus,
    });
  };

  const handleMessage = (connection: Connection, data: unknown, isBinary: boolean) => {
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      message = String(data);
    }
    const parsed = isBinary ? null : parseRelayV3OutgoingMessage(message);
    if (!parsed) {
      send(connection, { type: "error", code: "WRONG_PARAM" });
      closeConnection(connection);
      return;
    }
    if (parsed.type === "auth_init") {
      handleAuthInit(connection, parsed);
      return;
    }
    // 未认证不能发 data/query；重复认证已在上面的 WRONG_PARAM 分支关闭。
    if (!connection.authed || !connection.deviceSid) {
      send(connection, { type: "error", code: "AUTH_FAILED" });
      closeConnection(connection);
      return;
    }
    if (parsed.type === "pair_status_query") {
      const terminal = owners.get(connection.deviceSid)?.terminal;
      const other = peer(connection);
      send(connection, {
        type: "pair_status_ack",
        pair_status: other ? "matched" : "waiting",
        terminal_sid:
          connection.role === "device" ? (terminal?.terminalSid ?? "") : connection.terminalSid,
      });
      return;
    }
    // data：只发给同 SID 的另一角色；payload 不解析（契约层已校验为 JSON 对象）。
    const other = peer(connection);
    if (other) send(other, { type: "data", payload: parsed.payload });
    else send(connection, { type: "error", code: "INTERNAL" });
  };

  app.addHook("onReady", () => {
    const server = app.server;
    if (!server) return;
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== RELAY_V3_WS_PATH) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      // 一次性 token：Upgrade 前原子消费；过期不影响已建立的连接（§5.2）。
      const identity = runtime.consumeWsToken(url.searchParams.get("token") ?? "");
      if (!identity) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      if (connections.size >= RELAY_LIMITS.wsConnections) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
      }
      wsServer.handleUpgrade(request, socket, head, (ws) => {
        const connection: Connection = {
          id: randomUUID(),
          socket: ws,
          accountId: identity.accountId,
          role: identity.role,
          terminalSid: identity.role === "terminal" ? `t_${randomUUID().slice(0, 8)}` : "",
          meta: {},
          presenceMeta: { meta: {} },
          authed: false,
          lastSeen: now(),
          queue: [],
          closed: false,
        };
        connections.add(connection);
        // 握手（auth_init → auth_ack）15s deadline。
        connection.handshakeTimer = setTimeout(() => {
          if (!connection.authed) closeConnection(connection);
        }, RELAY_LIMITS.wsHandshakeDeadlineMs);
        // 服务端 ping + 45s liveness：pong 与任意应用帧都刷新 lastSeen。
        connection.pingTimer = setInterval(() => {
          if (now() - connection.lastSeen > RELAY_LIMITS.wsPongTimeoutMs) {
            connection.socket.terminate();
            return;
          }
          if (connection.socket.readyState === WebSocket.OPEN) connection.socket.ping();
        }, RELAY_LIMITS.wsPingIntervalMs);
        ws.on("pong", () => {
          connection.lastSeen = now();
        });
        ws.on("message", (data, isBinary) => {
          connection.lastSeen = now();
          handleMessage(connection, data, isBinary);
        });
        ws.on("error", () => connection.socket.terminate());
        ws.on("close", () => closeConnection(connection));
      });
    });
  });

  app.addHook("onClose", () => {
    clearInterval(flushTimer);
    for (const connection of connections) {
      connection.socket.terminate();
      connections.delete(connection);
    }
    wsServer.close();
  });
}

export type { Connection as RelayWsConnection };
