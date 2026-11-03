# syntax=docker/dockerfile:1
# Relay V3 自托管镜像（docs/relay-server/relay-v3-design.md §8）。
# 多阶段构建：deps → build → runtime 仅携带 dist 产物与生产依赖。

FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY relay-server/package.json ./relay-server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/model-option-map/package.json ./packages/model-option-map/package.json
RUN pnpm install --frozen-lockfile --filter @zcode/relay-server... --ignore-scripts

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY relay-server ./relay-server
RUN pnpm --filter @zcode/relay-server run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app ./
COPY --from=build /app/relay-server/dist ./relay-server/dist
# 仅暴露 TLS 终结由反向代理承担（Caddy 样例见 README）；容器内为明文 HTTP。
EXPOSE 8080
CMD ["node", "relay-server/dist/index.js"]
