import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAppConfigDir } from "@zcode/services/node";
import {
  RelayV3BusinessError,
  RelayV3ConnectionError,
  RelayV3HttpClient,
  type RelayV3Account,
  type RelayV3HttpOperation,
  type RelayV3HttpRequest,
  type RelayV3ResponseData,
} from "@zcode/shared/remote-relay-v3";

// Relay V3 账号服务（P1，设计 §3）：手机号+短信验证码登录、refresh 旋转、登出。
// 凭据（access/refresh）只保存在 main 内存与本地用户数据目录文件
//（~/.zcode/v2/relay-v3-account.json，原子写），不进 AppSettings、不写日志。
// refresh 重放撤销整个家族是 relay 侧语义（§3.3）；本服务在 refresh 失败
//（含家族撤销）时清空本地会话并报 auth-required 语义给上层。

interface StoredSession {
  refresh: string;
  account: RelayV3Account;
}

interface SessionState {
  access: string;
  accessExpiresAtMs: number;
  refresh: string;
  account: RelayV3Account;
}

export type RelayV3AccountEvent = "signed-in" | "signed-out";

export interface RelayV3AccountServiceOptions {
  configDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onSessionChange?: (event: RelayV3AccountEvent, account: RelayV3Account | null) => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const ACCESS_EXPIRY_MARGIN_MS = 60_000;

export class RelayV3AccountService {
  private readonly now: () => number;
  private session: SessionState | null = null;
  /** refresh 进行中的单飞 promise：并发 caller 复用同一次旋转。 */
  private refreshFlight: Promise<SessionState | null> | null = null;

  constructor(
    private readonly options: {
      resolveBaseUrl: () => string | null;
      accountOptions?: RelayV3AccountServiceOptions;
    },
  ) {
    this.now = options.accountOptions?.now ?? (() => Date.now());
  }

  /** 供 transport/注册使用：当前有效 access token（必要时旋转）。 */
  async getAccessToken(): Promise<string | null> {
    const session = await this.ensureSession();
    return session?.access ?? null;
  }

  getSession(): { phoneMasked: string } | null {
    return this.session ? { phoneMasked: this.session.account.phone_masked } : null;
  }

  isSignedIn(): boolean {
    return this.session !== null;
  }

  /** 启动时从本地文件恢复会话（refresh 旋转验证有效性）。 */
  async restoreFromDisk(): Promise<void> {
    if (this.session) return;
    const stored = this.readStoredSession();
    if (!stored) return;
    try {
      this.session = await this.rotate(stored.refresh);
    } catch (error) {
      // 本地 refresh 已失效（过期/家族撤销）：清理落盘凭据，等待重新登录。
      this.options.accountOptions?.log?.("relay-v3 account restore failed", { error: error instanceof Error ? error.name : "unknown" });
      this.clearStoredSession();
    }
  }

  async sendSmsCode(phone: string): Promise<{ ok: true } | { ok: false; businessCode?: number; message?: string }> {
    try {
      await this.request("smsCode", { phone });
      return { ok: true };
    } catch (error) {
      return toActionError(error);
    }
  }

  async loginWithCode(phone: string, code: string): Promise<{ ok: true } | { ok: false; businessCode?: number; message?: string }> {
    try {
      const data = await this.request("login", { phone, code });
      this.establishSession(data.access, data.refresh, data.account);
      return { ok: true };
    } catch (error) {
      return toActionError(error);
    }
  }

  async logout(): Promise<{ ok: true } | { ok: false; businessCode?: number; message?: string }> {
    const session = this.session;
    this.session = null;
    this.clearStoredSession();
    if (session) {
      try {
        await this.request("logout", undefined, session.access);
      } catch {
        // 登出尽力而为：家族撤销失败不阻塞本地清理（token 已丢弃）。
      }
    }
    this.options.accountOptions?.onSessionChange?.("signed-out", null);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private async ensureSession(): Promise<SessionState | null> {
    if (!this.session) return null;
    if (this.now() >= this.session.accessExpiresAtMs - ACCESS_EXPIRY_MARGIN_MS) {
      return this.refreshFlight ??= this.rotateWithRecovery(this.session.refresh);
    }
    return this.session;
  }

  private async rotateWithRecovery(refresh: string): Promise<SessionState | null> {
    try {
      const next = await this.rotate(refresh);
      this.session = next;
      return next;
    } catch (error) {
      this.session = null;
      this.clearStoredSession();
      this.options.accountOptions?.onSessionChange?.("signed-out", null);
      this.options.accountOptions?.log?.("relay-v3 refresh rejected; session cleared", {
        error: error instanceof Error ? error.name : "unknown",
      });
      return null;
    } finally {
      this.refreshFlight = null;
    }
  }

  private async rotate(refresh: string): Promise<SessionState> {
    const data = await this.request("refresh", { refresh });
    return {
      access: data.access,
      refresh: data.refresh,
      accessExpiresAtMs: this.accessExpiryMs(data.access),
      account: this.session?.account ?? this.readStoredSession()?.account ?? { id: "", phone_masked: "" },
    };
  }

  private establishSession(access: string, refresh: string, account: RelayV3Account): void {
    this.session = {
      access,
      refresh,
      account,
      accessExpiresAtMs: this.accessExpiryMs(access),
    };
    this.writeStoredSession({ refresh, account });
    this.options.accountOptions?.onSessionChange?.("signed-in", account);
  }

  /** JWT claims 仅 sub/exp/iat/jti（§3.3）；只读 exp，不校验签名（relay 校验）。 */
  private accessExpiryMs(access: string): number {
    try {
      const payload = access.split(".")[1];
      if (!payload) return this.now();
      const decoded = JSON.parse(decodeBase64UrlJson(payload)) as { exp?: unknown };
      return typeof decoded.exp === "number" ? decoded.exp * 1_000 : this.now();
    } catch {
      return this.now();
    }
  }

  private request<K extends RelayV3HttpOperation>(
    operation: K,
    body?: RelayV3HttpRequest<K>,
    bearer?: string,
  ): Promise<RelayV3ResponseData<K>> {
    const baseUrl = this.options.resolveBaseUrl();
    if (!baseUrl) {
      return Promise.reject(new RelayV3ConnectionError("relay-unavailable", false));
    }
    const client = new RelayV3HttpClient({
      baseUrl,
      fetch: this.options.accountOptions?.fetchImpl,
    });
    return client.request(operation, bearer ? { bearer } : {}, body);
  }

  private storedSessionPath(): string {
    return join(this.options.accountOptions?.configDir ?? getAppConfigDir(), "relay-v3-account.json");
  }

  private readStoredSession(): StoredSession | null {
    try {
      const parsed = JSON.parse(readFileSync(this.storedSessionPath(), "utf-8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (typeof record.refresh !== "string" || typeof record.account !== "object" || record.account === null) {
        return null;
      }
      const account = record.account as Record<string, unknown>;
      if (typeof account.id !== "string" || typeof account.phone_masked !== "string") return null;
      return { refresh: record.refresh, account: { id: account.id, phone_masked: account.phone_masked } };
    } catch {
      return null;
    }
  }

  private writeStoredSession(session: StoredSession): void {
    const file = this.storedSessionPath();
    mkdirSync(dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.tmp`;
    writeFileSync(tempFile, JSON.stringify(session), "utf-8");
    renameSync(tempFile, file);
  }

  private clearStoredSession(): void {
    try {
      writeFileSync(this.storedSessionPath(), "", "utf-8");
    } catch {
      // 清理失败不阻塞登出语义。
    }
  }
}

function decodeBase64UrlJson(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function toActionError(error: unknown): { ok: false; businessCode?: number; message?: string } {
  if (error instanceof RelayV3BusinessError) {
    return { ok: false, businessCode: error.code, message: error.msg };
  }
  if (error instanceof RelayV3ConnectionError) {
    return { ok: false, message: error.reason };
  }
  return { ok: false, message: error instanceof Error ? error.message : "unknown" };
}
