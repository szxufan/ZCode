import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// §3.3 access token：JWT（HS256，10 分钟，claims 仅 sub/exp/iat/jti）。
// 单实例 HS256 + 环境变量密钥；多实例升级路径见 §10 开放问题。

const ACCESS_TTL_SECONDS = 600;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export interface RelayJwtClaims {
  sub: string;
  exp: number;
  iat: number;
  jti: string;
}

export function signRelayAccessToken(secret: string, accountId: string, now = Date.now): string {
  const issuedAt = Math.floor(now() / 1000);
  const claims: RelayJwtClaims = {
    sub: accountId,
    exp: issuedAt + ACCESS_TTL_SECONDS,
    iat: issuedAt,
    jti: randomUUID(),
  };
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** 校验签名与过期；alg 不符或签名不匹配返回 null（不区分原因，防时序侧信道信息）。 */
export function verifyRelayAccessToken(
  secret: string,
  token: string,
  now = Date.now,
): RelayJwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  let headerJson: { alg?: string };
  let claims: RelayJwtClaims;
  try {
    headerJson = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg?: string };
    claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as RelayJwtClaims;
  } catch {
    return null;
  }
  if (headerJson.alg !== "HS256") return null;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(now() / 1000)) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  return claims;
}
