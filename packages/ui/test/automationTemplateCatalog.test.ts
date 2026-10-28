import { describe, expect, it } from "vitest";
import {
  materializeScheduledTemplateDraft,
  resolveAutomationTemplateText,
  type ScheduledAutomationTemplate,
} from "@/settings/automationTemplateCatalog.js";

const SCHEDULED_TEMPLATE: ScheduledAutomationTemplate = {
  id: "item-morningDevBrief",
  title: { cn: "晨会动态", en: "Morning dev brief" },
  description: { cn: "中文定时指令", en: "English scheduled prompt" },
  prompt: { cn: "中文定时指令", en: "English scheduled prompt" },
  cronExpr: "0 9 * * 1-5",
  icon: "target",
};

describe("automation template catalog", () => {
  it("materializes current-locale primitives that are independent from later catalog refreshes", () => {
    const scheduledDraft = materializeScheduledTemplateDraft(SCHEDULED_TEMPLATE, "zh-CN");

    expect(scheduledDraft).toEqual({
      templateId: "item-morningDevBrief",
      title: "晨会动态",
      cronExpr: "0 9 * * 1-5",
      prompt: "中文定时指令",
    });
  });

  it("resolves the active locale with a deterministic opposite-language fallback", () => {
    expect(resolveAutomationTemplateText({ cn: "中文", en: "English" }, "zh-CN")).toBe("中文");
    expect(resolveAutomationTemplateText({ en: "English" }, "zh-CN")).toBe("English");
    expect(resolveAutomationTemplateText({ cn: "中文" }, "en-US")).toBe("中文");
  });
});
