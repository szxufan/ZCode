import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildRelayApp } from "./app.js";
import { loadRelayConfig } from "./config.js";
import { openRelayDatabase, startupCleanup } from "./db.js";

// relay-server 入口：fail-closed 配置 → WAL 数据库 → Fastify 监听。
// 在线态、配对 owner、一次性 token 均为进程内存事实；重启后设备离线，
// 客户端按既有退避重连（§7）。

export async function startRelayServer(): Promise<void> {
  const config = loadRelayConfig();
  const db = openRelayDatabase(config.dbPath);
  startupCleanup(db);
  const relay = buildRelayApp({ db, config });
  try {
    await relay.app.listen({ port: config.port, host: "0.0.0.0" });
    // 容器运维需区分已监听与静默退出；仅记录端口，不开启可能泄露 URL/token 的请求日志。
    console.log(`relay-server listening on port ${config.port}`);
  } catch (error) {
    await relay.app.close();
    throw error;
  }
  const shutdown = async () => {
    await relay.app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// 以本文件为入口时才启动。修复原因：原实现只匹配 `index.ts`，tsc 产物
// `dist/index.js` 与打包产物都不会命中，进程静默退出 0；改为比较真实路径，
// 兼容 tsx 直跑源码与 node 跑打包产物（入口文件名不同也能命中）。
function isEntryModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  startRelayServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
