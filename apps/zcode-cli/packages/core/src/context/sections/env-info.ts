// ============================================================
// Environment Info Section Builder
// ============================================================

import {
  AGENT_ENVIRONMENT_HEADING,
  AGENT_ENV_INVOCATION_LINE,
  AGENT_ENV_LABELS,
  AGENT_GIT_LABELS,
  AGENT_GIT_SYSTEM_CONTEXT_PREFIX,
  agentEnvModelLine,
} from "@zcode/shared";
import type { ContextSection, EnvInfo } from "../types.js";
import type { Model } from "@zcode/contracts";
import { estimateTokens } from "../utils.js";

export function buildEnvInfoSection(
  envInfo: EnvInfo,
  model?: Model,
  additionalDirectories: readonly string[] = [],
): ContextSection {
  const content = buildEnvInfoContent(envInfo, model, additionalDirectories);

  return {
    name: "Environment Info",
    source: "env_info",
    injectionTarget: "system",
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

  const content = buildGitSystemContextContent(envInfo);

  return {
    name: "System Context",
    source: "system_context",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildEnvInfoContent(
  info: EnvInfo,
  model: Model | undefined,
  additionalDirectories: readonly string[],
): string {
  const hasGitRepository = isEnvInfoGitRepository(info);
  const lines: string[] = [
    AGENT_ENVIRONMENT_HEADING,
    AGENT_ENV_INVOCATION_LINE,
    `- ${AGENT_ENV_LABELS.workingDirectory}: ${info.cwd}`,
    // 附加目录此前只进入能力发现，模型看不到目录范围；这里只投影本次运行已解析的路径。
    ...(additionalDirectories.length
      ? [
          `- ${AGENT_ENV_LABELS.additionalDirectories}:`,
          ...additionalDirectories.map((path) => `  - ${path}`),
        ]
      : []),
    `- ${AGENT_ENV_LABELS.isGitRepository}: ${hasGitRepository ? AGENT_ENV_LABELS.yes : AGENT_ENV_LABELS.no}`,
    `- ${AGENT_ENV_LABELS.platform}: ${info.platform}`,
    `- ${AGENT_ENV_LABELS.shell}: ${info.shell}`,
    `- ${AGENT_ENV_LABELS.osVersion}: ${info.osVersion}`,
    // 旧环境快照可能携带历史模型字段；渲染只读取本步骤实际执行的 Model。
    ...(model ? [agentEnvModelLine(model.providerId, model.modelId)] : []),
  ];

  return lines.join("\n");
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

export function isEnvInfoGitRepository(info: EnvInfo): boolean {
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

// ---- 环境公告（快照比较与解析；文案路径保持 fork 中文体系，机制与上游一致） ----

export type EnvironmentSnapshot = Pick<EnvInfo, "cwd" | "platform" | "shell" | "osVersion"> & {
  isGitRepository: boolean;
  /** 本次运行的附加目录（运行配置，不来自 Context Source）。 */
  additionalWorkingDirectories: readonly string[];
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
  // 上游调用方以 (envInfo, additionalDirectories) 二参调用；fork 签名是 (envInfo, model?, additionalDirs?)。
  const sections = [buildEnvInfoSection(envInfo, undefined, additionalDirectories)];
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
  const { cwd, platform, shell, osVersion, isGitRepository, additionalWorkingDirectories } =
    snapshot as Record<string, unknown>;
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
  return {
    full,
    snapshot: {
      cwd,
      platform,
      shell,
      osVersion,
      isGitRepository,
      additionalWorkingDirectories: [...additionalWorkingDirectories],
    },
  };
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

/** 环境更新全量块：直接以快照字段渲染，不经完整 EnvInfo。 */
function buildEnvInfoContentFromSnapshot(snapshot: EnvironmentSnapshot): string {
  // 渲染只读取 snapshot 携带的环境字段；nodeVersion 是 EnvInfo 必填但不在公告里渲染。
  const info = { ...snapshot, nodeVersion: "" } as EnvInfo;
  return buildEnvInfoContent(info, undefined, snapshot.additionalWorkingDirectories);
}

const ENVIRONMENT_UPDATE_HEADING = "# 环境更新";

function pathLines(paths: readonly string[]): string[] {
  return paths.map((path) => `  - ${path}`);
}

export function buildEnvironmentAnnouncement(
  next: EnvironmentSnapshot,
  previous: EnvironmentSnapshot | undefined,
  hasFullBlock: boolean,
): { content: string; environment: EnvironmentAnnouncement } | null {
  const full =
    !previous ||
    !hasFullBlock ||
    previous.platform !== next.platform ||
    previous.shell !== next.shell ||
    previous.osVersion !== next.osVersion;
  if (full) {
    return {
      content: buildEnvInfoContentFromSnapshot(next),
      environment: { full, snapshot: next },
    };
  }
  const lines = [ENVIRONMENT_UPDATE_HEADING];
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
  return lines.length === 1
    ? null
    : { content: lines.join("\n"), environment: { full, snapshot: next } };
}
