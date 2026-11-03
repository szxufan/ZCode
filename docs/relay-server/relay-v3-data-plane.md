# Relay V3 数据面扩展：分块帧、流控与断点续传（R4 Spec）

状态：已实现（shared 分块帧模块 + daemon 设备授权接入 + 远端任务事件推送）；局域网直连模式为后续增强（见 §5）。本 spec 是 [Relay V3 总设计](./relay-v3-design.md) §9 R4「数据面协议扩展」的展开，实现随行为变更同步更新。

## 1. 背景与范围

R3/R4 的文件传输（上传/下载/工作区产物）此前受两条约束：

1. JSON 信封约束：业务 RPC 走 `rpc-frame` 分片（16 MiB logical / 1 MiB 物理 JSON 帧），大文件需要整块 base64 进入 RPC 参数，膨胀 4/3 且无断点。
2. 单条消息预算：`data` 消息含密文膨胀上限 1 MiB（§4.4/§8），文件字节流不适合逐条塞入。

本 spec 定义**二进制分块帧**：文件字节流独立成帧，与 JSON 业务信封并行，经同一条 E2E 加密 data 通道传输（不另建连接、不新增信任边界）。

范围：

- 文件上传/下载的分块传输、流控、CRC 校验、断点续传。
- 远端任务事件（完成/权限请求）经 relay 推送为控制端一等通知。
- 终端流（PTY）保持既有 JSON 信封（小帧，不迁移）。

非目标：多 terminal 扇出（总设计 §10.6）；跨 relay 的直连 P2P NAT 穿透。

## 2. 分块帧格式

分块帧承载于 `data` 消息的密文信封内（§4.5 不变），明文 JSON 为：

```json
{
  "zcode_type": "chunk-frame",
  "stream_id": "<UUID>",
  "seq": 42,
  "flags": "data|final|reset",
  "total_bytes": 104857600,
  "crc32": 2917448214,
  "offset": 22020096,
  "data": "<base64url，≤ 512 KiB>"
}
```

字段语义：

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `stream_id` | UUID | 一次传输会话；上传/下载各自新建，不复用 |
| `seq` | 从 0 单调递增 | 帧序号；乱序/回退按 reset 处理 |
| `flags` | `data` / `final` / `reset` | `final` 携带整流 CRC32；`reset` 丢弃已收数据（错误恢复） |
| `total_bytes` | final 前每帧携带 | 总字节数（进度展示与准入校验） |
| `crc32` | IEEE 802.3 | 单帧 CRC（`data` 帧）或整流 CRC（`final` 帧） |
| `offset` | 字节偏移 | 断点续传锚点：接收方持久化 highest offset+1，重连从该 offset 请求续传 |
| `data` | base64url ≤ 512 KiB（原始字节） | 单帧 512 KiB：密文+JSON 膨胀后约 700 KiB < 1 MiB 预算 |

传输方向：双向对称（daemon→控制端为下载；控制端→daemon 为上传）。

## 3. 会话密钥分域

分块帧与业务 RPC 共用 transport 的 E2E 会话密钥（X25519+HKDF，§4.3），**不做二次派生**：

- 分块帧是业务 payload 的一种（`zcode_type` 区分），不是独立通道。
- 完整性由两层保证：单帧 CRC32（传输层快速丢弃）+ 整流 CRC32（final 校验）。
- 密钥轮换（重配对）时 stream 失效：接收方对旧 stream_id 的帧回 `reset`，发起方从持久化 offset 重新协商。

## 4. 流控与断点续传

- **信用窗口**：接收方在应用层维护 `granted` 计数（初始 8 帧）；每消费 N 帧回 `{zcode_type: "chunk-credit", stream_id, grant: N}`。发送方无信用时暂停，不超发。窗口大小为编译期常量，不做带宽自适应。
- **断点续传**：接收方把 `(stream_id → highest_offset)` 持久化到传输会话本地（daemon 落 server root；控制端落内存，刷新页面即重传）。发起方收到 `{zcode_type: "chunk-resume", stream_id, offset}` 后从该 offset 续发，`seq` 重置为该 offset 对应帧号。
- **超时**：单 stream 60s 无帧且未 final → 双方各自 reset；final 整流 CRC 不符 → reset 重传（从持久化 offset，避免整流重来）。
- **准入**：total_bytes 超过 per-stream 预算（默认 4 GiB）在发起侧拒绝，不进入传输。

## 5. 局域网直连模式（后续增强）

relay 不可用或大文件场景的兜底：daemon 在授权时经 E2E 通道上报局域网候选地址（mDNS/网段探测），控制端优先直连（同一套分块帧、同一会话密钥、TLS 双向认证以设备公钥为身份）。本期不实现，接口设计不预设阻碍（stream_id/offset 语义与承载无关）。

## 6. 远端任务事件推送

daemon 侧 runtime 的任务完成/权限请求事件，经 device transport 的 data 通道推送：

```json
{ "zcode_type": "device-event", "event": "task-completed | permission-requested", "task_id": "...", "payload": { ... } }
```

控制端（桌面/手机）收到后映射为本地系统通知/应用内通知；不回写业务状态（owner 仍在 daemon runtime，§6.3 边界）。

## 7. 实现落点

| 模块 | 位置 |
| --- | --- |
| 分块帧 schema/编解码/信用窗口/续传状态 | `packages/shared/src/remote-relay-v3/chunk-frame.ts` |
| daemon 设备授权接入（`zcode server login`） | `packages/zcode-server-cli/src/cli.ts` + `src/relay-v3/` |
| daemon device transport | `packages/zcode-server-cli/src/relay-v3/deviceTransport.ts` |
| 控制端通知映射 | `packages/ui/src/remote-relay-v3/`（device-event 消费） |

## 8. 验收

- 分块帧单测：往返、乱序 reset、单帧/整流 CRC 拦截、信用窗口暂停/恢复、断点续传（offset 恢复）、60s 超时 reset、4 GiB 准入拒绝。
- 设备授权端到端：request → 批准（含指纹核对）→ poll 交付凭据 → daemon 以 device 角色上线 → 控制端 attach（relay 侧 §5.5 测试 + fixture 已覆盖协议面）。
- 弱网续传：中断后从持久化 offset 恢复，不整流重传。
- R3 外壳退役迁移：见总设计 §9 R4（SSH 降级为便利路径）。
