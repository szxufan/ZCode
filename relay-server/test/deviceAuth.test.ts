import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateRelayV3KeyPair } from "@zcode/shared/remote-relay-v3";

import { encodeRelayV3Base64Url } from "@zcode/shared/remote-relay-v3";
import { loginTestAccount, startTestRelay, type TestRelay } from "./helpers.js";

// §5.5 设备授权：request/approve/poll、过期、限流、批准即绑定。

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

describe("设备授权流程", () => {
  it("request → pending poll → approve → poll 交付凭据与设备记录", async () => {
    const { access } = await loginTestAccount(relay, "+8613800136200");
    const daemonKeys = generateRelayV3KeyPair();
    const publicKey = encodeRelayV3Base64Url(daemonKeys.publicKey);
    const request = await post("/v3/device-auth/request", { public_key: publicKey });
    expect(request.body.code).toBe(0);
    expect(request.body.data.user_code).toMatch(/^\d{8}$/);
    expect(request.body.data.expires_in).toBe(900);
    const pending = await post("/v3/device-auth/poll", {
      device_code: request.body.data.device_code,
    });
    expect(pending.body.data).toEqual({ status: "pending" });
    const approve = await post(
      "/v3/device-auth/approve",
      { user_code: request.body.data.user_code },
      access,
    );
    expect(approve.body.code).toBe(0);
    expect(approve.body.data.device.public_key).toBe(publicKey);
    // 批准后公钥进入设备目录。
    const list = await fetch(`${relay.httpUrl}/v3/device`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    const devices = ((await list.json()) as any).data as { public_key: string }[];
    expect(devices.some((device) => device.public_key === publicKey)).toBe(true);
    const poll = await post("/v3/device-auth/poll", {
      device_code: request.body.data.device_code,
    });
    expect(poll.body.code).toBe(0);
    expect(poll.body.data.access).toBeTruthy();
    expect(poll.body.data.refresh).toBeTruthy();
    // 凭据可用：poll 返回的 access 能列出设备目录。
    const daemonList = await fetch(`${relay.httpUrl}/v3/device`, {
      headers: { Authorization: `Bearer ${poll.body.data.access}` },
    });
    expect(((await daemonList.json()) as any).code).toBe(0);
    // user_code 单次使用。
    const consumed = await post("/v3/device-auth/poll", {
      device_code: request.body.data.device_code,
    });
    expect(consumed.body.code).toBe(5);
  });

  it("过期：15 分钟后 approve/poll 均拒绝", async () => {
    const daemonKeys = generateRelayV3KeyPair();
    const request = await post("/v3/device-auth/request", {
      public_key: encodeRelayV3Base64Url(daemonKeys.publicKey),
    });
    relay.clock.advance(901_000);
    const { access } = await loginTestAccount(relay, "+8613800136201");
    const approve = await post(
      "/v3/device-auth/approve",
      { user_code: request.body.data.user_code },
      access,
    );
    expect(approve.body.code).toBe(9);
    const poll = await post("/v3/device-auth/poll", {
      device_code: request.body.data.device_code,
    });
    expect(poll.body.code).toBe(9);
  });

  it("approve 需要登录态；未批准 user_code 报过期", async () => {
    const anonymous = await post("/v3/device-auth/approve", { user_code: "12345678" });
    expect(anonymous.body.code).toBe(2);
    const { access } = await loginTestAccount(relay, "+8613800136202");
    const unknown = await post("/v3/device-auth/approve", { user_code: "87654321" }, access);
    expect(unknown.body.code).toBe(9);
  });

  it("request 限流 5/分钟/IP", async () => {
    const daemonKeys = generateRelayV3KeyPair();
    const publicKey = encodeRelayV3Base64Url(daemonKeys.publicKey);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const ok = await post("/v3/device-auth/request", { public_key: publicKey });
      expect(ok.body.code).toBe(0);
    }
    const limited = await post("/v3/device-auth/request", { public_key: publicKey });
    expect(limited.body.code).toBe(7);
  });
});
