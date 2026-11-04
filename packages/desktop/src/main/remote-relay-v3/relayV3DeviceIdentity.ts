import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAppConfigDir } from "@zcode/services/node";
import {
  decodeRelayV3Base64Url,
  encodeRelayV3Base64Url,
  generateRelayV3KeyPair,
  type RelayV3KeyPair,
} from "@zcode/shared/remote-relay-v3";

// Relay V3 设备身份（P1，设计 §4.2/§9）：X25519 静态密钥对与 device_sid 的持久化。
// 私钥只落本地用户数据目录（~/.zcode/v2/relay-v3-device.json，原子写），不进
// AppSettings、不进设置同步、不写日志；重注册即换新密钥对与新 SID（同一生命周期）。

export interface RelayV3StoredDeviceIdentity {
  keyPair: RelayV3KeyPair;
  deviceSid: string | null;
}

interface IdentityFileShape {
  /** base64url(X25519 私钥 32B)；文件属本地用户数据，随 OS 账户隔离。 */
  privateKey: string;
  publicKey: string;
  deviceSid?: string;
}

export function relayV3IdentityFilePath(configDir?: string): string {
  return join(configDir ?? getAppConfigDir(), "relay-v3-device.json");
}

/** 读取或生成本机设备身份；device_sid 为 null 表示已生成密钥但尚未注册。 */
export function loadOrGenerateRelayV3DeviceIdentity(configDir?: string): RelayV3StoredDeviceIdentity {
  const file = relayV3IdentityFilePath(configDir);
  const stored = readIdentityFile(file);
  if (stored) {
    const privateKey = decodeRelayV3Base64Url(stored.privateKey);
    const publicKey = decodeRelayV3Base64Url(stored.publicKey);
    if (privateKey.length === 32 && publicKey.length === 32) {
      return { keyPair: { privateKey, publicKey }, deviceSid: stored.deviceSid ?? null };
    }
    // 损坏的身份文件视为缺失：换新密钥对并覆盖（注册事实以 relay 为准）。
  }
  const keyPair = generateRelayV3KeyPair();
  writeIdentityFile(file, {
    privateKey: encodeRelayV3Base64Url(keyPair.privateKey),
    publicKey: encodeRelayV3Base64Url(keyPair.publicKey),
  });
  return { keyPair, deviceSid: null };
}

/** 注册成功后持久化 device_sid；保存失败抛出（调用方按注册失败补偿删除，V2 03 语义）。 */
export function persistRelayV3DeviceSid(deviceSid: string, configDir?: string): void {
  const file = relayV3IdentityFilePath(configDir);
  const stored = readIdentityFile(file);
  if (!stored) {
    throw new Error("relay device identity file missing before persisting device_sid");
  }
  writeIdentityFile(file, { ...stored, deviceSid });
}

/** 丢弃当前身份（登出/重注册换新密钥对时调用）。 */
export function resetRelayV3DeviceIdentity(configDir?: string): RelayV3StoredDeviceIdentity {
  const file = relayV3IdentityFilePath(configDir);
  const keyPair = generateRelayV3KeyPair();
  writeIdentityFile(file, {
    privateKey: encodeRelayV3Base64Url(keyPair.privateKey),
    publicKey: encodeRelayV3Base64Url(keyPair.publicKey),
  });
  return { keyPair, deviceSid: null };
}

function readIdentityFile(file: string): IdentityFileShape | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.privateKey !== "string" || typeof record.publicKey !== "string") return null;
    return {
      privateKey: record.privateKey,
      publicKey: record.publicKey,
      ...(typeof record.deviceSid === "string" ? { deviceSid: record.deviceSid } : {}),
    };
  } catch {
    return null;
  }
}

function writeIdentityFile(file: string, shape: IdentityFileShape): void {
  mkdirSync(dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(shape, null, 2), "utf-8");
  renameSync(tempFile, file);
}

/** 测试辅助：身份文件是否存在。 */
export function relayV3IdentityFileExists(configDir?: string): boolean {
  return existsSync(relayV3IdentityFilePath(configDir));
}
