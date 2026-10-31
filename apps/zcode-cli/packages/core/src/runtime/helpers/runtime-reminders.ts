import {
  legacySyntheticRuntimeMetadata,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
} from "../../agent/message-history.js";
import type {
  CollaborationMode,
  OutputStylePromptConfig,
  SyntheticUserMessageSource,
  TodoItem,
} from "../deps.js";
import { ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "@zcode/contracts";
import { EXPLORE_AGENT_TYPE } from "../../subagent/explore.js";
import { isUserTurnInput } from "./provider-entry-origins.js";

export const RUNTIME_MODE_REMINDER_CONFIG = Object.freeze({
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
});

const planResearchAgentCount = 3;

function buildPlanWorkflow() {
  return `## 计划工作流（Plan Workflow）

### 阶段 1：初步理解
目标：通过阅读代码和向用户提问，全面理解用户的需求。关键：本阶段只允许使用 ${EXPLORE_AGENT_TYPE} 子代理类型。

1. 专注于理解用户的请求和相关代码。主动寻找可复用的现有函数、工具与模式——已有合适实现时不要另起炉灶。

2. **并行启动最多 ${planResearchAgentCount} 个 ${EXPLORE_AGENT_TYPE} 子代理**（单条消息、多个工具调用）来高效探索代码库。
   - 任务局限于已知文件、用户给了具体文件路径、或只做小改动时，用 1 个即可。
   - 范围不确定、涉及代码库多个区域、或需要先理解现有模式时，用多个。
   - 重质不重量——最多 ${planResearchAgentCount} 个，但应尽量用最少的必要数量（通常 1 个就够）
   - 使用多个子代理时：给每个子代理明确的搜索重点或探索区域。例如：一个找现有实现，另一个调查测试模式

### 阶段 2：设计
目标：设计实现方案。

**准则：**
- 使用阶段 1 收集的上下文，包括相关文件与代码路径。
- 考虑用户的需求与约束。
- 产出具体、足以直接执行的实现计划。
- 按任务类型考虑相应视角：
  - 新功能：简单性 vs 性能 vs 可维护性
  - Bug 修复：根因 vs 绕过 vs 预防
  - 重构：最小改动 vs 干净架构

### 阶段 3：评审
目标：评审阶段 2 的计划，确保与用户意图一致。
1. 阅读关键文件加深理解
2. 确认计划符合用户的原始请求
3. 用 ${ASK_USER_QUESTION_TOOL_NAME} 与用户澄清遗留问题

### 阶段 4：调用 ${EXIT_PLAN_MODE_TOOL_NAME}
在回合的最后——问完用户的问题、对最终计划满意之后——必须调用 ${EXIT_PLAN_MODE_TOOL_NAME} 告知用户你已完成规划。
关键：回合只能以使用 ${ASK_USER_QUESTION_TOOL_NAME} 工具或调用 ${EXIT_PLAN_MODE_TOOL_NAME} 结束。除非因为这两个原因，不要停下来。

**重要：** ${ASK_USER_QUESTION_TOOL_NAME} 只用于澄清需求或在方案之间做选择；${EXIT_PLAN_MODE_TOOL_NAME} 用于请求计划批准。绝不要用文本提问、也绝不要用 AskUserQuestion 询问计划是否批准。“这样 plan 可以吗？”“要不要继续？”“看起来如何？”“开始前还有什么要改的吗？”之类的话必须换成 ${EXIT_PLAN_MODE_TOOL_NAME}。

注意：整个流程中的任何时点都可以用 ${ASK_USER_QUESTION_TOOL_NAME} 向用户提问或澄清。不要对用户意图做大假设。目标是提交一份调研充分的计划，并在动手实现前收口所有悬而未决的问题。`;
}

const PLAN_MODE_FULL_REMINDER = [
  "计划模式已激活。用户表示暂不执行——你必须不做任何编辑、不运行任何非只读工具（包括修改配置或提交），也不以其他方式改动系统。本指令优先于你收到的其他一切指令。",
  buildPlanWorkflow(),
];

const PLAN_MODE_SPARSE_REMINDER = [
  `计划模式仍然生效（完整说明见会话前文）。只读。遵循四阶段工作流。回合以 ${ASK_USER_QUESTION_TOOL_NAME}（澄清）或 ${EXIT_PLAN_MODE_TOOL_NAME}（请求计划批准）结束。绝不通过文本或 AskUserQuestion 询问计划是否批准。`,
];

const PLAN_MODE_EXIT_REMINDER = [
  "## 已退出计划模式",
  "",
  "你已退出计划模式。现在可以进行编辑、运行工具和执行操作。",
];

export const TODO_REMINDER_CONFIG = Object.freeze({
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
});

export interface TodoReminderTurnCounts {
  turnsSinceLastTodoWrite: number;
  turnsSinceLastReminder: number;
}

// 上游调用方只传当前日期；previousDate 保留可选以兼容 fork 既有双参调用。
export function buildDateChangeReminderBody(_previousDate?: string, currentDate?: string): string {
  const date = currentDate ?? _previousDate ?? "";
  return `日期已变化。今天是 ${date}。不要向用户明确提及这一点，他们已经知道。`;
}

export function runtimeMetadataForSyntheticUserMessageSource(
  source: SyntheticUserMessageSource,
): RuntimeMessageMetadata {
  if (
    source === "background_task" ||
    source === "subagent_message" ||
    source === "shared_context"
  ) {
    return legacySyntheticRuntimeMetadata();
  }
  if (source === "subagent") {
    return systemReminderRuntimeMetadata("queued_system_notification");
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (source === "goal_state_change") {
    return systemReminderRuntimeMetadata("goal_state_change");
  }
  if (source === "agent_listing_delta") {
    return systemReminderRuntimeMetadata(source);
  }
  if (source === "plugin_reference") {
    return systemReminderRuntimeMetadata("plugin_reference");
  }
  if (source === "selection_side_chat") {
    return systemReminderRuntimeMetadata("selection_side_chat");
  }
  if (source === "bot_topic_context") return systemReminderRuntimeMetadata("bot_topic_context");
  if (source === "goal-continuation") {
    return systemReminderRuntimeMetadata("target_continuation");
  }
  return systemReminderRuntimeMetadata("rewind_notice");
}

export function getTodoReminderTurnCounts(
  entries: readonly RuntimeMessageEntry[],
): TodoReminderTurnCounts {
  let assistantTurnsAfterCurrentEntry = 0;
  let turnsSinceLastTodoWrite: number | undefined;
  let turnsSinceLastReminder: number | undefined;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (turnsSinceLastReminder === undefined && entry.metadata?.source === "todo_reminder") {
      turnsSinceLastReminder = assistantTurnsAfterCurrentEntry;
    }
    if (turnsSinceLastTodoWrite !== undefined && turnsSinceLastReminder !== undefined) {
      break;
    }

    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role !== "assistant") continue;

    if (
      turnsSinceLastTodoWrite === undefined &&
      entry.message.toolCalls?.some((toolCall) => toolCall.name === "TodoWrite")
    ) {
      turnsSinceLastTodoWrite = assistantTurnsAfterCurrentEntry;
    }
    assistantTurnsAfterCurrentEntry++;
    if (turnsSinceLastTodoWrite !== undefined && turnsSinceLastReminder !== undefined) {
      break;
    }
  }

  return {
    turnsSinceLastReminder: turnsSinceLastReminder ?? assistantTurnsAfterCurrentEntry,
    turnsSinceLastTodoWrite: turnsSinceLastTodoWrite ?? assistantTurnsAfterCurrentEntry,
  };
}

export function shouldBuildTodoReminder(entries: readonly RuntimeMessageEntry[]): boolean {
  const counts = getTodoReminderTurnCounts(entries);
  return (
    counts.turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    counts.turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  );
}

export function buildTodoReminderBody(todos: readonly TodoItem[]): string {
  const lines = [
    "最近没有使用 TodoWrite 工具。如果你正在处理适合跟踪进度的任务，可以考虑用 TodoWrite 记录；如果现有清单已过时、与你当前的工作不符，也可以顺手清理。仅在与当前工作相关时使用，无关请忽略——这只是温和提醒。",
  ];
  if (todos.length > 0) {
    const currentTodos = `[${formatTodoListForReminder(todos).join("\n")}]`;
    lines.push("", "以下是你当前 todo 清单的内容：", "", currentTodos);
  }
  return lines.join("\n");
}

export function buildRuntimeModeReminderBody(
  entries: readonly RuntimeMessageEntry[],
  mode: CollaborationMode,
  planEnabled = mode === "plan",
): string | null {
  if (!planEnabled) return null;

  const { foundRuntimeModeReminder, humanTurnsSinceReminder } =
    getRuntimeModeReminderTurnCount(entries);
  if (
    foundRuntimeModeReminder &&
    humanTurnsSinceReminder < RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS
  ) {
    return null;
  }

  const nextReminderCount = countRuntimeModeReminders(entries) + 1;
  const reminderLines =
    nextReminderCount % RUNTIME_MODE_REMINDER_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS === 1
      ? PLAN_MODE_FULL_REMINDER
      : PLAN_MODE_SPARSE_REMINDER;
  return reminderLines.join("\n");
}

export function buildPlanModeExitReminderBody(): string {
  return PLAN_MODE_EXIT_REMINDER.join("\n");
}

export function buildRuntimeOutputStyleReminderBody(
  outputStyle: OutputStylePromptConfig | undefined,
): string | null {
  const activePrompt = outputStyle?.prompt.trim();
  if (!outputStyle || !activePrompt) {
    return null;
  }

  return `${outputStyle.name} 输出风格已生效。请继续遵循该风格的具体指引。`;
}

function formatTodoListForReminder(todos: readonly TodoItem[]): string[] {
  return todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`);
}

function getRuntimeModeReminderTurnCount(entries: readonly RuntimeMessageEntry[]): {
  foundRuntimeModeReminder: boolean;
  humanTurnsSinceReminder: number;
} {
  let humanTurnsSinceReminder = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.metadata?.source === "runtime_mode") {
      return { foundRuntimeModeReminder: true, humanTurnsSinceReminder };
    }
    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role === "user" && entry.metadata?.source === "real_user") {
      humanTurnsSinceReminder++;
    }
  }
  return { foundRuntimeModeReminder: false, humanTurnsSinceReminder };
}

function countRuntimeModeReminders(entries: readonly RuntimeMessageEntry[]): number {
  return entries.reduce(
    (count, entry) => count + (entry.metadata?.source === "runtime_mode" ? 1 : 0),
    0,
  );
}

// ---- 静默回合提醒（机制与上游一致；文案走 fork 中文体系） ----

const SILENT_TURN_REMINDER_CONFIG = Object.freeze({
  TURNS_BETWEEN_REMINDERS: 5,
  MAX_REMINDERS_PER_STRETCH: 3,
});
const SILENT_TURN_REMINDER_BODY = "用户已经有一段时间没有收到你的消息了。继续任务时，有值得告知的进展（发现、计划变更）请主动同步。";
// 只有空白或这些占位文字的 assistant 文本不算与用户沟通。
const SILENT_TURN_PLACEHOLDER_TEXTS: ReadonlySet<string> = new Set([
  "(no content)",
  "No response requested.",
]);

function isVisibleAssistantText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !SILENT_TURN_PLACEHOLDER_TEXTS.has(trimmed);
}

export function buildSilentTurnReminderBody(
  entries: readonly RuntimeMessageEntry[],
): string | null {
  let silentTurns = 0;
  let reminders = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.metadata?.source === "silent_turn_reminder") {
      reminders++;
      if (reminders >= SILENT_TURN_REMINDER_CONFIG.MAX_REMINDERS_PER_STRETCH) return null;
      continue;
    }
    if (isRuntimeAttachmentEntry(entry)) continue;
    const { message } = entry;
    // 新的用户轮次结束静默段：新轮通知、中断标记与 compact summary 也算。
    // 中途输入（user_steer 等，含旧版本存下的立即发送）不算，不结束静默段。
    if (isUserTurnInput(entry)) break;
    if (message.role !== "assistant") continue;
    const communicated =
      typeof message.content === "string"
        ? isVisibleAssistantText(message.content)
        : message.content.some(
            (block) => block.type === "text" && isVisibleAssistantText(block.text),
          );
    if (
      communicated ||
      message.toolCalls?.some(
        (call) =>
          call.name === ASK_USER_QUESTION_TOOL_NAME || call.name === EXIT_PLAN_MODE_TOOL_NAME,
      )
    )
      break;
    // 每个已提交 assistant entry 是一次模型响应；工具数量和工具结果都不增加轮次。
    // 只累计最新提醒之后的响应，历史提醒仍用于限制同一段静默中的重复次数。
    if (reminders === 0) silentTurns++;
  }
  return silentTurns >= SILENT_TURN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
    ? SILENT_TURN_REMINDER_BODY
    : null;
}

// ---- 输出风格提醒（fork 保留 output_style section；提醒正文与上游一致） ----

export const OUTPUT_STYLE_RESET_REMINDER =
  "The output style was reset to the default. Respond in your usual style.";

/** output style 指令正文；prompt 为空白时视为未设置。 */
export function buildOutputStyleInstructionsBody(
  outputStyle: { name: string; prompt: string } | undefined,
): string | null {
  const activePrompt = outputStyle?.prompt.trim();
  if (!outputStyle || !activePrompt) return null;
  return `# Output Style: ${outputStyle.name}\n${activePrompt}`;
}

/** 当前计划段（最近一次退出之后）里是否已有完整的 plan 提醒。 */
export function hasFullRuntimeModeReminder(entries: readonly RuntimeMessageEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.metadata?.source === "plan_mode_exit") return false;
    if (
      isRuntimeAttachmentEntry(entry) &&
      entry.metadata.source === "runtime_mode" &&
      entry.content.startsWith(PLAN_MODE_FULL_REMINDER[0]!)
    ) {
      return true;
    }
  }
  return false;
}
