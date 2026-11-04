import WebSocket from "ws";

import {
  decodeRelayV3Base64Url,
  deriveRelayV3SessionKey,
  RELAY_V3_WS_PATH,
  RelayV3ConnectionError,
  relayV3KeyId,
  RelayV3HttpClient,
  RelayV3TransportCore,
  type RelayV3AuthInit,
  type RelayV3KeyPair,
  type RelayV3TransportSocket,
  type RelayV3TransportState,
} from "@zcode/shared/remote-relay-v3";

// Relay V3 device transport（P1）：包装共享 RelayV3TransportCore，负责 Node ws 适配与
// 一次性 token 获取。每次重连 openConnection 都重新走 token 接口（先关旧连再取新
// token 的语义由 core 连接循环 + 本层无状态 token 获取共同保证）。状态机/退避/
// KICKED 窗口/心跳全部复用 shared 实现；会话密钥在 pair_status_ack(matched 且
// 透传 terminal_public_key) 时由 core 回调派生（§4.2/§5.2）。

export interface RelayV3DeviceTransportOptions {
  resolveBaseUrl: () => string | null;
  fetchImpl?: typeof fetch;
  /** 取当前有效 access token（manager 注入账号服务；transport 不持有凭据）。 */
  acquireAccessToken: () => Promise<string>;
  deviceMid: string;
  keyPair: RelayV3KeyPair;
  deviceSid: string;
  log: (message: string, fields?: Record<string, unknown>) => void;
  onState: (state: RelayV3TransportState) => void;
  onAppPayload: (payload: unknown) => void;
  onProtocolFault?: (kind: "decrypt-failed" | "invalid-incoming" | "invalid-outgoing") => void;
  meta?: { name?: string; platform?: string; version?: string };
}

export class RelayV3DeviceTransport {
  private readonly core: RelayV3TransportCore;

  constructor(private readonly options: RelayV3DeviceTransportOptions) {
    const { keyPair } = options;
    this.core = new RelayV3TransportCore({
      role: "device",
      kid: relayV3KeyId(keyPair.publicKey),
      log: (event, fields) => options.log(`relay-v3-device:${event}`, fields),
      openConnection: () => this.openSocket(),
      buildAuthInit: (): RelayV3AuthInit => ({
        type: "auth_init",
        device_sid: options.deviceSid,
        ...(options.meta ? { meta: options.meta } : {}),
      }),
      deriveSessionKey: ({ terminalPublicKey }) =>
        terminalPublicKey
          ? deriveRelayV3SessionKey(keyPair.privateKey, decodeRelayV3Base64Url(terminalPublicKey))
          : null,
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
    const baseUrl = this.options.resolveBaseUrl();
    if (!baseUrl) {
      throw new RelayV3ConnectionError("relay-unavailable", false);
    }
    const accessToken = await this.options.acquireAccessToken();
    const client = new RelayV3HttpClient({ baseUrl, fetch: this.options.fetchImpl });
    const { token } = await client.request("relayToken", { bearer: accessToken }, { role: "device" });
    return this.connectSocket(baseUrl, token);
  }

  private connectSocket(baseUrl: string, token: string): Promise<RelayV3TransportSocket> {
    const wsOrigin = baseUrl.replace(/^http/, "ws");
    const url = `${wsOrigin}${RELAY_V3_WS_PATH}?token=${encodeURIComponent(token)}`;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const failTimer = setTimeout(() => {
        socket.terminate();
        reject(new RelayV3ConnectionError("relay-unavailable", true));
      }, 15_000);
      socket.once("open", () => {
        clearTimeout(failTimer);
        resolve({
          send: (text) => socket.send(text),
          close: () => socket.close(),
          onMessage: (listener) => {
            const handler = (data: WebSocket.RawData) => listener(data.toString());
            socket.on("message", handler);
            return () => socket.off("message", handler);
          },
          onClose: (listener) => {
            const handler = () => listener();
            socket.once("close", handler);
            return () => socket.off("close", handler);
          },
        });
      });
      socket.once("error", (error) => {
        clearTimeout(failTimer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
}
