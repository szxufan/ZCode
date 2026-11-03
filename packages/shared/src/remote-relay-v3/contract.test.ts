import { describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import {
  decodeRelayV3Base64Url,
  deriveRelayV3SessionKey,
  encodeRelayV3Base64Url,
  generateRelayV3KeyPair,
  openRelayV3Envelope,
  parseRelayV3Envelope,
  parseRelayV3HttpRequest,
  parseRelayV3IncomingMessage,
  parseRelayV3OutgoingMessage,
  relayV3KeyId,
  RelayV3CryptoError,
  sealRelayV3Envelope,
  buildRelayV3QrUrl,
  parseRelayV3QrUrl,
} from "./index.js";

const VALID_PUBLIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8";
const ENVELOPE = {
  v: 3,
  alg: "x25519-hkdfsha256-aes256gcm-v1",
  kid: "0a1b2c3d4e5f6071",
  nonce: "AAAAAAAAAAAAAAAA",
  ct: "c29tZWNpcGhlcnRleHQ",
};

describe("Relay V3 契约解析", () => {
  it("auth_init：device 与 terminal 形态均接受，未知字段拒绝", () => {
    expect(
      parseRelayV3OutgoingMessage({
        type: "auth_init",
        device_sid: "d_1",
        meta: { name: "桌面" },
        client_ts: 1,
      }),
    ).toEqual({ type: "auth_init", device_sid: "d_1", meta: { name: "桌面" }, client_ts: 1 });
    expect(
      parseRelayV3OutgoingMessage({
        type: "auth_init",
        device_sid: "d_1",
        terminal_public_key: VALID_PUBLIC_KEY,
      }),
    ).toMatchObject({ type: "auth_init", terminal_public_key: VALID_PUBLIC_KEY });
    // terminal 缺 device_sid 或公钥非法 → 拒绝（配对按 (SID, role) 路由）。
    expect(
      parseRelayV3OutgoingMessage({ type: "auth_init", terminal_public_key: VALID_PUBLIC_KEY }),
    ).toBeNull();
    expect(
      parseRelayV3OutgoingMessage({
        type: "auth_init",
        device_sid: "d_1",
        terminal_public_key: "short",
      }),
    ).toBeNull();
    expect(
      parseRelayV3OutgoingMessage({ type: "auth_init", device_sid: "d_1", extra: 1 }),
    ).toBeNull();
    expect(parseRelayV3OutgoingMessage({ type: "data", payload: 42 })).toBeNull();
    expect(parseRelayV3OutgoingMessage({ type: "pair_status_query", client_ts: -1 })).toBeNull();
  });

  it("incoming：auth_ack / pair_status_ack（含 terminal_public_key 透传）/ error", () => {
    expect(
      parseRelayV3IncomingMessage({
        type: "auth_ack",
        device_sid: "d_1",
        terminal_sid: "",
        pair_status: "waiting",
      }),
    ).toMatchObject({ pair_status: "waiting" });
    expect(
      parseRelayV3IncomingMessage({
        type: "pair_status_ack",
        terminal_sid: "t_1",
        pair_status: "matched",
        terminal_public_key: VALID_PUBLIC_KEY,
      }),
    ).toMatchObject({ terminal_public_key: VALID_PUBLIC_KEY });
    expect(parseRelayV3IncomingMessage({ type: "error", code: "DEVICE_OFFLINE" })).toMatchObject({
      code: "DEVICE_OFFLINE",
    });
    expect(parseRelayV3IncomingMessage({ type: "error", code: "SOMETHING_ELSE" })).toBeNull();
    expect(
      parseRelayV3IncomingMessage({
        type: "pair_status_ack",
        terminal_sid: "t",
        pair_status: "paused",
      }),
    ).toBeNull();
  });

  it("密文信封：合法/非法 alg、kid、nonce", () => {
    expect(parseRelayV3Envelope(ENVELOPE)).toEqual(ENVELOPE);
    expect(parseRelayV3Envelope({ ...ENVELOPE, alg: "future-alg" })).toBeNull();
    expect(parseRelayV3Envelope({ ...ENVELOPE, v: 2 })).toBeNull();
    expect(parseRelayV3Envelope({ ...ENVELOPE, kid: "XYZ" })).toBeNull();
    expect(parseRelayV3Envelope({ ...ENVELOPE, nonce: "short" })).toBeNull();
    expect(parseRelayV3Envelope({ ...ENVELOPE, extra: true })).toBeNull();
  });

  it("HTTP 请求：login 双形态、非法手机号拒绝", () => {
    expect(parseRelayV3HttpRequest("login", { phone: "+8613800138000", code: "123456" })).toEqual({
      phone: "+8613800138000",
      code: "123456",
    });
    expect(parseRelayV3HttpRequest("login", { phone: "+8613800138000", password: "pw" })).toEqual({
      phone: "+8613800138000",
      password: "pw",
    });
    expect(parseRelayV3HttpRequest("login", { phone: "13800138000", code: "123456" })).toBeNull();
    expect(parseRelayV3HttpRequest("login", { phone: "+8613800138000", code: "12345" })).toBeNull();
    expect(
      parseRelayV3HttpRequest("register", { device_mid: "m", public_key: VALID_PUBLIC_KEY }),
    ).toEqual({ device_mid: "m", public_key: VALID_PUBLIC_KEY });
    expect(parseRelayV3HttpRequest("register", { device_mid: "m", public_key: "x" })).toBeNull();
  });

  it("二维码：构建/解析往返，拒绝未知参数与带凭据链接", () => {
    const url = buildRelayV3QrUrl("https://relay.example.com/remote/v4", {
      sid: "d_1",
      name: "桌面",
      app_version: "1.0.0",
    });
    expect(parseRelayV3QrUrl(url)).toEqual({
      baseUrl: "https://relay.example.com",
      sid: "d_1",
      name: "桌面",
      app_version: "1.0.0",
    });
    expect(parseRelayV3QrUrl(`${url}&token=secret`)).toBeNull();
    expect(parseRelayV3QrUrl("https://user:pass@relay.example.com/remote")).toBeNull();
    expect(parseRelayV3QrUrl("https://relay.example.com/remote#fragment")).toBeNull();
    expect(parseRelayV3QrUrl("file:///tmp/qr")).toBeNull();
  });
});

describe("Relay V3 端到端加密", () => {
  function fixedKeyPair(seed: number) {
    const privateKey = new Uint8Array(32).fill(seed);
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
  }

  it("会话密钥两端一致、kid 稳定、contributory 拒绝", () => {
    const alice = generateRelayV3KeyPair();
    const bob = generateRelayV3KeyPair();
    const aliceKey = deriveRelayV3SessionKey(alice.privateKey, bob.publicKey);
    const bobKey = deriveRelayV3SessionKey(bob.privateKey, alice.publicKey);
    expect(Buffer.from(aliceKey).toString("hex")).toBe(Buffer.from(bobKey).toString("hex"));
    expect(aliceKey).toHaveLength(32);
    expect(relayV3KeyId(alice.publicKey)).toMatch(/^[0-9a-f]{16}$/);
    expect(relayV3KeyId(alice.publicKey)).toBe(relayV3KeyId(alice.publicKey));
    expect(relayV3KeyId(alice.publicKey)).not.toBe(relayV3KeyId(bob.publicKey));
    // 全零公钥是退化点（低阶点），按 AUTH_FAILED 语义拒绝（§4.3）。
    expect(() => deriveRelayV3SessionKey(alice.privateKey, new Uint8Array(32))).toThrow(
      RelayV3CryptoError,
    );
  });

  it("信封加解密往返；篡改与错误密钥计为协议错误", () => {
    const alice = generateRelayV3KeyPair();
    const bob = generateRelayV3KeyPair();
    const sessionKey = deriveRelayV3SessionKey(alice.privateKey, bob.publicKey);
    const plaintext = new TextEncoder().encode('{"kind":"task_delta","seq":42}');
    const envelope = sealRelayV3Envelope(sessionKey, plaintext, relayV3KeyId(bob.publicKey));
    expect(envelope.v).toBe(3);
    expect(envelope.alg).toBe("x25519-hkdfsha256-aes256gcm-v1");
    expect(envelope.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const decrypted = openRelayV3Envelope(sessionKey, envelope);
    expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(plaintext));
    // 随机 nonce：两次加密产生不同密文，但都可解。
    const second = sealRelayV3Envelope(sessionKey, plaintext, envelope.kid);
    expect(second.ct).not.toBe(envelope.ct);
    expect(openRelayV3Envelope(sessionKey, second)).toEqual(plaintext);
    // 篡改密文 → decrypt-failed（确定性翻转首字符，避免随机碰撞成原文）。
    const flipped = envelope.ct.startsWith("B") ? "C" : "B";
    const tampered = { ...envelope, ct: `${flipped}${envelope.ct.slice(1)}` };
    expect(() => openRelayV3Envelope(sessionKey, tampered)).toThrowError(
      expect.objectContaining({ kind: "decrypt-failed" }) as RelayV3CryptoError,
    );
    // 错误会话密钥 → decrypt-failed。
    const stranger = generateRelayV3KeyPair();
    const strangerKey = deriveRelayV3SessionKey(stranger.privateKey, bob.publicKey);
    expect(() => openRelayV3Envelope(strangerKey, envelope)).toThrowError(
      expect.objectContaining({ kind: "decrypt-failed" }) as RelayV3CryptoError,
    );
    // 未知 alg / 结构非法 → invalid-envelope（接收端按协议错误断开重建，§4.5）。
    expect(() => openRelayV3Envelope(sessionKey, { ...envelope, alg: "future" })).toThrowError(
      expect.objectContaining({ kind: "invalid-envelope" }) as RelayV3CryptoError,
    );
    expect(() => openRelayV3Envelope(sessionKey, null)).toThrowError(
      expect.objectContaining({ kind: "invalid-envelope" }) as RelayV3CryptoError,
    );
  });

  it("base64url 编解码往返（含 1/2 字节余量）", () => {
    for (const length of [1, 2, 3, 12, 32, 100]) {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      const encoded = encodeRelayV3Base64Url(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeRelayV3Base64Url(encoded)).toEqual(bytes);
    }
  });

  it("金丝雀向量：确定性输入得到稳定会话密钥", () => {
    const alice = fixedKeyPair(7);
    const bob = fixedKeyPair(11);
    expect(Buffer.from(alice.publicKey).toString("base64url")).toBe(
      "E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20",
    );
    expect(Buffer.from(bob.publicKey).toString("base64url")).toBe(
      "c7LYt2qptTZgAyvI9di-46OuTjs6f9Sa3oH3NHo0qmg",
    );
    const forward = deriveRelayV3SessionKey(alice.privateKey, bob.publicKey);
    const backward = deriveRelayV3SessionKey(bob.privateKey, alice.publicKey);
    expect(Buffer.from(forward).toString("hex")).toBe(
      "bd1177ca6483f5081b88d98b7a0e116b264eeaa1eeba5a49380162840ab28f2c",
    );
    expect(Buffer.from(backward).toString("hex")).toBe(
      "bd1177ca6483f5081b88d98b7a0e116b264eeaa1eeba5a49380162840ab28f2c",
    );
  });
});
