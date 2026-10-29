import { describe, expect, it } from "vitest";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

function providerContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && "type" in block) {
          if (block.type === "text" && "text" in block) {
            return String(block.text);
          }
          return JSON.stringify(block);
        }
        return String(block ?? "");
      })
      .join("\n");
  }
  return String(content ?? "");
}

// 系统提示词覆盖热切换（docs/specs/agent-system-prompt-chinese-and-profiles.md §1.4）：
// updateConfig({ systemPromptOverride }) 在无活跃 turn 时重建前缀，下一请求生效；
// null/undefined（回落内置）与设置值走同一条路径。
describe("runtime system prompt override", () => {
  it("applies the override to the next request prefix after updateConfig", async () => {
    const sessionId = `session_prompt_override_hot_${Math.random().toString(36).slice(2, 10)}`;
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        modelSelection: createTestModelSelection("openai/test-model"),
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              request.messages.map((message) => ({
                role: message.role,
                content: providerContentToText(message.content),
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("first");
    runtime.updateConfig({ systemPromptOverride: "你是这个工作区的领域专家助手。" });
    await runtime.executeTurn("second");

    expect(requests).toHaveLength(2);
    const firstStable = String(requests[0]?.[1]?.content ?? "");
    expect(firstStable).toMatch(/^\n?你是一个交互式 ZCode 智能体/);
    const secondStable = String(requests[1]?.[1]?.content ?? "");
    expect(secondStable).toBe("\n你是这个工作区的领域专家助手。");
    // 行为规范段被替换，环境事实段保留。
    const secondDynamic = String(requests[1]?.[2]?.content ?? "");
    expect(secondDynamic).not.toContain("# 与用户沟通");
    expect(secondDynamic).toContain("# 环境");
  });

  it("clears the override back to the built-in identity when set to undefined", async () => {
    const sessionId = `session_prompt_override_clear_${Math.random().toString(36).slice(2, 10)}`;
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        modelSelection: createTestModelSelection("openai/test-model"),
        systemPromptOverride: "自定义正文。",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              request.messages.map((message) => ({
                role: message.role,
                content: providerContentToText(message.content),
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("first");
    expect(String(requests[0]?.[1]?.content ?? "")).toBe("\n自定义正文。");

    runtime.updateConfig({ systemPromptOverride: undefined });
    await runtime.executeTurn("second");
    expect(String(requests[1]?.[1]?.content ?? "")).toMatch(/^\n?你是一个交互式 ZCode 智能体/);
  });
});
