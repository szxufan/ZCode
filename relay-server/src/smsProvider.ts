import { createHash, createHmac, randomUUID } from "node:crypto";

import type { RelayAliyunSmsConfig } from "./config.js";

// §3.2 短信验证码发送通道。Aliyun Dysmsapi ACS3-HMAC-SHA256 签名（与
// OpenBitFun sms.rs 同构）。test provider 不真正外发，验证码仅进入测试接缝；
// 生产构建禁用（config.ts fail closed），验证码不写日志。

export interface RelaySmsTransport {
  send(phone: string, code: string): Promise<void>;
}

/** 测试接缝：记录最近发送的验证码，供一致性矩阵与真实 relay 测试取用。 */
export class RecordingSmsTransport {
  readonly outbox = new Map<string, string>();
  async send(phone: string, code: string): Promise<void> {
    this.outbox.set(phone, code);
  }
}

function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replaceAll("+", "%20")
    .replaceAll("*", "%2A")
    .replaceAll("%7E", "~");
}

export class AliyunSmsTransport implements RelaySmsTransport {
  constructor(private readonly config: RelayAliyunSmsConfig) {}

  async send(phone: string, code: string): Promise<void> {
    const { accessKeyId, accessKeySecret, signName, templateCode, endpoint } = this.config;
    // 业务参数按 key 排序、RFC3986 编码拼 query；空 POST body。
    const businessParams: Record<string, string> = {
      PhoneNumbers: phone,
      SignName: signName,
      TemplateCode: templateCode,
      TemplateParam: JSON.stringify({ code }),
    };
    const sortedQuery = Object.keys(businessParams)
      .sort()
      .map((key) => `${percentEncode(key)}=${percentEncode(businessParams[key]!)}`)
      .join("&");
    const url = new URL(endpoint);
    const now = new Date();
    const headers: Record<string, string> = {
      host: url.host,
      "x-acs-action": "SendSms",
      "x-acs-content-sha256": createHash("sha256").update("").digest("hex"),
      "x-acs-date": now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      "x-acs-signature-nonce": randomUUID(),
      "x-acs-version": "2017-05-25",
    };
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((key) => `${key}:${headers[key]}\n`)
      .join("");
    const canonicalRequest = [
      "POST",
      "/",
      sortedQuery,
      canonicalHeaders,
      signedHeaders,
      headers["x-acs-content-sha256"]!,
    ].join("\n");
    const stringToSign = `ACS3-HMAC-SHA256\n${createHash("sha256")
      .update(canonicalRequest)
      .digest("hex")}`;
    const signature = createHmac("sha256", accessKeySecret).update(stringToSign).digest("hex");
    const authorization = `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
    const response = await fetch(`${endpoint}?${sortedQuery}`, {
      method: "POST",
      headers: { ...headers, Authorization: authorization },
      // 禁重定向；超时防止通道故障拖垮请求（对齐 OpenBitFun 3s/10s 预算）。
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as { Code?: string } | null;
    if (!response.ok || !body || body.Code !== "OK") {
      throw new Error(`aliyun sms send failed: ${body?.Code ?? response.status}`);
    }
  }
}
