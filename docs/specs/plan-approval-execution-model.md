# 计划审批的执行模型

> 改动本功能前先更新本文。运行时侧的说明同时见 `apps/zcode-cli/docs/design/v2/loop/turn-steering.md`「Drain 边界」与 `docs/plan-mode-approval-boundary.md`「批准携带执行模型」。

## 目标与范围

用户在 `ExitPlanMode` 审批弹窗里批准计划时，可以选择用另一个模型执行这份计划，例如用强推理模型规划、用更快的模型执行。新模型在**本次执行中立即生效**：批准后同一轮继续，下一次模型请求就用新模型。

不改动的部分：批准、无反馈拒绝、带修改意见拒绝的既有语义；不带执行模型的批准与改动前完全一致。子代理来源的计划审批和飞书 Bot 渠道的计划审批不提供执行模型。

```mermaid
sequenceDiagram
    participant UI as 审批弹窗宿主（V4InteractionDialogs）
    participant Pane as SessionPane 会话模型切换路径
    participant Cmd as CLI 命令面
    participant Broker as interaction broker
    participant Loop as 运行时循环
    UI->>Pane: commitSessionModelSwitch(X)
    Pane->>Cmd: switchModelConfig（经 configCommandBarrier）
    Cmd->>Cmd: 注册表预检、app.setModel(X)、持久化
    Cmd-->>Pane: ACK accepted（失败则 toast，弹窗不关）
    UI->>Broker: resolveInteraction(approve, content.executionModel = X)
    Broker-->>Loop: allow + executionModelSelection
    Loop->>Loop: ExitPlanMode 工具结果结算后，按会话选择创建 Model，替换 state.model，按需重建前缀
    Loop->>Loop: 再消费 guide（带意图的 guide 优先）
```

## 状态所有者

| 状态 | 唯一所有者 | 说明 |
| --- | --- | --- |
| 弹窗里的执行模型选择 | 弹窗宿主的本地状态 | 不进全局 store，不落盘；交互结束即丢弃 |
| 会话模型选择 | CLI 会话（`switchModelConfig` 命令路径） | 与 composer 手动切换是同一条写入路径；运行时不新增写入路径，只读会话选择来创建 Model |
| 当前轮实际使用的模型 | 运行时循环的 `state.model` | 批次边界按会话选择重建；每一步仍只读 `state.model` |
| 是否支持执行模型 | CLI 生成的审批请求 `payload.schema.executionModel` | 逐请求声明；界面不缓存，也不从 hello capabilities 推断 |

## 行为契约

### 界面

- 仅当审批请求的 `schema.executionModel.supported === true` 且是 `ExitPlanMode` 审批时，渲染「执行模型」字段；否则弹窗与改动前一致。
- 清单与 composer 模型菜单同源（目标工作区 Host 的 ModelSelectionView），首项是「会话模型」并带当前模型名，默认选中它。
- 选了另一个模型时显示说明：批准后从下一步起用该模型执行。
- 批准流程：选中非会话模型时，先走既有会话模型切换（`switchModelConfig`，含注册表预检和既有切换提示），切换被接受后再提交批准，并在 `answer.content.executionModel` 带上完整选择。切换失败则弹窗保持打开、不提交批准，沿用既有切换失败提示。
- 保持会话模型时，不发切换命令，批准不带 `executionModel`。
- 带修改意见的提交（自定义反馈）不携带执行模型，选择保留在弹窗里。
- 弹窗等待切换或批准回执期间，「忽略」与主按钮禁用；回执未被接受时弹窗保持打开。
- 模型菜单打开时，弹窗的 Enter / Esc 不触发提交或关闭，见 `docs/elicitation-keyboard-behavior.md`。

### 运行时

- broker 只在批准（allow）时读取 `content.executionModel`，用共享的 `modelSelectionSchema` 校验形状；不合法时忽略该字段并记 warn，批准照常生效。带修改意见的拒绝不携带。
- 工具批次结算后、消费 guide 之前：本批有成功的 `ExitPlanMode` 结果且带 `executionModelSelection` 时，运行时用会话**当前**选择创建新的 Model（`createTurnModel`），与循环当前模型不同才替换并重建上下文前缀。`executionModel` 只是触发信号，采用的值以会话选择为准。
- 同一边界若还有带意图的 guide，guide 后消费、优先（既有规则）。
- 固定执行模型的轮次（`modelSelectionScope === "execution"`）不切模，与 guide 同规则；此时会话切换从下一轮生效。
- 换模失败（创建 Model 抛错）不得让已批准的这一轮失败：保持原模型继续本轮，记一条 warn。
- 给模型的工具结果文案不变；不新增轮次，不合成用户消息，不重复发 `ModelSelected`。

## 协议与兼容

- 审批请求：`payload.schema` 为 `{ interaction: "plan_approval", toolName, executionModel?: { supported: true } }`；子代理来源的请求不带 `executionModel`。
- 审批应答：`answer.content.executionModel` 是完整的 `ModelSelection`（`providerId`、`modelId`、`options.reasoningLevel`）。`answer.content` 本就是开放对象，命令 schema 不变。
- CLI 内部：`PermissionBrokerResult.executionModelSelection` 与 `ToolExecutionResult.executionModelSelection`，均为可选字段。
- 旧 CLI 加新界面：请求不带 `executionModel`，界面不渲染字段。新 CLI 加旧界面：应答不带该键，运行时按普通批准处理。

## 验收场景

1. 选另一个模型后批准：先发 `switchModelConfig` 再发 `resolveInteraction`；批准后的下一次模型请求使用新模型；仍是同一轮。
2. 保持会话模型批准：不发切换命令，批准不带 `executionModel`，行为与改动前一致。
3. 切换失败（模型不可用）：弹窗保持打开，出现既有切换失败提示，不提交批准。
4. 带修改意见提交：不发切换命令，不携带 `executionModel`；反馈仍升级为真实用户消息。
5. 不带 `executionModel` 的批准：运行时行为不变。
6. 固定执行模型的轮次：不切模。
7. 换模失败：保持原模型继续，本轮不失败。
8. 旧 CLI 与旧界面两种组合：互不影响。

## 验证

执行 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；UI 单测覆盖弹窗提交内容、字段选择、`onRespond` 返回 false 时保持打开；CLI 定向测试覆盖 broker 映射、投影 schema、批次边界换模；E2E 手动评审候选覆盖验收 1–4。桌面本地 `desktop-continuous` 是正式验收面；手机 `web-remote-replayable` 沿用计划模式现有口径，不新增覆盖。
