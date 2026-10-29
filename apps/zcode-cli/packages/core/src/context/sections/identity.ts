// ============================================================
// Identity Section Builder
// ============================================================

import { AGENT_SECURITY_NOTICE, buildAgentHarnessBlock, buildAgentIdentityBody } from "@zcode/shared";
import type { ContextSection } from "../types.js";
import type { OutputStylePromptConfig } from "../types.js";
import { estimateTokens } from "../utils.js";

/** 安全 IMPORTANT 行：交互式身份与工作流子代理身份共用，逐字同一份（文案唯一来源在 shared）。 */
export function buildSecurityNotice(): string {
  return AGENT_SECURITY_NOTICE;
}

/**
 * `# Harness` 块：稳定运行时约束，不属于 output style 可替换的 coding instructions，
 * 也是工作流子代理身份（sections/workflow-actor.ts）逐字复用的那一段。
 */
export function buildHarnessBlock(): string {
  return buildAgentHarnessBlock();
}

function buildIdentityPrompt(outputStyle?: OutputStylePromptConfig): string {
  return buildAgentIdentityBody(Boolean(outputStyle));
}

export function buildIdentitySection(outputStyle?: OutputStylePromptConfig): ContextSection {
  const content = buildIdentityPrompt(outputStyle);

  return {
    name: "Agent Identity",
    source: "identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
