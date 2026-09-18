import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  findSshHost,
  listSshHosts,
  matchSshHosts,
  parseSshDestination,
  rememberSshHost,
  sshDestination,
} from "./ssh-history.js";

function withHome(fn: () => void) {
  const home = mkdtempSync(join(tmpdir(), "socode-ssh-hist-"));
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

describe("ssh history", () => {
  it("parses user@host and rejects paths", () => {
    assert.deepEqual(parseSshDestination("root@10.0.0.1"), { user: "root", host: "10.0.0.1" });
    assert.equal(parseSshDestination("root@10.0.0.1:/abs"), null);
    assert.equal(parseSshDestination("root@10.0.0.1 extra"), null);
  });

  it("remembers hosts without a password", () => {
    withHome(() => {
      rememberSshHost({
        user: "root",
        host: "106.53.55.161",
        auth: "password",
        identityFile: "not-a-path",
        lastWorkspace: "/root/server/minecraft_server",
      });
      rememberSshHost({ user: "me", host: "box.example", auth: "key", identityFile: "~/.ssh/id_ed25519" });
      const hosts = listSshHosts();
      assert.equal(hosts[0]?.host, "box.example");
      assert.equal(hosts[1]?.host, "106.53.55.161");
      assert.equal(hosts[1]?.lastWorkspace, "/root/server/minecraft_server");
      assert.equal(hosts[1]?.identityFile, undefined);
      const raw = readFileSync(join(process.env.SOCODE_HOME ?? "", "ssh-hosts.json"), "utf8");
      assert.equal(raw.includes("not-a-path"), false);
      assert.equal(raw.includes("password"), true);
      assert.match(raw, /id_ed25519/);
      assert.equal(sshDestination(hosts[1]!), "root@106.53.55.161");
      assert.equal(findSshHost("root", "106.53.55.161")?.user, "root");
      assert.equal(matchSshHosts("106").length, 1);
      assert.equal(matchSshHosts("root@").length, 1);
    });
  });

  it("moves a repeated host to the front", () => {
    withHome(() => {
      rememberSshHost({ user: "a", host: "one.test" });
      rememberSshHost({ user: "b", host: "two.test" });
      rememberSshHost({ user: "a", host: "one.test", lastWorkspace: "//tmp/proj/" });
      const hosts = listSshHosts();
      assert.equal(hosts.length, 2);
      assert.equal(hosts[0]?.host, "one.test");
      assert.equal(hosts[0]?.lastWorkspace, "/tmp/proj");
      assert.equal(existsSync(join(process.env.SOCODE_HOME ?? "", "providers.json")), false);
    });
  });
});
