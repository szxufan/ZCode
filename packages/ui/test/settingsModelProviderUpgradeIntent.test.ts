import { describe, expect, it } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  normalizeCodingPlanProviderId,
  resolveCodingPlanOAuthProviderId,
} from "@/settings/model-provider-section/codingPlanPurchaseAuth.js";

describe("settings model provider upgrade intent", () => {
  it("keeps both Team Provider identities in the Coding Plan upgrade boundary", () => {
    expect(normalizeCodingPlanProviderId(BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan)).toBe(
      BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
    );
    expect(normalizeCodingPlanProviderId(BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan)).toBe(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    );
    expect(resolveCodingPlanOAuthProviderId(BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan)).toBe(
      "zai",
    );
    expect(
      resolveCodingPlanOAuthProviderId(BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan),
    ).toBe("bigmodel");
  });
});
