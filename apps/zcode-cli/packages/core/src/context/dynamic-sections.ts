import {
  buildAgentContextManagementBody,
  buildAgentDynamicBehaviorBody,
  buildAgentFinishingWorkBody,
  buildAgentMemoryNotesBody,
  buildAgentSessionGuidanceBody,
  defaultAgentSessionGuidanceLines,
} from "@zcode/shared";
import type { ContextBuilderConfig, ContextSection } from "./types.js";
import { TOTAL_TOKENS_SYSTEM_LINE } from "./total-tokens.js";
import { estimateTokens } from "./utils.js";

export function buildSessionGuidanceSection(
  toolNames: readonly string[],
  hasSkills = false,
): ContextSection | null {
  const tools = new Set(toolNames);
  const lines: string[] = [];

  // 当前不输出 Agent 指导段。
  // if (tools.has("Agent")) {
  //   lines.push("- Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.");

  //   let exploreGuide = "- For broad codebase exploration or research that'll take more than 3 queries, spawn Agent with subagent_type=Explore.";
  //   const fallbackSearch = getDirectSearchGuidance(tools);
  //   if (fallbackSearch) {
  //     exploreGuide += ` Otherwise use ${fallbackSearch} directly.`;
  //   }
  //   lines.push(exploreGuide);
  // }

  if (tools.has("Skill") && hasSkills) {
    lines.push(...defaultAgentSessionGuidanceLines());
  }

  // if (tools.has("AskUserQuestion")) {
  //   lines.push("- Use AskUserQuestion when you need a bounded clarification before proceeding.");
  // }

  if (lines.length <= 0) {
    return null;
  }

  // 只有存在实际 session guidance 时才输出本段，避免向 simple branch 注入空标题。
  return createDynamicSection(
    "Session-specific guidance",
    "session_guidance",
    buildAgentSessionGuidanceBody(lines),
  );
}

export function buildDynamicBehaviorSection(): ContextSection {
  return createDynamicSection(
    "Dynamic Behavior",
    "dynamic_behavior",
    buildAgentDynamicBehaviorBody(),
  );
}

export function buildContextManagementSection(): ContextSection {
  return createDynamicSection(
    "Context Management",
    "context_management",
    buildAgentContextManagementBody(),
  );
}

// 默认 prompt 的收尾与记忆保存两段（上游 v4.0.0），不按模型区分；没有 Memory 目录时也发，
// 段内自己说明保存规则的适用条件。文案取自 @zcode/shared 的中文正文。
// 这两段不在 systemPromptOverride 的覆盖范围内：配置档生效时照常输出（规格 §1.4）。
export function buildFinishingWorkSection(): ContextSection {
  return createDynamicSection("Finishing Work", "finishing_work", buildAgentFinishingWorkBody());
}

export function buildMemoryNotesSection(): ContextSection {
  return createDynamicSection("Memory Notes", "memory_notes", buildAgentMemoryNotesBody());
}

/** 固定的 token 预算行，是 system 的最后一段；倒数由每次请求的提醒附件表达。开关关闭时不产出。 */
export function buildTotalTokensSection(enabled: boolean): ContextSection | null {
  if (!enabled) return null;
  return createDynamicSection("Total Tokens", "total_tokens", TOTAL_TOKENS_SYSTEM_LINE);
}

function createDynamicSection(
  name: string,
  source: ContextSection["source"],
  content: string,
): ContextSection {
  return {
    name,
    source,
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
