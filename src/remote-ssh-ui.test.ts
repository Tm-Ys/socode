import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { paintConnectLog } from "./connect.js";
import {
  applyRemoteSshKey,
  applySshTarget,
  emptyRemoteSshView,
  formatRemoteSshScreen,
} from "./remote-ssh-ui.js";
import { rememberSshHost } from "./ssh-history.js";

describe("remote-ssh screen", () => {
  it("splits the page into a form and a log pane", () => {
    const view = emptyRemoteSshView();
    view.host = "106.53.55.161";
    view.user = "root";
    view.logs.push({ level: "ok", text: "密码登录成功 root@106.53.55.161" });
    view.logs.push({ level: "err", text: "工作区不存在" });
    view.secret = "plain-password";
    const text = formatRemoteSshScreen(view, { cols: 72, rows: 24, color: false });
    assert.match(text, /\/remote-ssh/);
    assert.match(text, /主机/);
    assert.match(text, /106\.53\.55\.161/);
    assert.match(text, /plain-password/);
    assert.doesNotMatch(text, /\*{6,}/);
    assert.match(text, /注入本机 Provider/);
    assert.match(text, /日志/);
    assert.match(text, /ok .*密码登录成功/);
    assert.match(text, /err .*工作区不存在/);
    assert.equal(text.split("\n").length, 24);
    const green = paintConnectLog("ok", "握手成功", true);
    const red = paintConnectLog("err", "失败", true);
    assert.match(green, /\x1b\[32m/);
    assert.match(red, /\x1b\[31m/);
  });

  it("moves from the form to workspace picking", () => {
    const view = emptyRemoteSshView();
    view.focus = "secret";
    view.secret = "secret";
    assert.equal(applyRemoteSshKey(view, "\r"), "connect");
    view.phase = "pick";
    view.cwd = "/root";
    view.dirs = ["/root/app"];
    view.dirIndex = 0;
    assert.equal(applyRemoteSshKey(view, "\x1b[B"), "redraw");
    assert.equal(view.dirIndex, 1);
    assert.equal(applyRemoteSshKey(view, "\x1b[C"), "enter-dir");
    assert.equal(applyRemoteSshKey(view, "\r"), "redraw");
    assert.equal(view.confirmPath, "/root/app");
    const text = formatRemoteSshScreen(view, { cols: 72, rows: 24, color: false });
    assert.match(text, /确定选择 \/root\/app 为工作目录\?/);
    assert.equal(applyRemoteSshKey(view, "\r"), "pick");
  });

  it("toggles password and key auth", () => {
    const view = emptyRemoteSshView();
    view.focus = "auth";
    view.secret = "x";
    applyRemoteSshKey(view, "\x1b[C");
    assert.equal(view.auth, "key");
    assert.equal(view.secret, "");
  });

  it("tabs the host field through history and leaves the password empty", () => {
    const home = mkdtempSync(join(tmpdir(), "socode-ssh-ui-"));
    const prev = process.env.SOCODE_HOME;
    process.env.SOCODE_HOME = home;
    try {
      rememberSshHost({ user: "root", host: "106.53.55.161", lastWorkspace: "/root/app" });
      const view = emptyRemoteSshView();
      view.focus = "host";
      view.secret = "should-clear";
      assert.equal(applyRemoteSshKey(view, "\t"), "redraw");
      assert.equal(view.host, "106.53.55.161");
      assert.equal(view.user, "root");
      assert.equal(view.secret, "");
      assert.equal(view.focus, "secret");
      const other = emptyRemoteSshView();
      assert.equal(applySshTarget(other, "root@106.53.55.161"), true);
      assert.equal(other.host, "106.53.55.161");
      assert.equal(other.secret, "");
      const text = formatRemoteSshScreen(view, { cols: 72, rows: 24, color: false });
      assert.match(text, /tab 补全历史主机/);
    } finally {
      if (prev === undefined) delete process.env.SOCODE_HOME;
      else process.env.SOCODE_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("hides the password while installing the remote worker", () => {
    const view = emptyRemoteSshView();
    view.host = "106.53.55.161";
    view.user = "root";
    view.secret = "plain-password";
    view.phase = "install";
    view.cwd = "/root/server";
    view.confirmPath = "/root/server";
    const text = formatRemoteSshScreen(view, { cols: 72, rows: 20, color: false });
    assert.match(text, /正在把 worker 装到对方机器/);
    assert.match(text, /root@106\.53\.55\.161/);
    assert.match(text, /\/root\/server/);
    assert.doesNotMatch(text, /plain-password/);
    assert.doesNotMatch(text, /输入密码/);
    assert.match(text, /不要按键/);
    assert.equal(text.split("\n").length, 20);
    assert.doesNotMatch(text, /\n{3,}/);
  });
});
