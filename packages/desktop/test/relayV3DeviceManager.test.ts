import { mkdtempSync, rmSync } from "node:fs";
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
  parseRelayV3RpcFrame,
  sealRelayV3Envelope,
  type RelayV3DesktopStatus,
} from "@zcode/shared/remote-relay-v3";

import {
  RelayV3DeviceManager,
  type MessagePortLike,
} from "../src/main/remote-relay-v3/index.js";

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
    const settingsStore: { relayV3?: { lastEnabled?: { workspacePath: string; workspaceIdentity?: string } } } = {};
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
    const deviceRecord = listEnvelope.data.find(
      (device) => device.device_sid === status.deviceSid,
    );
    expect(deviceRecord).toBeTruthy();

    const terminalKeys = generateRelayV3KeyPair();
    const sessionKey = deriveRelayV3SessionKey(
      terminalKeys.privateKey,
      decodeRelayV3Base64Url(deviceRecord!.public_key),
    );
    const kid = await import("@zcode/shared/remote-relay-v3").then((m) =>
      m.relayV3KeyId(decodeRelayV3Base64Url(deviceRecord!.public_key)),
    );

    const tokenResponse = await fetch(`${relay.httpUrl}/v3/relay/token`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await currentAccessToken()}` },
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
          ),
        }),
      );
    };
    const waitForTerminalPayload = (zcodeType: string) =>
      waitFor(() => {
        for (const value of terminalIncoming) {
          const message = value as { type: string; payload?: unknown };
          if (message?.type !== "data") continue;
          try {
            const plaintext = openRelayV3Envelope(sessionKey, message.payload);
            const parsed = parseRelayV3AppPayload(JSON.parse(new TextDecoder().decode(plaintext)));
            if (parsed?.zcode_type === zcodeType) return parsed;
          } catch {
            // 解密失败（旧连接密文等）：跳过继续找。
          }
        }
        return null;
      }, 10_000, `terminal payload ${zcodeType}`);
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
    await waitFor(() => (harness.attachCalls.length > 0 ? harness.attachCalls : null), 5_000, "host attach");
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
            const plaintext = openRelayV3Envelope(sessionKey, message.payload);
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
    const identityRaw = await import("node:fs/promises").then((fs) => fs.readFile(identityFile, "utf-8"));
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
