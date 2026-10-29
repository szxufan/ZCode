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
  loading = false,
  locked = [],
  onManageModels,
  empty = false,
}: {
  modelName?: string;
  loading?: boolean;
  locked?: string[];
  onManageModels?: () => void;
  empty?: boolean;
}) {
  const [model, setModel] = useState(empty ? "" : "a/flash");
  const [open, setOpen] = useState(true);
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
        onValueChange: setModel,
        open,
        onOpenChange: setOpen,
        focusSelectorOnClose: null,
        composerOptions: {
          providerLabel: "Provider",
          modelsLabel: "Models",
          selectModelLabel: "Select model",
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
      "Select model",
    );

    expect(screen.getByTestId("chat-model-select-trigger")).toBe(trigger);
  });

  it("never renders a thought level display on the trigger or in the menu", () => {
    render(createElement(Harness));
    const trigger = screen.getByTestId("chat-model-select-trigger");
    // 档位展示与调整都收敛到独立思考控件；合并入口不再携带任何思考强度信息。
    expect(screen.queryByTestId("composer-thought-meter")).toBeNull();
    expect(trigger.querySelector("[data-composer-open-thought]")).toBeNull();
    expect(trigger.querySelector("[data-composer-thought-label]")).toBeNull();
    expect(trigger.textContent).not.toContain("High");
    expect(screen.queryByText("Effort")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByTestId("composer-thought-slider")).toBeNull();
    expect(screen.queryByTestId("composer-effort-shortcut")).toBeNull();
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

  it("selects the provider model without a second model click", () => {
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
