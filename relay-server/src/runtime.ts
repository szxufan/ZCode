import { createHash, randomBytes, randomInt } from "node:crypto";

import { RELAY_LIMITS, RateLimiter } from "./limits.js";

// 进程内存事实（§7）：(SID, role) 当前 owner 见 ws 模块；此处集中持有
// 一次性 ws token、待批准设备授权请求、验证码发送日志与全部限流器。
// 进程重启即清零，客户端按既有退避重连，无需恢复逻辑。

export interface OneTimeWsToken {
  accountId: string;
  role: "device" | "terminal";
  expiresAt: number;
}

export interface DeviceAuthRequestEntry {
  userCode: string;
  deviceCodeHash: string;
  publicKey: string;
  status: "pending" | "approved" | "consumed";
  accountId?: string;
  deviceSid?: string;
  expiresAt: number;
}

export interface RelayRuntimeDeps {
  now?: () => number;
}

export interface RelayRuntimeLimiters {
  smsSendPerIp: RateLimiter;
  smsVerifyPerIp: RateLimiter;
  refreshPerIp: RateLimiter;
  deviceAuthRequestPerIp: RateLimiter;
  deviceAuthPollPerDeviceCode: RateLimiter;
  deviceAuthApprovePerIp: RateLimiter;
}

export class RelayRuntime {
  readonly now: () => number;
  readonly wsTokens = new Map<string, OneTimeWsToken>();
  /** device_code 哈希 → 请求；userCodeIndex 供 approve 反查。 */
  readonly deviceAuthRequests = new Map<string, DeviceAuthRequestEntry>();
  readonly deviceAuthByUserCode = new Map<string, string>();
  /** phone → { lastSentAt, dayKey, dailyCount }；重发冷却与每日限额（UTC 日）。 */
  readonly smsSendLog = new Map<
    string,
    { lastSentAt: number; dayKey: string; dailyCount: number }
  >();
  /** 并发 HTTP 请求计数（§8 512 → 503）。 */
  inFlightHttp = 0;
  readonly limiters: RelayRuntimeLimiters;
  /** 验证码发送日志与限流器统一走注入时钟，测试可推进时间。 */

  constructor(deps: RelayRuntimeDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.limiters = {
      smsSendPerIp: new RateLimiter(RELAY_LIMITS.smsSendPerIpPerMinute, 60_000, this.now),
      smsVerifyPerIp: new RateLimiter(RELAY_LIMITS.smsVerifyPerIpPerMinute, 60_000, this.now),
      refreshPerIp: new RateLimiter(RELAY_LIMITS.refreshPerIpPerMinute, 60_000, this.now),
      deviceAuthRequestPerIp: new RateLimiter(
        RELAY_LIMITS.deviceAuthRequestPerIpPerMinute,
        60_000,
        this.now,
      ),
      deviceAuthPollPerDeviceCode: new RateLimiter(
        RELAY_LIMITS.deviceAuthPollPerDeviceCodePerMinute,
        60_000,
        this.now,
      ),
      deviceAuthApprovePerIp: new RateLimiter(
        RELAY_LIMITS.deviceAuthApprovePerIpPerMinute,
        60_000,
        this.now,
      ),
    };
  }

  issueWsToken(accountId: string, role: "device" | "terminal"): { token: string; expires_in: 60 } {
    const token = randomBytes(16).toString("base64url");
    this.wsTokens.set(token, {
      accountId,
      role,
      expiresAt: this.now() + RELAY_LIMITS.wsTokenTtlMs,
    });
    return { token, expires_in: 60 };
  }

  /** Upgrade 前原子消费：取出即删除，失败不恢复（§5.2）。 */
  consumeWsToken(token: string): OneTimeWsToken | null {
    const entry = this.wsTokens.get(token);
    if (!entry) return null;
    this.wsTokens.delete(token);
    if (entry.expiresAt <= this.now()) return null;
    return entry;
  }

  createDeviceAuthRequest(publicKey: string): {
    user_code: string;
    device_code: string;
    expires_in: 900;
  } | null {
    let pendingTotal = 0;
    for (const entry of this.deviceAuthRequests.values()) {
      if (entry.status === "pending") pendingTotal += 1;
    }
    // 匿名请求无法按账号计数；以 pending 总量约束内存与滥用（每 IP 限流另守第一道）。
    if (pendingTotal >= RELAY_LIMITS.deviceAuthPendingPerIp * 16) return null;
    const userCode = String(randomInt(10_000_000, 100_000_000));
    const deviceCode = randomBytes(32).toString("base64url");
    const deviceCodeHash = this.hashDeviceCode(deviceCode);
    this.deviceAuthRequests.set(deviceCodeHash, {
      userCode,
      deviceCodeHash,
      publicKey,
      status: "pending",
      expiresAt: this.now() + RELAY_LIMITS.deviceAuthTtlMs,
    });
    this.deviceAuthByUserCode.set(userCode, deviceCodeHash);
    // device_code 仅此一次返回，relay 只存哈希（§5.5）。
    return { user_code: userCode, device_code: deviceCode, expires_in: 900 };
  }

  findDeviceAuthByUserCode(userCode: string): DeviceAuthRequestEntry | null {
    const hash = this.deviceAuthByUserCode.get(userCode);
    return hash ? (this.deviceAuthRequests.get(hash) ?? null) : null;
  }

  findDeviceAuthByDeviceCode(deviceCode: string): DeviceAuthRequestEntry | null {
    return this.deviceAuthRequests.get(this.hashDeviceCode(deviceCode)) ?? null;
  }

  /** 每账号已批准未领取请求计数（"待批准上限 8 条"的 approve 时点解释，§5.5）。 */
  countApprovedPendingForAccount(accountId: string): number {
    let count = 0;
    for (const entry of this.deviceAuthRequests.values()) {
      if (entry.accountId === accountId && entry.status === "approved") count += 1;
    }
    return count;
  }

  pruneExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.wsTokens) {
      if (entry.expiresAt <= now) this.wsTokens.delete(token);
    }
    for (const [hash, entry] of this.deviceAuthRequests) {
      if (entry.expiresAt <= now) {
        this.deviceAuthRequests.delete(hash);
        this.deviceAuthByUserCode.delete(entry.userCode);
      }
    }
    for (const limiter of Object.values(this.limiters)) limiter.prune();
  }

  private hashDeviceCode(deviceCode: string): string {
    return createHash("sha256").update(deviceCode).digest("hex");
  }
}

/** 每手机号每日发送预算与 60s 重发冷却（UTC 日，§3.2）；返回 false 表示应拒绝发送。 */
export function smsSendAdmitted(
  runtime: RelayRuntime,
  phone: string,
  action: "check" | "consume",
): boolean {
  const now = runtime.now();
  const dayKey = new Date(now).toISOString().slice(0, 10);
  const entry = runtime.smsSendLog.get(phone);
  if (!entry || entry.dayKey !== dayKey) {
    if (action === "consume")
      runtime.smsSendLog.set(phone, { lastSentAt: now, dayKey, dailyCount: 1 });
    return true;
  }
  if (action === "check") {
    if (entry.dailyCount >= RELAY_LIMITS.smsPerPhonePerDay) return false;
    return now - entry.lastSentAt >= RELAY_LIMITS.smsResendCooldownMs;
  }
  if (entry.dailyCount >= RELAY_LIMITS.smsPerPhonePerDay) return false;
  if (now - entry.lastSentAt < RELAY_LIMITS.smsResendCooldownMs) return false;
  entry.lastSentAt = now;
  entry.dailyCount += 1;
  return true;
}
