import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import {
  parseRelayV3HttpRequest,
  parseRelayV3OutgoingMessage,
  RELAY_V3_BUSINESS_CODES as CODES,
  RELAY_V3_HTTP,
  RELAY_V3_WS_PATH,
  type RelayV3Device,
  type RelayV3ErrorCode,
  type RelayV3Meta,
  type RelayV3PairStatus,
  type RelayV3Role,
  type RelayV3IncomingMessage,
} from "@zcode/shared/remote-relay-v3";

// fake-relay-v3：V3 契约的测试接缝（参照已退役 fake-relay-v2 的模式）。
// 真实 loopback HTTP/WS、故障注入（onHttp/onMessage）、调用与消息留存。
// 与 relay-server 真实实现共用一致性矩阵（test/fixtures/relay-v3-consistency.ts），
// 行为差异只允许出现在矩阵不覆盖的实现细节（限流、JWT 形态、持久化）上。
// fake 不模拟限流：限流是真实 relay 的部署防线（§8），客户端不应依赖其行为。

interface Connection {
  id: string;
  socket: WebSocket;
  accountId: string;
  role: RelayV3Role;
  deviceSid?: string;
  terminalSid: string;
  meta: RelayV3Meta;
}

export interface FakeRelayV3Message {
  connectionId: string;
  accountId: string;
  role: RelayV3Role;
  deviceSid?: string;
  message: unknown;
}

export type FakeRelayV3HttpAction = { status: number; body?: unknown } | { networkError: true };
export type FakeRelayV3MessageAction =
  | { pairStatus: RelayV3PairStatus }
  | { drop: true }
  | { error: RelayV3ErrorCode }
  | { disconnect: true };
export interface FakeRelayV3Target {
  connectionId?: string;
  deviceSid?: string;
  role?: RelayV3Role;
}
export interface FakeRelayV3HttpCall {
  method: string;
  path: string;
  accountId?: string;
  body: unknown;
}
export interface FakeRelayV3Options {
  /** 预建账号：手机号 → 账号 ID。未列出的手机号按 registrationOpen 决定可否自注册。 */
  accounts?: Readonly<Record<string, string>>;
  /** 默认 true；false 对应 RELAY_LOCAL_REGISTRATION=closed。 */
  registrationOpen?: boolean;
  now?: () => number;
  onHttp?: (call: FakeRelayV3HttpCall) => FakeRelayV3HttpAction | void;
  onMessage?: (message: FakeRelayV3Message) => FakeRelayV3MessageAction | void;
}

const SMS_TTL_MS = 5 * 60_000;

function maskPhone(phone: string): string {
  if (phone.length <= 6) return `${phone.slice(0, 3)}****`;
  return `${phone.slice(0, phone.length - 6)}****${phone.slice(-2)}`;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function createFakeRelayV3(options: FakeRelayV3Options = {}) {
  const now = options.now ?? Date.now;
  const registrationOpen = options.registrationOpen ?? true;
  const accounts = new Map<string, string>(
    Object.entries(options.accounts ?? {}).map(([phone, id]) => [phone, id]),
  );
  const smsCodes = new Map<string, { code: string; expiresAt: number; used: boolean }>();
  const accessTokens = new Map<string, { accountId: string; familyId: string }>();
  const refreshTokens = new Map<
    string,
    { accountId: string; familyId: string; rotated: boolean }
  >();
  const revokedFamilies = new Set<string>();
  const devices = new Map<string, { accountId: string; view: Omit<RelayV3Device, "online"> }>();
  const tokens = new Map<string, { accountId: string; role: RelayV3Role; expiresAt: number }>();
  const deviceAuthRequests = new Map<
    string,
    {
      userCode: string;
      publicKey: string;
      status: "pending" | "approved" | "consumed";
      accountId?: string;
      device?: RelayV3Device;
      expiresAt: number;
    }
  >();
  const httpCalls: FakeRelayV3HttpCall[] = [];
  const messages: FakeRelayV3Message[] = [];
  const connections = new Set<Connection>();
  const owners = new Map<string, Partial<Record<RelayV3Role, Connection>>>();
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });

  const send = (connection: Connection, message: RelayV3IncomingMessage) => {
    if (connection.socket.readyState === WebSocket.OPEN)
      connection.socket.send(JSON.stringify({ ...message, server_ts: Math.floor(now() / 1000) }));
  };
  const peer = (connection: Connection) =>
    owners.get(connection.deviceSid ?? "")?.[connection.role === "device" ? "terminal" : "device"];
  const currentTerminal = (deviceSid: string) => owners.get(deviceSid)?.terminal;
  const deviceView = (device: { accountId: string; view: Omit<RelayV3Device, "online"> }) => ({
    ...device.view,
    online: !!owners.get(device.view.device_sid)?.device,
  });

  const issueTokenPair = (accountId: string, familyId: string = randomUUID()) => {
    const access = `a_${randomUUID()}`;
    const refresh = `r_${randomUUID()}`;
    accessTokens.set(access, { accountId, familyId });
    refreshTokens.set(refresh, { accountId, familyId, rotated: false });
    return { access, refresh };
  };

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const access = bearer ? accessTokens.get(bearer) : undefined;
    const accountId = access?.accountId;
    let body: unknown;
    try {
      body = await readBody(request);
    } catch {
      response.destroy();
      return;
    }
    const call = { method: request.method ?? "GET", path, accountId, body };
    httpCalls.push(call);
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    // code/familyId 显式标注为宽类型：默认值表达式会把参数收窄成字面量类型，
    // 导致传入其他业务码时类型不兼容。
    const reply = (status: number, data?: unknown, code: number = CODES.OK, msg = "") => {
      response.writeHead(status);
      response.end(JSON.stringify({ code, msg, ...(data === undefined ? {} : { data }) }));
    };
    // 返回会话对象而非布尔值，让调用方拿到已收窄的 accountId/familyId（TS 无法
    // 跨函数边界保留对 access/accountId 的 narrowing）。
    const authed = () => {
      if (!access || !accountId) {
        reply(200, null, CODES.AUTH_FAILED, "unauthorized");
        return null;
      }
      return { accountId, familyId: access.familyId };
    };

    const action = options.onHttp?.(call);
    if (action && "networkError" in action) {
      request.socket.destroy();
      return;
    }
    if (action && "status" in action) {
      response.writeHead(action.status);
      response.end(action.body === undefined ? undefined : JSON.stringify(action.body));
      return;
    }

    if (path === RELAY_V3_HTTP.smsCode.path && request.method === "POST") {
      const parsed = parseRelayV3HttpRequest("smsCode", body);
      if (!parsed) return reply(200, null, CODES.WRONG_PARAM, "parameter error");
      smsCodes.set(parsed.phone, {
        code: String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0"),
        expiresAt: now() + SMS_TTL_MS,
        used: false,
      });
      return reply(200, null);
    }
    if (path === RELAY_V3_HTTP.login.path && request.method === "POST") {
      const parsed = parseRelayV3HttpRequest("login", body);
      if (!parsed) return reply(200, null, CODES.WRONG_PARAM, "parameter error");
      const sms = smsCodes.get(parsed.phone);
      if (
        !sms ||
        sms.used ||
        sms.expiresAt <= now() ||
        !("code" in parsed) ||
        sms.code !== parsed.code
      ) {
        return reply(200, null, CODES.AUTH_FAILED, "invalid code");
      }
      sms.used = true;
      let accountIdForPhone = accounts.get(parsed.phone);
      if (!accountIdForPhone) {
        if (!registrationOpen) return reply(200, null, CODES.AUTH_FAILED, "registration closed");
        accountIdForPhone = `acct_${randomUUID()}`;
        accounts.set(parsed.phone, accountIdForPhone);
      }
      const pair = issueTokenPair(accountIdForPhone);
      return reply(200, {
        access: pair.access,
        refresh: pair.refresh,
        account: { id: accountIdForPhone, phone_masked: maskPhone(parsed.phone) },
      });
    }
    if (path === RELAY_V3_HTTP.refresh.path && request.method === "POST") {
      const parsed = parseRelayV3HttpRequest("refresh", body);
      if (!parsed) return reply(200, null, CODES.WRONG_PARAM, "parameter error");
      const token = refreshTokens.get(parsed.refresh);
      // 已旋转 token 的重放撤销整个家族（§3.3）。
      if (!token || revokedFamilies.has(token.familyId)) {
        return reply(200, null, CODES.AUTH_FAILED, "session expired");
      }
      if (token.rotated) {
        for (const [key, value] of refreshTokens)
          if (value.familyId === token.familyId) refreshTokens.delete(key);
        for (const [key, value] of accessTokens)
          if (value.familyId === token.familyId) accessTokens.delete(key);
        revokedFamilies.add(token.familyId);
        return reply(200, null, CODES.AUTH_FAILED, "session expired");
      }
      token.rotated = true;
      const next = issueTokenPair(token.accountId, token.familyId);
      // 同 family 旧 access 随旋转即刻失效；旧 refresh 保留在表中并标记 rotated，
      // 使重放可被识别并撤销整个家族（§3.3，与真实实现同语义）。
      for (const [key, value] of accessTokens)
        if (value.familyId === token.familyId && key !== next.access) accessTokens.delete(key);
      return reply(200, { access: next.access, refresh: next.refresh });
    }
    if (path === RELAY_V3_HTTP.logout.path && request.method === "POST") {
      const session = authed();
      if (!session) return;
      for (const [key, value] of accessTokens)
        if (value.familyId === session.familyId) accessTokens.delete(key);
      for (const [key, value] of refreshTokens)
        if (value.familyId === session.familyId) refreshTokens.delete(key);
      return reply(200, null);
    }
    if (path === RELAY_V3_HTTP.register.path && request.method === "POST") {
      const session = authed();
      if (!session) return;
      const parsed = parseRelayV3HttpRequest("register", body);
      if (!parsed) return reply(200, null, CODES.WRONG_PARAM, "parameter error");
      // 同 MID 每次注册产生新 SID 与新公钥绑定（§5.1）。
      const view = {
        device_sid: `d_${randomUUID()}`,
        device_mid: parsed.device_mid,
        public_key: parsed.public_key,
        created_at: Math.floor(now() / 1000),
        meta: {},
      };
      devices.set(view.device_sid, { accountId: session.accountId, view });
      return reply(200, { ...view, online: false });
    }
    if (path === RELAY_V3_HTTP.list.path && request.method === "GET") {
      const session = authed();
      if (!session) return;
      return reply(
        200,
        [...devices.values()]
          .filter((device) => device.accountId === session.accountId)
          .map(deviceView),
      );
    }
    if (path === RELAY_V3_HTTP.delete.path && request.method === "POST") {
      const session = authed();
      if (!session) return;
      const parsed = parseRelayV3HttpRequest("delete", body);
      if (!parsed) return reply(200, null, CODES.WRONG_PARAM, "parameter error");
      const device = devices.get(parsed.device_sid);
      if (!device) return reply(200, null);
      if (device.accountId !== session.accountId)
        return reply(200, null, CODES.NO_PERMISSION, "no permission");
      if (owners.get(parsed.device_sid)?.device)
        return reply(200, null, CODES.WRONG_STATE, "device online");
      devices.delete(parsed.device_sid);
      return reply(200, null);
    }
    if (path === RELAY_V3_HTTP.relayToken.path && request.method === "POST") {
      const session = authed();
      if (!session) return;
      const parsed = parseRelayV3HttpRequest("relayToken", body);
      if (!parsed) return reply(200, null, CODES.WRONG_PARAM, "parameter error");
      const token = randomBytes(16).toString("base64url");
      tokens.set(token, { accountId: session.accountId, role: parsed.role, expiresAt: now() + 60_000 });
      return reply(200, { token, expires_in: 60 });
    }
    if (path === RELAY_V3_HTTP.deviceAuthRequest.path && request.method === "POST") {
      const parsed = parseRelayV3HttpRequest("deviceAuthRequest", body);
      if (!parsed) return reply(200, null, CODES.WRONG_PARAM, "parameter error");
      const userCode = String(Math.floor(10_000_000 + Math.random() * 90_000_000));
      const deviceCode = randomBytes(32).toString("hex");
      deviceAuthRequests.set(deviceCode, {
        userCode,
        publicKey: parsed.public_key,
        status: "pending",
        expiresAt: now() + 900_000,
      });
      return reply(200, { user_code: userCode, device_code: deviceCode, expires_in: 900 });
    }
    if (path === RELAY_V3_HTTP.deviceAuthApprove.path && request.method === "POST") {
      const session = authed();
      if (!session) return;
      const parsed = parseRelayV3HttpRequest("deviceAuthApprove", body);
      if (!parsed) return reply(200, null, CODES.WRONG_PARAM, "parameter error");
      const entry = [...deviceAuthRequests.values()].find(
        (candidate) => candidate.userCode === parsed.user_code,
      );
      if (!entry || entry.status !== "pending" || entry.expiresAt <= now())
        return reply(200, null, CODES.EXPIRED, "user code expired");
      const view = {
        device_sid: `d_${randomUUID()}`,
        device_mid: `headless_${createHash("sha256").update(entry.publicKey).digest("hex").slice(0, 8)}`,
        public_key: entry.publicKey,
        created_at: Math.floor(now() / 1000),
        meta: {},
      };
      devices.set(view.device_sid, { accountId: session.accountId, view });
      entry.accountId = session.accountId;
      entry.status = "approved";
      entry.device = { ...view, online: false };
      return reply(200, { device: entry.device });
    }
    if (path === RELAY_V3_HTTP.deviceAuthPoll.path && request.method === "POST") {
      const parsed = parseRelayV3HttpRequest("deviceAuthPoll", body);
      if (!parsed) return reply(200, null, CODES.WRONG_PARAM, "parameter error");
      const entry = deviceAuthRequests.get(parsed.device_code);
      if (!entry) return reply(200, null, CODES.AUTH_FAILED, "unknown device code");
      if (entry.expiresAt <= now()) return reply(200, null, CODES.EXPIRED, "expired");
      if (entry.status === "pending") return reply(200, { status: "pending" });
      if (entry.status === "consumed") return reply(200, null, CODES.WRONG_STATE, "already used");
      entry.status = "consumed";
      const pair = issueTokenPair(entry.accountId ?? "");
      return reply(200, {
        access: pair.access,
        refresh: pair.refresh,
        device: entry.device,
      });
    }
    return reply(404, undefined, CODES.NOT_FOUND, "not found");
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    const identity = tokens.get(token);
    if (url.pathname !== RELAY_V3_WS_PATH || !identity || identity.expiresAt <= now()) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    // 一次性：Upgrade 前原子消费，失败不恢复（§5.2）。
    tokens.delete(token);
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      const connection: Connection = {
        id: randomUUID(),
        socket: ws,
        accountId: identity.accountId,
        role: identity.role,
        terminalSid: identity.role === "terminal" ? `t_${randomUUID()}` : "",
        meta: {},
      };
      connections.add(connection);
      ws.on("error", () => ws.terminate());
      ws.on("message", (data, isBinary) => {
        let message: unknown;
        try {
          message = JSON.parse(data.toString());
        } catch {
          message = data.toString();
        }
        const record = {
          connectionId: connection.id,
          accountId: connection.accountId,
          role: connection.role,
          deviceSid: connection.deviceSid,
          message,
        };
        messages.push(record);
        if (ws.readyState !== WebSocket.OPEN) return;
        const parsed = isBinary ? null : parseRelayV3OutgoingMessage(message);
        if (!parsed) {
          send(connection, { type: "error", code: "WRONG_PARAM" });
          ws.close();
          return;
        }
        const action = options.onMessage?.(record);
        if (action && "drop" in action) return;
        if (action && "disconnect" in action) {
          ws.close();
          return;
        }
        if (action && "error" in action) {
          send(connection, { type: "error", code: action.error });
          ws.close();
          return;
        }
        const override = action && "pairStatus" in action ? action.pairStatus : undefined;
        if (parsed.type === "auth_init") {
          if (connection.deviceSid) {
            send(connection, { type: "error", code: "WRONG_PARAM" });
            ws.close();
            return;
          }
          // 角色与 auth_init 形态必须匹配（token 绑定角色，§5.2；与真实实现同语义）。
          const hasTerminalKey = "terminal_public_key" in parsed;
          const terminalPublicKey = hasTerminalKey ? parsed.terminal_public_key : "";
          if (connection.role === "terminal" && !hasTerminalKey) {
            send(connection, { type: "error", code: "WRONG_PARAM" });
            ws.close();
            return;
          }
          if (connection.role === "device" && hasTerminalKey) {
            send(connection, { type: "error", code: "WRONG_PARAM" });
            ws.close();
            return;
          }
          const device = devices.get(parsed.device_sid);
          if (!device || device.accountId !== connection.accountId) {
            send(connection, { type: "error", code: "AUTH_FAILED" });
            ws.close();
            return;
          }
          connection.deviceSid = parsed.device_sid;
          const roles = owners.get(parsed.device_sid) ?? {};
          if (connection.role === "device") {
            const old = roles.device;
            roles.device = connection;
            if (old) {
              send(old, { type: "error", code: "KICKED" });
              old.socket.close();
            }
          } else {
            // 单 active terminal：新 terminal 配对成功后旧 terminal 收 waiting 并被关闭（§5.2）。
            const old = roles.terminal;
            roles.terminal = connection;
            if (old && old !== connection) {
              send(old, { type: "pair_status_ack", pair_status: "waiting", terminal_sid: "" });
              old.socket.close();
            }
          }
          owners.set(parsed.device_sid, roles);
          const other = peer(connection);
          const pair_status = override ?? (other ? "matched" : "waiting");
          if (other) {
            send(other, {
              type: "pair_status_ack",
              pair_status,
              terminal_sid:
                connection.role === "terminal" ? connection.terminalSid : other.terminalSid,
              ...(connection.role === "terminal"
                ? { terminal_public_key: terminalPublicKey }
                : {}),
            });
          }
          send(connection, {
            type: "auth_ack",
            device_sid: parsed.device_sid,
            terminal_sid: connection.terminalSid,
            pair_status,
          });
        } else if (!connection.deviceSid) {
          send(connection, { type: "error", code: "AUTH_FAILED" });
          ws.close();
        } else if (parsed.type === "pair_status_query") {
          const terminal = currentTerminal(connection.deviceSid ?? "");
          send(connection, {
            type: "pair_status_ack",
            pair_status: override ?? (peer(connection) ? "matched" : "waiting"),
            terminal_sid:
              connection.role === "device" ? (terminal?.terminalSid ?? "") : connection.terminalSid,
          });
        } else {
          const other = peer(connection);
          if (other) send(other, { type: "data", payload: parsed.payload });
          else send(connection, { type: "error", code: "INTERNAL" });
        }
      });
      ws.on("close", () => {
        connections.delete(connection);
        const roles = owners.get(connection.deviceSid ?? "");
        // 被替换连接的 close 晚于新认证完成，必须按连接身份释放，不能只按 SID/role 删除。
        if (roles?.[connection.role] !== connection) return;
        delete roles[connection.role];
        const other = peer(connection);
        if (other) {
          send(other, { type: "pair_status_ack", pair_status: "waiting", terminal_sid: "" });
          if (connection.role === "device") {
            send(other, { type: "error", code: "DEVICE_OFFLINE" });
            other.socket.close();
          }
        }
        if (!roles.device && !roles.terminal) owners.delete(connection.deviceSid ?? "");
      });
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing relay address");
  const select = (target: FakeRelayV3Target) =>
    [...connections].filter(
      (connection) =>
        (!target.connectionId || target.connectionId === connection.id) &&
        (!target.deviceSid || target.deviceSid === connection.deviceSid) &&
        (!target.role || target.role === connection.role),
    );
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}${RELAY_V3_WS_PATH}`,
    httpCalls,
    messages,
    /** 测试接缝：读取发送给手机号的验证码（对应真实 relay 的 test sms provider）。 */
    smsCode: (phone: string) => smsCodes.get(phone)?.code,
    sendError: (target: FakeRelayV3Target, code: RelayV3ErrorCode) => {
      for (const connection of select(target)) send(connection, { type: "error", code });
    },
    disconnect: (target: FakeRelayV3Target) => {
      for (const connection of select(target)) connection.socket.close();
    },
    close: async () => {
      for (const connection of connections) connection.socket.terminate();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export type FakeRelayV3 = Awaited<ReturnType<typeof createFakeRelayV3>>;
