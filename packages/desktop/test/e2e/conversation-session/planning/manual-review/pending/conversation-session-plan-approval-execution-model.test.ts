import { TID_PLAN_APPROVAL_EXECUTION_MODEL_TRIGGER } from "@zcode/shared/test-ids";

import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { UPSTREAM_MODEL } from "#e2e/helpers/upstream-provider";
import {
  E2E_REPLY_TOKEN,
  getV4ModelConfig,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

// 候选用例（manual-review/pending，对应 catalog PEM01、docs/specs/plan-approval-execution-model.md）。
// E2E 只注册了一个上游模型，所以「换模型」在这里表现为在审批弹窗的执行模型字段里重新选中同一模型
// （取注册表默认思考档）。本用例证明的是端到端接线：CLI 在审批请求里声明能力 → 弹窗渲染字段 →
// 选中后批准 → 弹窗关闭、同一轮继续、会话模型仍是选中的那个。先切换后提交的顺序、切换失败保持
// 弹窗、带修改意见不携带执行模型（PEM02–PEM04）由 UI 单测 settlePlanApproval 与 ElicitationDialog
// 覆盖；固定执行模型轮次与创建失败兜底（PEM05）由 CLI 单测覆盖。

const PROMPT_MARKER = "E2E_PLAN_EXEC_MODEL";
const ENTER_MARKER = "E2E_PLAN_EXEC_MODEL_ENTER_PLAN";
const EXIT_MARKER = "E2E_PLAN_EXEC_MODEL_EXIT_PLAN";
const PLAN_BODY =
  "E2E_PLAN_EXEC_MODEL_PLAN_BODY: verify the approval dialog offers an execution model.";
const EXIT_TOOL_CALL_ID = "toolu_e2e_plan_exec_model_exit";
const APPROVED_MESSAGE = "User has approved your plan";
const DENIED_MESSAGE = "The plan was not approved by the user.";

describe("conversation session plan approval execution model", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PEM01: 审批弹窗提供执行模型，选中后批准仍在本轮继续", async function () {
    this.timeout(150_000);
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");

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
      "plan approval execution model 没有创建 session",
      30_000,
    );
    const sessionId = activeTask.sessionId;
    if (!sessionId || sessionId === "draft") {
      throw new Error("plan approval execution model sessionId 为空");
    }

    await waitForUpstreamRequest(
      {
        includes: [EXIT_MARKER, "toolu_e2e_plan_exec_model_enter"],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan approval execution model ExitPlanMode request",
      60_000,
    );
    await waitForPlanApprovalDialog(60_000);

    // 能力由 CLI 逐请求声明：只有主会话来源的审批才渲染执行模型字段。
    const trigger = $(`[data-testid="${TID_PLAN_APPROVAL_EXECUTION_MODEL_TRIGGER}"]`);
    await trigger.waitForDisplayed({ timeout: 30_000 });
    expect((await getV4ModelConfig()).model).toBe(UPSTREAM_MODEL);

    await trigger.click();
    await pickExecutionModel(UPSTREAM_MODEL);

    await approvePlanFromDialog();
    await waitForPlanApprovalDialogClosed(30_000);
    await waitForUpstreamRequest(
      {
        includes: [EXIT_TOOL_CALL_ID, PLAN_BODY, APPROVED_MESSAGE],
        excludes: [DENIED_MESSAGE, "Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan approval execution model continuation request",
      60_000,
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
      "plan approval execution model 批准后的会话没有结束",
      60_000,
    );
    // E2E 只有一个模型：选中的执行模型就是会话当前模型，批准后会话模型保持为它。
    expect((await getV4ModelConfig()).model).toBe(UPSTREAM_MODEL);
  });
});

/** 非 composer 形态是两级菜单：先供应商（子菜单触发器），再该供应商下的模型。 */
async function pickExecutionModel(model: string): Promise<void> {
  await browser.waitUntil(
    async () => browser.execute(() => Boolean(document.querySelector('[role="menu"]'))),
    { timeout: 10_000, timeoutMsg: "执行模型菜单没有打开" },
  );
  const opened = await browser.execute(() => {
    // 一级菜单里只有「会话模型」是 menuitemradio，其余 menuitem 是供应商子菜单触发器。
    const providerTrigger = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).at(-1);
    if (!providerTrigger) return false;
    providerTrigger.click();
    return true;
  });
  if (!opened) throw new Error("执行模型菜单里没有供应商子菜单");
  await browser.waitUntil(async () => clickExecutionModelOption(model), {
    timeout: 10_000,
    timeoutMsg: `执行模型菜单里没有模型 ${model}`,
  });
}

function clickExecutionModelOption(model: string): Promise<boolean> {
  return browser.execute((modelId: string) => {
    // 「会话模型」首项的名字也是当前模型，靠徽标文案把它排除。
    const isSessionModelItem = (text: string) =>
      text.includes("Session model") || text.includes("会话模型");
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ).find(
      (item) =>
        (item.textContent ?? "").includes(modelId) && !isSessionModelItem(item.textContent ?? ""),
    );
    if (!option) return false;
    option.click();
    return true;
  }, model);
}

async function waitForPlanApprovalDialog(timeoutMs: number): Promise<void> {
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
      browser.execute(() => !document.querySelector('[data-elicitation-dialog-footer="true"]')),
    {
      timeout: timeoutMs,
      timeoutMsg: "批准后 ExitPlanMode 计划审批弹窗没有关闭",
    },
  );
}
