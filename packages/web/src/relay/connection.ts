import { randomUUID } from "../uuid.js";

import type { MessagePortLike as RpcMessagePortLike } from "@zcode/rpc";
import {
  decodeRelayV3BridgePortMessage,
  encodeRelayV3BridgePortMessage,
  parseRelayV3AppPayload,
  parseRelayV3RpcFrame,
  parseRelayV3RpcFrameAck,
  relayV3BridgePortEventToMessage,
  RelayV3AcknowledgedRpc,
  type RelayV3AppPayload,
  type RelayV3WorkspaceSummary,
} from "@zcode/shared/remote-relay-v3";

import type { RelayV3TerminalTransport } from "./terminalTransport.js";

// /remote/v4 的连接编排（P2）：bootstrap → workspace-bridge-open → acknowledged
// rpc adapter → MessagePortLike（供 rpc MessagePortProtocol/ChannelClient 挂载）。
// 恢复语义复用 web-remote-replayable（快照对齐、gap 恢复由 Host/CLI 侧承担）；
// bridge 生命周期：terminal 断开/degraded → dispose，UI 重建（V2 恢复顺序不变）。

export interface RelayV3BridgeHandle {
  bridgeSessionId: string;
  bridgeGeneration: number;
  terminalOwnerId?: string;
  port: RpcMessagePortLike;
  dispose(): void;
}

interface PendingWait<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RelayV3WebConnection {
  private readonly bridges = new Map<string, { adapter: RelayV3AcknowledgedRpc; handle: RelayV3BridgeHandle }>();
  private readonly pending = new Map<string, PendingWait<RelayV3AppPayload>>();
  private readonly bridgeWaiters = new Map<
    string,
    (payload: RelayV3AppPayload) => void
  >();
  private readonly payloadListeners = new Set<(payload: RelayV3AppPayload) => void>();

  constructor(
    private readonly transport: RelayV3TerminalTransport,
    private readonly options: { requestTimeoutMs?: number } = {},
  ) {}

  /** transport 的 onAppPayload 入口（构造后由调用方接到 transport 上）。 */
  handlePayload = (value: unknown): void => {
    const frame = parseRelayV3RpcFrame(value);
    if (frame) {
      this.bridges.get(frame.bridge_session_id)?.adapter.receive(frame);
      return;
    }
    const ack = parseRelayV3RpcFrameAck(value);
    if (ack) {
      this.bridges.get(ack.bridge_session_id)?.adapter.receive(ack);
      return;
    }
    const payload = parseRelayV3AppPayload(value);
    if (!payload) return;
    if (payload.zcode_type === "workspace-bridge-ready" || payload.zcode_type === "workspace-bridge-error") {
      const waiter = payload.bridge_session_id
        ? this.bridgeWaiters.get(payload.bridge_session_id)
        : undefined;
      if (waiter && payload.bridge_session_id) {
        this.bridgeWaiters.delete(payload.bridge_session_id);
        waiter(payload);
        return;
      }
    }
    const pending = this.pending.get(payload.zcode_type);
    if (pending) {
      this.pending.delete(payload.zcode_type);
      clearTimeout(pending.timer);
      pending.resolve(payload);
      return;
    }
    for (const listener of this.payloadListeners) listener(payload);
  };

  onPayload(listener: (payload: RelayV3AppPayload) => void): () => void {
    this.payloadListeners.add(listener);
    return () => this.payloadListeners.delete(listener);
  }

  /** paired 后发送 bootstrap-request 并等待响应（§P2 建连流程 3）。 */
  async bootstrap(clientId: string): Promise<Extract<RelayV3AppPayload, { zcode_type: "bootstrap-response" }>> {
    this.sendOrThrow({
      zcode_type: "bootstrap-request",
      terminal_client_id: clientId,
      terminal_kind: "phone-web",
    });
    return (await this.waitFor("bootstrap-response", isBootstrapResponse)) as Extract<
      RelayV3AppPayload,
      { zcode_type: "bootstrap-response" }
    >;
  }

  async listWorkspaces(): Promise<RelayV3WorkspaceSummary[]> {
    this.sendOrThrow({ zcode_type: "workspace-list-request" });
    const response = (await this.waitFor(
      "workspace-list-response",
      isWorkspaceListResponse,
    )) as Extract<RelayV3AppPayload, { zcode_type: "workspace-list-response" }>;
    return response.workspaces;
  }

  /** 对目标 workspace 建立 bridge，返回可供 MessagePortProtocol 挂载的 port。 */
  async openWorkspaceBridge(workspaceKey: string): Promise<RelayV3BridgeHandle> {
    const bridgeSessionId = `bs_${randomUUID()}`;
    this.sendOrThrow({
      zcode_type: "workspace-bridge-open",
      bridge_session_id: bridgeSessionId,
      workspace_key: workspaceKey,
      terminal_client_session_id: clientIdStorage.get(),
    });
    const settled = await this.waitForBridgeSettled(bridgeSessionId);
    if (settled.zcode_type === "workspace-bridge-error") {
      throw new Error(`workspace bridge error: ${settled.code}`);
    }
    const ready = settled as Extract<RelayV3AppPayload, { zcode_type: "workspace-bridge-ready" }>;
    const adapter = new RelayV3AcknowledgedRpc({
      bridgeSessionId,
      sendPayload: (frame) => {
        this.transport.send(frame as unknown as Record<string, unknown>);
      },
      onMessage: (message) => {
        const decoded = decodeRelayV3BridgePortMessage(message);
        if (!decoded) return;
        if (decoded.kind === "rpc") {
          portListenersDispatch(decoded.bytes);
        } else {
          portListenersDispatch({ __zcodeRpcControl: "connection-flow-v1", state: decoded.state } as never);
        }
      },
      onDegraded: () => {
        this.disposeBridge(bridgeSessionId);
      },
    });
    // MessagePortLike：rpc 的 MessagePortProtocol 只消费 Uint8Array（RPC binary）
    // 与流控控制对象（bridge-port 解码还原）。
    const messageListeners = new Set<(event: { data: unknown }) => void>();
    function portListenersDispatch(data: unknown): void {
      for (const listener of messageListeners) listener({ data });
    }
    const port: RpcMessagePortLike = {
      addEventListener: (_type, listener) => {
        messageListeners.add(listener as (e: { data: unknown }) => void);
      },
      removeEventListener: (_type, listener) => {
        messageListeners.delete(listener as (e: { data: unknown }) => void);
      },
      postMessage: (message) => {
        const portMessage = relayV3BridgePortEventToMessage(message);
        if (portMessage) adapter.send(encodeRelayV3BridgePortMessage(portMessage));
      },
      start: () => {},
      close: () => {
        messageListeners.clear();
      },
    };
    const handle: RelayV3BridgeHandle = {
      bridgeSessionId,
      bridgeGeneration: ready.bridge_generation,
      ...(ready.terminal_owner_id ? { terminalOwnerId: ready.terminal_owner_id } : {}),
      port,
      dispose: () => this.disposeBridge(bridgeSessionId),
    };
    this.bridges.set(bridgeSessionId, { adapter, handle });
    return handle;
  }

  dispose(): void {
    // Map 迭代中删除当前项是安全的（disposeBridge 只删自身 key）。
    for (const bridgeSessionId of this.bridges.keys()) {
      this.disposeBridge(bridgeSessionId);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("connection disposed"));
    }
    this.pending.clear();
  }

  private disposeBridge(bridgeSessionId: string): void {
    const bridge = this.bridges.get(bridgeSessionId);
    if (!bridge) return;
    this.bridges.delete(bridgeSessionId);
    bridge.adapter.dispose();
    bridge.handle.port.close();
  }

  private sendOrThrow(payload: Record<string, unknown>): void {
    if (!this.transport.send(payload)) {
      throw new Error("relay transport not paired");
    }
  }

  private waitFor(
    zcodeType: string,
    match: (payload: RelayV3AppPayload) => boolean,
  ): Promise<RelayV3AppPayload> {
    return new Promise<RelayV3AppPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(zcodeType);
        reject(new Error(`relay payload timeout: ${zcodeType}`));
      }, this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(zcodeType, {
        resolve: (payload) => (match(payload) ? resolve(payload) : reject(new Error("payload mismatch"))),
        reject,
        timer,
      });
    });
  }

  /** bridge ready/error 二选一等待：按 bridgeSessionId 注册 waiter，到达即清理。 */
  private waitForBridgeSettled(bridgeSessionId: string): Promise<RelayV3AppPayload> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bridgeWaiters.delete(bridgeSessionId);
        reject(new Error("workspace bridge timeout"));
      }, this.options.requestTimeoutMs ?? 15_000);
      this.bridgeWaiters.set(bridgeSessionId, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }
}

function isBootstrapResponse(payload: RelayV3AppPayload): boolean {
  return payload.zcode_type === "bootstrap-response";
}

function isWorkspaceListResponse(payload: RelayV3AppPayload): boolean {
  return payload.zcode_type === "workspace-list-response";
}

/** 页面会话标识（bridge-open 携带，main 分配 terminalOwnerId 用）。 */
class ClientIdStore {
  private value = `page_${randomUUID()}`;
  get(): string {
    return this.value;
  }
}
const clientIdStorage = new ClientIdStore();
