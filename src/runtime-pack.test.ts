import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { payloadHasSecrets, SOCODE_REMOTE_PROTOCOL } from "./remote-protocol.js";
import {
  extractRuntime,
  isForbiddenRel,
  nodeWorkerEnv,
  packRuntime,
  runtimeListingProblem,
} from "./runtime-pack.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("runtime listing guards", () => {
  it("rejects providers, env files, tests, and source trees", () => {
    assert.equal(isForbiddenRel("providers.json"), true);
    assert.equal(isForbiddenRel("dist/.env"), true);
    assert.equal(isForbiddenRel("dist/stdio-worker.test.js"), true);
    assert.equal(isForbiddenRel("src/index.js"), true);
    assert.equal(isForbiddenRel("dist/stdio-worker.js"), false);
    assert.equal(runtimeListingProblem(["dist/index.js", "skills/x/SKILL.md"]), null);
    assert.equal(runtimeListingProblem(["dist/index.js", "providers.json"]), "providers.json");
  });
});

describe("worker-entry", () => {
  it("does not use top-level await", () => {
    const src = readFileSync(join(repoRoot, "bin", "worker-entry.mjs"), "utf8");
    assert.match(src, /async function main/);
    assert.match(src, /main\(\)\.catch/);
    assert.doesNotMatch(src, /^await /m);
    assert.doesNotMatch(src, /^try \{\s*$/m);
  });
});

describe("nodeWorkerEnv", () => {
  it("strips test-runner IPC fds so spawned node workers keep stdio", () => {
    const env = nodeWorkerEnv({
      NODE_CHANNEL_FD: "3",
      NODE_UNIQUE_ID: "1",
      NODE_OPTIONS: "--import tsx",
      HOME: "/tmp/x",
    });
    assert.equal(env.NODE_CHANNEL_FD, undefined);
    assert.equal(env.NODE_UNIQUE_ID, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.HOME, "/tmp/x");
  });
});

describe("packRuntime", () => {
  it("packs dist+skills and keeps secrets and tests out of the tarball", () => {
    const root = mkdtempSync(join(tmpdir(), "socode-pack-src-"));
    const outDir = mkdtempSync(join(tmpdir(), "socode-pack-out-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "socode", version: "0.1.2-test", type: "module" }),
      );
      mkdirSync(join(root, "dist"), { recursive: true });
      mkdirSync(join(root, "skills", "demo"), { recursive: true });
      mkdirSync(join(root, "bin"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "dist", "index.js"), "export const ok = 1;\n");
      writeFileSync(join(root, "dist", "stdio-worker.js"), "export function runWorkerStdio() {}\n");
      writeFileSync(join(root, "dist", "leaky.test.js"), 'export const api = "sk-should-not-pack";\n');
      writeFileSync(join(root, "skills", "demo", "SKILL.md"), "# demo\n");
      writeFileSync(join(root, "bin", "worker-entry.mjs"), "console.log('entry');\n");
      writeFileSync(join(root, "providers.json"), JSON.stringify({ api: "sk-local" }));
      writeFileSync(join(root, ".env"), "api_key=sk-env\n");
      writeFileSync(join(root, "src", "index.ts"), "export {}\n");

      const packed = packRuntime({ projectRoot: root, outDir, reuseCached: false });
      assert.match(packed.stamp, /^0\.1\.2-test\+[0-9a-f]{7}$/);
      assert.equal(runtimeListingProblem(packed.files), null);
      assert.equal(
        packed.files.some((file) => file.replace(/\/$/, "") === "bin/worker-entry.mjs"),
        true,
      );
      assert.equal(
        packed.files.some((file) => file.replace(/\/$/, "") === "runtime-stamp.json"),
        true,
      );
      assert.equal(
        packed.files.some((file) => /providers\.json|\.env|\.test\.|\/src\//.test(file)),
        false,
      );

      const extractDir = mkdtempSync(join(tmpdir(), "socode-pack-x-"));
      try {
        extractRuntime(packed.tarPath, extractDir);
        const stamp = JSON.parse(readFileSync(join(extractDir, "runtime-stamp.json"), "utf8")) as {
          stamp: string;
        };
        assert.equal(stamp.stamp, packed.stamp);
        const pkg = JSON.parse(readFileSync(join(extractDir, "package.json"), "utf8")) as {
          name: string;
          version: string;
        };
        assert.equal(pkg.name, "socode-runtime");
        assert.equal(payloadHasSecrets(pkg), null);
      } finally {
        rmSync(extractDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("changes stamp when dist contents change", () => {
    const root = mkdtempSync(join(tmpdir(), "socode-pack-src-"));
    const outDir = mkdtempSync(join(tmpdir(), "socode-pack-out-"));
    try {
      writeMinimalRuntime(root, "one");
      const first = packRuntime({ projectRoot: root, outDir, reuseCached: false });
      writeFileSync(join(root, "dist", "index.js"), "export const ok = 2;\n");
      const second = packRuntime({ projectRoot: root, outDir, reuseCached: false });
      assert.notEqual(first.stamp, second.stamp);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("packed worker-entry speaks socode-remote/1", async () => {
    const tsc = spawnSync(
      process.execPath,
      [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (tsc.status !== 0) {
      throw new Error(tsc.stderr || tsc.stdout || "tsc failed");
    }

    const outDir = mkdtempSync(join(tmpdir(), "socode-pack-out-"));
    const extractDir = mkdtempSync(join(tmpdir(), "socode-pack-x-"));
    const workspace = mkdtempSync(join(tmpdir(), "socode-pack-ws-"));
    const home = mkdtempSync(join(tmpdir(), "socode-pack-home-"));
    const packed = packRuntime({ projectRoot: repoRoot, outDir, reuseCached: false });
    extractRuntime(packed.tarPath, extractDir);
    const entry = join(extractDir, "bin", "worker-entry.mjs");
    const workerJs = join(extractDir, "dist", "stdio-worker.js");
    if (!existsSync(entry) || !existsSync(workerJs)) {
      throw new Error(`packed runtime missing entry (${existsSync(entry)}) or stdio-worker (${existsSync(workerJs)})`);
    }
    const child = spawn(process.execPath, [entry, "--stdio", "--workspace", workspace], {
      cwd: extractDir,
      env: nodeWorkerEnv({ HOME: home, SOCODE_HOME: home }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    const stdout: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stdout?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocol: SOCODE_REMOTE_PROTOCOL, clientVersion: "test" },
      })}\n`,
    );
    try {
      const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `packed worker handshake timeout\nstdout=${stdout.join("")}\nstderr=${stderr.join("")}\nexit=${child.exitCode}`,
            ),
          );
        }, 15000);
        const fail = (error: Error) => {
          clearTimeout(timer);
          reject(error);
        };
        child.once("exit", (code, signal) => {
          fail(
            new Error(
              `packed worker exited code=${code} signal=${signal}\nstdout=${stdout.join("")}\nstderr=${stderr.join("")}`,
            ),
          );
        });
        const onData = () => {
          const line = stdout.join("").split("\n").find((item) => item.trim().startsWith("{"));
          if (!line) return;
          try {
            const parsed = JSON.parse(line) as { result?: Record<string, unknown>; error?: { message?: string } };
            if (parsed.error) {
              fail(new Error(parsed.error.message || "rpc error"));
              return;
            }
            if (parsed.result) {
              clearTimeout(timer);
              resolve(parsed.result);
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        };
        child.stdout?.on("data", onData);
      });
      assert.equal(hello.protocol, SOCODE_REMOTE_PROTOCOL);
      assert.equal(hello.runtimeStamp, packed.stamp);
      assert.equal(hello.workspace, workspace);
      assert.equal(payloadHasSecrets(hello), null);
      const errText = stderr.join("");
      assert.match(errText, /socode-runtime: starting/);
      assert.equal(errText.includes("unsettled top-level await"), false);
      child.stdin?.end();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      rmSync(outDir, { recursive: true, force: true });
      rmSync(extractDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function writeMinimalRuntime(root: string, body: string) {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "socode", version: "0.1.2-test", type: "module" }),
  );
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "skills", "demo"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), `export const ok = "${body}";\n`);
  writeFileSync(join(root, "skills", "demo", "SKILL.md"), "# demo\n");
  writeFileSync(join(root, "bin", "worker-entry.mjs"), "console.log('entry');\n");
}
