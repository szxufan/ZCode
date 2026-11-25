# Relay V3 自托管部署指南（P3）

状态：本文覆盖自部署一个 Relay V3 实例并启用「扫码即用」手机远控的完整配置面。镜像与 compose 已在 `relay-server/` 就绪（P0 交付）；staging/生产上线属运维操作，需在真实环境执行并回填验收记录。

## 1. 配置面（环境变量）

| 变量                       | 必填 | 说明                                                                                                                                                 |
| -------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_DB_PATH`            | ✅   | SQLite 数据库文件路径（缺失启动失败，fail-closed）。容器内挂 `/data` 卷                                                                              |
| `RELAY_JWT_SECRET`         | ✅   | access token HS256 密钥；泄露等于全部 access 可伪造，必须强随机并定期轮换                                                                            |
| `RELAY_PORT`               |      | HTTP 监听端口，默认 8080。TLS 由反向代理终结（compose 内置 Caddy 样例）                                                                              |
| `RELAY_STATIC_DIR`         |      | `/remote/v4` 手机页面静态产物目录。Docker 镜像已内置（`/static`，扫码即用）；裸 Node 部署需构建 web 并指向 `packages/web/dist`，未配置时桌面侧二维码入口提示不可用 |
| `RELAY_LOCAL_REGISTRATION` |      | `open`（默认，验证码登录即建号）/ `closed`（仅 `relay-admin add-user` 预建账号）                                                                     |
| `RELAY_SMS_PROVIDER`       |      | `aliyun`（默认，需下列凭据）/ `test`（非生产构建：验证码只进测试接缝不外发）/ `none`（验证码接口 503，密码登录仍可用）                               |
| `RELAY_TRUST_PROXY`        |      | Fastify `trustProxy` 值（`true` 或反代 CIDR，如 `172.16.0.0/12`）。反代后不设置会让所有请求共享反代 IP，按 IP 的验证码/登录/刷新限流退化为全局配额   |
| `RELAY_SMS_ALIYUN_*`       |      | Aliyun Dysmsapi 凭据：`ACCESS_KEY_ID` / `ACCESS_KEY_SECRET` / `SIGN_NAME` / `TEMPLATE_CODE`；可选 `ENDPOINT`（默认 `https://dysmsapi.aliyuncs.com`） |
| `RELAY_SMS_CODE_SECRET`    |      | 验证码 HMAC 密钥。启用 aliyun 时须与上述四项凭据同时提供，缺任一项验证码接口 503                                                                     |

## 2. 部署方式

三种方式等价，区别只在进程托管；TLS 一律由反向代理终结，relay 自身只监听明文 HTTP。

### 2.1 Docker Compose（推荐）

```bash
cd relay-server
cat > .env <<'EOF'
RELAY_JWT_SECRET=<openssl rand -hex 32>
RELAY_PUBLIC_HOST=relay.example.com
EOF
docker compose up -d
```

compose 拓扑：`relay`（node:24-slim，8080 明文 HTTP，仅 `expose`）+ `caddy`（443 TLS 终结，`caddy reverse-proxy --from $RELAY_PUBLIC_HOST --to relay:8080`）+ `/data` 卷。`.env` 可填 §1 全部变量，未填取默认值：

- `RELAY_PUBLIC_HOST` 仅 compose 使用（Caddy `--from`），不传给 relay；
- 手机页面静态产物已打进镜像（`ENV RELAY_STATIC_DIR=/static`），`.env` 无需配置；要外挂其他静态目录时自行覆盖；
- `RELAY_TRUST_PROXY` 默认 `true`（relay 不发布宿主端口，Caddy 是唯一入口）。

### 2.2 直接 docker run（不使用 Compose）

构建上下文必须是仓库根目录（Dockerfile 需要 pnpm workspace，以及 relay / web 两条依赖闭包上的 workspace 包：`packages/shared`、`packages/session-control`、`packages/model-option-map`、`packages/rpc`）：

```bash
# 仓库根目录
docker build -f relay-server/Dockerfile -t zcode-relay:latest .
docker volume create relay-data
```

配置面与 §1 相同，全部经环境变量注入；镜像内固定 `NODE_ENV=production`，因此 `RELAY_SMS_PROVIDER=test` 会启动失败。用 `--env-file` 集中管理，避免密钥进 shell history：

```ini
# relay.env —— 必填
RELAY_DB_PATH=/data/relay.db
RELAY_JWT_SECRET=<openssl rand -hex 32>

# 可选（按部署填写，不需要的行可删除）
RELAY_PORT=8080
RELAY_LOCAL_REGISTRATION=open
# 静态页已打进镜像（/static）；仅在外挂其他静态目录时才设置
# RELAY_STATIC_DIR=/srv/remote-v4
# 仅当反向代理是唯一入口时设置；直连部署删除
RELAY_TRUST_PROXY=true

# 短信：aliyun（默认）| none
RELAY_SMS_PROVIDER=aliyun
RELAY_SMS_ALIYUN_ACCESS_KEY_ID=
RELAY_SMS_ALIYUN_ACCESS_KEY_SECRET=
RELAY_SMS_ALIYUN_SIGN_NAME=
RELAY_SMS_ALIYUN_TEMPLATE_CODE=
RELAY_SMS_CODE_SECRET=<openssl rand -hex 32>
# RELAY_SMS_ALIYUN_ENDPOINT=https://dysmsapi.aliyuncs.com
```

```bash
docker run -d --name relay --restart unless-stopped \
  --env-file relay.env \
  -p 127.0.0.1:8080:8080 \
  -v relay-data:/data \
  zcode-relay:latest
```

- `RELAY_PORT` 与 `-p` 右端保持一致（容器内监听 `0.0.0.0:8080`）；`-p 127.0.0.1:...` 只绑回环，公网入口交给同机 Caddy/nginx：`caddy reverse-proxy --from relay.example.com --to 127.0.0.1:8080`。
- `RELAY_TRUST_PROXY` 只在反代是唯一入口时设置（`true` 或反代 CIDR）；直连部署不设，否则客户端可伪造 `X-Forwarded-For` 绕过按 IP 限流。
- 手机页面静态产物已打进镜像（`/static`），无需挂载；要外挂时再设 `RELAY_STATIC_DIR` 并加对应 `-v`。
- `RELAY_SMS_PROVIDER=aliyun` 时五项凭据（含 `RELAY_SMS_CODE_SECRET`）须齐全，缺任一项验证码接口 503（密码登录仍可用）；只做密码登录可显式设 `none`。
- `RELAY_LOCAL_REGISTRATION=closed` 时不能自助注册，需先用 `node relay-server/dist/relay-admin.js add-user` 预建账号。
- `RELAY_DB_PATH` 指向挂载卷内；备份 `relay-data` 卷即备份账号/设备目录（SQLite WAL）。
- `relay-admin` 没有 PATH shim（工作区不会为包自身链接 bin，镜像也只带 `dist`），统一跑构建产物：`docker exec -it relay node relay-server/dist/relay-admin.js list-users`（复用容器内 `RELAY_DB_PATH`）。

### 2.3 直接以 Node 进程运行（无容器）

要求 Node ≥ 24（`node:sqlite`）：

```bash
pnpm install
pnpm --filter @zcode/web build            # 手机页面静态产物 packages/web/dist
pnpm --filter @zcode/relay-server run build

export RELAY_DB_PATH=/var/lib/relay/relay.db
export RELAY_JWT_SECRET=$(openssl rand -hex 32)
export RELAY_STATIC_DIR=/opt/zcode/packages/web/dist
node relay-server/dist/server.js
```

用 systemd 托管的最小单元：

```ini
[Unit]
Description=ZCode Relay V3
After=network.target

[Service]
WorkingDirectory=/opt/zcode
EnvironmentFile=/etc/zcode/relay.env
ExecStart=/usr/bin/node relay-server/dist/server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

数据库目录需先创建并对运行用户可写；`relay-admin` 与主进程读同一份 `RELAY_DB_PATH`，可直接在同一环境变量下执行。

配置面同 §1，`EnvironmentFile` 可直接复用 §2.2 的 `relay.env` 格式，只把容器内路径换成宿主路径（如 `RELAY_DB_PATH=/var/lib/relay/relay.db`、`RELAY_STATIC_DIR=/srv/remote-v4`）；进程默认监听 `0.0.0.0`，同样只应通过本机反代对外。生产环境显式设 `NODE_ENV=production`（镜像已内置），否则 `RELAY_SMS_PROVIDER=test` 不会被拒绝。

## 3. 手机页面构建与托管

Docker 部署（compose / docker run）的静态页已打进镜像（`/static`），无需额外操作；仅当要把页面托管到别的目录/域名时才覆盖 `RELAY_STATIC_DIR`（§2.2）。

裸 Node 部署需要自行构建并指向产物：

```bash
pnpm --filter @zcode/web build          # 产物 packages/web/dist
RELAY_STATIC_DIR=/path/to/packages/web/dist node relay-server/dist/server.js
```

- 反向代理应直接缓存静态资源（relay 侧已带 `Cache-Control: public, max-age=300`）。
- 桌面端「设置 → 远程控制 → Relay 服务器地址」填 relay origin（如 `https://relay.example.com`，带协议头、不带路径），保存即生效；已登录时保存新地址会退出账号并停止远控，需重新登录（设计 §3.5）。二维码 base 即该 origin（`?sid&mid&name&app_version` 路由提示，§5.3）。
- 自定义 origin：`RELAY_STATIC_DIR` 部署在其他域名时，在 AppSettings.relayV3.staticPageBaseUrl 指向该域名。

## 4. relay-admin（账号与设备运维）

```bash
node relay-server/dist/relay-admin.js list-users
node relay-server/dist/relay-admin.js add-user --phone +8613800138000 --password-stdin
node relay-server/dist/relay-admin.js set-password --phone +8613800138000 --password-stdin
node relay-server/dist/relay-admin.js delete-user --phone +8613800138000     # 级联软删设备
node relay-server/dist/relay-admin.js list-devices --phone +8613800138000
```

`--db` 缺省取 `RELAY_DB_PATH`；`set-password` 会撤销该账号全部会话。需要先执行 §2.3 的构建。

closed-registration 部署的默认兜底：先 `add-user` 预建，用户首登用密码或验证码（`RELAY_SMS_PROVIDER=none` 时仅密码）。Docker 镜像内用 `docker exec -it relay node relay-server/dist/relay-admin.js <command>`。

## 5. headless 设备接入（R4）

服务器上：

```bash
ZCODE_RELAY_V3_ORIGIN=https://relay.example.com zcode server login --relay https://relay.example.com
# 终端显示 8 位输入码 + 公钥指纹 → 桌面端「设置 → 远程控制 → 批准无屏设备」输入码并核对指纹
```

daemon 侧 `serve` 读取 `ZCODE_RELAY_V3_ORIGIN` + server root 凭据自动以 device 角色上线；远程吊销 = 任一已认证设备在设备列表删除该设备（删除会撤销该设备授权取得的 refresh 家族；已签发的 access 最多再存活 10 分钟）。

## 6. 客户端切换与 V2 归档

- 客户端只连 V3：桌面（被控端/控制端）、手机 `/remote/v4`、headless daemon 一次性切换；V2 transport 与 OAuth 远控登录链路已随本 fork 移除。
- V2 文档归档为语义参考：`docs/web-remote-control/relay-v2-pairing.md`、`web-remote-login.md`（不再作为有效契约维护）。

## 7. 上线检查单

1. `RELAY_DB_PATH`/`RELAY_JWT_SECRET` 已设置且 secret 强随机；
2. TLS 入口唯一（Caddy/反代），8080 不直接暴露公网；
3. 静态页已就绪：Docker 部署已内置；裸 Node 部署已配置 `RELAY_STATIC_DIR`（或确认桌面二维码提示不可用是预期）；
4. Aliyun SMS 凭据可用或 closed-registration + `relay-admin` 预建账号；反代部署已设置 `RELAY_TRUST_PROXY` 且反代是唯一入口；
5. staging 完成一次：手机登录 → 扫码 → 密文会话 → 断线重连（replayable 恢复）；
6. 备份 `/data`（SQLite WAL）；secret 轮换预案（旧 access 10 分钟内自然过期）。
