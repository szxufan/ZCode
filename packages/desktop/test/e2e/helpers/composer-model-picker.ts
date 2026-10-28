import {
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_V4_MODEL_CONFIG,
  testId,
} from "@zcode/shared/test-ids";

/**
 * 合并模型菜单已移除思考强度设置（docs/composer-model-thinking.md）；v4 Composer 的
 * 思考档位统一由独立思考控件（Radix Select）调整。真实点击展开 trigger，item 聚焦后
 * 用键盘 Enter 确认——Radix SelectItem 的合成 click 会被手势判定忽略。
 * 返回 false 表示当前界面没有合并入口或思考控件（旧工具栏形态、无 reasoning 目录），
 * 交回调用方原有链路兜底。
 */
export async function selectComposerThoughtLevel(value: string): Promise<boolean> {
  // 合并入口锚点只在 v4 Composer 存在；旧工具栏沿用调用方的独立下拉驱动。
  const combinedTrigger = $("[data-composer-combined-model]");
  if (!(await combinedTrigger.isExisting())) return false;
  // 合并菜单打开时外部点击只负责关闭菜单；先恢复到菜单关闭的确定状态，再驱动思考控件。
  if ((await combinedTrigger.getAttribute("aria-expanded")) === "true") {
    await browser.keys("Escape");
    await browser.waitUntil(
      async () => (await combinedTrigger.getAttribute("aria-expanded")) !== "true",
      { timeout: 5000, timeoutMsg: "合并模型菜单没有随 Escape 关闭" },
    );
  }
  const trigger = $(`[data-testid="${TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER}"]`);
  if (!(await trigger.isExisting())) return false;
  const current = await $(`[data-testid="${TID_V4_MODEL_CONFIG}"]`).getAttribute("data-thought");
  if ((await trigger.getAttribute("data-thought-level-fixed")) === "true") {
    // 单档模型没有可调状态；只能接受当前真实投影，不能伪造一次选择。
    if (current !== value) {
      throw new Error(`当前模型没有可调思考档位: ${value} (current=${current})`);
    }
    return true;
  }
  if (current === value) return true;
  await trigger.waitForClickable({ timeout: 30000 });
  await trigger.click();
  const itemTestId = testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, value);
  const item = $(`[data-testid="${itemTestId}"]`);
  try {
    await item.waitForClickable({ timeout: 15000 });
  } catch (error) {
    throw new Error(`思考深度选择器没有出现目标档位: ${value}`, { cause: error });
  }
  const confirmResult = await browser.execute((currentItemId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${currentItemId}"]`);
    if (!element) return { ok: false, reason: "item-missing" };
    element.focus();
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    return { ok: true, focused: document.activeElement === element };
  }, itemTestId);
  if (!confirmResult || confirmResult.ok !== true) {
    throw new Error(`思考档位 ${value} 确认阶段异常: ${JSON.stringify(confirmResult)}`);
  }
  // 选择生效 ⇔ SelectContent 卸载（item 消失）；未关闭说明确认未生效。
  await browser.waitUntil(
    async () =>
      browser.execute(
        (currentItemId) => !document.querySelector(`[data-testid="${currentItemId}"]`),
        itemTestId,
      ),
    { timeout: 5000, timeoutMsg: `思考档位 ${value} 确认后菜单未关闭——选择未生效` },
  );
  return true;
}
