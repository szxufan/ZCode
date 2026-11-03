import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import {
  generateRelayV3KeyPair,
  parseRelayV3HttpResponse,
  RELAY_V3_BUSINESS_CODES as CODES,
  RELAY_V3_HTTP,
  type RelayV3HttpOperation,
  type RelayV3IncomingMessage,
} from "@zcode/shared/remote-relay-v3";

// Relay V3 一致性矩阵：同一套用例分别回放 fake-relay-v3 fixture 与 relay-server
// 真实实现（docs/relay-server/relay-v3-design.md §9 P0），杜绝两套行为。
// 覆盖 §5.2 "配对 owner 语义（纳入一致性测试）" 全部条目。限流、JWT 形态、
// 持久化等实现细节不在矩阵内，由 relay-server 自有测试覆盖。

export interface RelayV3ConsistencyTarget {
  httpUrl: string;
  wsUrl: string;
  /** 测试接缝：读取发送给手机号的验证码。 */
  smsCode(phone: string): string | undefined;
}

export type RelayV3ConsistencySetup = () => Promise<{
  target: RelayV3ConsistencyTarget;
  cleanup: () => Promise<void>;
}>;

export interface RelayV3HttpResponseResult<K extends RelayV3HttpOperation> {
  status: number;
  json: unknown;
  parsed: ReturnType<typeof parseRelayV3HttpResponse<K>>;
}

export async function relayV3Request<K extends RelayV3HttpOperation>(
  target: RelayV3ConsistencyTarget,
  operation: K,
  body?: unknown,
  bearer?: string,
): Promise<RelayV3HttpResponseResult<K>> {
  const { method, path } = RELAY_V3_HTTP[operation];
  const response = await fetch(`${target.httpUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as unknown;
  return { status: response.status, json, parsed: parseRelayV3HttpResponse(operation, json) };
}

export interface RelayV3TestSocket {
  send(message: unknown): void;
  /** 等待下一条满足 predicate 的消息；超时抛错。 */
  next<T>(predicate: (message: RelayV3IncomingMessage) => T | null, timeoutMs?: number): Promise<T>;
  closed: Promise<{ code: number; reason: string }>;
  close(): Promise<void>;
}

export function openTestSocket(url: string): RelayV3TestSocket & { opened: Promise<void> } {
  const ws = new WebSocket(url);
  const pending: RelayV3IncomingMessage[] = [];
  const waiters: {
    predicate: (message: RelayV3IncomingMessage) => unknown;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  let closeResult: { code: number; reason: string } | undefined;
  let closeWaiter: ((value: { code: number; reason: string }) => void) | undefined;
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error: Error) => reject(error));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    closeWaiter = resolve;
  });
  ws.on("message", (data) => {
    let message: RelayV3IncomingMessage | null = null;
    try {
      message = JSON.parse(data.toString()) as RelayV3IncomingMessage;
    } catch {
      message = null;
    }
    if (!message) return;
    const index = waiters.findIndex((waiter) => waiter.predicate(message!) !== null);
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(waiter!.predicate(message));
      return;
    }
    pending.push(message);
  });
  ws.on("close", (code, reason) => {
    closeResult = { code, reason: reason.toString() };
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("socket closed while waiting"));
    }
    closeWaiter?.(closeResult);
  });
  ws.on("error", () => {
    /* 关闭原因由 close 事件统一回报 */
  });
  return {
    opened,
    send: (message) => ws.send(JSON.stringify(message)),
    next: <T>(predicate: (message: RelayV3IncomingMessage) => T | null, timeoutMs = 5_000) =>
      new Promise<T>((resolve, reject) => {
        const pendingIndex = pending.findIndex((message) => predicate(message) !== null);
        if (pendingIndex >= 0) {
          const [message] = pending.splice(pendingIndex, 1);
          resolve(predicate(message!) as T);
          return;
        }
        const waiter = {
          predicate,
          resolve: (value: unknown) => resolve(value as T),
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("timed out waiting for message"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      }),
    closed,
    close: async () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
      await closed;
    },
  };
}

async function login(target: RelayV3ConsistencyTarget, phone: string) {
  const sms = await relayV3Request(target, "smsCode", { phone });
  expect(sms.parsed && sms.parsed.code === CODES.OK).toBe(true);
  const code = target.smsCode(phone);
  expect(code).toMatch(/^\d{6}$/);
  const loginResult = await relayV3Request(target, "login", { phone, code });
  expect(loginResult.parsed?.code).toBe(CODES.OK);
  const data = loginResult.parsed?.data;
  if (!data || "status" in data) throw new Error("login response missing token pair");
  return data;
}

async function registerDevice(target: RelayV3ConsistencyTarget, access: string, mid: string) {
  const keyPair = generateRelayV3KeyPair();
  const register = await relayV3Request(
    target,
    "register",
    {
      device_mid: mid,
      public_key: toBase64Url(keyPair.publicKey),
    },
    access,
  );
  const device = register.parsed?.data;
  if (!device) throw new Error(`register failed: ${JSON.stringify(register.json)}`);
  return { device, keyPair };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function openRelaySocket(
  target: RelayV3ConsistencyTarget,
  access: string,
  role: "device" | "terminal",
): Promise<RelayV3TestSocket> {
  const token = await relayV3Request(target, "relayToken", { role }, access);
  const data = token.parsed?.data;
  if (!data) throw new Error("relay token failed");
  const socket = openTestSocket(`${target.wsUrl}?token=${data.token}`);
  await socket.opened;
  return socket;
}

const isType =
  <T extends RelayV3IncomingMessage["type"]>(type: T) =>
  (message: RelayV3IncomingMessage) =>
    message.type === type ? (message as Extract<RelayV3IncomingMessage, { type: T }>) : null;

export function defineRelayV3ConsistencyMatrix(setup: RelayV3ConsistencySetup): void {
  describe("Relay V3 一致性矩阵（fake 与真实 relay 共用）", () => {
    it("登录 → 注册 → 列表 → WS 上线状态", async () => {
      const { target, cleanup } = await setup();
      try {
        const phone = "+8613800138000";
        const { access } = await login(target, phone);
        const { device, keyPair } = await registerDevice(target, access, "mid-consistency-1");
        expect(device.online).toBe(false);
        expect(device.public_key).toBe(toBase64Url(keyPair.publicKey));
        const socket = await openRelaySocket(target, access, "device");
        socket.send({ type: "auth_init", device_sid: device.device_sid, meta: { name: "桌面" } });
        const ack = await socket.next(isType("auth_ack"));
        expect(ack.pair_status).toBe("waiting");
        expect(ack.device_sid).toBe(device.device_sid);
        expect(ack.terminal_sid).toBe("");
        const list = await relayV3Request(target, "list", undefined, access);
        const record = list.parsed?.data?.find((item) => item.device_sid === device.device_sid);
        expect(record?.online).toBe(true);
        await socket.close();
        const listAfter = await relayV3Request(target, "list", undefined, access);
        const recordAfter = listAfter.parsed?.data?.find(
          (item) => item.device_sid === device.device_sid,
        );
        expect(recordAfter?.online).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it("terminal 配对 matched 且 device 收到 terminal 公钥透传", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138001");
        const { device } = await registerDevice(target, access, "mid-consistency-2");
        const deviceSocket = await openRelaySocket(target, access, "device");
        deviceSocket.send({ type: "auth_init", device_sid: device.device_sid });
        await deviceSocket.next(isType("auth_ack"));
        const terminalKeys = generateRelayV3KeyPair();
        const terminalSocket = await openRelaySocket(target, access, "terminal");
        terminalSocket.send({
          type: "auth_init",
          device_sid: device.device_sid,
          terminal_public_key: toBase64Url(terminalKeys.publicKey),
        });
        const ack = await terminalSocket.next(isType("auth_ack"));
        expect(ack.pair_status).toBe("matched");
        expect(ack.terminal_sid).not.toBe("");
        const deviceNotice = await deviceSocket.next(isType("pair_status_ack"));
        expect(deviceNotice.pair_status).toBe("matched");
        expect(deviceNotice.terminal_sid).toBe(ack.terminal_sid);
        expect(deviceNotice.terminal_public_key).toBe(toBase64Url(terminalKeys.publicKey));
        await deviceSocket.close();
        await terminalSocket.close();
      } finally {
        await cleanup();
      }
    });

    it("data 双向透传且 relay 不解析 payload", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138002");
        const { device } = await registerDevice(target, access, "mid-consistency-3");
        const deviceSocket = await openRelaySocket(target, access, "device");
        deviceSocket.send({ type: "auth_init", device_sid: device.device_sid });
        await deviceSocket.next(isType("auth_ack"));
        const terminalSocket = await openRelaySocket(target, access, "terminal");
        terminalSocket.send({
          type: "auth_init",
          device_sid: device.device_sid,
          terminal_public_key: toBase64Url(generateRelayV3KeyPair().publicKey),
        });
        await terminalSocket.next(isType("auth_ack"));
        await deviceSocket.next(isType("pair_status_ack"));
        // 密文信封与任意 JSON 对象都必须原样透传（§4.5 relay 不解析字段）。
        const envelope = {
          v: 3,
          alg: "x25519-hkdfsha256-aes256gcm-v1",
          kid: "0011223344556677",
          nonce: "AAAAAAAAAAAAAAAA",
          ct: "c29tZWNpcGhlcnRleHQ",
        };
        terminalSocket.send({ type: "data", payload: envelope, client_ts: 1 });
        const toDevice = await deviceSocket.next(isType("data"));
        expect(toDevice.payload).toEqual(envelope);
        const plain = { not: "an-envelope", arbitrary: [1, 2, 3] };
        deviceSocket.send({ type: "data", payload: plain });
        const toTerminal = await terminalSocket.next(isType("data"));
        expect(toTerminal.payload).toEqual(plain);
        await deviceSocket.close();
        await terminalSocket.close();
      } finally {
        await cleanup();
      }
    });

    it("未认证发送 data/pair_status_query → AUTH_FAILED 并关闭", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138003");
        const socket = await openRelaySocket(target, access, "device");
        socket.send({ type: "data", payload: { v: 3 } });
        const error = await socket.next(isType("error"));
        expect(error.code).toBe("AUTH_FAILED");
        await socket.closed;
        await socket.close();
      } finally {
        await cleanup();
      }
    });

    it("重复认证 → WRONG_PARAM 并关闭", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138004");
        const { device } = await registerDevice(target, access, "mid-consistency-5");
        const socket = await openRelaySocket(target, access, "device");
        socket.send({ type: "auth_init", device_sid: device.device_sid });
        await socket.next(isType("auth_ack"));
        socket.send({ type: "auth_init", device_sid: device.device_sid });
        const error = await socket.next(isType("error"));
        expect(error.code).toBe("WRONG_PARAM");
        await socket.closed;
        await socket.close();
      } finally {
        await cleanup();
      }
    });

    it("非法消息 → WRONG_PARAM 并关闭", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138005");
        const socket = await openRelaySocket(target, access, "device");
        socket.send({ type: "unknown_message" });
        const error = await socket.next(isType("error"));
        expect(error.code).toBe("WRONG_PARAM");
        await socket.closed;
        await socket.close();
      } finally {
        await cleanup();
      }
    });

    it("角色不符的 auth_init（device token 发 terminal 字段）→ WRONG_PARAM", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138006");
        const { device } = await registerDevice(target, access, "mid-consistency-7");
        const socket = await openRelaySocket(target, access, "device");
        socket.send({
          type: "auth_init",
          device_sid: device.device_sid,
          terminal_public_key: toBase64Url(generateRelayV3KeyPair().publicKey),
        });
        const error = await socket.next(isType("error"));
        expect(error.code).toBe("WRONG_PARAM");
        await socket.closed;
        await socket.close();
      } finally {
        await cleanup();
      }
    });

    it("同角色替换：新 device 连接 → 旧连接 KICKED，terminal 不受影响", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138007");
        const { device } = await registerDevice(target, access, "mid-consistency-8");
        const first = await openRelaySocket(target, access, "device");
        first.send({ type: "auth_init", device_sid: device.device_sid });
        await first.next(isType("auth_ack"));
        const terminal = await openRelaySocket(target, access, "terminal");
        terminal.send({
          type: "auth_init",
          device_sid: device.device_sid,
          terminal_public_key: toBase64Url(generateRelayV3KeyPair().publicKey),
        });
        await terminal.next(isType("auth_ack"));
        await first.next(isType("pair_status_ack"));
        const second = await openRelaySocket(target, access, "device");
        second.send({ type: "auth_init", device_sid: device.device_sid });
        await second.next(isType("auth_ack"));
        const kicked = await first.next(isType("error"));
        expect(kicked.code).toBe("KICKED");
        await first.closed;
        // 替换后 data 仍路由到新 device owner。
        terminal.send({ type: "data", payload: { after: "kick" } });
        const received = await second.next(isType("data"));
        expect(received.payload).toEqual({ after: "kick" });
        await second.close();
        await terminal.close();
        await first.close();
      } finally {
        await cleanup();
      }
    });

    it("单 active terminal：新 terminal 配对 → 旧 terminal waiting 并关闭，device 收到新 matched", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138008");
        const { device } = await registerDevice(target, access, "mid-consistency-9");
        const deviceSocket = await openRelaySocket(target, access, "device");
        deviceSocket.send({ type: "auth_init", device_sid: device.device_sid });
        await deviceSocket.next(isType("auth_ack"));
        const firstTerminal = await openRelaySocket(target, access, "terminal");
        firstTerminal.send({
          type: "auth_init",
          device_sid: device.device_sid,
          terminal_public_key: toBase64Url(generateRelayV3KeyPair().publicKey),
        });
        const firstAck = await firstTerminal.next(isType("auth_ack"));
        await deviceSocket.next(isType("pair_status_ack"));
        const secondTerminal = await openRelaySocket(target, access, "terminal");
        const secondKeys = generateRelayV3KeyPair();
        secondTerminal.send({
          type: "auth_init",
          device_sid: device.device_sid,
          terminal_public_key: toBase64Url(secondKeys.publicKey),
        });
        const secondAck = await secondTerminal.next(isType("auth_ack"));
        expect(secondAck.pair_status).toBe("matched");
        expect(secondAck.terminal_sid).not.toBe(firstAck.terminal_sid);
        const demoted = await firstTerminal.next(isType("pair_status_ack"));
        expect(demoted.pair_status).toBe("waiting");
        await firstTerminal.closed;
        const deviceNotice = await deviceSocket.next(isType("pair_status_ack"));
        expect(deviceNotice.pair_status).toBe("matched");
        expect(deviceNotice.terminal_sid).toBe(secondAck.terminal_sid);
        expect(deviceNotice.terminal_public_key).toBe(toBase64Url(secondKeys.publicKey));
        await deviceSocket.close();
        await secondTerminal.close();
        await firstTerminal.close();
      } finally {
        await cleanup();
      }
    });

    it("device 断开 → terminal 收 waiting + DEVICE_OFFLINE 并关闭", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138009");
        const { device } = await registerDevice(target, access, "mid-consistency-10");
        const deviceSocket = await openRelaySocket(target, access, "device");
        deviceSocket.send({ type: "auth_init", device_sid: device.device_sid });
        await deviceSocket.next(isType("auth_ack"));
        const terminal = await openRelaySocket(target, access, "terminal");
        terminal.send({
          type: "auth_init",
          device_sid: device.device_sid,
          terminal_public_key: toBase64Url(generateRelayV3KeyPair().publicKey),
        });
        await terminal.next(isType("auth_ack"));
        await deviceSocket.next(isType("pair_status_ack"));
        await deviceSocket.close();
        const waiting = await terminal.next(isType("pair_status_ack"));
        expect(waiting.pair_status).toBe("waiting");
        const error = await terminal.next(isType("error"));
        expect(error.code).toBe("DEVICE_OFFLINE");
        await terminal.closed;
        await terminal.close();
      } finally {
        await cleanup();
      }
    });

    it("terminal 断开 → device 仅收 waiting，不关闭", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138010");
        const { device } = await registerDevice(target, access, "mid-consistency-11");
        const deviceSocket = await openRelaySocket(target, access, "device");
        deviceSocket.send({ type: "auth_init", device_sid: device.device_sid });
        await deviceSocket.next(isType("auth_ack"));
        const terminal = await openRelaySocket(target, access, "terminal");
        terminal.send({
          type: "auth_init",
          device_sid: device.device_sid,
          terminal_public_key: toBase64Url(generateRelayV3KeyPair().publicKey),
        });
        await terminal.next(isType("auth_ack"));
        await deviceSocket.next(isType("pair_status_ack"));
        await terminal.close();
        const waiting = await deviceSocket.next(isType("pair_status_ack"));
        expect(waiting.pair_status).toBe("waiting");
        // device 不被关闭：心跳查询仍可用。
        deviceSocket.send({ type: "pair_status_query" });
        const ack = await deviceSocket.next(isType("pair_status_ack"));
        expect(ack.pair_status).toBe("waiting");
        await deviceSocket.close();
      } finally {
        await cleanup();
      }
    });

    it("pair_status_query 心跳 → pair_status_ack（matched 时携带 terminal_sid）", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138011");
        const { device } = await registerDevice(target, access, "mid-consistency-12");
        const deviceSocket = await openRelaySocket(target, access, "device");
        deviceSocket.send({ type: "auth_init", device_sid: device.device_sid });
        await deviceSocket.next(isType("auth_ack"));
        deviceSocket.send({ type: "pair_status_query" });
        const waiting = await deviceSocket.next(isType("pair_status_ack"));
        expect(waiting.pair_status).toBe("waiting");
        expect(waiting.terminal_sid).toBe("");
        const terminal = await openRelaySocket(target, access, "terminal");
        terminal.send({
          type: "auth_init",
          device_sid: device.device_sid,
          terminal_public_key: toBase64Url(generateRelayV3KeyPair().publicKey),
        });
        const terminalAck = await terminal.next(isType("auth_ack"));
        await deviceSocket.next(isType("pair_status_ack"));
        deviceSocket.send({ type: "pair_status_query" });
        const matched = await deviceSocket.next(isType("pair_status_ack"));
        expect(matched.pair_status).toBe("matched");
        expect(matched.terminal_sid).toBe(terminalAck.terminal_sid);
        await deviceSocket.close();
        await terminal.close();
      } finally {
        await cleanup();
      }
    });

    it("一次性 token 复用被拒（第二次 upgrade 失败）", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138012");
        const token = await relayV3Request(target, "relayToken", { role: "device" }, access);
        const data = token.parsed?.data;
        if (!data) throw new Error("relay token failed");
        const first = openTestSocket(`${target.wsUrl}?token=${data.token}`);
        await first.opened;
        await first.close();
        const second = openTestSocket(`${target.wsUrl}?token=${data.token}`);
        await expect(second.opened).rejects.toThrow();
        second.closed.catch(() => {});
      } finally {
        await cleanup();
      }
    });

    it("未配对发送 data → INTERNAL", async () => {
      const { target, cleanup } = await setup();
      try {
        const { access } = await login(target, "+8613800138013");
        const { device } = await registerDevice(target, access, "mid-consistency-14");
        const deviceSocket = await openRelaySocket(target, access, "device");
        deviceSocket.send({ type: "auth_init", device_sid: device.device_sid });
        await deviceSocket.next(isType("auth_ack"));
        deviceSocket.send({ type: "data", payload: { v: 3 } });
        const error = await deviceSocket.next(isType("error"));
        expect(error.code).toBe("INTERNAL");
        await deviceSocket.close();
      } finally {
        await cleanup();
      }
    });

    it("设备删除：越权 no permission、在线 wrong state、幂等删除", async () => {
      const { target, cleanup } = await setup();
      try {
        const owner = await login(target, "+8613800138014");
        const stranger = await login(target, "+8613800138015");
        const { device } = await registerDevice(target, owner.access, "mid-consistency-15");
        const foreign = await relayV3Request(
          target,
          "delete",
          { device_sid: device.device_sid },
          stranger.access,
        );
        expect(foreign.parsed?.code).toBe(CODES.NO_PERMISSION);
        const onlineSocket = await openRelaySocket(target, owner.access, "device");
        onlineSocket.send({ type: "auth_init", device_sid: device.device_sid });
        await onlineSocket.next(isType("auth_ack"));
        const online = await relayV3Request(
          target,
          "delete",
          { device_sid: device.device_sid },
          owner.access,
        );
        expect(online.parsed?.code).toBe(CODES.WRONG_STATE);
        await onlineSocket.close();
        // 关闭后列表在线态需要一次事件循环收敛；等待后删除两次验证幂等。
        await new Promise((resolve) => setTimeout(resolve, 100));
        const first = await relayV3Request(
          target,
          "delete",
          { device_sid: device.device_sid },
          owner.access,
        );
        expect(first.parsed?.code).toBe(CODES.OK);
        const second = await relayV3Request(
          target,
          "delete",
          { device_sid: device.device_sid },
          owner.access,
        );
        expect(second.parsed?.code).toBe(CODES.OK);
      } finally {
        await cleanup();
      }
    });
  });
}
