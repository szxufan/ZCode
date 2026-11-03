import { z } from "zod";

// Relay V3 契约（docs/relay-server/relay-v3-design.md §5）。
// 请求与 WebSocket 消息严格校验，HTTP 响应允许新增字段（与 V2 契同一约定）。
// relay 对 data.payload 只校验"合法 JSON 对象且长度在预算内"（§4.5），故上/下行
// payload 均为宽松对象；信封的严格校验由接收端在解密边界调用。

const unixSeconds = z.number().int().min(0).max(253_402_300_799);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);
const deviceSid = identifier.refine((value) => new TextEncoder().encode(value).length <= 128);
const meta = z.strictObject({
  name: z.string().optional(),
  platform: z.string().optional(),
  version: z.string().optional(),
});
const role = z.enum(["device", "terminal"]);
const pairStatus = z.enum(["waiting", "matched"]);
const errorCode = z.enum(["AUTH_FAILED", "WRONG_PARAM", "KICKED", "INTERNAL", "DEVICE_OFFLINE"]);
// E.164：+ 后 7~15 位数字（§5.1）。
const phoneE164 = z.string().regex(/^\+[1-9]\d{6,14}$/);
// base64url 无填充：32 字节公钥 → 43 字符（末字符 4 位余组）；12 字节 nonce 整除 3 → 16 个完整 6 位组。
const publicKeyBase64Url = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const nonceBase64Url = z.string().regex(/^[A-Za-z0-9_-]{16}$/);
const kidHex = z.string().regex(/^[0-9a-f]{16}$/);

export type RelayV3Role = z.infer<typeof role>;
export type RelayV3PairStatus = z.infer<typeof pairStatus>;
export type RelayV3ErrorCode = z.infer<typeof errorCode>;
export type RelayV3Meta = z.infer<typeof meta>;

/** 业务错误码（§5 前言：code 非零整数；具体取值按 V3 自身需求定义）。 */
export const RELAY_V3_BUSINESS_CODES = {
  OK: 0,
  WRONG_PARAM: 1,
  AUTH_FAILED: 2,
  NO_PERMISSION: 3,
  NOT_FOUND: 4,
  WRONG_STATE: 5,
  QUOTA_EXCEEDED: 6,
  RATE_LIMITED: 7,
  SMS_UNAVAILABLE: 8,
  EXPIRED: 9,
  LOCKED: 10,
  INTERNAL: 11,
} as const;

export const RELAY_V3_WS_PATH = "/v3/relay/ws";

export const RELAY_V3_HTTP = {
  smsCode: { method: "POST", path: "/v3/auth/sms-code" },
  login: { method: "POST", path: "/v3/auth/login" },
  refresh: { method: "POST", path: "/v3/auth/refresh" },
  logout: { method: "POST", path: "/v3/auth/logout" },
  register: { method: "POST", path: "/v3/device" },
  list: { method: "GET", path: "/v3/device" },
  delete: { method: "POST", path: "/v3/device/delete" },
  relayToken: { method: "POST", path: "/v3/relay/token" },
  deviceAuthRequest: { method: "POST", path: "/v3/device-auth/request" },
  deviceAuthApprove: { method: "POST", path: "/v3/device-auth/approve" },
  deviceAuthPoll: { method: "POST", path: "/v3/device-auth/poll" },
} as const;
export type RelayV3HttpOperation = keyof typeof RELAY_V3_HTTP;

// ---------------------------------------------------------------------------
// 密文信封（§4.5）。relay 不解析；此处供接收端解密边界严格校验。
// ---------------------------------------------------------------------------

export const RELAY_V3_ENVELOPE_VERSION = 3;
export const RELAY_V3_ENVELOPE_ALG = "x25519-hkdfsha256-aes256gcm-v1";
/** 单条 data 消息（含密文膨胀）上限 1 MiB（§4.4/§8）。 */
export const RELAY_V3_MAX_DATA_MESSAGE_BYTES = 1_048_576;
/** HTTP 侧密文单条上限（含信封，§8），超限 413。 */
export const RELAY_V3_MAX_CIPHERTEXT_BYTES = 4_194_304;

const envelope = z.strictObject({
  v: z.literal(RELAY_V3_ENVELOPE_VERSION),
  alg: z.literal(RELAY_V3_ENVELOPE_ALG),
  kid: kidHex,
  nonce: nonceBase64Url,
  ct: z.string().regex(/^[A-Za-z0-9_-]+$/),
});
export type RelayV3Envelope = z.infer<typeof envelope>;

export function parseRelayV3Envelope(value: unknown): RelayV3Envelope | null {
  const result = envelope.safeParse(value);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// WebSocket 消息（§5.2）
// ---------------------------------------------------------------------------

// auth_init：两角色都携带目标 device_sid（配对按 (SID, role) 路由，§5.2）；
// device 侧可选 meta，terminal 侧必填 terminal_public_key（§4.2）。
const authInitDevice = z.strictObject({
  type: z.literal("auth_init"),
  device_sid: deviceSid,
  meta: meta.optional(),
  client_ts: unixSeconds.optional(),
});
const authInitTerminal = z.strictObject({
  type: z.literal("auth_init"),
  device_sid: deviceSid,
  terminal_public_key: publicKeyBase64Url,
  client_ts: unixSeconds.optional(),
});
const pairStatusQuery = z.strictObject({
  type: z.literal("pair_status_query"),
  client_ts: unixSeconds.optional(),
});
const outgoingData = z.strictObject({
  type: z.literal("data"),
  payload: z.record(z.string(), z.unknown()),
  client_ts: unixSeconds.optional(),
});
const outgoingMessage = z.union([authInitDevice, authInitTerminal, pairStatusQuery, outgoingData]);
export type RelayV3AuthInitDevice = z.infer<typeof authInitDevice>;
export type RelayV3AuthInitTerminal = z.infer<typeof authInitTerminal>;
export type RelayV3AuthInit = RelayV3AuthInitDevice | RelayV3AuthInitTerminal;
export type RelayV3PairStatusQuery = z.infer<typeof pairStatusQuery>;
export type RelayV3OutgoingData = z.infer<typeof outgoingData>;
export type RelayV3OutgoingMessage = z.infer<typeof outgoingMessage>;

export function parseRelayV3OutgoingMessage(value: unknown): RelayV3OutgoingMessage | null {
  const result = outgoingMessage.safeParse(value);
  return result.success ? result.data : null;
}

const authAck = z.strictObject({
  type: z.literal("auth_ack"),
  device_sid: deviceSid,
  terminal_sid: z.string(),
  pair_status: pairStatus,
  server_ts: unixSeconds.optional(),
});
const pairStatusAck = z.strictObject({
  type: z.literal("pair_status_ack"),
  terminal_sid: z.string(),
  pair_status: pairStatus,
  // matched 且接收方为 device 时由 relay 从 terminal 的 auth_init 透传（§4.2：
  // 桌面从 terminal 的 auth_init 取得 terminal 公钥；公钥本就明文可见）。
  terminal_public_key: publicKeyBase64Url.optional(),
  server_ts: unixSeconds.optional(),
});
const incomingData = z.strictObject({
  type: z.literal("data"),
  payload: z.record(z.string(), z.unknown()),
  server_ts: unixSeconds.optional(),
});
const relayError = z.strictObject({
  type: z.literal("error"),
  code: errorCode,
  message: z.string().optional(),
  server_ts: unixSeconds.optional(),
});
const incomingMessage = z.discriminatedUnion("type", [
  authAck,
  pairStatusAck,
  incomingData,
  relayError,
]);
export type RelayV3AuthAck = z.infer<typeof authAck>;
export type RelayV3PairStatusAck = z.infer<typeof pairStatusAck>;
export type RelayV3IncomingData = z.infer<typeof incomingData>;
export type RelayV3Error = z.infer<typeof relayError>;
export type RelayV3IncomingMessage = z.infer<typeof incomingMessage>;

export function parseRelayV3IncomingMessage(value: unknown): RelayV3IncomingMessage | null {
  const result = incomingMessage.safeParse(value);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// HTTP 请求/响应（§5.1）
// ---------------------------------------------------------------------------

const account = z.object({
  id: z.string().min(1),
  phone_masked: z.string().min(1),
});
export type RelayV3Account = z.infer<typeof account>;

const device = z.object({
  device_sid: deviceSid,
  device_mid: identifier,
  public_key: publicKeyBase64Url,
  online: z.boolean(),
  created_at: unixSeconds,
  meta: z.object(meta.shape),
});
export type RelayV3Device = z.infer<typeof device>;

const tokenPair = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1),
});
const relayToken = z.object({
  // 16 字节无填充 Base64URL 的末字符只能使用高两位。
  token: z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/),
  expires_in: z.number().int().positive(),
});
const httpError = z.object({
  code: z
    .number()
    .int()
    .refine((value) => value !== 0),
  msg: z.string(),
  data: z.null().optional(),
});
function response<T extends z.ZodType>(data: T) {
  return z.union([z.object({ code: z.literal(0), msg: z.string(), data }), httpError]);
}

const deviceAuthRequestData = z.object({
  user_code: z.string().regex(/^\d{8}$/),
  device_code: z.string().min(16).max(128),
  expires_in: z.number().int().positive(),
});

const httpRequests = {
  smsCode: z.strictObject({ phone: phoneE164 }),
  login: z
    .strictObject({ phone: phoneE164, code: z.string().regex(/^\d{6}$/) })
    .or(z.strictObject({ phone: phoneE164, password: z.string().min(1).max(256) })),
  refresh: z.strictObject({ refresh: z.string().min(1).max(256) }),
  logout: z.strictObject({}),
  register: z.strictObject({ device_mid: identifier, public_key: publicKeyBase64Url }),
  list: z.strictObject({}),
  delete: z.strictObject({ device_sid: identifier }),
  relayToken: z.strictObject({ role }),
  deviceAuthRequest: z.strictObject({ public_key: publicKeyBase64Url }),
  deviceAuthApprove: z.strictObject({ user_code: z.string().regex(/^\d{8}$/) }),
  deviceAuthPoll: z.strictObject({ device_code: z.string().min(16).max(128) }),
};
const httpResponses = {
  smsCode: response(z.null()),
  login: response(tokenPair.extend({ account })),
  refresh: response(tokenPair),
  logout: response(z.null()),
  register: response(device),
  list: response(z.array(device)),
  delete: response(z.null()),
  relayToken: response(relayToken),
  deviceAuthRequest: response(deviceAuthRequestData),
  deviceAuthApprove: response(z.object({ device })),
  deviceAuthPoll: response(
    z.union([z.object({ status: z.literal("pending") }), tokenPair.extend({ device })]),
  ),
};
export type RelayV3Token = z.infer<typeof relayToken>;
export type RelayV3HttpError = z.infer<typeof httpError>;
export type RelayV3DeviceAuthRequestData = z.infer<typeof deviceAuthRequestData>;
export type RelayV3HttpRequest<K extends RelayV3HttpOperation> = z.infer<(typeof httpRequests)[K]>;
export type RelayV3HttpResponse<K extends RelayV3HttpOperation> = z.infer<
  (typeof httpResponses)[K]
>;

const requestSchemas: { [K in RelayV3HttpOperation]: z.ZodType<RelayV3HttpRequest<K>> } =
  httpRequests;
const responseSchemas: { [K in RelayV3HttpOperation]: z.ZodType<RelayV3HttpResponse<K>> } =
  httpResponses;

export function parseRelayV3HttpRequest<K extends RelayV3HttpOperation>(
  operation: K,
  value: unknown,
): RelayV3HttpRequest<K> | null {
  const schema: z.ZodType<RelayV3HttpRequest<K>> = requestSchemas[operation];
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseRelayV3HttpResponse<K extends RelayV3HttpOperation>(
  operation: K,
  value: unknown,
): RelayV3HttpResponse<K> | null {
  const schema: z.ZodType<RelayV3HttpResponse<K>> = responseSchemas[operation];
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/** HTTP 错误只保留分类，避免 token、手机号或服务端正文进入日志与 renderer。 */
export class RelayV3ConnectionError extends Error {
  constructor(
    readonly reason: "auth-required" | "relay-unavailable",
    readonly retryable = false,
  ) {
    super(reason);
    this.name = "RelayV3ConnectionError";
  }
}
