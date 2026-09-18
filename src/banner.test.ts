import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bannerTitle, formatBanner, packageVersion, pickWelcome, WELCOME_LINES } from "./banner.js";

describe("welcome lines", () => {
  it("explains a command and always picks one of them", () => {
    assert.ok(WELCOME_LINES.length >= 12);
    for (const line of WELCOME_LINES) {
      assert.match(line, /^你知道吗？.+\。$/);
    }
    assert.equal(pickWelcome(() => 0), WELCOME_LINES[0]);
    assert.equal(pickWelcome(() => 0.999), WELCOME_LINES[WELCOME_LINES.length - 1]);
    for (let i = 0; i < 20; i += 1) {
      assert.ok(WELCOME_LINES.includes(pickWelcome(() => (i + 0.5) / 20)));
    }
  });
});

describe("formatBanner", () => {
  it("shows a boxed welcome without dumping every command", () => {
    const text = formatBanner({
      workspace: "/Users/me/projects/socode",
      title: "新会话",
      mode: "ask",
      welcome: "你知道吗？输入 / 会按前缀列出命令，Tab 补全。",
      width: 56,
      color: false,
    });
    assert.match(text, /╭─ socode @ /);
    assert.match(text, /presented by Tm-Ys/);
    assert.match(text, /你知道吗？/);
    assert.match(text, /Ask · 新会话/);
    assert.match(text, /\/ 看命令/);
    assert.doesNotMatch(text, /\/provider/);
    assert.doesNotMatch(text, /工具步数/);
    assert.doesNotMatch(text, /MCP/);
  });

  it("keeps the box edges aligned", () => {
    const text = formatBanner({
      workspace: "/tmp/demo",
      title: "新会话",
      mode: "ask",
      welcome: "你知道吗？思考强度请用 /effort 调，不要走 /provider edit。",
      width: 56,
      color: false,
    });
    const rows = text.split("\n").filter((line) => line.startsWith("╭") || line.startsWith("│") || line.startsWith("╰"));
    const widths = rows.map((line) => displayWidth(line));
    assert.ok(widths.length > 2);
    assert.ok(widths.every((width) => width === widths[0]), String(widths));
  });

  it("only mentions MCP when tools are loaded", () => {
    const text = formatBanner({
      workspace: "/tmp/demo",
      mode: "plan",
      welcome: "hi",
      mcpCount: 3,
      width: 48,
      color: false,
    });
    assert.match(text, /MCP 3 个工具/);
    assert.match(text, /Plan · 新会话/);
  });

  it("puts version and presenter in the box title", () => {
    assert.match(bannerTitle("0.1.2"), /^socode @ 0\.1\.2 presented by Tm-Ys$/);
    assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
  });

  it("shows ssh host in the workspace line", () => {
    const text = formatBanner({
      workspace: "/root/example",
      mode: "ask",
      welcome: "hi",
      remoteHost: "106.53.55.161",
      remoteHome: "/root",
      width: 56,
      color: false,
    });
    assert.match(text, /ssh@106\.53\.55\.161/);
    assert.match(text, /~\/example/);
    assert.match(text, /\/sshquit 断开远程/);
    assert.doesNotMatch(text, /Ctrl\+C 两次退出/);
  });
});

function displayWidth(text: string) {
  let width = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (char === "·" || char === "…" || cp <= 127 || (cp >= 0x2500 && cp <= 0x259f)) width += 1;
    else width += 2;
  }
  return width;
}
