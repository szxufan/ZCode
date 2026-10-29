import { describe, expect, it } from "vitest";

import {
  shouldReuseDesktopE2EBuild,
  CODING_PLAN_TEAM_MOCK_BASE_URL_ENV,
  CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV,
  applyCodingPlanTeamMockEnv,
  applyCodingPlanUpgradeMockEnv,
  clearCodingPlanTeamMockEnv,
  clearCodingPlanUpgradeMockEnv,
  shouldPrepareCodingPlanTeamMock,
} from "./e2e/helpers/coding-plan-mock-env.js";

describe("Coding Plan E2E mock env", () => {
  it("网页 mock 分配新端口后不能复用父构建，源码证据也必须标记重新构建", () => {
    expect(shouldReuseDesktopE2EBuild({})).toBe(false);
    expect(shouldReuseDesktopE2EBuild({ ZCODE_E2E_SKIP_BUILD: "1" })).toBe(true);
    expect(
      shouldReuseDesktopE2EBuild({
        ZCODE_E2E_SKIP_BUILD: "1",
        [CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]: "http://127.0.0.1:43123",
      }),
    ).toBe(false);
  });
  it.each([
    "settings/settings-ui-polish.test.ts",
    "ui-shell/side-pane-tabs-responsive-interactions.test.ts",
  ])("Logo 外观回归隔离模拟账号控制面：%s", (spec) => {
    expect(shouldPrepareCodingPlanTeamMock([`./test/e2e/${spec}`])).toBe(true);
  });
  it("定时任务创建遥测回归隔离账号控制面", () => {
    expect(
      shouldPrepareCodingPlanTeamMock([
        "./test/e2e/conversation-session/conversation-session-automation-run-title-stable.test.ts",
      ]),
    ).toBe(true);
  });
  it.each([
    "./test/e2e/conversation-session/*.test.ts",
    "test/e2e/conversation-session/*.test.ts",
    ".\\test\\e2e\\conversation-session\\*.test.ts",
    "test\\e2e\\conversation-session\\*.test.ts",
    "./test/e2e/**/*.test.ts",
    "test/e2e/**/*.test.ts",
    ".\\test\\e2e\\**\\*.test.ts",
  ])("prepares the mock before workers expand the suite glob %s", (spec) => {
    expect(shouldPrepareCodingPlanTeamMock([spec])).toBe(true);
  });

  it("prepares the mock for the formal CI suite without opting unrelated workers in", () => {
    const unrelatedSpecs = [
      "./test/e2e/plugins/*.test.ts",
      "./test/e2e/workspace-file-tree-refresh.test.ts",
      "./test/e2e/conversation-session/conversation-session-background.test.ts",
    ];
    expect(
      shouldPrepareCodingPlanTeamMock([
        "./test/e2e/conversation-session/*.test.ts",
        ...unrelatedSpecs,
      ]),
    ).toBe(true);
    expect(shouldPrepareCodingPlanTeamMock(unrelatedSpecs)).toBe(false);
    expect(shouldPrepareCodingPlanTeamMock([])).toBe(false);
  });

  it.each([".test.ts", "-cli.test.ts", "-tui.test.ts", "*.test.ts"])(
    "keeps ToolSearch targeted entry %s enabled",
    (suffix) => {
      expect(
        shouldPrepareCodingPlanTeamMock([
          `./test/e2e/conversation-session/conversation-session-toolsearch${suffix}`,
        ]),
      ).toBe(true);
    },
  );

  it.each([
    "conversation-session-rpn-project-navigation.test.ts",
    "conversation-session-ssh-disconnect-experience.test.ts",
    "conversation-session-ssh-remote-cold-reconnect.test.ts",
    "conversation-session-r3-mixed-entries.test.ts",
    "conversation-session-create-telemetry.test.ts",
  ])("prepares account facts for %s", (spec) => {
    expect(
      shouldPrepareCodingPlanTeamMock([
        `./test/e2e/conversation-session/manual-review/pending/${spec}`,
      ]),
    ).toBe(true);
  });
  it.each([
    "conversation-session-highspeed-card.test.ts",
    "conversation-session-highspeed-card-draw-timeout.test.ts",
    "conversation-session-highspeed-card-draw-miss.test.ts",
    "conversation-session-highspeed-card-fallback-unlocks-model.test.ts",
    "conversation-session-highspeed-card-admission-retains-draft.test.ts",
  ])("prepares Coding Plan entitlement for highspeed draw case %s", (spec) => {
    expect(shouldPrepareCodingPlanTeamMock([`./test/e2e/conversation-session/${spec}`])).toBe(true);
  });
  it("keeps both prepared mock addresses while a team worker activates only the team mock", () => {
    const environment: Record<string, string | undefined> = {};
    const teamBaseUrl = "http://127.0.0.1:41001";
    const upgradeBaseUrl = "http://127.0.0.1:41002";

    applyCodingPlanTeamMockEnv(environment, teamBaseUrl);
    applyCodingPlanUpgradeMockEnv(environment, upgradeBaseUrl);

    expect(environment[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV]).toBe(teamBaseUrl);
    expect(environment[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]).toBe(upgradeBaseUrl);

    applyCodingPlanTeamMockEnv(environment, teamBaseUrl);
    clearCodingPlanUpgradeMockEnv(environment, upgradeBaseUrl);

    expect(environment.ZCODE_BASE_URL).toBe(teamBaseUrl);
    expect(environment.ZCODE_ENDPOINT_ORIGIN).toBe(teamBaseUrl);
    expect(environment.ZCODE_E2E_CODING_PLAN_MOCK_URL).toBe(teamBaseUrl);
  });

  it("does not clear an active upgrade mock when a non-team worker drops the prepared team mock", () => {
    const environment: Record<string, string | undefined> = {};
    const teamBaseUrl = "http://127.0.0.1:42001";
    const upgradeBaseUrl = "http://127.0.0.1:42002";

    applyCodingPlanTeamMockEnv(environment, teamBaseUrl);
    applyCodingPlanUpgradeMockEnv(environment, upgradeBaseUrl);
    clearCodingPlanTeamMockEnv(environment, teamBaseUrl);

    expect(environment.ZCODE_BASE_URL).toBe(upgradeBaseUrl);
    expect(environment.ZCODE_ENDPOINT_ORIGIN).toBe(upgradeBaseUrl);
    expect(environment.ZCODE_E2E_CODING_PLAN_MOCK_URL).toBe(upgradeBaseUrl);
  });

  it("prepares the team mock for targeted provider transition cases", () => {
    expect(
      shouldPrepareCodingPlanTeamMock([
        "./test/e2e/conversation-session/conversation-session-model-provider-restart-recovery.test.ts",
        "./test/e2e/conversation-session/conversation-session-model-provider-turbo-switch.test.ts",
      ]),
    ).toBe(true);
  });
});
