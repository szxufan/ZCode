import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import {
  RUNTIME_MODE_REMINDER_CONFIG,
  TODO_REMINDER_CONFIG,
  buildDateChangeReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeModeReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildSilentTurnReminderBody,
  buildTodoReminderBody,
  buildProviderRequestMessages,
  buildRepeatedToolCallReminderBody,
  buildToolCallBudgetReminderBody,
  formatConversationForkNoticeBody,
  getTodoReminderTurnCounts,
  runtimeMetadataForSyntheticUserMessageSource,
  shouldBuildTodoReminder,
} from "../src/runtime/helpers/index.js";
import {
  legacySyntheticRuntimeMetadata,
  realUserRuntimeMetadata,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../src/agent/message-history.js";
import { runtimeInputMetadata } from "../src/agent/runtime-input-presentation.js";

describe("runtime request reminders", () => {
  const silentTurn = (name = "Read"): RuntimeMessageEntry => ({
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call", name, input: {} }],
    },
  });
  const silentReminder = () =>
    systemReminderAttachmentEntry("silent_turn_reminder", "previous silence reminder");
  // 历史里作为普通 user 消息的输入都算一个用户轮次，不只真实 prompt。
  const userTurnInputs: RuntimeMessageEntry[] = [
    {
      message: { role: "user", content: "<task-notification>done</task-notification>" },
      metadata: runtimeInputMetadata("task_notification"),
    },
    {
      message: { role: "user", content: "agent reply" },
      metadata: runtimeInputMetadata("subagent_reply"),
    },
    {
      message: { role: "user", content: "[Request interrupted by user]" },
      metadata: { source: "interrupt_marker" },
    },
    {
      message: { role: "user", content: "summary" },
      metadata: { source: "legacy_synthetic", compactBoundary: { boundaryId: "b1" } },
    },
  ];

  // 静默提醒按时间判定（meta-user-context.md「Silent-turn reminder」）：最近一次提醒之后至少一次静默响应，
  // 且距锚点（最近一次提醒与本段起点中较新的一个）满 60 秒。条目时间单位是毫秒，这里用秒构造。
  const at = (seconds: number, entry: RuntimeMessageEntry): RuntimeMessageEntry => ({
    ...entry,
    time: seconds * 1000,
  });
  const prompt = (seconds: number) =>
    at(seconds, {
      message: { role: "user", content: "Inspect the code" },
      metadata: realUserRuntimeMetadata(),
    });
  const silentAt = (...seconds: number[]) => seconds.map((second) => at(second, silentTurn()));
  const reminderAt = (seconds: number) => at(seconds, silentReminder());
  const fires = (entries: RuntimeMessageEntry[], nowSeconds: number) =>
    buildSilentTurnReminderBody(entries, nowSeconds * 1000) !== null;

  it("emits a silent reminder after 60 seconds and one silent response", () => {
    expect(buildSilentTurnReminderBody([prompt(0), ...silentAt(61)], 61_000)).toBe(
      "用户已经有一段时间没有收到你的消息了。继续任务时，有值得告知的进展（发现、计划变更）请主动同步。",
    );
    // 满 60 000 毫秒才发：59.999 秒还不到。
    expect(buildSilentTurnReminderBody([prompt(0), ...silentAt(10)], 59_999)).toBeNull();
    expect(fires([prompt(0), ...silentAt(10)], 60)).toBe(true);
    // 时钟回拨（现在早于锚点）时不发。
    expect(fires([prompt(100), ...silentAt(110)], 50)).toBe(false);
    // 没有静默响应时不发。
    expect(fires([prompt(0)], 600)).toBe(false);
  });

  it("does not emit for many fast silent responses", () => {
    const fast = Array.from({ length: 20 }, (_, index) => at(index / 10, silentTurn()));
    expect(fires([prompt(0), ...fast], 2)).toBe(false);
    expect(fires([prompt(0), ...fast], 60)).toBe(true);
  });

  it("counts reasoning, empty text and placeholders as silent responses", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "assistant", content: [{ type: "reasoning", text: "thinking" }] } },
      {
        message: {
          role: "assistant",
          content: [{ type: "reasoning", text: "", providerOptions: { opaque: {} } }],
        },
      },
      { message: { role: "assistant", content: "  " } },
      { message: { role: "assistant", content: "(no content)" } },
      { message: { role: "assistant", content: "No response requested." } },
    ];
    for (const entry of entries) expect(fires([prompt(0), at(70, entry)], 70)).toBe(true);
  });

  it.each<RuntimeMessageEntry>([
    { message: { role: "assistant", content: "Found the cause." } },
    {
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "An update." },
        ],
      },
    },
    {
      message: { role: "user", content: "<system-reminder>User's own text</system-reminder>" },
      metadata: realUserRuntimeMetadata(),
    },
    { message: { role: "user", content: "legacy real input" } },
    ...userTurnInputs,
    silentTurn("AskUserQuestion"),
    silentTurn("ExitPlanMode"),
  ])("restarts the timer at effective communication %j", (boundary) => {
    const oldStretch = [prompt(0), reminderAt(61), ...silentAt(70, 130)];
    const entries = [...oldStretch, at(200, boundary), ...silentAt(210)];
    expect(fires(entries, 259)).toBe(false);
    expect(fires(entries, 260)).toBe(true);
    // 边界之后还没有静默响应时不发。
    expect(fires([...oldStretch, at(200, boundary)], 600)).toBe(false);
  });

  it("does not move the timer for tool results, synthetic context or mid-turn steers", () => {
    const entries: RuntimeMessageEntry[] = [
      prompt(0),
      ...silentAt(10).flatMap((entry) => [
        entry,
        at(20, { message: { role: "tool", content: "read result", toolCallId: "call" } }),
        at(30, { message: { role: "user", content: "legacy tool result", toolCallId: "call" } }),
        at(40, systemReminderAttachmentEntry("environment", "environment")),
        at(50, {
          message: { role: "user", content: "background notice" },
          metadata: legacySyntheticRuntimeMetadata(),
        }),
        at(55, {
          message: { role: "user", content: "also check the tests" },
          metadata: runtimeInputMetadata("user_steer"),
        }),
      ]),
    ];
    expect(fires(entries, 60)).toBe(true);
  });

  it("waits 60 seconds after each reminder and has no cap per stretch", () => {
    const entries = [prompt(0), ...silentAt(30)];
    let reminder = 60;
    for (let count = 0; count < 6; count++) {
      expect(fires(entries, reminder)).toBe(true);
      entries.push(reminderAt(reminder));
      // 提醒之后还没有静默响应。
      expect(fires(entries, reminder + 120)).toBe(false);
      entries.push(...silentAt(reminder + 1));
      expect(fires(entries, reminder + 59)).toBe(false);
      reminder += 60;
    }
    expect(fires(entries, reminder)).toBe(true);
  });

  it("does not emit when the anchor has no time", () => {
    const untimedPrompt: RuntimeMessageEntry = {
      message: { role: "user", content: "Inspect the code" },
      metadata: realUserRuntimeMetadata(),
    };
    expect(fires([untimedPrompt, ...silentAt(70)], 600)).toBe(false);
    // 最近一次提醒没有时间：不退回更早的锚点。
    expect(fires([prompt(0), silentReminder(), ...silentAt(70)], 600)).toBe(false);
  });
  it("maps a subagent message to direct user-like runtime metadata", () => {
    expect(runtimeMetadataForSyntheticUserMessageSource("subagent_message")).toEqual(
      legacySyntheticRuntimeMetadata(),
    );
  });

  it("maps a persisted plugin reference back to its attachment source", () => {
    expect(runtimeMetadataForSyntheticUserMessageSource("plugin_reference")).toEqual({
      source: "plugin_reference",
    });
  });

  it("builds a one-time plan mode exit reminder", () => {
    const body = buildPlanModeExitReminderBody();

    expect(body).toContain("## 已退出计划模式");
    expect(body).toContain("现在可以进行编辑、运行工具和执行操作");
    expect(body).not.toContain("<system-reminder>");
    expect(body).not.toContain("source=");
  });

  it("counts assistant turns since the latest TodoWrite and todo reminder markers", () => {
    const entries = [
      { message: { role: "user" as const, content: "start" }, metadata: realUserRuntimeMetadata() },
      {
        message: {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "todo-write-1", name: "TodoWrite", input: {} }],
        },
      },
      {
        message: {
          role: "tool" as const,
          content: "ok",
          toolCallId: "todo-write-1",
          toolName: "TodoWrite",
        },
      },
      { message: { role: "assistant" as const, content: "after write 1" } },
      {
        message: { role: "user" as const, content: "todo reminder" },
        metadata: { source: "todo_reminder" as const },
      },
      { message: { role: "assistant" as const, content: "after reminder 1" } },
      { message: { role: "assistant" as const, content: "after reminder 2" } },
    ];

    expect(getTodoReminderTurnCounts(entries)).toEqual({
      turnsSinceLastReminder: 2,
      turnsSinceLastTodoWrite: 3,
    });
  });

  it("stops scanning todo cadence history once both latest markers are found", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "assistant", content: "old assistant turn" } },
      { message: { role: "assistant", content: "older assistant turn" } },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "todo-write-latest", name: "TodoWrite", input: {} }],
        },
      },
      {
        message: { role: "user", content: "latest todo reminder" },
        metadata: { source: "todo_reminder" },
      },
      { message: { role: "assistant", content: "newer assistant turn" } },
    ];
    const guardedEntries = new Proxy(entries, {
      get(target, property, receiver) {
        if (property === "0" || property === "1") {
          throw new Error("older history should not be read after both todo markers are found");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(getTodoReminderTurnCounts(guardedEntries)).toEqual({
      turnsSinceLastReminder: 1,
      turnsSinceLastTodoWrite: 1,
    });
  });

  it("treats sessions without TodoWrite or prior todo reminders as counting from the start", () => {
    const entries = Array.from({ length: TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE }, (_, index) => ({
      message: { role: "assistant" as const, content: `assistant turn ${index}` },
    }));

    expect(getTodoReminderTurnCounts(entries)).toEqual({
      turnsSinceLastReminder: TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS,
      turnsSinceLastTodoWrite: TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE,
    });
  });

  it("resets todo cadence when TodoWrite appears in a recent assistant turn", () => {
    const entries = [
      { message: { role: "assistant" as const, content: "old assistant 1" } },
      {
        message: {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "todo-write-recent", name: "TodoWrite", input: {} }],
        },
      },
      {
        message: {
          role: "tool" as const,
          content: "ok",
          toolCallId: "todo-write-recent",
          toolName: "TodoWrite",
        },
      },
      { message: { role: "assistant" as const, content: "recent assistant" } },
    ];

    expect(getTodoReminderTurnCounts(entries)).toMatchObject({
      turnsSinceLastTodoWrite: 1,
    });
  });

  it("allows another todo reminder when the previous marker is old enough", () => {
    const entries = [
      {
        message: { role: "user" as const, content: "old todo reminder" },
        metadata: { source: "todo_reminder" as const },
      },
      ...Array.from({ length: TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS }, (_, index) => ({
        message: { role: "assistant" as const, content: `assistant turn ${index}` },
      })),
    ];

    expect(shouldBuildTodoReminder(entries)).toBe(true);
  });

  it("omits todo list details when a due reminder has no current todos", () => {
    const body = buildTodoReminderBody([]);
    expect(body).toContain("最近没有使用 TodoWrite 工具。");
    expect(body).not.toContain("<system-reminder>");
    expect(body).toContain("仅在与当前工作相关时使用");
    expect(body).toContain("无关请忽略");
    expect(body).not.toContain("以下是你当前 todo 清单的内容：");
    expect(body).not.toContain("[pending]");
  });

  it("builds an aligned todo reminder without the old authoritative todo_state wording", () => {
    const body = buildTodoReminderBody([
      {
        content: "Review prompt trajectory output",
        priority: "high",
        status: "in_progress",
      },
    ]);
    expect(body).toContain("1. [in_progress] Review prompt trajectory output");
    expect(body).not.toContain("<system-reminder>");
    expect(body).toContain("最近没有使用 TodoWrite 工具。");
    expect(body).toContain("仅在与当前工作相关时使用");
    expect(body).toContain("无关请忽略");
    expect(body).toContain("以下是你当前 todo 清单的内容：");
    expect(body).not.toContain("Current session todo state (authoritative):");
    expect(body).not.toContain("source=");
  });

  it("builds date change reminder with no-user-mention wording", () => {
    const body = buildDateChangeReminderBody("2026-06-03", "2026-06-04");
    expect(body).toContain("日期已变化。今天是 2026-06-04。");
    expect(body).not.toContain("<system-reminder>");
    expect(body).toContain("不要向用户明确提及这一点");
    expect(body).not.toContain("from 2026-06-03 to 2026-06-04");
  });

  it("escapes nested system reminder-like text in conversation fork notices", () => {
    const body = formatConversationForkNoticeBody({
      parentSessionId: createSessionId("parent-<system-reminder>") as never,
      targetMessageId: "message-</system-reminder>" as never,
    });
    expect(body).not.toContain("<system-reminder>");
    expect(body).not.toContain("</system-reminder>");

    expect(body).toContain("parentSessionId: sess_parent-&lt;system-reminder>");
    expect(body).toContain("targetMessageId: message-&lt;/system-reminder>");
  });

  it("builds output style reminder only for non-empty active style", () => {
    expect(buildRuntimeOutputStyleReminderBody(undefined)).toBeNull();
    expect(
      buildRuntimeOutputStyleReminderBody({
        name: "Default",
        prompt: "   ",
      }),
    ).toBeNull();

    const body = buildRuntimeOutputStyleReminderBody({
      name: "Learning",
      prompt: "Explain tradeoffs while solving the task.",
    });

    expect(body).toBe(
      "Learning 输出风格已生效。请继续遵循该风格的具体指引。",
    );
  });

  it("builds plan mode reminders with human-turn cadence and full/sparse cycle", () => {
    const firstBody = buildRuntimeModeReminderBody(
      [{ message: { role: "user", content: "make a plan" }, metadata: realUserRuntimeMetadata() }],
      "plan",
    );
    expect(firstBody).toContain("计划模式已激活");
    expect(firstBody).not.toContain("<system-reminder>");

    expect(firstBody).toContain("必须不做任何编辑");
    expect(firstBody).toContain("## 计划工作流（Plan Workflow）");
    expect(firstBody).not.toContain("ExitPlanModeV2");

    const recent = buildRuntimeModeReminderBody(
      [
        {
          message: { role: "user", content: "old full plan reminder" },
          metadata: { source: "runtime_mode" },
        },
        ...Array.from(
          { length: RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS - 1 },
          (_, index) => ({
            message: { role: "user" as const, content: `follow up ${index}` },
            metadata: realUserRuntimeMetadata(),
          }),
        ),
      ],
      "plan",
    );
    expect(recent).toBeNull();

    const sparse = buildRuntimeModeReminderBody(
      [
        {
          message: { role: "user", content: "old full plan reminder" },
          metadata: { source: "runtime_mode" },
        },
        ...Array.from(
          { length: RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS },
          (_, index) => ({
            message: { role: "user" as const, content: `follow up ${index}` },
            metadata: realUserRuntimeMetadata(),
          }),
        ),
      ],
      "plan",
    );
    expect(sparse).toContain("计划模式仍然生效");
    expect(sparse).toContain("只读。");
    expect(sparse).not.toContain("## 计划工作流（Plan Workflow）");
    expect(sparse).not.toContain("<system-reminder>");

    const nextFull = buildRuntimeModeReminderBody(
      [
        ...Array.from(
          { length: RUNTIME_MODE_REMINDER_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS },
          (_, index) => ({
            message: { role: "user" as const, content: `prior runtime reminder ${index}` },
            metadata: { source: "runtime_mode" as const },
          }),
        ),
        ...Array.from(
          { length: RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS },
          (_, index) => ({
            message: { role: "user" as const, content: `later follow up ${index}` },
            metadata: realUserRuntimeMetadata(),
          }),
        ),
      ],
      "plan",
    );
    expect(nextFull).toContain("计划模式已激活");

    expect(buildRuntimeModeReminderBody([], "build")).toBeNull();
  });

  // 适配说明：上游为五阶段英文工作流（Final Plan 独立成阶段）；fork 的系统提示词中文化使用中文四阶段，
  // 最终计划并入阶段 4。合并上游时不随上游的五阶段断言改回。
  // 阶段 4 必须带齐计划正文要求（spec：docs/design/v2/tool/16-plan-mode.md「规划提醒」），
  // 否则生成的计划没有固定结构、也没有决策段。固定结构的丢失源于合并上游 v3.17.2 时未把
  // Final Plan 的正文约束带进阶段 4；决策段是本次新增要求。
  it("renders the complete four-phase plan workflow without a template exception", () => {
    const body = buildRuntimeModeReminderBody([], "plan")!;
    expect(body.match(/^### 阶段 \d：.+$/gm)).toEqual([
      "### 阶段 1：初步理解",
      "### 阶段 2：设计",
      "### 阶段 3：评审",
      "### 阶段 4：最终计划与调用 ExitPlanMode",
    ]);
    expect(body).toContain("本阶段只允许使用 Explore 子代理类型");
    expect(body).toContain("阅读关键文件加深理解");

    // 澄清结论回写：阶段 3 问到的用户选择必须落进决策段。
    expect(body).toContain("把澄清结论回写进计划");

    // 计划正文分节及顺序：Context → 决策 → 实现步骤 → 验证。
    const sectionIndexes = ["**Context**", "**决策**", "**实现步骤**", "**验证**"].map((section) =>
      body.indexOf(section),
    );
    expect(sectionIndexes.every((index) => index >= 0)).toBe(true);
    expect([...sectionIndexes].sort((a, b) => a - b)).toEqual(sectionIndexes);

    // 决策段：单独成段，每条写清三要素并标注来源，不为凑数编造备选。
    expect(body).toContain("**决策**：单独成段");
    expect(body).toContain("决定了什么、备选方案、选择理由");
    expect(body).toContain("「用户已确认」");
    expect(body).toContain("「模型判断」");
    expect(body).toContain("不为凑数编造备选");

    // 实现步骤只展开推荐方案；完整计划经 plan 参数提交。
    expect(body).toContain("只展开推荐方案");
    expect(body).toContain("应复用的既有函数、工具及其路径");
    expect(body).toContain("如何端到端验证改动");
    expect(body).toContain("把完整计划放进 `plan` 参数");
    expect(body).toContain("只用于澄清需求或在方案之间做选择");
    expect(body).not.toMatch(/^### Phase /m);
  });

  // 修复原因：子会话继承 Plan 后收到主会话的五阶段提醒，被要求再派生 Explore、以
  // AskUserQuestion 或 ExitPlanMode 收尾，而子会话没有这些工具。
  // 断言按 fork 中文文案适配：完整提醒首段仍是“计划模式已激活……”。
  it("gives subagent children a read-only plan reminder without the main workflow", () => {
    for (const askUserQuestionAvailable of [true, false]) {
      const body = buildRuntimeModeReminderBody([], "build", true, { askUserQuestionAvailable })!;
      expect(body).toContain("计划模式已激活");
      expect(body).toContain("read-only");
      expect(body).not.toMatch(/### 阶段|ExitPlanMode|Explore 子代理/);
      if (askUserQuestionAvailable) expect(body).toContain("AskUserQuestion");
      else expect(body).not.toContain("AskUserQuestion");
    }
    expect(
      buildRuntimeModeReminderBody([], "build", false, { askUserQuestionAvailable: true }),
    ).toBeNull();
    expect(buildRuntimeModeReminderBody([], "plan")).toContain(
      "### 阶段 4：最终计划与调用 ExitPlanMode",
    );
  });

  it("builds model anomaly reminder bodies without wrapping", () => {
    const budgetBody = buildToolCallBudgetReminderBody(42);
    const repeatedBody = buildRepeatedToolCallReminderBody("Read", 3);

    expect(budgetBody).toContain("This turn has already made 42 tool calls.");
    expect(repeatedBody).toContain("You have called Read with the same input 3 times in a row.");
    expect(budgetBody).not.toContain("<system-reminder>");
    expect(repeatedBody).not.toContain("<system-reminder>");
  });

  it("uses metadata instead of system-reminder text to find the latest real user", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "system", content: "system prompt" } },
      {
        message: {
          role: "user",
          content: "<system-reminder>\nuser typed this literal tag\n</system-reminder>",
        },
        metadata: realUserRuntimeMetadata(),
      },
    ];

    const { messages } = buildProviderRequestMessages({ entries, applyCacheControl: true });
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      cacheControl: { type: "ephemeral" },
    });
  });

  it("bubbles legacy synthetic system-reminder text before latest non-system cache-control finalization", () => {
    const entries: RuntimeMessageEntry[] = [
      {
        message: {
          role: "user",
          content: "<system-reminder>\nuser typed this literal tag\n</system-reminder>",
        },
        metadata: realUserRuntimeMetadata(),
      },
      {
        message: {
          role: "user",
          content: "<system-reminder>\nlegacy synthetic reminder\n</system-reminder>",
        },
        metadata: legacySyntheticRuntimeMetadata(),
      },
    ];

    const { messages } = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(messages).toEqual([
      {
        role: "user",
        content: "<system-reminder>\nlegacy synthetic reminder\n</system-reminder>",
      },
      {
        role: "user",
        content: "<system-reminder>\nuser typed this literal tag\n</system-reminder>",
        cacheControl: { type: "ephemeral" },
      },
    ]);
  });

  it("keeps a trailing legacy Plan reminder in the provider projection", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "system", content: "system prompt" } },
      {
        message: { role: "user", content: "compare prompts" },
        metadata: realUserRuntimeMetadata(),
      },
      {
        message: {
          role: "user",
          content: "<system-reminder>\n计划模式已激活\n</system-reminder>",
        },
        metadata: { source: "runtime_mode" },
      },
    ];

    const { messages } = buildProviderRequestMessages({ entries, applyCacheControl: true });
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({
      role: "user",
      content: "compare prompts",
    });
    expect(messages[2]).toMatchObject({
      role: "user",
      cacheControl: { type: "ephemeral" },
    });

    expect(JSON.stringify(messages[2]?.content)).toContain("计划模式已激活");
    const reminderTexts = String(JSON.stringify(messages));
    expect(reminderTexts).toContain("compare prompts");
    expect(JSON.stringify(messages)).not.toContain("projectionPolicy");
  });

  it("projects compact summary requests with attachment ordering and skipped cache write", () => {
    // 压缩请求与普通请求同一投影：摘要提示接在历史最后，跳过缓存写入。
    const { messages } = buildProviderRequestMessages({
      entries: [
        { message: { role: "system", content: "system prompt" } },
        {
          message: { role: "user", content: "<system-reminder>\nprefix\n</system-reminder>" },
          metadata: { source: "context_prefix" },
        },
        {
          message: { role: "user", content: "summarize this history" },
          metadata: realUserRuntimeMetadata(),
        },
        systemReminderAttachmentEntry("output_style", "Use concise output for this turn."),
        { message: { role: "user", content: "Create compact summary." } },
      ],
      applyCacheControl: true,
      skipCacheWrite: true,
    });

    expect(messages).toHaveLength(5);
    expect(messages[1]).toEqual({
      role: "user",
      content: "<system-reminder>\nprefix\n</system-reminder>",
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: "summarize this history",
      cacheControl: { type: "ephemeral" },
    });
    expect(messages[3]).toMatchObject({
      role: "user",
    });
    expect(messages[3]).not.toHaveProperty("cacheControl");
    expect(messages[4]).toEqual({
      role: "system",
      content: "Use concise output for this turn.",
    });
    expect(JSON.stringify(messages[3]?.content)).toContain("Create compact summary.");
    expect(JSON.stringify(messages)).not.toContain("output_style");
  });

  it("keeps a trailing newline after the request user context system-reminder close tag", () => {
    const { messages } = buildProviderRequestMessages({
      entries: [
        { message: { role: "system", content: "system prompt" } },
        systemReminderAttachmentEntry(
          "context_prefix",
          "As you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-06-28.",
        ),
        { message: { role: "user", content: "hello" }, metadata: realUserRuntimeMetadata() },
      ],
      // 补换行只在合并相邻 user 内容的协议上（Anthropic）。
      // fork 早先合并时漏掉了这个选项，断言与 src「不传时不补换行」的语义不符；恢复上游现行写法。
      foldRemindersIntoToolResults: true,
    });

    expect(messages[1]).toEqual({
      role: "user",
      content:
        "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-06-28.\n</system-reminder>\n",
    });
  });
});

