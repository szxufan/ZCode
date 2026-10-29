// ============================================================
// 系统提示词配置档的 AI 生成/修改（设置页 agentPrompt 分区）
// ============================================================
//
// 通路：设置页 → IZcodeAgentService.generateAgentPromptDraft → generateWorkspaceText
// （workspace/generateText，CLI 侧无活跃会话时临时建 ZCodeApp）。与 commit message
// 生成同一先例：prompt 构造与输出规整集中在 Host services 层，UI 只处理 pending/error。
// 规格见 docs/specs/agent-system-prompt-chinese-and-profiles.md §6。

/** workspace/generateText 的调用来源标记；querySource 是自由字符串，无需协议改动。 */
export const AGENT_PROMPT_DRAFT_QUERY_SOURCE = "agent_prompt_draft";

/**
 * 协议层 RPC 超时（自身 deadline + 取消缓冲）。协议 client 默认 3 分钟超时会先于
 * thinking 模型的长请求触发并被误判 stale 杀进程，调用方必须显式透传（见
 * zcodeAgentService.generateWorkspaceText 的 requestTimeoutMs 注释）。
 */
export const AGENT_PROMPT_DRAFT_REQUEST_TIMEOUT_MS = 150_000;

/** 提示词正文可能很长；给足输出预算的同时封顶，防止失控长输出。 */
export const AGENT_PROMPT_DRAFT_MAX_OUTPUT_TOKENS = 8192;

/**
 * 面向 UI 的稳定错误码：服务层只抛码不抛文案（本包无 i18n 上下文），
 * UI 侧按码映射本地化文案（spec §6 失败语义）。
 */
export const AGENT_PROMPT_DRAFT_EMPTY_OUTPUT_CODE = "agent-prompt-draft.empty-output";
export const AGENT_PROMPT_DRAFT_WORKSPACE_REQUIRED_CODE = "agent-prompt-draft.workspace-required";

const AGENT_PROMPT_DRAFT_SYSTEM_PROMPT = [
  "你是 ZCode 主 Agent 的系统提示词工程助手。",
  "任务：根据用户要求，产出或修改一段 agent 系统提示词正文。",
  "要求：",
  "- 只输出提示词正文本身；不要任何解释、前言、结语，也不要 markdown 代码围栏。",
  "- 用 markdown 分节组织（如身份、沟通规范、上下文管理、工具使用边界等），指令具体可执行。",
  "- 修改模式：只改用户指令涉及的部分，其余内容保持逐字稳定。",
  "- 内置默认提示词是中文的，产物默认使用中文；专有名词与标识符（ZCode、AGENTS.md、Git、工具名、permission mode 名、file_path:line_number 等）保持英文。",
].join("\n");

export interface AgentPromptDraftMessagesInput {
  /** 用户对提示词的要求（生成模式）或修改指令（修改模式）。 */
  instruction: string;
  /** 修改模式下的现有提示词正文；缺省为生成模式。 */
  baseContent?: string;
}

export function buildAgentPromptDraftMessages(
  input: AgentPromptDraftMessagesInput,
): [{ role: "system"; content: string }, { role: "user"; content: string }] {
  const trimmedInstruction = input.instruction.trim();
  const baseContent = input.baseContent?.trim();
  const userContent = baseContent
    ? [
        "以下是现有的系统提示词正文，请按修改指令调整它：",
        "",
        "<现有提示词>",
        baseContent,
        "</现有提示词>",
        "",
        `修改指令：${trimmedInstruction}`,
      ].join("\n")
    : `请生成一段全新的 agent 系统提示词正文。要求：${trimmedInstruction}`;
  return [
    { role: "system", content: AGENT_PROMPT_DRAFT_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

/** 规整模型输出：剥离模型偶发加上的 markdown 围栏，空白输出视为失败。 */
export function extractAgentPromptDraftText(rawText: string): string {
  let text = rawText.trim();
  const fencePattern = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/;
  const fenced = text.match(fencePattern);
  if (fenced?.[1]) {
    text = fenced[1].trim();
  }
  if (!text) {
    throw new Error(AGENT_PROMPT_DRAFT_EMPTY_OUTPUT_CODE);
  }
  return text;
}
