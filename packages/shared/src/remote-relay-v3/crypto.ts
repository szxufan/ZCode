import { gcm } from "@noble/ciphers/aes";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

import {
  RELAY_V3_ENVELOPE_ALG,
  RELAY_V3_ENVELOPE_VERSION,
  parseRelayV3Envelope,
  type RelayV3Envelope,
} from "./contract.js";

// Relay V3 端到端加密（docs/relay-server/relay-v3-design.md §4）。
// 与 OpenBitFun device_crypto.rs 同构：X25519 static-static ECDH + HKDF-SHA256
// （公钥排序对称化）+ AES-256-GCM。密钥生成、派生、加解密全部在各端完成，
// relay 进程不引入任何加密依赖（§4.1）；纯 JS 实现，Node 与浏览器同一份代码。

export const RELAY_V3_KDF_SALT = "ZCode Relay V3 device key v1";
const RELAY_V3_KID_DOMAIN = "ZCode Relay V3 kid v1";
export const RELAY_V3_PUBLIC_KEY_BYTES = 32;
export const RELAY_V3_NONCE_BYTES = 12;
export const RELAY_V3_SESSION_KEY_BYTES = 32;

/** 设备密钥指纹：SHA-256(域分隔 ‖ 公钥) 前 8 字节 hex（§4.5 kid）。 */
export function relayV3KeyId(publicKey: Uint8Array): string {
  const domain = new TextEncoder().encode(RELAY_V3_KID_DOMAIN);
  const input = new Uint8Array(domain.length + publicKey.length);
  input.set(domain);
  input.set(publicKey, domain.length);
  const digest = sha256(input);
  let hex = "";
  for (let index = 0; index < 8; index += 1) {
    hex += (digest[index] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

export interface RelayV3KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** 生成本地 X25519 静态/一次性密钥对；私钥永不出端（§4.2）。 */
export function generateRelayV3KeyPair(): RelayV3KeyPair {
  const privateKey = new Uint8Array(RELAY_V3_PUBLIC_KEY_BYTES);
  crypto.getRandomValues(privateKey);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

function isAllZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return a.length - b.length;
}

export type RelayV3CryptoFailureKind = "invalid-public-key" | "invalid-envelope" | "decrypt-failed";

export class RelayV3CryptoError extends Error {
  constructor(readonly kind: RelayV3CryptoFailureKind) {
    super(kind);
    this.name = "RelayV3CryptoError";
  }
}

/**
 * 会话密钥派生（§4.3）：
 *   shared = X25519(本地私钥, 对端公钥)（拒绝全零等退化点）
 *   info   = sort_bytes(本地公钥 ‖ 对端公钥) —— 排序使两端得同一 key
 *   key    = HKDF-SHA256(salt="ZCode Relay V3 device key v1", ikm=shared, info) → 32B
 */
export function deriveRelayV3SessionKey(
  privateKey: Uint8Array,
  peerPublicKey: Uint8Array,
): Uint8Array {
  if (peerPublicKey.length !== RELAY_V3_PUBLIC_KEY_BYTES) {
    throw new RelayV3CryptoError("invalid-public-key");
  }
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(privateKey, peerPublicKey);
  } catch {
    throw new RelayV3CryptoError("invalid-public-key");
  }
  if (isAllZero(shared)) throw new RelayV3CryptoError("invalid-public-key");
  const localPublicKey = x25519.getPublicKey(privateKey);
  const [first, second] =
    compareBytes(localPublicKey, peerPublicKey) <= 0
      ? [localPublicKey, peerPublicKey]
      : [peerPublicKey, localPublicKey];
  const info = new Uint8Array(RELAY_V3_PUBLIC_KEY_BYTES * 2);
  info.set(first);
  info.set(second, first.length);
  return hkdf(sha256, shared, new TextEncoder().encode(RELAY_V3_KDF_SALT), info, 32);
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeRelayV3Base64Url(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index] ?? 0;
    const byte1 = bytes[index + 1];
    const byte2 = bytes[index + 2];
    result += BASE64URL_ALPHABET[byte0 >> 2];
    result += BASE64URL_ALPHABET[((byte0 & 0x03) << 4) | ((byte1 ?? 0) >> 4)];
    if (byte1 === undefined) break;
    result += BASE64URL_ALPHABET[((byte1 & 0x0f) << 2) | ((byte2 ?? 0) >> 6)];
    if (byte2 === undefined) break;
    result += BASE64URL_ALPHABET[byte2 & 0x3f];
  }
  return result;
}

const BASE64URL_LOOKUP: Record<string, number> = {};
for (let index = 0; index < BASE64URL_ALPHABET.length; index += 1) {
  BASE64URL_LOOKUP[BASE64URL_ALPHABET[index]!] = index;
}

export function decodeRelayV3Base64Url(value: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const digit = BASE64URL_LOOKUP[char];
    if (digit === undefined) throw new RelayV3CryptoError("invalid-envelope");
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** 加密明文为密文信封（§4.4/§4.5）；每条消息随机 12 字节 nonce，GCM tag 附在密文尾。 */
export function sealRelayV3Envelope(
  sessionKey: Uint8Array,
  plaintext: Uint8Array,
  kid: string,
): RelayV3Envelope {
  const nonce = new Uint8Array(RELAY_V3_NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const ciphertext = gcm(sessionKey, nonce, new Uint8Array(0)).encrypt(plaintext);
  return {
    v: RELAY_V3_ENVELOPE_VERSION,
    alg: RELAY_V3_ENVELOPE_ALG,
    kid,
    nonce: encodeRelayV3Base64Url(nonce),
    ct: encodeRelayV3Base64Url(ciphertext),
  };
}

/**
 * 解密密文信封。未知 alg 或解密失败按协议错误抛出（transport 记录
 * decrypt-failed 并断开重建，不静默丢弃，§4.5）。
 */
export function openRelayV3Envelope(sessionKey: Uint8Array, envelope: unknown): Uint8Array {
  const parsed = parseRelayV3Envelope(envelope);
  if (!parsed) throw new RelayV3CryptoError("invalid-envelope");
  const nonce = decodeRelayV3Base64Url(parsed.nonce);
  const ciphertext = decodeRelayV3Base64Url(parsed.ct);
  try {
    return gcm(sessionKey, nonce, new Uint8Array(0)).decrypt(ciphertext);
  } catch {
    throw new RelayV3CryptoError("decrypt-failed");
  }
}
