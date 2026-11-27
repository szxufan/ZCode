// 二维码与页面入口（§5.3）：参数集 sid/mid/name/app_version 均为可选路由提示，
// base URL 指向 relay 自带静态页面（§5.4）。从 contract.ts 拆出以满足契约
// max-contract-lines 上限；导出经 index.ts 汇聚。

import { relayV3DeviceFingerprint } from "./crypto.js";

const QR_ALLOWED_PARAMS = ["sid", "mid", "name", "app_version", "fingerprint"] as const;
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;
export interface RelayV3QrPayload {
  baseUrl: string;
  sid?: string;
  mid?: string;
  name?: string;
  app_version?: string;
  fingerprint?: string;
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
    else if (key === "fingerprint") {
      if (!FINGERPRINT_PATTERN.test(entry)) return null;
      payload.fingerprint = entry;
    }
  }
  return payload;
}

export type RelayV3QrTrustResult =
  | { ok: true; fingerprint: string }
  | {
      ok: false;
      reason: "missing-fingerprint" | "invalid-public-key" | "key-mismatch";
      expected?: string;
      actual?: string;
    };

/**
 * 用二维码带外指纹验证 relay 目录公钥。缺少指纹或比对失败都必须拒绝连接：
 * 仅展示从 relay 取回的指纹无法防御目录替换公钥的中间人。
 */
export function verifyRelayV3QrFingerprint(
  expected: string | undefined,
  publicKeyB64: string,
): RelayV3QrTrustResult {
  if (!expected || !FINGERPRINT_PATTERN.test(expected)) {
    return { ok: false, reason: "missing-fingerprint" };
  }
  const actual = relayV3DeviceFingerprint(publicKeyB64);
  if (!actual) return { ok: false, reason: "invalid-public-key" };
  if (actual !== expected.toLowerCase()) {
    return { ok: false, reason: "key-mismatch", expected, actual };
  }
  return { ok: true, fingerprint: actual };
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
