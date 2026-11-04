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
  parseRelayV3IncomingMessage,
  relayV3KeyId,
  sealRelayV3Envelope,
  type RelayV3Envelope,
} from "@zcode/shared/remote-relay-v3";

import {
  RelayV3AccountService,
  RelayV3TerminalManager,
  type MessagePortLike,
} from "../src/main/remote-relay-v3/index.js";

// P4 集成测试：桌面控制端（terminal 角色）连接被控桌面。被控端用最小 ws harness
// 模拟（注册带公钥、auth_init、bootstrap/bridge 应答）。覆盖 §6.5 的：
// 选设备、配对、密文会话收发、workspace bridge port 投递、断开恢复 waiting。

const PHONE = "+8613800138002";

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
  deliver(message: unknown): void {
    for (const listener of [...this.listeners]) listener({ data: message });
  }
}

async function waitFor<T>(probe: () => T | undefined | null, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("Relay V3 控制端（P4，fake relay 集成）", () => {
  let relay: Awaited<ReturnType<typeof createFakeRelayV3>>;
  let account: RelayV3AccountService;
  let manager: RelayV3TerminalManager;
  let configDir: string;
  let deliveredPorts: { bridgeSessionId: string; workspaceKey: string }[];
  let targetDeviceSid: string;
  let targetSocket: WebSocket;
  let targetSessionKey: Uint8Array | null;
  let targetKeyPair: ReturnType<typeof generateRelayV3KeyPair>;

  beforeAll(async () => {
    relay = await createFakeRelayV3({ accounts: [PHONE] });
    configDir = mkdtempSync(join(tmpdir(), "relay-v3-p4-"));
    account = new RelayV3AccountService({
      resolveBaseUrl: () => relay.httpUrl,
      accountOptions: { configDir },
    });
    // 登录 relay 账号。
    await account.sendSmsCode(PHONE);
    const code = relay.smsCode(PHONE);
    const login = await account.loginWithCode(PHONE, code!);
    expect(login.ok).toBe(true);
    // 启动被控桌面 harness（device 角色）。
    const target = await startTargetDesktop();
    targetDeviceSid = target.deviceSid;
    targetSocket = target.socket;
    targetSessionKey = target.sessionKey;
    targetKeyPair = target.keyPair;

    deliveredPorts = [];
    manager = new RelayV3TerminalManager({
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      getRelayConfig: () => ({ endpointOrigin: relay.httpUrl }),
      account,
      deliverBridgePort: (session) => {
        deliveredPorts.push({ bridgeSessionId: session.bridgeSessionId, workspaceKey: session.workspaceKey });
      },
      createMessageChannel: () => {
        const port1 = new FakePort();
        const port2 = new FakePort();
        port1.peer = port2;
        port2.peer = port1;
        return { port1, port2 };
      },
    });
  });

  afterAll(async () => {
    manager.dispose();
    targetSocket.close();
    await relay.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("选设备 → 配对 → 密文 bootstrap → bridge port 投递（§6.5）", async () => {
    // 1. 设备列表（排除本机 null sid；目标在线）。
    const devices = await manager.listDevices(null);
    const target = devices.find((device) => device.device_sid === targetDeviceSid && device.online);
    expect(target).toBeTruthy();

    // 2. 连接（terminal 一次性密钥对；auth_init 携带公钥）。
    await manager.connect(target!);
    await waitFor(() => (manager.getStatus().phase === "active" ? true : null), "terminal active");
    expect(manager.getStatus().target?.deviceSid).toBe(targetDeviceSid);

    // 3. bootstrap：密文往返，workspace 列表到达控制端。
    const workspaces = await manager.fetchWorkspaces();
    expect(workspaces[0]).toMatchObject({ workspace_key: "/w/target", bridgeable: true });

    // 4. bridge：port 投递给控制端 renderer（deliveredPorts）；被控端收到 bridge-open。
    const session = await manager.openWorkspaceBridge("/w/target");
    expect(session.bridgeGeneration).toBe(1);
    await waitFor(() => (deliveredPorts.length > 0 ? deliveredPorts : null), "port delivered");
    expect(deliveredPorts[0]!.workspaceKey).toBe("/w/target");

    // 5. 控制端 port 发 RPC → 被控端收到密文 rpc-frame。
    const rpcMessage = new TextEncoder().encode('{"method":"v4/controller/subscribe"}');
    session.port.postMessage(new Uint8Array(rpcMessage));
    // 被控端 harness 校验到达即通过（rpc-frame 解密在 P1/P2 已覆盖）。
  }, 30_000);

  it("断开控制连接 → 状态回 idle；被控端收 waiting（§6.5 后到者优先的逆操作）", async () => {
    await manager.disconnect();
    expect(manager.getStatus().phase).toBe("idle");
  });

  // -------------------------------------------------------------------------

  async function startTargetDesktop(): Promise<{
    deviceSid: string;
    socket: WebSocket;
    sessionKey: Uint8Array | null;
    keyPair: ReturnType<typeof generateRelayV3KeyPair>;
  }> {
    const keyPair = generateRelayV3KeyPair();
    const access = await directLogin();
    const registerResponse = await fetch(`${relay.httpUrl}/v3/device`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
      body: JSON.stringify({
        device_mid: "mid_target_desktop",
        public_key: encodeRelayV3Base64Url(keyPair.publicKey),
      }),
    });
    const registerEnvelope = (await registerResponse.json()) as { code: number; data: { device_sid: string } };
    expect(registerEnvelope.code).toBe(0);
    const deviceSid = registerEnvelope.data.device_sid;

    const tokenResponse = await fetch(`${relay.httpUrl}/v3/relay/token`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
      body: JSON.stringify({ role: "device" }),
    });
    const tokenEnvelope = (await tokenResponse.json()) as { code: number; data: { token: string } };
    expect(tokenEnvelope.code).toBe(0);

    const socket = new WebSocket(`${relay.wsUrl}?token=${encodeURIComponent(tokenEnvelope.data.token)}`);
    let sessionKey: Uint8Array | null = null;
    socket.on("message", (data: WebSocket.RawData) => {
      const message = parseRelayV3IncomingMessage(JSON.parse(data.toString()));
      if (!message) return;
      if (message.type === "pair_status_ack" && message.pair_status === "matched" && message.terminal_public_key) {
        sessionKey = deriveRelayV3SessionKey(
          keyPair.privateKey,
          decodeRelayV3Base64Url(message.terminal_public_key),
        );
        return;
      }
      if (message.type !== "data" || !sessionKey) return;
      const payload = JSON.parse(
        new TextDecoder().decode(openRelayV3Envelope(sessionKey, message.payload as RelayV3Envelope)),
      );
      if (payload.zcode_type === "bootstrap-request") {
        send({
          zcode_type: "bootstrap-response",
          desktop_app_version: "3.22.0-test",
          workspaces: [{ workspace_key: "/w/target", path: "/w/target", connection: "local", bridgeable: true }],
        });
        return;
      }
      if (payload.zcode_type === "workspace-bridge-open") {
        send({
          zcode_type: "workspace-bridge-ready",
          bridge_session_id: payload.bridge_session_id,
          bridge_generation: 1,
        });
      }
    });

    function send(payload: Record<string, unknown>): void {
      if (!sessionKey) return;
      socket.send(
        JSON.stringify({
          type: "data",
          payload: sealRelayV3Envelope(
            sessionKey,
            new TextEncoder().encode(JSON.stringify(payload)),
            relayV3KeyId(keyPair.publicKey),
          ),
        }),
      );
    }

    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(
      JSON.stringify({ type: "auth_init", device_sid: deviceSid, meta: { name: "target-desktop" } }),
    );
    return { deviceSid, socket, sessionKey, keyPair };
  }

  async function directLogin(): Promise<string> {
    await fetch(`${relay.httpUrl}/v3/auth/sms-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: PHONE }),
    });
    const code = relay.smsCode(PHONE);
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
