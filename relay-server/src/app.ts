import Fastify, { type FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";

import { RELAY_V3_BUSINESS_CODES } from "@zcode/shared/remote-relay-v3";

import type { RelayServerConfig } from "./config.js";
import { RelayPresence } from "./presence.js";
import { RelayRuntime } from "./runtime.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDeviceAuthRoutes } from "./routes/deviceAuth.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerStaticRoutes } from "./routes/static.js";
import { RELAY_LIMITS } from "./limits.js";
import { RecordingSmsTransport, type RelaySmsTransport } from "./smsProvider.js";
import { attachRelayWebSocket } from "./ws/relayWs.js";

export interface RelayAppDeps {
  db: DatabaseSync;
  config: RelayServerConfig;
  /** 注入短信通道；测试用 RecordingSmsTransport。缺省按 config.sms 构造。 */
  smsTransport?: RelaySmsTransport;
  now?: () => number;
}

export interface RelayApp {
  app: FastifyInstance;
  runtime: RelayRuntime;
  presence: RelayPresence;
  /** 测试接缝：test sms provider 的验证码收件箱。 */
  testSmsOutbox: Map<string, string> | null;
}

export function buildRelayApp(deps: RelayAppDeps): RelayApp {
  const { db, config } = deps;
  const runtime = new RelayRuntime({ now: deps.now });
  const presence = new RelayPresence();
  let testSmsOutbox: Map<string, string> | null = null;
  let smsTransport = deps.smsTransport;
  if (!smsTransport) {
    if (config.sms.provider === "test") {
      // 测试通道：验证码仅进入接缝，不外发、不写日志（§3.2）。
      const recording = new RecordingSmsTransport();
      smsTransport = recording;
      testSmsOutbox = recording.outbox;
    } else {
      // provider 为 none 或 aliyun 但未配置时，发送路径直接 503；
      // 此 transport 永不应被调用，保留兜底以防配置竞态。
      smsTransport = {
        async send() {
          throw new Error("sms transport not configured");
        },
      };
    }
  }

  const app = Fastify({
    logger: false,
    bodyLimit: RELAY_LIMITS.cipherBodyBytes,
  });

  // 并发 HTTP 请求 512 → 503（§8）。
  app.addHook("onRequest", async (request, reply) => {
    runtime.inFlightHttp += 1;
    if (runtime.inFlightHttp > RELAY_LIMITS.concurrentHttp) {
      runtime.inFlightHttp -= 1;
      return reply.status(503).send({ code: RELAY_V3_BUSINESS_CODES.INTERNAL, msg: "busy" });
    }
    request.raw.on("close", () => {
      runtime.inFlightHttp -= 1;
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  registerAuthRoutes(app, { db, config, runtime, smsTransport });
  registerDeviceRoutes(app, { db, config, runtime, presence });
  registerDeviceAuthRoutes(app, { db, config, runtime, presence });
  if (config.staticDir) registerStaticRoutes(app, config.staticDir);

  app.setNotFoundHandler((_request, reply) => {
    reply
      .status(200)
      .send({ code: RELAY_V3_BUSINESS_CODES.NOT_FOUND, msg: "not found", data: null });
  });

  attachRelayWebSocket(app, { db, runtime, presence });

  return { app, runtime, presence, testSmsOutbox };
}
