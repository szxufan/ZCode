# Session 首次打开 ARMS 埋点

## 目标

记录桌面端 Renderer 从 pane acquire 一个已有 session，到首个权威 snapshot 完成渲染并可以输入之间的关键耗时，区分 Renderer、Window Host、CLI runtime 和历史 session 恢复阶段。当前实现把 pane acquire 作为 Renderer 可观测起点；用户原始鼠标事件尚未进入这条统一链路。

本方案包含三条 ARMS Custom Event：

- `perf_ui_session_open_start`：逻辑打开开始时上报一次，作为没有 result（崩溃、协议断开、永久卡住）样本的分母。
- `perf_ui_session_open_result`：成功、失败或超时结束时上报一次，`value` 为 `total_ms`。
- `perf_ui_session_directory_settled`：宽屏问题目录进入终态或确认无需补拉时上报一次，`value` 为 `settled_ms`。

不为每个阶段单独发送 ARMS 事件。阶段耗时在各进程本地用 monotonic clock 计算，通过 `v4/conversation/subscribe` 的 ACK 携带 CLI/Host timing；Renderer 在 result 事件中汇总。目录 settled 是独立低频事件，不改变 result 的首屏终点。

## 产品边界

- 仅 Desktop `desktop-continuous` 安装真实 ARMS reporter；Web/mobile `web-remote-replayable` 不发送 ARMS。
- 只衡量已经存在的 session 被用户导航、恢复或分屏打开的过程。空草稿首发创建 session、草稿预热
  session 提升，以及 pending `createSession` 恢复成功都属于“新建 Task”，不得发送
  `perf_ui_session_open_start/result`。新建 Task 离开当前 pane 后再次被显式打开时，才按已有
  session 进入本指标。
- 只测一次用户逻辑打开，不把 subscribe retry、same-sub recovery 或 ACK 前后的重复帧当成新的打开。
- `open_kind` 区分 `cold`、`warm`、`keep_warm`：只有创建新 projection store 并发起本次 subscribe 的 `cold` 打开携带 Host/CLI/Renderer 首帧阶段 timing；`warm` 与 `keep_warm` 复用已有 projection store 时仍记录本次 `total_ms` 与 paint timing，但不得复用上一次 subscribe 的阶段耗时。
- session 内容、workspace path/identity、prompt、工具输入输出、MCP server 名称和 Skill 正文不得进入 ARMS。
- `MCP` 启动是 runtime 并行工作，不把 MCP 连接耗时加到 session 首屏总耗时；MCP 首次模型请求等待另有既有模型请求观测。
- `content_settled`（历史补拉、计划目录、懒加载资源完成）不是本指标终点；本指标终点是当前 store 已进入 `live`、目标 session 的首个 snapshot 已 paint 且 Composer 可交互。重连中的残留 snapshot 不能单独结束本次打开。问题目录的稳定时间由 `perf_ui_session_directory_settled` 单独观测。

## 时间边界

```text
R0 pane acquire
  -> R1 acquire / subscribe 发起
  -> Host prepare
  -> CLI process bootstrap（仅新进程）
  -> CLI session restore / context / history / V4 projection
  -> initial frame ready / transport
  -> Renderer snapshot apply
  -> React commit
  -> paint + main-thread yield
R8 interactive_ready
```

`total_ms = R8 - R0`。跨进程不直接相减不同进程的绝对时间；Host/CLI 各自计算 duration，Renderer 计算从 pane acquire 开始的可感知耗时。

## ARMS 事件

### `perf_ui_session_open_start`

`group=ui_perf`，`value=1`。properties：

| 字段              | 取值                                            |
| ----------------- | ----------------------------------------------- |
| `session_open_id` | 本次逻辑打开的不透明关联 ID                     |
| `session_id`      | 当前 session ID，沿用现有 talk/session 关联策略 |
| `open_trigger`    | sidebar/search/deeplink/reload 等低基数桶       |
| `open_kind`       | `cold` / `warm` / `keep_warm`                   |
| `client_mode`     | `desktop-continuous`                            |

### `perf_ui_session_open_result`

`group=ui_perf`，`value=total_ms`。除 start 事件字段外，properties 允许：

| 字段                                                | 含义                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `status`                                            | `success` / `failed` / `timeout`                                                                           |
| `error_phase` / `error_code`                        | 失败阶段和结构化 reason code                                                                               |
| `total_ms`                                          | pane acquire → interactive_ready                                                                           |
| `renderer_prepare_ms`                               | click → subscribe 发起                                                                                     |
| `host_prepare_ms`                                   | Host 收到请求 → CLI subscribe 请求发出                                                                     |
| `provider_registry_sync_ms`                         | 历史字段名；当前记录 Host 等待本 Environment Provider Registry readiness 的耗时，不表示跨 Environment 同步 |
| `task_meta_read_ms`                                 | Host 读取 session/task 元数据的耗时                                                                        |
| `cli_request_ms`                                    | Host 发起 CLI subscribe 请求 → 收到 CLI ACK                                                                |
| `cli_bootstrap_ms`                                  | 新 CLI 进程启动 → Protocol ready；复用进程为空                                                             |
| `cli_session_restore_ms`                            | 非 historyFirst 冷订阅的 CLI restore → initial projection ready                                            |
| `history_ready_ms`                                  | historyFirst 首帧前的 CLI 历史投影 ready 耗时                                                              |
| `initial_frame_encode_ms`                           | CLI 构建首帧 wire projection → physical wire 编码完成                                                      |
| `initial_frame_transport_ms`                        | initial frame ready → Renderer 完整收到                                                                    |
| `renderer_snapshot_apply_ms`                        | frame 收到 → ProjectionStore apply 完成                                                                    |
| `react_render_ms`                                   | snapshot apply → React commit                                                                              |
| `paint_to_interactive_ms`                           | React commit → paint 后主线程 yield                                                                        |
| `cli_process_state`                                 | `spawned` / `reused`                                                                                       |
| `session_runtime_state`                             | `cold` / `warm`                                                                                            |
| `attempt_count`                                     | subscribe/retry 次数                                                                                       |
| `persisted_message_count`                           | 本次 opening 物化过的持久 message 数量，只有数量不含正文                                                   |
| `snapshot_row_count`                                | 实际 wire tail window row 数量，不是 CLI 内部完整 projection 行数                                          |
| `snapshot_bytes`                                    | wire snapshot logical frame 大小                                                                           |
| `plugin_count` / `skill_count` / `mcp_server_count` | 低基数数量                                                                                                 |

这些阶段存在并行关系，不要求 properties 中的阶段简单相加等于 `total_ms`；看板以 `total_ms` 为主，以阶段字段归因。

### `perf_ui_session_directory_settled`

`group=ui_perf`，`value=settled_ms`。以 `session_open_id` 关联同一次逻辑打开，properties：

| 字段                | 取值                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `directory_status`  | `hydrated` / `not-enough-queries` / `unsupported` / `retry-exhausted` / `stale` / `ineligible` |
| `settled_ms`        | pane acquire → 目录终态                                                                        |
| `loaded_row_count`  | 当前 renderer rows window 行数                                                                 |
| `total_row_count`   | 当前有效分支全序 row 数                                                                        |

终态来自 `ConversationProjectionStore.turnNavigatorDirectory`，不由组件 ref 复制第二份。无更早历史时上报 `ineligible`；同一 `session_open_id + directoryRevision + status` 只上报一次。事件只含计数、枚举与耗时，不含目录预览文本。

## CLI/Host 内部 timing

`openTiming` 只允许出现在 `v4/conversation/subscribe` ACK，不进入 sessions-index、workspace-config、resync 或 conversation snapshot：

- Host：`hostPrepareMs`、`providerRegistrySyncMs`、`taskMetaReadMs`、`cliRequestMs`；这些 timing 现在全部映射到最终 ARMS result 的 snake_case 字段。
- CLI：`cliBootstrapMs`（新进程）、`cliSessionRestoreMs` / `historyReadyMs`（按打开路径二选一）、`initialFrameEncodeMs`；这些 timing 现在全部映射到最终 ARMS result 的 snake_case 字段。
- Renderer：`rendererPrepareMs`、`initialFrameTransportMs`、`rendererSnapshotApplyMs` 由 Renderer 本地 monotonic clock 计算，`reactRenderMs` 用 snapshot apply 到 React commit 的时间计算，再映射到 ARMS result。
- CLI 同时返回 `sessionRuntimeState`、wire tail 口径的 `snapshotRowCount`，historyFirst 还返回 `persistedMessageCount` 与 `snapshotBytes`；`cliProcessState` 由 Host 根据 runtime 是否复用补齐。
- `plugin/skill/memory/history` 的更细阶段不逐条发 ARMS；如果线上核心阶段异常，再通过已有 CLI/Host debug/trace 做第二层诊断，避免把每个 session 放大成多条事件。

Skill discovery 可以读取各个 `SKILL.md` 解析 metadata，但不会在 session open 阶段加载 Skill 正文到模型上下文。MCP 连接可以在 runtime 构造后并行启动，首个模型 turn 才等待工具注册。

## 去重、失败和采样

- `session_open_id` 在 Renderer 生成并贯穿本次逻辑打开；retry/recovery 复用同一 ID。
- start/result 事件都由 ARMS 观测旁路 fire-and-forget，不阻塞 UI 或 protocol。
- 桌面端 start/result/directory-settled 100% 上报；不新增逐阶段事件，不在 stream/delta 级别上报。
- 超过 session-open watchdog 的调用上报 `status=timeout`；进程崩溃、窗口销毁导致没有 result 时，可用 start/result 缺口估计未完成样本。
- 详细 `plugin/skill/memory/history/projection` 子阶段只进入现有 CLI/Host 结构化 debug/trace，不作为高频 ARMS 事件。
