// §8 资源限额：编译期常量（对齐 OpenBitFun 思路，规模按自部署下调）。
// 限额是部署防线，客户端不得依赖其行为（fixture 不模拟限流）。

export const RELAY_LIMITS = {
  /** 鉴权请求体 16 KiB，超限 413。 */
  authBodyBytes: 16 * 1024,
  /** 其余请求体（含密文信封）4 MiB，超限 413。 */
  cipherBodyBytes: 4 * 1024 * 1024,
  /** 并发 HTTP 请求 512，超限 503。 */
  concurrentHttp: 512,
  /** 验证码发送：每 IP 每分钟 5 条。 */
  smsSendPerIpPerMinute: 5,
  /** 验证码重发冷却 60 秒（每手机号）。 */
  smsResendCooldownMs: 60_000,
  /** 每手机号每天 10 条（UTC 日）。 */
  smsPerPhonePerDay: 10,
  /** 验证码校验：每 IP 每分钟 10 次。 */
  smsVerifyPerIpPerMinute: 10,
  /** 连续失败按账号指数锁定：5 次失败锁 5 分钟起步，每多 1 次翻倍，封顶 24 小时。 */
  loginLockoutBaseFailures: 5,
  loginLockoutBaseSeconds: 300,
  loginLockoutMaxSeconds: 24 * 3_600,
  /** refresh 旋转 30/分钟/IP。 */
  refreshPerIpPerMinute: 30,
  /** WS 连接 256/进程。 */
  wsConnections: 256,
  /** 握手（auth_init → auth_ack）15s deadline。 */
  wsHandshakeDeadlineMs: 15_000,
  /** 服务端 ping 间隔与 pong 超时（§8：ping 5s±1s 由客户端承担，服务端 45s 覆盖）。 */
  wsPingIntervalMs: 15_000,
  wsPongTimeoutMs: 45_000,
  /** WS 单消息 1 MiB（含密文膨胀预算）。 */
  wsMaxMessageBytes: 1_048_576,
  /** WS 出站队列 128 条/连接；2s 内无法入队即丢弃该帧。 */
  wsOutboundQueueLimit: 128,
  wsOutboundSaturatedDropMs: 2_000,
  wsOutboundBufferBytes: 4 * 1024 * 1024,
  /** 设备数 / 活跃凭据 64 / 256 每账号，数据库原子准入。 */
  devicesPerAccount: 64,
  activeCredentialsPerAccount: 256,
  /** 设备授权：user_code 15 分钟、单次使用。 */
  deviceAuthTtlMs: 900_000,
  deviceAuthRequestPerIpPerMinute: 5,
  deviceAuthPollPerDeviceCodePerMinute: 30,
  deviceAuthApprovePerIpPerMinute: 10,
  /** 每账号待批准（已批准未领取）请求上限 8 条；request 为匿名请求，追加按 IP 的 pending 上限。 */
  deviceAuthPendingPerAccount: 8,
  deviceAuthPendingPerIp: 8,
  /** 一次性 ws token 60 秒。 */
  wsTokenTtlMs: 60_000,
} as const;

/** 固定窗口计数限流器；单进程内存事实，重启即清零（与在线态同级，§7）。 */
export class RateLimiter {
  private readonly windows = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 记录一次命中；返回是否在限额内（false 表示超限，本次应被拒绝）。 */
  hit(key: string): boolean {
    const now = this.now();
    const entry = this.windows.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.windows.set(key, { windowStart: now, count: 1 });
      return this.max >= 1;
    }
    entry.count += 1;
    if (entry.count > this.max) return false;
    return true;
  }

  /** 当前窗口内是否已达上限（不产生命中）。 */
  saturated(key: string): boolean {
    const now = this.now();
    const entry = this.windows.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) return false;
    return entry.count >= this.max;
  }

  prune(): void {
    const now = this.now();
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart >= this.windowMs * 2) this.windows.delete(key);
    }
  }
}

/** 指数锁定计算：5 次失败锁 5 分钟起步，2^(n-5) 递增，封顶 24 小时。 */
export function loginLockoutSeconds(failures: number): number {
  if (failures < RELAY_LIMITS.loginLockoutBaseFailures) return 0;
  const exponent = failures - RELAY_LIMITS.loginLockoutBaseFailures;
  const seconds = RELAY_LIMITS.loginLockoutBaseSeconds * 2 ** exponent;
  return Math.min(seconds, RELAY_LIMITS.loginLockoutMaxSeconds);
}
