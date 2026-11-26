// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelection, ZCodeElicitationRequest } from "@zcode/shared";
import {
  ElicitationDialog,
  withPlanExecutionModelSelection,
  type NormalizedElicitationQuestion,
} from "@/ElicitationDialog.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// 审批弹窗的执行模型（docs/specs/plan-approval-execution-model.md）：只有「批准」且没有自定义反馈时，
// 提交才把执行模型并进 content；onRespond 返回 Promise 期间禁用按钮，返回 false 时弹窗保持打开。

const QUESTION = "Review this implementation plan.";
const SELECTION: ModelSelection = {
  providerId: "provider-b",
  modelId: "model-b",
  options: { reasoningLevel: "high" },
};
const BASE_CONTENT = { answer: "approve" };

const question: NormalizedElicitationQuestion = {
  key: `0:${QUESTION}`,
  question: QUESTION,
  header: "Plan",
  options: [{ value: "approve", label: "Approve" }],
};
const APPROVE_ONLY = { [question.key]: { selectedValues: ["approve"], customAnswer: "" } };

const planRequest: ZCodeElicitationRequest = {
  type: "elicitation_request",
  taskId: "session-plan",
  traceId: "trace-plan" as never,
  requestId: "request-plan",
  message: QUESTION,
  header: "Plan",
  options: [{ value: "approve", label: "Approve" }],
  questions: [
    { question: QUESTION, header: "Plan", options: [{ value: "approve", label: "Approve" }] },
  ],
  schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
};

function renderPlanDialog(options: {
  onRespond: NonNullable<Parameters<typeof ElicitationDialog>[0]["onRespond"]>;
  withAccessory?: boolean;
  withSelection?: boolean;
}) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        TooltipProvider,
        null,
        createElement(ElicitationDialog, {
          request: planRequest,
          planApprovalAccessory: options.withAccessory
            ? createElement("div", { "data-testid": "plan-accessory" })
            : undefined,
          planExecutionModelSelection: options.withSelection ? SELECTION : undefined,
          onRespond: options.onRespond,
        }),
      ),
    ),
  );
}

beforeEach(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(cleanup);

describe("withPlanExecutionModelSelection", () => {
  it("批准且没有自定义反馈时带上执行模型", () => {
    expect(
      withPlanExecutionModelSelection(BASE_CONTENT, { question, drafts: APPROVE_ONLY }, SELECTION),
    ).toEqual({ ...BASE_CONTENT, executionModel: SELECTION });
  });

  it("带自定义反馈、未选批准、非计划审批或没有选择时保持原 content", () => {
    const feedback = { [question.key]: { selectedValues: ["approve"], customAnswer: "先补测试" } };
    const customOnly = { [question.key]: { selectedValues: [], customAnswer: "先补测试" } };
    expect(
      withPlanExecutionModelSelection(BASE_CONTENT, { question, drafts: feedback }, SELECTION),
    ).toEqual(BASE_CONTENT);
    expect(
      withPlanExecutionModelSelection(BASE_CONTENT, { question, drafts: customOnly }, SELECTION),
    ).toEqual(BASE_CONTENT);
    expect(withPlanExecutionModelSelection(BASE_CONTENT, null, SELECTION)).toEqual(BASE_CONTENT);
    expect(
      withPlanExecutionModelSelection(BASE_CONTENT, { question, drafts: APPROVE_ONLY }, undefined),
    ).toEqual(BASE_CONTENT);
  });
});

describe("ElicitationDialog plan execution model", () => {
  it("空反馈直接点提交等于批准，应答带上执行模型", () => {
    const onRespond = vi.fn();
    renderPlanDialog({ onRespond, withSelection: true });

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(onRespond).toHaveBeenCalledWith(
      "request-plan",
      "accept",
      expect.objectContaining({ answer: "approve", executionModel: SELECTION }),
    );
  });

  it("带修改意见提交时不携带执行模型", () => {
    const onRespond = vi.fn();
    renderPlanDialog({ onRespond, withSelection: true });

    fireEvent.change(screen.getByPlaceholderText("Enter your answer..."), {
      target: { value: "先补测试再实现" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(onRespond).toHaveBeenCalledWith(
      "request-plan",
      "accept",
      expect.objectContaining({ answer: "先补测试再实现" }),
    );
    const content = onRespond.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(content).not.toHaveProperty("executionModel");
  });

  it("宿主给了字段就渲染在弹窗里", () => {
    renderPlanDialog({ onRespond: vi.fn(), withAccessory: true });
    expect(screen.getByTestId("plan-accessory")).toBeTruthy();
  });

  it("onRespond 未返回 Promise 时按钮不禁用（既有行为）", () => {
    renderPlanDialog({ onRespond: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("onRespond 等待期间禁用提交与忽略，返回 false 后恢复", async () => {
    let settle: ((accepted: boolean) => void) | undefined;
    const onRespond = vi.fn(() => new Promise<boolean>((resolve) => (settle = resolve)));
    renderPlanDialog({ onRespond, withSelection: true });

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    settle?.(false);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(onRespond).toHaveBeenCalledOnce();
  });
});
