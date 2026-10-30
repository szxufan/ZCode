import { describe, expect, it } from "vitest";
import {
  buildCustomTarget,
  defaultScheduledSendPresets,
  describeRelativeDay,
  describeRemaining,
  isValidHourMinute,
  isValidScheduledSendPreset,
  MAX_DELAY_MINUTES,
  resolvePresetTarget,
  resolveSelectionTarget,
  toDelayMinutes,
} from "@/v4/scheduled-send/index.js";

// 固定本地时钟：2026-10-30 10:00（周五）。
const NOW = new Date(2026, 9, 30, 10, 0, 0, 0).getTime();

describe("composerScheduledSendTime", () => {
  it("offset 预设按分钟顺延", () => {
    expect(
      resolvePresetTarget({ id: "p", kind: "offset", offsetMinutes: 30 }, NOW),
    ).toBe(NOW + 30 * 60_000);
  });

  it("dailyTime 预设命中今天未到的时刻", () => {
    expect(resolvePresetTarget({ id: "p", kind: "dailyTime", time: "20:00" }, NOW)).toBe(
      new Date(2026, 9, 30, 20, 0, 0, 0).getTime(),
    );
  });

  it("dailyTime 预设对已过的时刻顺延到明天", () => {
    expect(resolvePresetTarget({ id: "p", kind: "dailyTime", time: "09:00" }, NOW)).toBe(
      new Date(2026, 9, 31, 9, 0, 0, 0).getTime(),
    );
  });

  it("toDelayMinutes 只接受未来一年内的时刻", () => {
    expect(toDelayMinutes(NOW + 60 * 60_000, NOW)).toBe(60);
    expect(toDelayMinutes(NOW - 60_000, NOW)).toBeNull();
    expect(toDelayMinutes(NOW + (MAX_DELAY_MINUTES + 1) * 60_000, NOW)).toBeNull();
  });

  it("toDelayMinutes 对分钟取整，不足半分钟归零被拒绝", () => {
    expect(toDelayMinutes(NOW + 90_000, NOW)).toBe(2);
    expect(toDelayMinutes(NOW + 40_000, NOW)).toBe(1);
    // 四舍五入到 0 分钟等于“立刻”，低于最小延迟必须拒绝而不是当成立即发送。
    expect(toDelayMinutes(NOW + 20_000, NOW)).toBeNull();
  });

  it("buildCustomTarget 组合本地日期与时刻", () => {
    expect(buildCustomTarget("2026-10-31", "09:30")).toBe(
      new Date(2026, 9, 31, 9, 30, 0, 0).getTime(),
    );
  });

  it("buildCustomTarget 拒绝非法日期与溢出日期", () => {
    expect(buildCustomTarget("2026-13-01", "09:30")).toBeNull();
    expect(buildCustomTarget("2026-02-30", "09:30")).toBeNull();
    expect(buildCustomTarget("2026-10-31", "25:00")).toBeNull();
    expect(buildCustomTarget("10/31/2026", "09:30")).toBeNull();
  });

  it("describeRelativeDay 按自然日区分今天/明天/后天/其它", () => {
    expect(describeRelativeDay(new Date(2026, 9, 30, 23, 0).getTime(), NOW)).toBe("today");
    expect(describeRelativeDay(new Date(2026, 9, 31, 9, 0).getTime(), NOW)).toBe("tomorrow");
    expect(describeRelativeDay(new Date(2026, 10, 1, 9, 0).getTime(), NOW)).toBe(
      "dayAfterTomorrow",
    );
    expect(describeRelativeDay(new Date(2026, 10, 5, 9, 0).getTime(), NOW)).toBe("other");
  });

  it("describeRemaining 按距离选择分钟/小时/天", () => {
    expect(describeRemaining(9 * 60_000)).toEqual({ value: 9, unit: "minute" });
    expect(describeRemaining(3 * 60 * 60_000)).toEqual({ value: 3, unit: "hour" });
    expect(describeRemaining(3 * 24 * 60 * 60_000)).toEqual({ value: 3, unit: "day" });
    // 不足一分钟按 1 分钟展示，避免出现“in 0 minutes”。
    expect(describeRemaining(5_000)).toEqual({ value: 1, unit: "minute" });
  });

  it("校验 HH:mm 与预设模型", () => {
    expect(isValidHourMinute("00:00")).toBe(true);
    expect(isValidHourMinute("23:59")).toBe(true);
    expect(isValidHourMinute("24:00")).toBe(false);
    expect(isValidHourMinute("9:5")).toBe(false);
    expect(isValidScheduledSendPreset({ id: "p", kind: "offset", offsetMinutes: 0 })).toBe(false);
    expect(isValidScheduledSendPreset({ id: "p", kind: "dailyTime", time: "12:00" })).toBe(true);
  });

  it("resolveSelectionTarget 预设优先且按传入 now 现算", () => {
    const presets = defaultScheduledSendPresets();
    const selection = {
      selectedPresetId: "default-daily-2000",
      presets,
      customDate: "2026-10-31",
      customTime: "09:30",
    };
    expect(resolveSelectionTarget(selection, NOW)).toBe(
      new Date(2026, 9, 30, 20, 0, 0, 0).getTime(),
    );
    // 确认时重算的依据：同一选择在跨过今天 20:00 后必须顺延到明天，而不是复用渲染期缓存。
    expect(resolveSelectionTarget(selection, new Date(2026, 9, 30, 20, 30).getTime())).toBe(
      new Date(2026, 9, 31, 20, 0, 0, 0).getTime(),
    );
  });

  it("resolveSelectionTarget 未选预设时用自定义时间，无有效选择返回 null", () => {
    const presets = defaultScheduledSendPresets();
    expect(
      resolveSelectionTarget(
        { selectedPresetId: null, presets, customDate: "2026-10-31", customTime: "09:30" },
        NOW,
      ),
    ).toBe(new Date(2026, 9, 31, 9, 30, 0, 0).getTime());
    expect(
      resolveSelectionTarget(
        { selectedPresetId: null, presets, customDate: "2026-10-31", customTime: "" },
        NOW,
      ),
    ).toBeNull();
    // 选中的预设被删除后（id 找不到）且无自定义时间，不产生目标时刻。
    expect(
      resolveSelectionTarget(
        { selectedPresetId: "missing", presets, customDate: "2026-10-31", customTime: "" },
        NOW,
      ),
    ).toBeNull();
  });

  it("默认预设包含偏移与每日时刻且可安全变更", () => {
    const presets = defaultScheduledSendPresets();
    expect(presets.map((preset) => preset.kind)).toEqual([
      "offset",
      "offset",
      "offset",
      "dailyTime",
      "dailyTime",
    ]);
    presets.pop();
    expect(defaultScheduledSendPresets()).toHaveLength(5);
  });
});
