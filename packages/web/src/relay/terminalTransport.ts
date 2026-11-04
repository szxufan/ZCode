import {
  decodeRelayV3Base64Url,
  deriveRelayV3SessionKey,
  encodeRelayV3Base64Url,
  generateRelayV3KeyPair,
  RELAY_V3_WS_PATH,
  relayV3KeyId,
  RelayV3ConnectionError,
  RelayV3HttpClient,
  RelayV3TransportCore,
  type RelayV3TransportSocket,
  type RelayV3TransportState,
} from "@zcode/shared/remote-relay-v3";

// /remote/v4 的 terminal transport（P2）：每次控制会话生成一次性 X25519 密钥对
//（§4.2，页面关闭即弃、断开重连重新生成）；会话密钥从设备列表取得的目标设备
// 公钥派生（§4.2「公钥获取」）。状态机/退避/KICKED/心跳复用 shared transport-core。

export interface RelayV3TerminalTransportOptions {
  resolveOrigin: () => string | null;
  acquireAccessToken: () => Promise<string | null>;
  deviceSid: string;
  devicePublicKeyB64: string;
  onState: (state: RelayV3TransportState) => void;
  onAppPayload: (payload: unknown) => void;
  onProtocolFault?: (kind: "decrypt-failed" | "invalid-incoming" | "invalid-outgoing") => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** WebSocket 工厂（浏览器默认 globalThis.WebSocket；Node 测试注入 ws）。 */
  createSocket?: (url: string) => RelayV3TerminalWebSocket;
}

/** 浏览器 WebSocket 与 Node ws 的最小公共面（kind 联合签名，适配两端监听 API）。 */
export interface RelayV3TerminalWebSocket {
  send(text: string): void;
  close(): void;
  addEventListener(
    kind: "open" | "error" | "close" | "message",
    listener: (event?: unknown) => void,
  ): void;
  removeEventListener(
    kind: "open" | "error" | "close" | "message",
    listener: (event?: unknown) => void,
  ): void;
}

/** 浏览器 DOM WebSocket 的类型适配（DOM addEventListener 重载与公共面不完全一致）。 */
class BrowserWebSocketAdapter implements RelayV3TerminalWebSocket {
  constructor(private readonly socket: WebSocket) {}
  send(text: string): void {
    this.socket.send(text);
  }
  close(): void {
    this.socket.close();
  }
  addEventListener(
    kind: "open" | "error" | "close" | "message",
    listener: (event?: unknown) => void,
  ): void {
    this.socket.addEventListener(kind, listener as EventListener);
  }
  removeEventListener(
    kind: "open" | "error" | "close" | "message",
    listener: (event?: unknown) => void,
  ): void {
    this.socket.removeEventListener(kind, listener as EventListener);
  }
}

export class RelayV3TerminalTransport {
  private readonly core: RelayV3TransportCore;
  private readonly keyPair = generateRelayV3KeyPair();
  private readonly devicePublicKey: Uint8Array;

  constructor(private readonly options: RelayV3TerminalTransportOptions) {
    this.devicePublicKey = decodeRelayV3Base64Url(options.devicePublicKeyB64);
    this.core = new RelayV3TransportCore({
      role: "terminal",
      kid: relayV3KeyId(this.devicePublicKey),
      log: (event, fields) => options.log?.(`relay-v3-terminal:${event}`, fields),
      openConnection: () => this.openSocket(),
      buildAuthInit: () => ({
        type: "auth_init",
        device_sid: options.deviceSid,
        terminal_public_key: encodeRelayV3Base64Url(this.keyPair.publicKey),
      }),
      // terminal 建连前已知目标设备公钥（§4.2）。
      deriveSessionKey: () => deriveRelayV3SessionKey(this.keyPair.privateKey, this.devicePublicKey),
      onState: options.onState,
      onAppPayload: options.onAppPayload,
      onProtocolFault: options.onProtocolFault,
    });
  }

  getState(): RelayV3TransportState {
    return this.core.getState();
  }

  start(): void {
    this.core.start();
  }

  stop(): void {
    this.core.stop();
  }

  send(payload: Record<string, unknown>): boolean {
    return this.core.send(payload);
  }

  private async openSocket(): Promise<RelayV3TransportSocket> {
    const origin = this.options.resolveOrigin();
    if (!origin) throw new RelayV3ConnectionError("relay-unavailable", false);
    const access = await this.options.acquireAccessToken();
    if (!access) throw new RelayV3ConnectionError("auth-required", false);
    const client = new RelayV3HttpClient({ baseUrl: origin });
    const { token } = await client.request("relayToken", { bearer: access }, { role: "terminal" });
    const wsOrigin = origin.replace(/^http/, "ws");
    const url = `${wsOrigin}${RELAY_V3_WS_PATH}?token=${encodeURIComponent(token)}`;
    const socket = this.options.createSocket
      ? this.options.createSocket(url)
      : new BrowserWebSocketAdapter(new WebSocket(url));
    return await new Promise<RelayV3TransportSocket>((resolve, reject) => {
      const failTimer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* noop */
        }
        reject(new RelayV3ConnectionError("relay-unavailable", true));
      }, 15_000);
      socket.addEventListener("open", () => {
        clearTimeout(failTimer);
        resolve({
          send: (text) => socket.send(text),
          close: () => socket.close(),
          onMessage: (listener) => {
            const handler = (event?: unknown) => {
              const data = (event as { data?: unknown } | undefined)?.data;
              if (typeof data === "string") listener(data);
            };
            socket.addEventListener("message", handler);
            return () => socket.removeEventListener("message", handler);
          },
          onClose: (listener) => {
            const handler = () => listener();
            socket.addEventListener("close", handler);
            return () => socket.removeEventListener("close", handler);
          },
        });
      });
      socket.addEventListener("error", () => {
        clearTimeout(failTimer);
        reject(new RelayV3ConnectionError("relay-unavailable", true));
      });
    });
  }
}
