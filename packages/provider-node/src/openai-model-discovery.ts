import { z } from "zod";
import type { ModelConfigObject } from "@zcode/provider";

/**
 * OpenAI-compatible `/models` 响应的宽松 Schema。
 * 连接派（New API）实际返回 `{success, object:"list", data:[...]}`（2026-11-26 实测）；
 * 标准 OpenAI 兼容服务返回 `{object:"list", data:[...]}`。两种 envelope 都接受。
 * 每条模型记录只校验确认存在的字段；未知字段原样忽略，不猜能力。
 */
const modelEntrySchema = z
  .object({
    id: z.string().min(1),
    // supported_endpoint_types: 连接派返回的端点类型数组；标准 OpenAI 可能省略。
    supported_endpoint_types: z.array(z.string()).optional(),
    // 以下字段仅当接口明确声明时才写入候选，缺失/null 保持未覆盖。
    context_length: z.number().positive().int().nullish(),
    max_output_tokens: z.number().positive().int().nullish(),
    support_image_input: z.boolean().nullish(),
    support_video_input: z.boolean().nullish(),
  })
  .passthrough();

const modelsEnvelopeSchema = z
  .object({
    data: z.array(z.unknown()),
    object: z.string().optional(),
    success: z.boolean().optional(),
  })
  .passthrough();

export interface OpenAIModelCandidate {
  readonly modelId: string;
  readonly config: ModelConfigObject;
  /** supported_endpoint_types 存在且不含 "openai" 时为 false（rerank/tts/embedding 等非对话模型）。 */
  readonly chatCapable: boolean;
}

export interface OpenAIModelDiscoveryResult {
  readonly candidates: readonly OpenAIModelCandidate[];
  readonly invalidCount: number;
}

export interface FetchOpenAIModelDiscoveryOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** 静态 provider headers（如自定义 Authorization 以外的 Header），在 Bearer 之后覆盖同名 Header。 */
  readonly headers?: Readonly<Record<string, string>>;
  readonly request: (url: string | URL, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
}

const MAX_BODY_BYTES = 10_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export class OpenAIModelDiscoveryError extends Error {}

/** 把 Effective Provider 的 baseUrl 转成 models URL，保留 /v1 等路径并处理尾部斜杠。 */
export function resolveOpenAIModelsUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  if (!trimmed) throw new OpenAIModelDiscoveryError("base URL is empty");
  let url: URL;
  try {
    url = new URL(`${trimmed}/models`);
  } catch {
    throw new OpenAIModelDiscoveryError("base URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OpenAIModelDiscoveryError("base URL must use http or https");
  }
  if (url.username || url.password) {
    throw new OpenAIModelDiscoveryError("base URL must not embed credentials");
  }
  return url;
}

/**
 * GET <baseUrl>/models 并逐条校验。网络/envelope 错误抛出 OpenAIModelDiscoveryError；
 * 单条非法记录跳过并计入 invalidCount。错误消息不携带 Key、Authorization 或响应正文。
 */
export async function fetchOpenAIModelDiscovery(
  options: FetchOpenAIModelDiscoveryOptions,
): Promise<OpenAIModelDiscoveryResult> {
  const url = resolveOpenAIModelsUrl(options.baseUrl);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  try {
    signal.throwIfAborted();
    // Bearer 在前，静态 headers 在后覆盖同名 Header，与正式 chat/completions 请求保持一致。
    const headers = new Headers({ Authorization: `Bearer ${options.apiKey}` });
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        headers.set(key, value);
      }
    }
    const response = await abortable(
      options.request(url, {
        method: "GET",
        signal,
        credentials: "omit",
        redirect: "error",
        headers,
      }),
      signal,
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new OpenAIModelDiscoveryError(`HTTP ${response.status}`);
    }
    const payload = await readJsonBody(response, signal);
    const envelope = modelsEnvelopeSchema.safeParse(payload);
    if (!envelope.success || !Array.isArray(envelope.data.data)) {
      throw new OpenAIModelDiscoveryError("invalid response envelope");
    }
    const candidates: OpenAIModelCandidate[] = [];
    const seen = new Set<string>();
    let invalidCount = 0;
    for (const entry of envelope.data.data) {
      const parsed = modelEntrySchema.safeParse(entry);
      if (!parsed.success) {
        invalidCount += 1;
        continue;
      }
      const {
        id,
        supported_endpoint_types,
        context_length,
        max_output_tokens,
        support_image_input,
        support_video_input,
      } = parsed.data;
      // 重复 ID 保留第一次出现。
      if (seen.has(id)) continue;
      seen.add(id);
      const chatCapable =
        supported_endpoint_types === undefined ||
        supported_endpoint_types.length === 0 ||
        supported_endpoint_types.includes("openai");
      const properties: ModelConfigObject["properties"] = {};
      if (context_length != null) properties.contextWindow = context_length;
      const inputFormat: Record<string, boolean> = {};
      if (support_image_input != null) inputFormat.supportsImage = support_image_input;
      if (support_video_input != null) inputFormat.supportsVideo = support_video_input;
      if (Object.keys(inputFormat).length > 0) properties.inputFormat = inputFormat;
      const optionSpecs: ModelConfigObject["optionSpecs"] = {};
      if (max_output_tokens != null) {
        optionSpecs.maxOutputTokens = { max: max_output_tokens };
      }
      candidates.push({
        modelId: id,
        config: {
          ...(Object.keys(properties).length > 0 ? { properties } : {}),
          ...(Object.keys(optionSpecs).length > 0 ? { optionSpecs } : {}),
        },
        chatCapable,
      });
    }
    return Object.freeze({ candidates: Object.freeze(candidates), invalidCount });
  } catch (error) {
    if (error instanceof OpenAIModelDiscoveryError) throw error;
    const reason = signal.aborted
      ? timedOut
        ? "timeout"
        : "cancelled"
      : error instanceof SyntaxError
        ? "invalid JSON"
        : "request failed";
    throw new OpenAIModelDiscoveryError(reason);
  } finally {
    clearTimeout(timer);
  }

  async function readJsonBody(response: Response, abortSignal: AbortSignal): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new OpenAIModelDiscoveryError("empty body");
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await abortable(reader.read(), abortSignal);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BODY_BYTES) throw new OpenAIModelDiscoveryError("body limit exceeded");
        chunks.push(decoder.decode(part.value, { stream: true }));
      }
      chunks.push(decoder.decode());
      abortSignal.throwIfAborted();
      return JSON.parse(chunks.join("")) as unknown;
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
