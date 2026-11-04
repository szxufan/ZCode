import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  encodeRelayV3Base64Url,
  generateRelayV3KeyPair,
  relayV3KeyId,
  RelayV3BusinessError,
  RelayV3ConnectionError,
  RelayV3HttpClient,
  type RelayV3Account,
  type RelayV3KeyPair,
} from "@zcode/shared/remote-relay-v3";

// Relay V3 headless 设备授权（R4，总设计 §5.5 / 数据面 spec §7）：
// `zcode server login` 本地生成 X25519 静态密钥对（server root 0600），发起
// device-auth request → 终端显示 user_code + 公钥指纹 + 授权地址 → 轮询 poll
// 直到批准（凭据经 poll 交付）或过期。信任建立点在批准时刻：relay 批准时才
// 完成「账号 ↔ 公钥 ↔ 设备记录」绑定。凭据落 server root（0600，重启免重登）。

export interface RelayV3DeviceAuthPaths {
  identityFile: string;
  credentialsFile: string;
}

export function relayV3DeviceAuthPaths(serverRoot: string): RelayV3DeviceAuthPaths {
  return {
    identityFile: join(serverRoot, "relay-v3-device.json"),
    credentialsFile: join(serverRoot, "relay-v3-account.json"),
  };
}

export interface RelayV3DaemonIdentity {
  keyPair: RelayV3KeyPair;
  deviceSid: string | null;
}

export function loadOrGenerateRelayV3DaemonIdentity(serverRoot: string): RelayV3DaemonIdentity {
  const { identityFile } = relayV3DeviceAuthPaths(serverRoot);
  const read = readJson(identityFile);
  if (read && typeof read.privateKey === "string" && typeof read.publicKey === "string") {
    const privateKey = decode(read.privateKey);
    const publicKey = decode(read.publicKey);
    if (privateKey.length === 32 && publicKey.length === 32) {
      return { keyPair: { privateKey, publicKey }, deviceSid: typeof read.deviceSid === "string" ? read.deviceSid : null };
    }
  }
  const keyPair = generateRelayV3KeyPair();
  writeJson(identityFile, {
    privateKey: encodeRelayV3Base64Url(keyPair.privateKey),
    publicKey: encodeRelayV3Base64Url(keyPair.publicKey),
  });
  return { keyPair, deviceSid: null };
}

export interface RelayV3DaemonCredentials {
  access: string;
  refresh: string;
  account: RelayV3Account;
  deviceSid: string;
  /** access 过期时间（JWT exp 秒）。 */
  accessExpiresAtSec: number;
}

export function loadRelayV3DaemonCredentials(serverRoot: string): RelayV3DaemonCredentials | null {
  const { credentialsFile } = relayV3DeviceAuthPaths(serverRoot);
  const read = readJson(credentialsFile);
  if (!read) return null;
  const account = read.account as { id?: unknown; phone_masked?: unknown } | undefined;
  if (
    typeof read.access !== "string" ||
    typeof read.refresh !== "string" ||
    typeof read.deviceSid !== "string" ||
    typeof account?.id !== "string" ||
    typeof account?.phone_masked !== "string"
  ) {
    return null;
  }
  return {
    access: read.access,
    refresh: read.refresh,
    account: { id: account.id, phone_masked: account.phone_masked },
    deviceSid: read.deviceSid,
    accessExpiresAtSec: typeof read.accessExpiresAtSec === "number" ? read.accessExpiresAtSec : 0,
  };
}

export function saveRelayV3DaemonCredentials(serverRoot: string, credentials: RelayV3DaemonCredentials): void {
  const { credentialsFile, identityFile } = relayV3DeviceAuthPaths(serverRoot);
  writeJson(credentialsFile, { ...credentials });
  // 身份文件补记 device_sid（重装即换新密钥对与新记录，§4.2）。
  const identity = readJson(identityFile);
  if (identity && identity.deviceSid !== credentials.deviceSid) {
    writeJson(identityFile, { ...identity, deviceSid: credentials.deviceSid });
  }
}

export interface RelayV3DeviceAuthFlowResult {
  credentials: RelayV3DaemonCredentials;
  userCode: string;
}

/**
 * 设备授权流程：request →（终端展示）→ poll 至批准/过期。
 * @param display 回调负责把 user_code/指纹/授权地址呈现给用户（CLI 终端或测试断言）。
 */
export async function runRelayV3DeviceAuthFlow(options: {
  relayOrigin: string;
  serverRoot: string;
  identity?: RelayV3DaemonIdentity;
  pollIntervalMs?: number;
  deadlineMs?: number;
  now?: () => number;
  display?: (info: { userCode: string; fingerprint: string; authUrl: string }) => void;
}): Promise<RelayV3DeviceAuthFlowResult> {
  const identity = options.identity ?? loadOrGenerateRelayV3DaemonIdentity(options.serverRoot);
  const client = new RelayV3HttpClient({ baseUrl: options.relayOrigin });
  const request = await client.request("deviceAuthRequest", undefined, {
    public_key: encodeRelayV3Base64Url(identity.keyPair.publicKey),
  });
  options.display?.({
    userCode: request.user_code,
    fingerprint: relayV3KeyId(identity.keyPair.publicKey),
    authUrl: `${options.relayOrigin}/#device-auth`,
  });
  const deadline = (options.now ?? Date.now)() + (options.deadlineMs ?? request.expires_in * 1_000);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 2_000));
    let poll: Awaited<ReturnType<typeof client.request<"deviceAuthPoll">>>;
    try {
      poll = await client.request("deviceAuthPoll", undefined, { device_code: request.device_code });
    } catch (error) {
      if (error instanceof RelayV3BusinessError) {
        // EXPIRED（9）等业务终态：停止轮询，由调用方提示重新发起（换新密钥对，§5.5）。
        throw error;
      }
      if (error instanceof RelayV3ConnectionError && !error.retryable) throw error;
      continue; // 网络抖动：继续轮询直到 deadline。
    }
    if ("status" in poll && poll.status === "pending") {
      if ((options.now ?? Date.now)() > deadline) {
        throw new RelayV3BusinessError(9, "device auth expired", 200);
      }
      continue;
    }
    if ("access" in poll && "device" in poll) {
      // poll 响应不含账号摘要；凭据文件的 account 以设备记录补齐展示字段。
      const credentials: RelayV3DaemonCredentials = {
        access: poll.access,
        refresh: poll.refresh,
        account: {
          id: `device:${poll.device.device_sid}`,
          phone_masked: poll.device.meta?.name ?? poll.device.device_mid.slice(0, 8),
        },
        deviceSid: poll.device.device_sid,
        accessExpiresAtSec: accessExpirySec(poll.access),
      };
      saveRelayV3DaemonCredentials(options.serverRoot, credentials);
      return { credentials, userCode: request.user_code };
    }
  }
}

export function accessExpirySec(access: string): number {
  try {
    const payload = access.split(".")[1];
    if (!payload) return 0;
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
    ) as { exp?: unknown };
    return typeof decoded.exp === "number" ? decoded.exp : 0;
  } catch {
    return 0;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(value, null, 2), "utf-8");
  try {
    chmodSync(tempFile, 0o600);
  } catch {
    // Windows 无 POSIX 权限语义；目录 ACL 承担隔离。
  }
  renameSync(tempFile, file);
}

function decode(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lookup: Record<string, number> = {};
  for (let index = 0; index < alphabet.length; index += 1) lookup[alphabet[index]!] = index;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    buffer = (buffer << 6) | (lookup[char] ?? 0);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function relayV3IdentityExists(serverRoot: string): boolean {
  return existsSync(relayV3DeviceAuthPaths(serverRoot).identityFile);
}
