import {
  parseRelayV3HttpResponse,
  RELAY_V3_HTTP,
  RelayV3ConnectionError,
  type RelayV3HttpOperation,
  type RelayV3HttpRequest,
  type RelayV3HttpResponse,
} from "./contract.js";

// Relay V3 HTTP 客户端（§5.1）。两端共用；fetch 可注入（Node / 浏览器 / 测试）。
// 取消兼容沿用 V2 语义：不依赖 AbortSignal.any()/timeout()/throwIfAborted()，
// 用自有 AbortController + 定时器组合调用方取消与 15s 期限；期限覆盖 fetch 与
// 完整正文读取，收到响应头不提前释放；finally 清理定时器与监听。

export const RELAY_V3_HTTP_TIMEOUT_MS = 15_000;

/** 业务信封错误（code 非零）：登录 UX 需要区分 RATE_LIMITED / SMS_UNAVAILABLE 等。 */
export class RelayV3BusinessError extends Error {
  constructor(
    readonly code: number,
    readonly msg: string,
    readonly httpStatus: number,
  ) {
    super(`relay business error ${code}`);
    this.name = "RelayV3BusinessError";
  }
}

export interface RelayV3HttpClientOptions {
  /** relay origin，如 `https://relay.example.com`（不带尾斜杠）。 */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface RelayV3RequestOptions {
  bearer?: string;
  signal?: AbortSignal;
}

type Json = Record<string, unknown>;

/** 成功信封（code=0）分支的 data 类型（从成功/失败联合中提取成功分支）。 */
export type RelayV3ResponseData<K extends RelayV3HttpOperation> =
  Extract<RelayV3HttpResponse<K>, { code: 0 }> extends { data: infer T } ? T : never;

export class RelayV3HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: RelayV3HttpClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? RELAY_V3_HTTP_TIMEOUT_MS;
  }

  /**
   * 执行一次 V3 HTTP 操作。成功返回解析后的 data；
   * 业务 code 非零（含 4xx/5xx 信封）抛 `RelayV3BusinessError`；网络失败/超时/
   * HTTP 401/无业务信封的 4xx/5xx/非法正文抛 `RelayV3ConnectionError`。
   */
  async request<K extends RelayV3HttpOperation>(
    operation: K,
    requestOptions: RelayV3RequestOptions = {},
    body?: RelayV3HttpRequest<K>,
  ): Promise<RelayV3ResponseData<K>> {
    const spec = RELAY_V3_HTTP[operation];
    const requestBody = normalizeRequestPhone(body);
    const url = `${this.options.baseUrl}${spec.path}`;
    if (requestOptions.signal?.aborted) {
      throw new RelayV3ConnectionError("relay-unavailable", false);
    }
    // 请求作用域 AbortController：调用方取消与期限共用同一信号（V2 兼容语义）。
    const controller = new AbortController();
    const cancel = () => controller.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelledByDeadline = false;
    try {
      if (requestOptions.signal)
        requestOptions.signal.addEventListener("abort", cancel, { once: true });
      timeout = setTimeout(() => {
        cancelledByDeadline = true;
        controller.abort();
      }, this.timeoutMs);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (requestOptions.bearer) headers.authorization = `Bearer ${requestOptions.bearer}`;
      const hasBody = spec.method !== "GET" && requestBody !== undefined;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: spec.method,
          headers,
          ...(hasBody ? { body: JSON.stringify(requestBody satisfies Json) } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        if (requestOptions.signal?.aborted) {
          // 调用方取消：不可重试的本地终止，不冒充网络故障分类。
          throw new RelayV3ConnectionError("relay-unavailable", false);
        }
        if (cancelledByDeadline) {
          throw new RelayV3ConnectionError("relay-unavailable", true);
        }
        throw error instanceof RelayV3ConnectionError
          ? error
          : new RelayV3ConnectionError("relay-unavailable", true);
      }
      // 期限覆盖完整正文读取；提前拒绝时也要终止未读正文。
      let text: string;
      try {
        text = await response.text();
      } catch {
        if (requestOptions.signal?.aborted) {
          throw new RelayV3ConnectionError("relay-unavailable", false);
        }
        throw new RelayV3ConnectionError("relay-unavailable", cancelledByDeadline);
      }
      if (response.status === 401) {
        throw new RelayV3ConnectionError("auth-required", false);
      }
      const envelope = parseEnvelope(text);
      if (response.status >= 400) {
        // 5xx 也可能携带明确业务错误（如短信发送失败）；有信封则透传业务码，
        // 无信封时才按连接故障分类，避免把运营商问题误报为 relay-unavailable。
        if (envelope && typeof envelope.code === "number" && envelope.code !== 0) {
          throw new RelayV3BusinessError(envelope.code, envelope.msg ?? "", response.status);
        }
        throw new RelayV3ConnectionError("relay-unavailable", response.status >= 500);
      }
      if (!envelope) {
        throw new RelayV3ConnectionError("relay-unavailable", true);
      }
      if (envelope.code !== 0) {
        throw new RelayV3BusinessError(envelope.code, envelope.msg ?? "", response.status);
      }
      const parsed = parseRelayV3HttpResponse(operation, envelope);
      if (!parsed || parsed.code !== 0) {
        throw new RelayV3ConnectionError("relay-unavailable", true);
      }
      // envelope.code === 0 已保证 parsed 是成功分支；类型系统无法跨泛型收窄，此处断言。
      return parsed.data as RelayV3ResponseData<K>;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      requestOptions.signal?.removeEventListener("abort", cancel);
    }
  }
}

function normalizeRequestPhone<T>(body: T): T {
  if (typeof body !== "object" || body === null || !("phone" in body)) return body;
  const phone = body.phone;
  if (typeof phone !== "string") return body;
  const trimmed = phone.trim();
  // 两端共用唯一归一化点；发送验证码与登录必须使用同一个 E.164 账号键。
  const normalized = /^1\d{10}$/.test(trimmed) ? `+86${trimmed}` : trimmed;
  return normalized === phone ? body : ({ ...body, phone: normalized } as T);
}

function parseEnvelope(text: string): { code: number; msg?: string; data?: unknown } | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.code !== "number") return null;
    return {
      code: record.code,
      msg: typeof record.msg === "string" ? record.msg : undefined,
      data: record.data,
    };
  } catch {
    return null;
  }
}
