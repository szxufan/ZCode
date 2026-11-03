import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useRelayV3RemoteControl } from "./useRelayV3RemoteControl.js";
import { useRelayV3Terminal } from "./useRelayV3Terminal.js";
import { logger } from "@/logger.js";

// Relay V3 远程控制设置节（device 侧，P1）：relay 账号登录（手机号+验证码）、
// 启动/停止远控、扫码连接二维码与 relay endpoint 配置。凭据与私钥不在本层出现。
// 文案与状态语义：docs/relay-server/relay-v3-design.md §3.1/§9 P1。

interface RemoteControlSettingsSectionProps {
  workspacePath: string | null;
  workspaceIdentity?: string;
}

export function RemoteControlSettingsSection({
  workspacePath,
  workspaceIdentity,
}: RemoteControlSettingsSectionProps) {
  const { intl } = useZCodeIntl();
  const { supported, status, sendCode, login, logout, start, stop, cooldownRemainingMs } =
    useRelayV3RemoteControl();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const url = status?.qrUrl ?? null;
    if (!url) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(url, { width: 240, margin: 1 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch((error) => logger.warn("relay-v3 qr render failed", { error }));
    return () => {
      cancelled = true;
    };
  }, [status?.qrUrl]);

  const phaseText = useMemo(() => {
    switch (status?.phase) {
      case "idle":
        return intl.formatMessage({ id: "settings.remoteControl.phase.idle" });
      case "auth-required":
        return intl.formatMessage({ id: "settings.remoteControl.phase.authRequired" });
      case "starting":
      case "connecting":
        return intl.formatMessage({ id: "settings.remoteControl.phase.connecting" });
      case "waiting":
        return intl.formatMessage({ id: "settings.remoteControl.phase.waiting" });
      case "active":
        return intl.formatMessage({ id: "settings.remoteControl.phase.active" });
      case "error":
        return intl.formatMessage({ id: "settings.remoteControl.phase.error" });
      default:
        return intl.formatMessage({ id: "settings.remoteControl.phase.idle" });
    }
  }, [intl, status?.phase]);

  const handleSendCode = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const result = await sendCode(phone.trim());
    setBusy(false);
    if (!result.ok) {
      setNotice(result.message ?? `error ${result.businessCode ?? ""}`);
    }
  }, [phone, sendCode]);

  const handleLogin = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const result = await login(phone.trim(), code.trim());
    setBusy(false);
    if (result.ok) {
      setCode("");
    } else {
      setNotice(result.message ?? `error ${result.businessCode ?? ""}`);
    }
  }, [code, login, phone]);

  const handleLogout = useCallback(async () => {
    setBusy(true);
    await logout();
    setBusy(false);
    setPhone("");
    setCode("");
  }, [logout]);

  const handleStart = useCallback(async () => {
    if (!workspacePath) return;
    setBusy(true);
    setNotice(null);
    const result = await start({ workspacePath, workspaceIdentity });
    setBusy(false);
    if (!result.accepted && result.reason && result.reason !== "auth-required") {
      setNotice(result.reason);
    }
  }, [start, workspaceIdentity, workspacePath]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    await stop();
    setBusy(false);
  }, [stop]);

  if (!supported) {
    return (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.remoteControl.unsupported" })}
      </p>
    );
  }

  const signedIn = status?.account != null;
  const running = status?.phase === "waiting" || status?.phase === "active" || status?.phase === "connecting" || status?.phase === "starting";
  const cooldownSeconds = Math.ceil(cooldownRemainingMs / 1000);

  return (
    <div className="flex flex-col gap-5" data-testid="relay-v3-settings-section">
      <section className="flex flex-col gap-3">
        <h3 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.remoteControl.account.title" })}
        </h3>
        {signedIn ? (
          <div className="flex items-center gap-3">
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.remoteControl.account.signedInAs" },
                { phone: status?.account?.phoneMasked ?? "" },
              )}
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={handleLogout}
              data-testid="relay-v3-logout"
            >
              {intl.formatMessage({ id: "settings.remoteControl.account.logout" })}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="flex w-full flex-col gap-2 sm:w-52">
              <Input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+8613800138000"
                inputMode="tel"
                data-testid="relay-v3-phone"
                aria-label={intl.formatMessage({ id: "settings.remoteControl.account.phone" })}
              />
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="123456"
                inputMode="numeric"
                maxLength={6}
                data-testid="relay-v3-code"
                aria-label={intl.formatMessage({ id: "settings.remoteControl.account.code" })}
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={busy || phone.trim().length === 0 || cooldownRemainingMs > 0}
                onClick={handleSendCode}
                data-testid="relay-v3-send-code"
              >
                {cooldownRemainingMs > 0
                  ? intl.formatMessage(
                      { id: "settings.remoteControl.account.resendIn" },
                      { seconds: cooldownSeconds },
                    )
                  : intl.formatMessage({ id: "settings.remoteControl.account.sendCode" })}
              </Button>
              <Button
                type="button"
                disabled={busy || phone.trim().length === 0 || code.trim().length !== 6}
                onClick={handleLogin}
                data-testid="relay-v3-login"
              >
                {intl.formatMessage({ id: "settings.remoteControl.account.login" })}
              </Button>
            </div>
          </div>
        )}
        {notice ? (
          <p className="text-ui-sm text-destructive" data-testid="relay-v3-notice">
            {notice}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h3 className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.remoteControl.runtime.title" })}
          </h3>
          <span
            className="text-ui-sm text-foreground-subtle"
            data-testid="relay-v3-phase"
            data-phase={status?.phase ?? "idle"}
          >
            {phaseText}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            disabled={busy || !signedIn || running || !workspacePath}
            onClick={handleStart}
            data-testid="relay-v3-start"
          >
            {intl.formatMessage({ id: "settings.remoteControl.runtime.start" })}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || status?.phase === "idle"}
            onClick={handleStop}
            data-testid="relay-v3-stop"
          >
            {intl.formatMessage({ id: "settings.remoteControl.runtime.stop" })}
          </Button>
        </div>
        {!workspacePath ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.remoteControl.runtime.noWorkspace" })}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.remoteControl.qr.title" })}
        </h3>
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt={intl.formatMessage({ id: "settings.remoteControl.qr.alt" })}
            className="size-60 rounded-lg border border-border bg-white p-2"
            data-testid="relay-v3-qr"
          />
        ) : (
          <p className="text-ui-sm text-foreground-subtle" data-testid="relay-v3-qr-hint">
            {intl.formatMessage({ id: "settings.remoteControl.qr.hint" })}
          </p>
        )}
      </section>

      <TerminalSection />
      <DeviceAuthSection />
    </div>
  );
}

/** 设备授权批准（R4 §5.5）：输入 headless 终端显示的 user_code，批准后回显指纹。 */
function DeviceAuthSection() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [userCode, setUserCode] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof platform.relayV3DeviceAuthApprove === "function";

  if (!supported) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3" data-testid="relay-v3-device-auth">
      <h3 className="text-ui-lg font-semibold text-foreground">
        {intl.formatMessage({ id: "settings.remoteControl.deviceAuth.title" })}
      </h3>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.remoteControl.deviceAuth.hint" })}
      </p>
      <div className="flex gap-2">
        <Input
          value={userCode}
          onChange={(event) => setUserCode(event.target.value)}
          placeholder="12345678"
          inputMode="numeric"
          maxLength={8}
          data-testid="relay-v3-device-auth-code"
          aria-label={intl.formatMessage({ id: "settings.remoteControl.deviceAuth.title" })}
        />
        <Button
          type="button"
          disabled={busy || !/^\d{8}$/.test(userCode)}
          data-testid="relay-v3-device-auth-approve"
          onClick={async () => {
            setBusy(true);
            setResult(null);
            const response = await platform.relayV3DeviceAuthApprove?.(userCode);
            setBusy(false);
            if (response?.ok) {
              setResult({
                ok: true,
                text: intl.formatMessage(
                  { id: "settings.remoteControl.deviceAuth.approved" },
                  { fingerprint: response.fingerprint },
                ),
              });
              setUserCode("");
            } else {
              setResult({ ok: false, text: response?.message ?? "error" });
            }
          }}
        >
          {intl.formatMessage({ id: "settings.remoteControl.deviceAuth.approve" })}
        </Button>
      </div>
      {result ? (
        <p
          className={result.ok ? "text-ui-sm text-foreground-subtle" : "text-ui-sm text-destructive"}
          data-testid="relay-v3-device-auth-result"
        >
          {result.text}
        </p>
      ) : null}
    </section>
  );
}

/** 控制端（P4，§6）：设备切换器 + workspace 打开；选中态仅控制端本地。 */
function TerminalSection() {
  const { intl } = useZCodeIntl();
  const terminal = useRelayV3Terminal();
  const [busy, setBusy] = useState(false);

  const refreshRef = useRef(terminal.refresh);
  refreshRef.current = terminal.refresh;
  useEffect(() => {
    if (terminal.supported) {
      void refreshRef.current();
    }
  }, [terminal.supported]);

  const online = useMemo(() => terminal.devices.filter((device) => device.online), [terminal.devices]);

  if (!terminal.supported) {
    return null;
  }

  const connected = terminal.status?.phase === "active" || terminal.status?.phase === "waiting";

  return (
    <section className="flex flex-col gap-3" data-testid="relay-v3-terminal-section">
      <h3 className="text-ui-lg font-semibold text-foreground">
        {intl.formatMessage({ id: "settings.remoteControl.terminal.title" })}
      </h3>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={terminal.refreshing}
          onClick={() => void terminal.refresh()}
        >
          {intl.formatMessage({ id: "settings.remoteControl.terminal.refresh" })}
        </Button>
        {connected ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await terminal.disconnect();
              setBusy(false);
            }}
          >
            {intl.formatMessage({ id: "settings.remoteControl.terminal.disconnect" })}
          </Button>
        ) : null}
        {terminal.status?.target ? (
          <span className="text-ui-sm text-foreground-subtle" data-testid="relay-v3-terminal-target">
            {intl.formatMessage(
              { id: "settings.remoteControl.terminal.status" },
              {
                name: terminal.status.target.name ?? terminal.status.target.deviceSid,
                phase: terminal.status.phase,
              },
            )}
          </span>
        ) : null}
      </div>
      {terminal.listError ? <p className="text-ui-sm text-destructive">{terminal.listError}</p> : null}
      <div className="flex flex-col gap-2">
        {online.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.remoteControl.terminal.empty" })}
          </p>
        ) : null}
        {online.map((device) => (
          <div key={device.device_sid} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-ui-base">
              {device.meta?.name || device.device_mid}
            </span>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              data-testid={`relay-v3-terminal-connect-${device.device_sid}`}
              onClick={async () => {
                setBusy(true);
                await terminal.connect(device.device_sid);
                setBusy(false);
              }}
            >
              {intl.formatMessage({ id: "settings.remoteControl.terminal.connect" })}
            </Button>
          </div>
        ))}
      </div>
      {terminal.status?.workspaces && terminal.status.workspaces.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.remoteControl.terminal.workspaces" })}
          </p>
          {terminal.status.workspaces
            .filter((workspace) => workspace.bridgeable)
            .map((workspace) => (
              <div key={workspace.workspace_key} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-ui-base">{workspace.workspace_key}</span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await terminal.openWorkspace(workspace.workspace_key);
                    setBusy(false);
                  }}
                >
                  {intl.formatMessage({ id: "settings.remoteControl.terminal.open" })}
                </Button>
              </div>
            ))}
        </div>
      ) : null}
    </section>
  );
}
