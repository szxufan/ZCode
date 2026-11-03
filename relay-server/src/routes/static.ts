import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

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
  app.get("/*", async (request, reply) => {
    const requestPath = (request.params as { "*": string })["*"] ?? "";
    // 防路径穿越：归一化后必须仍在根目录内。
    const resolved = normalize(join(staticDir, requestPath));
    if (!resolved.startsWith(normalize(staticDir))) {
      return reply.status(404).send("not found");
    }
    let filePath = resolved;
    try {
      const info = await stat(resolved);
      if (info.isDirectory()) filePath = join(resolved, "index.html");
    } catch {
      filePath = join(staticDir, "index.html");
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
