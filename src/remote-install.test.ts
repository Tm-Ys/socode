import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractNodeScript,
  extractScript,
  installNodeScript,
  latestNode22Version,
  officialNodeTarball,
  parseNodeInstall,
  parseNodeMajor,
  parseProbe,
  parseUname,
  parseWorkspaceList,
  parentDir,
  normalizeAbsPath,
  probeScript,
  resolveWorkerNode,
  shQuote,
  shouldInstallNode,
  shouldUploadNode,
  sshBatchArgs,
  sshMasterArgs,
  wrapRemoteScript,
  sessionProviderPath,
  sshExecArgs,
  sshWorkerArgs,
  sshForwardArgs,
  startListenWorkerScript,
  parseListenStart,
  replaceRuntimeScript,
  wipeSessionProviderScript,
  workerScript,
} from "./remote-install.js";

describe("parseUname", () => {
  it("accepts Linux and Darwin x86_64/arm64", () => {
    assert.deepEqual(parseUname("Linux x86_64"), { os: "linux", arch: "x64" });
    assert.deepEqual(parseUname("Darwin arm64"), { os: "darwin", arch: "arm64" });
    assert.deepEqual(parseUname("Linux aarch64"), { os: "linux", arch: "arm64" });
  });

  it("rejects windows and unknown arch", () => {
    assert.equal("error" in parseUname("Windows_NT AMD64"), true);
    assert.equal("error" in parseUname("Linux riscv64"), true);
  });
});

describe("node install policy", () => {
  it("keeps remote Node 22+ and installs on the remote when missing or too old", () => {
    assert.equal(parseNodeMajor("v22.11.0"), 22);
    assert.equal(
      shouldInstallNode({ nodeVersion: "v22.11.0", portableNodeVersion: null }),
      false,
    );
    assert.equal(shouldUploadNode({ nodeVersion: "v18.20.0", portableNodeVersion: null }), true);
    assert.equal(shouldInstallNode({ nodeVersion: null, portableNodeVersion: null }), true);
    assert.equal(
      shouldInstallNode({ nodeVersion: "v20.20.2", portableNodeVersion: "v22.14.0" }),
      false,
    );
    assert.equal(
      officialNodeTarball("22.11.0", { os: "linux", arch: "arm64" }).url,
      "https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-arm64.tar.gz",
    );
    assert.equal(
      resolveWorkerNode({
        nodeVersion: "v20.20.2",
        nodePath: "/usr/bin/node",
        portableNodeVersion: "v22.14.0",
        portableNodePath: "/root/.socode-server/node/node-v22.14.0-linux-x64/bin/node",
      }),
      "/root/.socode-server/node/node-v22.14.0-linux-x64/bin/node",
    );
    const script = installNodeScript();
    assert.match(script, /uname -s/);
    assert.match(script, /curl/);
    assert.match(script, /nodejs\.org\/dist/);
    assert.match(script, /npmmirror\.com/);
    assert.equal(script.includes("scp "), false);
    const parsed = parseNodeInstall(
      [
        "SOCODE_NODE_V1",
        "UNAME Linux x86_64",
        "PLATFORM linux-x64",
        "FETCHER curl",
        "NET ok https://npmmirror.com/mirrors/node",
        "NODE_BIN /root/.socode-server/node/node-v22.23.2-linux-x64/bin/node",
        "NODE_VER 22.23.2",
      ].join("\n"),
    );
    assert.equal("error" in parsed, false);
    if ("error" in parsed) return;
    assert.equal(parsed.bin.endsWith("/bin/node"), true);
    assert.match(parsed.net, /npmmirror/);
  });
});

describe("remote scripts", () => {
  it("quotes paths and never uses ssh -t", () => {
    assert.equal(shQuote("it's"), `'it'\\''s'`);
    assert.match(extractNodeScript("/home/me", "node-v22.11.0-linux-x64.tar.gz"), /tar -xzf/);
    const args = sshBatchArgs("me@box", "uname -s -m");
    assert.equal(args.includes("-t"), false);
    assert.equal(args.includes("-T"), true);
    assert.equal(args.includes("BatchMode=yes"), true);
    assert.equal(args.at(-1)?.includes("\n"), false);
    const wrapped = wrapRemoteScript("echo SOCODE_PROBE_V1\necho UNAME $(uname -s -m)");
    assert.equal(wrapped.includes("\n"), false);
    assert.match(wrapped, /bash --noprofile --norc -c /);
    const master = sshMasterArgs("me@box", "/tmp/mux", { password: true });
    assert.equal(master.includes("-fN"), true);
    assert.equal(master.includes("ControlMaster=yes"), true);
    assert.equal(master.includes("PreferredAuthentications=password,keyboard-interactive"), true);
    assert.equal(master.includes("-t"), false);
    const keyed = sshMasterArgs("me@box", "/tmp/mux", { identityFile: "/home/me/.ssh/id_ed25519" });
    assert.equal(keyed.includes("IdentitiesOnly=yes"), true);
    assert.equal(keyed.includes("/home/me/.ssh/id_ed25519"), true);
    assert.match(probeScript("/abs/repo"), /uname -s -m/);
    assert.match(extractScript("/home/me", "0.1.2+abc", "socode-runtime-0.1.2+abc.tar.gz"), /tar -xzf/);
    const launch = workerScript({
      nodePath: "/usr/bin/node",
      runtimeRoot: "/home/me/.socode-server/runtime/0.1.2+abc",
      workspace: "/abs/repo",
      env: { SOCODE_PROVIDER_STORE: "/home/me/.socode-server/session/providers.json" },
    });
    assert.match(launch, /exec env SOCODE_PROVIDER_STORE=/);
    assert.match(launch, /session\/providers\.json/);
    assert.match(launch, /worker-entry\.mjs/);
    assert.match(launch, /--stdio/);
    assert.equal(launch.includes("sk-"), false);
    assert.equal(sessionProviderPath("/home/me"), "/home/me/.socode-server/session/providers.json");
    assert.match(wipeSessionProviderScript("/home/me"), /rm -f /);
    assert.match(wipeSessionProviderScript("/home/me"), /session\/providers\.json/);
    const execArgs = sshExecArgs("me@box", launch);
    assert.equal(execArgs.at(-1), `bash --noprofile --norc -c ${shQuote(launch)}`);
    assert.match(execArgs.at(-1) ?? "", /exec env SOCODE_PROVIDER_STORE=/);
    assert.equal(execArgs.includes("-T"), true);
    const workerArgs = sshWorkerArgs("me@box", launch, { password: true });
    assert.equal(workerArgs.includes("ControlPath=none"), true);
    assert.equal(workerArgs.includes("ControlMaster=no"), true);
    assert.equal(workerArgs.some((arg) => arg.startsWith("ControlPath=/")), false);
    assert.equal(workerArgs.includes("BatchMode=yes"), false);
    assert.equal(workerArgs.includes("PreferredAuthentications=password,keyboard-interactive"), true);
    assert.equal(workerArgs.at(-1), `bash --noprofile --norc -c ${shQuote(launch)}`);
    const workerKeyed = sshWorkerArgs("me@box", launch, { identityFile: "/tmp/id" });
    assert.equal(workerKeyed.includes("BatchMode=yes"), true);
    assert.equal(workerKeyed.includes("/tmp/id"), true);
    const forward = sshForwardArgs("me@box", 43123, { controlPath: "/tmp/mux", batch: true, master: "no" });
    assert.equal(forward.includes("-W"), true);
    assert.equal(forward.includes("127.0.0.1:43123"), true);
    assert.equal(forward.includes("ControlPath=/tmp/mux"), true);
    const replaced = replaceRuntimeScript("/root", "0.1.3-fix2+abc", "socode-runtime-0.1.3-fix2+abc.tar.gz");
    assert.match(replaced, /pkill -f/);
    assert.match(replaced, /rm -rf/);
    assert.match(replaced, /SOCODE_RUNTIME_REPLACED/);
    assert.match(replaced, /0\.1\.3-fix2\+abc/);
    assert.equal(replaced.includes("socode-runtime-0.1.3-fix2+abc.tar.gz"), true);
    const listen = startListenWorkerScript({
      nodePath: "/usr/bin/node",
      runtimeRoot: "/root/.socode-server/runtime/0.1.3-fix2+abc",
      workspace: "/root/server",
      home: "/root",
      env: { SOCODE_PROVIDER_STORE: "/root/.socode-server/session/providers.json" },
    });
    assert.match(listen, /--listen 127\.0\.0\.1:0/);
    assert.match(listen, /--port-file/);
    assert.match(listen, /nohup /);
    assert.match(listen, /SOCODE_LISTEN_V1/);
    const parsed = parseListenStart(["SOCODE_LISTEN_V1", "PID 42", "PORT 43123"].join("\n"));
    assert.equal("error" in parsed, false);
    if ("error" in parsed) return;
    assert.equal(parsed.pid, 42);
    assert.equal(parsed.port, 43123);
  });

  it("parses probe stdout", () => {
    const parsed = parseProbe(
      [
        "SOCODE_PROBE_V1",
        "UNAME Darwin arm64",
        "HOME /Users/me",
        "NODE v22.14.0",
        "NODE_PATH /usr/local/bin/node",
        "PORTABLE_NODE",
        "PORTABLE_NODE_PATH",
        "WORKSPACE ok",
        "RUNTIME 0.1.2+abc",
      ].join("\n"),
    );
    assert.equal("error" in parsed, false);
    if ("error" in parsed) return;
    assert.equal(parsed.platform.os, "darwin");
    assert.equal(parsed.nodePath, "/usr/local/bin/node");
    assert.equal(parsed.workspaceOk, true);
    assert.equal(parsed.portableNodePath, null);
  });

  it("parses remote workspace listings", () => {
    const parsed = parseWorkspaceList(
      ["SOCODE_DIRS_V1", "HOME /root", "CWD /root", "DIR /root/app", "DIR /root/app"].join("\n"),
    );
    assert.equal("error" in parsed, false);
    if ("error" in parsed) return;
    assert.equal(parsed.home, "/root");
    assert.equal(parsed.cwd, "/root");
    assert.deepEqual(parsed.dirs, ["/root/app"]);
    assert.equal(parentDir("/root/app"), "/root");
    assert.equal(parentDir("/root"), "/");
    assert.equal(parentDir("/"), "/");
    assert.equal(parentDir("//root/server/minecraft_server"), "/root/server");
    assert.equal(normalizeAbsPath("//root/app/"), "/root/app");
  });
});

describe("latestNode22Version", () => {
  it("picks the first v22 from the dist index", async () => {
    const version = await latestNode22Version(async () =>
      new Response(JSON.stringify([{ version: "v23.1.0" }, { version: "v22.19.0" }, { version: "v20.18.0" }])),
    );
    assert.equal(version, "22.19.0");
  });
});
