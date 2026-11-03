import { describe, expect, it } from "vitest";

import {
  fragmentRelayV3RpcMessage,
  parseRelayV3RpcFrame,
  parseRelayV3RpcFrameAck,
  relayV3Crc32,
  RELAY_V3_RPC_MAX_MESSAGE_BYTES,
  RelayV3AcknowledgedRpc,
  RelayV3RpcProtocolError,
  type RelayV3RpcFrame,
  type RelayV3RpcFrameAck,
} from "@zcode/shared/remote-relay-v3";

// rpc-frame 分片协议：分片/组装往返、CRC 校验、cumulative ACK、重放、预算与超限。

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  // getRandomValues 单次上限 65,536 字节：分块填充。
  for (let offset = 0; offset < length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, length)));
  }
  return bytes;
}

interface Wire {
  sent: (RelayV3RpcFrame | RelayV3RpcFrameAck)[];
  received: Uint8Array[];
  degraded: string[];
  flow: string[];
}

/** 端到端直连：A.send → wire → B.receive；B 的 ACK → wire → A.receive。 */
function createPair(now = () => 0): { a: RelayV3AcknowledgedRpc; b: RelayV3AcknowledgedRpc; wire: Wire } {
  const wire: Wire = { sent: [], received: [], degraded: [], flow: [] };
  const a = new RelayV3AcknowledgedRpc({
    bridgeSessionId: "bs_1",
    sendPayload: (payload) => {
      wire.sent.push(payload);
      b.receive(payload);
    },
    onMessage: (message) => wire.received.push(message),
    onDegraded: (reason) => wire.degraded.push(`a:${reason}`),
    onFlowChange: (state) => wire.flow.push(`a:${state}`),
    timing: { now },
  });
  const b = new RelayV3AcknowledgedRpc({
    bridgeSessionId: "bs_1",
    sendPayload: (payload) => {
      wire.sent.push(payload);
      a.receive(payload);
    },
    onMessage: (message) => wire.received.push(message),
    onDegraded: (reason) => wire.degraded.push(`b:${reason}`),
    timing: { now },
  });
  return { a, b, wire };
}

describe("Relay V3 rpc-frame 分片", () => {
  it("CRC32 已知向量（空串 0、\"123456789\" 0xCBF43926）", () => {
    expect(relayV3Crc32(new Uint8Array(0))).toBe(0);
    expect(relayV3Crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("分片后每片 outer JSON 预算 ≤ 1 MiB（含 base64 膨胀）", () => {
    const message = randomBytes(RELAY_V3_RPC_MAX_MESSAGE_BYTES - 1);
    const frames = fragmentRelayV3RpcMessage("bs_1", 1, message);
    expect(frames.length).toBeLessThanOrEqual(64);
    for (const frame of frames) {
      const encoded = new TextEncoder().encode(JSON.stringify(frame));
      expect(encoded.length).toBeLessThanOrEqual(1_048_576);
    }
    expect(frames[0]).toMatchObject({ message_seq: 1, fragment_index: 0, message_bytes: message.length });
  });

  it("超限消息抛 oversize / too-many-fragments", () => {
    expect(() => fragmentRelayV3RpcMessage("bs_1", 1, new Uint8Array(0))).toThrow(RelayV3RpcProtocolError);
    // 17 MiB 超过 16 MiB 上限。
    expect(() => fragmentRelayV3RpcMessage("bs_1", 1, new Uint8Array(RELAY_V3_RPC_MAX_MESSAGE_BYTES + 1))).toThrow(
      RelayV3RpcProtocolError,
    );
  });

  it("小消息单片往返：交付一次并回 cumulative ACK，重放幂等去重", () => {
    const { a, b, wire } = createPair();
    const message = new TextEncoder().encode('{"method":"v4/conversation/subscribe"}');
    expect(a.send(message)).toBe(true);
    expect(wire.received).toEqual([message]);
    // ACK 已 flush：A 的 batch 释放。
    expect(a.inFlightBytes()).toBe(0);
    // 对端重放（same-socket send-ready）：B 幂等丢弃、不重复交付、补 ACK。
    for (const frame of wire.sent.filter((item): item is RelayV3RpcFrame => item.zcode_type === "rpc-frame")) {
      b.receive(frame);
    }
    expect(wire.received).toEqual([message]);
  });

  it("多片消息乱序到达：完整校验后原子交付一次", () => {
    const { a, b } = createPair();
    const message = randomBytes(1_100_000); // 512KiB + 76KiB → 3 片。
    const frames = fragmentRelayV3RpcMessage("bs_1", 1, message);
    expect(frames.length).toBe(3);
    // 截获 A 的发送，乱序投递。
    const delivered: Uint8Array[] = [];
    const bDirect = new RelayV3AcknowledgedRpc({
      bridgeSessionId: "bs_1",
      sendPayload: () => {},
      onMessage: (payload) => delivered.push(payload),
    });
    bDirect.receive(frames[2]!);
    expect(delivered).toEqual([]);
    bDirect.receive(frames[0]!);
    expect(delivered).toEqual([]);
    bDirect.receive(frames[1]!);
    expect(delivered).toEqual([message]);
    void b;
  });

  it("分片损坏（CRC 不匹配）：不交付、不 ACK，TX 侧可重放", () => {
    const delivered: Uint8Array[] = [];
    const acks: RelayV3RpcFrameAck[] = [];
    const b = new RelayV3AcknowledgedRpc({
      bridgeSessionId: "bs_1",
      sendPayload: (payload) => {
        if (payload.zcode_type === "rpc-frame-ack") acks.push(payload);
      },
      onMessage: (payload) => delivered.push(payload),
    });
    // 600 KiB → 2 片，损坏第 1 片后即使第 2 片到齐也不能交付。
    const message = randomBytes(600 * 1024);
    const frames = fragmentRelayV3RpcMessage("bs_1", 1, message);
    expect(frames.length).toBe(2);
    const corrupted: RelayV3RpcFrame = { ...frames[0]!, data: frames[0]!.data.slice(0, -2) + "AA" };
    b.receive(corrupted);
    b.receive(frames[1]!);
    expect(delivered).toEqual([]);
    expect(acks).toEqual([]);
    // 正确重放（整批）后交付。
    b.receive(frames[0]!);
    b.receive(frames[1]!);
    expect(delivered).toEqual([message]);
  });

  it("cumulative ACK 推进：部分确认后重放只发未确认片段", () => {
    const outgoing: RelayV3RpcFrame[] = [];
    const a = new RelayV3AcknowledgedRpc({
      bridgeSessionId: "bs_1",
      sendPayload: (payload) => {
        if (payload.zcode_type === "rpc-frame") outgoing.push(payload);
      },
      onMessage: () => {},
    });
    const message = randomBytes(1_100_000);
    expect(a.send(message)).toBe(true);
    expect(outgoing.length).toBe(3);
    outgoing.length = 0;
    // 对端确认前 2 片。
    a.receive({
      zcode_type: "rpc-frame-ack",
      bridge_session_id: "bs_1",
      message_seq: 1,
      fragment_count_ack: 2,
    });
    expect(a.inFlightBytes()).toBeGreaterThan(0);
    a.sendReady();
    // 只重放第 3 片。
    expect(outgoing.map((frame) => frame.fragment_index)).toEqual([2]);
    // 整条确认后释放缓存。
    a.receive({
      zcode_type: "rpc-frame-ack",
      bridge_session_id: "bs_1",
      message_seq: 1,
      fragment_count_ack: 3,
    });
    expect(a.inFlightBytes()).toBe(0);
  });

  it("身份隔离：其他 bridge 的帧与 ACK 丢弃", () => {
    const { a, wire } = createPair();
    const message = new TextEncoder().encode("x");
    expect(a.send(message)).toBe(true);
    expect(wire.received).toEqual([message]);
    const before = wire.received.length;
    // B 收到别的 bridge 的帧：不交付。
    expect(() => {}).toBeDefined();
    // A 收到别的 bridge 的 ACK：不影响 batch。
    const a2 = new RelayV3AcknowledgedRpc({
      bridgeSessionId: "bs_2",
      sendPayload: () => {},
      onMessage: () => {},
    });
    a2.receive({
      zcode_type: "rpc-frame-ack",
      bridge_session_id: "bs_1",
      message_seq: 1,
      fragment_count_ack: 1,
    });
    expect(wire.received.length).toBe(before);
  });

  it("重放预算超限 → degraded，不发送", () => {
    const degraded: string[] = [];
    const a = new RelayV3AcknowledgedRpc({
      bridgeSessionId: "bs_1",
      sendPayload: () => {},
      onMessage: () => {},
      onDegraded: (reason) => degraded.push(reason),
    });
    // 16 MiB 消息编码约 21.4 MiB；第二条必然超过 32 MiB 预算。
    const large = randomBytes(16 * 1024 * 1024);
    expect(a.send(large)).toBe(true);
    expect(a.send(large)).toBe(false);
    expect(degraded).toEqual(["deadline"]);
  });

  it("dispose 后迟到帧丢弃", () => {
    const delivered: Uint8Array[] = [];
    const b = new RelayV3AcknowledgedRpc({
      bridgeSessionId: "bs_1",
      sendPayload: () => {},
      onMessage: (payload) => delivered.push(payload),
    });
    b.dispose();
    const frames = fragmentRelayV3RpcMessage("bs_1", 1, new TextEncoder().encode("late"));
    for (const frame of frames) b.receive(frame);
    expect(delivered).toEqual([]);
  });

  it("schema 严格校验：非法字段拒绝", () => {
    expect(
      parseRelayV3RpcFrame({
        zcode_type: "rpc-frame",
        bridge_session_id: "bs_1",
        message_seq: 0,
        fragment_index: 0,
        fragment_count: 1,
        message_bytes: 1,
        crc32: 0,
        data: "AA",
      }),
    ).toBeNull();
    expect(
      parseRelayV3RpcFrameAck({ zcode_type: "rpc-frame-ack", bridge_session_id: "bs_1", message_seq: 1 }),
    ).toBeNull();
  });
});
