# ZCode JWT 过期重新认证

## 状态

- 本文定义 OAuth 服务 / CLI 在 `zcodejwttoken` 过期后的认证恢复语义；桌面应用登录已改为 relay v3 账号（见 [relay-login.md](../ui/relay-login.md)），不再由 JWT 过期驱动欢迎页。
- `zcodejwttoken` 的签名与最终有效性仍由服务端负责；客户端只解析 JWT `exp`，用于避免恢复明显过期的本地会话。

## 问题

旧实现使用缓存的 `user_info` 恢复登录展示态，只检查 `zcodejwttoken` 是否存在，不检查 JWT `exp`。因此 JWT 过期后，UI 仍显示已登录，但余额、模型和其他业务请求会继续携带过期凭据并失败。

旧的 `useTokenRefresh` 只暴露回调，没有实际监听 401；同时 Z.AI / BigModel 当前没有可用于续期 `zcodejwttoken` 的客户端 refresh 实现，所以已确认过期时必须由用户在设置页重新连接对应 provider，而不是由应用登录流程跳转到欢迎页。

## 产品语义

缓存会话恢复返回三种结构化状态：

- `authenticated`：缓存用户完整，且 JWT 没有被客户端判定为过期。
- `signed-out`：没有完整缓存会话；不显示过期提示。
- `reauthentication-required`：JWT 含有效 `exp`，并且在当前时间（含时钟偏差）已经过期。

JWT 无法解析或缺少 `exp` 时，客户端不能证明它已经过期，继续按兼容缓存处理；服务端仍可在后续请求中拒绝它。服务端 401/403 的统一失效广播属于后续独立工作，不在本次修复中用字符串匹配扩散到所有 provider。

## 状态与时序

```text
持久化 OAuth 会话
        |
        v
读取 user_info + zcodejwttoken
        |
        +-- 会话不完整 ----------------------> signed-out
        |
        +-- JWT 无可用 exp / 尚未过期 --------> authenticated
        |
        +-- JWT exp 已过期
                |
                v
        在 mutation 队列内复核 provider、user_info、
        zcodejwttoken 与会话 generation 是否仍匹配读取快照
                |
                +-- 快照已变化（新登录/provider 切换）
                |       |
                |       v
                |   放弃旧清理并重新读取当前会话
                |
                +-- 快照仍一致
                |       |
                |       v
        原子清理 active provider、OAuth token、
        zcodejwttoken 和缓存 user_info
                |
                v
        尽力清理派生 Coding / Start Plan provider
        （失败只记录 warn，不得恢复旧登录态）
                |
                v
        reauthentication-required
                |
                v
        广播 signed-out / reauthentication-required
                |
                v
        UI 清理用户展示，显示普通聊天错误横幅
        （不弹重新登录提示、不打开 Welcome 登录页）
```

## 交互约束

- 认证过期不是用户主动退出，不显示“确认断开连接”或运行中会话二次确认。
- 清理认证事实发生在广播前；清理完成即生效，不等待 UI。
- Host 侧只清理凭据并广播 `signed-out` / `reauthentication-required`；renderer 不再弹「登录已过期，请重新登录」提示，也不打开 Welcome 登录页。需要重新连接 provider 时由用户在设置页主动操作，不触发 App relaunch。
- provider 启动门禁只能关闭自己打开的 `startup-provider-required`；不得以 `open=false` 覆盖 JWT 过期流程写入的 `session-expired`。
- 同一次启动恢复最多广播一次过期状态；UI 不维护第二份认证状态。
- Web 端清理过期 localStorage 后回到普通界面，不恢复伪登录态；relay v3 账号会话不受 OAuth / JWT 过期影响。

## 进程与多端边界

- Local Host OAuth service 是桌面本地 OAuth 凭据的权威 owner；renderer 只消费结构化恢复结果。
- Web 登录使用浏览器 localStorage，但复用相同的 JWT `exp` 判定语义。
- 远程 workspace 不创建独立认证状态；过期处理不修改 task/session、relay、stream、snapshot 或 owner 状态。
- 本次变更不改变 `desktop-continuous` 与 `web-remote-replayable` 消息链路。

## 验证要求

- 过期 JWT 不得恢复缓存用户，并清除 OAuth 会话凭据。
- 未过期 JWT 继续恢复缓存用户，且启动时不请求远端 userinfo。
- 无 `exp` 的历史/测试 token 保持兼容。
- 派生 provider 清理失败时仍返回 `reauthentication-required`。
- 过期恢复与新 OAuth callback 并发时，不得清除新登录或新切换 provider 的凭据。
- Web localStorage 中的过期 JWT 被清除且不恢复用户。
- UI 对 `reauthentication-required` 只清理展示态并显示普通错误横幅，不弹提示、不进入登录页。
