# ADR 0005：桌面应用登录由 OAuth 改为 relay v3 账号

- 状态：已采纳
- 日期：2026-11-28
- 相关：[relay-login.md](../ui/relay-login.md)、[relay-v3-design.md](../relay-server/relay-v3-design.md)

## 背景

fork 提交 `dcd08aa65` 移除云耦合功能时，显式把 OAuth 保留为白名单消费（套餐、模型路由、账号链路不变）。此后 relay v3 落地，提供了仓库内自托管的账号体系（手机号 + 短信验证码），桌面端已有完整的 relay 登录表单与 main 会话所有者。现有 Z.AI/BigModel OAuth 欢迎页与「连接使用」入口对新用户仍是必经门禁，用户判断该入口与欢迎页应当替换为 relay 登录。

## 决定

1. 桌面应用级登录使用 relay v3 账号；欢迎页与侧边栏入口保留，内容改为 relay 手机号 + 验证码登录。
2. OAuth 应用登录、欢迎页 API Key 表单及 OAuth 用户态从桌面 UI 移除；依赖 `user` 的能力（语音输入、Coding Plan 套餐/升级、用量、插件区域、onboarding 身份）接受降级，改为匿名/基于 provider。
3. 模型凭证由用户在设置页用 fork 自有「连接派 / linkpi」模板填写自己的 API Key；provider 可用性不再作为登录门禁。
4. `packages/services/src/oauth/**` 与 CLI 登录保留，继续服务 provider 运行时、Coding Plan webview 与 CLI；不删宿主侧 OAuth 服务。
5. 启动门禁改为 relay 账号判定，依赖 main 广播的 `restored` 事实；relay 不可用时跳过。

## 后果

- 反转 `dcd08aa65` 中「OAuth 白名单保持不变」的决定；账号、套餐、团队身份相关的 UI 能力降级，属可接受的 fork 产品选择。
- 支持 relay 自部署的团队可用同一账号体系登录桌面与远控；无需 Z.AI/BigModel 账号即可进入应用。
- 历史 OAuth 登录文档归档到 `docs/archive/oauth-login/`，新契约以 `docs/ui/relay-login.md` 为准。
