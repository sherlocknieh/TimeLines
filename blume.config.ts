//  文档配置

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "blume";

type MiddlewareServer = {
  middlewares: {
    use: (
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
        next: () => void
      ) => void
    ) => void;
  };
};

const root = fileURLToPath(new URL(".", import.meta.url));
const appDir = join(root, "_build");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * 把 /timeline 映射到 _build/ 下的文件，拒绝目录穿越。
 * Vite 在插件中间件之前已剥掉 deployment.base，这里同时兼容带前缀与已剥前缀的路径。
 */
function resolveAppFile(url: string): string | null {
  const path = decodeURIComponent((url.split("?")[0] ?? "").replace(/\/+$/, ""));
  const relativePath = path === "/timeline" || path.startsWith("/timeline/")
    ? path.slice("/timeline".length)
    : path;
  const file = relativePath === "" || relativePath.endsWith("/")
    ? `${relativePath}index.html`
    : relativePath;
  const target = normalize(join(appDir, file));

  if (target !== appDir && !target.startsWith(`${appDir}${sep}`)) return null;
  return target;
}

// 开发时由 Vite 构建监听写入 _build/，这里把该目录挂在 /timeline/ 下，
// 生产构建则由 .dev/build.mjs 复制到 _dist/ 根目录。
const timelineApp = {
  name: "timeline-app",
  hooks: {
    "astro:config:setup": ({
      updateConfig,
    }: {
      updateConfig: (config: {
        trailingSlash?: string;
        vite: { plugins: unknown[] };
      }) => void;
    }) => {
      updateConfig({
        // 允许 /timeline/ 带斜杠的目录地址通过开发服务器的尾部斜杠校验
        trailingSlash: "ignore",
        vite: {
          plugins: [
            {
              name: "timeline-app",
              enforce: "pre",
              configureServer(server: MiddlewareServer) {
                server.middlewares.use((req, res, next) => {
                  if (req.method !== "GET" && req.method !== "HEAD") {
                    next();
                    return;
                  }

                  const target = resolveAppFile(req.url ?? "");
                  if (!target || !existsSync(target) || !statSync(target).isFile()) {
                    next();
                    return;
                  }

                  res.setHeader(
                    "Content-Type",
                    MIME_TYPES[extname(target)] ?? "application/octet-stream"
                  );
                  if (req.method === "HEAD") {
                    res.end();
                    return;
                  }
                  createReadStream(target).pipe(res);
                });
              },
            },
          ],
        },
      });
    },
  },
};

export default defineConfig({
  title: "TimeLines",
  description: "英国 × 美国历史时间线：文档与前端混合项目",
  // 整站发布在个人主页的 /timeline/ 下：应用占 /timeline，文档占 /timeline/docs。
  deployment: { base: "/timeline" },
  basePath: "/docs",
  // 不加载任何自托管字体，样式回落到系统字体栈，构建也不访问 Google Fonts。
  theme: { fonts: false },
  integrations: [timelineApp],
});
