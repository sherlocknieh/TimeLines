import { fileURLToPath } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // 与 blume.config.ts 的 deployment.base 保持一致：站点发布在仓库 Pages 项目路径下
  base: "/TimeLines/",
  plugins: [vue()],
  build: {
    // 输出到 _build/，最终由 .dev/build.mjs 合入站点产物 _dist/
    outDir: fileURLToPath(new URL("../_build", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
