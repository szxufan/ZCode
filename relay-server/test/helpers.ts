import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRelayApp, type RelayApp } from "../src/app.js";
import type { RelayServerConfig } from "../src/config.js";
import { openRelayDatabase, startupCleanup } from "../src/db.js";
import type { DatabaseSync } from "node:sqlite";
import { RELAY_V3_WS_PATH } from "@zcode/shared/remote-relay-v3";

// 测试辅助：真实 Fastify 实例监听 127.0.0.1:0，临时 SQLite，注入可控时钟。
// sms provider 固定 test 通道，验证码经 testSmsOutbox 取回。

export class TestClock {
  private current = 1_800_000_000_000;
  now = (): number => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
}

export interface TestRelay {
  relay: RelayApp;
  db: DatabaseSync;
  httpUrl: string;
  wsUrl: string;
  clock: TestClock;
  config: RelayServerConfig;
  smsCode: (phone: string) => string | undefined;
  close(): Promise<void>;
}

export async function startTestRelay(
  overrides: Partial<RelayServerConfig> = {},
): Promise<TestRelay> {
  const dir = await mkdtemp(join(tmpdir(), "relay-v3-test-"));
  const clock = new TestClock();
  const config: RelayServerConfig = {
    port: 0,
    dbPath: join(dir, "relay.db"),
    jwtSecret: "test-jwt-secret",
    localRegistration: "open",
    production: false,
    sms: { provider: "test" },
    ...overrides,
  };
  const db = openRelayDatabase(config.dbPath);
  startupCleanup(db, clock.now);
  const relay = buildRelayApp({ db, config, now: clock.now });
  await relay.app.listen({ port: 0, host: "127.0.0.1" });
  const address = relay.app.server?.address();
  if (!address || typeof address === "string") throw new Error("missing relay address");
  return {
    relay,
    db,
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}${RELAY_V3_WS_PATH}`,
    clock,
    config,
    smsCode: (phone: string) => relay.testSmsOutbox?.get(phone),
    close: async () => {
      await relay.app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function loginTestAccount(
  relay: TestRelay,
  phone: string,
): Promise<{ access: string; refresh: string }> {
  // 每次登录前推进 61s：重置同 IP 的验证码发送分钟窗口并越过重发冷却，
  // 使同一测试内多次 loginTestAccount 不互相触发 §3.2 限流。
  relay.clock.advance(61_000);
  const response = await fetch(`${relay.httpUrl}/v3/auth/sms-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  if (response.status !== 200) throw new Error(`sms-code failed: ${response.status}`);
  const smsBody = (await response.json()) as { code: number };
  if (smsBody.code !== 0) throw new Error(`sms-code rejected: ${smsBody.code}`);
  const login = await fetch(`${relay.httpUrl}/v3/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, code: relay.smsCode(phone) }),
  });
  const body = (await login.json()) as {
    code: number;
    data?: { access: string; refresh: string };
  };
  if (body.code !== 0 || !body.data) throw new Error(`login failed: ${JSON.stringify(body)}`);
  return body.data;
}

export const VALID_PUBLIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8";
