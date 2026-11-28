# Workspace Sidebar Footer

## 目标

统一 workspace 侧边栏与 Settings 侧边栏底部的入口交互，避免两处行为不一致。

## 当前行为

- relay v3 账号是应用登录；footer 不再承载 OAuth / API Key 登录态，也不展示用户头像、用户名、ID 或套餐 badge。
- 触发按钮固定显示 `Z` 标识与「设置」文案，仅作为偏好菜单锚点；`aria-label` 使用 `settings.title`。
- 下拉菜单包含语言、主题、界面模式和桌面缩放等偏好项，以及一个 relay 登录入口（`TID_LOGIN_MENU_ITEM`）。该入口打开 relay 欢迎页；已登录时欢迎页会立即关闭并回到工作区。OAuth 登出操作已移除。
- 收到宿主 `update-ready` 事件后，设置按钮左侧会显示一颗 `Update` 按钮。
- 在 Settings 侧边栏底部复用同一个 footer 组件，但菜单里不再重复展示“设置”入口。
- 升级/续费入口始终显示；当前上下文无法解析 provider 时默认进入 Z.ai Coding Plan。
- 剩余额度详情保留在 Usage 页和聊天输入框 context 浮层，不在 footer 菜单中重复展示。

## 已移除

账号头像/用户名/ID/套餐 badge、复制用户 ID、OAuth 登录/退出菜单项随应用登录改为 relay v3 一并移除。浏览器候选用例 `packages/ui/test/browser/manual-review/pending/sidebar-user-id.test.mjs` 随之删除。

## 实现位置

- 账号区组件：`packages/ui/src/WorkspaceSidebarFooter.tsx`
- Settings 侧边栏挂载：`packages/ui/src/SettingsPage.tsx`
- 用量展示：`packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx`
- 应用登录契约：[relay-login.md](./relay-login.md)
