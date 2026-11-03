import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /remote/v4 手机页面（P2）：产物目录交给 relay RELAY_STATIC_DIR 托管（§5.4）。
// base 为相对路径，静态资源经 relay 静态路由按目录分发。
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
  },
});
