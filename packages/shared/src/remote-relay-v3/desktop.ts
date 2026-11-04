import { z } from "zod";

import type { RelayV3WorkspaceSummary } from "./payload.js";

// Relay V3 桌面被控端（device）的对外状态与 IPC 契约（P1，docs/relay-server/relay-v3-design.md §9）。
// renderer 只消费投影与发送命令；设备身份、连接与 bridge attachment 的唯一 owner 是
// main 的 relayV3DeviceManager。私钥、access/refresh token 不出现在本模块的任何类型里。

const workspaceKey = z.string().min(1).max(512);

/** renderer 同步给 main 的 workspace 目录项（按窗口全量快照同步）。 */
export const relayV3WorkspaceSyncEntry = z.object({
  workspaceKey,
  workspacePath: z.string().min(1),
  workspaceIdentity: z.string().optional(),
  /** 远程 workspace 的 logical session；本地 workspace 缺省。 */
  remoteSessionId: z.string().optional(),
  sourceServerId: z.string().optional(),
  /** Host scope 是否已可 bridge（本地 workspace ready / 远程 session attachable）。 */
  bridgeable: z.boolean(),
});
export type RelayV3WorkspaceSyncEntry = z.infer<typeof relayV3WorkspaceSyncEntry>;

export const relayV3WorkspaceSyncPayload = z.object({
  windowId: z.number().int().nonnegative(),
  workspaces: z.array(relayV3WorkspaceSyncEntry),
});
export type RelayV3WorkspaceSyncPayload = z.infer<typeof relayV3WorkspaceSyncPayload>;

export type RelayV3DesktopPhase =
  | "idle" // 未启用
  | "auth-required" // 等待 relay 账号登录（不注册、不建连）
  | "starting" // 已受理启动（注册/建连前）
  | "connecting" // 取 token / ws 握手中
  | "waiting" // 已认证，等待 terminal 配对
  | "active" // 已配对（终端可操作）
  | "error"; // 终态失败（见 failure）

export type RelayV3DesktopFailureKind =
  | "relay-unavailable"
  | "session-conflict"
  | "auth-failed"
  | "device-offline"
  | "stopped";

/** renderer 可见的远控状态投影；不含 token、私钥与完整手机号。 */
export interface RelayV3DesktopStatus {
  phase: RelayV3DesktopPhase;
  failure?: { kind: RelayV3DesktopFailureKind; message?: string };
  /** 已登录的 relay 账号摘要（未登录为 null）。 */
  account: { phoneMasked: string } | null;
  deviceSid: string | null;
  /** 配对可用（waiting/active）后的扫码 URL；base 指向 relay 静态页（§5.3/§5.4）。 */
  qrUrl: string | null;
  /** relay endpoint origin（设置项，供 UI 展示）。 */
  relayOrigin: string | null;
}

export const RELAY_V3_DESKTOP_PHASES: readonly RelayV3DesktopPhase[] = [
  "idle",
  "auth-required",
  "starting",
  "connecting",
  "waiting",
  "active",
  "error",
];

/** 账号操作结果：业务错误以 code 透传给 UI（限流/短信不可用等），凭据不进 payload。 */
export interface RelayV3AccountActionResult {
  ok: boolean;
  /** relay 业务码（§5.1）：0 成功；RATE_LIMITED/SMS_UNAVAILABLE/LOCKED 等供 UI 分支。 */
  businessCode?: number;
  message?: string;
  phoneMasked?: string;
}

/** 启动授权：authorizeStart 颁发的一次性短 TTL 内部票据（不进日志/设置）。 */
export interface RelayV3StartTicketResult {
  ticket: string;
}

// ---------------------------------------------------------------------------
// 控制端（P4，§6）：桌面作为 terminal 连接其他电脑的状态投影与 IPC 契约。
// ---------------------------------------------------------------------------

export interface RelayV3TerminalStatus {
  phase: "idle" | "connecting" | "waiting" | "active" | "error";
  target: { deviceSid: string; name: string | null } | null;
  failure?: { message?: string };
  workspaces: RelayV3WorkspaceSummary[];
  activeBridgeCount: number;
}

/** 控制端 bridge port 投递 payload（main → renderer，随 MessagePort 一起）。 */
export interface RelayV3TerminalPortPayload {
  bridgeSessionId: string;
  workspaceKey: string;
  bridgeGeneration: number;
}
