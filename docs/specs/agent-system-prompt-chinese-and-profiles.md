# 主 Agent 系统提示词中文化与多配置档（agent prompt profiles）

状态：已实施设计（approved plan 2026-10-29）。本文是行为规格：改动提示词组装、配置档存储、切换链路前先更新本文。

## 1. 产品规则

### 1.1 内置提示词语言

- 内置（built-in）主 Agent 系统提示词的静态文案**无条件使用中文**，与 UI locale（zh-CN / en-US）无关。
- 翻译约定：专有名词与标识符保持英文原文——ZCode、AGENTS.md、Git、工具名（Skill、TodoWrite、AskUserQuestion 等）、permission mode 名（plan、yolo 等）、`file_path:line_number`、协议字段、markdown/代码示例。叙述性规则文案译为中文。
- Memory 段的 frontmatter 代码示例（`name:`/`description:`/`metadata:` 键）保持英文原样：memory 写入与召回按这些键解析，翻译会破坏解析。
- 翻译范围（本期）：`apps/zcode-cli/packages/core/src/context/` 下的固定段落（cli-prefix、identity、desktop、env-info 标签、skills 标题句、memory、request-user-context 信封、current-date、workflow-actor 契约）与 `runtime/helpers/runtime-reminders.ts` 的回合内提醒。
- 不在范围（保持英文）：子代理提示词（subagent/*）、标题生成侧车、工具描述、runtime-reminders 之外的合成消息。

### 1.2 默认提示词唯一来源

- 内置提示词的可覆盖正文（identity + Dynamic Behavior + Session Guidance + Context Management）由 `packages/shared/src/agent-prompt/` 导出；core 的 section 构建器与 UI（设置页、切换器）都从这里取文本。core 与 UI 均不得内联第二份内置文案。

### 1.3 配置档（prompt profiles）

- 数据存 `~/.zcode/v2/setting.json`（唯一所有者：Host 的 `ISettingService`）：
  - `agentPromptProfiles?: Array<{ id: string; name: string; content: string }>`，用户自建，上限 20 份；name 非空 ≤100 字符，content ≤100_000 字符，id 唯一。
  - `agentPromptActiveProfileId?: string`；缺省或 `"default"` 表示使用内置中文提示词。
- 作用域为**本机应用级**：active 配置档影响本机所有 workspace 的会话（新会话 + 存活会话热更新）。
- 删除 active 配置档时 active 回落到内置；配置档内容不校验语义，保存什么发送什么。

### 1.4 覆盖语义（systemPromptOverride）

- 运行时 `ContextBuilderConfig.systemPromptOverride`（非空）**替换**：identity（含安全声明与 `# Harness`）、Dynamic Behavior、Session Guidance、Context Management。
- **保留**：cli-prefix（`你是 ZCode，一个交互式编码智能体`）、Desktop Context、Environment/Git 信息、Memory 段、Output Style 段、skills / AGENTS.md / 当前日期（meta_user）。理由：这些是运行时事实或独立机制，用户编辑的是"性格与规范"正文。
- 与既有路径的关系：
  - `customSystemPrompt`（动态工作流子代理专用）语义完全不变：仍整段替换 stable body 并跳过全部动态 system 段。
  - `workflowActor` 与 `systemPromptOverride` 可并存；`systemPromptOverride` 与 `workflowActor` 同时生效时 override 优先替换交互身份段，`workflowActor` 路径不受影响（工作流子代理不读用户配置档）。
- 生效时机：无活跃 turn 时立即重建 context 前缀；turn 中切换延迟到下一 turn（`AgentRuntime.updateConfig` 既有语义）。

## 2. 生效链路

### 2.1 新会话

```
session/create|resume（CLI server-operations.materializeSessionRecord）
  → requestSessionRuntimePreferences(scope=runtime-materialization)
  → Host resolveSessionRuntimePreferences 读 setting.json，
    解析 active 配置档为 agentSystemPromptOverride（内置/缺省 → 不下发）
  → zcodeSessionRuntimePreferencesResultSchema.agentSystemPromptOverride（可选字段）
  → server-operations 映射 startupPreferences → runtimeConfig.systemPromptOverride
  → AgentRuntimeConfig → ContextBuilderConfig → builder
```

### 2.2 热切换（状态所有者与事件顺序）

```
UI（设置页选中配置档 / composer 切换器）
  └─ useSettings().update({ agentPromptActiveProfileId })
       ├─ Host settingService.update：写 setting.json（唯一所有者）
       └─ useSettingService 既有同步分支
            └─ zcodeAgentService.syncAppRuntimePreferences({ agentSystemPromptOverride: 解析后文本 })
                 └─ workspace/updateInteractionPreferences（stdio JSON-RPC）
                      └─ CLI updateInteractionPreferences handler：
                         遍历 context.sessions → record.app.runtime.updateConfig({ systemPromptOverride })
  本地 UI 状态即时反映；turn 中切换延迟到下一 turn；协议只传解析后的文本，不传配置档 id
```

## 3. UI 规则

- 设置页新增 `agentPrompt` 分区（agentCapabilities 组）：配置档列表（内置默认只读项 + 自建档）、编辑器（名称 + 正文）、"载入内置提示词"、新建/删除/重命名、"恢复默认"。
- composer 左下工具条在"切换模式"（`V4ComposerModeSwitch`）旁挂 `PromptProfileSwitchControl`：下拉列出内置默认 + 自建档（当前项勾选），底部"管理提示词…"跳设置分区；窄视口折叠为图标（对齐 `ChatModeSwitchControl.compactIconOnly` 的响应式模式）；切换即 `useSettings().update`，本地即时反映。
- UI 自身文案仍走 `packages/ui/src/i18n` 双语；提示词正文是数据不是 UI 文案，不进 i18n 资源。
- 手机 Web composer 本期不挂切换器（后续项）。
- e2e：切换器与分区需 test-id 锚点（`packages/shared/test-ids.ts`）。

## 4. 协议兼容

- 两个协议 schema（runtime preferences result、interaction preferences）为 strict object，新增字段必须 optional：旧 Host 缺省不下发 → CLI 回落内置；旧 CLI 收到新 Host 的多余字段会 strict parse 失败——桌面 Host 与 CLI 同包发布，风险窗口仅存在于混版本远端部署，与既有偏好字段的兼容策略一致。

## 5. 验收场景

1. 全新会话（无配置档）：system prompt 为中文内置；`systemMessages` 结构不变（prefix / stable(ephemeral) / dynamic(ephemeral) + meta_user 附件）。
2. 设置页新建配置档并选中 → 新会话使用该文本；Environment/Git/Memory/AGENTS.md/skills 段仍在。
3. 存活会话中切换配置档 → 无活跃 turn 时下一次请求前缀变化；turn 中切换不中断当前 turn，下一 turn 生效。
4. 切回"内置默认" → 新会话与热更新均回到中文内置。
5. 删除 active 配置档 → active 回落内置；设置与切换器一致反映。
6. "载入内置提示词"得到的文本与运行时内置正文一致（同一 `composeDefaultAgentPromptBody()`）。
7. `customSystemPrompt`（工作流子代理）路径输出与改动前语义等价（其文案仍英文，不受配置档影响）。
8. debug analyzer 能从落盘 system prompt 识别中文 section 头。

## 6. AI 生成 / 修改提示词（设置页）

- 入口：`agentPrompt` 分区编辑器顶部的 AI 助手区——指令输入框 + 「AI 生成」（全新生成）与「按指令修改正文」（修改模式，正文为空时禁用）。
- 通路：renderer → `IZcodeAgentService.generateAgentPromptDraft`（Host）→ `generateWorkspaceText`（`workspace/generateText`；CLI 侧无活跃会话时临时建 ZCodeApp，用完即关）。prompt 构造与输出规整在 `packages/services/src/zcode-agent/agentPromptDraft.ts`，与 commit message 生成同一先例。
- 执行上下文：AI 生成由本机 Host 启动 CLI，只能使用本地工作区——与模型连通性探测同源，复用 `resolveModelProviderConnectivityWorkspacePath` 过滤远端 tab（远端激活时取任一本地 tab，无本地 tab 时回退进入设置页前的本地工作区）；无任何可用本地工作区时按钮禁用。模型：本机 `modelSelectionService.getView().preferredSelection`（与 commit message 同源），缺失时报“未配置默认模型”。
- `querySource = "agent_prompt_draft"`（自由字符串，无协议改动）；`requestTimeoutMs = 150_000`（协议 client 默认 3 分钟，必须透传自身 deadline）；`maxOutputTokens = 8192`。遥测超时必须显式覆盖 catalog 默认 30s（取 deadline + 取消缓冲），否则长请求会被记为 abandoned。不做流式与取消（后续项）。
- 结果语义：AI 输出**只回填编辑器草稿**，不写设置、不落盘；覆盖前值保留为「撤销 AI 结果」，手动编辑或载入内置会清除撤销点；撤销点与草稿同生命周期（新建/编辑/关闭草稿时经由单一重置点清空），pending 期间正文与取消按钮锁定、完成后校验草稿未被切换，防止异步结果覆盖编辑或撤销点跨档泄漏。是否保存仍由用户点击「保存」决定。
- 失败语义：指令为空在 UI 侧拦截；无工作区（`agent-prompt-draft.workspace-required`）、无默认模型（`agent-prompt-draft.model-missing`）、空输出（`agent-prompt-draft.empty-output`）等失败只抛稳定错误码（服务层与注入回调都不携文案），UI 侧按码映射 i18n 文案后走分区现有 error 展示，不打断编辑；未知错误（如 RPC 原始异常）原样透出。
