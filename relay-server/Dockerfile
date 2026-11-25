# syntax=docker/dockerfile:1
# Relay V3 自托管镜像（docs/relay-server/relay-v3-design.md §8）。
# 多阶段构建：relay 与 web 静态页各自独立安装/构建，runtime 仅携带
# relay 运行依赖、relay dist 产物与 web 静态产物（/static），
# 不携带 web 的构建依赖。

FROM node:24-slim AS deps-relay
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY patches ./patches
COPY relay-server/package.json ./relay-server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
# 根 package.json 的 workspace 链接也参与 frozen-lockfile 校验。
COPY packages/zcode-cua/package.json ./packages/zcode-cua/package.json
# shared 的 workspace 依赖也需 package.json 才能在 pnpm 解析依赖图时被识别。
COPY packages/session-control/package.json ./packages/session-control/package.json
COPY packages/model-option-map/package.json ./packages/model-option-map/package.json
RUN pnpm install --frozen-lockfile --filter @zcode/relay-server... --ignore-scripts

FROM deps-relay AS build-relay
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY relay-server ./relay-server
RUN pnpm --filter @zcode/relay-server run build

FROM node:24-slim AS deps-web
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY patches ./patches
COPY packages/web/package.json ./packages/web/package.json
COPY packages/rpc/package.json ./packages/rpc/package.json
COPY packages/shared/package.json ./packages/shared/package.json
# 根 package.json 的 workspace 链接也参与 frozen-lockfile 校验。
COPY packages/zcode-cua/package.json ./packages/zcode-cua/package.json
COPY packages/model-option-map/package.json ./packages/model-option-map/package.json
COPY packages/session-control/package.json ./packages/session-control/package.json
RUN pnpm install --frozen-lockfile --filter @zcode/web... --ignore-scripts

FROM deps-web AS build-web
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/rpc ./packages/rpc
COPY packages/web ./packages/web
RUN pnpm --filter @zcode/web build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 手机页面静态产物打进镜像；仅在外挂其他静态目录时才需要覆盖 RELAY_STATIC_DIR。
ENV RELAY_STATIC_DIR=/static
COPY --from=deps-relay /app ./
COPY --from=build-relay /app/relay-server/dist ./relay-server/dist
COPY --from=build-web /app/packages/web/dist ./static
# 仅暴露 TLS 终结由反向代理承担（Caddy 样例见 README）；容器内为明文 HTTP。
EXPOSE 8080
CMD ["node", "relay-server/dist/server.js"]