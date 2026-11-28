import { TID_LOGIN_MENU_ITEM, TID_LOGIN_TRIGGER } from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  clickTestIdByWebDriver,
  clearAppData,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  E2E_RELAY_PHONE,
  applyRelayV3FixtureEnv,
  clearRelayV3FixtureEnv,
  isRelayWelcomeVisible,
  startRelayV3TestServer,
  type RelayV3TestFixture,
} from "#e2e/helpers/relay-login";

// 应用级登录改为 relay v3 账号（docs/ui/relay-login.md）。本专项不预置 relay 账号，
// 由 fake relay 签发真实短信验证码，验证欢迎页门禁与完整登录链路。

let relay: RelayV3TestFixture | undefined;

const loginButton = () => $('[data-testid="relay-v3-login"]');
const notice = () => $('[data-testid="relay-v3-notice"]');

describe("应用登录：relay v3 欢迎页", () => {
  before(async () => {
    relay = await startRelayV3TestServer({ phone: E2E_RELAY_PHONE });
    applyRelayV3FixtureEnv(relay);
    // 不调用 prepareV4ConversationE2E：它会经 shell-ready 回退自动登录，提前消耗欢迎页。
    // 应用由 WDIO beforeSuite 启动，这里只等 relay 门禁渲染。
    await loginButton().waitForDisplayed({ timeout: 30_000 });
  });

  after(async () => {
    try {
      await browser.electron.restoreAllMocks();
      await clearAppData();
    } finally {
      clearRelayV3FixtureEnv();
      await relay?.stop();
    }
  });

  it("RL01：冷启动显示 relay 登录页，地址草稿未保存时发送验证码被拦截", async () => {
    expect(await isRelayWelcomeVisible()).toBe(true);
    // 空地址不是“草稿”：先输入一个未保存的地址，命中 §3.5 的先保存门禁。
    await setInputValueByTestIdDom("relay-v3-endpoint-input", "https://relay-unsaved.example.com");
    await setInputValueByTestIdDom("relay-v3-phone", E2E_RELAY_PHONE);
    await clickTestIdByDom("relay-v3-send-code");
    await notice().waitForDisplayed({ timeout: 15_000 });
    expect(await notice().getText()).toMatch(/保存|save/i);
    expect(await isRelayWelcomeVisible()).toBe(true);
  });

  it("RL02：保存地址 → 发短信 → 填验证码登录后进入工作区", async () => {
    const endpoint = process.env.ZCODE_E2E_RELAY_V3_URL;
    expect(endpoint).toBeTruthy();
    await setInputValueByTestIdDom("relay-v3-endpoint-input", endpoint!);
    await clickTestIdByDom("relay-v3-endpoint-save");
    await browser.waitUntil(
      () =>
        browser.execute(
          (testId, expected) =>
            (document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)?.value ?? "") ===
            expected,
          "relay-v3-endpoint-input",
          endpoint,
        ),
      { timeout: 15_000, timeoutMsg: "relay 服务器地址没有保存成功" },
    );

    await clickTestIdByDom("relay-v3-send-code");
    const code = relay!.smsCode(E2E_RELAY_PHONE);
    expect(code).toMatch(/^\d{6}$/);
    await setInputValueByTestIdDom("relay-v3-code", code);
    await clickTestIdByDom("relay-v3-login");
    await browser.waitUntil(() => isRelayWelcomeVisible().then((visible) => !visible), {
      timeout: 30_000,
      timeoutMsg: "relay 登录成功后欢迎页没有关闭",
    });
    await waitForDefaultWorkspaceReady(30_000);
  });

  it("RL03：已登录时侧边栏「连接使用」不会卡在登录页", async () => {
    // Radix DropdownMenu 触发器依赖 pointerdown，DOM click 不会展开菜单。
    await clickTestIdByWebDriver(TID_LOGIN_TRIGGER);
    await clickTestIdByDom(TID_LOGIN_MENU_ITEM);
    // 欢迎页拿到 status.account 后立即关闭，不能把已登录用户留在登录页。
    await browser.pause(1000);
    expect(await isRelayWelcomeVisible()).toBe(false);
    await waitForDefaultWorkspaceReady(15_000);
  });
});
