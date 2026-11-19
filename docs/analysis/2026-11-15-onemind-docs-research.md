# onemind 文档调研:可借鉴点分析

- **调研对象**:[onemind.docs](https://onemind.team/docs/)(BETA 0.4.14,页面标注发布于 2026-09-30)
- **调研方式**:只读抓取 14 个文档页面(见文末来源清单),未注册账号、未接触非公开资料;未修改任何代码。
- **调研日期**:2026-11-15

## 1. 一句话定位与调研结论

onemind 不是又一个 coding agent,而是架在 13 个第三方 AI 工具(Codex、Claude Code、Cursor、Qoder、TRAE、OpenCode、Antigravity、OpenClaw、Hermes Agent、Pi、Grok Build、DeepSeek Harness、CodeBuddy)之上的**团队层产品**,只做两件事:

1. **Minds**:给团队一份"经过人工评审的共享 AI 指令"(prompt/rules/skills/hooks),以提案 → 自动安全检查 → 管理员审批 → 不可变版本发布 → 定向同步到各工具指令文件的流水线治理。
2. **Matrix**:人和 AI 工具共用一个任务板,任务可以被分配给"某成员 Mac 上的某个工具",权限请求、跟进消息、交接都在板上路由。

它自己**不执行任何任务**:云端 agent 不跑代码不改文件,所有执行都发生在成员本机的工具里。这个定位决定了它的工程重心是**状态机、审批流、文件写入安全、可靠投递**——恰好是 ZCode relay/远控/会话链路每天在处理的问题域。

**总体结论**:不建议照搬它的产品形态(团队治理层对 ZCode 当前单人场景偏重),但它的**状态机词汇表、fail-closed 文件写入模式、outbox 队列、审批交互细节和文档规格风格**是可以直接吸收的工程资产。

## 2. 产品结构速览

| 组件 | 说明 |
| --- | --- |
| Web(BETA app) | 主界面:Matrix 任务板、Mind 评审、Notification 收件箱、Backup、Settings;五语言(英/简中/繁中/日/韩) |
| macOS app | 端侧宿主:发现并连接本机 AI 工具、绑定 Project folder、代发同步、跑 Mind Generator |
| CLI(macOS/Linux) | 全功能终端入口,含每用户后台服务(LaunchAgent/systemd) |
| 云端服务 | 团队存储、审批流、Safe Check、MCP server(`https://onemind.team/mcp`) |

核心域对象:**Team/Matrix(工作区)→ Project → Project folder binding(设备级)→ Mind(版本化指令)→ Mind file library(项目私有文件空间)→ Matrix task → AI tool binding → Notification → Backup**。

值得注意的身份模型:Project folder 绑定是 `(Project, tool, device)` 三元组,同一路径在另一台设备上不是同一绑定——与 ZCode 的 `workspaceIdentity`(身份)与 `workspacePath`(路径展示)分离是同一个设计判断。

## 3. 可借鉴点

### 3.1 指令治理流:提案 → 自动检查 → 人工审批 → 不可变版本(★ 最高价值)

Mind 的变更全走 PR 式流程,细节非常成熟:

- **一切皆提案**:内容更新、标题修改、删除、移动/复制、Project 元数据修改,全部是审批请求;删除是软删除(保留历史可恢复);**恢复旧版本也要走"在当前版本上新提案",绝不原地重写历史**。
- **Safe Check / Conflict Check**(提交时服务端自动跑):产出分三档严重级——`Blockers`(阻止审批)/`Review`(需人工确认)/`Overlap`(仅知会),每个 finding 再带置信度 `Exact / Heuristic / Semantic`,共 11 种 finding 类型(重复身份、过期版本引用、权限越界、依赖环、矛盾指令、重复指导……),每个 finding 有**稳定指纹**和精确的源版本引用。存在 Review 级 finding 时,审批者必须**勾选确认框**才允许点"Approve and publish"。
- **版本一致性**:提案提交后若基线版本变了,旧提案自动作废并引导"基于当前版本重新提案";若编辑与新版本重叠,则并排展示让作者手工修正。
- **配额与边界**:新建 Mind 内容 8,000 字符,附件 512 KiB/个,提案输入 1 MiB;方案变更期间全体 Mind 进入只读态。

**对 ZCode 的落点**:fork 已有"系统提示词配置档"等自有功能。若做团队/共享配置(配置档、AGENTS.md 模板、hooks 预设),这整套"提案-检查-审批-不可变版本"是现成的产品语义,尤其是:**(a)** Review 级 finding 的显式勾选确认(把"人工看过"变成数据而不是假设);**(b)** 恢复旧版本走新提案而非改历史(与 ZCode 会话恢复"不重写历史"的取向一致);**(c)** 删除可恢复 + 删除也审批。

### 3.2 受管块(managed block)写入策略(★ 直接可复用)

onemind 向各工具指令文件(AGENTS.md / CLAUDE.md / GEMINI.md / `.cursor/rules/one-mind.mdc` / TRAE `user_rules.md` bootstrap)写入时的安全模式:

- **只写自己的受管标记区**,块外内容永远属于用户;"Missing, duplicated, reversed, or malformed markers cause sync to stop instead of risking user-owned content"——标记损坏就停机(fail closed),绝不猜测覆盖。
- **首写前完整备份原文件**(`.one-mind/AGENTS.md.backup`,pre-onemind 原始状态,后续同步永不覆盖它),之后每次覆盖已应用 Mind 前再做**版本化快照**(manifest + history/ 全量副本),可 `onemind mind restore pre-onemind` 一键回到接管前。
- **写完落回执**:`.one-mind/mind-content/<tool>.json` 记录精确的已批准文件清单和 hash,供后续 freshness check 对账。
- **备份失败 = 什么都不写**:"Backup failed → onemind could not create the backup that protects this sync, so nothing was changed."写入的前置条件是保护机制先就位。
- 多工具共享同一 Project 文件夹,各写各的受管块,**一个工具同步失败不影响其他工具**。

**对 ZCode 的落点**:ZCode 桌面端写 AGENTS.md、hooks、配置档、插件资源时应采用同一套纪律:受管标记 + 损坏即停 + 首写备份 + 覆盖前快照 + hash 回执 + "备份不成不落盘"。这比通用的"写入前备份"强在**回执让后续校验成为可能**(见 3.5)。

### 3.3 状态机的"诚实性"词汇表(★ 直接可复用)

onemind 的文档通篇严格区分"请求过"与"已发生",这套词汇表可以整体移植:

- 同步事件状态:`Queued → Applying → Confirmed`,外加 `Confirmation overdue`(设备迟迟不确认)、`Recovery needed`(无法安全确认,设备需走恢复流程)、`Rolled back`(设备确认已回滚到之前文件)。
- "Pending / Sync requested **means the device still needs to apply and report the result**";"Synced = Delivery was confirmed. **delivery alone does not prove the tool used it correctly**"——连"送达"都明确声明不等于"生效"。
- 集成状态区分 `Package prepared`(包已就绪)与 `Host connected`(宿主已连上,可验证);`verify-session` 明确声明 "local readiness is not host-attested proof"(本地就绪不是主机证明)。
- 停止任务:"Waiting for stop confirmation ≠ Execution stopped",发出停止后要等工具确认才显示终态。
- CLI 更新:两次检查都只做只读检查,`onemind update` 本体**永不自替换二进制**,只打印签名安装器指引并以退出码 3(需要行动)结束,防止自动化误判"更新已完成"。

**对 ZCode 的落点**:与 AGENTS.md 已有原则("desktop-continuous 实时链路与 web-remote-replayable 恢复链路必须明确区分""不能用超时掩盖同步问题")完全同向。可具体吸收:(a) relay/远控 UI 的状态命名采用 Queued/Applying/Confirmed + overdue/rollback 三态延伸;(b) "送达≠生效≠被使用"的三段声明写进协议文档和 UI 文案;(c) 更新器"只检查不自换"的防误判设计。

### 3.4 面向用户的失败处置矩阵(文档模式)

Mind Sync 文档给了一张完整的错误表:每一行是用户会看到的错误文案,右列是精确的下一步动作(Offline→去那台 Mac 重连;Backup failed→查 Backup 再试;Device busy→等一下再试;Project-target mismatch→换绑定……),共 13 种,每条都对应一个明确状态而非笼统"出错了请重试"。

**对 ZCode 的落点**:relay v3、手机远控、远程工作区的错误文案可以按这个格式整理成 spec 附件(错误码 → 用户动作),配合 `docs/relay-server/` 现有文档。成本极低,收益是减少"连接失败"类工单。

### 3.5 单写者文件执行器:设备级审批 + 复验 + 崩溃可续(★ 架构级参考)

Project 文件陈旧时的受治理替换流程,是整个文档里工程密度最高的一段:

1. 后台服务在启动、相关服务端事件、鉴权/网络重连、15 分钟退避兜底时检查分配文件的 hash(**只发元数据和 SHA-256,不上传内容**;拒绝 symlink 和特殊文件)。
2. 陈旧 → 创建**设备级**审批请求(device-scoped,因为"只有设备主人有权决定这台机器上的文件"),状态机 `pending / refused / approved_awaiting_apply / applied / expired / conflict / failed`,Defer 保持在 pending。
3. 审批通过后由**单写者执行器**应用:复验双 hash 与 Project head → 校验下载内容 → 在 checkout **之外**(onemind 自有应用状态目录)保存精确恢复副本 → 通过 flushed 兄弟临时文件原子替换 → 回执确认。任何本地/远端/绑定/符号链接/过期变化 **fail closed**。
4. 崩溃恢复:mode-0600 的 checkpoint manifest 记录 attempt ID、确认幂等键、协商协议、阶段和**轮换短租约**,崩溃后可 reclaim/resume 同一一次性行权,老 grant 持久续接。
5. 等待采用**带退避的有界长轮询**,不是高频轮询;关闭等待命令不取消请求(服务端仍可在稍后审批时应用)。
6. 退出码语义:`0` 成功后调用方必须重读文件;`3` 被拒绝(禁止自动重试);`4` 等待预算耗尽(同样禁止自动重试)。

**对 ZCode 的落点**:这套"审批权在设备、执行器单写者、替换前四重复验、manifest 支撑崩溃续跑"的组合,与 ZCode 的 `web-remote-control-task-command-queue`、快照恢复、以及 relay v3 的 chunk-frame 可靠传输是同一问题域。尤其是**轮换短租约 + 幂等键写进持久 manifest** 的做法,可以对照 ZCode 的 owner/lease 设计做一次复盘(AGENTS.md 已要求"保留 owner/lease……不能仅根据单一路径删除边界判断")。

### 3.6 Outbox 可靠投递队列(★ 直接可复用)

`.one-mind/outbox-event-<sha256>.json`:**每个事件一个不可变文件**;集成方写入须持有 `outbox-v2.lock`;准入上限 1,000 事件 / 4 MiB;发布 = 临时文件 flush + **原子 no-replace 创建**;旧版 `outbox.json` 快照按需导入且**从不改写或删除**;`onemind sync` 负责重试未投递项;同一 payload 的精确重试**复用同一 pending 提案**(服务端幂等),不产生重复。

**对 ZCode 的落点**:定时发送队列、CommandInbox 的未投递输入、远控命令队列都可以对照这套模式自查:逐事件不可变文件 + 原子创建 + 显式准入上限 + 精确重试幂等。尤其"**精确重试复用同一 pending 记录**"值得写进 relay 协议的幂等边界。

### 3.7 任务板的人工介入路由(交互模式参考)

- **"Needs me" 视图**:把"等你处理的(工具提问/待审批/被阻塞)、正在替你跑的、7 天内完成待你看的"聚合成一屏——比纯时间线更贴合注意力分配。
- **权限请求带 TTL**:倒计时显示,超时未答=按拒绝处理,不会无限挂起。部分请求支持**结构化表单**回答(填完 Send answer 回传给工具)。
- **审批的三档细化**:非 owner 发跟进消息要 owner 审批,owner 可选 `Approve / Allow for this task / Decline`——"本次放行"作为一次性与永久之间的中间档。
- **跨用户分配要工具 owner 审批**:任务 Assigned 前插一道 `Awaiting approval`;拒绝则回退 Todo。
- **归档是个人的**(不影响他人视图),**侧栏排序是个人的**(存服务端,不互相同步)——明确区分 per-user 状态与全局事实,与 AGENTS.md"UI 局部状态不应被误当作服务端事实"同构。

**对 ZCode 的落点**:任务列表分组、手机远控的权限审批 UI(超时语义、结构化回答)、`Allow for this task` 中间档授权都可直接借用;`Needs me` 的三段聚合是任务列表产品化的低成本改法。

### 3.8 Worktree 隔离 + 并发上限

可选开关"任务跑在独立 worktree":`~/OneMind Worktrees` 下按 `onemind/<task>` 建分支,**永不自动删除**(明确让用户 merge 后手动 `git worktree remove`);每 Mac 并发 1–4;不开 worktree 时同 Project 任务自动排队,**保证任务永不共享文件夹**。

**对 ZCode 的落点**:ZCode 若做并行任务/批量定时发送,这是现成的隔离方案与安全默认值(默认不开、并发小、排队保底、产物永不自动清理)。

### 3.9 云端 agent 的"不落盘"边界与动作卡片

- agent 声明式边界:"**The agent never runs code, edits files, or executes commands on a device**; all work happens in the assigned tool."它能做的是 28 个目录化操作(列任务、读 Mind、触发同步、代答工具提问……)。
- **动作卡片**:agent 产出结构化卡片,用户点 `Run action` 才执行,`Cancel` 丢弃,"Nothing runs until you select Run action";卡片状态机 `Ready to run / Working / Completed / Failed / Stopped / Interrupted`(Interrupted 明确提示"先检查结果再决定是否重跑")。
- **proposal-bound 操作**:卡片先解析到精确记录(具体哪个 Mind、哪条提案)再呈现,避免模糊目标。
- **MCP 细粒度 consent**:每个工具一个权限;插件层进一步做 `onemind_read`(23 个读操作)/ `onemind_action`(34 个写操作)分离,并明确"**read/action 分离不等于授权**:action 必须匹配用户明确请求"。`files.check` 会创建审批请求、`mind-check` 会上传证据——这两个名字像读的操作被显式标注"不是被动读"。
- 上下文占用透明化:composer 常驻"还剩多少上下文",点开能看到六类填充来源(对话/操作结果/团队指导/项目/命令/任务团队),100% 时明确说"无法回复,请开新会话"。

**对 ZCode 的落点**:插件/MCP 权限粒度、"名字像读但会写状态"的工具显式标注、动作卡片的状态机(含 Interrupted 语义)、上下文填充来源分解——都是 ZCode 权限与 agent UI 可以直接吸收的交互细节。

### 3.10 CLI 工程纪律(零散但都值得抄)

- 退出码语义化:0 成功 / 3 action-required(更新指引、refused)/ 4 wait-exhausted;refused 与 wait-exhausted 都**禁止自动重试**。
- 显式确认参数:`--yes`(删除)、`--force`(覆盖下载,且明确"force 只授权本次下载,永不算作受治理替换的授权")。
- freshness check 必须带 `--ai` 显式消歧(多工具共享目录时,禁止隐式选择目标)。
- 幂等:创建带 `--idempotency-key`;模糊重试时"复用创建键和精确 payload,出现 stale-head 冲突就停下解决,不要蒙着重试"。
- `files` 库默认**解析到当前目录所属的最精确 Project 绑定,解析不到就失败**,绝不静默回退到 Team 库(`--team` 是显式逃生门)——"fail closed instead of silently falling back"。
- 后台服务日志路径、状态文件路径全部文档化;回执/事务日志/host-rollback 快照放在 `~/.onemind/integrations/` 下分目录管理。

**对 ZCode 的落点**:`apps/zcode-cli` 的退出码约定、显式确认参数、workspace 解析失败不静默回退(与 workspaceIdentity fallback 规则互补:fallback 要显式,解析失败不隐式)、更新器不自替换。

### 3.11 备份与恢复中心

- Local/Cloud 双栏;每条备份展示 **Changelog**(Edited/Added/Removed)与 **Original files**(变更前内容),**先检查后恢复**;浏览器里检查备份不授予覆盖本地文件的权限。
- `Restore before onemind` 一键回到接管前状态,恢复时**保留无关文件、其他工具的受管区和备份历史**;绑定或文件已变化时"刷新恢复计划再确认,不强推旧计划"。
- 恢复旧版 Mind 与恢复本地文件是两条路:本地文件直接恢复,历史版本必须走新提案——"history is not rewritten in place"。
- Settings > Storage:视图缓存可清(保留登录/草稿/备份/绑定);草稿**设备本地**不过期、不同步;folder 断链可重连或换路径,换路径后旧路径标注 `Replaced by` 且可切回。

**对 ZCode 的落点**:`settings-storage-management`、"回到接管前"式的一键回滚(对 hook/插件安装尤其有用)、"恢复计划过期需刷新,不强推"。

### 3.12 会话共享与跨工具接力

- 会话只来自用户**主动连接**的工具;owner 可对单个会话 `Show to team / Hide from team`,全局开关关闭时会撤下已共享的会话。
- "Continue this session":会话 idle、Mac 在线时,消息在**原 Mac、原目录**续跑同一会话;turn 进行中则等 turn 结束。
- 跨工具接力不传原始会话,而是传**结构化运行结果**(回复、清单、变更文件、链接、分支)+ 新消息,新工具从结果冷启动;自己的工具立即开始,别人的工具等 owner 审批。

**对 ZCode 的落点**:手机远控复用桌面 Host 的设计方向一致;跨 agent 接力的"结构化结果交接而不是会话搬运"对 subagent 协作、跨窗口任务接续有直接参考价值(与 `docs/subagent-*`、`docs/web-remote-control-*` 呼应)。

### 3.13 文档与规格风格(最易被忽视、ROI 最高)

onemind 文档有一些可以整体移植到 ZCode spec 写作的习惯:

1. **边界全是精确数字**:8,000 字符 / 512 KiB / 1 MiB / 消息 16 KiB / 附件 4 个·64 KiB·2 MiB·单条 4 MiB / 邀请 50/24h·200/7d / 恢复副本 100 MiB·未保护副本 7 天过期 / 准入 1,000 事件·4 MiB。没有"适当限制"这类模糊词。
2. **"X 不是 Y"消歧句式**贯穿全文:草稿≠已发布、等待停止确认≠已停止、本地就绪≠主机证明、Package prepared≠Host connected、送达≠被正确使用、提案 pending≠已发布变更。每个易混概念都成对声明。
3. **每页写清"谁能做什么"**:Any member / Admin / device owner / tool owner 逐操作标注;per-user 状态(归档、排序、草稿)与全局事实逐条声明归属。
4. **每个错误状态有专属文案**+下一步动作(见 3.4),没有笼统错误。
5. **诚实的验证声明**:多处明确"发布/送达/检查通过,不等于你的活动会话已经生效"。

这与 AGENTS.md 的 spec-first、状态所有者、幂等边界要求完全同向,可以作为 fork 内 spec 模板的对照范本。

## 4. 不建议照搬的部分

| 差异点 | 说明 |
| --- | --- |
| 产品定位 | onemind 是纯管理层,自己不执行任务;ZCode 是执行 agent。治理层要**轻量嵌入** ZCode 既有流程,不能整层引入 |
| 审批流重量 | 全量 PR 式审批对单人/小团队偏重;ZCode 当前以单机为主,应做成**可选开启的团队治理**,默认直写 |
| 隐私模型 | onemind 中心化保存全部团队记忆与任务记录;ZCode 偏本地优先(relay 只做鉴权/转发不存业务状态),共享记忆若引入需按 ZCode 的边界重设计 |
| 端侧适配面 | 13 个第三方工具适配 + macOS-only 深度集成是它的护城河,不是 ZCode 需要的;ZCode 已有 host/relay 架构 |
| 云 agent | onemind agent 是云上纯指挥所;ZCode 的 agent 在本地/远端 workspace 有完整运行时,只需吸收其动作卡片与 consent 细节 |

## 5. 与 ZCode 能力对照

| 领域 | ZCode 现状(依据 AGENTS.md / 仓库文档) | onemind 做法 | 建议 |
| --- | --- | --- | --- |
| 指令/配置治理 | 系统提示词配置档、AGENTS.md、hooks;spec-first 流程 | 提案→Safe Check→审批→不可变版本→同步 | 借鉴治理流与 Review 级确认勾选,做成可选团队功能 |
| 受管文件写入 | 有设置存储管理(`docs/settings-storage-management.md`) | 受管块 + fail-closed + 首写备份 + hash 回执 | 直接吸收写入纪律 |
| 同步/恢复状态机 | desktop-continuous vs web-remote-replayable 双链路 | Queued→Applying→Confirmed + overdue/rollback 词汇表 | 吸收词汇表与"送达≠生效"文案 |
| 可靠投递 | `web-remote-control-task-command-queue`、CommandInbox 串行 admission | outbox 逐事件不可变文件 + 原子创建 + 精确重试幂等 | 对照自查,吸收幂等重试语义 |
| owner/lease | 已有 owner/lease、跨 Host 路由、stale run 防护 | checkpoint manifest(0600)+ 轮换租约 + 幂等键,崩溃可续 | 做一次对照复盘 |
| 权限审批 | `dangerous-command-approval-v1-plan`、CUA 权限 | TTL 超时=拒绝、结构化表单、Allow for this task 中间档 | 吸收交互细节 |
| 任务列表 | `task-*` 系列、分组恢复 | Needs me 三段聚合、任务 Checker 查重 | 产品化参考 |
| 并行任务 | 子代理、定时发送 | worktree 隔离 + 并发 1–4 + 同 Project 排队 | 做并行任务时直接参考 |
| CLI | `apps/zcode-cli`、`zcode-mr-cli-auth` | 退出码语义、显式确认、fail-closed 解析、更新不自替换 | 逐项对照 |
| 远程授权 | relay v3 设备配对(进行中) | 浏览器式设备授权("Authorize this Mac")+ 过期请求明确文案 | 文案与状态命名参考 |

## 6. 信息来源

以下页面于 2026-11-15 抓取(部分经浏览器渲染读取):

1. [Overview](https://onemind.team/docs/)
2. [Getting started](https://onemind.team/docs/getting-started/)
3. [Sign-in and accounts](https://onemind.team/docs/sign-in-and-accounts/)
4. [Minds and review](https://onemind.team/docs/minds-and-review/)
5. [Mind Sync](https://onemind.team/docs/mind-sync/)
6. [Sync and share team memory](https://onemind.team/docs/sync-and-share-team-memory/)
7. [Sync activity](https://onemind.team/docs/sync-activity/)
8. [Matrix tasks](https://onemind.team/docs/matrix-tasks/)
9. [Matrix conversations](https://onemind.team/docs/matrix-conversations/)
10. [The onemind agent](https://onemind.team/docs/the-onemind-agent/)
11. [Team and AI tools](https://onemind.team/docs/team-and-ai-tools/)
12. [Team administration](https://onemind.team/docs/team-administration/)
13. [Projects and folders](https://onemind.team/docs/projects-and-folders/)
14. [Files and skills](https://onemind.team/docs/files-and-skills/)
15. [Backup and recovery](https://onemind.team/docs/backup-and-recovery/)
16. [Notifications and settings](https://onemind.team/docs/notifications-and-settings/)
17. [BETA plugin workflows](https://onemind.team/docs/beta-plugin-workflows/)
18. [CLI command reference](https://onemind.team/docs/cli-command-reference/)
19. [CLI service and files](https://onemind.team/docs/cli-service-and-files/)
20. [Use onemind with TRAE](https://onemind.team/docs/use-onemind-with-trae/)

> 注:BETA 0.4.14 文档首页自述"0.4.15 发布合同已备妥,0.4.13 为已接受基线",版本细节可能随发布变化;本报告引用以 2026-11-15 抓取内容为准。
