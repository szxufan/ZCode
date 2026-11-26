// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanExecutionModelChoice } from "@/plan-approval/index.js";

const mocks = vi.hoisted(() => ({
  useModelSelectionView: vi.fn(),
}));

// 清单来自目标工作区 Host：单测不搭服务上下文，直接给一份读好的视图。
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionView: mocks.useModelSelectionView,
}));

import { PlanExecutionModelField } from "@/plan-approval/index.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { isPlanExecutionModelSupported } from "@/v4/V4InteractionDialogs.js";

// 审批弹窗的「执行模型」字段（docs/specs/plan-approval-execution-model.md）：
// 首项是「会话模型」；换模型时带回完整选择，思考档取新模型档位列表的最后一档（最高公开档）。

const SESSION_CHOICE: PlanExecutionModelChoice = { kind: "session" };
const MODEL_B_CHOICE: PlanExecutionModelChoice = {
  kind: "model",
  providerId: "provider-a",
  modelId: "model-b",
  reasoningLevel: "high",
};

function createView(providers: readonly unknown[]) {
  return {
    revision: 1,
    providers,
    preferredSelection: undefined,
    effectiveSelection: undefined,
  };
}

function createProvider(
  providerId: string,
  providerName: string,
  models: readonly [string, readonly string[]][],
) {
  return {
    providerId,
    providerName,
    config: { api: { type: "openai-compatible" } },
    models: models.map(([modelId, levels]) => ({
      modelId,
      config: { optionSpecs: { reasoningLevel: { values: levels } } },
    })),
  };
}

function renderField(options: {
  value?: PlanExecutionModelChoice;
  onChange?: (choice: PlanExecutionModelChoice) => void;
  noCatalog?: boolean;
}) {
  // 单供应商：一级菜单直接列模型（docs/ui/chat-model-select-menu.md），便于单测点到选项。
  mocks.useModelSelectionView.mockReturnValue({
    state: {
      status: "ready",
      view: createView(
        options.noCatalog
          ? []
          : [
              createProvider("provider-a", "Provider A", [
                ["model-a", ["low", "high"]],
                ["model-b", ["minimal", "high"]],
              ]),
            ],
      ),
    },
  });
  function Harness() {
    const [choice, setChoice] = useState<PlanExecutionModelChoice>(options.value ?? SESSION_CHOICE);
    return createElement(PlanExecutionModelField, {
      workspacePath: "/workspace/app",
      sessionModel: { providerId: "provider-a", modelId: "model-a" },
      value: choice,
      onChange: (next: PlanExecutionModelChoice) => {
        options.onChange?.(next);
        setChoice(next);
      },
    });
  }
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(TooltipProvider, null, createElement(Harness)),
    ),
  );
}

beforeEach(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => {
  cleanup();
  mocks.useModelSelectionView.mockReset();
});

describe("isPlanExecutionModelSupported", () => {
  it("只认 CLI 逐请求声明的 supported: true", () => {
    expect(
      isPlanExecutionModelSupported({
        interaction: "plan_approval",
        toolName: "ExitPlanMode",
        executionModel: { supported: true },
      }),
    ).toBe(true);
    expect(
      isPlanExecutionModelSupported({ interaction: "plan_approval", toolName: "ExitPlanMode" }),
    ).toBe(false);
    expect(isPlanExecutionModelSupported(undefined)).toBe(false);
  });
});

describe("PlanExecutionModelField", () => {
  it("默认选中「会话模型」并显示当前模型名", () => {
    renderField({});

    expect(screen.getByText("Execution model")).toBeTruthy();
    expect(screen.getByTestId("plan-approval-execution-model-trigger").textContent).toContain(
      "model-a",
    );
  });

  it("清单里没有任何模型时不渲染", () => {
    renderField({ noCatalog: true });
    expect(screen.queryByTestId("plan-approval-execution-model-trigger")).toBeNull();
  });

  it("选了另一个模型后给出带默认思考档的完整选择", async () => {
    const onChange = vi.fn();
    renderField({ onChange });

    // 非 composer 形态是两级菜单：先供应商，再该供应商下的模型。
    fireEvent.keyDown(screen.getByTestId("plan-approval-execution-model-trigger"), {
      key: "Enter",
      code: "Enter",
    });
    const providerItem = await screen.findByRole(
      "menuitem",
      { name: /Provider A/ },
      { timeout: 3000 },
    );
    fireEvent.click(providerItem);
    const option = await screen.findByRole("menuitemradio", { name: /model-b/ }, { timeout: 3000 });
    fireEvent.click(option);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(MODEL_B_CHOICE));
  });

  it("已选另一个模型时提示批准后从下一步起用它执行", () => {
    renderField({ value: MODEL_B_CHOICE });
    expect(screen.getByTestId("plan-approval-execution-model").textContent).toContain(
      "After approval, the plan runs with",
    );
  });
});
