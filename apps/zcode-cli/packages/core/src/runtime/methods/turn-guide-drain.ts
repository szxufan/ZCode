import { EXIT_PLAN_MODE_TOOL_NAME, type Model, type ModelSelection } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import type { ToolExecutionResult } from "../deps.js";
import {
  applySubmissionExecutionState,
  createTurnModel,
  sameModelSelection,
} from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { appendTurnRequestEntries } from "./turn-output-token-continuation.js";
import { applyRuntimeExecutionState } from "../execution-state.js";
import { throwIfTurnAborted } from "../helpers/turn-errors.js";

/**
 * 在合法的 model-step 边界按 FIFO 一次消费全部已等待的 guide，并准备下一次 provider request。
 * SendMessage 可能在 child 的 model request 进行中到达；若该 step 正常
 * text-only 收口，等待未来 tool batch 会把 coordinator input 永久留在无人唤醒的 queue。
 */
export async function drainInlineGuideForNextRequest(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<boolean> {
  // 已停止的轮次不再消费挂起输入，直接结束；guide 由取消路径退回队列。
  throwIfTurnAborted(state.turnAbortSignal);
  const activeTurn = state.activeTurn;
  if (!activeTurn || !runtime.hasInlineGuidePendingInput(activeTurn)) return false;

  const drained = await runtime.drainPendingInput({
    activeTurn,
    events: state.events,
    traceContext: state.turnTraceContext,
  });
  if (!drained || drained.pendingInputIds.length === 0) return false;

  state.drainedSteerForNextRequest = drained;
  appendTurnRequestEntries(state.turnRequestState, drained.runtimeEntries ?? []);
  // 固定执行模型只禁止切模，不应连带丢弃 Guide 的权限／Plan 意图。
  if (state.modelSelectionScope === "execution" && drained.intent) {
    await applyRuntimeExecutionState(runtime, drained.intent, {
      source: "command",
      traceContext: state.turnTraceContext,
    });
  }
  const guideModel =
    state.modelSelectionScope === "execution"
      ? undefined
      : await applySubmissionExecutionState(runtime, drained?.intent, state.turnTraceContext);
  if (guideModel) adoptLoopModel(runtime, state, guideModel);
  state.currentUserMessageId = drained?.latestMessageId ?? state.currentUserMessageId;
  const nextQueryId = drained?.queryIds?.at(-1);
  if (nextQueryId) {
    // guide 以 user role 续上当前 active turn；后续请求归因到最后一条输入的 query。
    state.turnTraceContext = { ...state.turnTraceContext, queryId: nextQueryId };
  }
  // 旧端的 guide 合入同一轮不能借用原附件能力；一批多个输入取交集。
  state.pluginDiscoveryUi = state.pluginDiscoveryUi && drained.pluginDiscoveryUi === true;
  if ((drained.toolDisallowlist?.length ?? 0) > 0) {
    // automation guide 不会重新 start turn，必须把限制合并到当前 loop state。
    state.toolDisallowlist = [
      ...new Set([...(state.toolDisallowlist ?? []), ...(drained.toolDisallowlist ?? [])]),
    ];
  }
  state.repeatedToolCallSignature = undefined;
  state.repeatedToolCallStreakCount = 0;
  return true;
}

/** 把 Loop 的执行 Model 换成 model；选择变了才重建上下文前缀。guide 与计划批准共用。 */
function adoptLoopModel(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  model: Model,
): void {
  // 配置重新解析不等于切模；比较 Loop 的执行选择，而不是可能已被外部更新的 Session。
  const selectionChanged = !sameModelSelection(state.model, model);
  state.model = model;
  if (selectionChanged) {
    state.turnRequestState.entries = rebuildContextPrefix(runtime, {
      model,
      turnRequestEntries: state.turnRequestState.entries,
    });
  }
}

/** 本批是否有成功的 ExitPlanMode 结果带了执行模型选择，即用户批准时选了另一个模型。 */
export function hasPlanApprovalExecutionModelSelection(
  results: readonly ToolExecutionResult[],
): boolean {
  return results.some(
    (result) =>
      result.success &&
      result.toolName === EXIT_PLAN_MODE_TOOL_NAME &&
      result.executionModelSelection !== undefined,
  );
}

/**
 * 计划批准携带执行模型（docs/specs/plan-approval-execution-model.md）：让 Loop 在下一步跟上会话选择。
 * 会话选择已由界面经 switchModelConfig 命令路径提交并发过 ModelSelected，所以这里只读它来创建 Model，
 * 不接纳、不落库、不重复发事件。调用点在工具批次结算之后、drain 之前：带意图的 guide 仍然后消费、优先。
 */
export function adoptSessionModelAfterPlanApproval(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): boolean {
  // 固定执行模型的轮次与 guide 同规则：只是不切模，已批准的这一轮照常继续。
  if (state.modelSelectionScope === "execution") return false;
  // 会话还没有选择，或与 Loop 当前 Model 一致时，连新 Model 都不创建。
  const selection = runtime.getSessionModelSelection();
  if (!selection || loopModelMatchesSelection(state.model, selection)) return false;
  try {
    adoptLoopModel(runtime, state, createTurnModel(runtime));
    return true;
  } catch (error) {
    // 批准已经生效，换模只是附加动作：失败不能让已批准的轮次失败，保持原模型继续本轮。
    runtime.logger?.warn("Plan execution model adoption failed; keeping the current Model", {
      error: error instanceof Error ? error.message : String(error),
      event: "turn.plan_execution_model.adopt_failed",
      module: "core.runtime",
      status: "failed",
    });
    return false;
  }
}

function loopModelMatchesSelection(model: Model | undefined, selection: ModelSelection): boolean {
  return (
    model !== undefined &&
    model.providerId === selection.providerId &&
    model.modelId === selection.modelId &&
    model.options?.reasoningLevel === selection.options?.reasoningLevel
  );
}
