import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { prepareMcpE2EAccountIsolation } from "#e2e/helpers/mcp-e2e-account-isolation";

export const MCP_DIAGNOSTIC_PYTHON = "e2e_python_dependency";
export const MCP_DIAGNOSTIC_COMMAND = "e2e_missing_command";
export const MCP_DIAGNOSTIC_NODE = "plugin:e2e-startup-diagnostics:node";

export async function prepareMcpFailureGuidanceFixture(options: {
  specs: string[];
  credentialsFile: string;
  settingsFile: string;
  workspacePath: string;
}): Promise<(() => Promise<void>) | null> {
  if (!options.specs.some((spec) => spec.endsWith("mcp-failure-guidance.test.ts"))) return null;
  // fork 适配：旧手机远控 session-events fixture 仅用于账号/网络隔离，这里换成本地隔离 stub。
  const stopRemote = await prepareMcpE2EAccountIsolation({
    credentialsFile: options.credentialsFile,
  });
  try {
    const storageRoot = dirname(dirname(options.credentialsFile));
    const cliRoot = join(storageRoot, "cli");
    const marker = join(storageRoot, "mcp-diagnostic-recovered");
    const script = resolve("test/e2e/fixtures/mcp/startup-diagnostic-server.mjs");
    const pluginRoot = join(cliRoot, "e2e-fixtures", "e2e-startup-diagnostics");
    await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        name: "e2e-startup-diagnostics",
        version: "0.0.0",
        mcpServers: {
          node: {
            type: "stdio",
            command: process.execPath,
            args: [script, "node"],
            protocolVersion: "legacy",
          },
        },
      }),
    );
    const pluginId = "e2e-startup-diagnostics@e2e-fixture";
    await mkdir(join(cliRoot, "plugins"), { recursive: true });
    await writeFile(
      join(cliRoot, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: pluginId,
            name: "e2e-startup-diagnostics",
            installPath: pluginRoot,
            marketplace: "e2e-fixture",
            scope: "user",
            version: "0.0.0",
            installedAt: "2026-10-30T00:00:00.000Z",
            updatedAt: "2026-10-30T00:00:00.000Z",
          },
        ],
      }),
    );
    const configPath = join(cliRoot, "config.json");
    const config = JSON.parse(
      await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return "{}";
      }),
    );
    config.plugins = {
      ...config.plugins,
      enabledPlugins: { ...config.plugins?.enabledPlugins, [pluginId]: true },
    };
    config.mcp = {
      ...config.mcp,
      servers: {
        ...config.mcp?.servers,
        [MCP_DIAGNOSTIC_PYTHON]: {
          type: "stdio",
          command: process.execPath,
          args: [script, "python", marker],
          protocolVersion: "legacy",
        },
        [MCP_DIAGNOSTIC_COMMAND]: {
          type: "stdio",
          command: join(cliRoot, "missing-mcp-executable"),
          protocolVersion: "legacy",
        },
      },
    };
    await writeFile(configPath, JSON.stringify(config));
    return stopRemote;
  } catch (error) {
    await stopRemote();
    throw error;
  }
}
