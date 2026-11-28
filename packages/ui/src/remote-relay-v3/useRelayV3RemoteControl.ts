import { useCallback, useEffect, useRef, useState } from "react";

import type {
  RelayV3AccountActionResult,
  RelayV3ConfigureEndpointResult,
  RelayV3DesktopStatus,
} from "@zcode/shared/remote-relay-v3";

import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

// Relay V3 远控（device 侧）的 renderer hook（P1）：状态订阅 + 账号操作 + 票据启动/停止
// + 服务器地址配置。组件经本 hook 访问平台服务，不直接触碰 window.zcode（AGENTS UI 边界）。
// 验证码 60s 重发冷却在 UI 本地维护（relay 侧另有服务端限流，§3.2）。

export interface UseRelayV3RemoteControlResult {
  supported: boolean;
  /** 平台实现是否提供服务器地址配置命令；不提供时（非桌面平台）不渲染地址行。 */
  endpointSupported: boolean;
  status: RelayV3DesktopStatus | null;
  /** 首次状态查询失败；应用启动门禁据此放弃等待，避免 IPC 异常把启动卡死。 */
  statusQueryFailed: boolean;
  sendCode: (phone: string) => Promise<RelayV3AccountActionResult>;
  login: (phone: string, code: string) => Promise<RelayV3AccountActionResult>;
  logout: () => Promise<RelayV3AccountActionResult>;
  start: (target: { workspacePath: string; workspaceIdentity?: string }) => Promise<{ accepted: boolean; reason?: string }>;
  stop: () => Promise<void>;
  /** 提交 relay 服务器地址原始输入；归一化、校验与切换善后都在 main（设计 §3.5）。 */
  configureEndpoint: (rawOrigin: string) => Promise<RelayV3ConfigureEndpointResult>;
  cooldownRemainingMs: number;
}

export const RELAY_V3_SMS_RESEND_COOLDOWN_MS = 60_000;

export function useRelayV3RemoteControl(): UseRelayV3RemoteControlResult {
  const platform = usePlatform();
  const supported =
    typeof platform.relayV3GetStatus === "function" &&
    typeof platform.relayV3AuthorizeStart === "function";
  const endpointSupported = typeof platform.relayV3ConfigureEndpoint === "function";
  const [status, setStatus] = useState<RelayV3DesktopStatus | null>(null);
  const [statusQueryFailed, setStatusQueryFailed] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    platform
      .relayV3GetStatus?.()
      .then((value) => {
        if (!disposed) {
          setStatus(value);
          setStatusQueryFailed(false);
        }
      })
      .catch((error) => {
        if (!disposed) setStatusQueryFailed(true);
        logger.warn("relay-v3 status query failed", { error });
      });
    const disposeSubscription = platform.onRelayV3StatusChanged?.((next) => {
      setStatus(next);
      setStatusQueryFailed(false);
    });
    return () => {
      disposed = true;
      disposeSubscription?.();
    };
  }, [platform, supported]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCooldownRemainingMs(Math.max(0, cooldownUntil - Date.now()));
    }, 500);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  const sendCode = useCallback(
    async (phone: string): Promise<RelayV3AccountActionResult> => {
      const result = (await platform.relayV3SendSmsCode?.(phone)) ?? {
        ok: false,
        message: "relay v3 bridge unavailable",
      };
      if (result.ok) {
        setCooldownUntil(Date.now() + RELAY_V3_SMS_RESEND_COOLDOWN_MS);
      }
      return result;
    },
    [platform],
  );

  const login = useCallback(
    async (phone: string, code: string): Promise<RelayV3AccountActionResult> => {
      return (
        (await platform.relayV3Login?.(phone, code)) ?? {
          ok: false,
          message: "relay v3 bridge unavailable",
        }
      );
    },
    [platform],
  );

  const logout = useCallback(
    async (): Promise<RelayV3AccountActionResult> => {
      return (
        (await platform.relayV3Logout?.()) ?? {
          ok: false,
          message: "relay v3 bridge unavailable",
        }
      );
    },
    [platform],
  );

  const start = useCallback(
    async (target: { workspacePath: string; workspaceIdentity?: string }) => {
      const ticketResult = await platform.relayV3AuthorizeStart?.(target);
      if (!ticketResult?.ticket) {
        return { accepted: false, reason: "authorize-failed" };
      }
      return (
        (await platform.relayV3StartAuthorized?.(ticketResult.ticket)) ?? {
          accepted: false,
          reason: "bridge-unavailable",
        }
      );
    },
    [platform],
  );

  const stop = useCallback(async () => {
    await platform.relayV3Stop?.();
  }, [platform]);

  const configureEndpoint = useCallback(
    async (rawOrigin: string): Promise<RelayV3ConfigureEndpointResult> => {
      return (
        (await platform.relayV3ConfigureEndpoint?.(rawOrigin)) ?? {
          ok: false,
          reason: "unavailable",
        }
      );
    },
    [platform],
  );

  return {
    supported,
    endpointSupported,
    status,
    statusQueryFailed,
    sendCode,
    login,
    logout,
    start,
    stop,
    configureEndpoint,
    cooldownRemainingMs,
  };
}
