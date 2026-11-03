import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// §3.2 验证码：6 位数字、5 分钟有效、单次使用；存储为加盐哈希，比较用常数时间。

const CODE_TTL_MS = 5 * 60_000;
const MAX_CODE_ATTEMPTS = 5;

export function generateSmsCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function digestCode(phone: string, code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${phone}:${code}`).digest("hex");
}

export function storeSmsCode(
  db: DatabaseSync,
  input: { phone: string; requestIp: string },
  now = Date.now,
): string {
  const code = generateSmsCode();
  const salt = randomBytes(16).toString("hex");
  const nowSeconds = Math.floor(now() / 1000);
  // 每号一条活跃验证码：新码覆盖旧码并重置尝试计数（upsert）。
  db.prepare(
    `INSERT INTO sms_codes (phone, code_hash, code_salt, purpose, attempts, expires_at, used, request_ip, created_at)
     VALUES (?, ?, ?, 'login', 0, ?, 0, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       code_hash = excluded.code_hash,
       code_salt = excluded.code_salt,
       attempts = 0,
       expires_at = excluded.expires_at,
       used = 0,
       request_ip = excluded.request_ip,
       created_at = excluded.created_at`,
  ).run(
    input.phone,
    digestCode(input.phone, code, salt),
    salt,
    nowSeconds + Math.floor(CODE_TTL_MS / 1000),
    input.requestIp,
    nowSeconds,
  );
  return code;
}

export type SmsCodeCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "expired" | "used" | "mismatch" | "attempts" };

export function checkSmsCode(
  db: DatabaseSync,
  phone: string,
  code: string,
  now = Date.now,
): SmsCodeCheck {
  const row = db.prepare("SELECT * FROM sms_codes WHERE phone = ?").get(phone) as
    | {
        code_hash: string;
        code_salt: string;
        attempts: number;
        expires_at: number;
        used: number;
      }
    | undefined;
  if (!row) return { ok: false, reason: "missing" };
  const fail = (reason: SmsCodeCheck & { ok: false }) => {
    db.prepare("UPDATE sms_codes SET attempts = attempts + 1 WHERE phone = ?").run(phone);
    return reason;
  };
  if (row.used) return { ok: false, reason: "used" };
  if (row.expires_at <= Math.floor(now() / 1000)) return { ok: false, reason: "expired" };
  if (row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: "attempts" };
  const provided = Buffer.from(digestCode(phone, code, row.code_salt), "hex");
  const expected = Buffer.from(row.code_hash, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return fail({ ok: false, reason: "mismatch" });
  }
  db.prepare("UPDATE sms_codes SET used = 1 WHERE phone = ?").run(phone);
  return { ok: true };
}
