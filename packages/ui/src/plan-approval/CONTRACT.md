# plan-approval

模块存在的意图：把挂在 `ExitPlanMode` 审批与展示链路上的三件事收口成一个可复用模块——把计划原文
另存为本机文件、复制计划原文（计划卡片与详情侧栏共用同一组按钮），以及在审批弹窗里选择执行模型。

不变量：

- 保存只读取调用方给的计划正文并发起平台另存为（`IPlatformService.saveFile`）；不发送 task command，
  不写会话、投影或 `.zcode/plans` 下的 plan file，不改变 desktop-continuous 与 web-remote-replayable
  任一链路。目录是否存在只有 main 知道：模块只给候选顺序（`docs/superpowers/plans`、工作区根目录）。
  没有另存为能力的平台不渲染保存按钮。
- 执行模型的选中值由弹窗宿主持有，不进全局 store，不写草稿或 workspace default。模块不切换会话模型：
  切换走既有 `switchModelConfig` 路径，由宿主在批准时调用。清单与 composer 同源，目标工作区 Host
  提供候选，等待远端时不回退本机 Host。
- 换模型即取新模型在注册表里的默认思考档，与 composer 一致；清单读不好时无法补齐思考档，按保持
  会话模型处理。

与其它模块的交集：

- `ui`：消费 `PlanSaveButton`（计划卡片、计划详情侧栏）与 `PlanExecutionModelField`（审批弹窗宿主）；
  复用 `ModelConfigSelect`、`useModelSelectionView` 与 `modelSelectionGroups`。
- `provider`：`completeNewModelSelection`，用来补齐新模型的默认思考档。
- `shared`：`SaveFileRequest.defaultDirectoryCandidates` 与 test-ids。

验收场景与验证方式见 `docs/specs/plan-approval-execution-model.md` 与
`docs/ui/plan-detail-side-pane.md`。
