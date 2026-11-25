import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { addUser } from "../src/admin/operations.js";
import { openRelayDatabase } from "../src/db.js";

const execFileAsync = promisify(execFile);
// 用 tsx loader 跑 TS 源码（等价 pnpm dev），与 dist 产物测试解耦。
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const cliPath = fileURLToPath(new URL("../src/admin/cli.ts", import.meta.url));

// relay-admin CLI 入口：只依赖 --db / RELAY_DB_PATH，不应被主进程的 JWT、端口等
// 必填项牵连（回归：原实现经 loadRelayConfig 取 dbPath，未设 RELAY_JWT_SECRET 时报错）。
describe("relay-admin CLI", () => {
  it("只设 RELAY_DB_PATH 即可列出账号", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-admin-cli-"));
    try {
      const dbPath = join(dir, "relay.db");
      const db = openRelayDatabase(dbPath);
      addUser(db, { phone: "+8613800138001" });
      db.close();

      const env: NodeJS.ProcessEnv = { ...process.env, RELAY_DB_PATH: dbPath };
      delete env.RELAY_JWT_SECRET;
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", tsxLoader, cliPath, "list-users"],
        { env },
      );
      expect(stdout).toContain("+8613800138001");
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("既无 --db 也无 RELAY_DB_PATH 时报出明确错误", async () => {
    const env = { ...process.env };
    delete env.RELAY_DB_PATH;
    delete env.RELAY_JWT_SECRET;
    await expect(
      execFileAsync(process.execPath, ["--import", tsxLoader, cliPath, "list-users"], { env }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("缺少数据库路径：请设置 --db 或 RELAY_DB_PATH"),
    });
  });
});
