import { describe, expect, it } from "vitest";
import {
  buildScheduledSendAutomationParams,
  deriveScheduledSendTitle,
  MAX_DELAY_MINUTES,
} from "@/v4/scheduled-send/index.js";

const NOW = new Date(2026, 9, 30, 10, 0, 0, 0).getTime();

const BASE = {
  prompt: "帮我看下今天的构建日志",
  workspacePath: "/workspace/app",
  now: NOW,
};

describe("buildScheduledSendAutomationParams", () => {
  it("空正文拒绝提交", () => {
    const outcome = buildScheduledSendAutomationParams({
      ...BASE,
      prompt: "   \n  ",
      targetMs: NOW + 60 * 60_000,
    });
    expect(outcome).toEqual({ ok: false, reason: "emptyPrompt" });
  });

  it("过去时间判为非法", () => {
    const outcome = buildScheduledSendAutomationParams({
      ...BASE,
      targetMs: NOW - 60_000,
    });
    expect(outcome).toEqual({ ok: false, reason: "invalidTime" });
  });

  it("超过一年判为 tooFar", () => {
    const outcome = buildScheduledSendAutomationParams({
      ...BASE,
      targetMs: NOW + (MAX_DELAY_MINUTES + 1) * 60_000,
    });
    expect(outcome).toEqual({ ok: false, reason: "tooFar" });
  });

  it("绑定会话时透传 targetTaskId 并强制一次性", () => {
    const outcome = buildScheduledSendAutomationParams({
      ...BASE,
      targetMs: NOW + 90 * 60_000,
      sessionId: "session-1",
      modelSelection: { providerId: "glm", modelId: "glm-4.6" },
      mode: "build",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.params).toMatchObject({
      workspacePath: "/workspace/app",
      prompt: "帮我看下今天的构建日志",
      relativeDelayMinutes: 90,
      recurring: false,
      targetTaskId: "session-1",
      modelSelection: { providerId: "glm", modelId: "glm-4.6" },
      mode: "build",
    });
    // 一次性任务不收 cronExpr：服务层用 relativeDelayMinutes 生成锚点规则。
    expect("cronExpr" in outcome.params).toBe(false);
  });

  it("草稿态（无 sessionId）不绑定会话", () => {
    const outcome = buildScheduledSendAutomationParams({
      ...BASE,
      targetMs: NOW + 30 * 60_000,
      sessionId: null,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect("targetTaskId" in outcome.params).toBe(false);
    expect(outcome.params.relativeDelayMinutes).toBe(30);
  });

  it("标题取首行并截断到 40 字", () => {
    expect(deriveScheduledSendTitle("\n第一行标题\n第二行")).toBe("第一行标题");
    const long = "很长的标题".repeat(20);
    expect(deriveScheduledSendTitle(long)).toBe(`${long.slice(0, 40)}…`);
  });
});
