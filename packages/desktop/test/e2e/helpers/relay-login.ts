/**
 * Relay v3 应用级登录的 E2E seam。
 *
 * 约束：E2E helper 运行在 WDIO/worker 进程，renderer 侧只能经 IPlatformService IPC 访问
 * main 的 RelayV3DeviceManager；helper 无法直接拿到 main 的账号服务实例。因此“冷启动前
 * 已登录”必须由 wdio.conf.ts 在 beforeSession 的隔离 HOME 里完成：启动 fake-relay-v3，
 * 用它签发的 refresh 预置 ~/.zcode/v2/relay-v3-account.json，并把它的 httpUrl 写进
 * setting.json 的 relayV3.endpointOrigin。main 启动时 restoreOnLaunch() 会旋转这枚
 * refresh，随后广播 restored=true + account，Renderer 的欢迎页门禁自然放行。
 *
 * 本文件同时保留 UI 驱动的兜底：若某个 worker 没有走冷启动播种（例如登录专项），
 * ensureRelayLoggedIn() 会用 WelcomeScreen 的 relay-v3-* test id 走真实的“填地址 →
 * 发短信 → 填验证码 → 登录”链路；验证码从同一个 fake relay 的测试接缝读取。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TID_LOGIN_TRIGGER } from "@zcode/shared/test-ids";
import { createFakeRelayV3, type FakeRelayV3 } from "@zcode/shared/testing/fake-relay-v3";
import {
  parseRelayV3HttpResponse,
  RELAY_V3_HTTP,
  type RelayV3HttpOperation,
} from "@zcode/shared/remote-relay-v3";
import {
  clickTestIdByDom,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "./desktop-app.js";

export const TID_RELAY_LOGIN = "relay-v3-login";
export const TID_RELAY_PHONE = "relay-v3-phone";
export const TID_RELAY_CODE = "relay-v3-code";
export const TID_RELAY_SEND_CODE = "relay-v3-send-code";
export const TID_RELAY_ENDPOINT_INPUT = "relay-v3-endpoint-input";
export const TID_RELAY_ENDPOINT_SAVE = "relay-v3-endpoint-save";

export const E2E_RELAY_PHONE = "+8613800138000";
export const E2E_RELAY_ACCOUNT_ID = "acct_e2e_relay";
export const E2E_LINKPI_API_KEY = "e2e-linkpi-api-key";
export const E2E_LINKPI_PROVIDER_NAME = "E2E LinkPi";

const RELAY_URL_ENV = "ZCODE_E2E_RELAY_V3_URL";
const RELAY_PHONE_ENV = "ZCODE_E2E_RELAY_V3_PHONE";
const SMS_CODE_PATH_PREFIX = "/__e2e/sms-code/";

/**
 * 本地最小 relay HTTP 调用：不能复用 shared/test/fixtures/relay-v3-consistency.ts，
 * 它顶层 import vitest，而 wdio.conf.ts 由 jiti 以 CommonJS 加载会直接报错。
 */
async function relayV3Request<K extends RelayV3HttpOperation>(
  baseUrl: string,
  operation: K,
  body?: unknown,
) {
  const { method, path } = RELAY_V3_HTTP[operation];
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as unknown;
  return parseRelayV3HttpResponse(operation, json);
}

export interface RelayV3SignedInFixture {
  httpUrl: string;
  phone: string;
  /** 关闭 fake relay；调用方在 afterSession / onComplete 中释放。 */
  stop: () => Promise<void>;
}

export interface RelayV3TestFixture extends RelayV3SignedInFixture {
  wsUrl: string;
  smsCode: (phone: string) => string;
}

/**
 * 只启动 fake relay（含测试专用短信读取端点），不预置账号凭据。
 * 登录专项 E2E 用它验证欢迎页的完整手机号 + 验证码链路；wdio 冷启动播种用
 * startRelayV3SignedInFixture 额外写入已登录账号。
 */
export async function startRelayV3TestServer(options: {
  phone?: string;
  accountId?: string;
}): Promise<RelayV3TestFixture> {
  const phone = options.phone ?? E2E_RELAY_PHONE;
  const accountId = options.accountId ?? E2E_RELAY_ACCOUNT_ID;
  // fake relay 自带的 smsCode() 只在 fixture 对象上；UI 兜底需要经 HTTP 读同一事实，
  // 因此在这里加一个测试专用只读路径（不改动 shared 的 fake relay 实现）。
  let relay: FakeRelayV3 | undefined;
  relay = await createFakeRelayV3({
    accounts: { [phone]: accountId },
    onHttp: (call) => {
      if (call.method !== "GET" || !call.path.startsWith(SMS_CODE_PATH_PREFIX)) return;
      const targetPhone = decodeURIComponent(call.path.slice(SMS_CODE_PATH_PREFIX.length));
      return { status: 200, body: { code: relay?.smsCode(targetPhone) ?? null } };
    },
  });
  return {
    httpUrl: relay.httpUrl,
    wsUrl: relay.wsUrl,
    phone,
    smsCode: (targetPhone: string) => relay!.smsCode(targetPhone) ?? "",
    stop: () => relay!.close(),
  };
}

/**
 * 在 App 启动前准备一个“已登录”的 relay v3 账号。
 *
 * 不写 AppSettings 之外的任何业务状态：只落 main 自己读取的凭据文件，
 * endpoint 由调用方写进 setting.json（见 wdio.conf.ts 的 seedE2EStartupState）。
 */
export async function startRelayV3SignedInFixture(options: {
  configDir: string;
  phone?: string;
  accountId?: string;
}): Promise<RelayV3SignedInFixture> {
  const phone = options.phone ?? E2E_RELAY_PHONE;
  const accountId = options.accountId ?? E2E_RELAY_ACCOUNT_ID;
  const fixture = await startRelayV3TestServer({ phone, accountId });
  await relayV3Request(fixture.httpUrl, "smsCode", { phone });
  const login = await relayV3Request(fixture.httpUrl, "login", {
    phone,
    code: fixture.smsCode(phone),
  });
  const pair = login && "data" in login ? login.data : null;
  if (!pair || !("access" in pair)) {
    throw new Error(`relay v3 fixture 登录失败: ${JSON.stringify(login)}`);
  }
  mkdirSync(options.configDir, { recursive: true });
  // 与 RelayV3AccountService.writeStoredSession 同形；main 启动时会把 refresh 旋转成新值。
  writeFileSync(
    join(options.configDir, "relay-v3-account.json"),
    JSON.stringify({ refresh: pair.refresh, account: pair.account }),
    { encoding: "utf-8", mode: 0o600 },
  );
  return { httpUrl: fixture.httpUrl, phone, stop: fixture.stop };
}

/** 冷启动播种的 endpoint / 手机号传给 worker（WDIO worker 继承 process.env）。 */
export function applyRelayV3FixtureEnv(fixture: RelayV3SignedInFixture): void {
  process.env[RELAY_URL_ENV] = fixture.httpUrl;
  process.env[RELAY_PHONE_ENV] = fixture.phone;
}

export function clearRelayV3FixtureEnv(): void {
  delete process.env[RELAY_URL_ENV];
  delete process.env[RELAY_PHONE_ENV];
}

export async function isRelayWelcomeVisible(): Promise<boolean> {
  return browser
    .execute((testId) => Boolean(document.querySelector(`[data-testid="${testId}"]`)), TID_RELAY_LOGIN)
    .catch(() => false);
}

async function readSmsCode(endpoint: string, phone: string): Promise<string> {
  const response = await fetch(`${endpoint}${SMS_CODE_PATH_PREFIX}${encodeURIComponent(phone)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`读取 relay v3 验证码失败: HTTP ${response.status}`);
  const body = (await response.json()) as { code?: unknown };
  if (typeof body.code !== "string" || body.code.length !== 6) {
    throw new Error("fake relay 没有为测试手机号签发验证码");
  }
  return body.code;
}

/**
 * 保证应用已经越过 relay 登录门禁。冷启动播种成功时这里是 no-op；否则走一次真实 UI 登录。
 * page 参数仅为兼容旧 helper 调用点（WebdriverIO 使用全局 browser），不参与实现。
 */
export async function ensureRelayLoggedIn(_page?: unknown): Promise<void> {
  if (!(await isRelayWelcomeVisible())) return;

  const endpoint = process.env[RELAY_URL_ENV]?.trim();
  if (!endpoint) {
    throw new Error("欢迎页仍在，但没有 ZCODE_E2E_RELAY_V3_URL：relay v3 fixture 未启动");
  }
  const phone = process.env[RELAY_PHONE_ENV]?.trim() || E2E_RELAY_PHONE;

  const endpointSupported = await browser.execute(
    (testId) => Boolean(document.querySelector(`[data-testid="${testId}"]`)),
    TID_RELAY_ENDPOINT_INPUT,
  );
  if (endpointSupported) {
    const saved = await browser.execute(
      (testId) =>
        (document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)?.value ?? "").trim(),
      TID_RELAY_ENDPOINT_INPUT,
    );
    if (saved !== endpoint) {
      await setInputValueByTestIdDom(TID_RELAY_ENDPOINT_INPUT, endpoint, {
        timeoutMsg: "欢迎页没有 relay 服务器地址输入框",
      });
      await clickTestIdByDom(TID_RELAY_ENDPOINT_SAVE, {
        timeoutMsg: "欢迎页没有 relay 服务器地址保存按钮",
      });
      await browser.waitUntil(
        () =>
          browser.execute(
            (testId, expected) =>
              (
                document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)?.value ?? ""
              ).trim() === expected,
            TID_RELAY_ENDPOINT_INPUT,
            endpoint,
          ),
        { timeout: 15_000, timeoutMsg: "relay 服务器地址没有保存成功" },
      );
    }
  }

  await setInputValueByTestIdDom(TID_RELAY_PHONE, phone, {
    timeoutMsg: "欢迎页没有 relay 手机号输入框",
  });
  await clickTestIdByDom(TID_RELAY_SEND_CODE, {
    timeoutMsg: "欢迎页没有 relay 发送验证码按钮",
  });
  const code = await readSmsCode(endpoint, phone);
  await setInputValueByTestIdDom(TID_RELAY_CODE, code, {
    timeoutMsg: "欢迎页没有 relay 验证码输入框",
  });
  await clickTestIdByDom(TID_RELAY_LOGIN, {
    timeoutMsg: "欢迎页没有 relay 登录按钮",
  });
  await browser.waitUntil(() => isRelayWelcomeVisible().then((visible) => !visible), {
    timeout: 30_000,
    timeoutMsg: "relay 登录成功后欢迎页没有关闭",
  });
  await waitForDefaultWorkspaceReady(30_000);
}

/**
 * 用 config/provider/zcode-builtin.json 已有的 linkpi 模板创建个人 Provider，并写入测试 Key。
 * 通过头像菜单节点向上找 React context 拿到 Host 的 providerSettingsService（与其余
 * settings E2E 同一访问方式），不新增模板、不直接改 provider_config.json。
 */
export async function configureLinkPiProvider(_page?: unknown): Promise<string> {
  await ensureRelayLoggedIn();
  const created = await browser.execute(
    async (triggerTestId, templateId, providerName, apiKey) => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      if (!trigger) throw new Error("找不到头像菜单入口，无法访问 Provider Host 服务");
      let fiber: any = (trigger as any)[
        Object.keys(trigger).find((key) => key.startsWith("__reactFiber"))!
      ];
      let service: any;
      while (fiber) {
        const props = (fiber as any).memoizedProps;
        const value = props?.value;
        const candidate = value?.providerSettingsService ? value : props?.services;
        if (candidate?.providerSettingsService) {
          service = candidate.providerSettingsService;
          break;
        }
        fiber = (fiber as any).return;
      }
      if (!service) throw new Error("找不到 providerSettingsService RPC accessor");
      const config = { access: { type: "api-key", apiKey } };
      const result = await service.createPersonalProvider({
        templateId,
        providerName,
        locale: "en-US",
        initialConfig: config,
      });
      // createPersonalProvider 的模板继承层不含 Key；显式 overlay 一次，避免服务端
      // 对 initialConfig 的序列化差异让测试 Key 丢失。
      await service.savePersonalProviderOverlay(result.providerId, config);
      return result.providerId as string;
    },
    TID_LOGIN_TRIGGER,
    "linkpi",
    E2E_LINKPI_PROVIDER_NAME,
    E2E_LINKPI_API_KEY,
  );
  return created;
}
