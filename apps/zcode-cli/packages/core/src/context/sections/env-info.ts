// ============================================================
// Environment Info Section Builder
// ============================================================

import {
  AGENT_ENVIRONMENT_HEADING,
  AGENT_ENV_INVOCATION_LINE,
  AGENT_ENV_LABELS,
  AGENT_ENV_UNTRUSTED_NOTE,
  AGENT_GIT_LABELS,
  AGENT_GIT_SYSTEM_CONTEXT_PREFIX,
  AGENT_META_USER_CLOSING,
  AGENT_META_USER_OPENING,
  agentEnvModelLine,
} from "@zcode/shared";
import type { ContextSection, EnvInfo } from "../types.js";
import type { Model } from "@zcode/contracts";
import { estimateTokens } from "../utils.js";
import { buildDesktopContextContent } from "./desktop.js";

// 上游 v3.18：离开 Desktop 后追加的一句说明；fork 中文译文。
const DESKTOP_CONTEXT_NO_LONGER_APPLIES =
  "上述 ZCode Desktop 上下文不再适用：本会话未显示在 ZCode Desktop 中。";

export type EnvironmentSnapshot = Pick<EnvInfo, "cwd" | "platform" | "shell" | "osVersion"> & {
  isGitRepository: boolean;
  /** 本次运行的附加目录（运行配置，不来自 Context Source）。 */
  additionalWorkingDirectories: readonly string[];
  /** 会话的 Gen UI 输出目录；只在 Desktop 段声明支持 Gen UI 时有。旧元数据没有这个字段。 */
  visualizationDirectory?: string;
  /** 本次运行在 ZCode Desktop 呈现面时为 true，环境块带 Desktop 段。旧元数据没有这个字段，算不在。 */
  desktopContext?: boolean;
};

export interface EnvironmentAnnouncement {
  snapshot: EnvironmentSnapshot;
  full: boolean;
}

// 专用 agent 正文与环境上下文分开组装，避免走 custom system 分支时漏掉环境或复制另一套文案。
export function buildEnvironmentSections(
  envInfo: EnvInfo,
  model?: Model,
  additionalDirectories: readonly string[] = [],
): ContextSection[] {
  const sections = [buildEnvInfoSection(envInfo, additionalDirectories)];
  const modelSection = buildModelSection(model);
  if (modelSection) sections.push(modelSection);
  return sections;
}

export function environmentSnapshot(
  info: EnvInfo,
  additionalDirectories: readonly string[] = [],
): EnvironmentSnapshot {
  return {
    cwd: info.cwd,
    platform: info.platform,
    shell: info.shell,
    osVersion: info.osVersion,
    isGitRepository: isEnvInfoGitRepository(info),
    additionalWorkingDirectories: [...additionalDirectories],
  };
}

export function parseEnvironmentAnnouncement(value: unknown): EnvironmentAnnouncement | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { full, snapshot } = value as Record<string, unknown>;
  if (typeof full !== "boolean" || typeof snapshot !== "object" || snapshot === null)
    return undefined;
  const {
    cwd,
    platform,
    shell,
    osVersion,
    isGitRepository,
    additionalWorkingDirectories,
    visualizationDirectory,
    desktopContext,
  } = snapshot as Record<string, unknown>;
  if (
    typeof cwd !== "string" ||
    typeof platform !== "string" ||
    typeof shell !== "string" ||
    typeof osVersion !== "string" ||
    typeof isGitRepository !== "boolean"
  )
    return undefined;
  if (
    !Array.isArray(additionalWorkingDirectories) ||
    !additionalWorkingDirectories.every((path) => typeof path === "string")
  )
    return undefined;
  if (visualizationDirectory !== undefined && typeof visualizationDirectory !== "string")
    return undefined;
  if (desktopContext !== undefined && typeof desktopContext !== "boolean") return undefined;
  return {
    full,
    snapshot: {
      cwd,
      platform,
      shell,
      osVersion,
      isGitRepository,
      additionalWorkingDirectories: [...(additionalWorkingDirectories as string[])],
      ...(visualizationDirectory !== undefined ? { visualizationDirectory } : {}),
      ...(desktopContext !== undefined ? { desktopContext } : {}),
    },
  };
}

export function buildEnvironmentAnnouncement(
  next: EnvironmentSnapshot,
  previous: EnvironmentSnapshot | undefined,
  hasFullBlock: boolean,
): { content: string; environment: EnvironmentAnnouncement } | null {
  // shell 跟随最新设置，新 runtime（冷恢复）可能读到另一个 shell；与目录一样只追加变化行，不整块重发。
  const full =
    !previous ||
    !hasFullBlock ||
    previous.platform !== next.platform ||
    previous.osVersion !== next.osVersion;
  if (full) return { content: buildEnvInfoContent(next), environment: { full, snapshot: next } };
  const lines = ["# 环境更新"];
  if (previous.cwd !== next.cwd) {
    lines.push(` - ${AGENT_ENV_LABELS.workingDirectory}: ${next.cwd}（原为 ${previous.cwd}）`);
  }
  if (previous.isGitRepository !== next.isGitRepository) {
    lines.push(
      ` - ${AGENT_ENV_LABELS.isGitRepository}: ${next.isGitRepository ? AGENT_ENV_LABELS.yes : AGENT_ENV_LABELS.no}（原为 ${previous.isGitRepository ? AGENT_ENV_LABELS.yes : AGENT_ENV_LABELS.no}）`,
    );
  }
  const before = new Set(previous.additionalWorkingDirectories);
  const after = new Set(next.additionalWorkingDirectories);
  const added = next.additionalWorkingDirectories.filter((path) => !before.has(path));
  const removed = previous.additionalWorkingDirectories.filter((path) => !after.has(path));
  if (added.length > 0) {
    lines.push(" - 新增附加工作目录:", ...pathLines(added));
  }
  if (removed.length > 0) {
    lines.push(" - 移除附加工作目录:", ...pathLines(removed));
  }
  if (previous.visualizationDirectory !== next.visualizationDirectory) {
    const was = previous.visualizationDirectory
      ? `（原为 ${previous.visualizationDirectory}）`
      : "";
    lines.push(
      ` - ${AGENT_ENV_LABELS.visualizationDirectory}: ${next.visualizationDirectory ?? "无"}${was}`,
    );
  }
  if (previous.shell !== next.shell) {
    // 旧 Windows 会话的 Shell 可能为空，没有可写的旧值。
    const was = previous.shell ? `（原为 ${previous.shell}）` : "";
    lines.push(` - ${AGENT_ENV_LABELS.shell}: ${next.shell}${was}`);
  }
  const parts = lines.length === 1 ? [] : [lines.join("\n")];
  // Desktop 段按写法比较：换了写法追加整段新写法，离开 Desktop 追加一句不再适用。
  const previousDesktop = desktopContextText(previous);
  const nextDesktop = desktopContextText(next);
  if (previousDesktop !== nextDesktop) parts.push(nextDesktop ?? DESKTOP_CONTEXT_NO_LONGER_APPLIES);
  return parts.length === 0
    ? null
    : { content: parts.join("\n\n"), environment: { full, snapshot: next } };
}

/** 环境块里的 Desktop 段：不在 Desktop 时没有；在 Desktop 时按是否有 Gen UI 目录取写法。 */
function desktopContextText(snapshot: EnvironmentSnapshot): string | undefined {
  return snapshot.desktopContext
    ? buildDesktopContextContent(Boolean(snapshot.visualizationDirectory))
    : undefined;
}

// 上游 v3.18：环境与 Git 系统上下文改为 meta_user 公告（source: env_info / session_context），
// 运行时按当前事实宣告，不进 system；文案路径保持 fork 中文体系。
export function buildEnvInfoSection(
  envInfo: EnvInfo,
  additionalDirectories: readonly string[] = [],
): ContextSection {
  const content = buildEnvInfoContent(environmentSnapshot(envInfo, additionalDirectories));

  return {
    name: "Environment Info",
    source: "env_info",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

export function buildGitSystemContextSection(envInfo: EnvInfo): ContextSection | null {
  if (!isEnvInfoGitRepository(envInfo)) {
    return null;
  }

  const content = [
    AGENT_META_USER_OPENING,
    buildGitSystemContextContent(envInfo),
    "",
    AGENT_META_USER_CLOSING,
  ].join("\n");

  return {
    name: "Session Context",
    source: "session_context",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildEnvInfoContent(info: EnvironmentSnapshot): string {
  const directories = info.additionalWorkingDirectories;
  const lines: string[] = [
    AGENT_ENVIRONMENT_HEADING,
    AGENT_ENV_INVOCATION_LINE,
    ` - ${AGENT_ENV_LABELS.workingDirectory}: ${info.cwd}`,
    // 附加目录此前只进入能力发现，模型看不到目录范围；这里只投影本次运行已解析的路径。
    ...(directories.length > 0
      ? [` - ${AGENT_ENV_LABELS.additionalDirectories}:`, ...pathLines(directories)]
      : []),
    ...(info.visualizationDirectory
      ? [` - ${AGENT_ENV_LABELS.visualizationDirectory}: ${info.visualizationDirectory}`]
      : []),
    ` - ${AGENT_ENV_LABELS.isGitRepository}: ${info.isGitRepository ? AGENT_ENV_LABELS.yes : AGENT_ENV_LABELS.no}`,
    ` - ${AGENT_ENV_LABELS.platform}: ${info.platform}`,
    ` - ${AGENT_ENV_LABELS.shell}: ${info.shell}`,
    ` - ${AGENT_ENV_LABELS.osVersion}: ${info.osVersion}`,
    ` - ${AGENT_ENV_UNTRUSTED_NOTE}`,
  ];
  const desktop = desktopContextText(info);
  return desktop ? `${lines.join("\n")}\n\n${desktop}` : lines.join("\n");
}

function pathLines(paths: readonly string[]): string[] {
  return paths.map((path) => `  - ${path}`);
}

function buildGitSystemContextContent(info: EnvInfo): string {
  const lines: string[] = [AGENT_GIT_SYSTEM_CONTEXT_PREFIX];

  if (info.gitBranch) {
    lines.push("", `${AGENT_GIT_LABELS.currentBranch}: ${info.gitBranch}`);
  }
  if (info.gitMainBranch) {
    lines.push("", `${AGENT_GIT_LABELS.mainBranch}: ${info.gitMainBranch}`);
  }
  if (info.gitUser) {
    lines.push("", `${AGENT_GIT_LABELS.gitUser}: ${info.gitUser}`);
  }

  lines.push("", `${AGENT_GIT_LABELS.status}:\n${formatGitStatus(info)}`);
  lines.push("", `${AGENT_GIT_LABELS.recentCommits}:\n${formatRecentCommits(info)}`);

  return lines.join("\n");
}

export function isEnvInfoGitRepository(
  info: Pick<EnvInfo, "isGitRepository" | "gitStatus" | "gitBranch">,
): boolean {
  return (
    info.isGitRepository ??
    (info.gitStatus !== undefined ? info.gitStatus !== "not_repo" : Boolean(info.gitBranch))
  );
}

function formatGitStatus(info: EnvInfo): string {
  if (info.gitStatusLines && info.gitStatusLines.length > 0) {
    return info.gitStatusLines.join("\n");
  }
  if (info.gitStatus === "dirty") {
    return AGENT_GIT_LABELS.dirty;
  }
  if (info.gitStatus === "clean") {
    return AGENT_GIT_LABELS.clean;
  }
  return AGENT_GIT_LABELS.unknown;
}

function formatRecentCommits(info: EnvInfo): string {
  if (info.recentCommits && info.recentCommits.length > 0) {
    return info.recentCommits.join("\n");
  }
  return "";
}

export function buildModelSection(model: Model | undefined): ContextSection | null {
  if (!model) return null;
  // 模型身份只来自当前执行句柄，不从会话选择或环境快照推断。
  const content = agentEnvModelLine(model.providerId, model.modelId);
  return {
    name: "Model Identity",
    source: "model",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    content,
    chars: content.length,
    tokens: estimateTokens(content),
    preview: content.slice(0, 100),
  };
}
