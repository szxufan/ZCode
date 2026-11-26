import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  TID_MODEL_DISCOVERY_CONFIRM_BUTTON,
  TID_MODEL_DISCOVERY_DIALOG,
  TID_MODEL_DISCOVERY_MODEL_CHECKBOX,
  TID_MODEL_DISCOVERY_SEARCH_INPUT,
  TID_MODEL_DISCOVERY_SELECT_ALL,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_MODEL_PROVIDER_PULL_MODELS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspace, seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const PROVIDER_ID = "e2e-discovery";
const EXISTING_MODEL_ID = "existing-chat-model";
const RICH_MODEL_A = "glm-5.3-high";
const RICH_MODEL_B = "qwen3.8-flash";
const NON_CHAT_MODEL_ID = "embedding-small";

/** 连接派实测字段的脱敏投影：只保留解析器关心的字段。 */
function modelEntry(overrides: Record<string, unknown> = {}) {
  return {
    object: "model",
    created: 1626777600,
    owned_by: "zhipu_4v",
    supported_endpoint_types: ["openai"],
    ...overrides,
  };
}

describe("provider model discovery preview and selective import", () => {
  let server: Server;
  let serverPort = 0;
  let modelsRequests: { path: string; authorization: string | undefined }[] = [];
  let catalog: unknown[] = [];

  before(async () => {
    server = createServer((request, response) => {
      const authorization = request.headers.authorization;
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        modelsRequests.push({ path: request.url, authorization });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ success: true, object: "list", data: structuredClone(catalog) }),
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing discovery server port");
    serverPort = address.port;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  async function seedProvider() {
    catalog = [
      modelEntry({
        id: EXISTING_MODEL_ID,
        context_length: 200_000,
        max_output_tokens: 32_000,
      }),
      modelEntry({
        id: RICH_MODEL_A,
        context_length: 1_048_576,
        max_output_tokens: 131_072,
        reasoning_options: ["low", "high", "max"],
      }),
      modelEntry({
        id: RICH_MODEL_B,
        context_length: 1_006_592,
        max_output_tokens: 131_072,
        support_image_input: true,
        support_video_input: true,
      }),
      modelEntry({
        id: NON_CHAT_MODEL_ID,
        supported_endpoint_types: ["embeddings"],
      }),
    ];
    await seedReplayProvider({
      id: PROVIDER_ID,
      name: "E2E Discovery",
      apiKey: "e2e-discovery-key",
      baseURL: `http://127.0.0.1:${serverPort}/v1`,
      apiFormat: "openai-chat-completions",
      models: [{ id: EXISTING_MODEL_ID, contextWindow: 200_000, maxOutputTokens: 32_000 }],
    });
  }

  async function openProviderDetail() {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${PROVIDER_ID}`));
  }

  async function openDiscoveryDialog() {
    await clickTestIdByDom(TID_MODEL_PROVIDER_PULL_MODELS_BUTTON);
    await $(`[data-testid="${TID_MODEL_DISCOVERY_DIALOG}"]`).waitForDisplayed({
      timeout: 15_000,
    });
  }

  async function readPersonalConfigModelIds() {
    const paths = getE2EAppDataPaths();
    const raw = JSON.parse(await readFile(paths.configFile, "utf8")) as {
      config?: {
        providerConfigRules?: {
          providerRules?: {
            providerId?: string;
            config?: { personalModelIds?: string[] };
          }[];
        };
      };
    };
    const provider = raw.config?.providerConfigRules?.providerRules?.find(
      (rule) => rule.providerId === PROVIDER_ID,
    );
    return provider?.config?.personalModelIds ?? [];
  }

  it("pulls preview, filters, and imports only selected new models", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await restartIntoWorkspace({ afterElectronProcessExit: () => seedProvider() });
    await openProviderDetail();

    // 初始状态：只有预置模型；拉取按钮可见。
    const pullButton = $(`[data-testid="${TID_MODEL_PROVIDER_PULL_MODELS_BUTTON}"]`);
    await pullButton.waitForClickable({ timeout: 15_000 });
    const configBeforePull = await readFile(getE2EAppDataPaths().configFile, "utf8");

    // 第一次拉取：请求路径和 Bearer header 正确；弹窗打开后配置不变。
    await pullButton.click();
    await $(`[data-testid="${TID_MODEL_DISCOVERY_DIALOG}"]`).waitForDisplayed({
      timeout: 15_000,
    });
    expect(modelsRequests).toHaveLength(1);
    expect(modelsRequests[0]!.path).toBe("/v1/models");
    expect(modelsRequests[0]!.authorization).toBe("Bearer e2e-discovery-key");
    expect(await readFile(getE2EAppDataPaths().configFile, "utf8")).toBe(configBeforePull);

    // 已有模型禁选；非对话端点禁选。
    const existingCheckbox = $(
      `[data-testid="${testId(TID_MODEL_DISCOVERY_MODEL_CHECKBOX, EXISTING_MODEL_ID)}"]`,
    );
    await existingCheckbox.waitForDisplayed({ timeout: 10_000 });
    expect(await existingCheckbox.getAttribute("disabled")).toBeTruthy();
    const nonChatCheckbox = $(
      `[data-testid="${testId(TID_MODEL_DISCOVERY_MODEL_CHECKBOX, NON_CHAT_MODEL_ID)}"]`,
    );
    await nonChatCheckbox.waitForDisplayed({ timeout: 10_000 });
    expect(await nonChatCheckbox.getAttribute("disabled")).toBeTruthy();

    // 默认全选为空；筛选后全选只作用于当前筛选结果。
    // SettingsSearchInput 将 testid 直接落在内部 Input 上，不需要再往下找 input。
    const searchInput = $(`[data-testid="${TID_MODEL_DISCOVERY_SEARCH_INPUT}"]`);
    await searchInput.setValue("glm");
    const selectAll = $(`[data-testid="${TID_MODEL_DISCOVERY_SELECT_ALL}"]`);
    await selectAll.click();
    const richACheckbox = $(
      `[data-testid="${testId(TID_MODEL_DISCOVERY_MODEL_CHECKBOX, RICH_MODEL_A)}"]`,
    );
    await browser.waitUntil(
      async () => (await richACheckbox.getAttribute("data-state")) === "checked",
      { timeout: 10_000, timeoutMsg: "RICH_MODEL_A checkbox should be checked after select all" },
    );
    // 清空筛选：B 未被选上，A 保持选中。
    // WDIO 对空字符串 setValue 可能不触发 React onChange；点击组件自带清除按钮走真实 click。
    const clearSearch = $(`[data-testid="${testId(TID_MODEL_DISCOVERY_SEARCH_INPUT, "clear")}"]`);
    await clearSearch.waitForClickable({ timeout: 10_000 });
    await clearSearch.click();
    const richBCheckbox = $(
      `[data-testid="${testId(TID_MODEL_DISCOVERY_MODEL_CHECKBOX, RICH_MODEL_B)}"]`,
    );
    await richBCheckbox.waitForDisplayed({ timeout: 10_000 });
    expect(await richBCheckbox.isSelected()).toBe(false);

    // 确认导入：只写入选中模型。
    await clickTestIdByDom(TID_MODEL_DISCOVERY_CONFIRM_BUTTON);
    await browser.waitUntil(
      async () => !(await $(`[data-testid="${TID_MODEL_DISCOVERY_DIALOG}"]`).isDisplayed()),
      { timeout: 15_000, timeoutMsg: "Discovery dialog should close after import" },
    );
    const modelIds = await readPersonalConfigModelIds();
    expect(modelIds).toContain(RICH_MODEL_A);
    expect(modelIds).not.toContain(RICH_MODEL_B);
    expect(modelIds).toContain(EXISTING_MODEL_ID);
    expect(modelIds).not.toContain(NON_CHAT_MODEL_ID);
  });

  it("cancel discards candidates without writing config", async function () {
    this.timeout(120_000);
    // 每条用例独立导航，避免上一条失败后的页面状态污染本条。
    await openProviderDetail();
    const configBefore = await readFile(getE2EAppDataPaths().configFile, "utf8");
    const pullButton = $(`[data-testid="${TID_MODEL_PROVIDER_PULL_MODELS_BUTTON}"]`);
    await pullButton.waitForClickable({ timeout: 15_000 });
    await pullButton.click();
    await $(`[data-testid="${TID_MODEL_DISCOVERY_DIALOG}"]`).waitForDisplayed({
      timeout: 15_000,
    });
    expect(modelsRequests.length).toBeGreaterThanOrEqual(2);

    // 全选当前筛选结果后取消：配置不变。界面语言由宿主决定，按钮文本两种语言都要匹配。
    const selectAll = $(`[data-testid="${TID_MODEL_DISCOVERY_SELECT_ALL}"]`);
    await selectAll.click();
    const cancelButton = await $(`[data-testid="${TID_MODEL_DISCOVERY_DIALOG}"]`).$(
      './/button[normalize-space(.)="Cancel" or normalize-space(.)="取消"]',
    );
    await cancelButton.waitForClickable({ timeout: 10_000 });
    await cancelButton.click();
    await browser.waitUntil(
      async () => !(await $(`[data-testid="${TID_MODEL_DISCOVERY_DIALOG}"]`).isDisplayed()),
      { timeout: 15_000, timeoutMsg: "Discovery dialog should close after cancel" },
    );
    expect(await readFile(getE2EAppDataPaths().configFile, "utf8")).toBe(configBefore);
  });

  it("repeat pull marks imported models as existing and adds new selection", async function () {
    this.timeout(120_000);
    await openProviderDetail();
    // 目录里追加一条与已有条目重复的 RICH_MODEL_B：覆盖“重复 ID 只保留一条”的解析分支，
    // 同时 RICH_MODEL_A 已导入、RICH_MODEL_B 从未导入，用于验证再次拉取的禁选/可选差异。
    catalog = [
      ...catalog,
      modelEntry({
        id: RICH_MODEL_B,
        context_length: 1_006_592,
        max_output_tokens: 131_072,
        support_image_input: true,
        support_video_input: true,
      }),
    ];
    const pullButton = $(`[data-testid="${TID_MODEL_PROVIDER_PULL_MODELS_BUTTON}"]`);
    await pullButton.waitForClickable({ timeout: 15_000 });
    await pullButton.click();
    await $(`[data-testid="${TID_MODEL_DISCOVERY_DIALOG}"]`).waitForDisplayed({
      timeout: 15_000,
    });

    // RICH_MODEL_A 已导入 → 禁选；RICH_MODEL_B 仍可选。
    const richACheckbox = $(
      `[data-testid="${testId(TID_MODEL_DISCOVERY_MODEL_CHECKBOX, RICH_MODEL_A)}"]`,
    );
    await richACheckbox.waitForDisplayed({ timeout: 10_000 });
    expect(await richACheckbox.getAttribute("disabled")).toBeTruthy();
    const richBCheckbox = $(
      `[data-testid="${testId(TID_MODEL_DISCOVERY_MODEL_CHECKBOX, RICH_MODEL_B)}"]`,
    );
    await richBCheckbox.waitForDisplayed({ timeout: 10_000 });
    expect(await richBCheckbox.getAttribute("disabled")).toBeFalsy();
    await richBCheckbox.click();
    await browser.waitUntil(
      async () => (await richBCheckbox.getAttribute("data-state")) === "checked",
      { timeout: 10_000, timeoutMsg: "RICH_MODEL_B checkbox should be checked after click" },
    );
    await clickTestIdByDom(TID_MODEL_DISCOVERY_CONFIRM_BUTTON);
    await browser.waitUntil(
      async () => !(await $(`[data-testid="${TID_MODEL_DISCOVERY_DIALOG}"]`).isDisplayed()),
      { timeout: 15_000, timeoutMsg: "Discovery dialog should close after second import" },
    );
    const modelIds = await readPersonalConfigModelIds();
    expect(modelIds).toContain(RICH_MODEL_A);
    expect(modelIds).toContain(RICH_MODEL_B);
    // 重复导入不产生重复成员。
    expect(modelIds.filter((id) => id === RICH_MODEL_A)).toHaveLength(1);
  });
});
