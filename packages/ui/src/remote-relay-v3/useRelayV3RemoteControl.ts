import { useCallback, useEffect, useRef, useState } from "react";

import type {
  RelayV3AccountActionResult,
  RelayV3DesktopStatus,
} from "@zcode/shared/remote-relay-v3";

import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

// Relay V3 远控（device 侧）的 renderer hook（P1）：状态订阅 + 账号操作 + 票据启动/停止。
// 组件经本 hook 访问平台服务，不直接触碰 window.zcode（AGENTS UI 边界）。
// 验证码 60s 重发冷却在 UI 本地维护（relay 侧另有服务端限流，§3.2）。

export interface UseRelayV3RemoteControlResult {
  supported: boolean;
  status: RelayV3DesktopStatus | null;
  sendCode: (phone: string) => Promise<RelayV3AccountActionResult>;
  login: (phone: string, code: string) => Promise<RelayV3AccountActionResult>;
  logout: () => Promise<RelayV3AccountActionResult>;
  start: (target: { workspacePath: string; workspaceIdentity?: string }) => Promise<{ accepted: boolean; reason?: string }>;
  stop: () => Promise<void>;
  cooldownRemainingMs: number;
}

export const RELAY_V3_SMS_RESEND_COOLDOWN_MS = 60_000;

export function useRelayV3RemoteControl(): UseRelayV3RemoteControlResult {
  const platform = usePlatform();
  const supported =
    typeof platform.relayV3GetStatus === "function" &&
    typeof platform.relayV3AuthorizeStart === "function";
  const [status, setStatus] = useState<RelayV3DesktopStatus | null>(null);
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
        if (!disposed) setStatus(value);
      })
      .catch((error) => logger.warn("relay-v3 status query failed", { error }));
    const disposeSubscription = platform.onRelayV3StatusChanged?.((next) => {
      setStatus(next);
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

  return {
    supported,
    status,
    sendCode,
    login,
    logout,
    start,
    stop,
    cooldownRemainingMs,
  };
}
