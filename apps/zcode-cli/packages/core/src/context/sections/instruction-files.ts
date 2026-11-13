// ============================================================
// Instruction file blocks and change announcements
// ============================================================

import { createHash } from "node:crypto";

import { AGENT_AGENTSMD_INTRO } from "@zcode/shared";

import type {
  InstructionAnnouncement,
  InstructionFile,
  InstructionRefreshReason,
} from "../types.js";

// fork 中文文案体系：preamble 复用共享包的 agentsMd 引言，类型与文件块保持中文措辞。
export const INSTRUCTIONS_PREAMBLE = AGENT_AGENTSMD_INTRO;

export const INSTRUCTION_TYPE_PROJECT = "工作区指令，随代码库提交";
export const INSTRUCTION_TYPE_USER = "用户全局默认指令，对所有项目生效";
export const INSTRUCTION_TYPE_AUTO_MEMORY = "用户自动记忆，跨会话持久保存";

const INSTRUCTION_TYPES = [
  INSTRUCTION_TYPE_PROJECT,
  INSTRUCTION_TYPE_USER,
  INSTRUCTION_TYPE_AUTO_MEMORY,
] as const;

const REFRESH_REASON_TEXT: Record<InstructionRefreshReason, string> = {
  session_start: "本会话开始时",
  compaction: "会话压缩后",
};

export function renderInstructionFile(file: InstructionFile): string {
  return `以下是 ${file.path} 的内容（${file.type}）：\n\n${file.body}`;
}

/** 完整公告：preamble 加全部文件块。 */
export function renderInstructionAnnouncement(files: readonly InstructionFile[]): string {
  return `${INSTRUCTIONS_PREAMBLE}\n\n${files.map(renderInstructionFile).join("\n\n")}`;
}

/**
 * 增量公告：变化或新增的文件共用一句说明，再跟完整文件块；每个删除的文件一段。
 * 只有删除时首段只说明已重读。段落之间空一行。
 */
export function renderInstructionDelta(
  changed: readonly InstructionFile[],
  removed: readonly string[],
  reason: InstructionRefreshReason,
): string {
  const reread = `指令文件已在${REFRESH_REASON_TEXT[reason]}重新读取`;
  const head =
    changed.length > 0
      ? `${reread}；以下文件与先前的副本不同——每份都替换其先前副本，且上方的指令引言仍然适用：\n\n${changed.map(renderInstructionFile).join("\n\n")}`
      : `${reread}。`;
  return [head, ...removed.map((path) => `不再存在的指令：${path}`)].join("\n\n");
}

/**
 * 构建指令文件：正文去掉首尾空白，hash 在这里算一次。
 * 优化原因：持有的文件只在读取时变化，原来每次请求前都对每个文件重新算 sha256。
 */
export function createInstructionFile(path: string, type: string, body: string): InstructionFile {
  const trimmed = body.trim();
  return { path, type, body: trimmed, hash: createHash("sha256").update(trimmed).digest("hex") };
}

export function instructionFileRecord(
  file: InstructionFile,
): InstructionAnnouncement["files"][number] {
  return { path: file.path, type: file.type, hash: file.hash };
}

export function parseInstructionAnnouncement(value: unknown): InstructionAnnouncement | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { files, removed, reason } = value as Record<string, unknown>;
  if (!Array.isArray(files)) return undefined;
  const parsedFiles: InstructionAnnouncement["files"] = [];
  for (const file of files) {
    if (typeof file !== "object" || file === null) return undefined;
    const { path, type, hash } = file as Record<string, unknown>;
    if (typeof path !== "string" || typeof type !== "string" || typeof hash !== "string")
      return undefined;
    parsedFiles.push({ path, type, hash });
  }
  if (
    removed !== undefined &&
    (!Array.isArray(removed) || !removed.every((path) => typeof path === "string"))
  )
    return undefined;
  if (reason !== undefined && reason !== "session_start" && reason !== "compaction")
    return undefined;
  return {
    files: parsedFiles,
    ...(removed && removed.length > 0 ? { removed: [...(removed as string[])] } : {}),
    ...(reason ? { reason } : {}),
  };
}

const LEGACY_TYPE_ALIASES: Record<string, string> = {
  [INSTRUCTION_TYPE_PROJECT]: INSTRUCTION_TYPE_PROJECT,
  [INSTRUCTION_TYPE_USER]: INSTRUCTION_TYPE_USER,
  [INSTRUCTION_TYPE_AUTO_MEMORY]: INSTRUCTION_TYPE_AUTO_MEMORY,
  "project instructions, checked into the codebase": INSTRUCTION_TYPE_PROJECT,
  "user's private global instructions for all projects": INSTRUCTION_TYPE_USER,
  "user's auto-memory, persists across conversations": INSTRUCTION_TYPE_AUTO_MEMORY,
};
const LEGACY_TYPE_PATTERN = Object.keys(LEGACY_TYPE_ALIASES).map(escapeRegExp).join("|");
// 兼容上游英文旧公告与 fork 中文旧公告；没有兼容匹配时会把所有文件误判为已变化。
const LEGACY_HEADING = new RegExp(
  `^(?:Contents of (.+) \\((${LEGACY_TYPE_PATTERN})\\):|以下是 (.+) 的内容（(${LEGACY_TYPE_PATTERN})）：)$`,
  "gm",
);

/**
 * 没有 metadata 的旧完整公告：按标题行拆出文件。正文到下一个标题行为止，与新记录同样 trim 后取哈希。
 */
export function parseLegacyInstructionFiles(content: string): InstructionAnnouncement["files"] {
  const headings = [...content.matchAll(LEGACY_HEADING)];
  return headings.map((heading, index) => {
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? content.length;
    const path = heading[1] ?? heading[3]!;
    const rawType = heading[2] ?? heading[4]!;
    return instructionFileRecord(
      createInstructionFile(path, LEGACY_TYPE_ALIASES[rawType]!, content.slice(start, end)),
    );
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
