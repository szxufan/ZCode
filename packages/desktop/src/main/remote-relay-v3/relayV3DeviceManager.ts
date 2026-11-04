import { randomUUID } from "node:crypto";
import os from "node:os";

import { MessageChannelMain } from "electron";

import type { AppSettings } from "@zcode/shared";
import {
  buildRelayV3QrUrl,
  decodeRelayV3BridgePortMessage,
  encodeRelayV3Base64Url,
  encodeRelayV3BridgePortMessage,
  parseRelayV3AppPayload,
  parseRelayV3RpcFrame,
  parseRelayV3RpcFrameAck,
  relayV3BridgePortEventToMessage,
  relayV3KeyId,
  RelayV3AcknowledgedRpc,
  RelayV3ConnectionError,
  RelayV3HttpClient,
  type RelayV3DesktopPhase,
  type RelayV3DesktopStatus,
  type RelayV3KeyPair,
  type RelayV3TransportState,
  type RelayV3WorkspaceBridgeOpen,
  type RelayV3WorkspaceSyncEntry,
} from "@zcode/shared/remote-relay-v3";

import {
  loadOrGenerateRelayV3DeviceIdentity,
  persistRelayV3DeviceSid,
  resetRelayV3DeviceIdentity,
} from "./relayV3DeviceIdentity.js";
import { RelayV3AccountService, type RelayV3AccountEvent } from "./relayV3AccountService.js";
import { RelayV3DeviceTransport } from "./relayV3DeviceTransport.js";

// Relay V3 device manager（P1）：桌面被控端运行态的唯一 owner。
// 职责（V2 webRemoteControlManager 语义在 V3 的重建，见
// docs/web-remote-control/web-remote-control-architecture.md §Desktop Main）：
//   1. relay 账号会话（auth-required = 等待 relay 账号登录，不注册不建连）；
//   2. 设备身份与注册（携带公钥；重注册换新密钥对，AUTH_FAILED 同次启动最多恢复一次）；
//   3. transport 生命周期与状态投影（idle/starting/connecting/waiting/active/error）；
//   4. 按 workspaceKey 匹配 workspace，为手机/桌面控制端 bridge 创建 MessagePort
//      attachment 挂到窗口 Window Host（clientMode=web-remote-replayable）；
//   5. rpc-frame 分片经 shared acknowledged adapter 编解码（relay 不解析业务）；
//   6. 启用意图持久化与重启恢复（remoteSessionId 不跨重启持久化）。
// main 不持有 task/stream/snapshot 业务状态；attachment 由 Host 校验 scope。

export interface RelayV3DeviceManagerLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface RelayV3DeviceManagerOptions {
  logger: RelayV3DeviceManagerLogger;
  appVersion: string;
  /** relay 配置来源（AppSettings.relayV3）。 */
  getRelayConfig: () => { endpointOrigin: string | null; staticPageBaseUrl: string | null };
  /** 设置读写（启用意图持久化；只写 relayV3 子对象）。 */
  settings: {
    read(): Promise<AppSettings | null>;
    patch(patch: Partial<AppSettings>): Promise<void>;
  };
  configDir?: string;
  fetchImpl?: typeof fetch;
  hostname?: string;
  platform?: string;
  /** host attachment 注入点：把 port 挂到目标窗口的 Window Host（测试可替换）。 */
  attachHostPort: (params: {
    windowId: number;
    attachmentId: string;
    terminalOwnerId: string;
    scope:
      | { kind: "local" }
      | {
          kind: "remote";
          remoteSessionId: string;
          workspacePath: string;
          workspaceIdentity: string;
          sourceServerId?: string;
        };
    port: unknown;
  }) => void;
  /** host attachment 释放（幂等）。 */
  detachHostPort: (attachmentId: string) => void;
  createMessageChannel?: () => { port1: MessagePortLike; port2: unknown };
  /** 状态变化广播（main 转发到所有窗口）。 */
  broadcastStatus?: (status: RelayV3DesktopStatus) => void;
  /** deviceMid 解析（由 main 装配注入 ensureDesktopDeviceMidSync；测试注入）。 */
  resolveDeviceMid: () => string;
  now?: () => number;
}

/** main 侧持有的 MessagePort 最小接口（Electron MessagePortMain / 测试替身共用）。 */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  once(event: "close", listener: () => void): void;
}

interface ManagedBridge {
  bridgeSessionId: string;
  attachmentId: string;
  generation: number;
  port: MessagePortLike;
  adapter: RelayV3AcknowledgedRpc;
}

interface StartTicket {
  ticket: string;
  windowId: number;
  target: { workspacePath: string; workspaceIdentity?: string };
  expiresAt: number;
}

const TICKET_TTL_MS = 30_000;

export class RelayV3DeviceManager {
  private readonly account: RelayV3AccountService;
  private readonly workspacesByWindowId = new Map<number, RelayV3WorkspaceSyncEntry[]>();
  private readonly bridges = new Map<string, ManagedBridge>();
  private readonly tickets = new Map<string, StartTicket>();
  private transport: RelayV3DeviceTransport | null = null;
  private identity: { keyPair: RelayV3KeyPair; deviceSid: string | null } | null = null;
  private phase: RelayV3DesktopPhase = "idle";
  private failure: RelayV3DesktopStatus["failure"] | undefined;
  private enabledTarget: { workspacePath: string; workspaceIdentity?: string } | null = null;
  /** 同次启动内 AUTH_FAILED 后的重注册只允许一次（V2 03）。 */
  private reregisteredSinceStart = false;
  private starting = false;
  private latestViewState: unknown = null;
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly options: RelayV3DeviceManagerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.account = new RelayV3AccountService({
      resolveBaseUrl: () => options.getRelayConfig().endpointOrigin,
      accountOptions: {
        configDir: options.configDir,
        fetchImpl: options.fetchImpl,
        now: this.now,
        log: (message, fields) => options.logger.warn(message, fields),
        onSessionChange: (event) => this.handleAccountChange(event),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // 状态投影
  // ---------------------------------------------------------------------------

  getStatus(): RelayV3DesktopStatus {
    const { endpointOrigin, staticPageBaseUrl } = this.options.getRelayConfig();
    const deviceSid = this.identity?.deviceSid ?? null;
    const qrReady = (this.phase === "waiting" || this.phase === "active") && deviceSid !== null;
    return {
      phase: this.phase,
      ...(this.failure ? { failure: this.failure } : {}),
      account: this.account.getSession(),
      deviceSid,
      qrUrl:
        qrReady && deviceSid && (staticPageBaseUrl ?? endpointOrigin)
          ? buildRelayV3QrUrl(staticPageBaseUrl ?? endpointOrigin ?? "", {
              sid: deviceSid,
              mid: this.resolveDeviceMid(),
              name: this.options.hostname ?? os.hostname(),
              app_version: this.options.appVersion,
            })
          : null,
      relayOrigin: endpointOrigin,
    };
  }

  private setPhase(phase: RelayV3DesktopPhase, failure?: RelayV3DesktopStatus["failure"]): void {
    this.phase = phase;
    this.failure = failure;
    this.options.broadcastStatus?.(this.getStatus());
  }

  // ---------------------------------------------------------------------------
  // workspace 同步与账号
  // ---------------------------------------------------------------------------

  syncWorkspaces(windowId: number, workspaces: RelayV3WorkspaceSyncEntry[]): void {
    this.workspacesByWindowId.set(windowId, workspaces);
    // 启用意图等待 workspace 同步后恢复（新进程必须等 renderer 同步，V2 04）。
    void this.maybeAutoStart();
    this.pushWorkspaceListUpdate();
  }

  /** workspace 快照变化后把同一份列表推给已连接 terminal（V2 workspace-list-updated 语义）。 */
  private pushWorkspaceListUpdate(): void {
    if (this.phase !== "active" && this.phase !== "waiting") return;
    this.sendToTerminal({
      zcode_type: "workspace-list-updated",
      workspaces: this.flattenWorkspaces(),
    });
  }

  handleAccountChange(event: RelayV3AccountEvent): void {
    if (event === "signed-out") {
      // 登出立即停止远控 runtime，但保留启用意图（V2 04）。
      this.stopTransportOnly();
      this.setPhase("auth-required");
      return;
    }
    // signed-in：存在启用意图且未运行时恢复。
    void this.maybeAutoStart();
  }

  getSession() {
    return this.account.getSession();
  }

  /** 控制端 manager（P4）与本 manager 共用同一 relay 账号会话。 */
  getAccountService(): RelayV3AccountService {
    return this.account;
  }

  async sendSmsCode(phone: string) {
    return this.account.sendSmsCode(phone);
  }

  async loginWithCode(phone: string, code: string) {
    const result = await this.account.loginWithCode(phone, code);
    if (result.ok) {
      await this.maybeAutoStart();
    }
    return result;
  }

  async logout() {
    this.stopTransportOnly();
    this.disposeAllBridges("logout");
    const result = await this.account.logout();
    this.setPhase("idle");
    return result;
  }

  async restoreOnLaunch(): Promise<void> {
    await this.account.restoreFromDisk();
    const settings = await this.options.settings.read();
    const lastEnabled = settings?.relayV3?.lastEnabled;
    if (lastEnabled) {
      this.enabledTarget = lastEnabled;
      await this.maybeAutoStart();
    }
  }

  // ---------------------------------------------------------------------------
  // 启动 / 停止（票据边界）
  // ---------------------------------------------------------------------------

  authorizeStart(windowId: number, target: { workspacePath: string; workspaceIdentity?: string }): string {
    const ticket = randomUUID();
    this.tickets.set(ticket, { ticket, windowId, target, expiresAt: this.now() + TICKET_TTL_MS });
    return ticket;
  }

  async startAuthorized(ticket: string): Promise<{ accepted: boolean; reason?: string }> {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!entry || entry.expiresAt < this.now()) {
      return { accepted: false, reason: "invalid-ticket" };
    }
    this.enabledTarget = entry.target;
    return this.start();
  }

  async start(): Promise<{ accepted: boolean; reason?: string }> {
    if (this.disposed) return { accepted: false, reason: "disposed" };
    if (this.starting) return { accepted: true };
    const { endpointOrigin } = this.options.getRelayConfig();
    if (!endpointOrigin) {
      this.setPhase("error", { kind: "relay-unavailable", message: "relay endpoint not configured" });
      return { accepted: false, reason: "no-endpoint" };
    }
    if (!this.account.isSignedIn()) {
      // auth-required：不注册、不建连（V2 04 登录门禁）。
      this.setPhase("auth-required");
      return { accepted: false, reason: "auth-required" };
    }
    this.starting = true;
    this.reregisteredSinceStart = false;
    this.setPhase("starting");
    try {
      await this.ensureRegisteredDevice();
      this.launchTransport();
      return { accepted: true };
    } catch (error) {
      this.starting = false;
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error("relay-v3 start failed", { message });
      this.setPhase("error", { kind: "relay-unavailable", message });
      return { accepted: false, reason: message };
    }
  }

  async stop(): Promise<void> {
    this.stopTransportOnly();
    this.disposeAllBridges("stop");
    this.tickets.clear();
    // 用户明确停止：清除启用意图（V2 04）；显式去掉 lastEnabled 键而非写 undefined。
    this.enabledTarget = null;
    try {
      const { lastEnabled: _cleared, ...rest } = await this.currentRelaySettings();
      await this.options.settings.patch({ relayV3: rest });
    } catch (error) {
      this.options.logger.warn("relay-v3 failed to clear enabled intent", { error });
    }
    this.setPhase("idle");
  }

  dispose(): void {
    this.disposed = true;
    this.stopTransportOnly();
    this.disposeAllBridges("dispose");
    this.tickets.clear();
    this.enabledTarget = null;
  }

  // ---------------------------------------------------------------------------
  // 注册与 transport
  // ---------------------------------------------------------------------------

  private resolveDeviceMid(): string {
    return this.options.resolveDeviceMid();
  }

  private async ensureRegisteredDevice(): Promise<void> {
    if (!this.identity) {
      this.identity = loadOrGenerateRelayV3DeviceIdentity(this.options.configDir);
    }
    if (this.identity.deviceSid) return;
    await this.registerDevice(this.identity.keyPair);
  }

  private async registerDevice(keyPair: RelayV3KeyPair): Promise<void> {
    const baseUrl = this.options.getRelayConfig().endpointOrigin;
    if (!baseUrl) throw new Error("relay endpoint not configured");
    const accessToken = await this.account.getAccessToken();
    if (!accessToken) throw new Error("relay account not signed in");
    const client = new RelayV3HttpClient({ baseUrl, fetch: this.options.fetchImpl });
    const device = await client.request(
      "register",
      { bearer: accessToken },
      {
        device_mid: this.resolveDeviceMid(),
        public_key: encodeRelayV3Base64Url(keyPair.publicKey),
      },
    );
    try {
      persistRelayV3DeviceSid(device.device_sid, this.options.configDir);
    } catch (error) {
      // 注册成功但本地保存失败：尽力删除新 SID 后不可重试终止（V2 03）。
      try {
        await client.request("delete", { bearer: accessToken }, { device_sid: device.device_sid });
      } catch (deleteError) {
        this.options.logger.warn("relay-v3 compensate delete failed", { deleteError });
      }
      throw error;
    }
    this.identity = { keyPair, deviceSid: device.device_sid };
    this.options.logger.info("relay-v3 device registered", { kid: relayV3KeyId(keyPair.publicKey) });
  }

  private launchTransport(): void {
    const identity = this.identity;
    if (!identity?.deviceSid) throw new Error("device identity missing before transport launch");
    this.stopTransportOnly();
    this.transport = new RelayV3DeviceTransport({
      resolveBaseUrl: () => this.options.getRelayConfig().endpointOrigin,
      fetchImpl: this.options.fetchImpl,
      acquireAccessToken: async () => {
        const token = await this.account.getAccessToken();
        if (!token) throw new RelayV3ConnectionError("auth-required", false);
        return token;
      },
      deviceMid: this.resolveDeviceMid(),
      keyPair: identity.keyPair,
      deviceSid: identity.deviceSid,
      log: (message, fields) => this.options.logger.debug(message, fields),
      meta: {
        name: this.options.hostname ?? os.hostname(),
        ...(this.options.platform ? { platform: this.options.platform } : {}),
        version: this.options.appVersion,
      },
      onState: (state) => this.handleTransportState(state),
      onAppPayload: (payload) => this.handleAppPayload(payload),
      onProtocolFault: (kind) => this.options.logger.warn("relay-v3 protocol fault", { kind }),
    });
    this.transport.start();
  }

  private handleTransportState(state: RelayV3TransportState): void {
    switch (state.phase) {
      case "connecting":
      case "authenticating":
        if (this.phase !== "starting") this.setPhase("connecting");
        return;
      case "waiting":
        // terminal 断开：释放短生命周期 bridge attachment（Host/remote session 不动）。
        this.disposeAllBridges("terminal-waiting");
        this.setPhase("waiting");
        void this.persistEnabledIntent();
        return;
      case "matched":
        this.setPhase("active");
        return;
      case "failed": {
        const failure = state.failure;
        if (!failure) return;
        if (failure.kind === "auth-failed" && !this.reregisteredSinceStart) {
          // AUTH_FAILED：SID 失效/被删，同次启动最多重注册一次（V2 03）。
          this.reregisteredSinceStart = true;
          void this.reRegister();
          return;
        }
        if (failure.kind === "auth-required") {
          this.stopTransportOnly();
          this.setPhase("auth-required");
          return;
        }
        this.starting = false;
        this.setPhase("error", { kind: failure.kind, ...(failure.message ? { message: failure.message } : {}) });
        return;
      }
      default:
        return;
    }
  }

  private async reRegister(): Promise<void> {
    this.stopTransportOnly();
    this.disposeAllBridges("reregister");
    try {
      const identity = resetRelayV3DeviceIdentity(this.options.configDir);
      this.identity = identity;
      await this.registerDevice(identity.keyPair);
      this.launchTransport();
    } catch (error) {
      this.starting = false;
      this.setPhase("error", {
        kind: "auth-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopTransportOnly(): void {
    this.transport?.stop();
    this.transport = null;
    this.starting = false;
  }

  private async maybeAutoStart(): Promise<void> {
    if (this.disposed || this.enabledTarget === null || this.transport !== null || this.starting) return;
    if (!this.account.isSignedIn()) {
      if (this.phase === "idle") this.setPhase("auth-required");
      return;
    }
    // 等待目标 workspace 已同步到任一窗口（V2 04：不匹配保持 idle，不另起 runtime）。
    const key = this.enabledTarget.workspaceIdentity?.trim() || this.enabledTarget.workspacePath;
    const synced = [...this.workspacesByWindowId.values()].some((entries) =>
      entries.some((entry) => entry.workspaceKey === key),
    );
    if (!synced) {
      if (this.phase === "idle") this.setPhase("idle");
      return;
    }
    const result = await this.start();
    if (!result.accepted && result.reason && result.reason !== "auth-required" && result.reason !== "no-endpoint") {
      this.options.logger.warn("relay-v3 auto start rejected", { reason: result.reason });
    }
  }

  private async persistEnabledIntent(): Promise<void> {
    if (!this.enabledTarget) return;
    try {
      await this.options.settings.patch({
        relayV3: { ...(await this.currentRelaySettings()), lastEnabled: this.enabledTarget },
      });
    } catch (error) {
      this.options.logger.warn("relay-v3 failed to persist enabled intent", { error });
    }
  }

  private async currentRelaySettings(): Promise<NonNullable<AppSettings["relayV3"]>> {
    const settings = await this.options.settings.read();
    return settings?.relayV3 ?? {};
  }

  // ---------------------------------------------------------------------------
  // 业务 payload 路由
  // ---------------------------------------------------------------------------

  private handleAppPayload(value: unknown): void {
    // rpc-frame/ack 是 transport-only 分片（不在 app payload 联合内），前置分派到 bridge。
    const rawFrame = parseRelayV3RpcFrame(value);
    if (rawFrame) {
      this.bridges.get(rawFrame.bridge_session_id)?.adapter.receive(rawFrame);
      return;
    }
    const rawAck = parseRelayV3RpcFrameAck(value);
    if (rawAck) {
      this.bridges.get(rawAck.bridge_session_id)?.adapter.receive(rawAck);
      return;
    }
    const payload = parseRelayV3AppPayload(value);
    if (!payload) {
      this.options.logger.warn("relay-v3 invalid app payload dropped");
      return;
    }
    switch (payload.zcode_type) {
      case "bootstrap-request":
        this.handleBootstrapRequest(payload);
        return;
      case "workspace-list-request":
        this.sendToTerminal({
          zcode_type: "workspace-list-response",
          workspaces: this.flattenWorkspaces(),
        });
        return;
      case "workspace-bridge-open":
        this.handleBridgeOpen(payload);
        return;
      case "mobile-view-state-update":
        // 只存投影供诊断；不参与身份/配对/缓存 key（V2 语义）。
        this.latestViewState = payload;
        return;
      case "app-error":
        this.options.logger.warn("relay-v3 terminal app error", { code: payload.code });
        return;
      default:
        return;
    }
  }

  private handleBootstrapRequest(payload: { view_state?: unknown }): void {
    void payload;
    this.sendToTerminal({
      zcode_type: "bootstrap-response",
      desktop_app_version: this.options.appVersion,
      workspaces: this.flattenWorkspaces(),
    });
  }

  private flattenWorkspaces() {
    const seen = new Set<string>();
    const workspaces: {
      workspace_key: string;
      path: string;
      connection: "local" | "remote" | "offline";
      bridgeable: boolean;
      identity?: string;
      name?: string;
      remote_session_id?: string;
    }[] = [];
    for (const entries of this.workspacesByWindowId.values()) {
      for (const entry of entries) {
        if (seen.has(entry.workspaceKey)) continue;
        seen.add(entry.workspaceKey);
        workspaces.push({
          workspace_key: entry.workspaceKey,
          path: entry.workspacePath,
          connection: entry.remoteSessionId ? "remote" : "local",
          bridgeable: entry.bridgeable,
          ...(entry.workspaceIdentity ? { identity: entry.workspaceIdentity } : {}),
          ...(entry.remoteSessionId ? { remote_session_id: entry.remoteSessionId } : {}),
        });
      }
    }
    return workspaces;
  }

  private handleBridgeOpen(payload: RelayV3WorkspaceBridgeOpen): void {
    const match = this.findWorkspace(payload.workspace_key);
    if (!match) {
      this.sendToTerminal({
        zcode_type: "workspace-bridge-error",
        bridge_session_id: payload.bridge_session_id,
        code: "WORKSPACE_NOT_FOUND",
      });
      return;
    }
    const { windowId, entry } = match;
    if (!entry.bridgeable) {
      this.sendToTerminal({
        zcode_type: "workspace-bridge-error",
        bridge_session_id: payload.bridge_session_id,
        code: "WORKSPACE_NOT_BRIDGEABLE",
      });
      return;
    }
    let scope:
      | { kind: "local" }
      | {
          kind: "remote";
          remoteSessionId: string;
          workspacePath: string;
          workspaceIdentity: string;
          sourceServerId?: string;
        };
    if (entry.remoteSessionId) {
      if (!entry.workspaceIdentity) {
        this.sendToTerminal({
          zcode_type: "workspace-bridge-error",
          bridge_session_id: payload.bridge_session_id,
          code: "REMOTE_WORKSPACE_IDENTITY_MISMATCH",
        });
        return;
      }
      scope = {
        kind: "remote",
        remoteSessionId: entry.remoteSessionId,
        workspacePath: entry.workspacePath,
        workspaceIdentity: entry.workspaceIdentity,
        ...(entry.sourceServerId ? { sourceServerId: entry.sourceServerId } : {}),
      };
    } else {
      scope = { kind: "local" };
    }
    // 同 bridgeSessionId 重复 open（重试）不重复分配 attachment（V2 §虚拟项目导航）。
    const previous = this.bridges.get(payload.bridge_session_id);
    if (previous) {
      this.sendToTerminal({
        zcode_type: "workspace-bridge-ready",
        bridge_session_id: payload.bridge_session_id,
        bridge_generation: previous.generation,
      });
      return;
    }

    const channel = this.options.createMessageChannel?.() ?? new MessageChannelMain();
    const attachmentId = randomUUID();
    const terminalOwnerId = `relay-v3:${payload.terminal_client_session_id ?? randomUUID()}`;
    const adapter = new RelayV3AcknowledgedRpc({
      bridgeSessionId: payload.bridge_session_id,
      sendPayload: (frame) => {
        if (!this.transport?.send(frame as unknown as Record<string, unknown>)) {
          // 未配对/断开：bridge 硬降级，terminal 侧重建。
          this.disposeBridge(payload.bridge_session_id, "send-unpaired");
        }
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
      onDegraded: (reason) => {
        this.options.logger.warn("relay-v3 bridge degraded", { bridgeSessionId: payload.bridge_session_id, reason });
        this.disposeBridge(payload.bridge_session_id, "degraded");
        this.sendToTerminal({
          zcode_type: "bridge-degraded",
          bridge_session_id: payload.bridge_session_id,
          reason: "rpc-transport-fault",
        });
      },
    });
    const bridge: ManagedBridge = {
      bridgeSessionId: payload.bridge_session_id,
      attachmentId,
      generation: 1,
      port: channel.port1,
      adapter,
    };
    this.bridges.set(bridge.bridgeSessionId, bridge);
    channel.port1.on("message", (event) => {
      const message = relayV3BridgePortEventToMessage(event.data);
      if (message) adapter.send(encodeRelayV3BridgePortMessage(message));
    });
    channel.port1.once("close", () => this.disposeBridge(bridge.bridgeSessionId, "port-closed"));
    channel.port1.start();
    try {
      this.options.attachHostPort({ windowId, attachmentId, terminalOwnerId, scope, port: channel.port2 });
    } catch (error) {
      this.disposeBridge(bridge.bridgeSessionId, "attach-failed");
      this.options.logger.error("relay-v3 host attach failed", { error });
      this.sendToTerminal({
        zcode_type: "workspace-bridge-error",
        bridge_session_id: payload.bridge_session_id,
        code: "HOST_ATTACH_FAILED",
      });
      return;
    }
    this.sendToTerminal({
      zcode_type: "workspace-bridge-ready",
      bridge_session_id: payload.bridge_session_id,
      bridge_generation: bridge.generation,
      terminal_owner_id: terminalOwnerId,
    });
  }

  private findWorkspace(
    workspaceKey: string,
  ): { windowId: number; entry: RelayV3WorkspaceSyncEntry } | null {
    for (const [windowId, entries] of this.workspacesByWindowId) {
      for (const entry of entries) {
        if (entry.workspaceKey === workspaceKey) return { windowId, entry };
      }
    }
    return null;
  }

  private disposeBridge(bridgeSessionId: string, reason: string): void {
    const bridge = this.bridges.get(bridgeSessionId);
    if (!bridge) return;
    this.bridges.delete(bridgeSessionId);
    bridge.adapter.dispose();
    try {
      bridge.port.close();
    } catch {
      // port 可能已被 Host 侧关闭。
    }
    this.options.detachHostPort(bridge.attachmentId);
    this.options.logger.debug("relay-v3 bridge disposed", { bridgeSessionId, reason });
  }

  private disposeAllBridges(reason: string): void {
    // Map 迭代中删除当前项是安全的（disposeBridge 只删自身 key）。
    for (const bridgeSessionId of this.bridges.keys()) {
      this.disposeBridge(bridgeSessionId, reason);
    }
  }

  private sendToTerminal(payload: Record<string, unknown>): boolean {
    return this.transport?.send(payload) ?? false;
  }

  /** 诊断用：最新 mobile view state 投影。 */
  getLatestViewState(): unknown {
    return this.latestViewState;
  }

  getActiveBridgeCount(): number {
    return this.bridges.size;
  }
}
