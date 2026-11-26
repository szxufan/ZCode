import { describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "@zcode/shared";
import { settlePlanApproval } from "@/v4/V4InteractionDialogs.js";

// 计划审批的应答流程（docs/specs/plan-approval-execution-model.md）：应答带了执行模型时，先经既有会话
// 模型切换提交，被接受后才提交批准。E2E 只配了一个模型，无法在端到端层面证明这条顺序，由这里保证。

const SELECTION: ModelSelection = {
  providerId: "provider-b",
  modelId: "model-b",
  options: { reasoningLevel: "high" },
};

describe("settlePlanApproval", () => {
  it("带了执行模型时先切换、被接受后再提交批准", async () => {
    const order: string[] = [];
    const switchModel = vi.fn(async () => {
      order.push("switch");
      return true;
    });
    const resolveInteraction = vi.fn(async () => {
      order.push("resolve");
      return { accepted: true };
    });

    await expect(
      settlePlanApproval({ selection: SELECTION, switchModel, resolveInteraction }),
    ).resolves.toBe(true);

    expect(order).toEqual(["switch", "resolve"]);
    expect(switchModel).toHaveBeenCalledWith(SELECTION);
  });

  it("切换没被接受时不提交批准", async () => {
    const resolveInteraction = vi.fn(async () => ({ accepted: true }));

    await expect(
      settlePlanApproval({
        selection: SELECTION,
        switchModel: async () => false,
        resolveInteraction,
      }),
    ).resolves.toBe(false);

    expect(resolveInteraction).not.toHaveBeenCalled();
  });

  it("没有执行模型时直接提交批准，不触碰会话模型", async () => {
    const switchModel = vi.fn(async () => true);
    const resolveInteraction = vi.fn(async () => ({ accepted: true }));

    await expect(
      settlePlanApproval({ selection: undefined, switchModel, resolveInteraction }),
    ).resolves.toBe(true);

    expect(switchModel).not.toHaveBeenCalled();
    expect(resolveInteraction).toHaveBeenCalledOnce();
  });

  it("批准回执未被接受时返回 false", async () => {
    await expect(
      settlePlanApproval({
        selection: SELECTION,
        switchModel: async () => true,
        resolveInteraction: async () => ({ accepted: false }),
      }),
    ).resolves.toBe(false);
  });
});
