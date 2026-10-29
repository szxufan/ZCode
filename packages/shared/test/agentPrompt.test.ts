import { describe, expect, it } from "vitest";
import {
  AGENT_PROMPT_BUILTIN_PROFILE_ID,
  composeDefaultAgentPromptBody,
  resolveAgentPromptOverride,
} from "#src/agent-prompt/index.js";

describe("agent prompt copy", () => {
  it("composes the overridable default body in builder section order", () => {
    const body = composeDefaultAgentPromptBody();

    // 顺序：identity → Dynamic Behavior → Session Guidance → Context Management。
    expect(body.indexOf("你是一个交互式 ZCode 智能体")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("你是一个交互式 ZCode 智能体")).toBeLessThan(
      body.indexOf("# 与用户沟通"),
    );
    expect(body.indexOf("# 与用户沟通")).toBeLessThan(body.indexOf("# 会话专项指导"));
    expect(body.indexOf("# 会话专项指导")).toBeLessThan(body.indexOf("# 上下文管理"));
    // 组成段逐段在场。
    expect(body).toContain("重要：可协助已获授权的安全测试");
    expect(body).toContain("# 运行时框架（Harness）");
    expect(body).toContain("写代码要像周围的代码");
    expect(body).toContain("当用户输入 `/<skill-name>` 时");
    expect(body).toContain("当会话变长时");
    // 环境事实段不属于可覆盖正文。
    expect(body).not.toContain("# 环境");
    expect(body).not.toContain("# 记忆（Memory）");
  });

  it("can exclude the session guidance section", () => {
    const body = composeDefaultAgentPromptBody({ includeSessionGuidance: false });
    expect(body).not.toContain("# 会话专项指导");
    expect(body).toContain("# 上下文管理");
  });
});

describe("resolveAgentPromptOverride", () => {
  const profile = {
    id: "prompt_test",
    name: "测试档",
    content: "自定义提示词正文",
  };

  it("returns undefined for builtin, empty, or missing active id", () => {
    expect(resolveAgentPromptOverride({})).toBeUndefined();
    expect(resolveAgentPromptOverride({ agentPromptActiveProfileId: undefined })).toBeUndefined();
    expect(
      resolveAgentPromptOverride({ agentPromptActiveProfileId: AGENT_PROMPT_BUILTIN_PROFILE_ID }),
    ).toBeUndefined();
    expect(resolveAgentPromptOverride({ agentPromptActiveProfileId: "" })).toBeUndefined();
  });

  it("returns undefined when the active id points to a deleted profile", () => {
    expect(
      resolveAgentPromptOverride({
        agentPromptProfiles: [profile],
        agentPromptActiveProfileId: "prompt_gone",
      }),
    ).toBeUndefined();
  });

  it("returns the active profile content", () => {
    expect(
      resolveAgentPromptOverride({
        agentPromptProfiles: [profile],
        agentPromptActiveProfileId: "prompt_test",
      }),
    ).toBe("自定义提示词正文");
  });

  it("treats whitespace-only content as no override", () => {
    expect(
      resolveAgentPromptOverride({
        agentPromptProfiles: [{ ...profile, content: "   " }],
        agentPromptActiveProfileId: "prompt_test",
      }),
    ).toBeUndefined();
  });
});
