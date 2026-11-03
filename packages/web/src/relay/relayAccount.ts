import {
  parseRelayV3QrUrl,
  RelayV3BusinessError,
  RelayV3ConnectionError,
  RelayV3HttpClient,
  type RelayV3Account,
  type RelayV3HttpOperation,
  type RelayV3HttpRequest,
  type RelayV3ResponseData,
} from "@zcode/shared/remote-relay-v3";

// /remote/v4 的 relay 账号（P2，§3）：手机号+验证码登录，refresh 旋转。
// access 保存在页面内存；refresh 与账号摘要存同源 localStorage（V2 凭据仓储语义）。
// 无 OAuth 回跳/nonce（§5.3：登录即本站请求）。token 不写日志。

const STORAGE_KEY = "zcode-relay-v3-session";
const RELAY_ORIGIN_STORAGE_KEY = "zcode-relay-v3-origin";

interface StoredSession {
  refresh: string;
  account: RelayV3Account;
}

export interface WebRelaySession {
  account: RelayV3Account;
}

export class WebRelayAccount {
  private access: string | null = null;
  private accessExpiresAtMs = 0;
  private refresh: string | null = null;
  private account: RelayV3Account | null = null;
  private refreshFlight: Promise<boolean> | null = null;

  constructor(
    private readonly resolveOrigin: () => string | null,
    private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = typeof localStorage !==
      "undefined"
      ? localStorage
      : {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        },
  ) {}

  static readRelayOrigin(storage: Pick<Storage, "getItem" | "setItem">): string | null {
    return storage.getItem(RELAY_ORIGIN_STORAGE_KEY);
  }

  rememberRelayOrigin(origin: string): void {
    this.storage.setItem(RELAY_ORIGIN_STORAGE_KEY, origin);
  }

  getSession(): WebRelaySession | null {
    return this.account ? { account: this.account } : null;
  }

  isSignedIn(): boolean {
    return this.account !== null;
  }

  /** 启动时从同源 storage 恢复（refresh 旋转验证）。 */
  async restore(): Promise<boolean> {
    if (this.account) return true;
    const stored = this.readStored();
    if (!stored) return false;
    try {
      return await this.rotate(stored.refresh, stored.account);
    } catch {
      this.clearStored();
      return false;
    }
  }

  async sendSmsCode(phone: string): Promise<{ ok: true } | { ok: false; businessCode?: number; message?: string }> {
    try {
      await this.request("smsCode", { phone });
      return { ok: true };
    } catch (error) {
      return toError(error);
    }
  }

  async loginWithCode(phone: string, code: string): Promise<{ ok: true } | { ok: false; businessCode?: number; message?: string }> {
    try {
      const data = await this.request("login", { phone, code });
      this.establish(data.access, data.refresh, data.account);
      return { ok: true };
    } catch (error) {
      return toError(error);
    }
  }

  async logout(): Promise<void> {
    const access = this.access;
    this.access = null;
    this.refresh = null;
    this.account = null;
    this.clearStored();
    if (access) {
      try {
        await this.request("logout", undefined, access);
      } catch {
        // 尽力而为（V2 语义）。
      }
    }
  }

  /** 有效 access；必要时旋转（重放撤销家族 → 清会话回登录）。 */
  async getAccessToken(): Promise<string | null> {
    if (!this.refresh) return null;
    if (this.access && Date.now() < this.accessExpiresAtMs - 60_000) return this.access;
    this.refreshFlight ??= this.rotate(this.refresh, this.account).finally(() => {
      this.refreshFlight = null;
    });
    const ok = await this.refreshFlight;
    return ok ? this.access : null;
  }

  private establish(access: string, refresh: string, account: RelayV3Account): void {
    this.access = access;
    this.accessExpiresAtMs = accessExpiryMs(access);
    this.refresh = refresh;
    this.account = account;
    this.storage.setItem(STORAGE_KEY, JSON.stringify({ refresh, account } satisfies StoredSession));
  }

  private async rotate(refresh: string, account: RelayV3Account | null): Promise<boolean> {
    try {
      const data = await this.request("refresh", { refresh });
      this.access = data.access;
      this.accessExpiresAtMs = accessExpiryMs(data.access);
      this.refresh = data.refresh;
      if (account) this.account = account;
      if (this.account) {
        this.storage.setItem(STORAGE_KEY, JSON.stringify({ refresh: data.refresh, account: this.account }));
      }
      return true;
    } catch {
      this.access = null;
      this.refresh = null;
      this.account = null;
      this.clearStored();
      return false;
    }
  }

  private readStored(): StoredSession | null {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredSession;
      if (typeof parsed?.refresh !== "string" || typeof parsed?.account?.id !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private clearStored(): void {
    this.storage.removeItem(STORAGE_KEY);
  }

  private request<K extends RelayV3HttpOperation>(
    operation: K,
    body?: RelayV3HttpRequest<K>,
    bearer?: string,
  ): Promise<RelayV3ResponseData<K>> {
    const origin = this.resolveOrigin();
    if (!origin) return Promise.reject(new RelayV3ConnectionError("relay-unavailable", false));
    const client = new RelayV3HttpClient({ baseUrl: origin });
    return client.request(operation, bearer ? { bearer } : {}, body);
  }
}

function accessExpiryMs(access: string): number {
  try {
    const payload = access.split(".")[1];
    if (!payload) return Date.now();
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized)) as { exp?: unknown };
    return typeof decoded.exp === "number" ? decoded.exp * 1_000 : Date.now();
  } catch {
    return Date.now();
  }
}

function toError(error: unknown): { ok: false; businessCode?: number; message?: string } {
  if (error instanceof RelayV3BusinessError) {
    return { ok: false, businessCode: error.code, message: error.msg };
  }
  if (error instanceof RelayV3ConnectionError) {
    return { ok: false, message: error.reason };
  }
  return { ok: false, message: error instanceof Error ? error.message : "unknown" };
}

/** 二维码/链接参数解析（§5.3）：仅放行 sid/mid/name/app_version。 */
export function parseEntryParams(search: string): {
  sid?: string;
  mid?: string;
  name?: string;
  appVersion?: string;
} {
  if (typeof window !== "undefined" && window.location) {
    const parsed = parseRelayV3QrUrl(window.location.origin + window.location.pathname + search);
    if (parsed) {
      return {
        sid: parsed.sid,
        mid: parsed.mid,
        name: parsed.name,
        appVersion: parsed.app_version,
      };
    }
  }
  return {};
}
