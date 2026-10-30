// composer 定时发送的「预设时间点」用户偏好。
//
// 唯一所有者：UI 本地偏好，localStorage 持久化，键空间独立（zcode-scheduled-send-presets:v1）。
// 不写入 tasks-index、不进协议参数；到点事实仍归 AutomationRepo。label 由 i18n 依据预设模型
// 在组件侧生成，这里只存结构化模型，不存任何文案字符串。
import { create } from "zustand";
import { logger } from "@/logger.js";
import type {
  DailyTimeScheduledSendPreset,
  OffsetScheduledSendPreset,
  ScheduledSendPreset,
} from "@/v4/scheduled-send/contract.js";
import {
  defaultScheduledSendPresets,
  isValidScheduledSendPreset,
  MAX_SCHEDULED_SEND_PRESETS,
} from "@/v4/scheduled-send/scheduledSendTime.js";

const STORAGE_KEY = "zcode-scheduled-send-presets:v1";

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 只接受结构合法的预设；脏数据（旧版本/手改）整条丢弃，避免下游换算崩溃。 */
function parseStoredPresets(raw: string | null): ScheduledSendPreset[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter((item): item is ScheduledSendPreset => {
      if (typeof item !== "object" || item === null) return false;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.id !== "string") return false;
      if (candidate.kind === "offset") {
        return isValidScheduledSendPreset({
          id: candidate.id,
          kind: "offset",
          offsetMinutes: candidate.offsetMinutes as number,
        });
      }
      if (candidate.kind === "dailyTime") {
        return isValidScheduledSendPreset({
          id: candidate.id,
          kind: "dailyTime",
          time: candidate.time as string,
        });
      }
      return false;
    });
    return valid.slice(0, MAX_SCHEDULED_SEND_PRESETS);
  } catch (error) {
    logger.warn("[scheduled-send] 预设解析失败，回退默认", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function loadInitialPresets(): ScheduledSendPreset[] {
  const storage = getStorage();
  if (!storage) return defaultScheduledSendPresets();
  const stored = parseStoredPresets(readRaw(storage));
  return stored && stored.length > 0 ? stored : defaultScheduledSendPresets();
}

function readRaw(storage: Storage): string | null {
  try {
    return storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function persist(presets: ScheduledSendPreset[]): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch (error) {
    // 配额/隐私模式写入失败不影响本次会话内存态，下次读取回退默认。
    logger.warn("[scheduled-send] 预设持久化失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function makePresetId(): string {
  const cryptoRef = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoRef && "randomUUID" in cryptoRef) return cryptoRef.randomUUID();
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 新增预设的入参（id 可缺省，由 store 生成）：按 kind 分支而非 Omit 联合，避免字面量属性校验丢失。 */
export type ScheduledSendPresetInput = (
  | Omit<OffsetScheduledSendPreset, "id">
  | Omit<DailyTimeScheduledSendPreset, "id">
) & { id?: string };

export interface ScheduledSendPresetState {
  presets: ScheduledSendPreset[];
  /** 新增预设；超过上限或非法返回 false，不落盘。 */
  addPreset: (preset: ScheduledSendPresetInput) => boolean;
  removePreset: (id: string) => void;
  resetDefaults: () => void;
}

export const useScheduledSendPresetStore = create<ScheduledSendPresetState>((set, get) => ({
  presets: loadInitialPresets(),
  addPreset: (input) => {
    const current = get().presets;
    if (current.length >= MAX_SCHEDULED_SEND_PRESETS) return false;
    const preset: ScheduledSendPreset = {
      ...input,
      id: input.id ?? makePresetId(),
    } as ScheduledSendPreset;
    if (!isValidScheduledSendPreset(preset)) return false;
    const next = [...current, preset];
    set({ presets: next });
    persist(next);
    return true;
  },
  removePreset: (id) => {
    const current = get().presets;
    const next = current.filter((preset) => preset.id !== id);
    if (next.length === current.length) return;
    set({ presets: next });
    persist(next);
  },
  resetDefaults: () => {
    const next = defaultScheduledSendPresets();
    set({ presets: next });
    persist(next);
  },
}));
