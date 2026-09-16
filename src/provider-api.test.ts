import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyEffortKey,
  applyModelPickKey,
  createModelPickState,
  currentModelPick,
  defaultEffortIndex,
  modelsUrl,
  parseModelCatalog,
} from "./provider-api.js";
import { formatEffortFrame, formatModelFrame } from "./select-ui.js";
import type { Provider } from "./provider.js";

const deepseek: Provider = {
  name: "deepseek",
  url: "https://api.deepseek.com/v1",
  api: "sk-test",
  model: "deepseek-flash",
  contextWindow: 128000,
  maxOutput: 8192,
  thinkingEffort: "medium",
};

const other: Provider = {
  ...deepseek,
  name: "deepseek-reasoner",
  model: "deepseek-reasoner",
};

describe("parseModelCatalog", () => {
  it("reads supported efforts and the current model from an OpenAI-style list", () => {
    const catalog = parseModelCatalog(
      {
        data: [
          {
            id: "deepseek-flash",
            supported_reasoning_efforts: ["low", "medium", "high"],
            reasoning_effort: "medium",
          },
          { id: "deepseek-reasoner" },
        ],
      },
      "deepseek-flash",
    );
    assert.equal(catalog.source, "api");
    assert.deepEqual(catalog.models, ["deepseek-flash", "deepseek-reasoner"]);
    assert.deepEqual(catalog.efforts, ["low", "medium", "high"]);
    assert.equal(catalog.apiEffort, "medium");
  });

  it("falls back to the full scale when the API omits effort fields", () => {
    const catalog = parseModelCatalog({ data: [] }, "x");
    assert.equal(catalog.source, "fallback");
    assert.deepEqual(catalog.efforts, ["none", "minimal", "low", "medium", "high", "xhigh"]);
  });
});

describe("effort keys", () => {
  it("moves along the scale with arrows and wraps", () => {
    assert.deepEqual(applyEffortKey(2, 6, "\x1b[C"), { type: "index", index: 3 });
    assert.deepEqual(applyEffortKey(0, 6, "\x1b[D"), { type: "index", index: 5 });
    assert.deepEqual(applyEffortKey(1, 6, "\x1b[A"), { type: "index", index: 0 });
    assert.deepEqual(applyEffortKey(1, 6, "\x1b[B"), { type: "index", index: 2 });
    assert.equal(applyEffortKey(1, 6, "\r").type, "submit");
    assert.equal(applyEffortKey(1, 6, "\x1b").type, "cancel");
  });

  it("defaults to medium when the current value is unknown", () => {
    const efforts = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
    assert.equal(defaultEffortIndex([...efforts], "medium"), 3);
    assert.equal(defaultEffortIndex([...efforts], "nope"), 3);
    assert.equal(defaultEffortIndex([...efforts], "low"), 2);
  });
});

describe("model pick", () => {
  it("switches provider with left/right and model with up/down", () => {
    const openai: Provider = {
      ...deepseek,
      name: "openai",
      url: "https://api.openai.com/v1",
      model: "gpt-5",
    };
    let state = createModelPickState([deepseek, other, openai], deepseek);
    assert.equal(currentModelPick(state).provider?.name, "deepseek");
    const right = applyModelPickKey(state, "\x1b[C");
    assert.equal(right.type, "state");
    if (right.type !== "state") return;
    state = right.state;
    assert.equal(currentModelPick(state).provider?.name, "deepseek-reasoner");
    const down = applyModelPickKey(state, "\x1b[B");
    assert.equal(down.type, "state");
    if (down.type !== "state") return;
    assert.equal(currentModelPick(down.state).model, "deepseek-flash");
  });

  it("renders both choosers", () => {
    assert.match(formatEffortFrame(["low", "medium", "high"], 1, "API: medium"), /\[medium\]/);
    const state = createModelPickState([deepseek, other], deepseek);
    const frame = formatModelFrame(state);
    assert.match(frame, /\[deepseek\]/);
    assert.match(frame, /\[deepseek-flash\]/);
  });
});

describe("modelsUrl", () => {
  it("points at /models next to chat completions", () => {
    assert.equal(modelsUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/models");
    assert.equal(modelsUrl("https://api.deepseek.com/v1/chat/completions"), "https://api.deepseek.com/v1/models");
  });
});
