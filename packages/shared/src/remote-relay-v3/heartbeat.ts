// Relay V3 心跳时序（§5.2）：客户端每 4~6 秒（基准 5,000ms，±1,000ms 随机）
// 发送 pair_status_query 或心跳；ACK deadline 15s，watchdog 独立计时；
// 握手（auth_init → auth_ack）15s deadline。时序常量供两端 transport 与测试共用。

export const RELAY_V3_HEARTBEAT_INTERVAL_MS = 5_000;
export const RELAY_V3_HEARTBEAT_JITTER_MS = 1_000;
export const RELAY_V3_HEARTBEAT_ACK_TIMEOUT_MS = 15_000;
export const RELAY_V3_HANDSHAKE_DEADLINE_MS = 15_000;
export const RELAY_V3_WS_TOKEN_EXPIRES_IN = 60;

function safeRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(0.999999999, Math.max(0, value));
}

function normalizeIntervalMs(intervalMs?: number): number {
  if (intervalMs === undefined) return RELAY_V3_HEARTBEAT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return RELAY_V3_HEARTBEAT_INTERVAL_MS;
  return Math.floor(intervalMs);
}

function jitterFor(intervalMs: number, jitterMs?: number): number {
  const defaultJitterMs = Math.min(RELAY_V3_HEARTBEAT_JITTER_MS, Math.floor(intervalMs * 0.2));
  const requested = jitterMs ?? defaultJitterMs;
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  // jitter 必须小于基准间隔，避免把合法心跳变成 0ms 风暴。
  return Math.min(Math.floor(requested), Math.max(0, intervalMs - 1));
}

export function getRelayV3HeartbeatDelayMs(
  intervalMs?: number,
  jitterMs?: number,
  random: () => number = Math.random,
): number {
  const base = normalizeIntervalMs(intervalMs);
  const jitter = jitterFor(base, jitterMs);
  const minDelayMs = Math.max(1, base - jitter);
  const maxDelayMs = base + jitter;
  return minDelayMs + Math.floor(safeRandom(random) * (maxDelayMs - minDelayMs + 1));
}

/** ACK deadline 独立于 jitter 心跳；两端 transport 复用，不补发休眠期间的历史心跳。 */
export class RelayV3Heartbeat {
  private heartbeat?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly query: () => void,
    private readonly expired: () => void,
    private readonly timing: { intervalMs?: number; jitterMs?: number; ackTimeoutMs?: number } = {},
  ) {}
  acknowledged(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(
      this.expired,
      this.timing.ackTimeoutMs ?? RELAY_V3_HEARTBEAT_ACK_TIMEOUT_MS,
    );
    if (!this.heartbeat) this.schedule();
  }
  stop(): void {
    clearTimeout(this.heartbeat);
    clearTimeout(this.watchdog);
    this.heartbeat = this.watchdog = undefined;
  }
  private schedule(): void {
    this.heartbeat = setTimeout(
      () => {
        this.heartbeat = undefined;
        this.query();
        this.schedule();
      },
      getRelayV3HeartbeatDelayMs(this.timing.intervalMs, this.timing.jitterMs),
    );
  }
}
