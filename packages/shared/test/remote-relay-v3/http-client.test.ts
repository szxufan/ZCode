import { describe, expect, it } from "vitest";

import {
  RELAY_V3_HTTP,
  RelayV3BusinessError,
  RelayV3ConnectionError,
  RelayV3HttpClient,
} from "@zcode/shared/remote-relay-v3";

// HTTP 客户端：信封解析、错误分类（401/5xx/网络/超时/取消）、期限与监听清理。

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createClient(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  timeoutMs = 15_000,
): RelayV3HttpClient {
  return new RelayV3HttpClient({
    baseUrl: "https://relay.test",
    timeoutMs,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      return handler(url, init);
    }) as typeof fetch,
  });
}

describe("Relay V3 HTTP 客户端", () => {
  it("成功信封：返回解析后的 data；请求路径/method/头正确", async () => {
    const token = "A".repeat(22); // 16 字节 Base64URL：21 字符 + [AQgw] 末位。
    let captured: { url: string; init?: RequestInit } | undefined;
    const client = createClient(async (url, init) => {
      captured = { url, init };
      return jsonResponse(200, {
        code: 0,
        msg: "ok",
        data: { token, expires_in: 60 },
      });
    });
    const data = await client.request("relayToken", { bearer: "jwt_1" }, { role: "device" });
    expect(data).toEqual({ token, expires_in: 60 });
    expect(captured?.url).toBe(`https://relay.test${RELAY_V3_HTTP.relayToken.path}`);
    expect(captured?.init?.method).toBe("POST");
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer jwt_1");
    expect(JSON.parse(String(captured?.init?.body))).toEqual({ role: "device" });
  });

  it("GET 请求不带 body", async () => {
    let body: unknown;
    const client = createClient(async (_url, init) => {
      body = init?.body;
      return jsonResponse(200, { code: 0, msg: "ok", data: [] });
    });
    const data = await client.request("list", { bearer: "jwt_1" });
    expect(data).toEqual([]);
    expect(body).toBeUndefined();
  });

  it("业务 code 非零 → RelayV3BusinessError（HTTP 200 与 4xx 均透传）", async () => {
    const client = createClient(async () => jsonResponse(200, { code: 7, msg: "rate limited", data: null }));
    await expect(client.request("smsCode", {}, { phone: "+8613800138000" })).rejects.toBeInstanceOf(
      RelayV3BusinessError,
    );
    await expect(client.request("smsCode", {}, { phone: "+8613800138000" })).rejects.toMatchObject({
      code: 7,
      msg: "rate limited",
    });
  });

  it("HTTP 401 → auth-required（不可重试）；5xx → relay-unavailable（可重试）", async () => {
    const unauthorized = createClient(async () => new Response("no auth", { status: 401 }));
    await expect(unauthorized.request("relayToken", { bearer: "stale" }, { role: "device" })).rejects.toMatchObject({
      reason: "auth-required",
      retryable: false,
    });
    const serverError = createClient(async () => new Response("boom", { status: 502 }));
    await expect(serverError.request("relayToken", { bearer: "ok" }, { role: "device" })).rejects.toMatchObject({
      reason: "relay-unavailable",
      retryable: true,
    });
  });

  it("网络失败 → relay-unavailable 可重试；非 JSON 正文 → 不可重试", async () => {
    const networkError = createClient(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(networkError.request("relayToken", { bearer: "ok" }, { role: "device" })).rejects.toMatchObject({
      reason: "relay-unavailable",
      retryable: true,
    });
    const html = createClient(async () => new Response("<html>gateway</html>", { status: 200 }));
    await expect(html.request("relayToken", { bearer: "ok" }, { role: "device" })).rejects.toBeInstanceOf(
      RelayV3ConnectionError,
    );
  });

  it("15s 期限覆盖正文读取：慢正文超时 → 可重试错误", async () => {
    const client = createClient(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"code":0,'));
              // 正文永不完成；请求 signal abort 时让流错误，text() 拒绝。
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
              );
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      30,
    );
    await expect(client.request("relayToken", { bearer: "ok" }, { role: "device" })).rejects.toMatchObject({
      reason: "relay-unavailable",
      retryable: true,
    });
  });

  it("调用方已取消 → 零请求发出", async () => {
    let calls = 0;
    const client = createClient(async () => {
      calls += 1;
      return jsonResponse(200, { code: 0, msg: "ok", data: null });
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.request("smsCode", { signal: controller.signal }, { phone: "+8613800138000" }),
    ).rejects.toMatchObject({ reason: "relay-unavailable", retryable: false });
    expect(calls).toBe(0);
  });

  it("成功后清理取消监听（不泄漏到后续请求）", async () => {
    const client = createClient(async () => jsonResponse(200, { code: 0, msg: "ok", data: null }));
    const controller = new AbortController();
    await client.request("logout", { bearer: "ok", signal: controller.signal });
    // abort 已完成请求的 signal 不抛未捕获错误。
    controller.abort();
    await client.request("logout", { bearer: "ok" });
  });
});
