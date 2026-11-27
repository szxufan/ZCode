import { describe, expect, it } from "vitest";

import {
  buildRelayV3QrUrl,
  encodeRelayV3Base64Url,
  generateRelayV3KeyPair,
  parseRelayV3QrUrl,
  relayV3DeviceFingerprint,
  relayV3KeyId,
  verifyRelayV3QrFingerprint,
} from "@zcode/shared/remote-relay-v3";

// 二维码带外指纹是 relay 目录公钥的信任锚；缺失或不一致必须拒绝连接。

describe("Relay V3 二维码公钥指纹", () => {
  const keyPair = generateRelayV3KeyPair();
  const fingerprint = relayV3KeyId(keyPair.publicKey);
  const publicKeyB64 = encodeRelayV3Base64Url(keyPair.publicKey);

  it("构造与解析二维码时保留合法指纹，拒绝非法指纹", () => {
    const url = buildRelayV3QrUrl("https://relay.test/remote/v4", {
      sid: "d_1",
      mid: "mid_1",
      fingerprint,
    });
    expect(parseRelayV3QrUrl(url)).toMatchObject({
      sid: "d_1",
      mid: "mid_1",
      fingerprint,
    });
    expect(parseRelayV3QrUrl(url.replace(fingerprint, "not-a-fingerprint"))).toBeNull();
  });

  it("目录公钥与二维码指纹一致才通过，不一致拒绝", () => {
    expect(verifyRelayV3QrFingerprint(fingerprint, publicKeyB64)).toEqual({
      ok: true,
      fingerprint,
    });

    const attackerKey = generateRelayV3KeyPair();
    expect(
      verifyRelayV3QrFingerprint(fingerprint, encodeRelayV3Base64Url(attackerKey.publicKey)),
    ).toMatchObject({ ok: false, reason: "key-mismatch" });
    expect(verifyRelayV3QrFingerprint(undefined, publicKeyB64)).toMatchObject({
      ok: false,
      reason: "missing-fingerprint",
    });
  });

  it("非法公钥不产生可用指纹", () => {
    expect(relayV3DeviceFingerprint("not-base64url!")).toBeNull();
    expect(relayV3DeviceFingerprint(encodeRelayV3Base64Url(new Uint8Array(8)))).toBeNull();
  });
});
