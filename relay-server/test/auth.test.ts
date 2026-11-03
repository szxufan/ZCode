import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addUser, setPassword } from "../src/admin/operations.js";
import { loginTestAccount, startTestRelay, type TestRelay } from "./helpers.js";

// §3 账号与登录：验证码生命周期、注册闸、密码登录、锁定、refresh 家族。

let relay: TestRelay;

beforeAll(async () => {
  relay = await startTestRelay();
});

afterAll(async () => {
  await relay.close();
});

async function post(path: string, body: unknown, bearer?: string, target: TestRelay = relay) {
  // 无 body 时不发送 Content-Type：logout 等空体请求带 json Content-Type 会被
  // 服务端按空 JSON 解析拒绝（fastify 400），与真实客户端行为不符。
  const response = await fetch(`${target.httpUrl}${path}`, {
    method: "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

describe("短信验证码登录", () => {
  it("验证码登录成功即建号，返回 token 对与掩码手机号", async () => {
    const phone = "+8613800136000";
    const sms = await post("/v3/auth/sms-code", { phone });
    expect(sms.status).toBe(200);
    expect(sms.body.code).toBe(0);
    const login = await post("/v3/auth/login", { phone, code: relay.smsCode(phone) });
    expect(login.body.code).toBe(0);
    expect(login.body.data.access).toBeTruthy();
    expect(login.body.data.refresh).toBeTruthy();
    expect(login.body.data.account.phone_masked).not.toContain("8000");
  });

  it("错误验证码拒绝；正确验证码单次使用", async () => {
    const phone = "+8613800136001";
    await post("/v3/auth/sms-code", { phone });
    const wrong = await post("/v3/auth/login", { phone, code: "000000" });
    expect(wrong.body.code).not.toBe(0);
    const code = relay.smsCode(phone)!;
    const first = await post("/v3/auth/login", { phone, code });
    expect(first.body.code).toBe(0);
    const replay = await post("/v3/auth/login", { phone, code });
    expect(replay.body.code).not.toBe(0);
  });

  it("验证码 5 分钟过期", async () => {
    const phone = "+8613800136002";
    await post("/v3/auth/sms-code", { phone });
    relay.clock.advance(5 * 60_000 + 1_000);
    const login = await post("/v3/auth/login", { phone, code: relay.smsCode(phone) });
    expect(login.body.code).not.toBe(0);
  });

  it("closed 注册：未知手机号拒绝，预建账号可登录", async () => {
    const closed = await startTestRelay({ localRegistration: "closed" });
    try {
      await post("/v3/auth/sms-code", { phone: "+8613800136003" }, undefined, closed);
      const stranger = await post(
        "/v3/auth/login",
        { phone: "+8613800136003", code: closed.smsCode("+8613800136003") },
        undefined,
        closed,
      );
      expect(stranger.body.code).not.toBe(0);
      addUser(closed.db, { phone: "+8613800136004" });
      await post("/v3/auth/sms-code", { phone: "+8613800136004" }, undefined, closed);
      const seeded = await post(
        "/v3/auth/login",
        { phone: "+8613800136004", code: closed.smsCode("+8613800136004") },
        undefined,
        closed,
      );
      expect(seeded.body.code).toBe(0);
    } finally {
      await closed.close();
    }
  });
});

describe("密码登录与账号锁定", () => {
  it("预置密码可登录，错误密码计入指数锁定", async () => {
    const phone = "+8613800136010";
    addUser(relay.db, { phone, password: "correct horse" });
    const ok = await post("/v3/auth/login", { phone, password: "correct horse" });
    expect(ok.body.code).toBe(0);
    // 连续 5 次失败 → 锁定 5 分钟（§3.2）。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const bad = await post("/v3/auth/login", { phone, password: `wrong-${attempt}` });
      expect(bad.body.code).not.toBe(0);
    }
    // 第 5 次失败即触发锁定；正确密码在锁定期内也被拒绝。
    const locked = await post("/v3/auth/login", { phone, password: "correct horse" });
    expect(locked.body.code).toBe(10);
    relay.clock.advance(5 * 60_000 + 1_000);
    const unlocked = await post("/v3/auth/login", { phone, password: "correct horse" });
    expect(unlocked.body.code).toBe(0);
  });

  it("set-password 修改密码后旧密码失效", async () => {
    const phone = "+8613800136011";
    addUser(relay.db, { phone, password: "old-password" });
    setPassword(relay.db, phone, "new-password");
    const old = await post("/v3/auth/login", { phone, password: "old-password" });
    expect(old.body.code).not.toBe(0);
    const fresh = await post("/v3/auth/login", { phone, password: "new-password" });
    expect(fresh.body.code).toBe(0);
  });
});

describe("refresh 家族", () => {
  it("旋转 → 旧 token 重放撤销整个家族", async () => {
    const { access, refresh } = await loginTestAccount(relay, "+8613800136020");
    const rotated = await post("/v3/auth/refresh", { refresh });
    expect(rotated.body.code).toBe(0);
    // 重放已旋转 token：家族撤销，新链亦失效。
    const replay = await post("/v3/auth/refresh", { refresh });
    expect(replay.body.code).not.toBe(0);
    const next = await post("/v3/auth/refresh", { refresh: rotated.body.data.refresh });
    expect(next.body.code).not.toBe(0);
    // 家族撤销后 access 仍在 10 分钟有效期内可用（无状态 JWT，§3.3 已知边界），
    // 但登出语义验证见下个用例。
    expect(access).toBeTruthy();
  });

  it("登出撤销家族", async () => {
    const { access, refresh } = await loginTestAccount(relay, "+8613800136021");
    await post("/v3/auth/logout", undefined, access);
    const afterLogout = await post("/v3/auth/refresh", { refresh });
    expect(afterLogout.body.code).not.toBe(0);
  });

  it("refresh 过期拒绝", async () => {
    const { refresh } = await loginTestAccount(relay, "+8613800136022");
    relay.clock.advance(31 * 24 * 3_600_000);
    const expired = await post("/v3/auth/refresh", { refresh });
    expect(expired.body.code).not.toBe(0);
  });
});

describe("sms 未配置", () => {
  it("provider none 时验证码接口 503，密码登录仍可用", async () => {
    const offline = await startTestRelay({ sms: { provider: "none" } });
    try {
      addUser(offline.db, { phone: "+8613800136030", password: "pw" });
      const sms = await post("/v3/auth/sms-code", { phone: "+8613800136030" }, undefined, offline);
      expect(sms.status).toBe(503);
      const login = await post(
        "/v3/auth/login",
        { phone: "+8613800136030", password: "pw" },
        undefined,
        offline,
      );
      expect(login.body.code).toBe(0);
    } finally {
      await offline.close();
    }
  });
});
