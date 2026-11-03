import { defineRelayV3ConsistencyMatrix } from "@zcode/shared/testing/relay-v3-consistency";

import { startTestRelay } from "./helpers.js";

// P0 验收：同一套一致性矩阵回放真实 relay-server 实现（与 fake-relay-v3 共用，
// docs/relay-server/relay-v3-design.md §9）。握手 deadline / ping 超时依赖真实
// 计时器，由 ws/relayWs.ts 的 15s/45s 编译期常量约束，不在矩阵内。

defineRelayV3ConsistencyMatrix(async () => {
  const relay = await startTestRelay();
  return {
    target: { httpUrl: relay.httpUrl, wsUrl: relay.wsUrl, smsCode: relay.smsCode },
    cleanup: () => relay.close(),
  };
});
