import os from "node:os";

import {
  buildRelayV3QrUrl,
  relayV3KeyId,
  type RelayV3KeyPair,
} from "@zcode/shared/remote-relay-v3";

// 被控端二维码构造（§5.3）：指纹来自本地设备公钥，不经过 relay 目录，
// 因此手机扫码后可用它验证 relay 返回的公钥是否被替换。

export interface RelayV3StatusQrInput {
  baseUrl: string | null;
  deviceSid: string | null;
  deviceMid: string;
  keyPair: RelayV3KeyPair | null;
  hostname?: string;
  appVersion?: string;
}

export function buildRelayV3StatusQrUrl(input: RelayV3StatusQrInput): string | null {
  if (!input.baseUrl || !input.deviceSid) return null;
  return buildRelayV3QrUrl(input.baseUrl, {
    sid: input.deviceSid,
    mid: input.deviceMid,
    name: input.hostname ?? os.hostname(),
    app_version: input.appVersion,
    ...(input.keyPair ? { fingerprint: relayV3KeyId(input.keyPair.publicKey) } : {}),
  });
}
