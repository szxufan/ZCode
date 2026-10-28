import { BUILTIN_MODEL_PROVIDER_IDS, type UsageEntitlementSnapshot } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  buildSessionQuotaBannerDismissKey,
  buildSessionQuotaBannerState,
  normalizeProviderLimitedBannerMessage,
  resolveQuotaBannerUpgradeProviderId,
  shouldOfferQuotaBannerUpgrade,
} from "@/v4/sessionQuotaBannerState.js";

function entitlement(params: {
  dailyRemaining: number;
  modelRemaining: number;
}): UsageEntitlementSnapshot {
  return {
    generatedAt: 1,
    authenticated: true,
    provider: {
      id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      name: "Z.AI Start Plan",
    },
    remaining: {
      count: params.dailyRemaining,
      isShow: true,
      percentage: params.dailyRemaining / 500,
    },
    subscription: null,
    quota: {
      level: "Start",
      limits: [
        {
          type: "glm-5.2",
          bucketId: "bucket-glm-52",
          periodStart: 0,
          periodEnd: 1000,
          number: 100,
          remaining: params.modelRemaining,
          percentage: params.modelRemaining / 100,
          usageDetails: [{ modelCode: "glm-5.2", usage: 100 - params.modelRemaining }],
        },
      ],
    },
  };
}

describe("V4 session quota banner state", () => {
  it("只保留 10% 和耗尽提醒，且不阻断提交", () => {
    const cases = [
      [50, null, false],
      [48, null, false],
      [47, null, false],
      [20, null, false],
      [10.1, null, false],
      [10, "model-very-low", true],
      [9, "model-very-low", true],
      [0, "daily-exhausted", false],
    ] as const;
    for (const [remaining, kind, dismissible] of cases) {
      const state = buildSessionQuotaBannerState({
        activeProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        snapshot: entitlement({
          dailyRemaining: 450,
          modelRemaining: remaining,
        }),
        modelId: "glm-5.2",
      });
      expect(state.kind).toBe(kind);
      expect(state.dismissible).toBe(dismissible);
      expect(state.blocksSubmit).toBe(false);
    }
  });

  it("服务端并发和额度错误优先于 entitlement，dismiss key 隔离错误实例", () => {
    const state = buildSessionQuotaBannerState({
      activeProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      snapshot: entitlement({ dailyRemaining: 450, modelRemaining: 50 }),
      modelId: "glm-5.2",
      serverConcurrentLimited: true,
      serverConcurrentLimitBusinessCode: "3010",
      serverConcurrentLimitReason: "retry-exhausted-busy",
    });
    expect(state.kind).toBe("concurrent-limit");
    expect(state.priority).toBe(60);
    expect(buildSessionQuotaBannerDismissKey(state, "error-a")).not.toBe(
      buildSessionQuotaBannerDismissKey(state, "error-b"),
    );
  });

  it("清洗 GLM bracket 文案并保留当前 Provider 身份", () => {
    expect(
      normalizeProviderLimitedBannerMessage("[1113][余额不足或无可用资源包,请充值。][request-id]"),
    ).toBe("余额不足或无可用资源包,请充值。");
    expect(
      resolveQuotaBannerUpgradeProviderId(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan),
    ).toBe(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan);
  });
});
