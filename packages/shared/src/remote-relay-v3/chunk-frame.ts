import { z } from "zod";

import { relayV3Crc32, relayV3Crc32Finalize, relayV3Crc32Update } from "./rpc-frame.js";

// Relay V3 数据面分块帧（R4，docs/relay-server/relay-v3-data-plane.md §2/§4）：
// 文件字节流独立成帧，与 JSON 业务信封并行，经同一条 E2E 加密 data 通道传输。
// 终端流（PTY）保持既有 JSON 信封，不迁移。分块帧是业务 payload 的一种，
// 不做二次密钥派生（§3）：单帧 CRC32 + final 整流 CRC32 两层完整性。

/** 单帧原始字节上限（§2）：密文+JSON 膨胀后约 700 KiB < 1 MiB 预算。 */
export const RELAY_V3_CHUNK_FRAME_BYTES = 512 * 1024;
/** 信用窗口初始值（§4）：编译期常量，不做带宽自适应。 */
export const RELAY_V3_CHUNK_CREDIT_WINDOW = 8;
/** 单 stream 无帧超时（§4）。 */
export const RELAY_V3_CHUNK_STREAM_TIMEOUT_MS = 60_000;
/** 单 stream 总字节准入预算（§4）。 */
export const RELAY_V3_CHUNK_STREAM_MAX_BYTES = 4 * 1024 * 1024 * 1024;

const streamId = z.string().uuid();
const base64UrlData = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const relayV3ChunkFrame = z.strictObject({
  zcode_type: z.literal("chunk-frame"),
  stream_id: streamId,
  seq: z.number().int().min(0),
  flags: z.enum(["data", "final", "reset"]),
  total_bytes: z.number().int().min(1).max(RELAY_V3_CHUNK_STREAM_MAX_BYTES),
  crc32: z.number().int().min(0).max(0xffff_ffff),
  offset: z.number().int().min(0),
  data: base64UrlData,
});
export type RelayV3ChunkFrame = z.infer<typeof relayV3ChunkFrame>;

export const relayV3ChunkCredit = z.strictObject({
  zcode_type: z.literal("chunk-credit"),
  stream_id: streamId,
  grant: z.number().int().positive(),
});
export type RelayV3ChunkCredit = z.infer<typeof relayV3ChunkCredit>;

export const relayV3ChunkResume = z.strictObject({
  zcode_type: z.literal("chunk-resume"),
  stream_id: streamId,
  offset: z.number().int().min(0),
});
export type RelayV3ChunkResume = z.infer<typeof relayV3ChunkResume>;

export const relayV3DeviceEvent = z.strictObject({
  zcode_type: z.literal("device-event"),
  event: z.enum(["task-completed", "permission-requested"]),
  task_id: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type RelayV3DeviceEvent = z.infer<typeof relayV3DeviceEvent>;

export function parseRelayV3ChunkFrame(value: unknown): RelayV3ChunkFrame | null {
  const result = relayV3ChunkFrame.safeParse(value);
  return result.success ? result.data : null;
}

export function parseRelayV3ChunkControl(value: unknown): RelayV3ChunkCredit | RelayV3ChunkResume | null {
  const credit = relayV3ChunkCredit.safeParse(value);
  if (credit.success) return credit.data;
  const resume = relayV3ChunkResume.safeParse(value);
  if (resume.success) return resume.data;
  return null;
}

export class RelayV3ChunkProtocolError extends Error {
  constructor(readonly kind: "oversize" | "seq-regression" | "crc-mismatch" | "stream-reset") {
    super(kind);
    this.name = "RelayV3ChunkProtocolError";
  }
}

/** 发送侧：把字节流切成 final 标记完整的帧序列（含单帧与整流 CRC）。 */
export function fragmentRelayV3ChunkStream(
  streamIdValue: string,
  totalBytes: number,
  read: (offset: number, length: number) => Uint8Array,
): RelayV3ChunkFrame[] {
  if (totalBytes <= 0 || totalBytes > RELAY_V3_CHUNK_STREAM_MAX_BYTES) {
    throw new RelayV3ChunkProtocolError("oversize");
  }
  const frameCount = Math.ceil(totalBytes / RELAY_V3_CHUNK_FRAME_BYTES);
  const frames: RelayV3ChunkFrame[] = [];
  const whole = new Uint8Array(totalBytes);
  for (let index = 0; index < frameCount; index += 1) {
    const offset = index * RELAY_V3_CHUNK_FRAME_BYTES;
    const chunk = read(offset, Math.min(RELAY_V3_CHUNK_FRAME_BYTES, totalBytes - offset));
    whole.set(chunk, offset);
    frames.push({
      zcode_type: "chunk-frame",
      stream_id: streamIdValue,
      seq: index,
      flags: index === frameCount - 1 ? "final" : "data",
      total_bytes: totalBytes,
      crc32: relayV3Crc32(chunk),
      offset,
      data: encodeBase64Url(chunk),
    });
  }
  // final 帧的 crc32 语义是整流 CRC（§2）：覆盖全量字节。
  if (frames.length > 0) {
    frames[frames.length - 1]!.crc32 = relayV3Crc32(whole);
  }
  return frames;
}

export interface RelayV3ChunkAssemblerState {
  streamId: string;
  totalBytes: number;
  receivedBytes: number;
  /** 已确认连续到达的最高 offset+1（断点续传锚点，§4）。 */
  resumeOffset: number;
  completed: boolean;
}

/**
 * 接收侧组装器：顺序校验、单帧 CRC、final 整流 CRC；乱序/回退按 reset。
 * 整流 CRC 增量计算（不缓存全量字节——大文件不进内存两份）；字节经 onChunk
 * 流式交付，业务层自行落盘。
 */
export class RelayV3ChunkAssembler {
  private nextSeq = 0;
  private state: RelayV3ChunkAssemblerState;
  /** 增量整流 CRC 的中间状态（IEEE 802.3：初始/终值反转）。 */
  private wholeCrc = 0xffff_ffff;

  constructor(
    streamIdValue: string,
    totalBytes: number,
    private readonly onChunk: (offset: number, bytes: Uint8Array) => void,
  ) {
    this.state = { streamId: streamIdValue, totalBytes, receivedBytes: 0, resumeOffset: 0, completed: false };
  }

  getState(): RelayV3ChunkAssemblerState {
    return { ...this.state };
  }

  /** 收到一帧；返回 false 表示流被 reset（调用方应丢弃已收数据）。 */
  receive(frame: RelayV3ChunkFrame): boolean {
    if (frame.stream_id !== this.state.streamId) return false;
    if (frame.seq !== this.nextSeq) {
      if (frame.seq < this.nextSeq) {
        // 重复帧（续传窗口内）：幂等跳过。
        return true;
      }
      throw new RelayV3ChunkProtocolError("seq-regression");
    }
    if (frame.total_bytes !== this.state.totalBytes) {
      throw new RelayV3ChunkProtocolError("stream-reset");
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64Url(frame.data);
    } catch {
      throw new RelayV3ChunkProtocolError("crc-mismatch");
    }
    if (frame.flags !== "final" && relayV3Crc32(bytes) !== frame.crc32) {
      throw new RelayV3ChunkProtocolError("crc-mismatch");
    }
    this.nextSeq += 1;
    this.state.receivedBytes += bytes.length;
    this.state.resumeOffset = frame.offset + bytes.length;
    this.wholeCrc = relayV3Crc32Update(this.wholeCrc, bytes);
    this.onChunk(frame.offset, bytes);
    if (frame.flags === "final") {
      if (relayV3Crc32Finalize(this.wholeCrc) !== frame.crc32) {
        throw new RelayV3ChunkProtocolError("crc-mismatch");
      }
      this.state.completed = true;
    }
    return true;
  }

  reset(): void {
    this.nextSeq = 0;
    this.wholeCrc = 0xffff_ffff;
    this.state = {
      streamId: this.state.streamId,
      totalBytes: this.state.totalBytes,
      receivedBytes: 0,
      resumeOffset: 0,
      completed: false,
    };
  }
}

// base64url 编解码与 crypto.ts 同实现；此处内联避免把加密模块的导出面扩到分块帧消费者。
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeBase64Url(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index] ?? 0;
    const byte1 = bytes[index + 1];
    const byte2 = bytes[index + 2];
    result += ALPHABET[byte0 >> 2];
    result += ALPHABET[((byte0 & 0x03) << 4) | ((byte1 ?? 0) >> 4)];
    if (byte1 === undefined) break;
    result += ALPHABET[((byte1 & 0x0f) << 2) | ((byte2 ?? 0) >> 6)];
    if (byte2 === undefined) break;
    result += ALPHABET[byte2 & 0x3f];
  }
  return result;
}

export function decodeBase64Url(value: string): Uint8Array {
  const lookup: Record<string, number> = {};
  for (let index = 0; index < ALPHABET.length; index += 1) lookup[ALPHABET[index]!] = index;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const digit = lookup[char];
    if (digit === undefined) throw new Error("invalid base64url");
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
