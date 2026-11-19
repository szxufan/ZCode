import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import type { FastifyInstance } from "fastify";

// §5.4 静态资源：RELAY_STATIC_DIR 指向 /remote/v4 手机页面静态产物目录，
// 自部署实例"扫码即用"。生产部署建议由反向代理直接缓存静态资源。

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

export function registerStaticRoutes(app: FastifyInstance, staticDir: string): void {
  const root = resolve(staticDir);
  app.get("/*", async (request, reply) => {
    const requestPath = (request.params as { "*": string })["*"] ?? "";
    // 防路径穿越：解析后必须仍在根目录内。用 relative 判断，避免 startsWith 被
    // 同前缀兄弟目录（如 dist-backup）绕过。
    const resolved = resolve(root, requestPath);
    const rel = relative(root, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return reply.status(404).send("not found");
    }
    let filePath = resolved;
    try {
      const info = await stat(resolved);
      if (info.isDirectory()) filePath = join(resolved, "index.html");
    } catch (error) {
      // 只有"不存在"才回退到 SPA 入口；权限等真实错误继续按 404 处理，不掩盖故障。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return reply.status(404).send("not found");
      }
      filePath = join(root, "index.html");
    }
    try {
      const content = await readFile(filePath);
      reply.header("Content-Type", CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream");
      reply.header("Cache-Control", "public, max-age=300");
      return reply.send(content);
    } catch {
      return reply.status(404).send("not found");
    }
  });
}
