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
  let pruneTimer: ReturnType<typeof setInterval> | undefined;
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
    // 反代部署需显式开启，否则按直连地址限流（见 deployment.md）。
    trustProxy: config.trustProxy,
  });

  // 并发 HTTP 请求 512 → 503（§8）。每个请求恰好注册一次释放监听。
  app.addHook("onRequest", async (request, reply) => {
    runtime.inFlightHttp += 1;
    // Bug 原因：释放监听曾注册在超限检查之后，503 拒绝分支提前 return 导致该请求的 +1
    // 永不递减；过载突发后计数只增不减，累计超过上限会把后续所有请求永久拒绝。
    // 先注册再检查，接受与拒绝的请求都在 close 时释放一次（Node 的 request close
    // 在 keep-alive 下也按请求触发，已验证）。
    request.raw.once("close", () => {
      runtime.inFlightHttp = Math.max(0, runtime.inFlightHttp - 1);
    });
    if (runtime.inFlightHttp > RELAY_LIMITS.concurrentHttp) {
      return reply.status(503).send({ code: RELAY_V3_BUSINESS_CODES.INTERNAL, msg: "busy" });
    }
  });

  // 进程内过期事实（一次性 token、待批准请求、限流窗口）定期回收。
  app.addHook("onReady", () => {
    pruneTimer = setInterval(() => runtime.pruneExpired(), RELAY_LIMITS.pruneIntervalMs);
    pruneTimer.unref?.();
  });
  app.addHook("onClose", () => {
    if (pruneTimer) {
      clearInterval(pruneTimer);
      pruneTimer = undefined;
    }
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
