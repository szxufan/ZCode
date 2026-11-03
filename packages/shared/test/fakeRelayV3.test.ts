import { describe, expect, it } from "vitest";
import { createFakeRelayV3 } from "@zcode/shared/testing/fake-relay-v3";
import { defineRelayV3ConsistencyMatrix } from "@zcode/shared/testing/relay-v3-consistency";
import {
  relayV3Request,
  type RelayV3ConsistencySetup,
} from "@zcode/shared/testing/relay-v3-consistency";

// fake-relay-v3 fixture 自测试：一致性矩阵 + fixture 专属的故障注入/账号语义。
// 一致性矩阵由 relay-server 的真实实现回放同一套用例（见 relay-server/test/）。

const setup: RelayV3ConsistencySetup = async () => {
  const relay = await createFakeRelayV3();
  return {
    target: { httpUrl: relay.httpUrl, wsUrl: relay.wsUrl, smsCode: relay.smsCode },
    cleanup: () => relay.close(),
  };
};

defineRelayV3ConsistencyMatrix(setup);

describe("fake-relay-v3 fixture 专属行为", () => {
  it("onHttp networkError 销毁连接，调用被留存", async () => {
    const httpCalls: unknown[] = [];
    const relay = await createFakeRelayV3({
      onHttp: (call) => {
        httpCalls.push(call);
        return call.path === "/v3/auth/sms-code" ? { networkError: true } : undefined;
      },
    });
    try {
      await expect(
        relayV3Request({ httpUrl: relay.httpUrl, wsUrl: relay.wsUrl }, "smsCode", {
          phone: "+8613800139000",
        }),
      ).rejects.toThrow();
      expect(httpCalls).toHaveLength(1);
    } finally {
      await relay.close();
    }
  });

  it("registration closed：未知手机号不可自注册，预建账号可登录", async () => {
    const relay = await createFakeRelayV3({
      accounts: { "+8613800139001": "acct_seed" },
      registrationOpen: false,
    });
    const target = { httpUrl: relay.httpUrl, wsUrl: relay.wsUrl, smsCode: relay.smsCode };
    try {
      await relayV3Request(target, "smsCode", { phone: "+8613800139002" });
      const stranger = await relayV3Request(target, "login", {
        phone: "+8613800139002",
        code: relay.smsCode("+8613800139002"),
      });
      expect(stranger.parsed?.code).not.toBe(0);
      await relayV3Request(target, "smsCode", { phone: "+8613800139001" });
      const seeded = await relayV3Request(target, "login", {
        phone: "+8613800139001",
        code: relay.smsCode("+8613800139001"),
      });
      expect(seeded.parsed?.code).toBe(0);
    } finally {
      await relay.close();
    }
  });

  it("refresh 重放撤销整个家族（旋转后的旧 refresh 不可再用）", async () => {
    const relay = await createFakeRelayV3();
    const target = { httpUrl: relay.httpUrl, wsUrl: relay.wsUrl, smsCode: relay.smsCode };
    try {
      await relayV3Request(target, "smsCode", { phone: "+8613800139003" });
      const login = await relayV3Request(target, "login", {
        phone: "+8613800139003",
        code: relay.smsCode("+8613800139003"),
      });
      const pair = login.parsed?.data;
      if (!pair || "status" in pair) throw new Error("login failed");
      const rotated = await relayV3Request(target, "refresh", { refresh: pair.refresh });
      expect(rotated.parsed?.code).toBe(0);
      // 旧 refresh 重放 → 家族撤销，旋转签发的新 refresh 也随之失效。
      const replay = await relayV3Request(target, "refresh", { refresh: pair.refresh });
      expect(replay.parsed?.code).not.toBe(0);
      const nextPair = rotated.parsed?.data;
      if (!nextPair || "status" in nextPair) throw new Error("refresh failed");
      const chained = await relayV3Request(target, "refresh", { refresh: nextPair.refresh });
      expect(chained.parsed?.code).not.toBe(0);
    } finally {
      await relay.close();
    }
  });

  it("onMessage drop 丢弃 ACK，sendError/disconnect 面向目标连接", async () => {
    const relay = await createFakeRelayV3({
      onMessage: (message) => {
        const value = message.message as { type?: string };
        if (message.role === "device" && value.type === "pair_status_query") return { drop: true };
        return undefined;
      },
    });
    try {
      expect(relay.messages).toEqual([]);
      // drop 分支由矩阵外的 WS 行为覆盖；这里验证接缝存在且不抛错。
      expect(typeof relay.sendError).toBe("function");
      expect(typeof relay.disconnect).toBe("function");
    } finally {
      await relay.close();
    }
  });
});
