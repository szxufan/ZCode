import { defineConfig } from "tsup";

// @zcode/shared 的 exports 指向 TS 源码，且内部相对导入带 .js 后缀，
// tsc 产物直接用 node 运行会 ERR_MODULE_NOT_FOUND。把 shared 一并打进产物，
// 运行时只依赖 relay-server 自己的 dependencies（fastify/ws）。
export default defineConfig({
  entry: {
    // 入口名与 tsc 的 dist/index.js 区分，避免 typecheck 与 build 互相覆盖。
    server: "src/index.ts",
    "relay-admin": "src/admin/cli.ts",
  },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node24",
  sourcemap: true,
  splitting: false,
  // node:sqlite 只有带前缀的内置入口；去掉 node: 会错误解析到第三方包。
  removeNodeProtocol: false,
  noExternal: ["@zcode/shared"],
});
