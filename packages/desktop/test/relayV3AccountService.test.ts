import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { RelayV3AccountService } from "../src/main/remote-relay-v3/index.js";

// refresh 轮换持久化：每次旋转都会让旧 refresh 在 relay 侧失效，新值必须立即落盘；
// 否则下一次冷启动会用已 rotated 的旧 token，触发家族重放撤销并强制登出。

const configDir = mkdtempSync(join(tmpdir(), "relay-v3-account-"));

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function accessToken(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: "ok", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function readStoredRefresh(): string {
  const parsed = JSON.parse(readFileSync(join(configDir, "relay-v3-account.json"), "utf-8")) as {
    refresh: string;
  };
  return parsed.refresh;
}

describe("RelayV3AccountService refresh 持久化", () => {
  it("旋转后的新 refresh 立即写盘，冷启动继续使用最新 token", async () => {
    let nextRefresh = "r2";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v3/auth/login")) {
        // access 只剩 30 秒，低于 60 秒安全余量，getAccessToken 会立即旋转。
        return ok({
          access: accessToken(Math.floor(Date.now() / 1000) + 30),
          refresh: "r1",
          account: { id: "acct_1", phone_masked: "+8613****00" },
        });
      }
      if (url.endsWith("/v3/auth/refresh")) {
        const current = nextRefresh;
        nextRefresh = current === "r2" ? "r3" : "r4";
        return ok({
          access: accessToken(Math.floor(Date.now() / 1000) + 600),
          refresh: current,
        });
      }
      return ok(null);
    }) as typeof fetch;

    const service = new RelayV3AccountService({
      resolveBaseUrl: () => "http://relay.test",
      accountOptions: { configDir, fetchImpl },
    });
    expect(await service.loginWithCode("+8613800138000", "123456")).toEqual({ ok: true });
    expect(readStoredRefresh()).toBe("r1");

    // access 临期 → 旋转；新 refresh 必须落盘，而不是只留在内存。
    expect(await service.getAccessToken()).toBeTruthy();
    expect(readStoredRefresh()).toBe("r2");

    // 冷启动：新实例从磁盘恢复，读到的是 r2（若仍是 r1 会触发重放撤销）。
    const restarted = new RelayV3AccountService({
      resolveBaseUrl: () => "http://relay.test",
      accountOptions: { configDir, fetchImpl },
    });
    await restarted.restoreFromDisk();
    expect(readStoredRefresh()).toBe("r3");
  });
});
