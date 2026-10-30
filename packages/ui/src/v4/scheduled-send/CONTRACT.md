# scheduled-send

模块存在的意图：把「把当前草稿按用户选择的时间点投递」这件事收口成 composer 侧一个可复用模块。
定时发送不是新的调度系统——一次定时发送 = 一条一次性 automation（`relativeDelayMinutes` +
`recurring=false`），到点由常驻 scheduler 派发回 `targetTaskId` 会话；本模块只负责时间选择与
`automation/create` 入参构造。

不变量：

- 预设时间点是 UI 本地偏好，唯一所有者在 `scheduledSendPresetStore`（localStorage）；不写
  tasks-index、不进协议参数。定时事实的唯一所有者仍是 tasks-index `automations` 表。
- 提交必须走 `buildScheduledSendAutomationParams`：目标时刻在确认时按当前时刻现算（浮层预览
  仅展示，停留跨过目标时刻后不得提交过去值）；空正文、过去时刻、超过一年都拒绝提交；
  已有会话带 `targetTaskId`，草稿态不带（到点由 Host fallback 新建会话）。
- 入口只支持纯文本：附件/代码批注/网页元素/PPT/会话引用/插件上下文存在时禁用并给出原因；
  远程 workspace 不渲染入口（本机 scheduler 不为其派发）。
- 提交成功后由 `onScheduled` 清空草稿；失败（含 `AUTOMATION_CREATE_LIMIT`）保留草稿。

与其它模块的交集：

- `ui`（composer）：消费 `ComposerScheduledSend` 与 props；挂载点是
  `ConversationComposer` 发送键右侧。
- `services`：只消费 `ZCodeAgentCreateAutomationParams` 类型，经 `IZCodeAgentService.createAutomation`
  提交；不直接触达 `AutomationRepo` / scheduler。
- `shared`：`AUTOMATION_CREATE_LIMIT`、`isAutomationCreateLimitError` 与 test-ids。

验收场景与验证方式见 `docs/specs/composer-scheduled-send.md`。
