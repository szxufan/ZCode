// ============================================================
// Memory Section Builder
// ============================================================

import { agentMemorySectionCopy } from "@zcode/shared";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";
import type { ProjectMemoryRetrievalBranch } from "../../memory/project-memory-retrieval-branch.js";

export function buildMemorySection(
  memoryRoot: string | undefined,
  retrievalBranch: ProjectMemoryRetrievalBranch,
): ContextSection | null {
  if (!memoryRoot) return null;

  const content = agentMemorySectionCopy(memoryRoot, retrievalBranch);

  return {
    name: "Memory",
    source: "memory",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
