import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";

/**
 * fork 适配说明：上游 v3.17.2 的 MCP e2e fixture 复用旧手机远控的
 * web-remote-control-session-events-fixture 播种账号并把业务控制面指向 fake relay。
 * 本 fork 已移除旧手机远控（现行为 Relay V3 独立链路），这里提供等价的本地隔离：
 * 播种 mock 登录态（zai oauth + zcodejwttoken，官方 MCP jwt_token 授权解析为
 * Bearer mock-token），并把业务/配置请求路由到 loopback stub，避免 e2e 触达线上控制面。
 */
export async function prepareMcpE2EAccountIsolation(options: {
  credentialsFile: string;
}): Promise<() => Promise<void>> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    response.setHeader("content-type", "application/json");
    if (path.startsWith("/api/v1/client/configs")) {
      response.end(
        JSON.stringify({
          code: 0,
          data: { configs: {}, builtinModels: [], config_version: "mcp-e2e-isolation" },
        }),
      );
      return;
    }
    // 其余业务路径统一返回空成功；MCP 用例只关心本地 fixture server 上的授权头证据。
    response.end(JSON.stringify({ code: 0, msg: "", data: {} }));
  });
  const previousEnv: Record<string, string | undefined> = {};
  const cleanup = async () => {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing isolation stub address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const envPatch = {
      ZAI_BUSINESS_BASE_URL: baseUrl,
      ZCODE_BASE_URL: baseUrl,
      ZCODE_ENDPOINT_ORIGIN: baseUrl,
      ZCODE_TEST_BASE_URL: baseUrl,
    };
    for (const [key, value] of Object.entries(envPatch)) {
      previousEnv[key] = process.env[key];
      process.env[key] = value;
    }
    await writeFile(
      options.credentialsFile,
      JSON.stringify({
        "oauth:active_provider": "zai",
        "oauth:zai:access_token": "mock-token",
        "oauth:zai:user_info": JSON.stringify({
          id: "zcode-e2e-user",
          username: "ZCode E2E",
          displayName: "ZCode E2E",
        }),
        zcodejwttoken: "mock-token",
      }),
    );
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
