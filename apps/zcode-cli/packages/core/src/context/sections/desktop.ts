import { agentDesktopContextCopy } from "@zcode/shared";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

// Desktop 段由环境公告发送，不进 system：呈现面与灰度是进程级事实，Gen UI 目录随会话变化，
// 而 system 由 prompt 快照冻结到压缩。section 只作开关与用量统计，正文见 buildDesktopContextContent。
// fork：正文沿用共享包中文文案 agentDesktopContextCopy。
export function buildDesktopContextSection(hasGenUiOutputDirectory = false): ContextSection {
  return createDesktopSection(
    "ZCode Desktop Context",
    "desktop_context",
    buildDesktopContextContent(hasGenUiOutputDirectory),
  );
}

/** Desktop 段正文；插件关闭时不提供输出目录，整段 Gen UI 上下文随之省略。 */
export function buildDesktopContextContent(hasGenUiOutputDirectory: boolean): string {
  return agentDesktopContextCopy(hasGenUiOutputDirectory);
}


function createDesktopSection(
  name: string,
  source: ContextSection["source"],
  content: string,
): ContextSection {
  return {
    name,
    source,
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
