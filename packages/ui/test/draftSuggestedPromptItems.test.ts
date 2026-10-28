import { describe, expect, it } from "vitest";
import {
  parseDraftSuggestedPromptActions,
  resolveDraftSuggestedPromptText,
} from "@/v4/draftSuggestedPromptItems.js";

describe("draft suggested prompt items", () => {
  it("splits, trims, deduplicates, and allowlists on_finish actions", () => {
    expect(
      parseDraftSuggestedPromptActions(
        " UNKNOWN:ACTION, NAVIGATE:AUTOMATIONS, NAVIGATE:AUTOMATIONS , NAVIGATE:AUTOMATIONS ",
      ),
    ).toEqual(["NAVIGATE:AUTOMATIONS"]);
    expect(parseDraftSuggestedPromptActions(null)).toEqual([]);
    expect(parseDraftSuggestedPromptActions(undefined)).toEqual([]);
  });

  it("resolves cn/en directly and falls back to the other available language", () => {
    expect(resolveDraftSuggestedPromptText({ cn: "中文", en: "English" }, "zh-CN")).toBe("中文");
    expect(resolveDraftSuggestedPromptText({ cn: "中文", en: "English" }, "en-US")).toBe("English");
    expect(resolveDraftSuggestedPromptText({ cn: "中文", en: "" }, "en-US")).toBe("中文");
  });
});
