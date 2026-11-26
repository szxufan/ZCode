// 计划另存为的文件名与目录候选（docs/ui/plan-detail-side-pane.md「保存计划」）。
// 目录是否存在只有 main 知道：这里只给出候选顺序，由 platform.saveFile 的桌面实现挑第一个存在的。

import type { PlanSaveScope } from "./contract.js";

/** 另存为的首选目录，与 superpowers 的 writing-plans 约定一致。 */
export const PLAN_SAVE_PLANS_DIRECTORY = "docs/superpowers/plans";
/** 没有可用标题时的文件名。 */
const PLAN_SAVE_FALLBACK_TITLE = "plan";
const MAX_PLAN_TITLE_LENGTH = 80;
// Windows 与 macOS 文件名都不允许的字符，加上控制字符（含换行、制表）。
const UNSAFE_PLAN_TITLE_CHARS = /[\\/:*?"<>|\p{Cc}]+/gu;

/**
 * 计划标题：Markdown 首个一级标题；没有则取首个非空行并去掉井号与列表符号；都没有返回 undefined。
 * 代码块里的 `#` 行不是标题，整块跳过。
 */
export function extractPlanTitle(markdown: string): string | undefined {
  const heading = findPlanLine(markdown, true);
  if (heading !== undefined) return heading;
  const firstLine = findPlanLine(markdown, false);
  return firstLine === undefined
    ? undefined
    : firstLine.replace(/^(?:#{1,6}|[-*+]|\d+[.)])\s+/u, "").trim() || undefined;
}

/** 建议文件名：本地日期 + 标题；非法字符与空白折叠为连字符，标题最长 80 个字符。 */
export function buildPlanSaveSuggestedName(input: { markdown: string; now?: Date }): string {
  const now = input.now ?? new Date();
  const date = [now.getFullYear(), pad2(now.getMonth() + 1), pad2(now.getDate())].join("-");
  return `${date}-${sanitizePlanFileTitle(extractPlanTitle(input.markdown) ?? "") || PLAN_SAVE_FALLBACK_TITLE}.md`;
}

/** 另存为的起始目录候选：plans 目录优先，其次工作区根目录；远程工作区或没有路径时不给。 */
export function buildPlanSaveDirectoryCandidates(scope: PlanSaveScope): string[] | undefined {
  if (scope.remote || !scope.workspacePath) return undefined;
  const root = scope.workspacePath.replace(/[\\/]+$/, "");
  return [`${root}/${PLAN_SAVE_PLANS_DIRECTORY}`, root];
}

/** 跳过代码块。levelOne 为真时取首个一级标题，否则取首个非空行。 */
function findPlanLine(markdown: string, levelOne: boolean): string | undefined {
  let inFence = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length === 0) continue;
    if (!levelOne) return line;
    const match = /^#\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

function sanitizePlanFileTitle(title: string): string {
  return title
    .replace(UNSAFE_PLAN_TITLE_CHARS, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .join("-")
    .slice(0, MAX_PLAN_TITLE_LENGTH)
    .replace(/^[.\-\s]+|[.\-\s]+$/gu, "");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
