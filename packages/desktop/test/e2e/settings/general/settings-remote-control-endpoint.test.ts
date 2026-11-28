import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  applyRelayV3FixtureEnv,
  clearRelayV3FixtureEnv,
  startRelayV3TestServer,
  type RelayV3TestFixture,
} from "#e2e/helpers/relay-login";
import { clearAppData, clickTestIdByDom, readSettings } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// 设置 → 远程控制 → Relay 服务器地址（docs/relay-server/relay-v3-design.md §3.5）。
// 未登录时保存地址不产生任何网络请求，因此无需 relay fixture：只验证回显、落盘与就地报错。
// 已登录/运行中切换地址的善后（登出、重置设备身份、断开控制端）由
// packages/desktop/test/relayV3DeviceManager.test.ts 覆盖。

// relay v3 切换不同 origin 会登出并回到欢迎页；用例必须使用 fixture 自身的地址，
// 否则 RCE03 的设置搜索会在欢迎页上找不到入口（这是产品行为，不是 UI 缺陷）。
let ENDPOINT = "";
const SEARCH_ID = "settings.remoteControl.server.address";

let relayFixture: RelayV3TestFixture | undefined;

const input = () => $('[data-testid="relay-v3-endpoint-input"]');
const saveButton = () => $('[data-testid="relay-v3-endpoint-save"]');
const inputError = () => $('[data-testid="relay-v3-endpoint-error"]');

describe("设置 → 远程控制：Relay 服务器地址", () => {
  before(async () => {
    // 本专项被 wdio 排除在 relay 冷启动播种之外；prepare 的 shell-ready 会走 UI 登录兜底，
    // 因此必须在 worker 内先启动 fake relay 并把地址传给 helper。
    relayFixture = await startRelayV3TestServer({});
    ENDPOINT = relayFixture.httpUrl;
    applyRelayV3FixtureEnv(relayFixture);
    await prepareV4ConversationE2E({ skipProvider: true });
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed();
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteControl"));
    await input().waitForDisplayed({ timeout: 15000 });
  });

  after(async () => {
    try {
      await browser.electron.restoreAllMocks();
      await clearAppData();
    } finally {
      clearRelayV3FixtureEnv();
      await relayFixture?.stop();
    }
  });

  it("RCE01：保存后回显归一化地址并落盘；未修改时保存不可点", async () => {
    await input().setValue(`${ENDPOINT}/`);
    await saveButton().click();
    await browser.waitUntil(async () => (await input().getValue()) === ENDPOINT, {
      timeout: 15000,
      timeoutMsg: "保存后输入框未回显归一化（去尾斜杠）的服务器地址",
    });
    expect((await readSettings()).relayV3?.endpointOrigin).toBe(ENDPOINT);
    expect(await saveButton().isEnabled()).toBe(false);
  });

  it("RCE02：非法地址就地报错且不落盘，修正输入后报错消失", async () => {
    await input().setValue("relay.e2e.example.com");
    await saveButton().click();
    await inputError().waitForDisplayed({ timeout: 15000 });
    expect(await inputError().getText()).toContain("http://");
    expect((await readSettings()).relayV3?.endpointOrigin).toBe(ENDPOINT);

    await input().setValue(ENDPOINT);
    expect(await inputError().isExisting()).toBe(false);
  });

  it("RCE03：设置搜索可以定位到服务器地址行", async () => {
    await clickTestIdByDom("settings-search-open");
    await $('[data-testid="settings-search-input"]').setValue("relay");
    await $(`[data-settings-search-result="${SEARCH_ID}"]`).click();
    // 与 settings-navigation-search 的 expectLocated 同口径：先等搜索弹层收起，
    // 再核对定位高亮——行本身一直可见，不能拿它可见当作定位已完成的信号。
    await $('[data-testid="settings-search-dialog"]').waitForDisplayed({
      reverse: true,
      timeout: 15000,
    });
    const anchor = $(`[data-settings-search-id="${SEARCH_ID}"]`);
    await anchor.waitForDisplayed({ timeout: 15000 });
    expect(await anchor.getAttribute("data-settings-search-highlighted")).toBe("true");
  });

  it("RCE04：输入框内回车同样触发保存", async () => {
    const next = "https://relay-enter.e2e.example.com";
    await input().setValue(`${next}/`);
    await input().click();
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await input().getValue()) === next, {
      timeout: 15000,
      timeoutMsg: "回车后输入框未回显归一化的服务器地址",
    });
    expect((await readSettings()).relayV3?.endpointOrigin).toBe(next);
  });

  it("RCE05：未保存服务器地址时发送验证码被拦截并提示先保存", async () => {
    const saved = (await readSettings()).relayV3?.endpointOrigin;
    await input().setValue("https://relay-unsaved.e2e.example.com");
    await $('[data-testid="relay-v3-phone"]').setValue("+8613800138000");
    await $('[data-testid="relay-v3-send-code"]').click();
    const notice = $('[data-testid="relay-v3-notice"]');
    await notice.waitForDisplayed({ timeout: 15000 });
    expect(await notice.getText()).toMatch(/保存|save/i);
    expect((await readSettings()).relayV3?.endpointOrigin).toBe(saved);
  });
});
