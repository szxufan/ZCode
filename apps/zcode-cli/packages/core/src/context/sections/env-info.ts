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
