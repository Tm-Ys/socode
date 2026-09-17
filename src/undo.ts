import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type FileBackup = {
  path: string;
  existed: boolean;
  bytes: Buffer | null;
};

const backups = new Map<string, FileBackup>();
let nextWriteStartsTurn = false;

export function beginUndoTurn() {
  nextWriteStartsTurn = true;
}

export function pendingUndo(): { path: string; existed: boolean }[] {
  return [...backups.values()].map((item) => ({ path: item.path, existed: item.existed }));
}

export async function snapshotForUndo(path: string) {
  if (nextWriteStartsTurn) {
    backups.clear();
    nextWriteStartsTurn = false;
  }
  if (backups.has(path)) return;
  try {
    const bytes = await readFile(path);
    backups.set(path, { path, existed: true, bytes });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code === "ENOENT") {
      backups.set(path, { path, existed: false, bytes: null });
      return;
    }
    backups.set(path, { path, existed: true, bytes: null });
  }
}

export async function undoLastTurn(): Promise<string> {
  if (backups.size === 0) return "没有可撤销的改动。最近一轮 socode 没有写、改或删过文件。";
  const restored: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const item of [...backups.values()].reverse()) {
    try {
      if (!item.existed) {
        await unlink(item.path);
        removed.push(item.path);
        continue;
      }
      if (!item.bytes) {
        skipped.push(item.path);
        continue;
      }
      await mkdir(dirname(item.path), { recursive: true });
      await writeFile(item.path, item.bytes);
      restored.push(item.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push(`${item.path}（${message}）`);
    }
  }
  backups.clear();
  nextWriteStartsTurn = false;
  const lines = [
    "已撤回本轮 socode 的 write/edit/delete（不管 bash，不是对话 rewind，未碰本轮没改过的文件）：",
  ];
  if (restored.length) lines.push(...restored.map((path) => `  恢复  ${path}`));
  if (removed.length) lines.push(...removed.map((path) => `  删除  ${path}`));
  if (skipped.length) lines.push(...skipped.map((path) => `  跳过  ${path}`));
  return lines.join("\n");
}

export function resetUndoForTests() {
  backups.clear();
  nextWriteStartsTurn = false;
}
