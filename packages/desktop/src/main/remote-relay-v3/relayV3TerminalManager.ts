import { randomUUID } from "node:crypto";

import { MessageChannelMain } from "electron";
import WebSocket from "ws";

import {
  decodeRelayV3Base64Url,
  decodeRelayV3BridgePortMessage,
  deriveRelayV3SessionKey,
  encodeRelayV3Base64Url,
  encodeRelayV3BridgePortMessage,
  generateRelayV3KeyPair,
  parseRelayV3AppPayload,
  parseRelayV3RpcFrame,
  parseRelayV3RpcFrameAck,
  relayV3BridgePortEventToMessage,
  RELAY_V3_WS_PATH,
  relayV3KeyId,
  RelayV3AcknowledgedRpc,
  RelayV3ConnectionError,
  RelayV3HttpClient,
  RelayV3TransportCore,
  type RelayV3Device,
  type RelayV3TerminalStatus,
  type RelayV3WorkspaceSummary,
  type RelayV3TransportSocket,
  type RelayV3TransportState,
} from "@zcode/shared/remote-relay-v3";

import type { RelayV3AccountService } from "./relayV3AccountService.js";
import type { MessagePortLike, RelayV3DeviceManagerLogger } from "./relayV3DeviceManager.js";

// Relay V3 桌面控制端（P4，设计 §6）：桌面作为 terminal 连接同账号的其他电脑。
// 与被控端（device manager）互相独立：连接、密钥、配对状态、退避互不干扰。
// 复用 §5.2 terminal 协议（与手机完全相同，relay 与被控端不感知控制端类型）；
// 控制端不启动 Host/Agent——RPC port 终结在控制端 renderer（等价手机浏览器），
// replayable attachment 在被控端 Host（由被控端 main 分配）。

export type RelayV3TerminalPhase = RelayV3TerminalStatus["phase"];

export interface RelayV3TerminalBridgeSession {
  bridgeSessionId: string;
  workspaceKey: string;
  bridgeGeneration: number;
  port: MessagePortLike;
}

export interface RelayV3TerminalManagerOptions {
  logger: RelayV3DeviceManagerLogger;
  getRelayConfig: () => { endpointOrigin: string | null };
  /** 与 device manager 共用的 relay 账号服务。 */
  account: RelayV3AccountService;
  fetchImpl?: typeof fetch;
  /** bridge ready 后把 port 交给控制端 renderer（main→renderer 投递）。 */
  deliverBridgePort: (session: RelayV3TerminalBridgeSession) => void;
  createMessageChannel?: () => { port1: MessagePortLike; port2: unknown };
  onStatusChanged?: (status: RelayV3TerminalStatus) => void;
}

export class RelayV3TerminalManager {
  private phase: RelayV3TerminalPhase = "idle";
  private target: { deviceSid: string; name: string | null } | null = null;
  private failure: { message?: string } | undefined;
  private workspaces: RelayV3WorkspaceSummary[] = [];
  private readonly bridges = new Map<
    string,
    { adapter: RelayV3AcknowledgedRpc; port: MessagePortLike }
  >();
  private transportCore: RelayV3TransportCore | null = null;
  private devicePublicKeyB64: string | null = null;
  private keyPair = generateRelayV3KeyPair();
  private pendingBootstrap: ((workspaces: RelayV3WorkspaceSummary[]) => void) | null = null;
  private pendingBridge: {
    bridgeSessionId: string;
    workspaceKey: string;
    resolve: (session: RelayV3TerminalBridgeSession) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(private readonly options: RelayV3TerminalManagerOptions) {}

  getStatus(): RelayV3TerminalStatus {
    return {
      phase: this.phase,
      target: this.target,
      ...(this.failure ? { failure: this.failure } : {}),
      workspaces: this.workspaces,
      activeBridgeCount: this.bridges.size,
    };
  }

  /** IPC 层的设备授权批准（§5.5）需要 relay origin 与账号 access。 */
  getRelayOrigin(): string | null {
    return this.options.getRelayConfig().endpointOrigin;
  }

  async getAccessToken(): Promise<string | null> {
    return this.options.account.getAccessToken();
  }

  private setPhase(phase: RelayV3TerminalPhase, failure?: { message?: string }): void {
    this.phase = phase;
    this.failure = failure;
    this.options.onStatusChanged?.(this.getStatus());
  }

  /** 列出同账号设备（排除本机 deviceSid）。 */
  async listDevices(ownDeviceSid: string | null): Promise<RelayV3Device[]> {
    const baseUrl = this.options.getRelayConfig().endpointOrigin;
    const access = await this.options.account.getAccessToken();
    if (!baseUrl || !access) {
      throw new RelayV3ConnectionError("auth-required", false);
    }
    const client = new RelayV3HttpClient({ baseUrl, fetch: this.options.fetchImpl });
    const devices = await client.request("list", { bearer: access });
    return devices.filter((device) => device.device_sid !== ownDeviceSid);
  }

  /** 列表→按 SID 连接的便捷入口（IPC 用；公钥从列表取，§4.2）。 */
  async connectByDeviceSid(deviceSid: string): Promise<void> {
    const devices = await this.listDevices(null);
    const device = devices.find((item) => item.device_sid === deviceSid && item.online);
    if (!device) {
      throw new Error(`device offline or not found: ${deviceSid}`);
    }
    await this.connect(device);
  }

  /** 连接目标设备（terminal 角色，一次性密钥对；断开重连重新生成，§4.2）。 */
  async connect(device: Pick<RelayV3Device, "device_sid" | "public_key" | "meta">): Promise<void> {
    await this.disconnect();
    const baseUrl = this.options.getRelayConfig().endpointOrigin;
    if (!baseUrl) {
      this.setPhase("error", { message: "relay endpoint not configured" });
      return;
    }
    this.target = {
      deviceSid: device.device_sid,
      name: device.meta?.name ?? null,
    };
    this.workspaces = [];
    this.devicePublicKeyB64 = device.public_key;
    this.keyPair = generateRelayV3KeyPair();
    const devicePublicKey = decodeRelayV3Base64Url(device.public_key);
    this.setPhase("connecting");
    this.transportCore = new RelayV3TransportCore({
      role: "terminal",
      kid: relayV3KeyId(devicePublicKey),
      log: (event, fields) => this.options.logger.debug(`relay-v3-terminal:${event}`, fields),
      openConnection: () => this.openSocket(baseUrl),
      buildAuthInit: () => ({
        type: "auth_init",
        device_sid: device.device_sid,
        terminal_public_key: encodeRelayV3Base64Url(this.keyPair.publicKey),
      }),
      // terminal 建连前已知目标设备公钥（设备列表 HTTP，§4.2）。
      deriveSessionKey: () => deriveRelayV3SessionKey(this.keyPair.privateKey, devicePublicKey),
      onState: (state) => this.handleState(state),
      onAppPayload: (payload) => this.handlePayload(payload),
      onProtocolFault: (kind) => this.options.logger.warn("relay-v3 terminal protocol fault", { kind }),
    });
    this.transportCore.start();
  }

  async disconnect(): Promise<void> {
    this.transportCore?.stop();
    this.transportCore = null;
    for (const bridge of this.bridges.values()) {
      bridge.adapter.dispose();
      bridge.port.close();
    }
    this.bridges.clear();
    this.pendingBootstrap = null;
    this.pendingBridge?.reject(new Error("terminal disconnected"));
    this.pendingBridge = null;
    this.target = null;
    this.workspaces = [];
    this.setPhase("idle");
  }

  /** matched 后取目标设备 workspace 列表（bootstrap）。 */
  async fetchWorkspaces(): Promise<RelayV3WorkspaceSummary[]> {
    if (this.phase !== "active" && this.phase !== "waiting") {
      throw new Error("terminal not connected");
    }
    if (this.workspaces.length > 0) return this.workspaces;
    return await new Promise<RelayV3WorkspaceSummary[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBootstrap = null;
        reject(new Error("bootstrap timeout"));
      }, 15_000);
      this.pendingBootstrap = (workspaces) => {
        clearTimeout(timer);
        resolve(workspaces);
      };
      if (!this.transportCore?.send({ zcode_type: "bootstrap-request", terminal_client_id: `desktop_${randomUUID()}`, terminal_kind: "desktop-terminal" })) {
        clearTimeout(timer);
        this.pendingBootstrap = null;
        reject(new Error("terminal transport not paired"));
      }
    });
  }

  /** 对目标 workspace 建立 bridge；port 投递给控制端 renderer。 */
  async openWorkspaceBridge(workspaceKey: string): Promise<RelayV3TerminalBridgeSession> {
    if (!this.transportCore) throw new Error("terminal not connected");
    const bridgeSessionId = `bs_${randomUUID()}`;
    return await new Promise<RelayV3TerminalBridgeSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBridge = null;
        reject(new Error("workspace bridge timeout"));
      }, 15_000);
      this.pendingBridge = {
        bridgeSessionId,
        workspaceKey,
        resolve: (session) => {
          clearTimeout(timer);
          resolve(session);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const sent = this.transportCore!.send({
        zcode_type: "workspace-bridge-open",
        bridge_session_id: bridgeSessionId,
        workspace_key: workspaceKey,
        terminal_client_session_id: `controller_${randomUUID()}`,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingBridge = null;
        reject(new Error("terminal transport not paired"));
      }
    });
  }

  dispose(): void {
    void this.disconnect();
  }

  // ---------------------------------------------------------------------------

  private handleState(state: RelayV3TransportState): void {
    if (state.phase === "waiting") {
      this.setPhase("waiting");
      return;
    }
    if (state.phase === "matched") {
      this.setPhase("active");
      return;
    }
    if (state.phase === "failed") {
      const message = state.failure?.message;
      // 后到者优先替旧、退避耗尽等按可恢复处理：控制端 UI 可重连（§6.5）。
      this.setPhase("error", message ? { message } : undefined);
    }
  }

  private handlePayload(value: unknown): void {
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
    switch (payload.zcode_type) {
      case "bootstrap-response":
        this.workspaces = payload.workspaces;
        this.pendingBootstrap?.(payload.workspaces);
        this.pendingBootstrap = null;
        return;
      case "workspace-list-response":
      case "workspace-list-updated":
        this.workspaces = payload.workspaces;
        this.options.onStatusChanged?.(this.getStatus());
        return;
      case "workspace-bridge-ready": {
        const pending = this.pendingBridge;
        if (!pending || payload.bridge_session_id !== pending.bridgeSessionId) return;
        this.pendingBridge = null;
        this.attachBridge(pending, payload.bridge_generation);
        return;
      }
      case "workspace-bridge-error": {
        const pending = this.pendingBridge;
        this.pendingBridge = null;
        pending?.reject(new Error(`workspace bridge error: ${payload.code}`));
        return;
      }
      case "bridge-degraded": {
        const bridgeSessionId = payload.bridge_session_id;
        if (!bridgeSessionId) return;
        const bridge = this.bridges.get(bridgeSessionId);
        if (bridge) {
          this.bridges.delete(bridgeSessionId);
          bridge.adapter.dispose();
          bridge.port.close();
          this.options.onStatusChanged?.(this.getStatus());
        }
        return;
      }
      default:
        return;
    }
  }

  private attachBridge(
    pending: {
      bridgeSessionId: string;
      workspaceKey: string;
      resolve: (session: RelayV3TerminalBridgeSession) => void;
    },
    bridgeGeneration: number,
  ): void {
    const { bridgeSessionId, workspaceKey, resolve } = pending;
    const channel = this.options.createMessageChannel?.() ?? new MessageChannelMain();
    const adapter = new RelayV3AcknowledgedRpc({
      bridgeSessionId,
      sendPayload: (frame) => {
        this.transportCore?.send(frame as unknown as Record<string, unknown>);
      },
      onMessage: (message) => {
        const decoded = decodeRelayV3BridgePortMessage(message);
        if (!decoded) return;
        if (decoded.kind === "rpc") {
          channel.port1.postMessage(new Uint8Array(decoded.bytes));
        } else {
          channel.port1.postMessage({ __zcodeRpcControl: "connection-flow-v1", state: decoded.state });
        }
      },
      onDegraded: () => {
        const bridge = this.bridges.get(bridgeSessionId);
        if (bridge) {
          this.bridges.delete(bridgeSessionId);
          bridge.adapter.dispose();
          bridge.port.close();
        }
      },
    });
    this.bridges.set(bridgeSessionId, { adapter, port: channel.port1 });
    channel.port1.on("message", (event) => {
      const message = relayV3BridgePortEventToMessage(event.data);
      if (message) adapter.send(encodeRelayV3BridgePortMessage(message));
    });
    channel.port1.once("close", () => {
      const bridge = this.bridges.get(bridgeSessionId);
      if (bridge) {
        this.bridges.delete(bridgeSessionId);
        bridge.adapter.dispose();
      }
    });
    channel.port1.start();
    const session: RelayV3TerminalBridgeSession = {
      bridgeSessionId,
      workspaceKey,
      bridgeGeneration,
      port: channel.port1,
    };
    this.options.deliverBridgePort(session);
    resolve(session);
  }

  private async openSocket(baseUrl: string): Promise<RelayV3TransportSocket> {
    const access = await this.options.account.getAccessToken();
    if (!access) throw new RelayV3ConnectionError("auth-required", false);
    const client = new RelayV3HttpClient({ baseUrl, fetch: this.options.fetchImpl });
    const { token } = await client.request("relayToken", { bearer: access }, { role: "terminal" });
    const wsOrigin = baseUrl.replace(/^http/, "ws");
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
}
