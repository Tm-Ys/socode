#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = join(root, "dist", "stdio-worker.js");
if (!existsSync(compiled)) {
  process.stderr.write("socode-runtime: 找不到 dist/stdio-worker.js。包不完整。\n");
  process.exit(1);
}

const BOOLEAN_FLAGS = new Set(["stdio", "no-stream", "no-agent", "resume", "new"]);
const flags = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!arg.startsWith("--")) continue;
  const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
  const next = args[i + 1];
  const asBoolean =
    BOOLEAN_FLAGS.has(rawKey) &&
    inlineValue === undefined &&
    (!next || next.startsWith("--"));
  flags[rawKey] = asBoolean ? "true" : (inlineValue ?? args[++i] ?? "");
}

if (flags.stdio !== "true" || !flags.workspace) {
  process.stderr.write("用法: worker-entry --stdio --workspace /abs/path\n");
  process.exit(2);
}

process.stderr.write("socode-runtime: starting\n");

async function main() {
  const { runWorkerStdio } = await import(pathToFileURL(compiled).href);
  await runWorkerStdio({ workspace: flags.workspace, flags });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`socode-runtime: ${message}\n`);
  process.exit(1);
});
