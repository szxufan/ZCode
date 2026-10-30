import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { setDataBaseDir } from "../src/paths.js";

// composer 定时发送走 agent 侧 createAutomation：relativeDelayMinutes 二选一替代 cronExpr，
// 必须落成一次性（recurring=false）并保留会话绑定 targetTaskId。这里只验证入参透传与拒绝路径，
// 到点派发由 scheduler/host 的既有用例覆盖。

const createdDirs: string[] = [];

afterEach(() => {
  setDataBaseDir(null);
  for (const dir of createdDirs.splice(0).reverse()) {
    try {
      // Windows 上 sqlite 句柄可能延迟释放，删除失败不影响断言结果。
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function prepareSandbox(prefix: string): string {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(sandbox);
  setDataBaseDir(sandbox);
  return sandbox;
}

describe("zcodeAgentService createAutomation 定时发送", () => {
  it("relativeDelayMinutes + targetTaskId 落成一次性会话绑定任务", async () => {
    prepareSandbox("zcode-agent-scheduled-send-");
    const service = createZCodeAgentService();
    const before = Date.now();
    const automation = await service.createAutomation({
      workspacePath: "/workspace/scheduled-send",
      title: "定时发送",
      prompt: "提醒我提交周报",
      relativeDelayMinutes: 90,
      recurring: false,
      targetTaskId: "session-1",
      modelSelection: { providerId: "glm", modelId: "glm-4.6" },
      mode: "build",
    });

    expect(automation.recurring).toBe(false);
    expect(automation.targetTaskId).toBe("session-1");
    expect(automation.modelSelection).toEqual({ providerId: "glm", modelId: "glm-4.6" });
    expect(automation.prompt).toBe("提醒我提交周报");
    expect(automation.scheduleRule?.unit).toBe("minute");
    expect(automation.nextRunAt).toBeGreaterThanOrEqual(before + 90 * 60_000);
    expect(automation.nextRunAt).toBeLessThanOrEqual(Date.now() + 90 * 60_000 + 5_000);
  });

  it("草稿态任务不绑定会话", async () => {
    prepareSandbox("zcode-agent-scheduled-send-draft-");
    const service = createZCodeAgentService();
    const automation = await service.createAutomation({
      workspacePath: "/workspace/scheduled-send",
      title: "定时发送",
      prompt: "整理今天的待办",
      relativeDelayMinutes: 30,
      recurring: false,
    });
    expect(automation.recurring).toBe(false);
    expect(automation.targetTaskId).toBeUndefined();
  });

  it("cronExpr 与 relativeDelayMinutes 都缺省时拒绝创建", async () => {
    prepareSandbox("zcode-agent-scheduled-send-invalid-");
    const service = createZCodeAgentService();
    await expect(
      service.createAutomation({
        workspacePath: "/workspace/scheduled-send",
        title: "缺少调度",
        prompt: "没有任何时间信息",
      }),
    ).rejects.toThrow("automation create requires cronExpr or relativeDelayMinutes");
  });
});
