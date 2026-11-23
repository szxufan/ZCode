// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

// 菜单内已无滑杆承接 Escape；通过冒泡到 document 的 Escape 走 Radix DismissableLayer 的关闭链路
// （规格「交互」：「Escape 与一次外部点击关闭」）。
function closeMenuWithEscape() {
  fireEvent.keyDown(document.body, { key: "Escape" });
}

// 上游 v4.0.0 起合并面板由 Popover 承载，使用 dialog 语义；模型与 Provider 列表改用 listbox/option，
// 「Manage models」是普通按钮，不再是 DropdownMenu 的 menu / menuitemradio / menuitem
// （规格「交互」）。以下查询按新结构改写，断言意图不变。
// 子菜单打开期间文档里有两个 role="dialog"（合并弹层与 Provider 子面板），按角色查询会有歧义：
// 合并弹层用 data-testid 定位，再在其中按 listbox 的无障碍名称取模型列表。
const PANEL_TEST_ID = "composer-model-panel";
const PROVIDER_PANEL_TEST_ID = "composer-provider-panel";

/** 合并弹层本体。 */
function getPanel() {
  return screen.getByTestId(PANEL_TEST_ID);
}

/** 当前 Provider 内的模型列表（listbox，无障碍名称为 modelsLabel）。 */
function getModelListbox() {
  return within(getPanel()).getByRole("listbox", { name: "Models" });
}

/**
 * 用键盘打开桌面端 Provider 子菜单并返回该子面板。
 * 组件对 ArrowRight 有显式处理（ComposerProviderMenu）。
 */
function openProviderPanel() {
  fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
  return screen.getByTestId(PROVIDER_PANEL_TEST_ID);
}

describe("composer combined model picker", () => {
  it("rolls between the open and closed content without replacing the trigger", async () => {
    render(createElement(Harness));
    const trigger = screen.getByTestId("chat-model-select-trigger");
    // 展开期间只渲染 open 帧并显示 Select model，关闭态帧不并存。
    expect(trigger.querySelector('[data-composer-trigger-frame="open"]')?.textContent).toBe(
      "Select model",
    );
    expect(trigger.querySelector('[data-composer-trigger-frame="closed"]')).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Select model" })).toBe(getPanel());
    closeMenuWithEscape();
    await waitFor(() =>
      expect(trigger.querySelector('[data-composer-trigger-frame="open"]')).toBeNull(),
    );
    expect(trigger.querySelector('[data-composer-trigger-frame="closed"]')?.textContent).toContain(
      "GLM-5.3-Flash",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // 原用例用 keyDown(Enter) 重新打开。新结构的 PopoverTrigger 只合成 onClick，组件对 Enter/空格
    // 没有显式处理：真实浏览器里由原生 button 把 Enter/空格合成为 click；jsdom 的 keyDown 不合成
    // click，仓库也未安装 user-event，因此用 click 驱动同一条打开链路。
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(trigger.querySelector('[data-composer-trigger-frame="closed"]')).toBeNull(),
    );
    expect(trigger.querySelector('[data-composer-trigger-frame="open"]')?.textContent).toBe(
      "Select model",
    );
    expect(screen.getByRole("dialog", { name: "Select model" })).toBe(getPanel());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    expect(screen.getByTestId("chat-model-select-trigger")).toBe(trigger);
  });

  it("never renders a thought level display on the trigger or in the menu", async () => {
    render(createElement(Harness));
    const trigger = screen.getByTestId("chat-model-select-trigger");
    // 菜单现在是 Popover 面板；先确认它已渲染，下面的否定断言才不会因面板缺失而空过。
    expect(screen.getByRole("dialog", { name: "Select model" })).toBe(getPanel());
    // 档位展示与调整都收敛到独立思考控件；合并入口不再携带任何思考强度信息。
    expect(screen.queryByTestId("composer-thought-meter")).toBeNull();
    expect(trigger.querySelector("[data-composer-open-thought]")).toBeNull();
    expect(trigger.querySelector("[data-composer-thought-label]")).toBeNull();
    expect(trigger.textContent).not.toContain("High");
    // 规格「合并入口触发器不再显示思考档位」：「aria-label 只保留模型与操作文案，不再拼接当前档位」。
    expect(trigger.getAttribute("aria-label")).toBe("GLM-5.3-Flash");
    // 上游 Effort 区域的挂载点（标题、当前档位文字、快捷键徽标、滑杆）都不应出现在面板里。
    expect(screen.queryByText("Effort")).toBeNull();
    expect(screen.queryByTestId("composer-thought-value")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByTestId("composer-thought-slider")).toBeNull();
    expect(screen.queryByTestId("composer-effort-shortcut")).toBeNull();
    // 关闭态触发器同样只显示模型名。
    closeMenuWithEscape();
    await waitFor(() => expect(trigger.textContent).toBe("GLM-5.3-Flash"));
    expect(trigger.getAttribute("aria-label")).toBe("GLM-5.3-Flash");
  });

  it("keeps an empty selection secondary without a phantom effort or effort placeholder", async () => {
    render(createElement(Harness, { empty: true }));
    const trigger = screen.getByTestId("chat-model-select-trigger");
    expect(trigger.textContent).toBe("Select model");
    expect(trigger.getAttribute("aria-label")).toBe("Select model");

    expect(screen.queryByTestId("composer-thought-meter")).toBeNull();
    closeMenuWithEscape();
    // 展开与关闭显示同一文案；先确认面板确实关闭，关闭态的断言才不是空过。
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toBe("Select model");
  });
  it("shows the provider logo and access badges, with management only inside the provider submenu", () => {
    const manage = vi.fn();
    render(createElement(Harness, { onManageModels: manage }));
    const trigger = screen.getByTestId("composer-provider-trigger");
    expect(trigger.querySelector("img")?.getAttribute("src")).toContain("deepseek");
    expect(trigger.textContent).toBe("Provider AIndividual");
    // 规格：「末尾分割线下放置 Manage models；合并弹层底部不重复显示此入口」。
    expect(screen.queryByText("Manage models")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage models" })).toBeNull();
    const providerPanel = openProviderPanel();
    // Provider 列表同样是 listbox/option；当前 Provider 的选中标记由 aria-selected 表达。
    const current = within(providerPanel).getByRole("option", {
      name: "Provider A Individual",
      exact: true,
    });
    expect(current.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByText("Individual")).toHaveLength(2);
    const other = within(providerPanel).getByRole("option", {
      name: "Provider B API",
      exact: true,
    });
    expect(other.getAttribute("aria-selected")).toBe("false");
    // 子菜单打开后，整个文档只有子菜单内的一个管理入口，合并弹层本体仍没有。
    expect(screen.getAllByRole("button", { name: "Manage models" })).toHaveLength(1);
    expect(within(getPanel()).queryByText("Manage models")).toBeNull();
    fireEvent.click(within(providerPanel).getByRole("button", { name: "Manage models" }));
    expect(manage).toHaveBeenCalledOnce();
    // 管理入口关闭整个合并弹层（原断言 queryByRole("menu") 为 null）。
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId(PANEL_TEST_ID)).toBeNull();
  });

  it("keeps model management reachable with an empty provider directory", () => {
    const manage = vi.fn();
    render(createElement(Harness, { loading: true, onManageModels: manage }));
    // 规格：「空目录时仍可打开子菜单进入模型管理」——Provider 行不因目录为空而禁用。
    expect(screen.getByTestId("composer-provider-trigger").hasAttribute("disabled")).toBe(false);
    const providerPanel = openProviderPanel();
    expect(within(providerPanel).queryAllByRole("option")).toHaveLength(0);
    fireEvent.click(within(providerPanel).getByRole("button", { name: "Manage models" }));
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
      // 模型列表是 listbox/option（规格「交互」）。
      expect(option.getAttribute("role")).toBe("option");
      expect(option.closest('[role="listbox"]')).toBe(getModelListbox());
      fireEvent.click(option);
      // 规格「模型菜单关闭」：「草稿和已有会话点击或键盘确认模型后均保持菜单打开」。
      expect(screen.getByRole("dialog", { name: "Select model" })).toBe(getPanel());
      expect(screen.getByTestId("chat-model-select-trigger").getAttribute("aria-expanded")).toBe(
        "true",
      );
      // listbox/option 语义下选中态由 aria-selected 表达（原 menuitemradio 的 aria-checked）。
      expect(option.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByTestId("chat-model-select-trigger").getAttribute("aria-label")).toContain(
        name,
      );
    },
  );

  it("selects the provider model without a second model click", () => {
    render(createElement(Harness));
    const providerPanel = openProviderPanel();
    fireEvent.click(within(providerPanel).getByRole("option", { name: "Provider B API" }));
    expect(screen.getByTestId("chat-model-select-trigger").getAttribute("aria-label")).toContain(
      "Fixed model",
    );
    const fixed = within(getModelListbox()).getByRole("option", { name: "Fixed model" });
    expect(fixed.getAttribute("aria-selected")).toBe("true");
    // 原断言 getAllByRole("menu") 长度为 1：选择 Provider 后子菜单收起，整个文档只剩合并弹层。
    expect(screen.getAllByRole("dialog")).toEqual([getPanel()]);
  });

  it("preserves the selected model when selecting the current provider again", () => {
    render(createElement(Harness));
    fireEvent.click(
      within(getModelListbox()).getByRole("option", { name: "GLM-5.3", exact: true }),
    );
    const providerPanel = openProviderPanel();
    fireEvent.click(within(providerPanel).getByRole("option", { name: "Provider A Individual" }));
    // 规格：「重复选择当前 Provider 保留其当前可用模型」。
    const glm = within(getModelListbox()).getByRole("option", { name: "GLM-5.3", exact: true });
    expect(glm.getAttribute("aria-selected")).toBe("true");
  });

  it("skips locked models when automatically selecting a provider model", () => {
    render(createElement(Harness, { locked: ["a/flash"] }));
    fireEvent.click(within(openProviderPanel()).getByRole("option", { name: "Provider B API" }));
    fireEvent.click(
      within(openProviderPanel()).getByRole("option", { name: "Provider A Individual" }),
    );
    // 规格：「切换 Provider 立即选择该分组按目录顺序的第一个未锁定模型」。
    const glm = within(getModelListbox()).getByRole("option", { name: "GLM-5.3", exact: true });
    expect(glm.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the current selection when the target provider has no available model", () => {
    render(createElement(Harness, { locked: ["b/fixed"] }));
    fireEvent.click(within(openProviderPanel()).getByRole("option", { name: "Provider B API" }));
    // 规格：「没有可用模型的 Provider 仍可浏览和配置，但不覆盖当前模型」。
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
      const trigger = screen.getByTestId("chat-model-select-trigger");
      // 窄屏没有独立子面板：Provider 页在合并弹层内切换（规格「交互」：「窄屏沿用点击进入和返回」）。
      const panel = getPanel();
      fireEvent.click(screen.getByTestId("composer-provider-trigger"));
      expect(screen.getByTestId("composer-provider-back")).toBeTruthy();
      expect(screen.queryByTestId("composer-provider-trigger")).toBeNull();
      fireEvent.click(screen.getByTestId("composer-provider-back"));
      expect(screen.getByTestId("composer-provider-trigger")).toBeTruthy();
      // 规格：「关闭菜单及窄屏返回不修改模型」。
      expect(trigger.getAttribute("aria-label")).toContain("GLM-5.3-Flash");
      const flash = within(getModelListbox()).getByTestId("chat-model-select-item-a/flash");
      expect(flash.getAttribute("aria-selected")).toBe("true");
      fireEvent.click(screen.getByTestId("composer-provider-trigger"));
      fireEvent.click(within(panel).getByRole("option", { name: "Provider B API" }));
      // 选择后回到同一个合并弹层的模型页，Provider 自动选中的模型已勾选。
      const fixed = await waitFor(() => within(panel).getByRole("option", { name: "Fixed model" }));
      expect(fixed.getAttribute("aria-selected")).toBe("true");
      expect(screen.queryByTestId("composer-provider-back")).toBeNull();
      expect(getPanel()).toBe(panel);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(trigger.getAttribute("aria-label")).toContain("Fixed model");
    } finally {
      window.matchMedia = original;
    }
  });
});
