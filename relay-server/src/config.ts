// Relay V3 配置面（§8）：环境变量 → RelayServerConfig。
// fail closed：RELAY_DB_PATH 缺失直接启动失败（§7，沿用 OpenBitFun 约束）；
// JWT 密钥缺失同样失败——临时随机密钥会在重启后使全部 access token 失效，
// 掩盖配置错误，不如启动即报。

export interface RelayAliyunSmsConfig {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templateCode: string;
  endpoint: string;
  codeSecret: string;
}

export interface RelaySmsConfig {
  /** aliyun：真实下发；test：仅记录到测试接缝（生产构建禁用）；none：未配置。 */
  provider: "aliyun" | "test" | "none";
  aliyun?: RelayAliyunSmsConfig;
}

export interface RelayServerConfig {
  port: number;
  dbPath: string;
  staticDir?: string;
  jwtSecret: string;
  localRegistration: "open" | "closed";
  production: boolean;
  sms: RelaySmsConfig;
}

export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayConfigError";
  }
}

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayServerConfig {
  const missing: string[] = [];
  const requireEnv = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };
  const dbPath = requireEnv("RELAY_DB_PATH");
  const jwtSecret = requireEnv("RELAY_JWT_SECRET");
  if (missing.length > 0) {
    throw new RelayConfigError(`missing required environment variables: ${missing.join(", ")}`);
  }
  const production = env.RELAY_ENV === "production" || env.NODE_ENV === "production";
  const provider = env.RELAY_SMS_PROVIDER?.trim() || "aliyun";
  if (provider !== "aliyun" && provider !== "test") {
    throw new RelayConfigError(`RELAY_SMS_PROVIDER must be aliyun or test, got: ${provider}`);
  }
  // 生产构建禁用 test provider，验证码不写日志（§3.2）。
  if (provider === "test" && production) {
    throw new RelayConfigError("RELAY_SMS_PROVIDER=test is not allowed in production");
  }
  let sms: RelaySmsConfig = { provider: "none" };
  if (provider === "test") {
    sms = { provider: "test" };
  } else {
    const accessKeyId = env.RELAY_SMS_ALIYUN_ACCESS_KEY_ID?.trim() ?? "";
    const accessKeySecret = env.RELAY_SMS_ALIYUN_ACCESS_KEY_SECRET?.trim() ?? "";
    const signName = env.RELAY_SMS_ALIYUN_SIGN_NAME?.trim() ?? "";
    const templateCode = env.RELAY_SMS_ALIYUN_TEMPLATE_CODE?.trim() ?? "";
    const codeSecret = env.RELAY_SMS_CODE_SECRET?.trim() ?? "";
    // 未配置时验证码接口返回 503（密码登录仍可用，§3.2）。
    if (accessKeyId && accessKeySecret && signName && templateCode && codeSecret) {
      sms = {
        provider: "aliyun",
        aliyun: {
          accessKeyId,
          accessKeySecret,
          signName,
          templateCode,
          endpoint: env.RELAY_SMS_ALIYUN_ENDPOINT?.trim() || "https://dysmsapi.aliyuncs.com",
          codeSecret,
        },
      };
    }
  }
  const localRegistration = env.RELAY_LOCAL_REGISTRATION?.trim() || "open";
  if (localRegistration !== "open" && localRegistration !== "closed") {
    throw new RelayConfigError(`RELAY_LOCAL_REGISTRATION must be open or closed`);
  }
  const staticDir = env.RELAY_STATIC_DIR?.trim() || undefined;
  const port = Number(env.RELAY_PORT?.trim() || "8080");
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new RelayConfigError(`RELAY_PORT is not a valid port: ${env.RELAY_PORT}`);
  }
  return {
    port,
    dbPath,
    staticDir,
    jwtSecret,
    localRegistration,
    production,
    sms,
  };
}
