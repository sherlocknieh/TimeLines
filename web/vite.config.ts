import { fileURLToPath } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // 与 Blume 的 public/timeline 挂载路径保持一致
  base: "/timeline/",
  plugins: [vue()],
  build: {
    // 输出到 _build/，最终由 .dev/build.mjs 合入站点产物 _dist/
    outDir: fileURLToPath(new URL("../_build", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
