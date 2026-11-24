import type {
  RelayV3WorkspaceSummary,
  RelayV3WorkspaceSyncEntry,
} from "@zcode/shared/remote-relay-v3";

// Relay V3 device 的 workspace 目录查询（P1）：relayV3DeviceManager 按窗口保存全量快照，
// 这里只承载与运行态无关的纯查询——跨窗口匹配 workspaceKey 与生成发给 terminal 的去重列表。
// 从 manager 拆出以守住单文件行数上限；快照的写入与 owner 仍在 manager。

type WorkspacesByWindowId = ReadonlyMap<number, RelayV3WorkspaceSyncEntry[]>;

/** 跨窗口查找 workspaceKey 对应的目录项及其所属窗口（attachment 挂到该窗口的 Host）。 */
export function findRelayV3Workspace(
  workspacesByWindowId: WorkspacesByWindowId,
  workspaceKey: string,
): { windowId: number; entry: RelayV3WorkspaceSyncEntry } | null {
  for (const [windowId, entries] of workspacesByWindowId) {
    for (const entry of entries) {
      if (entry.workspaceKey === workspaceKey) return { windowId, entry };
    }
  }
  return null;
}

/** 所有窗口目录按 workspaceKey 去重后的列表（bootstrap / workspace-list 响应）。 */
export function flattenRelayV3Workspaces(
  workspacesByWindowId: WorkspacesByWindowId,
): RelayV3WorkspaceSummary[] {
  const seen = new Set<string>();
  const workspaces: RelayV3WorkspaceSummary[] = [];
  for (const entries of workspacesByWindowId.values()) {
    for (const entry of entries) {
      if (seen.has(entry.workspaceKey)) continue;
      seen.add(entry.workspaceKey);
      workspaces.push({
        workspace_key: entry.workspaceKey,
        path: entry.workspacePath,
        connection: entry.remoteSessionId ? "remote" : "local",
        bridgeable: entry.bridgeable,
        ...(entry.workspaceIdentity ? { identity: entry.workspaceIdentity } : {}),
        ...(entry.remoteSessionId ? { remote_session_id: entry.remoteSessionId } : {}),
      });
    }
  }
  return workspaces;
}
