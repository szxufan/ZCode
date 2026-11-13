import { describe, expect, it } from "vitest";
import {
  mergeConversationTurnNavigatorDirectory,
  resolveConversationTurnNavigatorActiveUnitIndex,
  type ConversationTurnNavigatorItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";

function item(overrides: Partial<ConversationTurnNavigatorItem> & { rowId: number }) {
  return {
    key: `turn-${overrides.rowId}:query:${overrides.rowId}`,
    turnId: `turn-${overrides.rowId}`,
    userPreview: `query ${overrides.rowId}`,
    assistantPreview: "answer",
    assistantPreviewKind: "text" as const,
    isRunning: false,
    ...overrides,
  } satisfies ConversationTurnNavigatorItem;
}

describe("resolveConversationTurnNavigatorActiveUnitIndex", () => {
  // 服务端目录会先给出大量尚未加载正文的旧 query（无 unitIndex），已加载 tail 项排在其后。
  const items = [
    item({ rowId: 1 }),
    item({ rowId: 2 }),
    item({ rowId: 10, unitIndex: 0 }),
    item({ rowId: 20, unitIndex: 1 }),
    item({ rowId: 30, unitIndex: 2 }),
  ];
  const virtualItems = [
    { index: 0, start: 0, size: 100 },
    { index: 1, start: 100, size: 100 },
    { index: 2, start: 200, size: 100 },
  ];

  it("locates the first mounted turn after unloaded directory items", () => {
    expect(
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        virtualItems,
        scrollOffsetPx: 0,
        viewportHeightPx: 100,
      }),
    ).toBe(0);
  });

  it("keeps correct unit mapping while scrolling into later loaded turns", () => {
    expect(
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        virtualItems,
        scrollOffsetPx: 150,
        viewportHeightPx: 100,
      }),
    ).toBe(1);
    expect(
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        virtualItems,
        scrollOffsetPx: 250,
        viewportHeightPx: 100,
      }),
    ).toBe(2);
  });
});

describe("mergeConversationTurnNavigatorDirectory", () => {
  it("keeps local loaded items first and orders the merged directory by rowId", () => {
    const globalOptions = {
      assistantEmptyPreview: "No answer yet",
      assistantRunningPreview: "Working",
      userFallbackPreview: "Question",
    };
    const merged = mergeConversationTurnNavigatorDirectory(
      [item({ rowId: 20, unitIndex: 1 })],
      [
        {
          rowId: 10,
          turnId: "turn-10",
          userPreview: "server query",
          assistantPreview: "server answer",
          assistantPreviewKind: "text",
          isRunning: false,
        },
        {
          rowId: 20,
          turnId: "turn-20",
          userPreview: "stale server query",
          assistantPreview: "stale server answer",
          assistantPreviewKind: "empty",
          isRunning: false,
        },
        {
          rowId: 30,
          turnId: "turn-30",
          userPreview: "server query 30",
          assistantPreview: "",
          assistantPreviewKind: "empty",
          isRunning: false,
        },
      ],
      globalOptions,
    );

    expect(merged.map((entry) => entry.rowId)).toEqual([10, 20, 30]);
    // 同 rowId 本地优先：流式 running / 本地化预览比在途目录页更新。
    expect(merged[1]?.unitIndex).toBe(1);
    expect(merged[1]?.assistantPreview).toBe("answer");
    expect(merged[0]?.unitIndex).toBeUndefined();
    expect(merged[2]?.assistantPreview).toBe("No answer yet");
  });
});
