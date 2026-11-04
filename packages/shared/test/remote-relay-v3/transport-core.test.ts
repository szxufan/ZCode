import { describe, expect, it } from "vitest";

import {
  decodeRelayV3Base64Url,
  deriveRelayV3SessionKey,
  encodeRelayV3Base64Url,
  generateRelayV3KeyPair,
  openRelayV3Envelope,
  relayV3KeyId,
  sealRelayV3Envelope,
  RelayV3ConnectionError,
  RelayV3TransportCore,
  type RelayV3TransportSocket,
  type RelayV3TransportState,
} from "@zcode/shared/remote-relay-v3";

// transport-core 状态机：device 角色全路径（配对、密文收发、KICKED 窗口、退避、
// 解密失败重建、AUTH_FAILED/401 终态、stop 清理）用受控 socket 与手动时钟驱动。
// connect() 是异步函数，openConnection 的失败在微任务里落定：每步 advance 后 flush。
// terminal 角色差异（公钥来源、DEVICE_OFFLINE 宽限）在两端 transport 单测覆盖。

interface Harness {
  core: RelayV3TransportCore;
  states: RelayV3TransportState[];
  sent: string[];
  serverPush: (text: string) => void;
  payloads: unknown[];
  faults: string[];
  openAttempts: () => number;
  setNextOpenError: (error: unknown) => void;
  advance: (ms: number) => void;
  /** harness 自持的 device 密钥（terminal 公钥由测试注入并派生同一会话密钥）。 */
  deviceKeys: ReturnType<typeof generateRelayV3KeyPair>;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function createHarness(): Harness {
  const deviceKeys = generateRelayV3KeyPair();
  const kid = relayV3KeyId(deviceKeys.publicKey);

  const states: RelayV3TransportState[] = [];
  const sent: string[] = [];
  const payloads: unknown[] = [];
  const faults: string[] = [];
  let openCount = 0;
  let nextOpenError: unknown;
  let pushListener: ((text: string) => void) | undefined;
  let closeListener: (() => void) | undefined;
  let now = 1_000_000;
  const timers: ({ at: number; callback: () => void } | undefined)[] = [];

  const core = new RelayV3TransportCore({
    role: "device",
    kid,
    log: () => {},
    openConnection: async () => {
      openCount += 1;
      if (nextOpenError) {
        const error = nextOpenError;
        nextOpenError = undefined;
        throw error;
      }
      const socket: RelayV3TransportSocket = {
        send: (text) => sent.push(text),
        close: () => closeListener?.(),
        onMessage: (listener) => {
          pushListener = listener;
          return () => {
            if (pushListener === listener) pushListener = undefined;
          };
        },
        onClose: (listener) => {
          closeListener = listener;
          return () => {
            if (closeListener === listener) closeListener = undefined;
          };
        },
      };
      return socket;
    },
    buildAuthInit: () => ({
      type: "auth_init",
      device_sid: "sid_1",
      meta: { name: "test-device", platform: "darwin" },
    }),
    deriveSessionKey: ({ terminalPublicKey }) =>
      terminalPublicKey
        ? deriveRelayV3SessionKey(deviceKeys.privateKey, decodeRelayV3Base64Url(terminalPublicKey))
        : null,
    onState: (state) => states.push(state),
    onAppPayload: (payload) => payloads.push(payload),
    onProtocolFault: (kind) => faults.push(kind),
    timing: {
      now: () => now,
      setTimeout: (callback, ms) => {
        const handle = timers.length;
        timers.push({ at: now + ms, callback });
        return handle;
      },
      clearTimeout: (handle) => {
        timers[Number(handle)] = undefined;
      },
      random: () => 0.5, // jitter 因子 1+((0.5*2)-1)*0.2 = 1：退避精确等于基数。
    },
  });

  return {
    core,
    states,
    sent,
    payloads,
    faults,
    deviceKeys,
    openAttempts: () => openCount,
    setNextOpenError: (error) => {
      nextOpenError = error;
    },
    serverPush: (text) => pushListener?.(text),
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        let dueIndex = -1;
        let dueAt = Infinity;
        for (let index = 0; index < timers.length; index += 1) {
          const timer = timers[index];
          if (timer && timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at;
            dueIndex = index;
          }
        }
        if (dueIndex < 0) break;
        const timer = timers[dueIndex]!;
        timers[dueIndex] = undefined;
        now = Math.max(now, timer.at);
        timer.callback();
      }
      now = target;
    },
  };
}

describe("Relay V3 transport core", () => {
  it("完整配对流：auth_ack waiting → pair matched（透传公钥）→ 密文收发", async () => {
    const harness = createHarness();
    const terminalKeys = generateRelayV3KeyPair();
    // 会话密钥由 harness 的 device 私钥与测试注入的 terminal 公钥共同派生。
    const sessionKey = deriveRelayV3SessionKey(harness.deviceKeys.privateKey, terminalKeys.publicKey);
    const kid = relayV3KeyId(harness.deviceKeys.publicKey);
    harness.core.start();
    await flush();
    expect(harness.states.at(-1)?.phase).toBe("authenticating");
    expect(JSON.parse(harness.sent[0]!)).toMatchObject({ type: "auth_init", device_sid: "sid_1" });

    harness.serverPush(
      JSON.stringify({
        type: "auth_ack",
        device_sid: "sid_1",
        terminal_sid: "",
        pair_status: "waiting",
        server_ts: 1,
      }),
    );
    expect(harness.states.at(-1)?.phase).toBe("waiting");

    harness.serverPush(
      JSON.stringify({
        type: "pair_status_ack",
        terminal_sid: "tsid_1",
        pair_status: "matched",
        terminal_public_key: encodeRelayV3Base64Url(terminalKeys.publicKey),
      }),
    );
    expect(harness.states.at(-1)?.phase).toBe("matched");

    // 下行密文：解密后交付业务 payload。
    harness.serverPush(
      JSON.stringify({
        type: "data",
        payload: sealRelayV3Envelope(
          sessionKey,
          new TextEncoder().encode(JSON.stringify({ zcode_type: "bootstrap-request" })),
          kid,
        ),
      }),
    );
    expect(harness.payloads).toEqual([{ zcode_type: "bootstrap-request" }]);

    // 上行密文：发出的 data 携带合法信封。
    expect(harness.core.send({ zcode_type: "app-error", code: "x" })).toBe(true);
    const outgoing = JSON.parse(harness.sent.at(-1)!);
    expect(outgoing.type).toBe("data");
    expect(openRelayV3Envelope(sessionKey, outgoing.payload)).toEqual(
      new TextEncoder().encode(JSON.stringify({ zcode_type: "app-error", code: "x" })),
    );
    harness.core.stop();
  });

  it("解密失败：记录 decrypt-failed 并断开重建（不静默丢弃）", async () => {
    const harness = createHarness();
    const terminalKeys = generateRelayV3KeyPair();
    const kid = relayV3KeyId(harness.deviceKeys.publicKey);
    harness.core.start();
    await flush();
    harness.serverPush(
      JSON.stringify({
        type: "pair_status_ack",
        terminal_sid: "",
        pair_status: "matched",
        terminal_public_key: encodeRelayV3Base64Url(terminalKeys.publicKey),
      }),
    );
    expect(harness.states.at(-1)?.phase).toBe("matched");
    // 用无关密钥加密的密文：解密失败 → decrypt-failed → 断开重建（§4.5）。
    const strangerKeys = generateRelayV3KeyPair();
    const strangerSession = deriveRelayV3SessionKey(
      strangerKeys.privateKey,
      generateRelayV3KeyPair().publicKey,
    );
    harness.serverPush(
      JSON.stringify({
        type: "data",
        payload: sealRelayV3Envelope(
          strangerSession,
          new TextEncoder().encode(JSON.stringify({ zcode_type: "app-error", code: "x" })),
          kid,
        ),
      }),
    );
    expect(harness.faults).toContain("decrypt-failed");
    expect(harness.states.some((state) => state.phase === "connecting")).toBe(true);
    harness.core.stop();
  });

  it("KICKED：首次随机 2~5s 重连；60s 内第二次 → session-conflict 终态", async () => {
    const harness = createHarness();
    harness.core.start();
    await flush();
    harness.serverPush(JSON.stringify({ type: "error", code: "KICKED", message: "replaced", server_ts: 1 }));
    // random=0.5 → 首次 KICKED 延迟 2000 + floor(0.5*3000) = 3500ms。
    harness.advance(3_500);
    await flush();
    expect(harness.openAttempts()).toBe(2);
    // 60s 内第二次 KICKED → 终态。
    harness.serverPush(JSON.stringify({ type: "error", code: "KICKED", server_ts: 2 }));
    expect(harness.states.at(-1)).toMatchObject({ phase: "failed", failure: { kind: "session-conflict" } });
    harness.advance(120_000);
    await flush();
    expect(harness.openAttempts()).toBe(2);
  });

  it("网络失败指数退避：1s → 2s → 4s（random=0.5 → jitter 无偏移）", async () => {
    const harness = createHarness();
    const failure = () => new RelayV3ConnectionError("relay-unavailable", true);
    harness.setNextOpenError(failure());
    harness.core.start();
    await flush(); // open 1 失败 → 1s 退避。
    expect(harness.openAttempts()).toBe(1);
    harness.setNextOpenError(failure());
    harness.advance(1_000);
    await flush(); // open 2 失败 → 2s 退避。
    expect(harness.openAttempts()).toBe(2);
    harness.setNextOpenError(failure());
    harness.advance(2_000);
    await flush(); // open 3 失败 → 4s 退避。
    expect(harness.openAttempts()).toBe(3);
    harness.advance(4_000);
    await flush();
    expect(harness.openAttempts()).toBe(4);
    harness.core.stop();
  });

  it("HTTP 401 → auth-required 终态，停止自动重连", async () => {
    const harness = createHarness();
    harness.setNextOpenError(new RelayV3ConnectionError("auth-required", false));
    harness.core.start();
    await flush();
    expect(harness.states.at(-1)).toMatchObject({ phase: "failed", failure: { kind: "auth-required" } });
    harness.advance(120_000);
    await flush();
    expect(harness.openAttempts()).toBe(1);
  });

  it("AUTH_FAILED → auth-failed 终态（重注册由 manager 承担）", async () => {
    const harness = createHarness();
    harness.core.start();
    await flush();
    harness.serverPush(JSON.stringify({ type: "error", code: "AUTH_FAILED", server_ts: 1 }));
    expect(harness.states.at(-1)).toMatchObject({ phase: "failed", failure: { kind: "auth-failed" } });
  });

  it("握手 15s deadline：无 auth_ack → 断开退避重连", async () => {
    const harness = createHarness();
    harness.core.start();
    await flush();
    harness.advance(15_000); // deadline 触发 → 1s 退避。
    harness.advance(1_000); // 重连。
    await flush();
    expect(harness.openAttempts()).toBe(2);
    harness.core.stop();
  });

  it("心跳 watchdog：15s 无 ACK → 断开退避重连", async () => {
    const harness = createHarness();
    harness.core.start();
    await flush();
    harness.serverPush(
      JSON.stringify({
        type: "auth_ack",
        device_sid: "sid_1",
        terminal_sid: "",
        pair_status: "waiting",
        server_ts: 1,
      }),
    );
    harness.advance(15_000); // 心跳 5s/10s 各一次，watchdog 15s → 断开。
    expect(harness.sent.filter((text) => text.includes("pair_status_query")).length).toBeGreaterThan(0);
    harness.advance(1_000);
    await flush();
    expect(harness.openAttempts()).toBe(2);
    harness.core.stop();
  });

  it("非法入站消息 → 断开重建", async () => {
    const harness = createHarness();
    harness.core.start();
    await flush();
    harness.serverPush("not-json{{");
    expect(harness.faults).toContain("invalid-incoming");
    harness.advance(1_000);
    await flush();
    expect(harness.openAttempts()).toBe(2);
    harness.core.stop();
  });
});
