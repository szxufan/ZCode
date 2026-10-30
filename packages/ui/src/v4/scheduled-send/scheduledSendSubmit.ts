// composer 定时发送的提交入参构造：纯函数，便于单测覆盖一次性 automation 的字段约定。
//
// 约束：relativeDelayMinutes + recurring=false 二选一替代 cronExpr（服务层据此生成锚点规则）；
// 已有会话带 targetTaskId 注入原会话，草稿态缺省则到点由 Host fallback 新建会话。
import type { ModelSelection } from "@zcode/shared";
import type { ZCodeAgentCreateAutomationParams } from "./contract.js";
import { MAX_DELAY_MINUTES, toDelayMinutes } from "./scheduledSendTime.js";

export type ScheduledSendSubmitOutcome =
  | { ok: true; params: ZCodeAgentCreateAutomationParams }
  | { ok: false; reason: "emptyPrompt" | "invalidTime" | "tooFar" };

export interface BuildScheduledSendParamsInput {
  prompt: string;
  /** 目标绝对时刻（毫秒）。 */
  targetMs: number;
  now?: number;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string | null;
  modelSelection?: ModelSelection;
  mode?: string;
}

/** automation 标题取首行并截断，避免整段 prompt 变成任务列表里的长标题。 */
export function deriveScheduledSendTitle(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim().length > 0) ?? prompt;
  const trimmed = firstLine.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
}

export function buildScheduledSendAutomationParams(
  input: BuildScheduledSendParamsInput,
): ScheduledSendSubmitOutcome {
  const prompt = input.prompt.trim();
  if (!prompt) return { ok: false, reason: "emptyPrompt" };
  const now = input.now ?? Date.now();
  if (input.targetMs <= now) return { ok: false, reason: "invalidTime" };
  const delay = toDelayMinutes(input.targetMs, now);
  if (delay === null) {
    const tooFar = input.targetMs - now > MAX_DELAY_MINUTES * 60_000;
    return { ok: false, reason: tooFar ? "tooFar" : "invalidTime" };
  }
  return {
    ok: true,
    params: {
      workspacePath: input.workspacePath,
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      title: deriveScheduledSendTitle(prompt),
      prompt,
      relativeDelayMinutes: delay,
      recurring: false,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.sessionId ? { targetTaskId: input.sessionId } : {}),
    },
  };
}
