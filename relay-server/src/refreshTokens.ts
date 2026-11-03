import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { countActiveCredentials, QuotaExceededError } from "./db.js";
import { RELAY_LIMITS } from "./limits.js";

// §3.3 refresh token：32 字节随机串，哈希落库，30 天有效。
// 每次刷新旧 token 失效并签发新 token，构成家族；已旋转 token 的重放撤销整个
// 家族（防盗号续期）。登出撤销当前家族。

const REFRESH_TTL_SECONDS = 30 * 24 * 3_600;

export class RefreshRejectedError extends Error {
  constructor(
    message: string,
    readonly replayDetected: boolean,
  ) {
    super(message);
    this.name = "RefreshRejectedError";
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function issuePair(): { refresh: string } {
  // access 为无状态 JWT（jwt.ts 签发），此处只落库 refresh 的哈希。
  return { refresh: randomBytes(32).toString("base64url") };
}

/** 签发新家族（登录/设备授权 poll）。活跃凭据超配额即拒绝（原子准入）。 */
export function issueRefreshFamily(
  db: DatabaseSync,
  accountId: string,
  now = Date.now,
): { refresh: string; familyId: string } {
  if (countActiveCredentials(db, accountId, now) >= RELAY_LIMITS.activeCredentialsPerAccount) {
    throw new QuotaExceededError("active credential quota exceeded");
  }
  const familyId = randomUUID().replace(/-/g, "");
  const pair = issuePair();
  db.prepare(
    "INSERT INTO refresh_tokens (token_hash, family_id, account_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    tokenHash(pair.refresh),
    familyId,
    accountId,
    Math.floor(now() / 1000) + REFRESH_TTL_SECONDS,
    Math.floor(now() / 1000),
  );
  return { refresh: pair.refresh, familyId };
}

/**
 * 旋转 refresh：已旋转（重放）或过期即撤销整个家族并拒绝；成功则旧 token 标记
 * 旋转、同家族签发新对。
 */
export function rotateRefreshToken(
  db: DatabaseSync,
  refresh: string,
  now = Date.now,
): { refresh: string; accountId: string; familyId: string } {
  const hash = tokenHash(refresh);
  const row = db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").get(hash) as
    | {
        family_id: string;
        account_id: string;
        expires_at: number;
        rotated_at: number | null;
        revoked_at: number | null;
      }
    | undefined;
  if (!row || row.revoked_at !== null) {
    throw new RefreshRejectedError("session expired", false);
  }
  const nowSeconds = Math.floor(now() / 1000);
  // 已旋转 token 的重放撤销整个家族（§3.3）。
  if (row.rotated_at !== null || row.expires_at <= nowSeconds) {
    revokeFamily(db, row.family_id, now);
    throw new RefreshRejectedError("session expired", row.rotated_at !== null);
  }
  const claimed = db
    .prepare(
      "UPDATE refresh_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL AND revoked_at IS NULL",
    )
    .run(nowSeconds, hash);
  // 并发竞态下的第二次旋转按重放处理，同样撤销家族。
  if (claimed.changes === 0) {
    revokeFamily(db, row.family_id, now);
    throw new RefreshRejectedError("session expired", true);
  }
  const next = issuePair();
  db.prepare(
    "INSERT INTO refresh_tokens (token_hash, family_id, account_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    tokenHash(next.refresh),
    row.family_id,
    row.account_id,
    nowSeconds + REFRESH_TTL_SECONDS,
    nowSeconds,
  );
  return { refresh: next.refresh, accountId: row.account_id, familyId: row.family_id };
}

export function revokeFamily(db: DatabaseSync, familyId: string, now = Date.now): void {
  db.prepare(
    "UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
  ).run(Math.floor(now() / 1000), familyId);
}

/** 登出：撤销 access 所属家族（access 只携带 sub，家族由签发记录反查）。 */
export function revokeFamiliesForAccount(
  db: DatabaseSync,
  accountId: string,
  now = Date.now,
): void {
  db.prepare(
    "UPDATE refresh_tokens SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL",
  ).run(Math.floor(now() / 1000), accountId);
}

export function findFamilyIdForRefresh(db: DatabaseSync, refresh: string): string | null {
  const row = db
    .prepare("SELECT family_id FROM refresh_tokens WHERE token_hash = ?")
    .get(tokenHash(refresh)) as { family_id: string } | undefined;
  return row?.family_id ?? null;
}
