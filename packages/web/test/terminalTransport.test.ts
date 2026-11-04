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

import { WebRelayAccount } from "../src/relay/relayAccount.js";
import { RelayV3TerminalTransport } from "../src/relay/terminalTransport.js";
import { RelayV3WebConnection } from "../src/relay/connection.js";
import { createDeviceCatalog } from "../src/relay/deviceCatalog.js";

// P2 集成测试：真实 loopback fake relay；device 侧用最小 ws harness 模拟桌面 main
//（注册带公钥、auth_init、透传密文解密应答 bootstrap/bridge）。验证 terminal 的
// 一次性密钥、auth_init 公钥携带、密文 bootstrap/bridge、rpc-frame 与 cumulative ACK。

const PHONE = "+8613800138001";

interface DeviceHarness {
  deviceSid: string;
  publicKeyB64: string;
  incoming: { zcode_type: string; [key: string]: unknown }[];
  dispose: () => void;
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

describe("/remote/v4 terminal 数据通路（P2，fake relay 集成）", () => {
  let relay: Awaited<ReturnType<typeof createFakeRelayV3>>;
  let account: WebRelayAccount;
  let catalog: ReturnType<typeof createDeviceCatalog>;
  let device: DeviceHarness;

  beforeAll(async () => {
    relay = await createFakeRelayV3({ accounts: [PHONE] });
    accountStorage = memoryStorage();
    account = new WebRelayAccount(() => relay.httpUrl, accountStorage);
    // 登录（refresh 落内存 storage，不依赖浏览器 localStorage）。
    await fetch(`${relay.httpUrl}/v3/auth/sms-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: PHONE }),
    });
    const code = relay.smsCode(PHONE);
    const login = await account.loginWithCode(PHONE, code!);
    expect(login.ok).toBe(true);
    catalog = createDeviceCatalog({
      resolveOrigin: () => relay.httpUrl,
      acquireAccessToken: () => account.getAccessToken(),
      storage: memoryStorage(),
    });
    device = await startDeviceHarness();
  });

  afterAll(async () => {
    device.dispose();
    await relay.close();
  });

  it("设备列表 → 一次性密钥配对 → 密文 bootstrap → bridge ready → rpc-frame/ACK", async () => {
    // 1. 列表：注册的 device 在线；无最近记录时落点为 null（展示列表，V2 06）。
    const devices = await catalog.listDevices();
    expect(devices.some((item) => item.device_sid === device.deviceSid && item.online)).toBe(true);
    expect(catalog.resolveRecentLanding(devices)).toBeNull();

    // 2. terminal transport + connection。
    const transport = new RelayV3TerminalTransport({
      resolveOrigin: () => relay.httpUrl,
      acquireAccessToken: () => account.getAccessToken(),
      deviceSid: device.deviceSid,
      devicePublicKeyB64: device.publicKeyB64,
      createSocket: (url) => new NodeWebSocket(url),
      onState: () => {},
      onAppPayload: (payload) => connection.handlePayload(payload),
    });
    const connection = new RelayV3WebConnection(transport);
    transport.start();
    await waitFor(() => (transport.getState().phase === "matched" ? true : null), "terminal matched");

    // 3. bootstrap：密文请求/响应（device harness 应答）。
    const bootstrap = await connection.bootstrap("web_test_client");
    expect(bootstrap.zcode_type).toBe("bootstrap-response");
    expect(bootstrap.workspaces[0]).toMatchObject({ workspace_key: "/w/demo", bridgeable: true });

    // 4. bridge open → ready（device harness 分配 generation/owner）。
    const bridge = await connection.openWorkspaceBridge("/w/demo");
    expect(bridge.bridgeGeneration).toBe(1);
    expect(bridge.terminalOwnerId).toBe("owner_test");

    // 5. rpc-frame 经 bridge port → device 侧收到分片；ACK 回流。
    bridge.port.postMessage(new TextEncoder().encode('{"id":1,"method":"ping"}'));
    const seenFrame = (
      await waitFor(
        () => device.incoming.find((item) => item.zcode_type === "rpc-frame") ?? null,
        "rpc-frame at device",
      )
    ) as { zcode_type: "rpc-frame"; bridge_session_id: string; message_seq: number; fragment_count: number };
    transport.send({
      zcode_type: "rpc-frame-ack",
      bridge_session_id: seenFrame.bridge_session_id,
      message_seq: seenFrame.message_seq,
      fragment_count_ack: seenFrame.fragment_count,
    });

    connection.dispose();
    transport.stop();
  }, 30_000);

  it("refresh 旋转后旧 refresh 重放 → 家族撤销 → 会话清理", async () => {
    // fake relay 实现了与真实一致的家族撤销语义；account 侧验证：
    // 已旋转的 refresh 再被使用 → restore 失败并清会话（回登录，V2 05 语义）。
    const staleRefresh = await captureRefreshViaStorage();
    const access = await account.getAccessToken(); // 正常旋转一次（旧 refresh 作废）。
    expect(access).toBeTruthy();
    const replayStorage = memoryStorage();
    replayStorage.setItem(
      "zcode-relay-v3-session",
      JSON.stringify({ refresh: staleRefresh, account: { id: "a", phone_masked: "+86****8001" } }),
    );
    const replayAccount = new WebRelayAccount(() => relay.httpUrl, replayStorage);
    const restored = await replayAccount.restore();
    expect(restored).toBe(false);
    expect(replayAccount.isSignedIn()).toBe(false);
  });

  // ---------------------------------------------------------------------------

  let storageData: Record<string, string> | null = null;
  let accountStorage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void } | null = null;

  function memoryStorage() {
    const data: Record<string, string> = {};
    storageData = data;
    return {
      getItem: (key: string) => data[key] ?? null,
      setItem: (key: string, value: string) => {
        data[key] = value;
      },
      removeItem: (key: string) => {
        delete data[key];
      },
    };
  }

  async function captureRefreshViaStorage(): Promise<string> {
    const raw = accountStorage?.getItem("zcode-relay-v3-session") ?? null;
    expect(raw).toBeTruthy();
    return (JSON.parse(raw!) as { refresh: string }).refresh;
  }

  async function startDeviceHarness(): Promise<DeviceHarness> {
    const keyPair = generateRelayV3KeyPair();
    const publicKeyB64 = encodeRelayV3Base64Url(keyPair.publicKey);
    const access = await directLogin();
    const registerResponse = await fetch(`${relay.httpUrl}/v3/device`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
      body: JSON.stringify({ device_mid: "mid_web_test", public_key: publicKeyB64 }),
    });
    const registerEnvelope = (await registerResponse.json()) as {
      code: number;
      data: { device_sid: string };
    };
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
    const incoming: { zcode_type: string; [key: string]: unknown }[] = [];
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
      incoming.push(payload);
      reply(payload);
    });

    function reply(payload: { zcode_type: string; [key: string]: unknown }): void {
      if (payload.zcode_type === "bootstrap-request") {
        send({
          zcode_type: "bootstrap-response",
          desktop_app_version: "3.22.0-test",
          workspaces: [{ workspace_key: "/w/demo", path: "/w/demo", connection: "local", bridgeable: true }],
        });
        return;
      }
      if (payload.zcode_type === "workspace-bridge-open") {
        send({
          zcode_type: "workspace-bridge-ready",
          bridge_session_id: payload.bridge_session_id,
          bridge_generation: 1,
          terminal_owner_id: "owner_test",
        });
      }
    }

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
    socket.send(JSON.stringify({ type: "auth_init", device_sid: deviceSid, meta: { name: "web-test-device" } }));

    return {
      deviceSid,
      publicKeyB64,
      incoming,
      dispose: () => socket.close(),
    };
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

/** Node ws 适配为 terminal transport 的浏览器式 WebSocket 面。 */
class NodeWebSocket {
  private readonly socket: WebSocket;
  constructor(url: string) {
    this.socket = new WebSocket(url);
  }
  send(text: string): void {
    this.socket.send(text);
  }
  close(): void {
    this.socket.close();
  }
  addEventListener(kind: "open" | "error" | "close" | "message", listener: (event?: unknown) => void): void {
    if (kind === "message") {
      // 浏览器 WebSocket 的 message 事件携带字符串；ws 的 RawData 需转换。
      this.socket.on("message", (data: WebSocket.RawData) => listener({ data: data.toString() }));
      return;
    }
    this.socket.on(kind, () => listener());
  }
  removeEventListener(kind: "open" | "error" | "close" | "message", listener: (event?: unknown) => void): void {
    this.socket.off(kind, listener as never);
  }
}
