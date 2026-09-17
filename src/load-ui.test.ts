import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLoadUi, formatLoadFrame, LOAD_FRAMES, stopLoadUi } from "./load-ui.js";

describe("formatLoadFrame", () => {
  it("looks like npm gauge: spinner, pulse bar, label", () => {
    const frame = formatLoadFrame(0);
    assert.equal(frame.startsWith(`  ${LOAD_FRAMES[0]} [`), true);
    assert.match(frame, /socoding$/);
    assert.match(frame, /█/);
    assert.match(frame, /░/);
  });

  it("slides the block then bounces back", () => {
    const bar = (tick: number) => formatLoadFrame(tick).match(/\[([░█]+)\]/)?.[1] ?? "";
    assert.equal(bar(0).indexOf("█"), 0);
    assert.equal(bar(3).indexOf("█"), 3);
    assert.equal(bar(12).indexOf("█"), 6);
    assert.equal(formatLoadFrame(0), formatLoadFrame(90));
  });

  it("paints spinner and bar green when color is on", () => {
    const frame = formatLoadFrame(0, { color: true, label: "socoding" });
    assert.match(frame, /\x1b\[32m/);
    assert.match(frame, /socoding/);
  });
});

describe("createLoadUi", () => {
  it("is a no-op without a TTY", () => {
    const writes: string[] = [];
    const ui = createLoadUi({ tty: false, write: (text) => writes.push(text) });
    ui.start();
    ui.stop();
    assert.deepEqual(writes, []);
  });

  it("paints in place then clears the line", () => {
    const writes: string[] = [];
    let tick: (() => void) | undefined;
    const ui = createLoadUi({
      tty: true,
      color: false,
      write: (text) => writes.push(text),
      setInterval: ((fn: () => void) => {
        tick = fn;
        return 1 as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
      clearInterval: () => undefined,
    });
    ui.start();
    assert.match(writes.join(""), new RegExp(LOAD_FRAMES[0]));
    tick?.();
    assert.match(writes.join(""), new RegExp(LOAD_FRAMES[1]));
    ui.stop();
    assert.match(writes.at(-1) ?? "", /\x1b\[2K/);
    stopLoadUi();
  });
});
