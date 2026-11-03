# Relay V3 自托管部署指南（P3）

状态：本文覆盖自部署一个 Relay V3 实例并启用「扫码即用」手机远控的完整配置面。镜像与 compose 已在 `relay-server/` 就绪（P0 交付）；staging/生产上线属运维操作，需在真实环境执行并回填验收记录。

## 1. 配置面（环境变量）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `RELAY_DB_PATH` | ✅ | SQLite 数据库文件路径（缺失启动失败，fail-closed）。容器内挂 `/data` 卷 |
| `RELAY_JWT_SECRET` | ✅ | access token HS256 密钥；泄露等于全部 access 可伪造，必须强随机并定期轮换 |
| `RELAY_PORT` |  | HTTP 监听端口，默认 8080。TLS 由反向代理终结（compose 内置 Caddy 样例） |
| `RELAY_STATIC_DIR` |  | `/remote/v4` 手机页面静态产物目录（`pnpm --filter @zcode/web build` 的 `packages/web/dist`）。配置后「扫码即用」；未配置时桌面侧二维码入口提示不可用 |
| `RELAY_LOCAL_REGISTRATION` |  | `open`（默认，验证码登录即建号）/ `closed`（仅 `relay-admin add-user` 预建账号） |
| `RELAY_SMS_PROVIDER` |  | `aliyun`（默认，需下列凭据）/ `test`（非生产构建：验证码只进测试接缝不外发）/ `none`（验证码接口 503，密码登录仍可用） |
| `RELAY_SMS_ALIYUN_*` |  | Aliyun Dysmsapi 凭据（AccessKey/Secret/SignName/TemplateCode） |

## 2. Docker Compose（推荐）

```bash
cd relay-server
cat > .env <<'EOF'
RELAY_JWT_SECRET=<openssl rand -hex 32>
RELAY_PUBLIC_HOST=relay.example.com
EOF
docker compose up -d
```

compose 拓扑：`relay`（node:24-slim，8080 明文 HTTP）+ `caddy`（443 TLS 终结，`caddy reverse-proxy --from $RELAY_PUBLIC_HOST --to relay:8080`）+ `/data` 卷。手机页面静态产物打进 relay 镜像或挂载到 `RELAY_STATIC_DIR`。

## 3. 手机页面构建与托管

```bash
pnpm --filter @zcode/web build          # 产物 packages/web/dist
RELAY_STATIC_DIR=/path/to/dist relay 起服务
```

- 反向代理应直接缓存静态资源（relay 侧已带 `Cache-Control: public, max-age=300`）。
- 桌面端 AppSettings「远程控制」填 relay origin；二维码 base 即该 origin（`?sid&mid&name&app_version` 路由提示，§5.3）。
- 自定义 origin：`RELAY_STATIC_DIR` 部署在其他域名时，在 AppSettings.relayV3.staticPageBaseUrl 指向该域名。

## 4. relay-admin（账号与设备运维）

```bash
relay-admin list-users
relay-admin add-user --phone +8613800138000 --password-stdin
relay-admin set-password --phone +8613800138000 --password-stdin
relay-admin delete-user --phone +8613800138000     # 级联软删设备
relay-admin list-devices --phone +8613800138000
```

closed-registration 部署的默认兜底：先 `add-user` 预建，用户首登用密码或验证码（`RELAY_SMS_PROVIDER=none` 时仅密码）。

## 5. headless 设备接入（R4）

服务器上：

```bash
ZCODE_RELAY_V3_ORIGIN=https://relay.example.com zcode server login --relay https://relay.example.com
# 终端显示 8 位输入码 + 公钥指纹 → 桌面端「设置 → 远程控制 → 批准无屏设备」输入码并核对指纹
```

daemon 侧 `serve` 读取 `ZCODE_RELAY_V3_ORIGIN` + server root 凭据自动以 device 角色上线；远程吊销 = 任一已认证设备在设备列表删除该设备（refresh 家族即时撤销）。

## 6. 客户端切换与 V2 归档

- 客户端只连 V3：桌面（被控端/控制端）、手机 `/remote/v4`、headless daemon 一次性切换；V2 transport 与 OAuth 远控登录链路已随本 fork 移除。
- V2 文档归档为语义参考：`docs/web-remote-control/relay-v2-pairing.md`、`web-remote-login.md`（不再作为有效契约维护）。

## 7. 上线检查单

1. `RELAY_DB_PATH`/`RELAY_JWT_SECRET` 已设置且 secret 强随机；
2. TLS 入口唯一（Caddy/反代），8080 不直接暴露公网；
3. `RELAY_STATIC_DIR` 已配置（或确认桌面二维码提示不可用是预期）；
4. Aliyun SMS 凭据可用或 closed-registration + `relay-admin` 预建账号；
5. staging 完成一次：手机登录 → 扫码 → 密文会话 → 断线重连（replayable 恢复）；
6. 备份 `/data`（SQLite WAL）；secret 轮换预案（旧 access 10 分钟内自然过期）。
