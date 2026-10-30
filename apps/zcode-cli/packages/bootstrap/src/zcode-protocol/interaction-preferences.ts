import {
  zcodeWorkspaceUpdateAgentPromptPreferencesParamsSchema,
  zcodeWorkspaceUpdateInteractionPreferencesParamsSchema,
} from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 应用 Host 全局交互偏好。共享 CLI 内各工作区收到相同设置，registry 是进程内
 * 主任务、后台任务与子 Agent 共用的权威 gate；Host 按物理连接串行同步。
 */
export async function updateInteractionPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateInteractionPreferencesParamsSchema, rawParams);
  const enabled = params.preferences.askUserQuestionAutoResolutionEnabled;
  context.appRuntimePreferences.askUserQuestionAutoResolutionEnabled = enabled;
  const snoozedInteractionCount =
    await context.v4Interactions.setAskUserQuestionAutoResolutionEnabled(enabled);

  return {
    workspace: params.workspace,
    askUserQuestionAutoResolutionEnabled: enabled,
    snoozedInteractionCount,
  };
}

/**
 * 应用系统提示词覆盖（设置页配置档热切换）。遍历本 workspace 的全部活跃会话：
 * 覆盖是 workspace 级事实（新会话由 runtime-materialization 偏好注入，这里只负责
 * 已存活会话）。turn 中切换由 runtime.updateConfig 的既有语义延迟到下一 turn。
 * `agentSystemPromptOverride: null` 表示回落内置中文提示词（写 undefined 清除覆盖）。
 */
export async function updateAgentPromptPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateAgentPromptPreferencesParamsSchema, rawParams);
  const override = params.agentSystemPromptOverride ?? undefined;
  let appliedToAnySession = false;
  for (const record of context.sessions.values()) {
    record.app.runtime.updateConfig({ systemPromptOverride: override });
    appliedToAnySession = true;
  }

  return {
    workspace: params.workspace,
    applied: appliedToAnySession,
  };
}
