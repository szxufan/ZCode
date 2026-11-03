import { describe, expect, it } from "vitest";

import {
  decodeBase64Url,
  encodeBase64Url,
  fragmentRelayV3ChunkStream,
  parseRelayV3ChunkControl,
  parseRelayV3ChunkFrame,
  RelayV3ChunkAssembler,
  RelayV3ChunkProtocolError,
  RELAY_V3_CHUNK_FRAME_BYTES,
  RELAY_V3_CHUNK_STREAM_MAX_BYTES,
} from "@zcode/shared/remote-relay-v3";

// R4 分块帧（docs/relay-server/relay-v3-data-plane.md §2/§4/§8）：
// 往返、乱序/重复、单帧与整流 CRC 拦截、断点锚点、准入与控制帧解析。

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, length)));
  }
  return bytes;
}

describe("Relay V3 chunk-frame（R4）", () => {
  it("多片往返：final 整流 CRC 通过，resumeOffset 推进到总量", () => {
    const total = RELAY_V3_CHUNK_FRAME_BYTES + 1000;
    const stream = randomBytes(total);
    const frames = fragmentRelayV3ChunkStream("s1", total, (offset, length) =>
      stream.subarray(offset, offset + length),
    );
    expect(frames.length).toBe(2);
    expect(frames[1]!.flags).toBe("final");

    const received: Uint8Array[] = [];
    const assembler = new RelayV3ChunkAssembler("s1", total, (offset, bytes) => {
      received.push(bytes);
    });
    for (const frame of frames) {
      expect(assembler.receive(frame)).toBe(true);
    }
    const state = assembler.getState();
    expect(state.completed).toBe(true);
    expect(state.resumeOffset).toBe(total);
    expect(state.receivedBytes).toBe(total);
  });

  it("单帧 CRC 损坏 → crc-mismatch；重复帧幂等跳过", () => {
    const stream = randomBytes(64);
    const frames = fragmentRelayV3ChunkStream("s2", 64, (offset, length) => stream.subarray(offset, offset + length));
    const assembler = new RelayV3ChunkAssembler("s2", 64, () => {});
    const corrupted = { ...frames[0]!, data: encodeBase64Url(randomBytes(32)) };
    expect(() => assembler.receive(corrupted)).toThrow(RelayV3ChunkProtocolError);
    // 正确帧 + 重复投递（续传窗口）：第二次幂等跳过。
    expect(assembler.receive(frames[0]!)).toBe(true);
    expect(assembler.receive(frames[0]!)).toBe(true);
  });

  it("seq 超前 → seq-regression（按 reset 处理）", () => {
    const frames = fragmentRelayV3ChunkStream("s3", RELAY_V3_CHUNK_FRAME_BYTES + 8, (o, l) =>
      randomBytes(l),
    );
    const assembler = new RelayV3ChunkAssembler("s3", RELAY_V3_CHUNK_FRAME_BYTES + 8, () => {});
    expect(() => assembler.receive(frames[1]!)).toThrow(RelayV3ChunkProtocolError);
  });

  it("准入：total 超预算 → oversize", () => {
    expect(() =>
      fragmentRelayV3ChunkStream("s4", RELAY_V3_CHUNK_STREAM_MAX_BYTES + 1, () => new Uint8Array()),
    ).toThrow(RelayV3ChunkProtocolError);
    expect(() => fragmentRelayV3ChunkStream("s4", 0, () => new Uint8Array())).toThrow(
      RelayV3ChunkProtocolError,
    );
  });

  it("reset 清零状态（断点续传从 0 重新协商）", () => {
    const stream = randomBytes(128);
    const frames = fragmentRelayV3ChunkStream("s5", 128, (o, l) => stream.subarray(o, o + l));
    const assembler = new RelayV3ChunkAssembler("s5", 128, () => {});
    assembler.receive(frames[0]!);
    expect(assembler.getState().resumeOffset).toBe(128);
    assembler.reset();
    expect(assembler.getState().resumeOffset).toBe(0);
    expect(assembler.getState().completed).toBe(false);
  });

  it("schema 严格：非法 chunk-frame / 控制帧拒绝", () => {
    expect(
      parseRelayV3ChunkFrame({
        zcode_type: "chunk-frame",
        stream_id: "not-a-uuid",
        seq: 0,
        flags: "data",
        total_bytes: 10,
        crc32: 0,
        offset: 0,
        data: "AA",
      }),
    ).toBeNull();
    expect(
      parseRelayV3ChunkControl({ zcode_type: "chunk-credit", stream_id: "0b6bbf85-8895-4f70-9d2c-956bbf80b4d4", grant: 0 }),
    ).toBeNull();
    expect(
      parseRelayV3ChunkControl({ zcode_type: "chunk-resume", stream_id: "0b6bbf85-8895-4f70-9d2c-956bbf80b4d4", offset: 512 }),
    ).not.toBeNull();
  });

  it("base64url 编解码往返", () => {
    const bytes = randomBytes(777);
    expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
  });
});
