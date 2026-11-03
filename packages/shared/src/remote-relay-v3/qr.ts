// 二维码与页面入口（§5.3）：参数集 sid/mid/name/app_version 均为可选路由提示，
// base URL 指向 relay 自带静态页面（§5.4）。从 contract.ts 拆出以满足契约
// max-contract-lines 上限；导出经 index.ts 汇聚。

const QR_ALLOWED_PARAMS = ["sid", "mid", "name", "app_version"] as const;
export interface RelayV3QrPayload {
  baseUrl: string;
  sid?: string;
  mid?: string;
  name?: string;
  app_version?: string;
}

/**
 * 解析 V3 二维码链接：仅放行路由提示参数，拒绝未知参数与带凭据的链接。
 * 带 userinfo、fragment 或凭据型 query 的 URL 一律返回 null。
 */
export function parseRelayV3QrUrl(value: string): RelayV3QrPayload | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.hash) return null;
  const payload: RelayV3QrPayload = { baseUrl: `${url.protocol}//${url.host}` };
  for (const [key, entry] of url.searchParams) {
    if (!(QR_ALLOWED_PARAMS as readonly string[]).includes(key)) return null;
    if (entry === "") return null;
    if (key === "sid") payload.sid = entry;
    else if (key === "mid") payload.mid = entry;
    else if (key === "name") payload.name = entry;
    else if (key === "app_version") payload.app_version = entry;
  }
  return payload;
}

/** 构造 V3 二维码链接（base URL 指向 relay 自带静态页面，§5.4）。 */
export function buildRelayV3QrUrl(
  baseUrl: string,
  params: Omit<RelayV3QrPayload, "baseUrl"> = {},
): string {
  const url = new URL(baseUrl);
  for (const key of QR_ALLOWED_PARAMS) {
    const value = params[key];
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
