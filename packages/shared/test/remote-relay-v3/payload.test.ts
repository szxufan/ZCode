import { describe, expect, it } from "vitest";

import { parseRelayV3AppPayload } from "@zcode/shared/remote-relay-v3";

// V3 业务 payload 契约：合法样例往返、非法字段拒绝、未知 zcode_type 拒绝。

describe("Relay V3 业务 payload", () => {
  it("bootstrap-request/response 合法样例", () => {
    expect(
      parseRelayV3AppPayload({
        zcode_type: "bootstrap-request",
        terminal_client_id: "c_1",
        terminal_kind: "phone-web",
        view_state: {
          active_workspace_key: "/home/user/proj",
          updated_at: 1_700_000_000_000,
          device_info: { platform: "iPhone", collected_at: 1 },
        },
      }),
    ).toMatchObject({ zcode_type: "bootstrap-request", terminal_client_id: "c_1" });

    expect(
      parseRelayV3AppPayload({
        zcode_type: "bootstrap-response",
        desktop_app_version: "3.20.0",
        workspaces: [
          {
            workspace_key: "/home/user/proj",
            path: "/home/user/proj",
            connection: "local",
            bridgeable: true,
          },
        ],
        terminal_owner_id: "owner_1",
      }),
    ).toMatchObject({ zcode_type: "bootstrap-response", terminal_owner_id: "owner_1" });
  });

  it("workspace-bridge 三段协商合法样例", () => {
    expect(
      parseRelayV3AppPayload({
        zcode_type: "workspace-bridge-open",
        bridge_session_id: "bs_1",
        workspace_key: "/home/user/proj",
        terminal_client_session_id: "page_1",
        initial_task_id: "task_9",
      }),
    ).toMatchObject({ zcode_type: "workspace-bridge-open", initial_task_id: "task_9" });
    expect(
      parseRelayV3AppPayload({
        zcode_type: "workspace-bridge-ready",
        bridge_session_id: "bs_1",
        bridge_generation: 2,
      }),
    ).toMatchObject({ bridge_generation: 2 });
    expect(
      parseRelayV3AppPayload({
        zcode_type: "workspace-bridge-error",
        code: "REMOTE_WORKSPACE_IDENTITY_MISMATCH",
      }),
    ).toMatchObject({ code: "REMOTE_WORKSPACE_IDENTITY_MISMATCH" });
  });

  it("bridge-degraded 只接受通用原因码", () => {
    expect(parseRelayV3AppPayload({ zcode_type: "bridge-degraded", reason: "rpc-transport-fault" })).not.toBeNull();
    expect(parseRelayV3AppPayload({ zcode_type: "bridge-degraded", reason: "something-else" })).toBeNull();
  });

  it("非法与未知消息拒绝", () => {
    expect(parseRelayV3AppPayload(null)).toBeNull();
    expect(parseRelayV3AppPayload("bootstrap-request")).toBeNull();
    expect(parseRelayV3AppPayload({ zcode_type: "unknown-type" })).toBeNull();
    // 请求类 strict：多余字段拒绝（response 类允许服务端新增字段）。
    expect(
      parseRelayV3AppPayload({ zcode_type: "workspace-list-request", extra: true }),
    ).toBeNull();
    expect(
      parseRelayV3AppPayload({ zcode_type: "mobile-view-state-update", updated_at: -1 }),
    ).toBeNull();
  });
});
