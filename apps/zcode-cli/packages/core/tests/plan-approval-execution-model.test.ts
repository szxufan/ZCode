import { describe, expect, it, vi } from "vitest";
import {
  createModelId,
  createModelProviderId,
  EXIT_PLAN_MODE_TOOL_NAME,
  type Model,
  type ModelSelection,
  type ToolExecutionResult,
} from "@zcode/contracts";
import {
  adoptSessionModelAfterPlanApproval,
  hasPlanApprovalExecutionModelSelection,
} from "../src/runtime/methods/turn-guide-drain.js";
import { interpretPermissionResponse } from "../src/tool/executor/permission-response.js";

// 计划批准携带执行模型（docs/specs/plan-approval-execution-model.md）：当前轮在工具批次结算后
// 跟上会话选择，下一步请求即用新模型。会话选择已由界面经 switchModelConfig 命令路径提交，
// 这里只读它来创建 Model，不重复写会话选择，也不重复发 ModelSelected。

const SESSION_SELECTION_A: ModelSelection = {
  providerId: "provider-a",
  modelId: "model-a",
};
const SESSION_SELECTION_B: ModelSelection = {
  providerId: "provider-b",
  modelId: "model-b",
  options: { reasoningLevel: "high" },
};

function createHarness(input: { sessionSelection: ModelSelection; createError?: Error }) {
  const currentModel = createModel("provider-a", "model-a");
  const nextModel = createModel(
    input.sessionSelection.providerId,
    input.sessionSelection.modelId,
    input.sessionSelection.options?.reasoningLevel,
  );
  let canonicalEntries = [
    { message: { role: "system" as const, content: "old context" } },
    { message: { role: "user" as const, content: "original prompt" } },
  ];
  const logger = { warn: vi.fn() };
  const runtime = {
    activeTurn: { pendingInputs: [] },
    config: { mode: "build", modelSelection: input.sessionSelection },
    contextBuilder: { build: vi.fn() },
    contextInitialized: true,
    contextSourceSnapshot: {
      currentDate: "2026-11-26",
      envInfo: {
        cwd: "/workspace",
        nodeVersion: "test",
        osVersion: "test",
        platform: "test",
        shell: "test",
      },
      workingDirectory: "/workspace",
    },
    createContextBuilderFromSnapshot: vi.fn(() => ({
      build: () => ({
        metaUserAttachments: [],
        systemMessages: [
          {
            role: "system" as const,
            content: `${input.sessionSelection.providerId}/${input.sessionSelection.modelId} context`,
          },
        ],
      }),
    })),
    emitModelSelected: vi.fn(),
    getSessionModelSelection: () => structuredClone(input.sessionSelection),
    logger,
    messageHistory: {
      borrowReadOnlyRuntimeEntries: () => canonicalEntries,
      replaceMessages: vi.fn((entries) => {
        canonicalEntries = entries;
      }),
    },
    modelFactory: vi.fn(() => {
      if (input.createError) throw input.createError;
      return nextModel;
    }),
    rootTraceContext: { traceId: "plan-approval-trace" },
    sessionStore: { saveSessionEntry: vi.fn(async () => undefined) },
    sessionId: "plan-session",
    setSessionModelSelection: vi.fn(),
  };
  const state = {
    activeTurn: runtime.activeTurn,
    model: currentModel,
    turnTraceContext: { traceId: "plan-approval-trace" },
    turnRequestState: {
      entries: canonicalEntries,
      outputTokenContinuationCount: 0,
    },
  };
  return { currentModel, logger, runtime, state };
}

describe("adoptSessionModelAfterPlanApproval", () => {
  it("让当前轮在下一步用会话选择创建的 Model，并重建前缀", async () => {
    const { runtime, state } = createHarness({ sessionSelection: SESSION_SELECTION_B });

    const adopted = await adoptSessionModelAfterPlanApproval(runtime as never, state as never);

    expect(adopted).toBe(true);
    expect(runtime.modelFactory).toHaveBeenCalledWith(
      expect.objectContaining({ selection: SESSION_SELECTION_B }),
    );
    expect(state.model).toMatchObject({
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "high" },
    });
    expect(JSON.stringify(state.turnRequestState.entries)).toContain("provider-b/model-b context");
    expect(JSON.stringify(state.turnRequestState.entries)).not.toContain("old context");
    // 会话选择与 ModelSelected 都已由 switchModelConfig 命令路径落地，这里不重复写、不重复发。
    expect(runtime.setSessionModelSelection).not.toHaveBeenCalled();
    expect(runtime.sessionStore.saveSessionEntry).not.toHaveBeenCalled();
    expect(runtime.emitModelSelected).not.toHaveBeenCalled();
  });

  it("会话选择没变时保留当前 Model 对象，也不重建前缀", async () => {
    const { currentModel, runtime, state } = createHarness({
      sessionSelection: SESSION_SELECTION_A,
    });
    const entriesBefore = state.turnRequestState.entries;

    const adopted = await adoptSessionModelAfterPlanApproval(runtime as never, state as never);

    expect(adopted).toBe(false);
    expect(state.model).toBe(currentModel);
    expect(state.turnRequestState.entries).toBe(entriesBefore);
    expect(runtime.modelFactory).not.toHaveBeenCalled();
    expect(runtime.createContextBuilderFromSnapshot).not.toHaveBeenCalled();
  });

  it("固定执行模型的轮次不换模", async () => {
    const { currentModel, runtime, state } = createHarness({
      sessionSelection: SESSION_SELECTION_B,
    });
    state.modelSelectionScope = "execution";

    const adopted = await adoptSessionModelAfterPlanApproval(runtime as never, state as never);

    expect(adopted).toBe(false);
    expect(state.model).toBe(currentModel);
    expect(runtime.modelFactory).not.toHaveBeenCalled();
  });

  it("新 Model 创建失败时保持原模型继续本轮，并记一条 warn", async () => {
    const { currentModel, logger, runtime, state } = createHarness({
      sessionSelection: SESSION_SELECTION_B,
      createError: new Error("provider.notInRegistry"),
    });

    const adopted = await adoptSessionModelAfterPlanApproval(runtime as never, state as never);

    expect(adopted).toBe(false);
    expect(state.model).toBe(currentModel);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe("hasPlanApprovalExecutionModelSelection", () => {
  const result = (overrides: Partial<ToolExecutionResult>): ToolExecutionResult => ({
    toolCallId: "call-1",
    toolName: EXIT_PLAN_MODE_TOOL_NAME,
    success: true,
    output: {},
    durationMs: 1,
    startedAt: new Date(),
    completedAt: new Date(),
    ...overrides,
  });

  it("只有成功的 ExitPlanMode 结果携带选择时才成立", () => {
    expect(
      hasPlanApprovalExecutionModelSelection([
        result({ executionModelSelection: SESSION_SELECTION_B }),
      ]),
    ).toBe(true);
    expect(
      hasPlanApprovalExecutionModelSelection([
        result({ success: false, executionModelSelection: SESSION_SELECTION_B }),
      ]),
    ).toBe(false);
    expect(hasPlanApprovalExecutionModelSelection([result({})])).toBe(false);
    expect(
      hasPlanApprovalExecutionModelSelection([
        result({ toolName: "Read", executionModelSelection: SESSION_SELECTION_B }),
      ]),
    ).toBe(false);
  });
});

describe("permission response passthrough", () => {
  function guardedTransition(executionModelSelection: unknown) {
    return interpretPermissionResponse({
      deps: {} as never,
      toolCall: { id: "call-1", name: EXIT_PLAN_MODE_TOOL_NAME } as never,
      entry: {} as never,
      input: { plan: "计划" },
      mode: "guarded",
      decision: {
        decision: "allow",
        allowed: true,
        escalated: false,
        mode: "guarded",
        ruleId: "r1",
        riskLevel: "low",
      },
      outcome: { source: "broker", result: { decision: "allow", executionModelSelection } },
      requestId: "request-1",
    } as never);
  }

  it("放行时把执行模型选择带到权限结果", () => {
    expect(guardedTransition(SESSION_SELECTION_B)).toEqual({
      kind: "complete",
      result: {
        allowed: true,
        executionInput: { plan: "计划" },
        executionModelSelection: SESSION_SELECTION_B,
      },
    });
  });

  it("guarded 模式拒绝形状不合法的执行模型选择", () => {
    expect(() => guardedTransition({ providerId: "provider-b" })).toThrow(
      /Invalid permission response/,
    );
  });
});

function createModel(providerId: string, modelId: string, reasoningLevel?: string): Model {
  return {
    providerId: createModelProviderId(providerId),
    modelId: createModelId(modelId),
    properties: {
      contextWindow: 128_000,
      supportsMidConversationSystem: false,
      supportsNativeWebSearch: false,
      supportsJsonSchemaOutput: true,
      supportsToolCall: true,
    },
    optionSpecs: {
      reasoningLevel: {
        values: ["low", "high"],
      },
      maxOutputTokens: { max: 8_000 },
    },
    options: { reasoningLevel, maxOutputTokens: 8_000 },
    bind() {
      return this;
    },
    async generateText() {
      throw new Error("not used");
    },
    async *streamText() {
      throw new Error("not used");
    },
  };
}
