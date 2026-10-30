import { describe, expect, it } from "vitest";

import type { ComposerScheduledSendProps, ScheduledSendPreset } from "./contract.js";
import { scheduledSendModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("scheduled-send contract", () => {
  it("declares its module manifest", () => {
    expect(scheduledSendModule.id).toBe("scheduled-send");
    expect(scheduledSendModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("暴露的 props 与预设模型字段保持稳定", () => {
    // 只做编译期形状校验：字段被误删时这里的字面量会报错。
    const preset: ScheduledSendPreset = { id: "p", kind: "offset", offsetMinutes: 10 };
    const props = {
      draftText: "text",
      hasNonTextContext: false,
      enabled: true,
      agentService: {} as ComposerScheduledSendProps["agentService"],
      workspacePath: "/ws",
      sessionId: null,
      onScheduled: () => {},
    } satisfies ComposerScheduledSendProps;
    expect(preset.kind).toBe("offset");
    expect(props.sessionId).toBeNull();
  });
});
