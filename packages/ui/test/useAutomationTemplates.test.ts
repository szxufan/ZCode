// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAutomationTemplates } from "@/settings/useAutomationTemplates.js";

describe("useAutomationTemplates", () => {
  it("returns the local-only catalog immediately after Client Scenes retirement", () => {
    const { result } = renderHook(() => useAutomationTemplates());

    expect(result.current.loading).toBe(false);
    expect(result.current.scheduled).toEqual([]);
    expect(result.current.rejectedScheduledTemplateIds).toEqual([]);
  });
});
