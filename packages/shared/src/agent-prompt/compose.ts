// ============================================================
// 内置提示词正文组装
// ============================================================

import {
  AGENT_COMMUNICATION_PROMPTS,
  AGENT_CONTEXT_MANAGEMENT_PROMPTS,
  AGENT_HARD_TO_REVERSE_PROMPT,
  AGENT_SECURITY_NOTICE,
  AGENT_SESSION_GUIDANCE_HEADING,
  agentSessionGuidanceSkillBullet,
  buildAgentHarnessBlock,
  buildAgentIdentityIntro,
} from "./sections.js";

/** 与 ContextBuilder 的 section 拼接一致：section 内容之间以空行连接。 */
function joinSections(parts: readonly string[]): string {
  return parts.join("\n\n");
}

/** identity 段正文（含安全声明与 Harness 块）。 */
export function buildAgentIdentityBody(hasOutputStyle: boolean): string {
  return [
    ["", buildAgentIdentityIntro(hasOutputStyle), "", AGENT_SECURITY_NOTICE].join("\n"),
    "",
    buildAgentHarnessBlock(),
  ].join("\n");
}

/** Dynamic Behavior 段正文：沟通规范 + 代码风格 + 难以逆转操作边界。 */
export function buildAgentDynamicBehaviorBody(): string {
  return [
    AGENT_COMMUNICATION_PROMPTS.beforeDefault,
    "",
    AGENT_COMMUNICATION_PROMPTS.default,
    AGENT_COMMUNICATION_PROMPTS.afterDefault,
    "",
    AGENT_HARD_TO_REVERSE_PROMPT,
  ].join("\n");
}

/** 会话专项指导正文：标题 + 调用方按注册工具生成的条目行。 */
export function buildAgentSessionGuidanceBody(lines: readonly string[]): string {
  return [AGENT_SESSION_GUIDANCE_HEADING, ...lines].join("\n");
}

/** 当前默认的会话指导条目（Skill 斜杠调用）。 */
export function defaultAgentSessionGuidanceLines(): string[] {
  return [agentSessionGuidanceSkillBullet()];
}

/** Context Management 段正文。 */
export function buildAgentContextManagementBody(): string {
  return [AGENT_CONTEXT_MANAGEMENT_PROMPTS.default, "", AGENT_CONTEXT_MANAGEMENT_PROMPTS.additional].join("\n");
}

/**
 * 组装"可被 systemPromptOverride 覆盖的内置正文全文"，供设置页"载入内置提示词"使用。
 * 组装顺序与 ContextBuilder 对这四段的输出一致（identity → Dynamic Behavior →
 * Session Guidance → Context Management）。
 */
export function composeDefaultAgentPromptBody(
  options: { includeSessionGuidance?: boolean } = {},
): string {
  return joinSections([
    buildAgentIdentityBody(false),
    buildAgentDynamicBehaviorBody(),
    ...(options.includeSessionGuidance === false ? [] : [buildAgentSessionGuidanceBody(defaultAgentSessionGuidanceLines())]),
    buildAgentContextManagementBody(),
  ]);
}
