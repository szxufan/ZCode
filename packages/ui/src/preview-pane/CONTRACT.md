# ui-preview-edit

文件预览的就地编辑会话（Monaco 懒加载）与未保存变更守卫。

- 层：ui。依赖 `shared` 协议、`services` 的 workspace 服务类型与 `rpc` 的 `IDisposable`。
- 对外入口：`index.ts`。
- 调用方（未保存确认的收口点，全部在 `useAppPanels`，不在各个 UI 入口）：
  - `handleOpenCodeViewer` / `handleOpenCodeViewers`：`openCodeViewerSidePane(s)` 会复用已有 tab 并整体替换 source，聊天链接、工具卡片、命令面板与 Agent 产物自动打开都经此路径；
  - `handleNavigateFileManager`：文件树导航（`FileManagerPane.navigate` 不再自己确认，避免弹两遍）；
  - `handleCloseCodeViewer` 与 `closeSelectedSidePaneTabs`：关闭会卸载编辑会话的 tab；
  - 工作区切换 effect：用 `hasUnsavedEdits()` 同步判断后异步确认，取消则不前移 memory key；
  - `PreviewPane` 的 markdown / SVG 视图切换菜单。
- 不变量：
  - 编辑缓冲只存在于组件局部状态，不进入全局 store；
  - Monaco 只在编辑态动态加载，不入默认预览路径；
  - `unsavedEditGuard` 只聚合"是否存在脏会话"，确认动作由各会话自己完成；注册表 key 是 `path + sessionId`，同文件多 tab 各自独立追踪；
  - 编辑态由 `editSessionPath` 表达，`source` 引用变化但 path 未变时不得销毁会话；
  - 保存以 `FileRevision` 为基线，冲突由用户显式选择覆盖或重载；
  - 覆盖编辑器缓冲用 `executeEdits` 而非 `setValue`，以保留撤销栈。
