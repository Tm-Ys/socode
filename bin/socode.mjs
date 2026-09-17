#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = join(root, "dist", "index.js");
const source = join(root, "src", "index.ts");
const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");

if (existsSync(compiled)) {
  await import(pathToFileURL(compiled).href);
} else if (existsSync(tsx) && existsSync(source)) {
  const child = spawn(process.execPath, [tsx, source, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} else {
  console.error("socode: 找不到 dist/index.js。请先在仓库里运行 npm install && npm run build。");
  process.exit(1);
}
