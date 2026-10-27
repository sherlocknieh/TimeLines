import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "web");
const node = process.execPath;
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const blumeBin = join(root, "node_modules", "blume", "bin", "blume.mjs");

const args = process.argv.slice(2);
const docsOnly = args.includes("--docs-only");
const blumeArgs = args.filter((arg) => arg !== "--docs-only");

// 先完成一次前端构建，保证 Blume 启动时 _build/ 已经就绪
const initial = spawnSync(node, [viteBin, "build"], {
  cwd: webDir,
  stdio: "inherit",
});
if (initial.status !== 0) {
  process.exit(initial.status ?? 1);
}

const children = [];

if (!docsOnly) {
  children.push(
    spawn(node, [viteBin, "build", "--watch"], {
      cwd: webDir,
      stdio: "inherit",
    }),
  );
}

children.push(
  spawn(node, [blumeBin, "dev", ...blumeArgs], {
    cwd: root,
    stdio: "inherit",
  }),
);

let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 0);
  });
}
