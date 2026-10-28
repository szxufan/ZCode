import { describe, expect, it } from "vitest";
import {
  describeOffPeakCardStatus,
  readOffPeakCreateTaskOutputSummary,
} from "@/ToolCallBlocks/renderers/offpeak-create.js";

const intl = {
  formatMessage: (
    { id }: { id: string },
    values?: Record<string, string | number>,
  ) => (id === "offPeak.chatCreated.queuedAt" ? `排队第 ${values?.["position"]} 位` : id),
};

describe("OffPeakCreateTaskCard output（D49-6 静态轮尾卡，历史 transcript 渲染）", () => {
  it("从工具输出解析最小任务快照（含 JSON 字符串候选）", () => {
    const task = readOffPeakCreateTaskOutputSummary(
      JSON.stringify({
        task: {
          offPeakTaskId: "offpeak-abc",
          title: "重构 utils",
          status: "queued",
          queuePosition: 3,
          createdAt: 1_700_000_000_000,
        },
        message: "Created idle-time task offpeak-abc (#3 in queue).",
      }),
    );

    expect(task).toMatchObject({
      offPeakTaskId: "offpeak-abc",
      title: "重构 utils",
      status: "queued",
      queuePosition: 3,
    });
  });

  it("缺 offPeakTaskId 视为无效输出（卡片必须能定位任务）", () => {
    expect(
      readOffPeakCreateTaskOutputSummary({ task: { title: "无 id", status: "queued" } }),
    ).toBeNull();
  });

  it("状态行：有位次显示创建时快照，无位次回退排队文案", () => {
    expect(
      describeOffPeakCardStatus({ offPeakTaskId: "offpeak-1", queuePosition: 3 }, intl),
    ).toBe("排队第 3 位");
    expect(describeOffPeakCardStatus({ offPeakTaskId: "offpeak-1" }, intl)).toBe(
      "offPeak.chatCreated.queued",
    );
  });
});
