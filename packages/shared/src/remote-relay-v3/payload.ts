import { z } from "zod";

// Relay V3 业务 payload 契约（docs/relay-server/relay-v3-design.md §4.4/§5.2）。
// data 消息的 payload 是密文信封（contract.ts 的 RelayV3Envelope）；解密后的明文
// JSON 是本模块定义的业务消息，以 `zcode_type` 区分。两端（桌面 device、手机/桌面
// terminal）共享同一份编解码，relay 对本模块零感知（只见不透明密文）。
// 语义依据 V2 架构文档的 App Payload 集合，字段按 V3 自身需求设计、不保留 V2 兼容层。

const identifier = z.string().min(1).max(256);
const workspaceKey = z.string().min(1).max(512);

// ---------------------------------------------------------------------------
// 公共结构
// ---------------------------------------------------------------------------

/** bootstrap/列表里的工作区摘要：只含路由与展示，不含 task/stream 业务事实。 */
export const relayV3WorkspaceSummary = z.object({
  workspace_key: workspaceKey,
  path: z.string().min(1),
  name: z.string().optional(),
  identity: z.string().optional(),
  connection: z.enum(["local", "remote", "offline"]),
  bridgeable: z.boolean(),
  remote_session_id: z.string().optional(),
});
export type RelayV3WorkspaceSummary = z.infer<typeof relayV3WorkspaceSummary>;

/** 手机浏览器采集的受控设备信息；仅展示用，不参与身份/配对/缓存 key（V2 语义保留）。 */
const mobileDeviceInfo = z.object({
  platform: z.string().optional(),
  name: z.string().optional(),
  language: z.string().optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  timezone: z.string().optional(),
  collected_at: z.number().int().min(0),
});
export type RelayV3MobileDeviceInfo = z.infer<typeof mobileDeviceInfo>;

const mobileViewState = z.object({
  active_workspace_key: workspaceKey.optional(),
  active_task_id: identifier.optional(),
  updated_at: z.number().int().min(0),
  device_info: mobileDeviceInfo.optional(),
});
export type RelayV3MobileViewState = z.infer<typeof mobileViewState>;

// ---------------------------------------------------------------------------
// bootstrap 与工作区列表
// ---------------------------------------------------------------------------

const bootstrapRequest = z.strictObject({
  zcode_type: z.literal("bootstrap-request"),
  terminal_client_id: identifier,
  terminal_kind: z.enum(["phone-web", "desktop-terminal"]),
  view_state: mobileViewState.optional(),
});
export type RelayV3BootstrapRequest = z.infer<typeof bootstrapRequest>;

const bootstrapResponse = z.object({
  zcode_type: z.literal("bootstrap-response"),
  desktop_app_version: z.string().min(1).optional(),
  workspaces: z.array(relayV3WorkspaceSummary),
  view_state: mobileViewState.optional(),
  terminal_owner_id: z.string().optional(),
});
export type RelayV3BootstrapResponse = z.infer<typeof bootstrapResponse>;

const workspaceListRequest = z.strictObject({
  zcode_type: z.literal("workspace-list-request"),
});
export type RelayV3WorkspaceListRequest = z.infer<typeof workspaceListRequest>;

const workspaceListResult = z.object({
  workspaces: z.array(relayV3WorkspaceSummary),
});
export type RelayV3WorkspaceListResult = z.infer<typeof workspaceListResult>;

const workspaceListResponse = z.object({
  zcode_type: z.literal("workspace-list-response"),
  ...workspaceListResult.shape,
});
export type RelayV3WorkspaceListResponse = z.infer<typeof workspaceListResponse>;

const workspaceListUpdated = z.object({
  zcode_type: z.literal("workspace-list-updated"),
  ...workspaceListResult.shape,
});
export type RelayV3WorkspaceListUpdated = z.infer<typeof workspaceListUpdated>;

// ---------------------------------------------------------------------------
// workspace bridge（手机/控制端 → 桌面 Host 的 MessagePort attachment 协商）
// ---------------------------------------------------------------------------

const workspaceBridgeOpen = z.strictObject({
  zcode_type: z.literal("workspace-bridge-open"),
  bridge_session_id: identifier,
  workspace_key: workspaceKey,
  // 页面会话标识：main 据此分配 terminalOwnerId（终端 PTY owner，V2 CR-01 语义）。
  terminal_client_session_id: identifier.optional(),
  // 携带初始任务意图时由 main 侧做 Host 任务身份核验，不在此处展开业务字段。
  initial_task_id: identifier.optional(),
});
export type RelayV3WorkspaceBridgeOpen = z.infer<typeof workspaceBridgeOpen>;

const workspaceBridgeReady = z.object({
  zcode_type: z.literal("workspace-bridge-ready"),
  bridge_session_id: identifier,
  bridge_generation: z.number().int().min(1),
  terminal_owner_id: z.string().optional(),
});
export type RelayV3WorkspaceBridgeReady = z.infer<typeof workspaceBridgeReady>;

const workspaceBridgeError = z.object({
  zcode_type: z.literal("workspace-bridge-error"),
  bridge_session_id: identifier.optional(),
  code: z.string().min(1),
  message: z.string().optional(),
});
export type RelayV3WorkspaceBridgeError = z.infer<typeof workspaceBridgeError>;

/** raw transport 故障的通用降级通知；具体 reasonCode 留在 owning 端日志（V2 语义）。 */
const bridgeDegraded = z.object({
  zcode_type: z.literal("bridge-degraded"),
  bridge_session_id: identifier.optional(),
  reason: z.literal("rpc-transport-fault"),
});
export type RelayV3BridgeDegraded = z.infer<typeof bridgeDegraded>;

// ---------------------------------------------------------------------------
// 视图状态与错误
// ---------------------------------------------------------------------------

const mobileViewStateUpdate = z.strictObject({
  zcode_type: z.literal("mobile-view-state-update"),
  active_workspace_key: workspaceKey.optional(),
  active_task_id: identifier.optional(),
  updated_at: z.number().int().min(0),
  device_info: mobileDeviceInfo.optional(),
});
export type RelayV3MobileViewStateUpdate = z.infer<typeof mobileViewStateUpdate>;

const appError = z.object({
  zcode_type: z.literal("app-error"),
  code: z.string().min(1),
  message: z.string().optional(),
});
export type RelayV3AppError = z.infer<typeof appError>;

// ---------------------------------------------------------------------------
// 汇聚与解析
// ---------------------------------------------------------------------------

export const relayV3AppPayload = z.discriminatedUnion("zcode_type", [
  bootstrapRequest,
  bootstrapResponse,
  workspaceListRequest,
  workspaceListResponse,
  workspaceListUpdated,
  workspaceBridgeOpen,
  workspaceBridgeReady,
  workspaceBridgeError,
  bridgeDegraded,
  mobileViewStateUpdate,
  appError,
]);
export type RelayV3AppPayload = z.infer<typeof relayV3AppPayload>;

/**
 * 解析 data 明文业务 payload。返回 null 表示不是合法的 V3 业务消息；
 * 调用方按协议错误处理（记录安全元数据，不记录原始 JSON）。
 */
export function parseRelayV3AppPayload(value: unknown): RelayV3AppPayload | null {
  const result = relayV3AppPayload.safeParse(value);
  return result.success ? result.data : null;
}
