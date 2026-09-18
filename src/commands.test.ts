import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { completeCommand, matchCommands, parseRemoteSshCommand } from "./commands.js";
import { rememberSshHost } from "./ssh-history.js";

function withHome(fn: () => void) {
  const home = mkdtempSync(join(tmpdir(), "socode-cmd-"));
  const prev = process.env.SOCODE_HOME;
  process.env.SOCODE_HOME = home;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.SOCODE_HOME;
    else process.env.SOCODE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("remote-ssh command complete", () => {
  it("tabs through remembered hosts and never includes a password", () => {
    withHome(() => {
      rememberSshHost({ user: "root", host: "10.0.0.1", lastWorkspace: "/root/app" });
      rememberSshHost({ user: "me", host: "box.test" });
      const names = matchCommands("/remote-ssh").map((item) => item.name);
      assert.equal(names.includes("/remote-ssh"), true);
      assert.equal(names.includes("/remote-ssh me@box.test"), true);
      assert.equal(names.includes("/remote-ssh root@10.0.0.1"), true);
      assert.equal(completeCommand("/remote-ssh"), "/remote-ssh me@box.test");
      assert.equal(completeCommand("/remote-ssh"), "/remote-ssh root@10.0.0.1");
      assert.equal(completeCommand("/remote-ssh r"), "/remote-ssh root@10.0.0.1");
      const parsed = parseRemoteSshCommand("/remote-ssh root@10.0.0.1");
      assert.equal(parsed && parsed.ok && parsed.target, "root@10.0.0.1");
    });
  });

  it("tabs /ssh onto /remote-ssh and parses the same target", () => {
    withHome(() => {
      rememberSshHost({ user: "root", host: "10.0.0.1" });
      assert.equal(completeCommand("/ssh"), "/remote-ssh");
      assert.equal(completeCommand("/ssh r"), "/remote-ssh root@10.0.0.1");
      assert.equal(
        matchCommands("/ssh").some((item) => item.name === "/ssh"),
        true,
      );
      assert.equal(matchCommands("/sshquit")[0]?.name, "/sshquit");
      const parsed = parseRemoteSshCommand("/ssh root@10.0.0.1");
      assert.equal(parsed && parsed.ok && parsed.target, "root@10.0.0.1");
      assert.equal(parseRemoteSshCommand("/sshquit"), null);
    });
  });
});
