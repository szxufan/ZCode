import type {
  RelayV3AuthAck,
  RelayV3Device,
  RelayV3Envelope,
  RelayV3OutgoingMessage,
} from "./contract.js";

export const relayV3EnvelopeExample: RelayV3Envelope = {
  v: 3,
  alg: "x25519-hkdfsha256-aes256gcm-v1",
  kid: "0a1b2c3d4e5f6071",
  nonce: "AAAAAAAAAAAAAAAA",
  ct: "c29tZWNpcGhlcnRleHQ",
};

export const relayV3DeviceAuthInitExample: RelayV3OutgoingMessage = {
  type: "auth_init",
  device_sid: "d_9f2c1a44",
  meta: { name: "工作电脑", platform: "win32", version: "1.0.0" },
  client_ts: 1_799_000_000,
};

export const relayV3TerminalAuthInitExample: RelayV3OutgoingMessage = {
  type: "auth_init",
  device_sid: "d_9f2c1a44",
  terminal_public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8",
  client_ts: 1_799_000_000,
};

export const relayV3AuthAckExample: RelayV3AuthAck = {
  type: "auth_ack",
  device_sid: "d_9f2c1a44",
  terminal_sid: "t_1e2d3c4b",
  pair_status: "matched",
  server_ts: 1_799_000_001,
};

export const relayV3DeviceRecordExample: RelayV3Device = {
  device_sid: "d_9f2c1a44",
  device_mid: "mid-7f00",
  public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8",
  online: true,
  created_at: 1_799_000_000,
  meta: { name: "工作电脑" },
};
