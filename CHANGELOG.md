# Changelog

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
