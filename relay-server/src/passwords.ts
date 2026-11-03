import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// 密码登录（§3.1）：可后置设置密码作为短信不可用时的登录方式。
// scrypt 加盐哈希；校验使用常数时间比较。

export function hashRelayPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function verifyRelayPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, saltPart, hashPart] = stored.split("$");
  if (scheme !== "scrypt" || !saltPart || !hashPart) return false;
  const salt = Buffer.from(saltPart, "base64url");
  const expected = Buffer.from(hashPart, "base64url");
  const derived = scryptSync(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
