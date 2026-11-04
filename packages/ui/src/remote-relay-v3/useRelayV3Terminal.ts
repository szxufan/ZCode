import { useCallback, useEffect, useState } from "react";

import type { RelayV3Device, RelayV3TerminalStatus } from "@zcode/shared/remote-relay-v3";

import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

// Relay V3 控制端 hook（P4，§6）：设备列表、连接目标设备、打开 workspace bridge。
// 控制端选中态（当前设备/工作区）是控制端本地状态，不影响被控端（§6.3）。
// 控制端可：浏览任务、发输入、处理权限；不可：管理被控端的工作区连接（§6.2）。

export interface UseRelayV3TerminalResult {
  supported: boolean;
  status: RelayV3TerminalStatus | null;
  devices: RelayV3Device[];
  listError: string | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
  connect: (deviceSid: string) => Promise<{ ok: boolean; message?: string }>;
  disconnect: () => Promise<void>;
  openWorkspace: (
    workspaceKey: string,
  ) => Promise<{ ok: boolean; bridgeSessionId?: string; bridgeGeneration?: number; message?: string }>;
}

export function useRelayV3Terminal(): UseRelayV3TerminalResult {
  const platform = usePlatform();
  const supported = typeof platform.relayV3TerminalList === "function";
  const [status, setStatus] = useState<RelayV3TerminalStatus | null>(null);
  const [devices, setDevices] = useState<RelayV3Device[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!supported) return;
    return platform.onRelayV3TerminalStatusChanged?.((next) => setStatus(next));
  }, [platform, supported]);

  const refresh = useCallback(async () => {
    if (!platform.relayV3TerminalList) return;
    setRefreshing(true);
    setListError(null);
    try {
      const result = await platform.relayV3TerminalList();
      if (result.ok && result.devices) {
        setDevices(result.devices);
      } else {
        setListError(result.message ?? "list failed");
      }
    } catch (error) {
      logger.warn("relay-v3 terminal list failed", { error });
      setListError(error instanceof Error ? error.message : "list failed");
    } finally {
      setRefreshing(false);
    }
  }, [platform]);

  const connect = useCallback(
    async (deviceSid: string) => {
      return (await platform.relayV3TerminalConnect?.(deviceSid)) ?? { ok: false, message: "unavailable" };
    },
    [platform],
  );

  const disconnect = useCallback(async () => {
    await platform.relayV3TerminalDisconnect?.();
  }, [platform]);

  const openWorkspace = useCallback(
    async (workspaceKey: string) => {
      return (
        (await platform.relayV3TerminalOpenWorkspace?.(workspaceKey)) ?? {
          ok: false as const,
          message: "unavailable",
        }
      );
    },
    [platform],
  );

  return {
    supported,
    status,
    devices,
    listError,
    refreshing,
    refresh,
    connect,
    disconnect,
    openWorkspace,
  };
}
