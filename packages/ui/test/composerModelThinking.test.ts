// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const groups = [
  {
    key: "a",
    label: "Provider A",
    labelBadge: "Individual",
    logo: { type: "builtin" as const, key: "deepseek" },
    items: [
      { key: "flash", value: "a/flash", name: "GLM-5.3-Flash", supportsVisionInput: true },
      { key: "glm", value: "a/glm", name: "GLM-5.3" },
    ],
  },
  {
    key: "b",
    label: "Provider B",
    labelBadge: "API",
    items: [{ key: "fixed", value: "b/fixed", name: "Fixed model" }],
  },
];

function Harness({
  modelName,
  invalid = false,
  loading = false,
  locked = [],
  onManageModels,
  empty = false,
  levelsOverride,
  initialThought,
}: {
  modelName?: string;
  invalid?: boolean;
  loading?: boolean;
  locked?: string[];
  onManageModels?: () => void;
  empty?: boolean;
  levelsOverride?: { value: string; label: string }[];
  initialThought?: string;
}) {
  const [model, setModel] = useState(empty ? "" : "a/flash");
  const [thought, setThought] = useState(initialThought ?? (invalid ? "missing" : "high"));
  const [open, setOpen] = useState(true);
  const levels =
    model === "b/fixed"
      ? [{ value: "disabled", label: "Off" }]
      : [
          { value: "disabled", label: "Off" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ];
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "en-US" },
    createElement(
      TooltipProvider,
      null,
      createElement(ModelConfigSelect, {
        modelGroups: loading
          ? []
          : groups.map((group) => ({
              ...group,
              items: group.items.map((item) =>
                item.value === "a/flash" && modelName ? { ...item, name: modelName } : item,
              ),
            })),
        normalizedValue: model,
        triggerLabel:
          groups.flatMap((group) => group.items).find((item) => item.value === model)?.name ??
          "Select model",
        tooltipTitle:
          groups.flatMap((group) => group.items).find((item) => item.value === model)?.name ??
          "Select model",
        showManageModelsAction: Boolean(onManageModels),
        manageModelsLabel: "Manage models",
        onManageModels,
        lockReasonMessage: "",
        isItemLocked: (value: string) => locked.includes(value),
        onValueChange: (value: string) => {
          setModel(value);
          setThought(value === "b/fixed" ? "disabled" : "high");
        },
        open,
        onOpenChange: setOpen,
        focusSelectorOnClose: null,
        composerOptions: {
          providerLabel: "Provider",
          modelsLabel: "Models",
          selectModelLabel: "Select model",
          levels: loading ? [] : (levelsOverride ?? levels),
          value: thought,
        },
      }),
    ),
  );
}

beforeEach(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(cleanup);

// 菜单内已无滑杆承接 Escape；通过冒泡到 document 的 Escape 走 Radix 关闭链路。
function closeMenuWithEscape() {
  fireEvent.keyDown(document.body, { key: "Escape" });
}

describe("composer combined model picker", () => {
  it("rolls between the open and closed content without replacing the trigger", async () => {
    render(createElement(Harness));
    const trigger = screen.getByTestId("chat-model-select-trigger");
    expect(trigger.querySelector('[data-composer-trigger-frame="open"]')).not.toBeNull();
    closeMenuWithEscape();
    await waitFor(() =>
      expect(trigger.querySelector('[data-composer-trigger-frame="open"]')).toBeNull(),
    );
    expect(trigger.querySelector('[data-composer-trigger-frame="closed"]')?.textContent).toContain(
      "GLM-5.3-Flash",
    );
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() =>
      expect(trigger.querySelector('[data-composer-trigger-frame="closed"]')).toBeNull(),
    );
    expect(trigger.querySelector('[data-composer-trigger-frame="open"]')?.textContent).toBe(
      "Select modelHigh",
    );

    expect(screen.getByTestId("chat-model-select-trigger")).toBe(trigger);
  });

  it("never renders an effort setting in the model menu regardless of level count", () => {
    for (const levelsOverride of [
      undefined,
      [{ value: "disabled", label: "Off" }],
      [],
    ]) {
      render(createElement(Harness, { levelsOverride }));
      // 合并入口的思考档位展示保留，但菜单内不再提供任何调整设置。
      expect(screen.getByTestId("composer-thought-meter")).toBeTruthy();
      expect(screen.queryByText("Effort")).toBeNull();
      expect(screen.queryByRole("slider")).toBeNull();
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByTestId("composer-thought-slider")).toBeNull();
      expect(screen.queryByTestId("composer-effort-shortcut")).toBeNull();
      cleanup();
    }
  });

  it("keeps an empty selection secondary without a phantom effort or effort placeholder", () => {
    render(createElement(Harness, { empty: true }));
    const trigger = screen.getByTestId("chat-model-select-trigger");
    expect(trigger.textContent).toBe("Select model");
    expect(trigger.getAttribute("aria-label")).toBe("Select model");

    expect(screen.queryByTestId("composer-thought-meter")).toBeNull();
    closeMenuWithEscape();
    expect(trigger.textContent).toBe("Select model");
  });
  it("shows the provider logo and access badges, with management only inside the provider submenu", () => {
    const manage = vi.fn();
    render(createElement(Harness, { onManageModels: manage }));
    const trigger = screen.getByTestId("composer-provider-trigger");
    expect(trigger.querySelector("img")?.getAttribute("src")).toContain("deepseek");
    expect(trigger.textContent).toBe("Provider AIndividual");
    expect(screen.queryByText("Manage models")).toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    expect(
      screen.getByRole("menuitemradio", { name: "Provider A Individual", exact: true }),
    ).toBeTruthy();
    expect(screen.getAllByText("Individual")).toHaveLength(2);
    expect(screen.getByRole("menuitemradio", { name: "Provider B API", exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage models" }));
    expect(manage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps model management reachable with an empty provider directory", () => {
    const manage = vi.fn();
    render(createElement(Harness, { loading: true, onManageModels: manage }));
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage models" }));
    expect(manage).toHaveBeenCalledOnce();
  });
  it.each(["GLM-5.3", "GLM-5.3-Flash"])(
    "stays open after choosing %s, including the current model",
    (name) => {
      render(createElement(Harness));
      expect(screen.getByLabelText("Vision")).toBeTruthy();
      const option = screen.getByTestId(
        name === "GLM-5.3" ? "chat-model-select-item-a/glm" : "chat-model-select-item-a/flash",
      );
      fireEvent.click(option);
      expect(screen.getByRole("menu")).toBeTruthy();
      expect(option.getAttribute("aria-checked")).toBe("true");
      expect(screen.getByTestId("chat-model-select-trigger").getAttribute("aria-label")).toContain(
        name,
      );
    },
  );

  it("selects the provider model and synchronizes the thought display without a second model click", () => {
    render(createElement(Harness));
    const providerTrigger = screen.getByTestId("composer-provider-trigger");
    fireEvent.keyDown(providerTrigger, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider B API" }));
    expect(screen.getByTestId("chat-model-select-trigger").getAttribute("aria-label")).toContain(
      "Fixed model",
    );
    expect(
      screen.getByRole("menuitemradio", { name: "Fixed model" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getAllByRole("menu")).toHaveLength(1);

    // 固定模型只有 Off：触发器竖条归零，不制造默认选择。
    expect(screen.getByTestId("composer-thought-meter").getAttribute("data-progress")).toBe("0");
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider A Individual" }));
    expect(screen.getByTestId("composer-thought-meter").getAttribute("data-progress")).toBe("100");
  });

  it("preserves the selected model when selecting the current provider again", () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GLM-5.3", exact: true }));
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider A Individual" }));
    expect(
      screen
        .getByRole("menuitemradio", { name: "GLM-5.3", exact: true })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("skips locked models when automatically selecting a provider model", () => {
    render(createElement(Harness, { locked: ["a/flash"] }));
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider B API" }));
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider A Individual" }));
    expect(
      screen
        .getByRole("menuitemradio", { name: "GLM-5.3", exact: true })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps the current selection when the target provider has no available model", () => {
    render(createElement(Harness, { locked: ["b/fixed"] }));
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider B API" }));
    expect(screen.getByTestId("chat-model-select-trigger").getAttribute("aria-label")).toContain(
      "GLM-5.3-Flash",
    );
  });

  it("does not project an invalid effort as a selected level on the trigger", () => {
    render(createElement(Harness, { invalid: true }));
    expect(screen.getByTestId("composer-thought-meter").getAttribute("data-progress")).toBe("0");
  });
});

describe("narrow provider navigation", () => {
  it("returns without changing model and selects a provider in the same menu", async () => {
    const original = window.matchMedia;
    window.matchMedia = vi
      .fn()
      .mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    try {
      render(createElement(Harness));
      fireEvent.click(screen.getByTestId("composer-provider-trigger"));
      expect(screen.getByTestId("composer-provider-back")).toBeTruthy();
      expect(screen.queryByTestId("composer-provider-trigger")).toBeNull();
      fireEvent.click(screen.getByTestId("composer-provider-back"));
      expect(screen.getByTestId("composer-provider-trigger")).toBeTruthy();
      fireEvent.click(screen.getByTestId("composer-provider-trigger"));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Provider B API" }));
      await waitFor(() =>
        expect(screen.getByRole("menuitemradio", { name: "Fixed model" })).toBeTruthy(),
      );
      expect(screen.queryByTestId("composer-provider-back")).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("GLM Highspeed trigger meter", () => {
  it.each([
    ["GLM-5.3-Highspeed", true],
    ["glm-5.3-HIGHSPEED", true],
    ["GLM-5.3-FlashX", true],
    ["glm-5.3-FLASHx", true],
    ["FlashX", false],
    ["DeepSeek-FlashX", false],
    ["GLM-5.3", false],
    ["DeepSeek-Highspeed", false],
  ])("derives the effect from model name %s", (modelName, enabled) => {
    render(createElement(Harness, { modelName }));

    expect(screen.getByTestId("composer-thought-meter").getAttribute("data-highspeed")).toBe(
      String(enabled),
    );
  });
});

it("hides the effort area when a selected model has no effort capability", () => {
  render(createElement(Harness, { levelsOverride: [] }));
  expect(screen.getByRole("menuitemradio", { name: "GLM-5.3", exact: true })).toBeTruthy();
  expect(screen.queryByText("Effort")).toBeNull();
  expect(screen.queryByRole("slider")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
});
