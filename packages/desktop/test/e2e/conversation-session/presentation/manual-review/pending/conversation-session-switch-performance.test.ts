import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { DEFAULT_WORKSPACE, setCurrentElectronRendererContentSize } from "#e2e/helpers/desktop-app";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  clickV4TurnNavigatorItemByIndex,
  getV4TimelineScrollState,
  getV4TurnNavigatorState,
  prepareV4ConversationE2E,
  scrollV4TurnNavigatorToTop,
  selectV4TaskById,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE = "conversation-session-switch-performance";
const TURNS = Number(process.env.ZCODE_E2E_SESSION_SWITCH_TURNS ?? 1000);

type ArmsRecord = {
  name: string;
  properties?: Record<string, unknown>;
  recordedAt?: number;
};

type SwitchProbe = {
  startedAt: number;
  longTasks: { at: number; duration: number }[];
  stop(): void;
};

type SwitchProbeSnapshot = {
  startedAt: number;
  endedAt: number;
  longTasks: { at: number; duration: number }[];
};

declare global {
  interface Window {
    __sessionSwitchProbe?: SwitchProbe;
  }
}

async function createLongHistory() {
  const id = -948002;
  const writer = new BufferWriter();
  serialize(writer, [100, id, ServiceChannels.ZCodeAgent, "createSession"]);
  serialize(writer, [
    {
      workspacePath: DEFAULT_WORKSPACE,
      persistence: "immediate",
      titleGenerationEnabled: false,
      importedHistory: {
        source: "claudeCode",
        title: "E2E_SESSION_SWITCH_PERF",
        messages: Array.from({ length: TURNS }, (_, index) => [
          { role: "user", content: `历史提问 ${index}` },
          { role: "assistant", content: `历史回答 ${index}` },
        ]).flat(),
      },
    },
  ]);
  const prefixes = [201, 202, 203].map((kind) => {
    const prefix = new BufferWriter();
    serialize(prefix, [kind, id]);
    return Array.from(prefix.buffer.buffer);
  });
  const response = await browser.execute(
    (payload, headers) => {
      const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
      return window.__remoteProjectHandoffRpc!.call(Array.from(bytes), headers);
    },
    Buffer.from(writer.buffer.buffer).toString("base64"),
    prefixes,
  );
  const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(response)));
  const header = deserialize(reader) as [number, number];
  const body = deserialize(reader);
  if (header[0] !== 201) throw new Error(JSON.stringify(body));
  return body as { session: { sessionId: string } };
}

async function clearArmsEvents() {
  await browser.execute(() => {
    (window as Window & { __zcodeArmsCustomEventsE2E?: ArmsRecord[] }).__zcodeArmsCustomEventsE2E =
      [];
  });
}

async function readArmsEvents(sessionId: string): Promise<ArmsRecord[]> {
  return browser.execute((targetSessionId) => {
    const events =
      (window as Window & { __zcodeArmsCustomEventsE2E?: ArmsRecord[] })
        .__zcodeArmsCustomEventsE2E ?? [];
    return events.filter((event) => event.properties?.session_id === targetSessionId);
  }, sessionId);
}

async function startSwitchProbe() {
  await browser.execute(() => {
    const startedAt = performance.now();
    const probe: SwitchProbe = { startedAt, longTasks: [], stop() {} };
    const observer = new PerformanceObserver((list) =>
      probe.longTasks.push(
        ...list.getEntries().map((entry) => ({ at: entry.startTime, duration: entry.duration })),
      ),
    );
    observer.observe({ type: "longtask" });
    probe.stop = () => observer.disconnect();
    window.__sessionSwitchProbe = probe;
  });
}

async function stopSwitchProbe(): Promise<SwitchProbeSnapshot> {
  return browser.execute(() => {
    const probe = window.__sessionSwitchProbe!;
    probe.stop();
    return { startedAt: probe.startedAt, endedAt: performance.now(), longTasks: probe.longTasks };
  });
}

describe("PERF05 long session switch and directory hydration", () => {
  let replay: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>>;
  before(async function () {
    this.timeout(240000);
    replay = await startConversationModelProviderReplayServer(CASE);
    await prepareV4ConversationE2E();
    await setCurrentElectronRendererContentSize(1280, 900);
    await installHandoffRpcProbe();
  });
  after(async () => {
    await restoreHandoffProbes();
    await replay?.stop();
  });

  it("keeps the wire tail bounded while hydrating a full lightweight directory", async function () {
    this.timeout(300000);
    const created = await createLongHistory();
    await callHandoffHost(ServiceChannels.ZCodeTask, "resumeTask", [
      { taskId: created.session.sessionId, workspacePath: DEFAULT_WORKSPACE },
    ]);
    await clearArmsEvents();
    await startSwitchProbe();
    let probeData: Awaited<ReturnType<typeof stopSwitchProbe>> | null = null;
    try {
      await selectV4TaskById(created.session.sessionId);
      await waitForV4Pane((pane) => !pane.canStop, "导入会话没有完成冷恢复", 120000);

      const resultEvent = await browser.waitUntil(
        async () => {
          const events = await readArmsEvents(created.session.sessionId);
          return events.find(
            (event) =>
              event.name === "perf_ui_session_open_result" &&
              event.properties?.status === "success",
          );
        },
        {
          timeout: 120000,
          timeoutMsg: "会话切换没有收到成功的 session-open result",
        },
      );
      const result = resultEvent.properties ?? {};
      expect(result.open_kind).toBe("cold");
      expect(result.history_ready_ms).toBeDefined();
      expect(Number(result.persisted_message_count ?? 0)).toBeGreaterThan(0);
      expect(Number(result.snapshot_row_count ?? 0)).toBeLessThanOrEqual(60);
      expect(Number(result.snapshot_bytes ?? 0)).toBeGreaterThan(0);

      await browser.waitUntil(
        async () => {
          const events = await readArmsEvents(created.session.sessionId);
          return events.some((event) => event.name === "perf_ui_session_directory_settled");
        },
        {
          timeout: 120000,
          timeoutMsg: "轻量问题目录没有进入 settled 终态",
        },
      );
      const navigator = await browser.waitUntil(
        async () => {
          const state = await getV4TurnNavigatorState();
          return state.totalItemCount >= TURNS ? state : false;
        },
        { timeout: 120000, timeoutMsg: "轻量问题目录没有覆盖全部历史 query" },
      );
      expect(navigator.visible).toBe(true);
      // rail 是虚拟列表：DOM 只挂载可视窗口，目录完整性必须看 data-item-count。
      expect(navigator.items.length).toBeLessThan(navigator.totalItemCount);
      const tail = await getV4TimelineScrollState();
      expect(tail.windowRowCount).toBeLessThanOrEqual(60);
      expect(tail.renderUnitCount).toBeLessThan(TURNS);
      expect(tail.totalRowCount).toBeGreaterThan(tail.windowRowCount);

      // 点击最旧 query 才允许按需补拉正文；这是用户显式动作，不得由宽屏目录自动发生。
      // rail 虚拟化后目录第 0 项不一定已挂载，先把 rail 滚到起点再点。
      await scrollV4TurnNavigatorToTop();
      await clickV4TurnNavigatorItemByIndex(0);
      await waitForV4TimelineContaining("历史提问 0", 120000);
      await browser.waitUntil(
        async () => (await getV4TurnNavigatorState()).items[0]?.active === true,
        { timeout: 30000, timeoutMsg: "跳转最旧 query 后 active 没有更新" },
      );
      const jumped = await getV4TimelineScrollState();
      expect(jumped.windowRowCount).toBeGreaterThan(tail.windowRowCount);

      probeData = await stopSwitchProbe();
      const settledEvents = await readArmsEvents(created.session.sessionId);
      const metrics = {
        caseId: "PERF05",
        turns: TURNS,
        beforeJump: tail,
        afterJump: jumped,
        sessionOpenResult: settledEvents.find(
          (event) => event.name === "perf_ui_session_open_result",
        ),
        directorySettled: settledEvents.find(
          (event) => event.name === "perf_ui_session_directory_settled",
        ),
        longTasks: probeData.longTasks,
        totalMs: Math.max(0, probeData.endedAt - probeData.startedAt),
      };
      const directory = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (directory) {
        await writeFile(
          join(directory, "session-switch-metrics.json"),
          JSON.stringify(metrics, null, 2),
        );
      }
      const budget = Number(process.env.ZCODE_E2E_SESSION_SWITCH_BUDGET_MS);
      if (Number.isFinite(budget) && budget > 0) expect(metrics.totalMs).toBeLessThan(budget);
    } finally {
      if (!probeData) await stopSwitchProbe();
    }
  });
});
