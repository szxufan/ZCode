import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestRelay, type TestRelay } from "./helpers.js";
import { loadRelayConfig } from "../src/config.js";
import { RELAY_LIMITS } from "../src/limits.js";

// §8 资源限额：请求体上限、验证码发送/校验限流、refresh 旋转限流、fail-closed 启动。

let relay: TestRelay;

beforeAll(async () => {
  relay = await startTestRelay();
});

afterAll(async () => {
  await relay.close();
});

async function post(path: string, body: unknown, bearer?: string) {
  const response = await fetch(`${relay.httpUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

describe("请求体上限", () => {
  it("鉴权接口 16 KiB → 413", async () => {
    const bigBody = { phone: "+8613800136300", code: "1".repeat(20_000) };
    const response = await fetch(`${relay.httpUrl}/v3/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bigBody),
    });
    expect(response.status).toBe(413);
  });
});

describe("验证码限流", () => {
  it("发送 5/分钟/IP；重发冷却 60s；每日 10 条/号", async () => {
    const phone = "+8613800136301";
    // 每次推进 61s：同时满足重发冷却并重置 IP 分钟窗口，逐条计入每日预算。
    let sent = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      relay.clock.advance(61_000);
      const ok = await post("/v3/auth/sms-code", { phone });
      expect(ok.body.code).toBe(0);
      sent += 1;
    }
    expect(sent).toBe(10);
    relay.clock.advance(61_000);
    const dailyLimited = await post("/v3/auth/sms-code", { phone });
    expect(dailyLimited.body.code).toBe(7);
    // 同一时刻另一手机号不受该号每日预算影响（IP 窗口刚重置）。
    const other = await post("/v3/auth/sms-code", { phone: "+8613800136303" });
    expect(other.body.code).toBe(0);
  });

  it("校验 10/分钟/IP", async () => {
    const phone = "+8613800136302";
    await post("/v3/auth/sms-code", { phone });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const bad = await post("/v3/auth/login", { phone, code: "000001" });
      expect(bad.body.code).not.toBe(0);
    }
    const limited = await post("/v3/auth/login", { phone, code: "000002" });
    expect(limited.body.code).toBe(7);
  });
});

describe("refresh 旋转限流", () => {
  it("30/分钟/IP", async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ok = await post("/v3/auth/refresh", { refresh: `invalid-${attempt}` });
      expect(ok.body.code).not.toBe(0);
    }
    const limited = await post("/v3/auth/refresh", { refresh: "invalid-31" });
    expect(limited.body.code).toBe(7);
  });
});

describe("并发 HTTP 计数", () => {
  it("503 拒绝的请求也释放计数，过载突发后服务不被永久锁死", async () => {
    const runtime = relay.relay.runtime;
    // 模拟并发已满：下一个请求必须被 503 拒绝。
    runtime.inFlightHttp = RELAY_LIMITS.concurrentHttp;
    const rejected = await fetch(`${relay.httpUrl}/health`);
    expect(rejected.status).toBe(503);
    await rejected.text();
    // 拒绝请求的 +1 必须随请求结束释放回满额值，不能永久滞留把后续请求全部挡死。
    await waitUntil(
      () => runtime.inFlightHttp === RELAY_LIMITS.concurrentHttp,
      "503 请求释放并发计数",
    );
    runtime.inFlightHttp = 0;
    const ok = await fetch(`${relay.httpUrl}/health`);
    expect(ok.status).toBe(200);
    await ok.text();
    await waitUntil(() => runtime.inFlightHttp === 0, "正常请求释放并发计数");
  });
});

async function waitUntil(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("fail-closed 启动", () => {
  it("缺失 RELAY_DB_PATH / RELAY_JWT_SECRET 报错；生产禁用 test provider", () => {
    expect(() => loadRelayConfig({})).toThrow(/RELAY_DB_PATH/);
    expect(() => loadRelayConfig({ RELAY_DB_PATH: "/tmp/x.db" })).toThrow(/RELAY_JWT_SECRET/);
    expect(() =>
      loadRelayConfig({
        RELAY_DB_PATH: "/tmp/x.db",
        RELAY_JWT_SECRET: "s",
        RELAY_SMS_PROVIDER: "test",
        NODE_ENV: "production",
      }),
    ).toThrow(/test/);
    const ok = loadRelayConfig({
      RELAY_DB_PATH: "/tmp/x.db",
      RELAY_JWT_SECRET: "s",
      RELAY_SMS_PROVIDER: "test",
    });
    expect(ok.sms.provider).toBe("test");
    expect(ok.production).toBe(false);
    expect(ok.trustProxy).toBe(false);
    // none 是部署文档允许的显式值：验证码接口 503，密码登录仍可用。
    const none = loadRelayConfig({
      RELAY_DB_PATH: "/tmp/x.db",
      RELAY_JWT_SECRET: "s",
      RELAY_SMS_PROVIDER: "none",
    });
    expect(none.sms.provider).toBe("none");
    // 反代部署可显式给出可信代理 CIDR，用于恢复真实客户端 IP。
    const proxied = loadRelayConfig({
      RELAY_DB_PATH: "/tmp/x.db",
      RELAY_JWT_SECRET: "s",
      RELAY_SMS_PROVIDER: "test",
      RELAY_TRUST_PROXY: "172.16.0.0/12",
    });
    expect(proxied.trustProxy).toBe("172.16.0.0/12");
  });
});
