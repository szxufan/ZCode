// Relay V3 workspace bridge 的端口消息编码（两端同源）。
// Host attachment 的 MessagePort 上有两类消息（见 packages/rpc MessagePortProtocol）：
//   1. RPC binary（Uint8Array / VSBuffer）；
//   2. 流控 sideband 控制对象 {__zcodeRpcControl: "connection-flow-v1", state}。
// rpc-frame 通道只承载不透明字节；这里用 1 字节 kind 前缀区分两类消息，
// 避免整条 base64 膨胀（16 MiB RPC 预算不被编码吃掉）。

export type RelayV3BridgePortMessage =
  | { kind: "rpc"; bytes: Uint8Array }
  | { kind: "flow"; state: "high" | "low" };

const KIND_RPC = 0x00;
const KIND_FLOW = 0x01;

const FLOW_STATES = new Set(["high", "low"]);

export function encodeRelayV3BridgePortMessage(message: RelayV3BridgePortMessage): Uint8Array {
  if (message.kind === "rpc") {
    const encoded = new Uint8Array(message.bytes.length + 1);
    encoded[0] = KIND_RPC;
    encoded.set(message.bytes, 1);
    return encoded;
  }
  const json = new TextEncoder().encode(JSON.stringify({ state: message.state }));
  const encoded = new Uint8Array(json.length + 1);
  encoded[0] = KIND_FLOW;
  encoded.set(json, 1);
  return encoded;
}

export function decodeRelayV3BridgePortMessage(bytes: Uint8Array): RelayV3BridgePortMessage | null {
  if (bytes.length === 0) return null;
  const kind = bytes[0];
  const rest = bytes.subarray(1);
  if (kind === KIND_RPC) return { kind: "rpc", bytes: rest };
  if (kind === KIND_FLOW) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(rest)) as { state?: unknown };
      return typeof parsed.state === "string" && FLOW_STATES.has(parsed.state)
        ? { kind: "flow", state: parsed.state as "high" | "low" }
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** MessagePort 上的原始事件数据归一化：Uint8Array 为 RPC，控制对象为流控，其余丢弃。 */
export function relayV3BridgePortEventToMessage(data: unknown): RelayV3BridgePortMessage | null {
  if (data instanceof Uint8Array) return { kind: "rpc", bytes: data };
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    if (record.__zcodeRpcControl === "connection-flow-v1") {
      return typeof record.state === "string" && FLOW_STATES.has(record.state)
        ? { kind: "flow", state: record.state as "high" | "low" }
        : null;
    }
  }
  return null;
}
