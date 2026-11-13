import type { ArmsCustomEventPayload } from "@zcode/shared";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerSelectionReady,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const PROMPT_MARKER = "E2E_SESSION_OPEN_EXISTING_ONLY";
const REPLY_MARKER = "session-open-existing-only-ok";
const SESSION_OPEN_EVENT_NAMES = [
  "perf_ui_session_open_start",
  "perf_ui_session_open_result",
] as const;
const SESSION_DIRECTORY_SETTLED_EVENT_NAME = "perf_ui_session_directory_settled";

describe("conversation session open existing only", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("草稿提升零上报，离开后重开已有 Session 只上报一组", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E();
    await waitForV4ComposerSelectionReady();
    await clearSessionOpenArmsEvents();

    await sendV4Prompt(`${PROMPT_MARKER}: create a new task without session-open telemetry.`);
    await waitForV4AssistantMessageContaining(REPLY_MARKER, 60_000);
    const createdPane = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "TEL10 草稿提升后没有形成已完成 Session",
      60_000,
    );
    const createdSessionId = createdPane.sessionId;
    if (!createdSessionId || createdSessionId === "draft") {
      throw new Error("TEL10 无法取得新建 Session ID");
    }

    await browser.pause(500);
    expect(await readSessionOpenArmsEvents(createdSessionId)).toEqual([]);

    await startNewV4Draft();
    await waitForV4ComposerSelectionReady();
    // E2E store bridge 把 renderer keep-warm 缩到 1s；等待它过期，确保本组断言覆盖 cold ACK 字段。
    await browser.pause(1_500);
    await clearSessionOpenArmsEvents();
    await selectV4TaskById(createdSessionId);

    const reopenedEvents = await waitForSessionOpenArmsPair(createdSessionId);
    expect(reopenedEvents.map((event) => event.name)).toEqual(SESSION_OPEN_EVENT_NAMES);
    expect(reopenedEvents[0]?.properties?.session_open_id).toBe(
      reopenedEvents[1]?.properties?.session_open_id,
    );
    expect(reopenedEvents[0]?.properties).toMatchObject({
      session_id: createdSessionId,
      open_trigger: "sidebar",
      open_kind: "cold",
    });
    const resultProperties = reopenedEvents[1]?.properties ?? {};
    expect(resultProperties).toMatchObject({
      session_id: createdSessionId,
      status: "success",
    });
    expect(Number(resultProperties.snapshot_row_count ?? 0)).toBeGreaterThan(0);
    expect(Number(resultProperties.snapshot_row_count ?? 0)).toBeLessThanOrEqual(60);
    expect(Number(resultProperties.snapshot_bytes ?? 0)).toBeGreaterThan(0);
    // renderer cold 不代表 CLI runtime cold：会话刚完成时 publisher 仍可 resident。
    // historyReady/persisted count 只在 CLI 冷恢复样本中断言，warm 样本保持字段缺席。
    if (resultProperties.session_runtime_state === "cold") {
      expect(resultProperties.history_ready_ms).toBeDefined();
      expect(Number(resultProperties.persisted_message_count ?? 0)).toBeGreaterThan(0);
    }

    const settledEvent = await waitForSessionDirectorySettledEvent(createdSessionId);
    expect(settledEvent.properties).toMatchObject({
      session_id: createdSessionId,
      directory_status: "ineligible",
    });
    expect(Number(settledEvent.properties?.settled_ms ?? 0)).toBeGreaterThanOrEqual(0);
    expect(Number(settledEvent.properties?.loaded_row_count ?? 0)).toBeGreaterThan(0);
    expect(Number(settledEvent.properties?.total_row_count ?? 0)).toBeGreaterThan(0);
  });
});

async function clearSessionOpenArmsEvents(): Promise<void> {
  await browser.execute(() => {
    (
      window as Window & {
        __zcodeArmsCustomEventsE2E?: Array<ArmsCustomEventPayload & { recordedAt?: number }>;
      }
    ).__zcodeArmsCustomEventsE2E = [];
  });
}

async function readSessionOpenArmsEvents(sessionId: string): Promise<ArmsCustomEventPayload[]> {
  return readSessionOpenArmsEventsForNames(sessionId, [...SESSION_OPEN_EVENT_NAMES]);
}

async function readSessionOpenArmsEventsForNames(
  sessionId: string,
  eventNames: readonly string[],
): Promise<ArmsCustomEventPayload[]> {
  return browser.execute(
    (targetSessionId, targetEventNames) => {
      const events =
        (
          window as Window & {
            __zcodeArmsCustomEventsE2E?: Array<ArmsCustomEventPayload & { recordedAt?: number }>;
          }
        ).__zcodeArmsCustomEventsE2E ?? [];
      return events
        .filter(
          (event) =>
            (targetEventNames as readonly string[]).includes(event.name) &&
            event.properties?.session_id === targetSessionId,
        )
        .map(({ recordedAt: _recordedAt, ...payload }) => payload);
    },
    sessionId,
    [...eventNames],
  );
}

async function waitForSessionOpenArmsPair(sessionId: string): Promise<ArmsCustomEventPayload[]> {
  let latest: ArmsCustomEventPayload[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readSessionOpenArmsEvents(sessionId);
      return latest.length === SESSION_OPEN_EVENT_NAMES.length;
    },
    {
      timeout: 30_000,
      timeoutMsg: `TEL10 重开已有 Session 没有得到一组 session-open 事件: ${sessionId}`,
    },
  );
  return latest;
}

async function waitForSessionDirectorySettledEvent(
  sessionId: string,
): Promise<ArmsCustomEventPayload> {
  let latest: ArmsCustomEventPayload | undefined;
  await browser.waitUntil(
    async () => {
      latest = (
        await readSessionOpenArmsEventsForNames(sessionId, [SESSION_DIRECTORY_SETTLED_EVENT_NAME])
      )[0];
      return latest !== undefined;
    },
    {
      timeout: 30_000,
      timeoutMsg: `TEL10 重开已有 Session 没有得到 directory settled 事件: ${sessionId}`,
    },
  );
  if (latest === undefined) throw new Error("directory settled event disappeared");
  return latest;
}
