import { afterEach, describe, expect, it, vi } from "vitest";

import { RELAY_V3_HTTP } from "@zcode/shared/remote-relay-v3";

import type { RelayServerConfig } from "../src/config.js";
import { startTestRelay } from "./helpers.js";

const phone = "+8613800138000";
const aliyunSms: RelayServerConfig["sms"] = {
  provider: "aliyun",
  aliyun: {
    accessKeyId: "test-key-id",
    accessKeySecret: "test-key-secret",
    signName: "Test",
    templateCode: "SMS_TEST",
    endpoint: "https://dysmsapi.aliyuncs.com",
    codeSecret: "test-code-secret",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Aliyun 短信通道接线", () => {
  it("完整配置使用真实 transport 发送验证码", async () => {
    const providerFetch = vi.fn(async (_input: unknown, _init?: RequestInit) => {
      return new Response(JSON.stringify({ Code: "OK" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", providerFetch);
    const relay = await startTestRelay({ sms: aliyunSms });
    try {
      const response = await relay.relay.app.inject({
        method: "POST",
        url: RELAY_V3_HTTP.smsCode.path,
        payload: { phone },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ code: 0 });
      expect(providerFetch).toHaveBeenCalledOnce();
      const providerUrl = new URL(String(providerFetch.mock.calls[0]?.[0]));
      expect(providerUrl.searchParams.get("PhoneNumbers")).toBe(phone);
    } finally {
      await relay.close();
    }
  });

  it("运营商拒绝时记录不含手机号与验证码的错误类别", async () => {
    const providerFetch = vi.fn(async (_input: unknown, _init?: RequestInit) => {
      return new Response(JSON.stringify({ Code: "isv.INVALID_PARAMETERS" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", providerFetch);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const relay = await startTestRelay({ sms: aliyunSms });
    try {
      const response = await relay.relay.app.inject({
        method: "POST",
        url: RELAY_V3_HTTP.smsCode.path,
        payload: { phone },
      });

      expect(response.statusCode).toBe(502);
      expect(warning).toHaveBeenCalledOnce();
      const log = JSON.stringify(warning.mock.calls);
      expect(log).toContain("isv.INVALID_PARAMETERS");
      expect(log).not.toContain(phone);
      expect(log).not.toContain("accessKeySecret");
      expect(log).not.toContain("test-key-secret");
    } finally {
      await relay.close();
    }
  });
});
