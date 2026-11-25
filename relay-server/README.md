# Relay V3 自托管中继

ZCode 手机远控 / 桌面互控的自托管 relay（设计 spec：[docs/relay-server/relay-v3-design.md](../docs/relay-server/relay-v3-design.md)）。
V3 为全新协议，不兼容闭源 Relay V2；端到端加密全部位于客户端（`@zcode/shared/remote-relay-v3`），
本服务只见密文。

- 技术栈：Fastify + ws + `node:sqlite`（WAL），Node ≥ 24。
- 构建：tsup 打包为 `dist/server.js` 与 `dist/relay-admin.js`，`@zcode/shared` 内联进产物，运行时不依赖 workspace 源码。
- 职责：账号/短信、JWT、refresh 家族旋转、设备目录（含公钥）、设备授权（headless）、
  配对 owner 调度、密文透传、限流。不保存 task/workspace/stream 等业务状态。
- 在线态、配对 owner、一次性 token 为进程内存事实：重启后设备离线，客户端按既有退避重连。

## 运行

```bash
# 必填（fail closed，缺失即启动失败）
export RELAY_DB_PATH=/var/lib/relay/relay.db
export RELAY_JWT_SECRET=$(openssl rand -hex 32)

# 可选
export RELAY_PORT=8080                    # 默认 8080
export RELAY_LOCAL_REGISTRATION=open      # open | closed（closed 时仅 relay-admin 预建账号可登录）
export RELAY_STATIC_DIR=/srv/remote-v4    # /remote 手机页静态产物目录（pnpm --filter @zcode/web build 的产物），配置后扫码即用
export RELAY_SMS_PROVIDER=aliyun          # aliyun | test（生产禁用 test）| none

# Aliyun Dysmsapi（未配置时验证码接口 503，密码登录仍可用）
export RELAY_SMS_ALIYUN_ACCESS_KEY_ID=...
export RELAY_SMS_ALIYUN_ACCESS_KEY_SECRET=...
export RELAY_SMS_ALIYUN_SIGN_NAME=...
export RELAY_SMS_ALIYUN_TEMPLATE_CODE=...
export RELAY_SMS_CODE_SECRET=$(openssl rand -hex 32)

pnpm --filter @zcode/web build             # 手机页面静态产物（配合 RELAY_STATIC_DIR）
pnpm --filter @zcode/relay-server run build
node relay-server/dist/server.js
```

## relay-admin CLI

```bash
node relay-server/dist/relay-admin.js list-users [--db <path>]
node relay-server/dist/relay-admin.js add-user --phone +8613800138000 [--password-stdin]
node relay-server/dist/relay-admin.js delete-user --phone +8613800138000
node relay-server/dist/relay-admin.js set-password --phone +8613800138000 --password-stdin
node relay-server/dist/relay-admin.js list-devices --phone +8613800138000
```

需先执行上方 build；`--db` 缺省取 `RELAY_DB_PATH`。`set-password` 会撤销该账号全部会话。

## Docker 部署

`docker-compose.yml` 含 relay + Caddy 反代（TLS 终结）。手机页面静态产物已打进镜像
（`/static`），短信凭据与注册开关经 `.env` 注入：

```bash
cd relay-server
echo 'RELAY_PUBLIC_HOST=relay.example.com' >> .env
echo 'RELAY_JWT_SECRET=...' >> .env
docker compose up -d
```

生产部署要求仅暴露 TLS 入口；反向代理可直接缓存 `RELAY_STATIC_DIR` 静态资源。
不使用 compose 的 `docker build` / `docker run` 与裸 Node 进程方式见
[docs/relay-server/deployment.md §2](../docs/relay-server/deployment.md)。

## 测试

一致性矩阵（`@zcode/shared/testing/relay-v3-consistency`）同一套用例分别回放
fake fixture 与本实现；矩阵外另有限流、refresh 家族、fail-closed、admin、设备授权测试：

```bash
npx vitest run --project unit relay-server/test/
```
