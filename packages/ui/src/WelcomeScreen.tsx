/* oxlint-disable eslint(max-lines) */
/**
 * WelcomeScreen —— relay v3 账号登录入口。
 *
 * 应用级登录从 OAuth 替换为 relay 手机号 + 短信验证码；OAuth / API Key 登录已移除。
 * 登录状态与凭据由 main 的 RelayV3AccountService 唯一持有，本组件只经
 * useRelayV3RemoteControl（IPlatformService）读写。契约见 docs/ui/relay-login.md。
 */
import { useState, useCallback, useEffect, useRef } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert.js";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import type { useCredentialStoreRecovery } from "@/hooks/useCredentials.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { ThemeHeroVisual } from "./openWorkspacePageThemeHero.js";
import { logger } from "@/logger.js";
import { useRelayV3RemoteControl } from "./remote-relay-v3/useRelayV3RemoteControl.js";

interface WelcomeScreenProps {
  onComplete: () => void | Promise<void>;
}

/**
 * 凭据容器损坏恢复界面：从登录流程中独立出来，但继续复用 WelcomeScreen 文件
 * （packages/ui/src 根为非受管模块，新增文件会被架构门禁拒绝）。
 * 语义与所有权见 docs/ui/credential-store-recovery.md。
 */
export function CredentialStoreRecovery({
  recovery,
}: {
  recovery: ReturnType<typeof useCredentialStoreRecovery>;
}) {
  const { intl } = useZCodeIntl();
  const [confirming, setConfirming] = useState(false);
  const text = (id: Parameters<typeof intl.formatMessage>[0]["id"]) => intl.formatMessage({ id });
  return (
    <main
      data-testid="credential-store-recovery"
      className="relative flex min-h-dvh items-center justify-center bg-background p-4 text-foreground"
    >
      <DesktopOverlayWindowControls />
      <section className="w-full max-w-md space-y-4 rounded-2xl border border-popover-border bg-background p-6 text-ui-base shadow-md">
        <h1 className="text-ui-lg font-semibold">{text("login.credentialStore.title")}</h1>
        <p className="text-foreground-subtle">
          {text(
            recovery.state?.status === "recovered"
              ? "login.credentialStore.done"
              : recovery.state?.status === "changed"
                ? "login.credentialStore.changed"
                : "login.credentialStore.description",
          )}
        </p>
        {recovery.state?.status === "recovered" && (
          <p className="break-all text-ui-sm text-foreground-subtle">{recovery.state.backupPath}</p>
        )}
        {recovery.failed && (
          <Alert variant="destructive" data-testid="credential-store-recovery-error">
            <AlertDescription>{text("login.credentialStore.failed")}</AlertDescription>
          </Alert>
        )}
        {recovery.state?.status === "corrupt" ? (
          <Button
            data-testid="credential-store-recovery-open"
            disabled={recovery.busy}
            onClick={() => setConfirming(true)}
          >
            {text("login.credentialStore.restore")}
          </Button>
        ) : (
          <Button
            data-testid="credential-store-recovery-reload"
            onClick={() => window.location.reload()}
          >
            {text("login.credentialStore.reload")}
          </Button>
        )}
      </section>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!recovery.busy) setConfirming(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{text("login.credentialStore.restore")}</AlertDialogTitle>
            <AlertDialogDescription>{text("login.credentialStore.confirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="credential-store-recovery-cancel"
              disabled={recovery.busy}
            >
              {text("common.cancel")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              data-testid="credential-store-recovery-confirm"
              disabled={recovery.busy}
              onClick={async () => {
                await recovery.recover();
                setConfirming(false);
              }}
            >
              {text("login.credentialStore.restore")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

export function WelcomeScreen({ onComplete }: WelcomeScreenProps) {
  const { intl } = useZCodeIntl();
  return (
    <main className="relative h-full min-h-dvh overflow-hidden bg-background text-foreground">
      <ThemeHeroVisual className="absolute inset-0" />
      {/* 原生拖拽命中不受 pointer-events/z-index 约束；拖拽层必须避开窗控，且先于 no-drag 区声明。 */}
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 items-center [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />
      {/* 矮窗口展开表单时，绝对定位的页脚会盖住操作区；同一滚动布局保证两者可达，窗控仍在外层。 */}
      <div className="relative z-10 flex h-dvh flex-col items-center overflow-y-auto px-4 pb-6 pt-14 sm:px-6">
        <div className="flex w-full flex-1 shrink-0 items-center justify-center py-6">
          <section className="flex w-full max-w-sm shrink-0 flex-col gap-7 rounded-2xl bg-background p-8 text-ui-base/relaxed shadow-md sm:p-10">
            <RelayLoginPanel onComplete={onComplete} />
          </section>
        </div>
        <footer className="pointer-events-none flex shrink-0 flex-col items-center gap-2 text-center text-ui-xs text-foreground-subtle">
          <p>{intl.formatMessage({ id: "login.copyright" })}</p>
        </footer>
      </div>
    </main>
  );
}

function RelayLoginPanel({ onComplete }: WelcomeScreenProps) {
  const { intl } = useZCodeIntl();
  const {
    supported,
    endpointSupported,
    status,
    sendCode,
    login,
    configureEndpoint,
    cooldownRemainingMs,
  } = useRelayV3RemoteControl();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [endpointError, setEndpointError] = useState<string | null>(null);
  // 草稿绑定开始编辑时的事实值；事实变化（保存成功/其他窗口改写）后自动回显，输入期间
  // 不被状态推送覆盖。与设置节保持同一套「先保存地址」门禁语义（relay v3 设计 §3.5）。
  const relayOrigin = status?.relayOrigin ?? "";
  const [endpointEdit, setEndpointEdit] = useState<{ origin: string; text: string } | null>(null);
  const endpointDraft = endpointEdit?.origin === relayOrigin ? endpointEdit.text : relayOrigin;
  const endpointDirty = endpointDraft.trim() !== relayOrigin;
  const completionLatch = useRef(false);

  useEffect(() => {
    if (status?.account && !completionLatch.current) {
      completionLatch.current = true;
      void onComplete();
    }
  }, [onComplete, status?.account]);

  const requireSavedEndpoint = useCallback((): boolean => {
    if (!endpointDirty) return true;
    setNotice(intl.formatMessage({ id: "settings.remoteControl.server.saveFirst" }));
    return false;
  }, [endpointDirty, intl]);

  const handleSaveEndpoint = useCallback(async () => {
    setBusy(true);
    setEndpointError(null);
    try {
      const result = await configureEndpoint(endpointDraft);
      if (result.ok) {
        setEndpointEdit(null);
      } else {
        setEndpointError(
          intl.formatMessage({
            id:
              result.reason === "invalid-origin"
                ? "settings.remoteControl.server.invalid"
                : "settings.remoteControl.server.saveFailed",
          }),
        );
      }
    } catch (error) {
      logger.warn("relay-v3 login endpoint save failed", { error });
      setEndpointError(intl.formatMessage({ id: "settings.remoteControl.server.saveFailed" }));
    } finally {
      setBusy(false);
    }
  }, [configureEndpoint, endpointDraft, intl]);

  const handleSendCode = useCallback(async () => {
    if (!requireSavedEndpoint()) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await sendCode(phone.trim());
      if (!result.ok) {
        setNotice(result.message ?? `error ${result.businessCode ?? ""}`);
      }
    } finally {
      setBusy(false);
    }
  }, [phone, requireSavedEndpoint, sendCode]);

  const handleLogin = useCallback(async () => {
    if (!requireSavedEndpoint()) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await login(phone.trim(), code.trim());
      if (result.ok) {
        setCode("");
      } else {
        setNotice(result.message ?? `error ${result.businessCode ?? ""}`);
      }
    } finally {
      setBusy(false);
    }
  }, [code, login, phone, requireSavedEndpoint]);

  const cooldownSeconds = Math.ceil(cooldownRemainingMs / 1000);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col items-center gap-4 text-center">
        <div
          className="relative flex size-16 items-center justify-center rounded-2xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] shadow-lg/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-2xl before:border before:border-[rgba(255,255,255,0.1)]"
          aria-label="ZCode"
          role="img"
        >
          <ZCodeAboutLogo className="h-auto w-10" />
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-ui-xl font-semibold tracking-tight">
            {intl.formatMessage({ id: "login.relay.title" })}
          </h1>
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "login.relay.description" })}
          </p>
        </div>
      </header>

      {!supported ? (
        <p className="text-ui-sm text-destructive" data-testid="relay-v3-login-unsupported">
          {intl.formatMessage({ id: "settings.remoteControl.unsupported" })}
        </p>
      ) : null}

      {endpointSupported ? (
        <div className="flex flex-col gap-2">
          <label className="text-ui-sm text-foreground-subtle" htmlFor="relay-login-endpoint">
            {intl.formatMessage({ id: "settings.remoteControl.server.address" })}
          </label>
          <Input
            id="relay-login-endpoint"
            size="lg"
            value={endpointDraft}
            placeholder="https://relay.example.com"
            inputMode="url"
            spellCheck={false}
            aria-invalid={endpointError ? true : undefined}
            disabled={busy}
            data-testid="relay-v3-endpoint-input"
            onChange={(event) => {
              setEndpointEdit({ origin: relayOrigin, text: event.currentTarget.value });
              setEndpointError(null);
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                endpointDirty &&
                !busy
              ) {
                void handleSaveEndpoint();
              }
            }}
            className="font-mono"
          />
          <Button
            type="button"
            variant="secondary"
            size="lg"
            disabled={busy || !endpointDirty}
            onClick={() => void handleSaveEndpoint()}
            data-testid="relay-v3-endpoint-save"
          >
            {intl.formatMessage({ id: "common.save" })}
          </Button>
          {endpointError ? (
            <p className="text-ui-sm text-destructive" data-testid="relay-v3-endpoint-error">
              {endpointError}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
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
        <Button
          type="button"
          size="lg"
          variant="secondary"
          disabled={busy || !supported || phone.trim().length === 0 || cooldownRemainingMs > 0}
          onClick={() => void handleSendCode()}
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
          size="lg"
          disabled={busy || !supported || phone.trim().length === 0 || code.trim().length !== 6}
          onClick={() => void handleLogin()}
          data-testid="relay-v3-login"
        >
          {intl.formatMessage({ id: "settings.remoteControl.account.login" })}
        </Button>
        {notice ? (
          <p className="text-ui-sm text-destructive" data-testid="relay-v3-notice">
            {notice}
          </p>
        ) : null}
      </div>
    </div>
  );
}
