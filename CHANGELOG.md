# Changelog

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
