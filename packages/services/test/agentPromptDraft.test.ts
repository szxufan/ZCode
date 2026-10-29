import { describe, expect, it } from "vitest";
import {
  AGENT_PROMPT_DRAFT_MAX_OUTPUT_TOKENS,
  AGENT_PROMPT_DRAFT_QUERY_SOURCE,
  AGENT_PROMPT_DRAFT_REQUEST_TIMEOUT_MS,
  buildAgentPromptDraftMessages,
  extractAgentPromptDraftText,
} from "../src/zcode-agent/agentPromptDraft.js";

describe("buildAgentPromptDraftMessages", () => {
  it("生成模式：system 固定，user 只携带生成要求", () => {
    const messages = buildAgentPromptDraftMessages({ instruction: "  更简洁，强调测试优先  " });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("只输出提示词正文本身");
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toBe(
      "请生成一段全新的 agent 系统提示词正文。要求：更简洁，强调测试优先",
    );
    expect(messages[1]?.content).not.toContain("<现有提示词>");
  });

  it("修改模式：user 携带原文与修改指令，并要求未提及部分保持稳定", () => {
    const messages = buildAgentPromptDraftMessages({
      instruction: "把沟通规范换成更直接的口吻",
      baseContent: "# 与用户沟通\n\n保持结论先行。",
    });
    expect(messages[1]?.content).toContain("<现有提示词>");
    expect(messages[1]?.content).toContain("# 与用户沟通");
    expect(messages[1]?.content).toContain("修改指令：把沟通规范换成更直接的口吻");
    expect(messages[0]?.content).toContain("其余内容保持逐字稳定");
  });

  it("修改模式对 baseContent 只做 trim，不改变换行结构", () => {
    const messages = buildAgentPromptDraftMessages({
      instruction: "x",
      baseContent: "  第一行\n\n第二行  ",
    });
    expect(messages[1]?.content).toContain("第一行\n\n第二行");
  });
});

describe("extractAgentPromptDraftText", () => {
  it("剥离模型偶发添加的 markdown 围栏", () => {
    expect(extractAgentPromptDraftText("```markdown\n# 提示词\n正文\n```")).toBe("# 提示词\n正文");
    expect(extractAgentPromptDraftText("```\n只有围栏\n```")).toBe("只有围栏");
  });

  it("普通文本原样返回（trim 后）", () => {
    expect(extractAgentPromptDraftText("  # 提示词正文  ")).toBe("# 提示词正文");
  });

  it("空白输出视为失败", () => {
    expect(() => extractAgentPromptDraftText("   ")).toThrow("agent-prompt-draft.empty-output");
    expect(() => extractAgentPromptDraftText("```\n   \n```")).toThrow(
      "agent-prompt-draft.empty-output",
    );
  });
});

describe("agent prompt draft 调用参数常量", () => {
  it("querySource/超时/输出预算符合 spec §6", () => {
    // requestTimeoutMs 必须显式透传（协议 client 默认 3 分钟会误判 stale 杀进程），
    // 且要留出取消缓冲；输出预算封顶防止失控长输出。
    expect(AGENT_PROMPT_DRAFT_QUERY_SOURCE).toBe("agent_prompt_draft");
    expect(AGENT_PROMPT_DRAFT_REQUEST_TIMEOUT_MS).toBe(150_000);
    expect(AGENT_PROMPT_DRAFT_MAX_OUTPUT_TOKENS).toBe(8192);
  });
});
