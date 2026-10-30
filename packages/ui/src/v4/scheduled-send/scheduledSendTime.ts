// scheduled-send 的时间计算：目标时刻解析、延迟分钟换算。
//
// 唯一职责是纯时间数学，不碰 UI、不读 localStorage、不依赖 i18n；文案与格式化留给组件。
// 预设模型类型归 contract.ts；store 与组件都依赖本模块。
import type { ScheduledSendPreset } from "./contract.js";

/** 一次性 automation 的分钟延迟边界（与后端 relativeDelayMinutes 契约一致）。 */
export const MIN_DELAY_MINUTES = 1;
export const MAX_DELAY_MINUTES = 525_600; // ≈ 1 年
/** 用户可维护的预设上限。 */
export const MAX_SCHEDULED_SEND_PRESETS = 10;

const HH_MM_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** 默认预设：10/30/60 分钟后 + 今晚 20:00 + 明早 09:00。返回新数组，调用方可安全变更。 */
export function defaultScheduledSendPresets(): ScheduledSendPreset[] {
  return [
    { id: "default-offset-10", kind: "offset", offsetMinutes: 10 },
    { id: "default-offset-30", kind: "offset", offsetMinutes: 30 },
    { id: "default-offset-60", kind: "offset", offsetMinutes: 60 },
    { id: "default-daily-2000", kind: "dailyTime", time: "20:00" },
    { id: "default-daily-0900", kind: "dailyTime", time: "09:00" },
  ];
}

/** 校验 "HH:mm" 是否为合法 24 小时制时刻。 */
export function isValidHourMinute(value: string): boolean {
  const match = HH_MM_PATTERN.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/** 校验一条预设是否合法（新增/编辑时用于门禁，不含 id）。 */
export function isValidScheduledSendPreset(preset: ScheduledSendPreset): boolean {
  if (preset.kind === "offset") {
    return Number.isInteger(preset.offsetMinutes) && preset.offsetMinutes >= MIN_DELAY_MINUTES;
  }
  return isValidHourMinute(preset.time);
}

function parseHourMinute(value: string): { hour: number; minute: number } | null {
  const match = HH_MM_PATTERN.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * 解析预设对应的绝对目标时刻（毫秒）。
 * - offset：now + N 分钟；
 * - dailyTime：下一个 HH:mm 本地时刻，若今天的该时刻已过则顺延到明天。
 */
export function resolvePresetTarget(preset: ScheduledSendPreset, now = Date.now()): number {
  if (preset.kind === "offset") {
    return now + preset.offsetMinutes * 60_000;
  }
  const parsed = parseHourMinute(preset.time);
  if (!parsed) return now;
  const target = new Date(now);
  target.setHours(parsed.hour, parsed.minute, 0, 0);
  if (target.getTime() <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

/**
 * 目标时刻换算为一次性 automation 的 relativeDelayMinutes。
 * 落在 [MIN, MAX] 之外（过去、或超过一年）返回 null，调用方据此拒绝提交。
 */
export function toDelayMinutes(targetMs: number, now = Date.now()): number | null {
  const minutes = Math.round((targetMs - now) / 60_000);
  if (minutes < MIN_DELAY_MINUTES || minutes > MAX_DELAY_MINUTES) return null;
  return minutes;
}

/**
 * 把自定义日期 + 时间组合成目标时刻（本地时区）。
 * @param dateValue "YYYY-MM-DD"
 * @param timeValue "HH:mm"
 * 任一格式非法返回 null。
 */
export function buildCustomTarget(
  dateValue: string,
  timeValue: string,
): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const parsed = parseHourMinute(timeValue);
  if (!dateMatch || !parsed) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const target = new Date(year, month - 1, day, parsed.hour, parsed.minute, 0, 0);
  // 拒绝 2 月 30 日这类溢出被 Date 静默滚月的输入：分量必须与原始一致。
  if (
    target.getFullYear() !== year ||
    target.getMonth() !== month - 1 ||
    target.getDate() !== day
  ) {
    return null;
  }
  return target.getTime();
}

/** 目标时刻相对 now 的日标签枚举，供组件映射 i18n（今天/明天/后天/其它）。 */
export type RelativeDayKind = "today" | "tomorrow" | "dayAfterTomorrow" | "other";

/** 浮层里「预设选中项 + 自定义日期时间」的原始选择状态。 */
export interface ScheduledSendSelection {
  selectedPresetId: string | null;
  presets: ScheduledSendPreset[];
  /** "YYYY-MM-DD"，来自 date input。 */
  customDate: string;
  /** "HH:mm"，来自 time input；为空表示未选。 */
  customTime: string;
}

/**
 * 解析浮层当前选择对应的目标时刻（预设优先，否则自定义日期时间）；无有效选择返回 null。
 * 预设始终按传入 now 现算：确认提交时必须重算而不是复用渲染期缓存，
 * 否则浮层停留跨过目标时刻后会把过去时刻提交成 automation。
 */
export function resolveSelectionTarget(
  selection: ScheduledSendSelection,
  now = Date.now(),
): number | null {
  if (selection.selectedPresetId) {
    const preset = selection.presets.find(
      (item) => item.id === selection.selectedPresetId,
    );
    if (preset) return resolvePresetTarget(preset, now);
  }
  if (selection.customDate && /^\d{2}:\d{2}$/.test(selection.customTime)) {
    return buildCustomTarget(selection.customDate, selection.customTime);
  }
  return null;
}

/**
 * “约 X 后”的主单位：<60 分钟用分钟，<48 小时用小时，其余用天。
 * 只做单位选择，格式化（本地化文案）留给组件。
 */
export function describeRemaining(diffMs: number): {
  value: number;
  unit: "minute" | "hour" | "day";
} {
  const minutes = Math.max(1, Math.round(diffMs / 60_000));
  if (minutes < 60) return { value: minutes, unit: "minute" };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { value: hours, unit: "hour" };
  return { value: Math.round(hours / 24), unit: "day" };
}

/** 计算目标时刻相对 now 的自然日差（按本地日历日，非 24 小时）。 */
export function describeRelativeDay(targetMs: number, now = Date.now()): RelativeDayKind {
  const startOfDay = (ms: number): number => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const dayDiff = Math.round((startOfDay(targetMs) - startOfDay(now)) / 86_400_000);
  if (dayDiff <= 0) return "today";
  if (dayDiff === 1) return "tomorrow";
  if (dayDiff === 2) return "dayAfterTomorrow";
  return "other";
}
