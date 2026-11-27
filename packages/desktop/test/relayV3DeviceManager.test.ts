import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createFakeRelayV3 } from "@zcode/shared/testing/fake-relay-v3";
import {
  decodeRelayV3Base64Url,
  deriveRelayV3SessionKey,
  encodeRelayV3Base64Url,
  generateRelayV3KeyPair,
  openRelayV3Envelope,
  parseRelayV3AppPayload,
  parseRelayV3QrUrl,
  parseRelayV3RpcFrame,
  RELAY_V3_HTTP,
  relayV3EnvelopeAad,
  relayV3KeyId,
  sealRelayV3Envelope,
  type RelayV3DesktopStatus,
} from "@zcode/shared/remote-relay-v3";

import { RelayV3DeviceManager, type MessagePortLike } from "../src/main/remote-relay-v3/index.js";

// P1 集成测试：真实 loopback fake relay（HTTP+WS）+ 真实 Node ws 终端，覆盖
// 登录 → 注册（带公钥）→ 配对（公钥透传）→ 密文 bootstrap/bridge 协商 →
// rpc-frame 经 in-memory MessagePort 对 往返 → 断开等待语义。
// 私钥不进日志的断言一并覆盖（AGENTS 日志边界）。

const PHONE = "+8613800138000";

interface Harness {
  manager: RelayV3DeviceManager;
  configDir: string;
  attachCalls: {
    windowId: number;
    attachmentId: string;
    terminalOwnerId: string;
    scope: { kind: string };
  }[];
  hostPorts: Map<string, FakePort>;
  statuses: RelayV3DesktopStatus[];
  logs: string[];
  cleanup: () => Promise<void>;
}

/** 内存 MessagePort 对：模拟 MessageChannelMain 的结构克隆语义（异步派发）。 */
class FakePort implements MessagePortLike {
  peer?: FakePort;
  private listeners: ((event: { data: unknown }) => void)[] = [];
  private closeListeners: (() => void)[] = [];
  private closed = false;

  postMessage(message: unknown): void {
    if (!this.peer || this.closed) return;
    const target = this.peer;
    queueMicrotask(() => target.deliver(message));
  }
  start(): void {}
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }
  on(event: "message", listener: (event: { data: unknown }) => void): void {
    if (event === "message") this.listeners.push(listener);
  }
  once(event: "close", listener: () => void): void {
    if (event === "close") this.closeListeners.push(listener);
  }
  private deliver(message: unknown): void {
    for (const listener of [...this.listeners]) listener({ data: message });
  }
}

function createPortPair(): { port1: FakePort; port2: FakePort } {
  const port1 = new FakePort();
  const port2 = new FakePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

async function waitFor<T>(
  probe: () => T | undefined | null,
  timeoutMs = 10_000,
  what = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("Relay V3 device manager（P1，fake relay 集成）", () => {
  let relay: Awaited<ReturnType<typeof createFakeRelayV3>>;
  let harness: Harness;

  beforeAll(async () => {
    relay = await createFakeRelayV3({ accounts: [PHONE] });
    const configDir = mkdtempSync(join(tmpdir(), "relay-v3-p1-"));
    const attachCalls: Harness["attachCalls"] = [];
    const hostPorts = new Map<string, FakePort>();
    const statuses: RelayV3DesktopStatus[] = [];
    const logs: string[] = [];
    const settingsStore: {
      relayV3?: { lastEnabled?: { workspacePath: string; workspaceIdentity?: string } };
    } = {};
    const manager = new RelayV3DeviceManager({
      logger: {
        debug: (message, fields) => logs.push(`${message} ${JSON.stringify(fields ?? {})}`),
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
        error: (message) => logs.push(message),
      },
      appVersion: "3.22.0-test",
      getRelayConfig: () => ({ endpointOrigin: relay.httpUrl, staticPageBaseUrl: null }),
      settings: {
        read: () =>
          Promise.resolve({
            relayV3: settingsStore.relayV3,
          } as never),
        patch: async (patch) => {
          settingsStore.relayV3 = { ...settingsStore.relayV3, ...patch.relayV3 };
        },
      },
      configDir,
      hostname: "test-host",
      platform: "darwin",
      resolveDeviceMid: () => "mid_test_123",
      attachHostPort: ({ windowId, attachmentId, scope, port }) => {
        attachCalls.push({ windowId, attachmentId, terminalOwnerId: "", scope });
        hostPorts.set(attachmentId, port as FakePort);
      },
      detachHostPort: (attachmentId) => {
        hostPorts.delete(attachmentId);
      },
      createMessageChannel: createPortPair,
      broadcastStatus: (status) => statuses.push(status),
    });
    harness = {
      manager,
      configDir,
      attachCalls,
      hostPorts,
      statuses,
      logs,
      cleanup: async () => {
        manager.dispose();
        await relay.close();
        rmSync(configDir, { recursive: true, force: true });
      },
    };
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("登录 → 注册带公钥 → 配对 → 密文 bootstrap → bridge rpc 往返", async () => {
    // 1. 登录：先经 manager 发送验证码，再从 fake relay 测试接缝读出。
    const sendResult = await harness.manager.sendSmsCode(PHONE);
    expect(sendResult.ok).toBe(true);
    const code = relay.smsCode(PHONE);
    expect(code).toBeTruthy();
    const loginResult = await harness.manager.loginWithCode(PHONE, code!);
    expect(loginResult.ok).toBe(true);
    // 登录提交后当前已挂载的设置节必须立刻看到账号，不能等重新进入页面再查状态。
    expect(harness.statuses.some((item) => item.account?.phoneMasked)).toBe(true);
    expect(harness.manager.getStatus().deviceMid).toBe("mid_test_123");

    // 2. workspace 同步 + 票据启动。
    harness.manager.syncWorkspaces(1, [
      { workspaceKey: "/w/proj", workspacePath: "/w/proj", bridgeable: true },
    ]);
    const ticket = harness.manager.authorizeStart(1, { workspacePath: "/w/proj" });
    const startResult = await harness.manager.startAuthorized(ticket);
    expect(startResult.accepted).toBe(true);

    // 3. 等待 device 上线（waiting）。
    await waitFor(
      () => (harness.manager.getStatus().phase === "waiting" ? harness.manager.getStatus() : null),
      10_000,
      "device waiting",
    );
    const status = harness.manager.getStatus();
    expect(status.deviceSid).toBeTruthy();
    expect(status.qrUrl).toContain(status.deviceSid);
    expect(status.qrUrl).toContain("mid_test_123");

    // 4. terminal 侧：取设备公钥（HTTP 列表）→ terminal token → WS 配对。
    const listResponse = await fetch(`${relay.httpUrl}/v3/device`, {
      headers: { authorization: `Bearer ${await currentAccessToken()}` },
    });
    const listEnvelope = (await listResponse.json()) as {
      code: number;
      data: { device_sid: string; public_key: string }[];
    };
    expect(listEnvelope.code).toBe(0);
    const deviceRecord = listEnvelope.data.find((device) => device.device_sid === status.deviceSid);
    expect(deviceRecord).toBeTruthy();
    const kid = relayV3KeyId(decodeRelayV3Base64Url(deviceRecord!.public_key));
    // 二维码指纹必须来自被控端本地公钥，不能依赖 relay 目录内容。
    expect(parseRelayV3QrUrl(status.qrUrl ?? "")?.fingerprint).toBe(kid);

    const terminalKeys = generateRelayV3KeyPair();
    const sessionKey = deriveRelayV3SessionKey(
      terminalKeys.privateKey,
      decodeRelayV3Base64Url(deviceRecord!.public_key),
    );

    const tokenResponse = await fetch(`${relay.httpUrl}/v3/relay/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await currentAccessToken()}`,
      },
      body: JSON.stringify({ role: "terminal" }),
    });
    const tokenEnvelope = (await tokenResponse.json()) as { code: number; data: { token: string } };
    expect(tokenEnvelope.code).toBe(0);

    const terminalSocket = new WebSocket(
      `${relay.wsUrl}?token=${encodeURIComponent(tokenEnvelope.data.token)}`,
    );
    const terminalIncoming: unknown[] = [];
    const sendFromTerminal = (payload: Record<string, unknown>) => {
      terminalSocket.send(
        JSON.stringify({
          type: "data",
          payload: sealRelayV3Envelope(
            sessionKey,
            new TextEncoder().encode(JSON.stringify(payload)),
            kid,
            relayV3EnvelopeAad("terminal"),
          ),
        }),
      );
    };
    const waitForTerminalPayload = (zcodeType: string) =>
      waitFor(
        () => {
          for (const value of terminalIncoming) {
            const message = value as { type: string; payload?: unknown };
            if (message?.type !== "data") continue;
            try {
              const plaintext = openRelayV3Envelope(
                sessionKey,
                message.payload,
                relayV3EnvelopeAad("device"),
              );
              const parsed = parseRelayV3AppPayload(
                JSON.parse(new TextDecoder().decode(plaintext)),
              );
              if (parsed?.zcode_type === zcodeType) return parsed;
            } catch {
              // 解密失败（旧连接密文等）：跳过继续找。
            }
          }
          return null;
        },
        10_000,
        `terminal payload ${zcodeType}`,
      );
    terminalSocket.on("message", (data: WebSocket.RawData) => {
      terminalIncoming.push(JSON.parse(data.toString()));
    });
    await new Promise<void>((resolve) => terminalSocket.once("open", resolve));
    terminalSocket.send(
      JSON.stringify({
        type: "auth_init",
        device_sid: status.deviceSid,
        terminal_public_key: encodeRelayV3Base64Url(terminalKeys.publicKey),
      }),
    );

    // 5. 配对后 device 转 active；terminal 发 bootstrap-request 收到密文响应。
    await waitFor(
      () => (harness.manager.getStatus().phase === "active" ? true : null),
      10_000,
      "device active",
    );
    sendFromTerminal({
      zcode_type: "bootstrap-request",
      terminal_client_id: "test-terminal",
      terminal_kind: "phone-web",
    });
    const bootstrap = await waitForTerminalPayload("bootstrap-response");
    expect(bootstrap.zcode_type).toBe("bootstrap-response");
    expect((bootstrap as { workspaces: { workspace_key: string }[] }).workspaces).toEqual([
      expect.objectContaining({ workspace_key: "/w/proj", bridgeable: true }),
    ]);

    // 6. bridge open → host attach + ready；rpc-frame 经 FakePort 往返。
    sendFromTerminal({
      zcode_type: "workspace-bridge-open",
      bridge_session_id: "bs_test_1",
      workspace_key: "/w/proj",
      terminal_client_session_id: "page_1",
    });
    await waitForTerminalPayload("workspace-bridge-ready");
    await waitFor(
      () => (harness.attachCalls.length > 0 ? harness.attachCalls : null),
      5_000,
      "host attach",
    );
    expect(harness.attachCalls[0]!.scope.kind).toBe("local");

    // 模拟 Host 从 port2 发 RPC 二进制（MessagePortProtocol 的原始 Uint8Array；
    // kind 前缀由 manager 的 bridge-port 编码层添加）→ terminal 侧收到 rpc-frame。
    const hostPort = harness.hostPorts.get(harness.attachCalls[0]!.attachmentId)!;
    const rpcMessage = new TextEncoder().encode('{"id":1,"method":"v4/conversation/subscribe"}');
    hostPort.postMessage(new Uint8Array(rpcMessage));
    const rpcFrame = await waitFor(
      () => {
        for (const value of terminalIncoming.slice().reverse()) {
          const message = value as { type: string; payload?: unknown };
          if (message?.type !== "data") continue;
          try {
            const plaintext = openRelayV3Envelope(
              sessionKey,
              message.payload,
              relayV3EnvelopeAad("device"),
            );
            const parsed = parseRelayV3RpcFrame(JSON.parse(new TextDecoder().decode(plaintext)));
            if (parsed?.zcode_type === "rpc-frame") return parsed;
          } catch {
            /* 非密文或解密失败：继续找 */
          }
        }
        return null;
      },
      10_000,
      "rpc-frame at terminal",
    );
    expect(rpcFrame.bridge_session_id).toBe("bs_test_1");
    expect(rpcFrame.message_bytes).toBe(rpcMessage.length + 1);

    // terminal 回 ACK：device 侧 adapter 释放 batch；Host port 收到该 ACK 的流控无关。
    sendFromTerminal({
      zcode_type: "rpc-frame-ack",
      bridge_session_id: "bs_test_1",
      message_seq: rpcFrame.message_seq,
      fragment_count_ack: rpcFrame.fragment_count,
    });
    // Host → device 方向的下行 RPC 也应原样到达 terminal（rpc-frame 已验证）。

    // 7. terminal 断开 → device 回 waiting，bridge 释放。
    terminalSocket.close();
    await waitFor(
      () => (harness.manager.getStatus().phase === "waiting" ? true : null),
      15_000,
      "device back to waiting",
    );
    await waitFor(
      () => (harness.manager.getActiveBridgeCount() === 0 ? true : null),
      5_000,
      "bridge released",
    );

    // 8. 私钥不进日志（AGENTS 日志边界）。
    await harness.manager.stop();
    const identityFile = join(harness.configDir, "relay-v3-device.json");
    const identityRaw = await import("node:fs/promises").then((fs) =>
      fs.readFile(identityFile, "utf-8"),
    );
    const privateKey = (JSON.parse(identityRaw) as { privateKey: string }).privateKey;
    expect(privateKey).toBeTruthy();
    for (const line of harness.logs) {
      expect(line).not.toContain(privateKey);
    }
  }, 60_000);

  it("票据过期/伪造拒绝；未登录启动 → auth-required", async () => {
    const bogus = await harness.manager.startAuthorized("not-a-ticket");
    expect(bogus.accepted).toBe(false);
    expect(harness.manager.getStatus().phase).toBe("idle");
  });

  async function currentAccessToken(): Promise<string> {
    // fake relay 的账号体系：先 POST sms-code，再读接缝 code，HTTP login 拿 access。
    const sendResponse = await fetch(`${relay.httpUrl}/v3/auth/sms-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: PHONE }),
    });
    expect(sendResponse.ok).toBe(true);
    const code = relay.smsCode(PHONE);
    expect(code).toBeTruthy();
    const response = await fetch(`${relay.httpUrl}/v3/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: PHONE, code }),
    });
    const envelope = (await response.json()) as { code: number; data: { access: string } };
    expect(envelope.code).toBe(0);
    return envelope.data.access;
  }
});

// 设计 §3.5：服务器地址是账号凭据与设备身份的归属边界，切换顺序即安全边界。
// 用例按顺序共享同一 manager：未登录配置 → 登录并上线 → 切换 → 切换后 no-op。
describe("Relay V3 device manager：切换服务器地址（设计 §3.5）", () => {
  const NEW_ORIGIN = "https://relay-new.example.com";
  let relay: Awaited<ReturnType<typeof createFakeRelayV3>>;
  let configDir: string;
  let manager: RelayV3DeviceManager;
  let relayV3Settings: Record<string, unknown> | undefined;
  /** 网络请求与设置写入的先后顺序，entry 形如 `fetch:<url>` / `patch:<endpointOrigin>`。 */
  const timeline: string[] = [];
  const fetchEntries = () => timeline.filter((entry) => entry.startsWith("fetch:"));
  /**
   * 挂起 register 请求的闸门，用来构造"注册等待期间被打断"：放行后 reject 为真则模拟注册失败，
   * 否则照常打到 fake relay（模拟迟到的注册成功）。
   */
  let registerHold: { promise: Promise<void>; reject: boolean } | null = null;

  beforeAll(async () => {
    relay = await createFakeRelayV3({ accounts: [PHONE] });
    configDir = mkdtempSync(join(tmpdir(), "relay-v3-endpoint-"));
    manager = new RelayV3DeviceManager({
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      appVersion: "3.22.0-test",
      getRelayConfig: () => ({
        endpointOrigin: (relayV3Settings?.endpointOrigin as string | undefined) ?? null,
        staticPageBaseUrl: null,
      }),
      settings: {
        read: () => Promise.resolve({ relayV3: relayV3Settings } as never),
        patch: async (patch) => {
          // 与 settingService.update 的语义一致：顶层字段整体替换，relayV3 子对象不做深合并
          //（stop() 正是靠整块替换去掉 lastEnabled）。
          relayV3Settings = patch.relayV3;
          timeline.push(`patch:${String(patch.relayV3?.endpointOrigin ?? "")}`);
        },
      },
      configDir,
      fetchImpl: async (input, init) => {
        const url = String(input);
        timeline.push(`fetch:${url}`);
        const hold = url === `${relay.httpUrl}${RELAY_V3_HTTP.register.path}` ? registerHold : null;
        if (hold) {
          registerHold = null;
          await hold.promise;
          if (hold.reject) throw new Error("register aborted by test");
        }
        return fetch(input, init);
      },
      hostname: "test-host",
      resolveDeviceMid: () => "mid_test_123",
      attachHostPort: () => {},
      detachHostPort: () => {},
    });
  });

  afterAll(async () => {
    manager.dispose();
    await relay.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("未登录时配置地址：只落盘，不发请求、不创建设备身份", async () => {
    // 首尾空白与尾斜杠在 main 归一化。
    const result = await manager.configureEndpoint(` ${relay.httpUrl}/ `);
    expect(result).toEqual({ ok: true, endpointOrigin: relay.httpUrl, changed: true });
    expect(fetchEntries()).toEqual([]);
    expect(relayV3Settings).toEqual({ endpointOrigin: relay.httpUrl });
    expect(manager.getStatus()).toMatchObject({
      phase: "idle",
      account: null,
      deviceSid: null,
      relayOrigin: relay.httpUrl,
    });
    expect(existsSync(join(configDir, "relay-v3-device.json"))).toBe(false);
  });

  it("已登录并上线时：非法地址被拒绝，等价地址 no-op，均无副作用", async () => {
    expect((await manager.sendSmsCode(PHONE)).ok).toBe(true);
    expect((await manager.loginWithCode(PHONE, relay.smsCode(PHONE)!)).ok).toBe(true);
    manager.syncWorkspaces(1, [
      { workspaceKey: "/w/proj", workspacePath: "/w/proj", bridgeable: true },
    ]);
    const ticket = manager.authorizeStart(1, { workspacePath: "/w/proj" });
    expect((await manager.startAuthorized(ticket)).accepted).toBe(true);
    await waitFor(
      () => (manager.getStatus().phase === "waiting" ? true : null),
      10_000,
      "device waiting",
    );
    timeline.length = 0;

    for (const invalid of [
      "relay.example.com",
      "ftp://relay.example.com",
      "https://user:pass@relay.example.com",
      `${relay.httpUrl}/v3`,
      `${relay.httpUrl}?x=1`,
      "",
    ]) {
      expect(await manager.configureEndpoint(invalid)).toEqual({
        ok: false,
        reason: "invalid-origin",
      });
    }
    // 归一化后与当前地址相同：不登出、不写盘，已上线的连接不受影响。
    expect(await manager.configureEndpoint(`${relay.httpUrl}/`)).toEqual({
      ok: true,
      endpointOrigin: relay.httpUrl,
      changed: false,
    });
    expect(timeline).toEqual([]);
    expect(manager.getStatus()).toMatchObject({
      phase: "waiting",
      account: { phoneMasked: expect.any(String) },
      relayOrigin: relay.httpUrl,
    });
  }, 30_000);

  it("切换地址：先对旧地址登出、重置设备身份，再落盘新地址", async () => {
    timeline.length = 0;
    expect(manager.getStatus().deviceSid).toBeTruthy();

    const result = await manager.configureEndpoint(`${NEW_ORIGIN}/`);
    expect(result).toEqual({ ok: true, endpointOrigin: NEW_ORIGIN, changed: true });

    // 登出请求必须命中旧地址，且早于新地址落盘（反序会把旧凭据发给新服务器）。
    const logoutIndex = timeline.indexOf(`fetch:${relay.httpUrl}${RELAY_V3_HTTP.logout.path}`);
    expect(logoutIndex).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf(`patch:${NEW_ORIGIN}`)).toBeGreaterThan(logoutIndex);
    // 切换后未登录、未启动：不向新地址发任何请求。
    expect(fetchEntries().filter((entry) => entry.startsWith(`fetch:${NEW_ORIGIN}`))).toEqual([]);

    expect(manager.getStatus()).toMatchObject({
      phase: "idle",
      account: null,
      deviceSid: null,
      qrUrl: null,
      relayOrigin: NEW_ORIGIN,
    });
    // 启用意图随切换清除，只保留新地址。
    expect(relayV3Settings).toEqual({ endpointOrigin: NEW_ORIGIN });
    // 旧 SID 只对旧 relay 有效：身份文件不得再携带它。
    const identity = JSON.parse(readFileSync(join(configDir, "relay-v3-device.json"), "utf-8")) as {
      deviceSid?: string;
    };
    expect(identity.deviceSid).toBeUndefined();
  }, 30_000);

  it("切换后重复保存同一地址：no-op", async () => {
    timeline.length = 0;
    expect(await manager.configureEndpoint(NEW_ORIGIN)).toEqual({
      ok: true,
      endpointOrigin: NEW_ORIGIN,
      changed: false,
    });
    expect(timeline).toEqual([]);
  });

  /** 发起一次启动并把它的注册请求挂起；等请求真正发出才返回，保证打断落在注册等待期间。 */
  async function startWithHeldRegister(reject: boolean): Promise<{
    start: Promise<{ accepted: boolean; reason?: string }>;
    release: () => void;
  }> {
    let release = () => {};
    registerHold = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      reject,
    };
    const start = manager.startAuthorized(manager.authorizeStart(1, { workspacePath: "/w/proj" }));
    await waitFor(() => (registerHold === null ? true : null), 5_000, "register request");
    return { start, release };
  }

  async function listRelayDevices(): Promise<{ device_sid: string; public_key: string }[]> {
    const access = await manager.getAccountService().getAccessToken();
    const response = await fetch(`${relay.httpUrl}${RELAY_V3_HTTP.list.path}`, {
      headers: { authorization: `Bearer ${access}` },
    });
    const envelope = (await response.json()) as {
      code: number;
      data: { device_sid: string; public_key: string }[];
    };
    expect(envelope.code).toBe(0);
    return envelope.data;
  }

  it("注册等待期间被停止、注册随后成功：结果不保留，并在 relay 侧补偿删除", async () => {
    // 切回 fake relay 并重新登录；设备身份已在切换时重置，下次启动会重新注册。
    expect(await manager.configureEndpoint(relay.httpUrl)).toEqual({
      ok: true,
      endpointOrigin: relay.httpUrl,
      changed: true,
    });
    expect((await manager.sendSmsCode(PHONE)).ok).toBe(true);
    expect((await manager.loginWithCode(PHONE, relay.smsCode(PHONE)!)).ok).toBe(true);
    const identity = JSON.parse(readFileSync(join(configDir, "relay-v3-device.json"), "utf-8")) as {
      publicKey: string;
    };
    timeline.length = 0;

    const { start, release } = await startWithHeldRegister(false);
    // 注册仍在等待时用户明确停止；随后注册成功也不该把这次作废的注册留下来。
    await manager.stop();
    release();

    expect(await start).toEqual({ accepted: false, reason: "stopped" });
    expect(manager.getStatus()).toMatchObject({ phase: "idle", deviceSid: null });
    expect(timeline).toContain(`fetch:${relay.httpUrl}${RELAY_V3_HTTP.delete.path}`);
    expect(
      (await listRelayDevices()).some((device) => device.public_key === identity.publicKey),
    ).toBe(false);
  }, 30_000);

  it("注册等待期间被停止、注册随后失败：启动作废，不改写 phase", async () => {
    // 上一条用例没有保留注册结果，设备仍未注册，可以再次构造注册等待。
    const { start, release } = await startWithHeldRegister(true);
    expect(manager.getStatus().phase).toBe("starting");

    await manager.stop();
    release();

    expect(await start).toEqual({ accepted: false, reason: "stopped" });
    expect(manager.getStatus()).toMatchObject({ phase: "idle", deviceSid: null });
  }, 30_000);
});
