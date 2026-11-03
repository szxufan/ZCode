import { z } from "zod";

import { decodeRelayV3Base64Url, encodeRelayV3Base64Url } from "./crypto.js";
import { RELAY_V3_MAX_DATA_MESSAGE_BYTES } from "./contract.js";

// Relay V3 rpc-frame 分片协议（V2 acknowledged adapter 语义在 V3 的重建，见
// docs/web-remote-control/web-remote-control-architecture.md §App Payload）：
// raw Channel message 不能整条塞进单个 data 消息，必须切成带
// messageSeq/fragmentIndex/fragmentCount/messageBytes/CRC32 的物理片；每片连最终
// {type:"data",payload,...} 未压缩 JSON ≤ 1 MiB。单 logical message 上限 16 MiB / 64 片，
// 接收侧一次只 staging 一个 message，完整校验后原子交付一次。rpc-frame-ack 是 raw
// transport 的 cumulative ACK，不是 command ACK。两端（device/terminal）使用同一实现。

export const RELAY_V3_RPC_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const RELAY_V3_RPC_MAX_FRAGMENT_COUNT = 64;
/** 每片原始字节 chunk：base64 后约 683 KiB，加 outer JSON 字段仍 < 1 MiB 预算。 */
export const RELAY_V3_RPC_FRAGMENT_CHUNK_BYTES = 512 * 1024;
/** TX 在途未确认 outer 字节的高/低水位（流控边沿）。 */
export const RELAY_V3_RPC_FLOW_HIGH_BYTES = RELAY_V3_MAX_DATA_MESSAGE_BYTES;
export const RELAY_V3_RPC_FLOW_LOW_BYTES = 256 * 1024;
/** 重放缓存预算：2 * maxMessageBytes（V2 2026-10-27 校正后的推导，容纳 16 MiB 编码批次）。 */
export const RELAY_V3_RPC_REPLAY_BUDGET_BYTES = 2 * RELAY_V3_RPC_MAX_MESSAGE_BYTES;
/** TX batch 无推进 / RX queued ACK 未 flush 的期限。 */
export const RELAY_V3_RPC_DEADLINE_MS = 45_000;

const identifier = z.string().min(1).max(256);

export const relayV3RpcFrame = z.strictObject({
  zcode_type: z.literal("rpc-frame"),
  bridge_session_id: identifier,
  message_seq: z.number().int().min(1),
  fragment_index: z.number().int().min(0),
  fragment_count: z.number().int().min(1).max(RELAY_V3_RPC_MAX_FRAGMENT_COUNT),
  message_bytes: z.number().int().min(1).max(RELAY_V3_RPC_MAX_MESSAGE_BYTES),
  crc32: z.number().int().min(0).max(0xffff_ffff),
  data: z.string().min(1),
});
export type RelayV3RpcFrame = z.infer<typeof relayV3RpcFrame>;

export const relayV3RpcFrameAck = z.strictObject({
  zcode_type: z.literal("rpc-frame-ack"),
  bridge_session_id: identifier,
  message_seq: z.number().int().min(1),
  /** cumulative：该 message_seq 已连续收到的片数（== fragment_count 即整条确认）。 */
  fragment_count_ack: z.number().int().min(1),
});
export type RelayV3RpcFrameAck = z.infer<typeof relayV3RpcFrameAck>;

export function parseRelayV3RpcFrame(value: unknown): RelayV3RpcFrame | null {
  const result = relayV3RpcFrame.safeParse(value);
  return result.success ? result.data : null;
}

export function parseRelayV3RpcFrameAck(value: unknown): RelayV3RpcFrameAck | null {
  const result = relayV3RpcFrameAck.safeParse(value);
  return result.success ? result.data : null;
}

export class RelayV3RpcProtocolError extends Error {
  constructor(readonly kind: "oversize" | "too-many-fragments" | "corrupt" | "budget-exceeded") {
    super(kind);
    this.name = "RelayV3RpcProtocolError";
  }
}

// ---------------------------------------------------------------------------
// CRC32（IEEE 802.3，ZIP/PNG 同款）：分片完整性的接收侧校验。
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function relayV3Crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** CRC32 增量更新：`finalize(crc32Update(crc32Update(0xffffffff, a), b)) === crc32(a‖b)`。 */
export function relayV3Crc32Update(crc: number, bytes: Uint8Array): number {
  let state = crc >>> 0;
  for (const byte of bytes) {
    state = CRC32_TABLE[(state ^ byte) & 0xff]! ^ (state >>> 8);
  }
  return state >>> 0;
}

/** CRC32 增量终值（反转）。 */
export function relayV3Crc32Finalize(crc: number): number {
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** 把 raw message 切成 fragment 集合；分片大小对齐 outer JSON ≤1 MiB 预算（含 base64 膨胀）。 */
export function fragmentRelayV3RpcMessage(
  bridgeSessionId: string,
  messageSeq: number,
  message: Uint8Array,
): RelayV3RpcFrame[] {
  if (message.length === 0 || message.length > RELAY_V3_RPC_MAX_MESSAGE_BYTES) {
    throw new RelayV3RpcProtocolError("oversize");
  }
  const fragmentCount = Math.ceil(message.length / RELAY_V3_RPC_FRAGMENT_CHUNK_BYTES);
  if (fragmentCount > RELAY_V3_RPC_MAX_FRAGMENT_COUNT) {
    throw new RelayV3RpcProtocolError("too-many-fragments");
  }
  const crc32 = relayV3Crc32(message);
  const frames: RelayV3RpcFrame[] = [];
  for (let index = 0; index < fragmentCount; index += 1) {
    const chunk = message.subarray(
      index * RELAY_V3_RPC_FRAGMENT_CHUNK_BYTES,
      Math.min((index + 1) * RELAY_V3_RPC_FRAGMENT_CHUNK_BYTES, message.length),
    );
    frames.push({
      zcode_type: "rpc-frame",
      bridge_session_id: bridgeSessionId,
      message_seq: messageSeq,
      fragment_index: index,
      fragment_count: fragmentCount,
      message_bytes: message.length,
      crc32,
      data: encodeRelayV3Base64Url(chunk),
    });
  }
  return frames;
}

interface ReplayBatch {
  frames: RelayV3RpcFrame[];
  /** 本批 outer JSON 字节预算（message_bytes 的保守编码上界：base64 4/3 + 字段开销）。 */
  encodedBytes: number;
  ackedFragments: number;
  firstSentAt: number;
  lastProgressAt: number;
}

export interface RelayV3AcknowledgedRpcOptions {
  bridgeSessionId: string;
  /** wire 发送回调（transport 注入：加密为 data 信封后经 relay 发出）。 */
  sendPayload: (payload: RelayV3RpcFrame | RelayV3RpcFrameAck) => void;
  /** 完整校验后原子交付 raw message。 */
  onMessage: (message: Uint8Array) => void;
  /** TX 在途跨越高水位 → 调用方暂停写入；回落低水位 → 恢复。 */
  onFlowChange?: (state: "saturated" | "drained") => void;
  /** 45s 无推进（TX 重放后仍无 ACK / RX ACK 无法 flush）→ bridge 硬恢复。 */
  onDegraded?: (reason: "deadline") => void;
  timing?: { now?: () => number };
}

/**
 * 单个 workspace bridge 的对称 acknowledged rpc 适配器（两端同用）。
 * TX：整批 immutable fragments + cumulative ACK + 同 bridge send-ready 重放；
 * RX：单 message staging、CRC 原子交付、ACK 优先 flush、已交付 seq 幂等去重。
 * 状态全部 bridge-scoped；dispose / degraded 后迟到帧一律丢弃。
 */
export class RelayV3AcknowledgedRpc {
  private readonly now: () => number;
  private nextSeq = 1;
  private readonly batches = new Map<number, ReplayBatch>();
  private replayBytes = 0;
  private saturated = false;
  private disposed = false;
  // RX staging：一次只保留一个未完成 message。
  private staging?: {
    seq: number;
    fragmentCount: number;
    messageBytes: number;
    crc32: number;
    received: (Uint8Array | undefined)[];
    receivedFragments: number;
  };
  private maxDeliveredSeq = 0;
  private lastQueuedAck?: { frame: RelayV3RpcFrameAck; queuedAt: number };

  constructor(private readonly options: RelayV3AcknowledgedRpcOptions) {
    this.now = options.timing?.now ?? (() => Date.now());
  }

  /** TX 入口：分片、缓存、逐片发出。bridge 未就绪/已废弃返回 false。 */
  send(message: Uint8Array): boolean {
    if (this.disposed) return false;
    const seq = this.nextSeq;
    let frames: RelayV3RpcFrame[];
    try {
      frames = fragmentRelayV3RpcMessage(this.options.bridgeSessionId, seq, message);
    } catch (error) {
      if (error instanceof RelayV3RpcProtocolError) {
        // 超限消息按 terminal fault 处理，不让单条输入拖垮 bridge 状态。
        this.options.onDegraded?.("deadline");
        return false;
      }
      throw error;
    }
    const encodedBytes = estimateEncodedBytes(frames);
    if (this.replayBytes + encodedBytes > RELAY_V3_RPC_REPLAY_BUDGET_BYTES) {
      this.options.onDegraded?.("deadline");
      return false;
    }
    this.nextSeq += 1;
    const batch: ReplayBatch = {
      frames,
      encodedBytes,
      ackedFragments: 0,
      firstSentAt: this.now(),
      lastProgressAt: this.now(),
    };
    this.batches.set(seq, batch);
    this.replayBytes += encodedBytes;
    this.emitBatch(batch);
    this.updateFlowState();
    return true;
  }

  /** 同 bridge 重新 send-ready（含 same-socket 心跳重确认 matched）时重放未 ACK batch。 */
  sendReady(): void {
    if (this.disposed) return;
    for (const batch of this.batches.values()) {
      this.emitBatch(batch);
    }
    this.flushQueuedAck();
  }

  /** wire 接收入口（transport 解密后按 zcode_type 分派到此）。 */
  receive(payload: RelayV3RpcFrame | RelayV3RpcFrameAck): void {
    if (this.disposed) return;
    if (payload.bridge_session_id !== this.options.bridgeSessionId) return;
    if (payload.zcode_type === "rpc-frame-ack") {
      this.applyAck(payload);
      return;
    }
    this.applyFrame(payload);
  }

  /** RX ACK flush 时机（delivery 成功后由调用方在下一拍调用；ACK 优先于新数据帧）。 */
  flushQueuedAck(): void {
    const queued = this.lastQueuedAck;
    this.lastQueuedAck = undefined;
    if (queued && this.now() - queued.queuedAt <= RELAY_V3_RPC_DEADLINE_MS && !this.disposed) {
      this.options.sendPayload(queued.frame);
    } else if (queued) {
      this.options.onDegraded?.("deadline");
    }
  }

  inFlightBytes(): number {
    return this.replayBytes;
  }

  isSaturated(): boolean {
    return this.saturated;
  }

  dispose(): void {
    this.disposed = true;
    this.batches.clear();
    this.replayBytes = 0;
    this.staging = undefined;
    this.lastQueuedAck = undefined;
  }

  // --- TX ---

  private emitBatch(batch: ReplayBatch): void {
    for (const frame of batch.frames) {
      // 从已确认位置之后重放（ACK 推进后不重复发送已确认片段）。
      if (frame.fragment_index < batch.ackedFragments) continue;
      this.options.sendPayload(frame);
    }
  }

  private applyAck(ack: RelayV3RpcFrameAck): void {
    const batch = this.batches.get(ack.message_seq);
    if (!batch) return; // 迟到 ACK（batch 已释放）：幂等忽略。
    if (ack.fragment_count_ack <= batch.ackedFragments) return; // 重复/乱序 ACK：不回退。
    batch.ackedFragments = ack.fragment_count_ack;
    batch.lastProgressAt = this.now();
    if (ack.fragment_count_ack >= batch.frames.length) {
      this.batches.delete(ack.message_seq);
      this.replayBytes -= batch.encodedBytes;
      this.updateFlowState();
    }
  }

  private updateFlowState(): void {
    const was = this.saturated;
    this.saturated = this.replayBytes > RELAY_V3_RPC_FLOW_HIGH_BYTES;
    if (this.saturated && !was) this.options.onFlowChange?.("saturated");
    if (!this.saturated && was && this.replayBytes <= RELAY_V3_RPC_FLOW_LOW_BYTES) {
      this.options.onFlowChange?.("drained");
    }
  }

  // --- RX ---

  private applyFrame(frame: RelayV3RpcFrame): void {
    // 已交付过的 seq：幂等丢弃并补 ACK（对端重放场景）。
    if (frame.message_seq <= this.maxDeliveredSeq) {
      this.queueAck(frame.message_seq, frame.fragment_count);
      return;
    }
    if (!this.staging || this.staging.seq !== frame.message_seq) {
      if (this.staging && this.staging.seq > frame.message_seq) return; // 迟到旧消息。
      this.staging = {
        seq: frame.message_seq,
        fragmentCount: frame.fragment_count,
        messageBytes: frame.message_bytes,
        crc32: frame.crc32,
        received: Array.from<Uint8Array | undefined>({ length: frame.fragment_count }),
        receivedFragments: 0,
      };
    }
    const staging = this.staging;
    if (
      staging.fragmentCount !== frame.fragment_count ||
      staging.messageBytes !== frame.message_bytes ||
      staging.crc32 !== frame.crc32 ||
      frame.fragment_index >= staging.fragmentCount
    ) {
      // 同 seq 元数据冲突：按 corrupt 处理，等待对端重放。
      this.staging = undefined;
      return;
    }
    if (staging.received[frame.fragment_index] !== undefined) return; // 重放片段去重。
    let chunk: Uint8Array;
    try {
      chunk = decodeRelayV3Base64Url(frame.data);
    } catch {
      return; // 非法 base64：丢弃该片段，靠对端 45s deadline 兜底。
    }
    staging.received[frame.fragment_index] = chunk;
    staging.receivedFragments += 1;
    if (staging.receivedFragments < staging.fragmentCount) return;

    const message = new Uint8Array(staging.messageBytes);
    let offset = 0;
    for (const part of staging.received) {
      // receivedFragments == fragmentCount 时槽位仍可能 undefined（重复覆盖语义不会发生），
      // 出现即视为不完整，交由下方完整性检查丢弃。
      if (!part) break;
      message.set(part, offset);
      offset += part.length;
    }
    this.staging = undefined;
    if (offset !== staging.messageBytes || relayV3Crc32(message) !== staging.crc32) {
      return; // 完整性失败：不交付、不 ACK；对端 deadline 后重放整批。
    }
    this.maxDeliveredSeq = staging.seq;
    this.options.onMessage(message);
    // 同步 delivery 成功后才排队 cumulative ACK；ACK 优先 flush。
    this.queueAck(staging.seq, staging.fragmentCount);
    this.flushQueuedAck();
  }

  private queueAck(messageSeq: number, fragmentCount: number): void {
    // 后续更高 cumulative ACK 只替换值，不刷新 age（V2 语义）。
    const previous = this.lastQueuedAck;
    this.lastQueuedAck = {
      frame: {
        zcode_type: "rpc-frame-ack",
        bridge_session_id: this.options.bridgeSessionId,
        message_seq: messageSeq,
        fragment_count_ack: fragmentCount,
      },
      queuedAt: previous?.queuedAt ?? this.now(),
    };
  }
}

function estimateEncodedBytes(frames: RelayV3RpcFrame[]): number {
  let bytes = 0;
  for (const frame of frames) {
    // frame.data 已是 base64 字符串：outer JSON 主体即其长度，另加固定字段开销上界。
    bytes += frame.data.length + 160;
  }
  return bytes;
}
