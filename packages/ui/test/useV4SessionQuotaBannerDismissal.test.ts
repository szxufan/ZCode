// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { useV4SessionQuotaBanner } from "@/v4/useV4SessionQuotaBanner.js";

afterEach(cleanup);

function renderBanner(sessionId: string, errorKey: string) {
  return renderHook(() =>
    useV4SessionQuotaBanner({
      error: { code: "1308", message: "quota limited" },
      errorKey,
      modelId: "glm-5",
      phase: "idle",
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      sessionId,
    }),
  );
}

describe("useV4SessionQuotaBanner dismissal lifecycle", () => {
  it("survives unmount/session switching while isolating sessions and new errors", () => {
    const sessionA = renderBanner("session-a-remount", "error-1");
    expect(sessionA.result.current.dismissed).toBe(false);
    act(() => sessionA.result.current.dismiss());
    expect(sessionA.result.current.dismissed).toBe(true);
    sessionA.unmount();

    const sessionB = renderBanner("session-b-remount", "error-1");
    expect(sessionB.result.current.dismissed).toBe(false);
    sessionB.unmount();

    const remountedA = renderBanner("session-a-remount", "error-1");
    expect(remountedA.result.current.dismissed).toBe(true);
    remountedA.unmount();

    const newFailureA = renderBanner("session-a-remount", "error-2");
    expect(newFailureA.result.current.dismissed).toBe(false);
  });
});
