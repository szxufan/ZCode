// scheduled-send 模块公开入口（spec: docs/specs/composer-scheduled-send.md）。
//
// composer 只从这里拿 ComposerScheduledSend 与 props 类型；时间换算、提交入参构造与
// 预设 store 一并暴露给同包调用方和单测，避免测试深导入模块内部文件。
export type * from "@/v4/scheduled-send/contract.js";
export { ComposerScheduledSend } from "@/v4/scheduled-send/ComposerScheduledSend.js";
export {
  buildScheduledSendAutomationParams,
  deriveScheduledSendTitle,
} from "@/v4/scheduled-send/scheduledSendSubmit.js";
export type {
  BuildScheduledSendParamsInput,
  ScheduledSendSubmitOutcome,
} from "@/v4/scheduled-send/scheduledSendSubmit.js";
export {
  buildCustomTarget,
  defaultScheduledSendPresets,
  describeRelativeDay,
  describeRemaining,
  isValidHourMinute,
  isValidScheduledSendPreset,
  MAX_DELAY_MINUTES,
  MAX_SCHEDULED_SEND_PRESETS,
  MIN_DELAY_MINUTES,
  resolvePresetTarget,
  resolveSelectionTarget,
  toDelayMinutes,
} from "@/v4/scheduled-send/scheduledSendTime.js";
export type {
  RelativeDayKind,
  ScheduledSendSelection,
} from "@/v4/scheduled-send/scheduledSendTime.js";
export { useScheduledSendPresetStore } from "@/store/scheduledSendPresetStore.js";
export type {
  ScheduledSendPresetInput,
  ScheduledSendPresetState,
} from "@/store/scheduledSendPresetStore.js";
