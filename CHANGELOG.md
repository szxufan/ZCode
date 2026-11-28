# Changelog

## [4.0.5](https://github.com/szxufan/ZCode/compare/v4.0.4...v4.0.5) (2026-11-28)

### Bug Fixes

* **relay:** 连接后自动拉取目标工作区 ([131735c](https://github.com/szxufan/ZCode/commit/131735ccecea3b068edde9e282d31832ff4e4cf8))

* **relay:** 增加公钥指纹带外校验 ([b033e21](https://github.com/szxufan/ZCode/commit/b033e21a3fa4d0a166490f089d50555fbaf03d3a))
  * 二维码携带设备公钥指纹，手机扫码连接前强制比对目录公钥\n- 手机与桌面设备列表展示指纹，支持输入带外指纹后强制比对\n- 指纹不一致或缺省时拒绝扫码连接，防止 relay 替换公钥中间人

* **relay:** 重启后恢复远控启用意图 ([14cf3e2](https://github.com/szxufan/ZCode/commit/14cf3e285c672561ccc95ebbb3d76ebdf90d73d3))

## [4.0.4](https://github.com/szxufan/ZCode/compare/v4.0.3...v4.0.4) (2026-11-27)

### Bug Fixes

* **relay:** 修复远控地址草稿、登录状态与设备识别 ([385317a](https://github.com/szxufan/ZCode/commit/385317a72efcd9d2f9a10705b77b72f4c14c4800))
  * 服务器地址未保存时阻止发送验证码、登录和启动远控并提示保存\n- 登录成功后立即广播账号状态，无需重进设置页\n- 持久化设备机器名，标记本机并禁止自连


### Chores

* **ci:** 精简 pre-push Lint 输出 ([e8e02c3](https://github.com/szxufan/ZCode/commit/e8e02c3e3e9382b8ab1e7114d87f483366e66f13))

## [4.0.3](https://github.com/szxufan/ZCode/compare/v4.0.0...v4.0.3) (2026-11-26)

### ⚠ BREAKING CHANGES

* remove cloud-coupled features (telemetry report, marketing, rewards, highspeed card, context-prompt rollout, feedback, client scenes, mcp quota display, conversation share, off-peak, mobile remote control)

### Features

* 新增计划审批与保存功能模块，支持选择执行模型和导出计划文件 ([f3ff9dd](https://github.com/szxufan/ZCode/commit/f3ff9dd5245ead64a2bc7ae708e6b4ad014776a1))

* 新增文件预览就地编辑功能模块 ([5243f59](https://github.com/szxufan/ZCode/commit/5243f593d248fc365c3e0e0769d06f7c9157909b))

* 新增问题导航目录轻量分页接口实现 ([4c30373](https://github.com/szxufan/ZCode/commit/4c3037301052df2b3ff2ef0f49c476026955d9da))

* add GitHub Actions release pipeline ([0a6327e](https://github.com/szxufan/ZCode/commit/0a6327e7b2c38083e982bad780715d0c1eb0fd79))

* **agent-prompt:** 内置主 Agent 系统提示词中文化并支持多配置档快速切换 ([1a0324c](https://github.com/szxufan/ZCode/commit/1a0324c9c730ce3975d8230012f391724c5020a8))
  * 内置提示词静态文案（身份/Harness/沟通规范/上下文管理/环境与 Git 标签/Memory/
  * 新增 systemPromptOverride：只替换 identity/Dynamic Behavior/Session Guidance/
  * 配置档存 ~/.zcode/v2/setting.json（agentPromptProfiles/agentPromptActiveProfileId，
  * 设置页新增 agentPrompt 分区（增删改/载入内置全文/恢复默认）；composer 切换模式旁
  * 热更新走新增协议方法 workspace/updateAgentPromptPreferences（旧 CLI
  * 回归测试随实现更新为中文断言（context-builder/runtime-reminders/runtime-trace/

* **agent-prompt:** 系统提示词配置档 AI 生成/修改并收口草稿状态时序 ([bd90e7a](https://github.com/szxufan/ZCode/commit/bd90e7ada645418cf97007d275771ddae53bc334))
  * 执行上下文复用 resolveModelProviderConnectivityWorkspacePath 过滤远端
  * AI pending 期间锁定正文与取消按钮，完成时校验草稿未被切换，撤销点与
  * 遥测超时显式覆盖 catalog 默认 30s（取 deadline + 取消缓冲），长请求不
  * 无工作区/无模型/空输出只抛稳定错误码，UI 侧按码映射 i18n 文案
  * 同步 spec §6、trace catalog、双语 i18n 与架构策略未受管文件例外

* **composer:** 定时发送——草稿按选定时间投递为一次性 automation ([8e51330](https://github.com/szxufan/ZCode/commit/8e513305d7d6bdb7c697f4158c62c961da0317d9))
  * 发送键右侧新增「设为定时」入口：预设时间点（本地偏好，localStorage 持久化）
  * 自定义日期时间，确认时按当前时刻重算目标时刻
  * 一次定时发送 = 一条 recurring=false automation（relativeDelayMinutes），
  * 服务层 createAutomation 收口 cronExpr/relativeDelayMinutes 二选一门禁并透传 targetTaskId
  * 入口仅本地 workspace 且支持纯文本：附件/引用等非文本上下文禁用并说明原因
  * 新增 scheduled-send 架构模块（契约层/时间换算/提交入参纯函数 + 预设 store），

* **desktop:** 发版流水线支持 Linux x64 构建并限定 deb 目标 ([a9e2244](https://github.com/szxufan/ZCode/commit/a9e2244d8ff57360d05706fa5c2d2676ae7a0ad4))

* **provider:** 新增连接派供应商与模型拉取选择导入 ([44fabc0](https://github.com/szxufan/ZCode/commit/44fabc063d8b0b03fe65c036b2e9ee2c729fe163))

* **relay-server:** 重构构建与启动逻辑，优化admin CLI可用性 ([d60ff97](https://github.com/szxufan/ZCode/commit/d60ff9728959497a842773b39950e4e087dfc4be))

* **relay:** 远程控制设置新增 Relay 服务器地址，不再需要手改配置文件 ([9e92fae](https://github.com/szxufan/ZCode/commit/9e92faea11c571e27fbfeb276c29fc206f996584))
  * 入口：设置 → 远程控制 → 「Relay 服务器地址」，保存或回车生效，并纳入设置搜索
  * 格式：须为带 http(s) 协议头的 origin；原先只能手改 setting.json 且无校验；现在由 main 归一化（去尾斜杠、主机小写、去默认端口），非法输入就地报错不落盘
  * 切换地址：保存不同的地址等同停止远控并登出，需在新地址重新登录并手动启动；保存相同地址为 no-op
  * 切换顺序：先对旧地址登出、丢弃已注册设备身份，再写入新地址，避免旧凭据被发给新服务器
  * 登出：原先等待远端撤销返回（旧 relay 不可达时最长 15s）；现在本地立即生效，远端撤销后台尽力而为
  * 启动被打断：注册等待期间停止/登出/切换地址后不再拉起连接，迟到的注册结果不保留（relay 侧补偿删除）、迟到的失败不改写状态
  * 规则、所有权与事件顺序见 docs/relay-server/relay-v3-design.md §3.5

* **relay:** Relay V3 P0 —— 自托管中继服务端、共享协议模块与 fake fixture ([4b10280](https://github.com/szxufan/ZCode/commit/4b10280edfc45ae73d0fe41404af01696642a507))
  * relay-server/：全新 Fastify + ws + node:sqlite 自托管中继 workspace 包，
  * packages/shared/src/remote-relay-v3/：V3 契约（HTTP/WS 消息 zod 校验）、
  * packages/shared/test/fixtures/：fake-relay-v3 测试接缝与 fake/真实实现
  * 清理 fork 已移除的旧 web 远控链路遗留测试（mobileLog / actionRequests）。
  * architecture-policy.yaml 登记 remote-relay-v3 与 relay-server 模块边界；

* **relay:** relay-v3 安全加固 —— 批准前指纹预览、refresh 家族隔离与数据面防护 ([daef154](https://github.com/szxufan/ZCode/commit/daef154b084a7bb75047859807e4e94721ce581e))
  * device-auth：新增只读 POST /v3/device-auth/preview（Bearer，与 approve
  * refresh 家族：access JWT 携带 fam；登出只撤销当前家族（旧无 fam token
  * 信封 AAD 方向绑定（发送方角色域分隔），防密文反射/重放；spec §4.4 同步。
  * 数据面：chunk 组装 offset 连续性/越界拒绝、整流 CRC 增量计算（不再按
  * 限流与回收：relay token 30/分钟/IP、密码登录 10/分钟/IP（未知账号也计
  * 修复 bug：并发 HTTP 计数在 503 拒绝分支泄漏（根因：释放监听注册在超限
  * static 路径穿越改用 relative 判定（防同前缀兄弟目录绕过）；SPA 回退仅

* remove cloud-coupled features (telemetry report, marketing, rewards, highspeed card, context-prompt rollout, feedback, client scenes, mcp quota display, conversation share, off-peak, mobile remote control) ([dcd08aa](https://github.com/szxufan/ZCode/commit/dcd08aa65d063805d5ed72cf357ca84d61c72877))
  * 遥测上报：/api/v1/event/report 出网链路与构建期端点注入；保留 deviceMid
  * 营销触达 + 云内容：/api/v1/marketing/touch、banner/弹窗/素材、cloud-content-dialog
  * 奖励中心：内嵌 webview、shared 契约、desktop 分区与信任域
  * 高速卡：draw/healthy 服务、整套 UI；v4 协议 schema 保留（旧会话 transcript 兼容）
  * context prompt 灰度：rollout、Host env 透传、CLI --surface 注入链；
  * 反馈工单：服务、UI、桌面命令/菜单/平台契约；通用"导出日志"保留
  * client scenes：/api/v1/client/scenes 全栈；自动化模板回退本地目录
  * MCP 用量：/api/v1/mcp/usage provider 与展示；普通套餐用量保留
  * 会话分享：发布/导入全链、packages/web-share 与 packages/share-ui 整包；
  * 闲时任务（off-peak）：票据服务、mock 网关、UI、桌面派发；
  * 手机远控：packages/web、packages/android 整包，server 的 http 入口
  * 每个特性单属主垂直切除，shared 协议/transcript 兼容层最小保留
  * zcodeEndpoint 的套餐（zcode-plan billing）、OAuth、强更、模型路由等
  * 架构：architecture-policy.yaml 同步移除 8 个已删模块注册，
  * 前：上述特性在桌面/Web/CLI 可用，客户端向 ZCode 服务出网上报/拉取
  * 后：对应入口不存在；会话/任务/模型/账号/自动化的既有行为不变；
  * pnpm typecheck exit 0；pnpm lint 0 errors（128 warnings 与基线持平）
  * pnpm architecture:check --changed OK
  * packages/ui 单测全量 9095 用例通过；shared/services/desktop/desktop 关键面
  * pnpm-lock.yaml 随包删除重新生成；版本 3.16.2 → 3.17.0

* **ui:** 辅助对话关闭改为 detach，支持从历史列表重开 ([f1aa4b9](https://github.com/szxufan/ZCode/commit/f1aa4b97013447fb860857628ac9f46f886d0cfb))
  * 关闭 tab：原先 closeSession；现在 stop + 退订，不进 close lifecycle
  * 历史重开：原先无入口；现在启动页列出最近 20 条，点击即重开，草稿与选区引用不恢复
  * session/list：新增 parentSessionId / sessionKind 过滤（与 sessionIds 互斥）。
  * 最近关闭：辅助对话 tab 进入最近关闭列表


### Bug Fixes

* **deps:** 用钉定的 pnpm@10.33.2 重生成 lockfile，修复 v3.25.0 发版 CI 的 frozen install 失败 ([b7131a4](https://github.com/szxufan/ZCode/commit/b7131a41c88dc0187a6fb688e2e616c29bc7bb3a))

* **desktop:** powershell 工程测试强制 UTF-8 输出，修复 GBK 代码页机器上中文断言乱码 ([3ba5a79](https://github.com/szxufan/ZCode/commit/3ba5a7952500c07d088db31541e862b9cd86af8a))

* **desktop:** tsup 外置 iconv-lite/prettier，修复安装包 main 进程启动即崩 ([5a5fe87](https://github.com/szxufan/ZCode/commit/5a5fe8728ef4112c759a053481df402db38d4b3f))

* **lockfile:** regenerate pnpm-lock.yaml with pnpm 10 patch hashes ([5c30248](https://github.com/szxufan/ZCode/commit/5c30248efebc00e5897e45b913265b1ec6cd9585))

* pass bundle target via --os/--arch in release workflow ([9ac1e6f](https://github.com/szxufan/ZCode/commit/9ac1e6fc78bc1776151c15140bd596eb1780fa1b))

* **plugins:** 移除官方 image-search 搜图插件并同步文档与测试 ([93a2901](https://github.com/szxufan/ZCode/commit/93a2901db2fb90b8ed809f80c8664efd790ec4c5))

* **scripts:** 首次推送基线按集成分支链回退，修复无 origin/staging 的 fork tag 推送被 pre-push 挡下 ([a629918](https://github.com/szxufan/ZCode/commit/a62991838d7b467351c71750050f321555dce834))


### Chores

* 清理合并带入的 packages/web 孤儿平台文件（fork 已移除 web 应用） ([b3b6aa0](https://github.com/szxufan/ZCode/commit/b3b6aa08ae3ad2e2b6dbfd80abbdf67dcea30eb3))

* 升级 pnpm 至 11.29.0 ([e55a6c0](https://github.com/szxufan/ZCode/commit/e55a6c02219ed5b663da010f077e078f8b336552)), closes [pnpm#12880]()

* ignore .openbitfun local directory ([868f749](https://github.com/szxufan/ZCode/commit/868f7493f135cb8bf8554ea75489a7441e3e6c41))

* ignore workspace-local .zcode app data directory ([bb80b5a](https://github.com/szxufan/ZCode/commit/bb80b5ae7291e31ac1bfd5b8e0f6ec2f742d3801))

* release v3.16.2 ([1c9f2b4](https://github.com/szxufan/ZCode/commit/1c9f2b4a2e05d6b9589fff771db346f39dcc74b6))

* release v3.18.0 ([b04ac2b](https://github.com/szxufan/ZCode/commit/b04ac2bf6e4c7b6a6daf462a64d513d0464555d4))

* release v3.19.0 ([355aedd](https://github.com/szxufan/ZCode/commit/355aedd4bb345f8ac3639da0444460c7931ce7af))

* release v3.20.0 ([6d0b284](https://github.com/szxufan/ZCode/commit/6d0b284a8906eb386f778a5884ea63e4c0d69379))

* release v3.21.0 ([d3813e1](https://github.com/szxufan/ZCode/commit/d3813e1a1a52255451bc9bfa8b841971f4abacbc))

* release v3.22.0 ([e7d5e7b](https://github.com/szxufan/ZCode/commit/e7d5e7be45881ffd755625a5eeebcfc702f48437))

* release v3.23.0 ([66148bc](https://github.com/szxufan/ZCode/commit/66148bc8e60c79cbc29b167f6fa2603c68b7f642))

* release v3.24.0 ([5f05707](https://github.com/szxufan/ZCode/commit/5f05707c8b673e876207e7099f666b2f1168addb))

* release v3.25.0 ([c4f8651](https://github.com/szxufan/ZCode/commit/c4f8651606f56a7e0296688d67d80302f27baaad))

* release v3.25.1 ([dcc48f1](https://github.com/szxufan/ZCode/commit/dcc48f1b87cc4cdcf5e901d2226a1b688fc544a9))

* release v4.0.1 ([0e04f9e](https://github.com/szxufan/ZCode/commit/0e04f9e81a486aa516ed81538f505591a36830e3))

* release v4.0.2 ([76ad283](https://github.com/szxufan/ZCode/commit/76ad28330f80957b1f5f138878a61030c582a8cf))


### Documentation

* AGENTS.md 新增上游合并经验（门禁+定向验证收敛、环境噪音分类、双父提交保护） ([6a80b00](https://github.com/szxufan/ZCode/commit/6a80b00ae9abd1a794818b478c0d1555cddc95ac))

* note fork tag-push baseline workaround in release spec ([47aa08c](https://github.com/szxufan/ZCode/commit/47aa08ced66222fd9456880d2ffce611e264e78b))

* onemind 文档调研与可借鉴点分析 ([0cfafb2](https://github.com/szxufan/ZCode/commit/0cfafb22f0d71a36f6c15c3c2c78a8ad8bbda385))


### Refactorings

* **composer:** 移除模型菜单内的思考强度设置并收敛到独立思考控件 ([89420ec](https://github.com/szxufan/ZCode/commit/89420eca43758aea1a6c968ddabdad5af589be81))

## [4.0.2](https://github.com/szxufan/ZCode/compare/v4.0.1...v4.0.2) (2026-11-25)

### Features

* **relay:** 远程控制设置新增 Relay 服务器地址，不再需要手改配置文件 ([eca6bce](https://github.com/szxufan/ZCode/commit/eca6bcef2ff0b6110c0c6e6b41d59a7a0d0c3196))
  * 入口：设置 → 远程控制 → 「Relay 服务器地址」，保存或回车生效，并纳入设置搜索
  * 格式：须为带 http(s) 协议头的 origin；原先只能手改 setting.json 且无校验；现在由 main 归一化（去尾斜杠、主机小写、去默认端口），非法输入就地报错不落盘
  * 切换地址：保存不同的地址等同停止远控并登出，需在新地址重新登录并手动启动；保存相同地址为 no-op
  * 切换顺序：先对旧地址登出、丢弃已注册设备身份，再写入新地址，避免旧凭据被发给新服务器
  * 登出：原先等待远端撤销返回（旧 relay 不可达时最长 15s）；现在本地立即生效，远端撤销后台尽力而为
  * 启动被打断：注册等待期间停止/登出/切换地址后不再拉起连接，迟到的注册结果不保留（relay 侧补偿删除）、迟到的失败不改写状态
  * 规则、所有权与事件顺序见 docs/relay-server/relay-v3-design.md §3.5

## [4.0.1](https://github.com/szxufan/ZCode/compare/v3.25.1...v4.0.1) (2026-11-24)

### Features

* **relay:** relay-v3 安全加固 —— 批准前指纹预览、refresh 家族隔离与数据面防护 ([11a7774](https://github.com/szxufan/ZCode/commit/11a77744bb14975ed23301ebdb730edf5cc7b7f1))
  * device-auth：新增只读 POST /v3/device-auth/preview（Bearer，与 approve
  * refresh 家族：access JWT 携带 fam；登出只撤销当前家族（旧无 fam token
  * 信封 AAD 方向绑定（发送方角色域分隔），防密文反射/重放；spec §4.4 同步。
  * 数据面：chunk 组装 offset 连续性/越界拒绝、整流 CRC 增量计算（不再按
  * 限流与回收：relay token 30/分钟/IP、密码登录 10/分钟/IP（未知账号也计
  * 修复 bug：并发 HTTP 计数在 503 拒绝分支泄漏（根因：释放监听注册在超限
  * static 路径穿越改用 relative 判定（防同前缀兄弟目录绕过）；SPA 回退仅

* **ui:** 辅助对话关闭改为 detach，支持从历史列表重开 ([a5c6099](https://github.com/szxufan/ZCode/commit/a5c6099322c21f677280236559b002b00e8ee919))
  * 关闭 tab：原先 closeSession；现在 stop + 退订，不进 close lifecycle
  * 历史重开：原先无入口；现在启动页列出最近 20 条，点击即重开，草稿与选区引用不恢复
  * session/list：新增 parentSessionId / sessionKind 过滤（与 sessionIds 互斥）。
  * 最近关闭：辅助对话 tab 进入最近关闭列表


### Chores

* sync ZCode source v4.0.0 ([a4b4445](https://github.com/szxufan/ZCode/commit/a4b4445141eb7d3b3e99eada9292775383bfc44e))


### Documentation

* onemind 文档调研与可借鉴点分析 ([cd12770](https://github.com/szxufan/ZCode/commit/cd127709faee9963970a52b2060d099e29890b34))

## [3.25.1](https://github.com/szxufan/ZCode/compare/v3.25.0...v3.25.1) (2026-11-14)

### Bug Fixes

* **ui:** 就地编辑主题色值转 hex，修复点击编辑后编辑区静默空白 ([857f348](https://github.com/szxufan/ZCode/commit/857f3481761e08bd5dc397b74bf8db80b1d03ab4))

## [3.25.0](https://github.com/szxufan/ZCode/compare/v3.24.0...v3.25.0) (2026-11-13)

### Features

* 新增问题导航目录轻量分页接口实现 ([224cc38](https://github.com/szxufan/ZCode/commit/224cc387baeed08e7834ebd90372c0749bc6766a))


### Bug Fixes

* **desktop:** powershell 工程测试强制 UTF-8 输出，修复 GBK 代码页机器上中文断言乱码 ([2c6ea19](https://github.com/szxufan/ZCode/commit/2c6ea19eeae5669466214c8aeed76c5e376718f4))


### Chores

* sync ZCode source v3.18.0 ([b95ebaf](https://github.com/szxufan/ZCode/commit/b95ebaffeab641907b38652f45c1502bd762972d))

* sync ZCode source v3.18.1 ([c590468](https://github.com/szxufan/ZCode/commit/c5904686ea8341826b3affe5d993d06a134fa779))

* sync ZCode source v3.18.2 ([fec9759](https://github.com/szxufan/ZCode/commit/fec975905a2abd4c07e35c40d51fa097a2258ec9))


### Documentation

* AGENTS.md 新增上游合并经验（门禁+定向验证收敛、环境噪音分类、双父提交保护） ([a1e1527](https://github.com/szxufan/ZCode/commit/a1e1527e78fdda58bbf830b630306974e0a06419))

## [3.24.0](https://github.com/szxufan/ZCode/compare/v3.23.0...v3.24.0) (2026-11-10)

### Features

* 新增文件预览就地编辑功能模块 ([7e9effc](https://github.com/szxufan/ZCode/commit/7e9effc603ef7d9f12d9e702a60dea66de39014f))

## [3.23.0](https://github.com/szxufan/ZCode/compare/v3.22.0...v3.23.0) (2026-11-09)

### Chores

* sync ZCode source v3.17.2 ([a9fe401](https://github.com/szxufan/ZCode/commit/a9fe401eede6e6e5e01be9048679c206fe6f02d9))

## [3.22.0](https://github.com/szxufan/ZCode/compare/v3.21.0...v3.22.0) (2026-11-04)

### Features

* **desktop:** 发版流水线支持 Linux x64 构建并限定 deb 目标 ([9e87bf0](https://github.com/szxufan/ZCode/commit/9e87bf0f58f986cc9e352e9b1c65252bb34abfa4))

* **relay:** Relay V3 P0 —— 自托管中继服务端、共享协议模块与 fake fixture ([03486bb](https://github.com/szxufan/ZCode/commit/03486bb3c423b7ede03bace0c576d3e7c0590f2e))
  * relay-server/：全新 Fastify + ws + node:sqlite 自托管中继 workspace 包，
  * packages/shared/src/remote-relay-v3/：V3 契约（HTTP/WS 消息 zod 校验）、
  * packages/shared/test/fixtures/：fake-relay-v3 测试接缝与 fake/真实实现
  * 清理 fork 已移除的旧 web 远控链路遗留测试（mobileLog / actionRequests）。
  * architecture-policy.yaml 登记 remote-relay-v3 与 relay-server 模块边界；

* **relay:** Relay V3 P1–P4/R4 —— 桌面被控端、手机 Web、桌面互控、headless 设备授权与数据面分块帧 ([b72e56f](https://github.com/szxufan/ZCode/commit/b72e56fe3384121689b89b2ae3fcf5ec25eecff5))
  * fake-relay-v3 双跑矩阵）已交付；本提交实现剩余全部客户端与 R4 里程碑。V2 客户端
  * shared remote-relay-v3：新增 payload（bootstrap/bridge/view-state 业务契约）、
  * P1 桌面被控端：main 侧 relay 账号登录（refresh 旋转+重放撤销家族）、X25519
  * P2 手机 Web：新建 packages/web（/remote/v4），手机号+验证码登录、设备列表
  * P4 桌面互控：relayTerminalManager（与被控端独立）、bridge port 投递控制端
  * R4：zcode server login（设备授权 request→批准→poll，凭据/私钥落 server root
  * P3：部署指南 docs/relay-server/deployment.md；V2 文档归档、孤儿测试与 stale

## [3.21.0](https://github.com/szxufan/ZCode/compare/v3.20.0...v3.21.0) (2026-10-31)

### Miscellaneous

* **sync:** 合并上游 zai-org/ZCode v3.17.1 开源同步（a60ba6a7，5231 文件），保留 fork 全部自有功能与云端功能移除边界
  * 采纳上游保留功能演进：ProviderProvisioningLane、设备数据同步、Personalization 设置分区、Sites 启动器、窗口 Host 终端 owner、会话 ID 预分配、/reload 恢复命令、ConversationTelemetryEngine、electron 44、engineering 工程测试与 verify:pre-push 新链路
  * CLI 系统提示词保留 fork 中文体系；测试基建取混合形态（fork unit/fork-isolated + 上游 engineering 清单）
  * 上游退役的 App 业务单测按其策略接受；fork 自有功能单测 112/112 通过

## [3.20.0](https://github.com/szxufan/ZCode/compare/v3.19.0...v3.20.0) (2026-10-30)

### Features

* **composer:** 定时发送——草稿按选定时间投递为一次性 automation ([6a7e592](https://github.com/szxufan/ZCode/commit/6a7e5928c10b3efb4a373d0f3fc428342e377826))
  * 发送键右侧新增「设为定时」入口：预设时间点（本地偏好，localStorage 持久化）
  * 自定义日期时间，确认时按当前时刻重算目标时刻
  * 一次定时发送 = 一条 recurring=false automation（relativeDelayMinutes），
  * 服务层 createAutomation 收口 cronExpr/relativeDelayMinutes 二选一门禁并透传 targetTaskId
  * 入口仅本地 workspace 且支持纯文本：附件/引用等非文本上下文禁用并说明原因
  * 新增 scheduled-send 架构模块（契约层/时间换算/提交入参纯函数 + 预设 store），


### Chores

* ignore .openbitfun local directory ([ec00416](https://github.com/szxufan/ZCode/commit/ec00416c871cd3863b8667ec920e336e687eca20))

## [3.19.0](https://github.com/szxufan/ZCode/compare/v3.18.0...v3.19.0) (2026-10-29)

### Features

* **agent-prompt:** 系统提示词配置档 AI 生成/修改并收口草稿状态时序 ([6ba9a17](https://github.com/szxufan/ZCode/commit/6ba9a17a628f7ecefa52e068460d675b6b64df6f))
  * 执行上下文复用 resolveModelProviderConnectivityWorkspacePath 过滤远端
  * AI pending 期间锁定正文与取消按钮，完成时校验草稿未被切换，撤销点与
  * 遥测超时显式覆盖 catalog 默认 30s（取 deadline + 取消缓冲），长请求不
  * 无工作区/无模型/空输出只抛稳定错误码，UI 侧按码映射 i18n 文案
  * 同步 spec §6、trace catalog、双语 i18n 与架构策略未受管文件例外


### Bug Fixes

* **plugins:** 移除官方 image-search 搜图插件并同步文档与测试 ([36ad71e](https://github.com/szxufan/ZCode/commit/36ad71e59de2e1e7724115202bd5f22d3e87586f))

## [3.18.0](https://github.com/szxufan/ZCode/compare/v3.17.0...v3.18.0) (2026-10-29)

### Features

* **agent-prompt:** 内置主 Agent 系统提示词中文化并支持多配置档快速切换 ([9495d54](https://github.com/szxufan/ZCode/commit/9495d54096d6df86bb0614c48a79e8dcd06e2bd5))
  * 内置提示词静态文案（身份/Harness/沟通规范/上下文管理/环境与 Git 标签/Memory/
  * 新增 systemPromptOverride：只替换 identity/Dynamic Behavior/Session Guidance/
  * 配置档存 ~/.zcode/v2/setting.json（agentPromptProfiles/agentPromptActiveProfileId，
  * 设置页新增 agentPrompt 分区（增删改/载入内置全文/恢复默认）；composer 切换模式旁
  * 热更新走新增协议方法 workspace/updateAgentPromptPreferences（旧 CLI
  * 回归测试随实现更新为中文断言（context-builder/runtime-reminders/runtime-trace/


### Chores

* ignore workspace-local .zcode app data directory ([e47ee12](https://github.com/szxufan/ZCode/commit/e47ee126fc69533c351efd5e52fd021ebd4f2b27))


### Refactorings

* **composer:** 移除模型菜单内的思考强度设置并收敛到独立思考控件 ([5c6e94f](https://github.com/szxufan/ZCode/commit/5c6e94f3ef13ad263068df9e11bc9720606519da))

## [3.16.2](https://github.com/szxufan/ZCode/compare/v3.15.1...v3.16.2) (2026-10-26)

### Features

* add GitHub Actions release pipeline ([0a6327e](https://github.com/szxufan/ZCode/commit/0a6327e7b2c38083e982bad780715d0c1eb0fd79))


### Chores

* sync ZCode source ([3c5b227](https://github.com/szxufan/ZCode/commit/3c5b227649371507ddc4eb46ac5133afe6db1cab))

* sync ZCode source ([0a1fc56](https://github.com/szxufan/ZCode/commit/0a1fc56d279fd1001f78387bd81aec1c26767411))


### Documentation

* note fork tag-push baseline workaround in release spec ([18e0d5f](https://github.com/szxufan/ZCode/commit/18e0d5f436d2d7a2a587bd3940e7fbd7cebf827b))
