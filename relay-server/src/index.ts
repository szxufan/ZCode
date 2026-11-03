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

// bin 直跑（node dist/index.js / node --experimental-strip-types src/index.ts）。
if (process.argv[1]?.replaceAll("\\", "/").endsWith("index.ts")) {
  startRelayServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
