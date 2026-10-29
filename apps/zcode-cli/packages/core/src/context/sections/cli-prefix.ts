// ============================================================
// CLI Prefix Section Builder
// ============================================================

import { AGENT_CLI_PREFIX_PROMPT } from "@zcode/shared";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

export function buildCliPrefixSection(): ContextSection {
  const content = AGENT_CLI_PREFIX_PROMPT;

  return {
    name: "CLI Prefix",
    source: "cli_prefix",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
