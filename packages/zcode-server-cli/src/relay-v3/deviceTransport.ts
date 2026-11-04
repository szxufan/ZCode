import WebSocket from "ws";

import {
  decodeRelayV3Base64Url,
  deriveRelayV3SessionKey,
  parseRelayV3AppPayload,
  parseRelayV3RpcFrame,
  parseRelayV3RpcFrameAck,
  RELAY_V3_WS_PATH,
  relayV3KeyId,
  RelayV3AcknowledgedRpc,
  RelayV3ConnectionError,
  RelayV3HttpClient,
  RelayV3TransportCore,
  type RelayV3TransportSocket,
  type RelayV3TransportState,
} from "@zcode/shared/remote-relay-v3";

import {
  accessExpirySec,
  loadOrGenerateRelayV3DaemonIdentity,
  loadRelayV3DaemonCredentials,
  saveRelayV3DaemonCredentials,
  type RelayV3DaemonCredentials,
} from "./deviceAuth.js";

// Relay V3 daemon device transport（R4）：远端 source-server daemon 经 §5.5 设备
// 授权后以 device 角色接入 relay，成为与桌面同权的一等设备。任务完成/权限请求
// 事件经 device-event 推送给控制端（数据面 spec §6）；文件传输走 chunk-frame。
// daemon 无 GUI：登录凭据来自 `zcode server login`；凭据/私钥落 server root 0600。

export interface RelayV3DaemonTransportOptions {
  relayOrigin: string;
  serverRoot: string;
  meta?: { name?: string; platform?: string; version?: string };
  log?: (message: string, fields?: Record<string, unknown>) => void;
  onState?: (state: RelayV3TransportState) => void;
  /** 控制端业务 payload（bootstrap/bridge/rpc-frame/chunk-frame/device-event）。 */
  onAppPayload?: (payload: unknown) => void;
}

export class RelayV3DaemonTransport {
  private readonly core: RelayV3TransportCore;
  private credentials: RelayV3DaemonCredentials | null;
  private readonly identity: ReturnType<typeof loadOrGenerateRelayV3DaemonIdentity>;
  private bridges = new Map<string, RelayV3AcknowledgedRpc>();
  private outbox: Record<string, unknown>[] = [];

  constructor(private readonly options: RelayV3DaemonTransportOptions) {
    this.identity = loadOrGenerateRelayV3DaemonIdentity(options.serverRoot);
    this.credentials = loadRelayV3DaemonCredentials(options.serverRoot);
    this.core = new RelayV3TransportCore({
      role: "device",
      kid: relayV3KeyId(this.identity.keyPair.publicKey),
      log: (event, fields) => options.log?.(`relay-v3-daemon:${event}`, fields),
      openConnection: () => this.openSocket(),
      buildAuthInit: () => ({
        type: "auth_init",
        device_sid: this.requireCredentials().deviceSid,
        ...(options.meta ? { meta: options.meta } : {}),
      }),
      deriveSessionKey: ({ terminalPublicKey }) =>
        terminalPublicKey
          ? deriveRelayV3SessionKey(
              this.identity.keyPair.privateKey,
              decodeRelayV3Base64Url(terminalPublicKey),
            )
          : null,
      onState: (state) => {
        // 离线重连后释放 bridge（控制端会重新 bootstrap/bridge-open）。
        if (state.phase === "waiting") this.disposeBridges();
        options.onState?.(state);
      },
      onAppPayload: (payload) => this.handlePayload(payload),
      onProtocolFault: (kind) => options.log?.(`relay-v3-daemon:fault:${kind}`),
    });
  }

  isConfigured(): boolean {
    return this.credentials !== null;
  }

  start(): void {
    if (!this.credentials) return;
    this.core.start();
  }

  stop(): void {
    this.core.stop();
    this.disposeBridges();
  }

  send(payload: Record<string, unknown>): boolean {
    return this.core.send(payload);
  }

  /** 任务事件推送（数据面 spec §6）：控制端映射为本地通知。 */
  sendDeviceEvent(event: "task-completed" | "permission-requested", taskId: string, payload: Record<string, unknown>): boolean {
    return this.core.send({
      zcode_type: "device-event",
      event,
      task_id: taskId,
      payload,
    });
  }

  private handlePayload(value: unknown): void {
    const frame = parseRelayV3RpcFrame(value);
    if (frame) {
      this.bridges.get(frame.bridge_session_id)?.receive(frame);
      return;
    }
    const ack = parseRelayV3RpcFrameAck(value);
    if (ack) {
      this.bridges.get(ack.bridge_session_id)?.receive(ack);
      return;
    }
    const payload = parseRelayV3AppPayload(value);
    if (payload?.zcode_type === "workspace-bridge-open") {
      // daemon 侧最小 bridge：接受 open，分配 adapter；业务 RPC 由 onAppPayload 消费方
      // （server-core 的 RPC 面）经 adapter 承载。
      const adapter = new RelayV3AcknowledgedRpc({
        bridgeSessionId: payload.bridge_session_id,
        sendPayload: (out) => {
          this.core.send(out as unknown as Record<string, unknown>);
        },
        onMessage: (message) => {
          this.options.onAppPayload?.({ __rpcMessage: message } as never);
        },
        onDegraded: () => this.bridges.delete(payload.bridge_session_id),
      });
      this.bridges.set(payload.bridge_session_id, adapter);
      this.core.send({
        zcode_type: "workspace-bridge-ready",
        bridge_session_id: payload.bridge_session_id,
        bridge_generation: 1,
      });
      return;
    }
    this.options.onAppPayload?.(value);
  }

  private disposeBridges(): void {
    for (const adapter of this.bridges.values()) adapter.dispose();
    this.bridges = new Map();
  }

  private requireCredentials(): RelayV3DaemonCredentials {
    if (!this.credentials) throw new RelayV3ConnectionError("auth-required", false);
    return this.credentials;
  }

  private async openSocket(): Promise<RelayV3TransportSocket> {
    await this.ensureFreshAccess();
    const credentials = this.requireCredentials();
    const client = new RelayV3HttpClient({ baseUrl: this.options.relayOrigin });
    const { token } = await client.request(
      "relayToken",
      { bearer: credentials.access },
      { role: "device" },
    );
    const wsOrigin = this.options.relayOrigin.replace(/^http/, "ws");
    const url = `${wsOrigin}${RELAY_V3_WS_PATH}?token=${encodeURIComponent(token)}`;
    return await new Promise<RelayV3TransportSocket>((resolve, reject) => {
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

  /** access 临期（<60s）时用 refresh 旋转（家族撤销 → auth-required 终态）。 */
  private async ensureFreshAccess(): Promise<void> {
    const credentials = this.requireCredentials();
    if (Date.now() / 1000 < credentials.accessExpiresAtSec - 60) return;
    const client = new RelayV3HttpClient({ baseUrl: this.options.relayOrigin });
    let rotated: { access: string; refresh: string } | null = null;
    try {
      rotated = await client.request("refresh", {}, { refresh: credentials.refresh });
    } catch {
      rotated = null;
    }
    if (!rotated) {
      this.credentials = null;
      throw new RelayV3ConnectionError("auth-required", false);
    }
    const next: RelayV3DaemonCredentials = {
      ...credentials,
      access: rotated.access,
      refresh: rotated.refresh,
      accessExpiresAtSec: accessExpirySec(rotated.access),
    };
    this.credentials = next;
    saveRelayV3DaemonCredentials(this.options.serverRoot, next);
  }
}

/** serve 启动钩子：凭据存在则拉起 daemon device transport（R4 接入）。 */
export function startRelayV3DaemonTransportIfConfigured(options: {
  relayOrigin: string;
  serverRoot: string;
  version: string;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  onAppPayload?: (payload: unknown) => void;
}): RelayV3DaemonTransport | null {
  const transport = new RelayV3DaemonTransport({
    relayOrigin: options.relayOrigin,
    serverRoot: options.serverRoot,
    meta: { name: "zcode-server", version: options.version },
    log: options.log,
    onAppPayload: options.onAppPayload,
  });
  if (!transport.isConfigured()) {
    return null;
  }
  transport.start();
  return transport;
}
