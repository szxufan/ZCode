import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestRelay, type TestRelay } from "./helpers.js";
import { loadRelayConfig } from "../src/config.js";

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
  });
});
