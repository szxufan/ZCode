import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const entryPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForStartupLog(
  child: ChildProcess,
  expected: string,
  output: () => { stdout: string; stderr: string },
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!output().stdout.includes(expected)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`relay 提前退出：${JSON.stringify(output())}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待启动日志超时：${JSON.stringify(output())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

describe("relay-server 启动入口", () => {
  it("监听成功后输出端口并提供健康检查", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-startup-log-"));
    const port = await getAvailablePort();
    const child = spawn(process.execPath, ["--import", tsxLoader, entryPath], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        RELAY_DB_PATH: join(dir, "relay.db"),
        RELAY_JWT_SECRET: "startup-log-test-only",
        RELAY_SMS_PROVIDER: "none",
        RELAY_STATIC_DIR: "",
        RELAY_PORT: String(port),
        RELAY_TRUST_PROXY: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      const expectedLog = `relay-server listening on port ${port}`;
      await waitForStartupLog(child, expectedLog, () => ({ stdout, stderr }));
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ok" });
      expect(stderr).toBe("");
    } finally {
      await stopChild(child);
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 15_000);
});
