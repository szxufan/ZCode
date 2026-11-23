import { describe, expect, it } from "vitest";
import {
  AGENT_ENV_CMD_SHELL_RULE,
  AGENT_PROMPT_BUILTIN_PROFILE_ID,
  buildAgentFinishingWorkBody,
  buildAgentMemoryNotesBody,
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

// 上游 v4.0.0 新增的两段固定提示词：fork 译成中文，且不在配置档可覆盖正文内（规格 §1.4）。
describe("fixed sections added by upstream v4.0.0", () => {
  it("keeps finishing work and memory notes in Chinese and out of the overridable body", () => {
    const finishing = buildAgentFinishingWorkBody();
    const memoryNotes = buildAgentMemoryNotesBody();

    expect(finishing.startsWith("# 收尾")).toBe(true);
    expect(memoryNotes.startsWith("# 记忆、笔记与反馈")).toBe(true);
    expect(finishing).toContain("结束回合意味着你的工作就此停住");
    expect(finishing).toContain("这不影响对有风险或破坏性的操作先做确认的要求");
    expect(memoryNotes).toContain("只保存既适用又持久的内容");
    expect(memoryNotes).toContain("「记忆（Memory）」");
    // 笔记里的提醒涉及风险操作时，仍要等人确认（上游同段的边界）。
    expect(memoryNotes).toContain("直到有人给出确认");

    const body = composeDefaultAgentPromptBody();
    expect(body).not.toContain("# 收尾");
    expect(body).not.toContain("# 记忆、笔记与反馈");
  });

  it("translates the cmd.exe shell rule while keeping command names", () => {
    expect(AGENT_ENV_CMD_SHELL_RULE).toContain("Bash 工具的命令由 cmd.exe 解析");
    expect(AGENT_ENV_CMD_SHELL_RULE).toContain("ls、cat、head、tail、grep、wc");
    expect(AGENT_ENV_CMD_SHELL_RULE).toContain("dir、type 或 findstr");
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
