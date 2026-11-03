import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChannelClient, MessagePortProtocol } from "@zcode/rpc";
import type { RelayV3Device } from "@zcode/shared/remote-relay-v3";

import { WebRelayAccount, parseEntryParams } from "./relay/relayAccount.js";
import { createDeviceCatalog } from "./relay/deviceCatalog.js";
import { RelayV3TerminalTransport } from "./relay/terminalTransport.js";
import { RelayV3WebConnection } from "./relay/connection.js";
import { randomUUID } from "./uuid.js";
import { detectWebLocale, formatWebString, type WebLocale } from "./i18n.js";

// /remote/v4 应用（P2）：登录 → 设备列表（最近设备落点）→ 连接（bootstrap →
// workspace → bridge）→ 会话页（ChannelClient over E2E rpc-frame）。
// 状态机 owner 是本组件；transport/connection 各自持有 socket/generation/bridge 生命周期。

type Stage = "entry" | "login" | "devices" | "connecting" | "chat";

export function RemoteApp() {
  const locale = useMemo(detectWebLocale, []);
  const t = useCallback(
    (key: Parameters<typeof formatWebString>[1], params?: Record<string, string | number>) =>
      formatWebString(locale, key, params),
    [locale],
  );
  const [stage, setStage] = useState<Stage>("entry");
  const [entryParams] = useState(() => parseEntryParams(location.search));
  const [relayOriginInput, setRelayOriginInput] = useState("");
  const [relayOrigin, setRelayOrigin] = useState<string | null>(null);
  const [devices, setDevices] = useState<RelayV3Device[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [target, setTarget] = useState<RelayV3Device | null>(null);
  const [connectStage, setConnectStage] = useState<string>("");
  const [chatReady, setChatReady] = useState(false);
  const [streamLog, setStreamLog] = useState<string[]>([]);
  const accountRef = useRef<WebRelayAccount | null>(null);
  const sessionRef = useRef<{
    transport: RelayV3TerminalTransport;
    connection: RelayV3WebConnection;
    client: ChannelClient;
    protocol: MessagePortProtocol;
  } | null>(null);

  // relay origin 解析：同源（relay 托管本页，§5.4）优先，URL ?relay= 覆盖，记忆回退。
  useEffect(() => {
    const url = new URL(window.location.href);
    const override = url.searchParams.get("relay");
    const sameOrigin = `${url.protocol}//${url.host}`;
    const remembered = WebRelayAccount.readRelayOrigin(localStorage);
    const resolved = override ?? (isLikelyRelayOrigin(sameOrigin) ? sameOrigin : remembered) ?? null;
    setRelayOrigin(resolved);
    if (override) setRelayOriginInput(override);
    else if (resolved) setRelayOriginInput(resolved);
  }, []);

  // 会话初始化：恢复登录态后决定落点（回调经 ref 解耦，避免时序依赖链）。
  const startDirectConnectRef = useRef<(sid: string) => void>(() => {});
  const refreshDevicesRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!relayOrigin || accountRef.current) return;
    const account = new WebRelayAccount(
      () => relayOrigin,
      typeof localStorage !== "undefined" ? localStorage : undefined,
    );
    accountRef.current = account;
    void account.restore().then((restored) => {
      if (restored) {
        if (entryParams.sid) {
          startDirectConnectRef.current(entryParams.sid);
        } else {
          setStage("devices");
          refreshDevicesRef.current();
        }
      } else {
        setStage("login");
      }
    });
  }, [relayOrigin, entryParams.sid]);

  const catalog = useMemo(
    () =>
      createDeviceCatalog({
        resolveOrigin: () => relayOrigin,
        acquireAccessToken: async () => accountRef.current?.getAccessToken() ?? null,
      }),
    [relayOrigin],
  );

  const refreshDevices = useCallback(async () => {
    setRefreshing(true);
    setDevicesError(null);
    try {
      const list = await catalog.listDevices();
      setDevices(list);
    } catch {
      setDevicesError(t("devices.loadFailed"));
    } finally {
      setRefreshing(false);
    }
  }, [catalog, t]);
  refreshDevicesRef.current = () => void refreshDevices();

  const startDirectConnect = useCallback(
    async (sid: string) => {
      setStage("connecting");
      setConnectStage(t("connect.connecting"));
      try {
        const list = await catalog.listDevices();
        const device = list.find((item) => item.device_sid === sid && item.online);
        if (!device) {
          setStage("devices");
          setDevices(list);
          return;
        }
        beginConnectRef.current(device);
      } catch {
        setStage("devices");
        setDevicesError(t("devices.loadFailed"));
      }
    },
    [catalog, t],
  );
  startDirectConnectRef.current = (sid: string) => void startDirectConnect(sid);

  // 最近设备自动连接：仅在本次无码入口的设备列表首次成功时尝试一次（V2 06）。
  const autoConnectAttemptedRef = useRef(false);
  useEffect(() => {
    if (stage !== "devices" || entryParams.sid || autoConnectAttemptedRef.current) return;
    if (!devices || devices.length === 0) return;
    autoConnectAttemptedRef.current = true;
    const landing = catalog.resolveRecentLanding(devices);
    if (landing) {
      catalog.rememberDevice(landing.device_sid, landing.device_mid);
      beginConnectRef.current(landing);
    }
  }, [stage, devices, entryParams.sid, catalog]);

  const appendLog = useCallback((line: string) => {
    setStreamLog((previous) => [...previous.slice(-200), line]);
  }, []);

  const connectionRef = useRef<RelayV3WebConnection | null>(null);

  const beginConnect = useCallback(
    (device: RelayV3Device) => {
      setTarget(device);
      setStage("connecting");
      setConnectStage(t("connect.connecting"));
      setStreamLog([]);
      const account = accountRef.current;
      if (!account || !relayOrigin) {
        setStage("login");
        return;
      }
      const transport = new RelayV3TerminalTransport({
        resolveOrigin: () => relayOrigin,
        acquireAccessToken: () => account.getAccessToken(),
        deviceSid: device.device_sid,
        devicePublicKeyB64: device.public_key,
        onState: (state) => {
          if (state.phase === "matched") {
            setConnectStage(t("connect.bootstrap"));
            void runBootstrap();
          } else if (state.phase === "waiting") {
            setConnectStage(t("status.waiting"));
          } else if (state.phase === "failed") {
            setConnectStage(`${t("connect.failed")}${state.failure?.message ? `：${state.failure.message}` : ""}`);
          }
        },
        onAppPayload: (payload) => connectionRef.current?.handlePayload(payload),
        log: (message) => appendLog(message),
      });
      const connection = new RelayV3WebConnection(transport);
      connectionRef.current = connection;
      transport.start();

      async function runBootstrap(): Promise<void> {
        try {
          const bootstrap = await connection.bootstrap(`web_${randomUUID()}`);
          const bridgeable = bootstrap.workspaces.filter((workspace) => workspace.bridgeable);
          const workspace = bridgeable[0] ?? bootstrap.workspaces[0];
          if (!workspace) {
            appendLog("no workspaces available");
            return;
          }
          setConnectStage(t("chat.bridgePending"));
          const bridge = await connection.openWorkspaceBridge(workspace.workspace_key);
          const protocol = new MessagePortProtocol(bridge.port);
          const client = new ChannelClient(protocol);
          sessionRef.current = { transport, connection, client, protocol };
          catalog.rememberDevice(device.device_sid, device.device_mid);
          appendLog(`bridge ready: ${workspace.workspace_key} (gen ${bridge.bridgeGeneration})`);
          setChatReady(true);
          setStage("chat");
        } catch (error) {
          appendLog(`bootstrap/bridge failed: ${error instanceof Error ? error.message : String(error)}`);
          setConnectStage(t("connect.failed"));
        }
      }
    },
    [relayOrigin, t, appendLog, catalog],
  );
  const beginConnectRef = useRef(beginConnect);
  beginConnectRef.current = beginConnect;

  const disconnect = useCallback(() => {
    sessionRef.current?.protocol.disconnect();
    sessionRef.current = null;
    connectionRef.current?.dispose();
    connectionRef.current = null;
    setChatReady(false);
  }, []);

  useEffect(() => {
    return () => {
      sessionRef.current?.protocol.disconnect();
      connectionRef.current?.dispose();
    };
  }, []);

  if (stage === "entry") {
    return (
      <div className="app-shell">
        <div className="connect-stage">
          <div className="spinner" />
        </div>
      </div>
    );
  }

  if (stage === "login") {
    return (
      <LoginPage
        t={t}
        account={accountRef.current}
        relayOriginInput={relayOriginInput}
        onRelayOriginChange={(value) => {
          setRelayOriginInput(value);
          const trimmed = value.trim().replace(/\/$/, "");
          if (/^https?:\/\/[^\s/]+$/.test(trimmed)) {
            accountRef.current?.rememberRelayOrigin(trimmed);
            setRelayOrigin(trimmed);
          }
        }}
        onLoggedIn={() => {
          if (entryParams.sid) {
            void startDirectConnect(entryParams.sid);
          } else {
            setStage("devices");
            void refreshDevices();
          }
        }}
      />
    );
  }

  if (stage === "devices") {
    return (
      <DeviceListPage
        t={t}
        devices={devices}
        error={devicesError}
        refreshing={refreshing}
        onRefresh={() => void refreshDevices()}
        onSelect={(device) => {
          catalog.rememberDevice(device.device_sid, device.device_mid);
          beginConnect(device);
        }}
        onLogout={async () => {
          await accountRef.current?.logout();
          setStage("login");
        }}
        account={accountRef.current?.getSession() ?? null}
      />
    );
  }

  if (stage === "connecting") {
    return (
      <div className="app-shell">
        <div className="app-header">
          <div className="app-title">
            <span className="logo-dot">Z</span>
            {t("app.title")}
          </div>
        </div>
        <div className="card">
          <div className="connect-stage">
            <div className="spinner" />
            <div className="section-title">
              {t("connect.connecting")}
              {target?.meta?.name ? ` ${target.meta.name}` : ""}
            </div>
            <div className="hint-text">{connectStage}</div>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                disconnect();
                setStage("devices");
                void refreshDevices();
              }}
            >
              {t("connect.backToList")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ChatPage
      t={t}
      chatReady={chatReady}
      streamLog={streamLog}
      session={sessionRef.current}
      onBack={() => {
        disconnect();
        setStage("devices");
        void refreshDevices();
      }}
      onLog={appendLog}
    />
  );
}

// -----------------------------------------------------------------------------

function LoginPage({
  t,
  account,
  relayOriginInput,
  onRelayOriginChange,
  onLoggedIn,
}: {
  t: (key: Parameters<typeof formatWebString>[1], params?: Record<string, string | number>) => string;
  account: WebRelayAccount | null;
  relayOriginInput: string;
  onRelayOriginChange: (value: string) => void;
  onLoggedIn: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1_000);
    return () => clearInterval(timer);
  }, [cooldown]);

  return (
    <div className="app-shell">
      <div className="app-header">
        <div className="app-title">
          <span className="logo-dot">Z</span>
          {t("app.title")}
        </div>
      </div>
      <h1 className="section-title">{t("login.title")}</h1>
      <p className="section-subtitle">{t("login.description")}</p>
      <div className="form">
        <input
          className="input"
          value={relayOriginInput}
          onChange={(event) => onRelayOriginChange(event.target.value)}
          placeholder={t("login.relayOrigin")}
          aria-label={t("login.relayOrigin")}
        />
        <input
          className="input"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="+8613800138000"
          inputMode="tel"
          aria-label={t("login.phone")}
        />
        <input
          className="input"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="123456"
          inputMode="numeric"
          maxLength={6}
          aria-label={t("login.code")}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="button button-secondary"
            style={{ flex: 1 }}
            disabled={busy || phone.trim().length === 0 || cooldown > 0}
            onClick={async () => {
              setBusy(true);
              setNotice(null);
              const result = await account?.sendSmsCode(phone.trim());
              setBusy(false);
              if (result?.ok) setCooldown(60);
              else setNotice(result?.message ?? "error");
            }}
          >
            {cooldown > 0 ? t("login.resendIn", { seconds: cooldown }) : t("login.sendCode")}
          </button>
          <button
            type="button"
            className="button"
            style={{ flex: 1 }}
            disabled={busy || phone.trim().length === 0 || code.trim().length !== 6}
            onClick={async () => {
              setBusy(true);
              setNotice(null);
              const result = await account?.loginWithCode(phone.trim(), code.trim());
              setBusy(false);
              if (result?.ok) onLoggedIn();
              else setNotice(result?.message ?? "error");
            }}
          >
            {t("login.submit")}
          </button>
        </div>
        {notice ? <p className="error-text">{notice}</p> : null}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

function DeviceListPage({
  t,
  devices,
  error,
  refreshing,
  onRefresh,
  onSelect,
  onLogout,
  account,
}: {
  t: (key: Parameters<typeof formatWebString>[1], params?: Record<string, string | number>) => string;
  devices: RelayV3Device[] | null;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onSelect: (device: RelayV3Device) => void;
  onLogout: () => void;
  account: { account: { phone_masked: string } } | null;
}) {
  const online = (devices ?? []).filter((device) => device.online);
  const offline = (devices ?? []).filter((device) => !device.online);
  const grouped = useMemo(() => groupByMid(offline), [offline]);

  return (
    <div className="app-shell">
      <div className="app-header">
        <div className="app-title">
          <span className="logo-dot">Z</span>
          {t("app.title")}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {account ? <span className="status-pill">{account.account.phone_masked}</span> : null}
          <button type="button" className="button-ghost" onClick={onLogout}>
            {t("common.logout")}
          </button>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 className="section-title">{t("devices.title")}</h1>
        <button
          type="button"
          className="button button-secondary"
          disabled={refreshing}
          onClick={onRefresh}
        >
          {refreshing ? "…" : t("devices.refresh")}
        </button>
      </div>
      {error ? <p className="error-text" style={{ padding: "0 4px" }}>{error}</p> : null}
      {!devices && !error ? (
        <div className="connect-stage">
          <div className="spinner" />
        </div>
      ) : null}
      {devices && devices.length === 0 ? (
        <div className="card" style={{ padding: 24 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{t("devices.empty")}</div>
            <p className="hint-text">{t("devices.emptyHint")}</p>
          </div>
        </div>
      ) : null}
      {online.length > 0 ? (
        <>
          <div className="row-group-title">
            {t("devices.online")} {online.length}
          </div>
          <div className="card">
            {online.map((device) => (
              <button
                type="button"
                className="row-button"
                key={device.device_sid}
                onClick={() => onSelect(device)}
              >
                <div className="row">
                  <span className="device-icon">
                    💻<span className="online-dot" />
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="device-name">{device.meta?.name || t("devices.unnamed")}</span>
                    <br />
                    <span className="device-meta">
                      {device.meta?.platform ? `${device.meta.platform} · ` : ""}
                      {device.meta?.version ? `ZCode ${device.meta.version}` : "ZCode"}
                    </span>
                  </span>
                  <span aria-hidden>›</span>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : null}
      {grouped.length > 0 ? (
        <>
          <div className="row-group-title">
            {t("devices.offline")} {grouped.length}
          </div>
          <div className="card">
            {grouped.map((device) => (
              <div className="row" key={device.device_sid} style={{ opacity: 0.6 }}>
                <span className="device-icon">💻</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="device-name">{device.meta?.name || t("devices.unnamed")}</span>
                  <br />
                  <span className="device-meta">{t("devices.offline")}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------

function ChatPage({
  t,
  chatReady,
  streamLog,
  session,
  onBack,
  onLog,
}: {
  t: (key: Parameters<typeof formatWebString>[1], params?: Record<string, string | number>) => string;
  chatReady: boolean;
  streamLog: string[];
  session: { client: ChannelClient } | null;
  onBack: () => void;
  onLog: (line: string) => void;
}) {
  const [sessionId, setSessionId] = useState("");
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [streamLog]);

  return (
    <div className="app-shell" style={{ display: "flex", flexDirection: "column" }}>
      <div className="app-header">
        <div className="app-title">
          <span className="logo-dot">Z</span>
          {t("app.title")}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="status-pill">
            {chatReady ? t("chat.bridge") : t("chat.bridgePending")}
          </span>
          <button type="button" className="button-ghost" onClick={onBack}>
            {t("connect.backToList")}
          </button>
        </div>
      </div>
      <div className="chat-layout">
        <div className="form" style={{ flexDirection: "row" }}>
          <input
            className="input"
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            placeholder="session id (v4/conversation/subscribe)"
          />
          <button
            type="button"
            className="button"
            disabled={!session || sessionId.trim().length === 0}
            onClick={() => {
              if (!session) return;
              onLog(`subscribe → ${sessionId.trim()}`);
              // v4 replayable 订阅：经 zcode-agent 服务通道（ServiceChannels.ZCodeAgent）。
              // ACK 与后续帧经 E2E rpc-frame 流回。
              const agentChannel = session.client.getChannel("zcode-agent");
              void agentChannel
                .call("subscribeConversationV4", { topic: `conversation:${sessionId.trim()}` })
                .then(
                  (ack) => onLog(`subscribe ack: ${safeJson(ack)}`),
                  (error: unknown) => onLog(`subscribe error: ${String(error)}`),
                );
            }}
          >
            {t("chat.workspaces")}
          </button>
        </div>
        <div className="stream-log" ref={logRef}>
          {streamLog.join("\n")}
        </div>
        <div className="composer">
          <input
            className="input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("chat.sendPlaceholder")}
          />
          <button
            type="button"
            className="button"
            onClick={() => {
              if (!draft.trim()) return;
              onLog(`(draft) ${draft.trim()}`);
              setDraft("");
            }}
          >
            {t("chat.send")}
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

function groupByMid(devices: RelayV3Device[]): RelayV3Device[] {
  return devices;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 400);
  } catch {
    return String(value);
  }
}

function isLikelyRelayOrigin(origin: string): boolean {
  // relay 托管页（§5.4）即同源；开发服务器（vite 端口）不是 relay origin。
  return !origin.includes("localhost:5") && !origin.includes("localhost:4");
}
