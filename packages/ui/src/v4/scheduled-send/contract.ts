// scheduled-send 模块契约：只放类型；运行时实现经 index.ts 暴露。
//
// 调用方（composer）只需要知道 ComposerScheduledSend 的 props 与定时语义：
// 一次定时发送 = 一条一次性 automation（relativeDelayMinutes + recurring=false），
// 预设时间点只是 UI 本地偏好，不进入协议参数。
import type { IZCodeAgentService } from "@zcode/services";
import type { ModelSelection } from "@zcode/shared";

// 提交入参类型只经 contract 转出：ui 层文件不直接 import services，避免 uuid-import-implementation 拦截。
export type { ZCodeAgentCreateAutomationParams } from "@zcode/services";

/** 相对偏移：N 分钟后触发。 */
export interface OffsetScheduledSendPreset {
  id: string;
  kind: "offset";
  offsetMinutes: number;
}

/** 每日时刻：下一个 HH:mm（今天未到=今天，否则顺延明天）。 */
export interface DailyTimeScheduledSendPreset {
  id: string;
  kind: "dailyTime";
  /** "HH:mm"，24 小时制本地时刻。 */
  time: string;
}

export type ScheduledSendPreset = OffsetScheduledSendPreset | DailyTimeScheduledSendPreset;

export interface ComposerScheduledSendProps {
  /** 当前草稿纯文本；提交时读取，空则不提交。 */
  draftText: string;
  /** 是否含附件/引用等非文本上下文；有则禁用定时入口（仅支持纯文本）。 */
  hasNonTextContext: boolean;
  /** 入口是否可用（合并 canSend、runtime、pending 等门禁）。 */
  enabled: boolean;
  /** enabled=false 时的禁用原因（tooltip）。 */
  disabledReason?: string;
  agentService: IZCodeAgentService;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 当前会话 id；缺省（草稿态）不绑定 targetTaskId。 */
  sessionId: string | null;
  modelSelection?: ModelSelection;
  mode?: string;
  /** 定时成功后清空草稿（复用发送后的清理路径）。 */
  onScheduled: () => void;
}
