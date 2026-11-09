import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "_dist");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

if (!existsSync(distDir)) {
  console.error("未找到 _dist/，请先运行 pnpm build。");
  process.exit(1);
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const port = Number(argValue("port", 4321));
const host = argValue("host", "localhost");

// _dist/ 是部署到 /timeline/ 的内容，预览时按同样的子路径提供
const BASE_PATH = "/timeline";

/** 解析 /timeline/ 下的请求路径：目录取 index.html，禁止越出 _dist/ */
function resolveFile(pathname) {
  if (pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) return null;

  let relative = decodeURIComponent(pathname.slice(BASE_PATH.length)).replace(/^\/+/, "");
  let target = normalize(join(distDir, relative));

  if (target !== distDir && !target.startsWith(`${distDir}${sep}`)) return null;
  if (existsSync(target) && statSync(target).isDirectory()) {
    target = join(target, "index.html");
  } else if (!existsSync(target) && existsSync(`${target}/index.html`)) {
    target = join(target, "index.html");
  }
  return existsSync(target) && statSync(target).isFile() ? target : null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const file = resolveFile(url.pathname);

  if (!file) {
    const fallback = join(distDir, "404.html");
    const status = 404;
    if (existsSync(fallback)) {
      res.writeHead(status, { "Content-Type": MIME_TYPES[".html"] });
      createReadStream(fallback).pipe(res);
      return;
    }
    res.writeHead(status, { "Content-Type": MIME_TYPES[".txt"] });
    res.end("404 Not Found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(file)] ?? "application/octet-stream",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.listen(port, host === "true" ? undefined : host, () => {
  console.log(`预览地址：http://${host === "true" ? "localhost" : host}:${port}${BASE_PATH}/`);
});
