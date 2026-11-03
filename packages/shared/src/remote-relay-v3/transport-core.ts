import {
  parseRelayV3Envelope,
  parseRelayV3IncomingMessage,
  RelayV3ConnectionError,
  type RelayV3AuthInit,
  type RelayV3IncomingMessage,
  type RelayV3OutgoingMessage,
  type RelayV3Role,
} from "./contract.js";
import { openRelayV3Envelope, sealRelayV3Envelope } from "./crypto.js";
import { RelayV3Heartbeat, RELAY_V3_HANDSHAKE_DEADLINE_MS } from "./heartbeat.js";

// Relay V3 transport 连接状态机共享内核（device 与 terminal 两个 transport 的公共部分）。
// 语义依据 V2 桌面 device 生命周期（docs/web-remote-control/relay-v2-pairing.md §03）
// 在 V3 的重建：网络/5xx 从 1s 指数退避（±20% jitter，上限 30s，auth_ack 清零）；
// 首次 KICKED 随机 2~5s 重连，60s 内第二次 → session-conflict 终态；每次重连先关
// 旧连再取新 token（由 openConnection 回调承担）；握手 15s deadline；心跳复用
// RelayV3Heartbeat（5s±1s / 15s watchdog）。generation 丢弃 stop/重启后的过期异步结果。
// socket 建立与 token 获取由两端注入（Node ws / 浏览器 WebSocket 各自适配）。

export type RelayV3TransportPhase =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting"
  | "matched"
  | "failed";

export type RelayV3TransportFailureKind =
  | "auth-required"
  | "relay-unavailable"
  | "session-conflict"
  | "auth-failed"
  | "device-offline"
  | "stopped";

export interface RelayV3TransportState {
  phase: RelayV3TransportPhase;
  failure?: { kind: RelayV3TransportFailureKind; message?: string };
  /** terminal 专属：DEVICE_OFFLINE 宽限中（15s 内等待设备回线）。 */
  deviceOfflineGrace?: boolean;
}

export interface RelayV3TransportFailure {
  kind: RelayV3TransportFailureKind;
  message?: string;
}

/** transport 持有的连接 socket 最小接口（ws 库与浏览器 WebSocket 各自适配）。 */
export interface RelayV3TransportSocket {
  send(text: string): void;
  close(): void;
  onMessage(listener: (text: string) => void): () => void;
  onClose(listener: () => void): () => void;
}

export interface RelayV3TransportTiming {
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  random?: () => number;
}

export interface RelayV3TransportCoreOptions {
  role: RelayV3Role;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /**
   * 建立连接：申请一次性 ws token 并完成 Upgrade。必须先关闭旧 socket 再取新 token
   * （V2 语义）。失败抛 RelayV3ConnectionError（网络/5xx retryable=true 走退避；
   * auth-required / 其他 4xx 停止）。
   */
  openConnection: () => Promise<RelayV3TransportSocket>;
  /** 构造本角色的 auth_init（device: {device_sid, meta}；terminal: {device_sid, terminal_public_key}）。 */
  buildAuthInit: () => RelayV3AuthInit;
  /**
   * 会话密钥：device 侧在 pair_status_ack(matched 且透传 terminal_public_key) 时派生；
   * terminal 侧建连前已知目标设备公钥。返回 null 表示暂无法派生（waiting）。
   */
  deriveSessionKey: (peer: { terminalPublicKey?: string }) => Uint8Array | null;
  /** 信封 kid（两端均为目标设备公钥的 keyId，跨 terminal 轮换稳定）。 */
  kid: string;
  onState: (state: RelayV3TransportState) => void;
  /** 解密成功的业务 payload 明文 JSON（对象）。 */
  onAppPayload: (payload: unknown) => void;
  /** 协议错误通知（core 已自行断开重建，回调仅用于日志/埋点）。 */
  onProtocolFault?: (kind: "decrypt-failed" | "invalid-incoming" | "invalid-outgoing") => void;
  timing?: RelayV3TransportTiming;
  /** 退避参数（测试注入）。 */
  backoff?: Partial<RelayV3BackoffOptions>;
  /** terminal 的 DEVICE_OFFLINE 宽限时长；默认 15s。 */
  deviceOfflineGraceMs?: number;
}

export interface RelayV3BackoffOptions {
  initialMs: number;
  maxMs: number;
  jitterRatio: number;
  kickedFirstMinMs: number;
  kickedFirstMaxMs: number;
  kickedWindowMs: number;
}

const DEFAULT_BACKOFF: RelayV3BackoffOptions = {
  initialMs: 1_000,
  maxMs: 30_000,
  jitterRatio: 0.2,
  kickedFirstMinMs: 2_000,
  kickedFirstMaxMs: 5_000,
  kickedWindowMs: 60_000,
};

export class RelayV3TransportCore {
  private readonly timing: Required<RelayV3TransportTiming>;
  private readonly backoffOptions: RelayV3BackoffOptions;
  private generation = 0;
  private state: RelayV3TransportState = { phase: "idle" };
  private socket?: RelayV3TransportSocket;
  private detachSocket?: () => void;
  private heartbeat?: RelayV3Heartbeat;
  private handshakeDeadline?: unknown;
  private reconnectTimer?: unknown;
  private offlineGraceTimer?: unknown;
  private backoffAttempt = 0;
  private lastKickedAt?: number;
  private sessionKey?: Uint8Array;
  private stopped = true;

  constructor(private readonly options: RelayV3TransportCoreOptions) {
    this.timing = {
      now: options.timing?.now ?? (() => Date.now()),
      setTimeout: options.timing?.setTimeout ?? ((callback, ms) => setTimeout(callback, ms)),
      clearTimeout:
        options.timing?.clearTimeout ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0])),
      random: options.timing?.random ?? Math.random,
    };
    this.backoffOptions = { ...DEFAULT_BACKOFF, ...options.backoff };
  }

  getState(): RelayV3TransportState {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.backoffAttempt = 0;
    this.lastKickedAt = undefined;
    this.connect(this.generation);
  }

  stop(): void {
    this.dispose({ kind: "stopped" });
  }

  /** 发送业务 payload：仅在 matched 且已派生会话密钥时加密发出。 */
  send(payload: Record<string, unknown>): boolean {
    if (this.stopped || this.state.phase !== "matched" || !this.sessionKey || !this.socket) {
      return false;
    }
    // sealRelayV3Envelope 产出的信封即 wire 上的 data.payload（relay 不解析，仅透传）。
    const envelope = sealRelayV3Envelope(
      this.sessionKey,
      new TextEncoder().encode(JSON.stringify(payload)),
      this.options.kid,
    );
    this.socket.send(
      JSON.stringify({ type: "data", payload: envelope } satisfies RelayV3OutgoingMessage),
    );
    return true;
  }

  // ---------------------------------------------------------------------------
  // 连接循环
  // ---------------------------------------------------------------------------

  private async connect(generation: number): Promise<void> {
    this.publish({ phase: "connecting" });
    let socket: RelayV3TransportSocket;
    try {
      socket = await this.options.openConnection();
    } catch (error) {
      if (generation !== this.generation) return;
      this.handleOpenFailure(error);
      return;
    }
    if (generation !== this.generation) {
      socket.close();
      return;
    }
    this.attachSocket(socket, generation);
    this.publish({ phase: "authenticating" });
    this.handshakeDeadline = this.scheduleTimer(() => {
      if (generation !== this.generation) return;
      this.options.log("handshake-deadline");
      this.reconnect(generation, "backoff");
    }, RELAY_V3_HANDSHAKE_DEADLINE_MS);
    const authInit = this.options.buildAuthInit();
    socket.send(JSON.stringify(authInit satisfies RelayV3OutgoingMessage));
  }

  private attachSocket(socket: RelayV3TransportSocket, generation: number): void {
    this.closeSocket();
    this.socket = socket;
    const offMessage = socket.onMessage((text) => {
      if (generation !== this.generation) return;
      this.handleIncoming(text);
    });
    const offClose = socket.onClose(() => {
      if (generation !== this.generation) return;
      this.options.log("socket-closed", { phase: this.state.phase });
      this.reconnect(generation, "backoff");
    });
    this.detachSocket = () => {
      offMessage();
      offClose();
    };
  }

  private handleOpenFailure(error: unknown): void {
    if (error instanceof RelayV3ConnectionError) {
      if (error.reason === "auth-required" || !error.retryable) {
        // relay 账号登录态失效或不可恢复 4xx：终态，停止自动重连（V2 语义）。
        this.dispose({ kind: error.reason === "auth-required" ? "auth-required" : "relay-unavailable", message: error.message });
        return;
      }
    }
    this.scheduleBackoffReconnect();
  }

  private scheduleBackoffReconnect(): void {
    const generation = this.generation;
    const delay = this.nextBackoffDelayMs();
    this.reconnectTimer = this.scheduleTimer(() => {
      if (generation !== this.generation) return;
      this.connect(generation);
    }, delay);
  }

  private nextBackoffDelayMs(): number {
    const { initialMs, maxMs, jitterRatio } = this.backoffOptions;
    const base = Math.min(initialMs * 2 ** this.backoffAttempt, maxMs);
    this.backoffAttempt = Math.min(this.backoffAttempt + 1, 16);
    const jitter = 1 + (this.timing.random() * 2 - 1) * jitterRatio;
    return Math.max(1, Math.round(base * jitter));
  }

  private reconnect(generation: number, mode: "backoff" | "kicked-first"): void {
    if (generation !== this.generation || this.stopped) return;
    this.teardownSocketAndTimers();
    if (mode === "backoff") {
      this.scheduleBackoffReconnect();
      return;
    }
    const { kickedFirstMinMs, kickedFirstMaxMs } = this.backoffOptions;
    const delay =
      kickedFirstMinMs + Math.floor(this.timing.random() * Math.max(1, kickedFirstMaxMs - kickedFirstMinMs));
    this.reconnectTimer = this.scheduleTimer(() => {
      if (generation !== this.generation) return;
      this.connect(generation);
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // 入站消息
  // ---------------------------------------------------------------------------

  private handleIncoming(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.options.onProtocolFault?.("invalid-incoming");
      this.reconnect(this.generation, "backoff");
      return;
    }
    const message = parseRelayV3IncomingMessage(value);
    if (!message) {
      this.options.onProtocolFault?.("invalid-incoming");
      this.reconnect(this.generation, "backoff");
      return;
    }
    switch (message.type) {
      case "auth_ack":
        this.handleAuthAck(message);
        break;
      case "pair_status_ack":
        this.handlePairStatusAck(message);
        break;
      case "data":
        this.handleData(message.payload);
        break;
      case "error":
        this.handleRelayError(message);
        break;
    }
  }

  private handleAuthAck(message: Extract<RelayV3IncomingMessage, { type: "auth_ack" }>): void {
    if (this.handshakeDeadline !== undefined) {
      this.timing.clearTimeout(this.handshakeDeadline);
      this.handshakeDeadline = undefined;
    }
    // auth_ack 清零退避（V2：网络退避在配对确认后复位）。
    this.backoffAttempt = 0;
    this.startHeartbeat();
    if (message.pair_status === "matched") {
      const key = this.options.deriveSessionKey({});
      if (key) this.sessionKey = key;
      this.publish({ phase: "matched" });
    } else {
      this.sessionKey = undefined;
      this.publish({ phase: "waiting" });
    }
  }

  private handlePairStatusAck(message: Extract<RelayV3IncomingMessage, { type: "pair_status_ack" }>): void {
    this.heartbeat?.acknowledged();
    if (message.pair_status === "matched") {
      if (message.terminal_public_key) {
        const key = this.options.deriveSessionKey({ terminalPublicKey: message.terminal_public_key });
        if (key) {
          this.sessionKey = key;
        } else {
          // 公钥不可用（退化点等）：按 AUTH_FAILED 处理（§4.3）。
          this.options.onProtocolFault?.("invalid-incoming");
          this.dispose({ kind: "auth-failed", message: "invalid terminal public key" });
          return;
        }
      }
      this.publish({ phase: "matched", deviceOfflineGrace: false });
    } else {
      this.sessionKey = undefined;
      this.publish({ phase: "waiting" });
    }
  }

  private handleData(payload: unknown): void {
    const envelope = parseRelayV3Envelope(payload);
    if (!envelope) {
      this.options.onProtocolFault?.("invalid-incoming");
      this.reconnect(this.generation, "backoff");
      return;
    }
    if (!this.sessionKey) {
      // 未配对/未派生密钥时收到 data：按协议错误断开重建（V2：未配对发 data → INTERNAL）。
      this.options.onProtocolFault?.("invalid-incoming");
      this.reconnect(this.generation, "backoff");
      return;
    }
    let plaintext: Uint8Array;
    try {
      plaintext = openRelayV3Envelope(this.sessionKey, payload);
    } catch {
      // 解密失败不静默丢弃：记录 decrypt-failed 并断开重建（§4.5）。
      this.options.onProtocolFault?.("decrypt-failed");
      this.reconnect(this.generation, "backoff");
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      this.options.onProtocolFault?.("invalid-incoming");
      this.reconnect(this.generation, "backoff");
      return;
    }
    if (typeof decoded !== "object" || decoded === null) {
      this.options.onProtocolFault?.("invalid-incoming");
      this.reconnect(this.generation, "backoff");
      return;
    }
    this.options.onAppPayload(decoded);
  }

  private handleRelayError(message: Extract<RelayV3IncomingMessage, { type: "error" }>): void {
    this.options.log("relay-error", { code: message.code, message: message.message });
    switch (message.code) {
      case "AUTH_FAILED":
        // 同次启动最多恢复一次由 manager 层承担（重注册后重建 core）。
        this.dispose({ kind: "auth-failed", message: message.message });
        return;
      case "KICKED": {
        const now = this.timing.now();
        if (this.lastKickedAt !== undefined && now - this.lastKickedAt < this.backoffOptions.kickedWindowMs) {
          this.dispose({ kind: "session-conflict", message: message.message });
          return;
        }
        this.lastKickedAt = now;
        this.reconnect(this.generation, "kicked-first");
        return;
      }
      case "DEVICE_OFFLINE":
        if (this.options.role === "terminal") {
          // 设备离线：relay 会关闭本连接；进入宽限重连，超时未恢复 → device-offline 终态。
          this.publish({ phase: "waiting", deviceOfflineGrace: true });
          this.enterOfflineGrace();
        }
        return;
      case "WRONG_PARAM":
        // 非法字段被 relay 关闭：断开重建。
        this.reconnect(this.generation, "backoff");
        return;
      case "INTERNAL":
      default:
        if (this.state.phase === "matched" || this.state.phase === "waiting") {
          // 可恢复等待：保持连接语义，由后续 close/心跳 watchdog 驱动重连。
          return;
        }
        this.reconnect(this.generation, "backoff");
        return;
    }
  }

  private enterOfflineGrace(): void {
    if (this.offlineGraceTimer !== undefined) return;
    const generation = this.generation;
    this.offlineGraceTimer = this.scheduleTimer(() => {
      if (generation !== this.generation) return;
      if (this.state.phase !== "matched") {
        this.dispose({ kind: "device-offline" });
      }
    }, this.options.deviceOfflineGraceMs ?? 15_000);
  }

  // ---------------------------------------------------------------------------
  // 心跳与生命周期
  // ---------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeat?.stop();
    const generation = this.generation;
    this.heartbeat = new RelayV3Heartbeat(
      () => {
        if (generation !== this.generation || !this.socket) return;
        this.socket.send(JSON.stringify({ type: "pair_status_query" } satisfies RelayV3OutgoingMessage));
      },
      () => {
        if (generation !== this.generation) return;
        this.options.log("heartbeat-watchdog");
        this.reconnect(generation, "backoff");
      },
      {
        // 心跳计时与 core 共用同一注入时钟（测试手动推进；生产为全局 setTimeout）。
        setTimeout: (callback, ms) => this.timing.setTimeout(callback, ms) as ReturnType<typeof setTimeout>,
        clearTimeout: (handle) => this.timing.clearTimeout(handle),
      },
    );
    this.heartbeat.acknowledged();
  }

  private scheduleTimer(callback: () => void, ms: number): unknown {
    return this.timing.setTimeout(callback, ms);
  }

  private publish(next: RelayV3TransportState): void {
    this.state = next;
    this.options.onState(next);
  }

  private teardownSocketAndTimers(): void {
    if (this.handshakeDeadline !== undefined) {
      this.timing.clearTimeout(this.handshakeDeadline);
      this.handshakeDeadline = undefined;
    }
    if (this.reconnectTimer !== undefined) {
      this.timing.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.heartbeat?.stop();
    this.heartbeat = undefined;
    this.closeSocket();
  }

  private closeSocket(): void {
    this.detachSocket?.();
    this.detachSocket = undefined;
    if (this.socket) {
      const socket = this.socket;
      this.socket = undefined;
      try {
        socket.close();
      } catch {
        // 关闭竞态不致命：generation 已使旧 socket 回调失效。
      }
    }
  }

  private dispose(failure: RelayV3TransportFailure): void {
    this.generation += 1;
    this.stopped = true;
    this.teardownSocketAndTimers();
    if (this.offlineGraceTimer !== undefined) {
      this.timing.clearTimeout(this.offlineGraceTimer);
      this.offlineGraceTimer = undefined;
    }
    this.sessionKey = undefined;
    this.publish({ phase: "failed", failure });
  }
}
