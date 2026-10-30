import {
  TID_AUTOMATION_CARD,
  TID_AUTOMATIONS_OPEN,
  TID_V4_COMPOSER_SCHEDULE_CONFIRM,
  TID_V4_COMPOSER_SCHEDULE_MENU_ITEM,
  TID_V4_COMPOSER_SCHEDULE_PRESET,
  TID_V4_COMPOSER_SCHEDULE_TRIGGER,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  waitForTestIdByDom,
} from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  setV4ComposerText,
  waitForV4ComposerText,
} from "../../../helpers/v4-conversation.js";

// 定时发送的产品语义：composer 下拉「设为定时」→ 选预设 → 确认后草稿清空，
// 同时在「定时任务」列表出现一条一次性任务（绑定当前会话或草稿态新建会话）。
// 到点注入依赖常驻 scheduler 与真实时钟，不在本 case 内等待触发；这里只验证
// 「创建 + 草稿清理 + 列表可见」这条可确定性断言的链路，触发派发作为手动 review 项。
const PROMPT = "E2E_SCHEDULED_SEND 提醒我 10 分钟后提交日报";
const EXPECTED_TITLE = "E2E_SCHEDULED_SEND 提醒我 10 分钟后提交日报";

describe("Composer 定时发送 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("输入草稿 → 设为定时 → 选预设 → 确认 → 草稿清空且任务列表出现一次性任务", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });

    // 1) 只写入草稿，不发送，验证定时发送不依赖任何模型回合。
    await setV4ComposerText(PROMPT);

    // 2) 发送键右侧下拉 → 「设为定时」→ 预设浮层。
    await clickTestIdByWebDriver(TID_V4_COMPOSER_SCHEDULE_TRIGGER, {
      timeoutMsg: "composer 发送键右侧没有定时发送下拉触发键",
    });
    await clickTestIdByDom(TID_V4_COMPOSER_SCHEDULE_MENU_ITEM, {
      timeoutMsg: "定时发送下拉没有出现「设为定时」菜单项",
    });
    await waitForTestIdByDom(TID_V4_COMPOSER_SCHEDULE_PRESET, {
      timeoutMsg: "定时发送浮层没有渲染预设时间点",
    });

    // 3) 选第一个预设（默认「10 分钟后」）并确认。
    await clickTestIdByDom(TID_V4_COMPOSER_SCHEDULE_PRESET, {
      timeoutMsg: "定时发送浮层预设时间点不可点击",
    });
    await clickTestIdByDom(TID_V4_COMPOSER_SCHEDULE_CONFIRM, {
      timeoutMsg: "定时发送浮层没有可提交的确认按钮",
    });

    // 4) 成功路径必须清空草稿：正文已作为 automation prompt 落库，不再残留输入框。
    await waitForV4ComposerText("", "定时发送成功后 composer 草稿没有清空", 15000);

    // 5) 定时任务列表出现该任务（同一 workspace 的 tasks-index 事实）。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现定时任务入口",
    });
    await waitForTestIdByDom(TID_AUTOMATION_CARD, {
      timeout: 15000,
      timeoutMsg: "定时任务列表没有出现 composer 创建的任务",
    });
    // 列表可能已有其他任务；断言“至少一张卡片包含本次标题”。
    const cardTexts = await browser.execute((tid) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${tid}"]`)).map(
        (item) => item.textContent?.trim() ?? "",
      ),
      TID_AUTOMATION_CARD,
    );
    expect(cardTexts.some((text) => text.includes(EXPECTED_TITLE))).toBe(true);
  });
});
