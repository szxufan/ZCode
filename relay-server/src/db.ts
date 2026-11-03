import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { RELAY_LIMITS } from "./limits.js";

// §7 数据模型（node:sqlite，WAL）。在线态、配对 owner、一次性 token、待批准
// 设备授权请求均为进程内存事实，不入库；进程重启后设备显示离线，客户端按
// 既有退避重连（§7）。表结构在 spec"关键列"之外补充了实现必需的列：
// accounts.failed_attempts/locked_until（§3.2 账号锁定）、sms_codes.code_salt/
// attempts（加盐哈希与暴力尝试上限）、refresh_tokens.rotated_at/created_at
// （家族旋转与重放检测）。

export interface AccountRow {
  id: string;
  phone_e164: string;
  password_scrypt: string | null;
  status: string;
  failed_attempts: number;
  locked_until: number;
  created_at: number;
}

export interface DeviceRow {
  sid: string;
  account_id: string;
  device_mid: string;
  public_key: string;
  meta: string;
  created_at: number;
  deleted_at: number | null;
}

export interface RefreshTokenRow {
  token_hash: string;
  family_id: string;
  account_id: string;
  expires_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export function openRelayDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      phone_e164 TEXT UNIQUE NOT NULL,
      password_scrypt TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sms_codes (
      phone TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      code_salt TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'login',
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      request_ip TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      sid TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      device_mid TEXT NOT NULL,
      public_key TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS devices_account ON devices(account_id);
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      rotated_at INTEGER,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS refresh_tokens_family ON refresh_tokens(family_id);
    CREATE INDEX IF NOT EXISTS refresh_tokens_account ON refresh_tokens(account_id);
  `);
  return db;
}

/** 启动清理：过期验证码与已终结的 refresh token（幂等，重启安全）。 */
export function startupCleanup(db: DatabaseSync, now: () => number = Date.now): void {
  db.prepare("DELETE FROM sms_codes WHERE expires_at <= ?").run(Math.floor(now() / 1000));
  db.prepare("DELETE FROM refresh_tokens WHERE expires_at <= ?").run(Math.floor(now() / 1000));
}

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

/** 注册设备：64/账号，count+insert 在事务内原子准入（§8）。 */
export function insertDeviceWithQuota(
  db: DatabaseSync,
  input: { accountId: string; deviceMid: string; publicKey: string; meta?: string },
  now = Date.now,
): DeviceRow {
  db.exec("BEGIN IMMEDIATE");
  try {
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND deleted_at IS NULL")
      .get(input.accountId) as { n: number };
    if (count.n >= RELAY_LIMITS.devicesPerAccount) {
      throw new QuotaExceededError("device quota exceeded");
    }
    const sid = `d_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    db.prepare(
      "INSERT INTO devices (sid, account_id, device_mid, public_key, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      sid,
      input.accountId,
      input.deviceMid,
      input.publicKey,
      input.meta ?? "{}",
      Math.floor(now() / 1000),
    );
    db.exec("COMMIT");
    const row = db.prepare("SELECT * FROM devices WHERE sid = ?").get(sid) as unknown as DeviceRow;
    return row;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** 活跃凭据：256/账号（未旋转、未撤销、未过期），签发前原子准入（§8）。 */
export function countActiveCredentials(
  db: DatabaseSync,
  accountId: string,
  now: () => number = Date.now,
) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM refresh_tokens WHERE account_id = ? AND rotated_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
    )
    .get(accountId, Math.floor(now() / 1000)) as { n: number };
  return row.n;
}
