import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDefaultTitle, statusSessionLabel } from "./title.js";

describe("statusSessionLabel", () => {
  it("uses new until a real title exists", () => {
    assert.equal(statusSessionLabel(""), "new");
    assert.equal(statusSessionLabel("新会话"), "new");
    assert.equal(isDefaultTitle("新会话"), true);
    assert.equal(statusSessionLabel("初次问候与询问需求"), "初次问候与询问需求");
  });
});
