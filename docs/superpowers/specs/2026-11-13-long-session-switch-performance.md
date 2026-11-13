# 性能：长会话切换加载慢修复

用户反馈（2026-11-13）：切换会话时加载会话内容特别慢，轮数很多的会话最明显。只读调查确认这不是“消息 DOM 没有虚拟化”的单点问题：正文时间线已按 turn 虚拟化，慢来自冷恢复全量重放、宽屏问题目录自动拉全正文、以及观测缺口掩盖的三段成本。

## 已确认根因

1. **historyFirst 冷打开在首帧前物化完整历史**：`v4/conversation/subscribe` 的 wire 首帧只有 60 行，但 CLI 先完整读取 message/part、选择有效分支、合成 durable transcript 并重建 projection。PERF03-E（10,623 messages / 35,811 parts / 30,500 rows）在本机四次实测，merge + rehydrate 为 2.11–2.99s，中位约 2.40s。runtime-ready 后第二次 `forceRebuild` 还会重复 durable transcript 合成与 file-change artifact 扫描。
2. **宽屏问题目录自动补齐全正文**：会话容器宽度 >= 864px 时，无需用户展开目录即触发 `loadAllOlder()`；renderer 按 200 行一页循环 `rows/range` 并把全部正文 rows 合入本地 projection。CLI 每页先复制完整 rows、再按 `beforeRowId` 过滤、最后 `slice(-limit)`，拉全历史总扫描接近 O(N²/200)。
3. **观测缺口**：CLI history-first ACK 已产出 `historyReadyMs`，但 ARMS result 未映射；`persistedMessageCount` / `snapshotBytes` 只有 payload 字段没有生产者；目录补拉终态只存在于组件 ref 与 debug 日志，无法回答“切换后内容何时稳定”。行高缓存按组件实例持有并在切会话时清空，A→B→A 快速切换仍要全量重测。

## 目标

- historyFirst 同一 opening 内复用 pass 1 的 durable transcript artifact；pass 2 只重算 memory integration，并保留权威 `publisher.rehydrate` 与 ready 对齐语义。
- `rows/range` 按 rowId 升序不变量二分定位，单页 O(log N + limit)，不再整窗复制。
- 问题目录改为服务端轻量分页：只拉 query 元数据与截断预览，不把全正文 rows 自动拉进 renderer；点击未加载条目时按需补拉到目标。
- ARMS 补齐 history-first 首屏阶段、首帧字节数/行数与目录 settled 事件。
- Renderer 行高测量跨会话共享，同布局 A→B→A 切换免重测。

## 非目标

- 不做 SQLite message/part tail-first 分页查询，不改 `SessionStorePort.messages` 合同。
- 不引入持久 projection checkpoint 或 store-backed lazy range（V4HYD-07 另行立项）。
- 不跳过 runtime-ready 后的第二次 `publisher.rehydrate`，不把 memory events 改成 append-only 增量。
- 不在 pass 1 伪造 contextWindow、usage 或模型可执行状态。
- 不为问题目录建立第二事实源或订阅状态；目录永远是 CLI 当前有效 projection 的只读派生。

## Owner 与事件顺序

### historyFirst durable artifact 复用

Owner：CLI bridge 的单次 historyFirst opening。缓存是 opening-local `WeakMap<MessageWithParts[], DurableArtifact>`，不落盘、不加 TTL、不跨 opening 复用。

```text
M0 全量 messages（仍只调用一次 store.messages）
  → pass 1（首帧前，无 record）
      build durable artifact（durable messages / goal entries / target / turn+boundary 索引 / transcript events）
      → integrate memory=[] → publisher.rehydrate → 60 行首帧
  → runtime resume
  → pass 2（record 已入册）
      M0 引用相等 且 非 compact reload 且 非 retry 且 memory authority turns 不与 durable messages 冲突 且 target/entries 关键事实未变
        → 复用 durable artifact
        → patch contextWindow / fileChanges payload
        → 重新 integrate memory events（保持 hook/boundary 插入与重排语义）
      任一失效条件命中
        → 走完整旧路径重建 artifact
  → publisher.rehydrate（现有收敛 delta / resync 语义不变）
  → usage / config / subagents seeds + raw tail 对齐 → READY
```

file-change artifact 扫描只在 memory events 含可用 ModelComplete/checkpoint 事实时执行；冷重启 resume-only 事件集直接跳过。`readSessionContextUsage` 与 `listSessionSubagents` 继续共享同一 M0，不新增读取路径。

`target` 的 own property（含显式 `null`）只作为持久 authority 用于压制内存 `TargetChanged` 与复用判定；`null` 不产生替身 goal 事件，保证所有冷恢复路径与旧 merge 逐字段等价。

### 问题目录轻量分页

事实 owner：CLI `ProductProjection`。renderer 只保存目录展示态（页累积条目、hydration 终态、busy 标记），不保存第二份会话事实。

```text
宽度 >= 864px（只裁决资格，rail 显隐仍由 CSS container query 决定）
  → hydration effect → store.hydrateTurnNavigatorDirectory()
      → v4/conversation/queries 分页（只读、无状态、超时重发安全）
      → CLI 从完整有效 projection 反向扫描 realUser query，返回元数据 + 220 字截断预览
      → 单次提交目录 items；snapshot.rows.window 不变
  点击未加载目录项
      → store.loadOlderUntil(rowId)（复用 rows/range + mergeOlderRows + prepend 锚定）
      → 现有虚拟挂载与 rAF 精确对齐
  普通向上滚动 prefetch / HLP01 首 turn 补齐：仍走单窗 loadOlder，不受目录影响
```

防陈旧规则沿用 rows/range 家族：页结果携带 `atSeq/atRevision/atLogEpoch`；accumulation 期间 epoch 或首行游标失效则整目录丢弃；`directoryRevision` 因 realUser 增删、`row.removed` 或 snapshot 替换递增后终态缓存失效并允许重新探测。旧 CLI 返回 method-not-found 时终态为 `unsupported`，目录只覆盖已加载窗口，禁止回退到全量补拉。

### 行高缓存

Owner：Renderer 本地派生测量缓存。模块级共享 LRU，总上限仍 4000 条；key 为 `sessionKey + turnId + layoutScopeKey`，不进入服务端事实、不持久化。宽度/布局变化通过 `layoutScopeKey` 隔离，真实测量仍由 ResizeObserver 收敛。

## 协议

新增只读 query（不新增 command，不建立订阅状态）：

- `v4/conversation/queries`
  - Params：`{ workspace?, sessionId, beforeRowId?, limit? }`
  - Result：`{ queries: [{ rowId, turnId, entityId?, userPreview, assistantPreview, assistantPreviewKind, isRunning }], atSeq, atRevision, atLogEpoch, hasMore }`
- `queries` 按 rowId 升序返回当前页；`beforeRowId` 语义与 `rows/range` 一致（严格小于）。
- 每页（含最后一页）最多 `limit` 条；同一 product turn 被 `beforeRowId` 截断时，较早 query 的
  `assistantPreview` 仍从完整 turn 的 assistant 正文派生，不因跨页退化为空。
- 不返回 `totalQueries`：每页全量计数会重新引入 O(N²)；`not-enough-queries` 由最多前两页结果判定。
- 旧 CLI method-not-found 属于正常偏斜；新 CLI 对旧桌面不暴露新调用。

`rows/range` wire 合同不变，仅实现改为二分；`filterConversationRowsForProfile` 对 rows 窗口提供只读直通，两个 delivery profile 的终态一致收口不变。

## 遥测

- `perf_ui_session_open_result` 补映射：
  - `history_ready_ms` 来自 CLI ACK `historyReadyMs`；
  - `persisted_message_count` 来自本次 opening 的 M0 数量；
  - `snapshot_bytes` 复用 publisher 既有 wire snapshot 字节测量/上界，不额外 stringify 全量 snapshot；
  - `snapshot_row_count` 改为实际 wire tail row 数。
- 新增 `perf_ui_session_directory_settled`（与 session_open_id 关联）：
  - `directory_status`: `hydrated | not-enough-queries | unsupported | retry-exhausted | stale | ineligible`
  - `settled_ms`、`loaded_row_count`、`total_row_count`
- 所有新增字段只能是计数、字节数、枚举与耗时；session 正文、workspace path/identity、prompt、工具输入输出、MCP server 名称与 Skill 正文不得进入 ARMS。目录预览文本只存在于 Renderer DOM，不上报。

## 验收

- CLI golden：cold merge 拆分后与旧实现逐字段等价；rows/range 二分与旧 filter 扫描在随机窗口下逐行一致。
- historyFirst：正常路径 `store.messages()` 仍 1 次；pass 2 durable transcript 合成与 artifact 扫描命中复用；compact reload、retry、authority-turn 冲突、target 变化走完整重建。
- 宽屏长会话：目录 item 覆盖完整 realUser query 集合，`data-window-row-count` 保持尾窗约 60 且不自动增长；点击最旧 query 后按需补拉到目标、目标可见、active 更新、滚动锚定稳定。
- 普通向上滚动与 HLP01 首 turn 补齐行为不回归。
- E2E 能读到 `history_ready_ms`、`persisted_message_count`、`snapshot_bytes`、wire tail `snapshot_row_count` 与 directory settled 事件。
- PERF03-E opt-in 输出 pass 1 / pass 2 merge 分段，pass 2 显著低于 pass 1；不写跨机器绝对墙钟阈值。

## 架构

- 新 shared 纯逻辑放入现有 `packages/shared/src/zcode-protocol-v4/` 管理模块，经公开入口导出；不新建跨层模块。
- CLI 实现位于 bootstrap 现有 materialization / publisher / gateway / server 文件；不引入存储 schema 或 migration。
- services 只做只读 query 透传，沿用 `conversationPlansV4` 模式，不承载目录状态。
- UI 改动位于现有 v4 store / transport / timeline / navigator 文件；不直接调用 `window.zcode`，不绕过 hooks 服务层。
