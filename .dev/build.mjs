import { spawnSync } from "node:child_process";
import { cpSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "web");
const node = process.execPath;
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const blumeBin = join(root, "node_modules", "blume", "bin", "blume.mjs");
const distDir = join(root, "_dist");

const web = spawnSync(node, [viteBin, "build"], {
  cwd: webDir,
  stdio: "inherit",
});
if (web.status !== 0) process.exit(web.status ?? 1);

const docs = spawnSync(node, [blumeBin, "build"], {
  cwd: root,
  stdio: "inherit",
});
if (docs.status !== 0) process.exit(docs.status ?? 1);

// Blume 固定输出到 <root>/dist，这里改名成 _dist，让产物目录统一以下划线开头
rmSync(distDir, { recursive: true, force: true });
renameSync(join(root, "dist"), distDir);

cpSync(join(root, "_build"), join(distDir, "timeline"), { recursive: true });
console.log("构建产物：_dist/（前端页面位于 _dist/timeline/）");
