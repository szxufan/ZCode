# Git 提交信息生成重做实施计划

**Goal:** 让 AI 生成提交信息时的输入等于用户即将提交的内容；模型由用户显式配置并可预期；移除静默截断与死参数。

**Spec:** `docs/specs/git-commit-message-generation.md`（本计划 Task 0 新增）

## 背景

当前实现存在三处独立缺陷（已通过源码与本机日志确认）：

| 问题 | 现状 | 证据 |
| --- | --- | --- |
| 文件集合 | 服务端重新读全量 `git status`，按 `[...unstaged, ...staged]` 排序后只取前 8 个 diff、前 20 个文件；未暂存多时 staged 被完全挤掉 | `packages/services/src/git/gitService.ts` 的 `getCommitMessageDiffQueries`；日志 `fileCount: 47, diffCount: 8` |
| 模型选择 | 只读 `preferredSelection`；它来自无写入入口的 `defaultModelSelection`，缺失时回退 Registry 第一个模型（实测为账号套餐 `GLM-5.4`） | `packages/services/src/node.ts` 的 `readCurrentModel`；`provider_config.json` 无 `defaultModelSelection` |
| 会话上下文 | `conversationContext` 在 UI 没有任何调用方，恒为 `(not provided)` | `packages/ui/src/git-action-menu/commitConversationContext.ts` 无引用；日志 `conversationMessageCount: 0` |

## 目标与非目标

**目标**

- 生成请求的文件集合与 `gitService.commit` 的 `paths` 完全一致
- 增加“Git 提交信息模型”设置项，支持显式选择与失效回退
- diff 基准与提交基准一致；所有上限在 prompt 中显式表达
- 删除 `currentSessionFilePaths`、`includeUnstaged`、`commitMessageFileScope` 等隐式过滤

**非目标**

- 不新增逐文件勾选 UI（本期沿用“包含未暂存”开关）
- 不做辅助模型跨 Host 同步（见“决策 3”）
- 不改动提交信息的撰写规范 `docs/git/ai-agent-commit-message-guidelines.md`

## 决策

1. **文件集合唯一所有者是 UI 对话框**
   UI 传 `paths = getCommitDialogStagePaths(state, includeUnstaged)` 和 `stagedOnly = !includeUnstaged`；服务端不再推断集合，只按 `paths` 取 diff。

2. **diff 基准与提交基准一致**
   `stagedOnly = true` 用 `git diff --cached`；否则新增 `worktree` source，用 `git diff HEAD`（工作区 vs HEAD 的合并结果）。未跟踪文件继续走现有 no-index 路径。

3. **模型配置存本机 `AppSettings`，仅本机 workspace 生效**
   新增 `gitCommitMessageModelSelection`，通过现有 `settingService.update` 写入。远程 workspace 读取不到该配置时回退该 Host 的 `preferredSelection`，并在设置页标注“仅本机工作区生效”。跨 Host 同步留待后续迁移到 Provider 域。

4. **设置项命名为“Git 提交信息模型”**
   不叫“辅助模型”，避免后续被 session title、input prediction 等复用造成行为耦合。

5. **删除 `conversationContext`**
   当前无调用方；本期直接删除协议字段与 UI 侧构造函数，避免留下第二个死参数。若未来要做，另立 spec。

## Global Constraints

- 生成输入的文件集合必须等于提交输入，任何排序、过滤、截断都不得改变集合成员
- 所有上限（文件清单、diff 数量、字符预算）必须在 prompt 中显式说明被省略的数量
- 配置读取、模型校验、日志分别在 UI 与 services 各自边界内完成；不跨层读对方状态
- 日志使用 `logger.ts` / `createServiceLogger`，不得写入凭据、完整 diff 或用户数据
- 删除字段前先确认唯一调用方；`generateCommitMessage` 目前只有 `GitActionMenu` 一处调用
- 字符串与数字常量提取为具名常量

## Tasks

### Task 0: 功能 spec

**Files:**

- Create: `docs/specs/git-commit-message-generation.md`

- [ ] 写明输入契约：`paths`、`stagedOnly`、`selection`、`locale`
- [ ] 写明模型解析链：本机配置 → `preferredSelection` → Registry 第一个模型；每级的校验与失效提示
- [ ] 写明 diff 基准：`stagedOnly` 对应 `--cached`，否则 `HEAD`；未跟踪文件例外
- [ ] 写明配额：文件清单全量、diff 数量与字符预算、省略提示
- [ ] 写明失败语义：空集合、无可用模型、单个 diff 失败、设置失效
- [ ] 写明不变量：生成 paths 与提交 paths 相等；远程 workspace 的降级行为

**验收:** spec 评审通过后再进入 Task 1。

### Task 1: 共享类型与设置字段

**Files:**

- Modify: `packages/shared/src/git.ts`
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/shared/src/validationAppSettings.ts`

**Interfaces:**

```ts
export interface GitGenerateCommitMessageRequest extends GitRepositoryRequest {
  workspaceIdentity?: string;
  locale?: Locale;
  paths: string[];
  stagedOnly: boolean;
  selection?: ModelSelection;
}
```

- [ ] `packages/shared/src/git.ts`：替换 `GitGenerateCommitMessageRequest` 字段；删除 `GitCommitMessageConversationContext`、`GitCommitMessageConversationMessage`
- [ ] `packages/shared/src/git.ts`：`GitDiffRequest.sourceId` 联合类型增加 `"worktree"`
- [ ] `packages/shared/src/protocol.ts`：`AppSettings` 增加 `gitCommitMessageModelSelection?: ModelSelection`
- [ ] `packages/shared/src/validationAppSettings.ts`：新增对应 zod 字段，保持 optional 且默认不写盘

**验收:** `pnpm typecheck` 通过，且全仓库不再引用被删字段。

### Task 2: 新增 worktree diff source

**Files:**

- Modify: `packages/services/src/git/repo/gitCliRepo.ts`
- Test: `packages/services/test/gitCommitMessageDiff.test.ts`

- [ ] `getDiff` 增加 `worktree` 分支：`git diff HEAD --no-color --binary -- <path>`
- [ ] 未跟踪文件：`git diff HEAD` 无输出时复用现有 `buildUntrackedTextDiffResult` / `--no-index` 路径
- [ ] 单个文件 diff 失败时返回 unavailable，不阻断整批

**验收:** 新增单测覆盖 `staged`、`worktree`、未跟踪三种情况。

### Task 3: 服务端按 paths 取 diff

**Files:**

- Modify: `packages/services/src/git/gitService.ts`
- Delete: `packages/services/src/git/commitMessageFileScope.ts`
- Test: `packages/services/test/gitServiceCommitMessage.test.ts`

- [ ] `generateCommitMessage` 删除 `getChangesForSource` 构造集合的逻辑
- [ ] 保留一次 `getStatus`，仅用于补齐 `paths` 的 `kind/added/removed` 元数据；集合以 `paths` 为准
- [ ] `paths` 为空时抛出明确错误（沿用现有 no-changes 文案）
- [ ] `stagedOnly ? "staged" : "worktree"` 作为 `getDiff` 的 source
- [ ] 把可选 `selection` 透传给 generator
- [ ] 删除 `filterCommitMessageFilesByCurrentSession` 及其测试引用

**验收:** 单测断言只请求传入 paths 的 diff；staged-only 时不发 unstaged 请求。

### Task 4: prompt 重做

**Files:**

- Modify: `packages/services/src/git/gitCommitMessageGenerator.ts`
- Test: `packages/services/test/gitCommitMessagePrompt.test.ts`

- [ ] `generate` 优先使用传入 `selection`，缺失时回退 `currentModelProvider.readCurrentModel`
- [ ] 文件清单不再 `slice(0, 20)`；超限时在 prompt 写 `omittedFileCount`
- [ ] diff 按 `added + removed` 降序排序后取前 8 个，总预算 12000 字符
- [ ] 被省略或 diff 不可用的文件在 prompt 中显式标注
- [ ] `stagedOnly` 时 prompt 说明“本次仅提交已暂存内容”
- [ ] 保持现有 Conventional Commit 校验与 1000 字符上限

**验收:** 快照式单测覆盖 staged-only、混合、超量、缺失 diff、中英文。

### Task 5: UI 输入契约

**Files:**

- Modify: `packages/ui/src/GitActionMenu.tsx`
- Create: `packages/ui/src/git-action-menu/commitMessageModel.ts`
- Delete: `packages/ui/src/git-action-menu/currentSessionFileScope.ts`

- [ ] `generateCommitMessage` 传 `paths`、`stagedOnly`、`selection`
- [ ] 生成与提交共用 `getCommitDialogStagePaths(state, includeUnstaged)`
- [ ] 新增 `resolveGitCommitMessageSelection(services, view)`：读设置 → 校验 → 回退 `preferredSelection`，失效写 `warn`
- [ ] 删除会话文件过滤；对话框预览显示全量改动
- [ ] 更新调用日志，记录 `stagedOnly`、`pathCount`、`diffCount`

**验收:** E2E 断言生成请求的 `paths` 等于提交请求的 `paths`。

### Task 6: 设置 UI 与 i18n

**Files:**

- Modify: `packages/ui/src/settings/ModelProviderSection.tsx`（或新增 `GitCommitMessageSection.tsx`）
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`

- [ ] 新增“Git 提交信息模型”选择器，数据来自 `modelSelectionService.getView()`
- [ ] 展示“未配置时使用：{当前默认模型}”
- [ ] 配置模型失效时展示提示并允许一键清除
- [ ] 标注“仅本机工作区生效”
- [ ] 通过 `settingService.update({ gitCommitMessageModelSelection })` 持久化

**验收:** 修改后写入 `setting.json`，重启保留；删除模型后显示失效提示。

### Task 7: 验证

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm architecture:check --changed`
- [ ] `pnpm test:unit`（新增单测）
- [ ] 定向运行 `packages/desktop/test/e2e/git/commit/git-commit-dialog-ui-flow.test.ts`
- [ ] 手工验证：仅暂存 2 个文件、未暂存 10 个文件时，生成的 prompt 只包含 2 个 staged 文件

## Risks

1. **`git diff HEAD` 行为差异**：未跟踪文件仍需 no-index；子模块、二进制文件走现有 unavailable 分支。
2. **跨 Host 配置**：远程 workspace 读不到本机设置时会回退，需要在 UI 明确提示，否则用户会认为配置没生效。
3. **字段删除遗漏**：`includeUnstaged`、`currentSessionFilePaths`、`conversationContext` 可能被测试或 E2E fixture 引用，删除前用 Grep 全量确认。
4. **设置项再次成为死字段**：必须同时实现写入路径与读取路径，并在验收中验证持久化。

## Open Questions

- 设置项放在 `ModelProviderSection` 内，还是新增独立的 Git 设置分区？
- `worktree` source 是否也需要暴露给 Review 面板使用，还是仅限提交信息生成？
