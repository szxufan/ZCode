import {
  buildZCodeEndpointUrls,
  buildZCodeSourceHeadersFromContext,
  ZCODE_ENV,
  DISABLED_RENDERER_ACTION_TRACE_CONFIG,
  rendererActionTraceConfigSchema,
  rendererActionTraceGroupSchema,
  type RendererActionTraceConfigV1,
} from "@zcode/shared";
import {
  createSingleFeatureRollout,
  type SingleFeatureRollout,
  type SingleFeatureRolloutLogger,
} from "./singleFeatureRollout.js";

export type RendererActionTraceRollout = SingleFeatureRollout<RendererActionTraceConfigV1>;

export function resolveRendererActionTraceConfig(
  payload: unknown,
): RendererActionTraceConfigV1 | null {
  if (typeof payload !== "object" || payload === null) return null;
  const envelope = payload as {
    code?: unknown;
    success?: unknown;
    data?: {
      configs?: {
        rendererActionTrace?: {
          enabled?: unknown;
          localTtftEnabled?: unknown;
          sample_ratio?: unknown;
          sampleRatio?: unknown;
          enabled_groups?: unknown;
          enabledGroups?: unknown;
          config_version?: unknown;
          configVersion?: unknown;
        } | null;
      } | null;
    } | null;
  };
  if ((envelope.code !== undefined && envelope.code !== 0) || envelope.success === false) {
    return null;
  }
  const config = envelope.data?.configs?.rendererActionTrace;
  if (config === undefined || config === null) {
    return { ...DISABLED_RENDERER_ACTION_TRACE_CONFIG };
  }
  const enabledGroupsInput = config.enabled_groups ?? config.enabledGroups;
  const enabledGroups = Array.isArray(enabledGroupsInput)
    ? enabledGroupsInput.flatMap((value) => {
        const parsed = rendererActionTraceGroupSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
    : enabledGroupsInput;
  const candidate = {
    enabled: config.enabled,
    ...(config.localTtftEnabled !== undefined ? { localTtftEnabled: config.localTtftEnabled } : {}),
    sampleRatio: config.sample_ratio ?? config.sampleRatio,
    enabledGroups,
    configVersion: config.config_version ?? config.configVersion,
  };
  const parsed = rendererActionTraceConfigSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function createRendererActionTraceRollout(options: {
  fetchConfig: (signal: AbortSignal) => Promise<unknown>;
  logger: SingleFeatureRolloutLogger;
  timeoutMs?: number;
  cacheTtlMs?: number;
}): RendererActionTraceRollout {
  return createSingleFeatureRollout<RendererActionTraceConfigV1>({
    resolveConfig: resolveRendererActionTraceConfig,
    defaultValue: { ...DISABLED_RENDERER_ACTION_TRACE_CONFIG },
    logTag: "renderer-action-trace",
    fetchConfig: options.fetchConfig,
    logger: options.logger,
    timeoutMs: options.timeoutMs,
    cacheTtlMs: options.cacheTtlMs,
  });
}

const CLIENT_CONFIGS_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * /api/v1/client/configs 的 Electron net fetcher。
 * 修复说明：desktopContextPrompt 灰度已移除，本 fetcher 从 desktopContextPromptRollout.ts
 * 迁来（改名）继续服务 rendererActionTrace 灰度，请求参数与鉴权保持不变。
 */
export function createElectronClientConfigsFetcher(options: {
  appVersion: string;
  deviceMid: string;
  resolveEndpointOrigin: () => Promise<string>;
  /** 当前界面语言；以前不传，X-Client-Language 固定为 unknown。 */
  getClientLanguage: () => string;
}): (signal: AbortSignal) => Promise<unknown> {
  return async (signal) => {
    const { net } = await import("electron");
    const endpointOrigin = await options.resolveEndpointOrigin();
    const url = new URL(`${buildZCodeEndpointUrls(endpointOrigin).origin}/api/v1/client/configs`);
    url.searchParams.set("app_version", options.appVersion);
    url.searchParams.set("platform", `${process.platform}-${process.arch}`);

    return await new Promise<unknown>((resolve, reject) => {
      const request = net.request(url.toString());
      let responseBytes = 0;
      let body = "";
      let settled = false;

      function onAbort() {
        request.abort();
        settle(() => reject(new Error("client configs fetch aborted")));
      }

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const sourceHeaders = buildZCodeSourceHeadersFromContext({
        appVersion: options.appVersion,
        arch: process.arch,
        clientLanguage: options.getClientLanguage(),
        deviceMid: options.deviceMid,
        endpointOrigin,
        platform: process.platform,
        releaseChannel: ZCODE_ENV,
        sourceTitle: "electron",
      });
      for (const [name, value] of Object.entries(sourceHeaders)) {
        request.setHeader(name, value);
      }
      request.on("response", (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          settle(() => reject(new Error(`client configs fetch failed: ${statusCode}`)));
          request.abort();
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > CLIENT_CONFIGS_MAX_RESPONSE_BYTES) {
            settle(() => reject(new Error("client configs response too large")));
            request.abort();
            return;
          }
          body += chunk.toString();
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            settle(() => resolve(parsed));
          } catch (error) {
            settle(() => reject(error instanceof Error ? error : new Error(String(error))));
          }
        });
        response.on("error", (error) => {
          settle(() => reject(error instanceof Error ? error : new Error(String(error))));
        });
      });
      request.on("error", (error) => {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      });
      request.end();
    });
  };
}
