# ZCode JWT 失效与凭据清理

当 Host 通过统一 `NodeApiClient` 检测到 ZCode JWT 请求返回 401 时，复用 OAuth logout 清理本地凭据与派生 provider，并通过 Broadcast 通知 Renderer。桌面应用登录已改为 relay v3 账号（见 [relay-login.md](../ui/relay-login.md)），renderer 不再提示“登录已过期”、不写 restart marker、不执行 `RelaunchApp`，也不以 `session-expired` 原因进入登录页；用户只看到普通聊天错误横幅，需要重新连接 provider 时在设置页主动操作。

```text
401 + 当前 ZCode JWT
        ↓
Host logout 清理凭据与派生 provider
        ↓
auth:zcode-jwt-invalid 广播
        ↓
Renderer 清理展示态并显示普通聊天错误横幅
        ↓
（不弹重新登录提示、不重启、不进入登录页）
```

当前平台 userinfo/customerInfo、企业定价、团队订阅详情请求携带当前业务 access_token 并返回 HTTP 401 或 HTTP 200 + JSON 数值 `code: 401` 时，也复用上述流程；具体范围见 [401 自动退出](jwt-401-auto-logout.md)。空响应、其它业务错误、普通 API Key、支付/API key 管理请求不纳入新增判断。Web 端同样没有重新登录弹窗或 `location.reload()`；JWT 过期只清理浏览器中的 OAuth / localStorage 凭据，不影响 relay v3 账号会话。
