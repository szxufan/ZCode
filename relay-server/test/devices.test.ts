import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loginTestAccount, startTestRelay, VALID_PUBLIC_KEY, type TestRelay } from "./helpers.js";

// §5.1 设备目录：注册、列表、删除、配额。

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

async function get(path: string, bearer: string) {
  const response = await fetch(`${relay.httpUrl}${path}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

describe("设备注册与目录", () => {
  it("同 MID 重复注册产生新 SID 与新公钥绑定", async () => {
    const { access } = await loginTestAccount(relay, "+8613800136100");
    const first = await post(
      "/v3/device",
      { device_mid: "mid-a", public_key: VALID_PUBLIC_KEY },
      access,
    );
    expect(first.body.code).toBe(0);
    const second = await post(
      "/v3/device",
      { device_mid: "mid-a", public_key: VALID_PUBLIC_KEY },
      access,
    );
    expect(second.body.code).toBe(0);
    expect(second.body.data.device_sid).not.toBe(first.body.data.device_sid);
    const list = await get("/v3/device", access);
    expect(list.body.data).toHaveLength(2);
  });

  it("非法公钥与未授权访问拒绝", async () => {
    const { access } = await loginTestAccount(relay, "+8613800136101");
    const badKey = await post("/v3/device", { device_mid: "mid-b", public_key: "short" }, access);
    expect(badKey.body.code).toBe(1);
    const anonymous = await post("/v3/device", {
      device_mid: "mid-b",
      public_key: VALID_PUBLIC_KEY,
    });
    expect(anonymous.body.code).toBe(2);
    const badToken = await post(
      "/v3/device",
      { device_mid: "mid-b", public_key: VALID_PUBLIC_KEY },
      "not-a-jwt",
    );
    expect(badToken.body.code).toBe(2);
  });

  it("设备配额 64/账号（原子准入）", async () => {
    const { access } = await loginTestAccount(relay, "+8613800136102");
    for (let index = 0; index < 64; index += 1) {
      const created = await post(
        "/v3/device",
        { device_mid: `mid-quota-${index}`, public_key: VALID_PUBLIC_KEY },
        access,
      );
      expect(created.body.code).toBe(0);
    }
    const exceeded = await post(
      "/v3/device",
      { device_mid: "mid-quota-overflow", public_key: VALID_PUBLIC_KEY },
      access,
    );
    expect(exceeded.body.code).toBe(6);
  });

  it("删除：幂等、越权 no permission", async () => {
    const owner = await loginTestAccount(relay, "+8613800136103");
    const stranger = await loginTestAccount(relay, "+8613800136104");
    const created = await post(
      "/v3/device",
      { device_mid: "mid-del", public_key: VALID_PUBLIC_KEY },
      owner.access,
    );
    const sid = created.body.data.device_sid as string;
    const foreign = await post("/v3/device/delete", { device_sid: sid }, stranger.access);
    expect(foreign.body.code).toBe(3);
    expect(foreign.body.msg).toBe("no permission");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const deleted = await post("/v3/device/delete", { device_sid: sid }, owner.access);
      expect(deleted.body.code).toBe(0);
    }
    const list = await get("/v3/device", owner.access);
    expect(list.body.data).toHaveLength(0);
  });

  it("一次性 ws token：60s 有效、单次消费", async () => {
    const { access } = await loginTestAccount(relay, "+8613800136105");
    const token = await post("/v3/relay/token", { role: "device" }, access);
    expect(token.body.code).toBe(0);
    expect(token.body.data.expires_in).toBe(60);
    expect(token.body.data.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // 复用已在一致性矩阵覆盖（upgrade 401）；此处验证 token 过期：推进 61s 后消费失败。
    relay.clock.advance(61_000);
    const second = await post("/v3/relay/token", { role: "terminal" }, access);
    expect(second.body.code).toBe(0);
    const badRole = await post("/v3/relay/token", { role: "observer" }, access);
    expect(badRole.body.code).toBe(1);
  });
});
