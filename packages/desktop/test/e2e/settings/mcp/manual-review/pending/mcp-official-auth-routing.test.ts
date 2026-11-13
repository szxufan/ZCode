import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_PLUGIN_MCP_SERVER_ROW,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { OFFICIAL_AUTH_ROUTING_SERVER } from "#e2e/helpers/mcp-official-auth-routing-fixture";
import { runOfficialMcpRoutingRuntime } from "#e2e/helpers/mcp-official-auth-routing-runtime";

const paths = getE2EAppDataPaths();
const rowId = testId(TID_PLUGIN_MCP_SERVER_ROW, OFFICIAL_AUTH_ROUTING_SERVER);
const artifactDir =
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(paths.homeDir, "official-mcp-artifacts");

async function openSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "mcp"));
  await waitForTestIdByDom(rowId);
}

async function waitConnected() {
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) =>
          document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-mcp-status") ===
          "connected",
        rowId,
      ),
    { timeout: 30_000, timeoutMsg: "已登录的官方 MCP 设置探测未连接成功" },
  );
}

describe("官方 MCP 设置探测授权路由（候选）", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("OMCP-SETTINGS-01: 设置探测使用独立 CLI 取得当前授权，不替换聊天进程", async function () {
    this.timeout(180_000);
    await mkdir(artifactDir, { recursive: true });
    await prepareV4ConversationE2E({ skipProvider: true });
    await openSettings();
    try {
      await waitConnected();
    } finally {
      await browser.saveScreenshot(join(artifactDir, "OMCP-SETTINGS-01.png"));
      await writeFile(
        join(artifactDir, "OMCP-SETTINGS-01-dom.txt"),
        await browser.execute(() => document.body.innerText),
      );
    }
    const fixtureUrl = process.env.ZCODE_E2E_OFFICIAL_AUTH_ROUTING_URL;
    expect(fixtureUrl).toBeTruthy();
    const evidence = (await (await fetch(`${fixtureUrl}/__e2e/status`)).json()) as {
      requests: Array<{ method: string; authenticated: boolean }>;
    };
    expect(
      evidence.requests.some((entry) => entry.method === "initialize" && entry.authenticated),
    ).toBe(true);
    expect(
      evidence.requests.some((entry) => entry.method === "tools/list" && entry.authenticated),
    ).toBe(true);
    const log = await readFile(
      join(
        artifactDir,
        "runtime-logs",
        "0-0",
        "desktop",
        `${new Date().toISOString().slice(0, 10)}.log`,
      ),
      "utf8",
    );
    expect(log.includes("官方 MCP 身份头已解析")).toBe(true);
    expect(log.includes("官方 MCP 身份头请求未通过工作区路由")).toBe(false);
    await writeFile(
      join(artifactDir, "OMCP-SETTINGS-01-wire.json"),
      JSON.stringify(evidence, null, 2),
    );
  });

  // fork 适配说明：上游 OMCP-SETTINGS-04 通过旧手机远控（mobile pairing 页面）验证手机侧
  // 设置探测不带授权头；本 fork 已移除该链路（手机 Web 走 Relay V3 恢复语义，不承载设置探测），
  // 该子用例随旧手机远控一并裁撤，官方 MCP 授权头不下发到手机侧的约束由 Relay V3 数据面回归承接。

  it("OMCP-SETTINGS-02/03: 真实控制面进程切换、重建与恶意反向授权隔离", async function () {
    this.timeout(180_000);
    await runOfficialMcpRoutingRuntime(artifactDir);
  });
});
