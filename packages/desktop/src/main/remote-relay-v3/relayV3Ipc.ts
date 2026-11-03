import { BrowserWindow, ipcMain } from "electron";

import { PlatformChannels } from "@zcode/shared";
import {
  decodeRelayV3Base64Url,
  relayV3KeyId,
  RelayV3BusinessError,
  RelayV3HttpClient,
  relayV3WorkspaceSyncPayload,
} from "@zcode/shared/remote-relay-v3";

import type { RelayV3DeviceManager } from "./relayV3DeviceManager.js";
import type { RelayV3TerminalManager } from "./relayV3TerminalManager.js";

// Relay V3 device IPC 注册（P1）。renderer 可达面只有状态查询、账号操作、票据启动、
// 停止与 workspace 同步；票据不进 renderer 可写共享协议（V2 启动调用边界语义）。
// terminal（P4 控制端）处理器在 manager 存在时注册（未登录 relay 账号时不可用）。

export function registerRelayV3DeviceIpc(manager: RelayV3DeviceManager): void {
  ipcMain.handle(PlatformChannels.RelayV3GetStatus, () => manager.getStatus());

  ipcMain.on(PlatformChannels.RelayV3SyncWorkspaces, (event, value) => {
    const parsed = relayV3WorkspaceSyncPayload.safeParse(value);
    if (!parsed.success) return;
    const windowId = parsed.data.windowId ?? BrowserWindow.fromWebContents(event.sender)?.id;
    if (windowId === undefined) return;
    manager.syncWorkspaces(windowId, parsed.data.workspaces);
  });

  ipcMain.handle(PlatformChannels.RelayV3AccountSendCode, (_event, value: { phone?: string }) => {
    if (typeof value?.phone !== "string") {
      return { ok: false, message: "invalid phone" };
    }
    return manager.sendSmsCode(value.phone);
  });

  ipcMain.handle(PlatformChannels.RelayV3AccountLogin, (_event, value: { phone?: string; code?: string }) => {
    if (typeof value?.phone !== "string" || typeof value?.code !== "string") {
      return Promise.resolve({ ok: false, message: "invalid payload" });
    }
    return manager.loginWithCode(value.phone, value.code);
  });

  ipcMain.handle(PlatformChannels.RelayV3AccountLogout, () => manager.logout());

  ipcMain.handle(
    PlatformChannels.RelayV3AuthorizeStart,
    (event, value: { workspacePath?: string; workspaceIdentity?: string } | undefined) => {
      const windowId = BrowserWindow.fromWebContents(event.sender)?.id;
      if (windowId === undefined || typeof value?.workspacePath !== "string" || !value.workspacePath) {
        throw new Error("invalid authorize payload");
      }
      const ticket = manager.authorizeStart(windowId, {
        workspacePath: value.workspacePath,
        ...(typeof value.workspaceIdentity === "string" && value.workspaceIdentity
          ? { workspaceIdentity: value.workspaceIdentity }
          : {}),
      });
      return { ticket };
    },
  );

  ipcMain.handle(PlatformChannels.RelayV3StartAuthorized, (_event, value: { ticket?: string }) => {
    if (typeof value?.ticket !== "string") {
      return { accepted: false, reason: "invalid-ticket" };
    }
    return manager.startAuthorized(value.ticket);
  });

  ipcMain.handle(PlatformChannels.RelayV3Stop, () => manager.stop());
}

export function registerRelayV3TerminalIpc(manager: RelayV3TerminalManager): void {
  ipcMain.handle(PlatformChannels.RelayV3DeviceAuthApprove, async (_event, value: { userCode?: string }) => {
    if (typeof value?.userCode !== "string" || !/^\d{8}$/.test(value.userCode)) {
      return { ok: false, message: "invalid user code" };
    }
    const baseUrl = manager.getRelayOrigin();
    const access = await manager.getAccessToken();
    if (!baseUrl || !access) {
      return { ok: false, message: "relay account not signed in" };
    }
    const client = new RelayV3HttpClient({ baseUrl });
    try {
      const result = await client.request("deviceAuthApprove", { bearer: access }, { user_code: value.userCode });
      // 批准后回显公钥指纹（§5.5 人工核对；kid = SHA-256(域分隔‖公钥) 前 8 字节 hex）。
      return {
        ok: true,
        fingerprint: relayV3KeyId(decodeRelayV3Base64Url(result.device.public_key)),
        deviceSid: result.device.device_sid,
      };
    } catch (error) {
      if (error instanceof RelayV3BusinessError) {
        return { ok: false, businessCode: error.code, message: error.msg };
      }
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(PlatformChannels.RelayV3TerminalList, async () => {
    try {
      const devices = await manager.listDevices(null);
      return { ok: true as const, devices };
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(PlatformChannels.RelayV3TerminalConnect, (_event, value: { deviceSid?: string }) => {
    if (typeof value?.deviceSid !== "string" || !value.deviceSid) {
      return { ok: false as const, message: "invalid deviceSid" };
    }
    return manager
      .connectByDeviceSid(value.deviceSid)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }));
  });

  ipcMain.handle(PlatformChannels.RelayV3TerminalDisconnect, () => manager.disconnect());

  ipcMain.handle(
    PlatformChannels.RelayV3TerminalOpenWorkspace,
    (_event, value: { workspaceKey?: string }) => {
      if (typeof value?.workspaceKey !== "string" || !value.workspaceKey) {
        return { ok: false as const, message: "invalid workspaceKey" };
      }
      return manager
        .openWorkspaceBridge(value.workspaceKey)
        .then((session) => ({
          ok: true as const,
          bridgeSessionId: session.bridgeSessionId,
          bridgeGeneration: session.bridgeGeneration,
          workspaceKey: session.workspaceKey,
        }))
        .catch((error: unknown) => ({
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        }));
    },
  );
}
