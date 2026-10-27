import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const removeAll = args.includes("--all");
const force = args.includes("--force");

const targets = ["_build", "_dist", "dist", ".blume"];
if (removeAll) targets.push("node_modules");

// 开发服务器运行时会持续写入 .blume，删掉会破坏正在运行的实例
const lockFile = join(root, ".blume", "dev.lock");
if (existsSync(lockFile) && !force) {
  let port = "";
  try {
    port = ` (${JSON.parse(readFileSync(lockFile, "utf-8")).port ?? "?"})`;
  } catch {
    // 锁文件损坏时忽略端口信息
  }
  console.error(
    `检测到正在运行的 blume dev${port}：请先停止它，或使用 pnpm clean --force 强制清理。`
  );
  process.exit(1);
}

const removed = [];
for (const target of targets) {
  const path = join(root, target);
  if (!existsSync(path)) continue;
  rmSync(path, { recursive: true, force: true });
  removed.push(target);
}

if (removed.length === 0) {
  console.log("没有需要清理的文件。");
} else {
  console.log(`已清理：${removed.join("、")}`);
}
