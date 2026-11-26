import { fetchOpenAIModelDiscovery, type OpenAIModelDiscoveryResult } from "@zcode/provider-node";
import type { ApiClient } from "@zcode/shared";
import { isApiKeyAccess, type ProviderConfigObject } from "@zcode/provider";

/** Services 仅注入既有网络装配；URL、Schema 与逐条校验由 provider-node 唯一实现。 */
export interface ProviderModelDiscoveryClientInput {
  readonly providerConfig: ProviderConfigObject;
  readonly signal?: AbortSignal;
}

export type ProviderModelDiscoveryClient = (
  input: ProviderModelDiscoveryClientInput,
) => Promise<OpenAIModelDiscoveryResult>;

export function createOpenAIModelDiscoveryClient(options: {
  apiClient: ApiClient;
}): ProviderModelDiscoveryClient {
  return async (input) => {
    const config = input.providerConfig;
    if (!isApiKeyAccess(config.access)) {
      throw new Error("模型拉取仅支持 API Key 供应商");
    }
    const apiKey = config.access.apiKey?.trim();
    if (!apiKey) throw new Error("API Key 未保存，请先保存连接信息");
    if (config.api?.type !== "openai-chat-completions") {
      throw new Error("模型拉取仅支持 OpenAI Chat Completions 供应商");
    }
    const baseUrl = config.api.baseUrl?.trim();
    if (!baseUrl) throw new Error("Base URL 未配置");
    return fetchOpenAIModelDiscovery({
      baseUrl,
      apiKey,
      ...(config.api.headers ? { headers: config.api.headers } : {}),
      request: (url, init) =>
        options.apiClient.request(url, { ...init, authFailurePolicy: "caller-handled" }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  };
}
