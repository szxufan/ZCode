import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TID_PLAN_CARD_SAVE, TID_PLAN_DETAIL_SAVE } from "@zcode/shared/test-ids";

import { DEFAULT_WORKSPACE, clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockContaining } from "#e2e/helpers/conversation-session-tool";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

// 候选用例（manual-review/pending，对应 catalog PSV01–PSV03、docs/ui/plan-detail-side-pane.md「保存计划」）：
// mock 原生另存为对话框并回读文件字节，断言 defaultPath 落在 docs/superpowers/plans（不存在则回退
// 工作区根目录）、文件内容等于计划原文；取消不产生文件。目录是否存在由 main 判定。

const PROMPT_MARKER = "E2E_PLAN_SAVE_TO_FILE";
const ENTER_MARKER = "E2E_PLAN_SAVE_TO_FILE_ENTER_PLAN";
const EXIT_MARKER = "E2E_PLAN_SAVE_TO_FILE_EXIT_PLAN";
const PLAN_TITLE = "E2E 计划保存标题";
const PLAN_BODY_MARKER = "E2E_PLAN_SAVE_TO_FILE_PLAN_BODY";
const PLAN_TEXT =
  `# ${PLAN_TITLE}\n\n` +
  `${PLAN_BODY_MARKER}: verify the plan card and detail pane save the plan text.`;
const EXIT_TOOL_CALL_ID = "toolu_e2e_plan_save_to_file_exit";
const APPROVED_MESSAGE = "User has approved your plan";
const DENIED_MESSAGE = "The plan was not approved by the user.";

const DOCS_DIR = join(DEFAULT_WORKSPACE, "docs");
const SUPERPOWERS_DIR = join(DOCS_DIR, "superpowers");
const PLANS_DIR = join(SUPERPOWERS_DIR, "plans");
const SAVE_ROOT = join(DEFAULT_WORKSPACE, ".zcode-e2e", "plan-save");
const createdDirectories: string[] = [];

describe("conversation session plan save to file", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(SAVE_ROOT, { recursive: true, force: true });
    for (const directory of createdDirectories.reverse()) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("PSV01-03: 计划卡片与详情侧栏另存为计划原文，默认目录优先 plans", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    await createDirectoryIfMissing(SUPERPOWERS_DIR);
    await createDirectoryIfMissing(PLANS_DIR);
    await mkdir(SAVE_ROOT, { recursive: true });

    const runId = Date.now();
    await sendV4Prompt(
      [
        `${PROMPT_MARKER}_${runId}: enter plan mode and request approval.`,
        `${ENTER_MARKER}: call EnterPlanMode before drafting.`,
        `${EXIT_MARKER}: call ExitPlanMode with the proposed plan.`,
      ].join(" "),
    );
    await waitForV4TimelineContaining(PROMPT_MARKER);
    const activeTask = await waitForV4Pane(
      (snapshot) => snapshot.sessionId !== null && snapshot.sessionId !== "draft",
      "plan save 没有创建 session",
      30_000,
    );
    const sessionId = activeTask.sessionId;
    if (!sessionId || sessionId === "draft") throw new Error("plan save sessionId 为空");

    await waitForUpstreamRequest(
      {
        includes: [EXIT_MARKER, "toolu_e2e_plan_save_to_file_enter"],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan save ExitPlanMode request",
      60_000,
    );
    await waitForPlanApprovalDialog(60_000);

    const save = await browser.electron.mock("dialog", "showSaveDialog");
    const expectedFileName = `${formatLocalDate(new Date())}-E2E-计划保存标题.md`;

    // PSV03：取消另存为不产生文件。
    await save.mockResolvedValue({ canceled: true });
    await clickTestIdByDom(TID_PLAN_CARD_SAVE);
    await browser.waitUntil(
      async () => {
        try {
          await expect(save).toHaveBeenCalledTimes(1);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000, timeoutMsg: "取消保存没有进入原生另存为入口" },
    );
    expect(await exists(join(PLANS_DIR, expectedFileName))).toBe(false);

    // PSV01：卡片保存，defaultPath 落在 docs/superpowers/plans，内容等于计划原文。
    const cardTarget = join(SAVE_ROOT, "card.md");
    await save.mockResolvedValue({ canceled: false, filePath: cardTarget });
    await clickTestIdByDom(TID_PLAN_CARD_SAVE);
    await waitForSavedFile(cardTarget);
    const cardSavePath = await readLastSaveDialogDefaultPath();
    expect(dirname(cardSavePath)).toBe(PLANS_DIR);
    expect(basename(cardSavePath)).toBe(expectedFileName);

    // 批准让会话继续，随后打开计划详情侧栏再保存一次。
    await approvePlanFromDialog();
    await waitForPlanApprovalDialogClosed(30_000);
    // 请求体是 JSON，计划原文里的换行会被转义，所以这里只断言不含换行的正文标记。
    await waitForUpstreamRequest(
      {
        includes: [EXIT_TOOL_CALL_ID, PLAN_BODY_MARKER, APPROVED_MESSAGE],
        excludes: [DENIED_MESSAGE, "Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan save approved continuation request",
      60_000,
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
      "plan save 批准后的会话没有结束",
      60_000,
    );

    await openPlanDetailFromCard();
    await browser.waitUntil(
      async () =>
        Boolean(
          await browser.execute(() =>
            Boolean(document.querySelector("[data-plan-detail-tool-call-id]")),
          ),
        ),
      { timeout: 30_000, timeoutMsg: "计划详情侧栏没有打开" },
    );

    const paneTarget = join(SAVE_ROOT, "pane.md");
    await save.mockResolvedValue({ canceled: false, filePath: paneTarget });
    await clickTestIdByDom(TID_PLAN_DETAIL_SAVE);
    await waitForSavedFile(paneTarget);
    expect(dirname(await readLastSaveDialogDefaultPath())).toBe(PLANS_DIR);

    // PSV02：plans 目录不存在时回退到工作区根目录。
    await rm(PLANS_DIR, { recursive: true, force: true });
    createdDirectories.splice(createdDirectories.indexOf(PLANS_DIR), 1);
    const rootTarget = join(SAVE_ROOT, "root.md");
    await save.mockResolvedValue({ canceled: false, filePath: rootTarget });
    await clickTestIdByDom(TID_PLAN_DETAIL_SAVE);
    await waitForSavedFile(rootTarget);
    const rootSavePath = await readLastSaveDialogDefaultPath();
    expect(dirname(rootSavePath)).toBe(DEFAULT_WORKSPACE);
    expect(basename(rootSavePath)).toBe(expectedFileName);
  });
});

async function createDirectoryIfMissing(directory: string) {
  if (await exists(directory)) return;
  await mkdir(directory, { recursive: true });
  createdDirectories.push(directory);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForSavedFile(target: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        return (await readFile(target, "utf8")) === PLAN_TEXT;
      } catch {
        return false;
      }
    },
    { timeout: 15_000, timeoutMsg: `另存为没有把计划原文写入 ${target}` },
  );
}

async function readLastSaveDialogDefaultPath(): Promise<string> {
  const defaultPath = await browser.electron.execute((electron) => {
    const calls = (
      electron.dialog.showSaveDialog as unknown as {
        mock: { calls: Array<Array<{ defaultPath?: string }>> };
      }
    ).mock.calls;
    return calls.at(-1)?.at(-1)?.defaultPath;
  });
  if (!defaultPath) throw new Error("原生另存为没有被调用，拿不到 defaultPath");
  return defaultPath;
}

function formatLocalDate(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join("-");
}

async function waitForPlanApprovalDialog(timeoutMs: number) {
  let latestDialogText = "";
  await browser.waitUntil(
    async () => {
      latestDialogText = await browser.execute(() => {
        const body = document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]');
        return body?.innerText ?? "";
      });
      return ["Approve", "批准"].some((text) => latestDialogText.includes(text));
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `ExitPlanMode 计划审批弹窗没有出现; latest=${latestDialogText}`,
    },
  );
}

async function approvePlanFromDialog(): Promise<void> {
  const approved = await browser.execute(() => {
    const body = document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]');
    const approve = Array.from(
      body?.querySelectorAll<HTMLButtonElement>('button[role="option"]') ?? [],
    ).find((button) =>
      ["Approve", "批准"].some((label) => (button.textContent ?? "").includes(label)),
    );
    if (!approve) return false;
    approve.click();
    return true;
  });
  if (!approved) throw new Error("计划审批弹窗里没有找到批准选项");
}

async function waitForPlanApprovalDialogClosed(timeoutMs: number): Promise<void> {
  await browser.waitUntil(
    async () =>
      !(await browser.execute(() =>
        Boolean(document.querySelector('[data-elicitation-dialog-footer="true"]')),
      )),
    {
      timeout: timeoutMs,
      timeoutMsg: "批准后 ExitPlanMode 计划审批弹窗没有关闭",
    },
  );
}

async function openPlanDetailFromCard(): Promise<void> {
  await waitForToolCallBlockContaining(PLAN_TITLE, 60_000);
  // browser.execute 的函数体在渲染进程里执行，不能引用模块常量，test id 作为参数传入。
  const opened = await browser.execute((saveButtonTestId: string) => {
    const saveButton = document.querySelector(`[data-testid="${saveButtonTestId}"]`);
    const card = saveButton?.closest('section[role="button"]');
    const heading = card?.querySelector("h3");
    if (!(heading instanceof HTMLElement)) return false;
    heading.click();
    return true;
  }, TID_PLAN_CARD_SAVE);
  if (!opened) throw new Error("没有找到计划卡片，无法打开计划详情侧栏");
}
