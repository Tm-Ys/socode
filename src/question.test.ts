import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyQuestionKey,
  createQuestionnaireState,
  CUSTOM_LABEL,
  formatQuestionFrame,
  formatQuestionResult,
  isConfirmTab,
  parseQuestions,
  type QuestionInfo,
  type QuestionKeyResult,
  type QuestionnaireState,
} from "./question.js";

const storage: QuestionInfo = {
  question: "用哪种存储？",
  header: "存储",
  options: [
    { label: "SQLite (Recommended)", description: "本地文件，零依赖" },
    { label: "PostgreSQL", description: "已有数据库" },
  ],
  multiple: false,
};

const port: QuestionInfo = {
  question: "监听端口？",
  header: "端口",
  options: [
    { label: "3000", description: "默认" },
    { label: "8080", description: "备用" },
  ],
  multiple: false,
};

describe("parseQuestions", () => {
  it("keeps presets and always treats Type your own answer as extra", () => {
    const questions = parseQuestions({
      questions: [
        {
          question: "用哪种存储？",
          header: "存储",
          options: [
            { label: "SQLite (Recommended)", description: "本地文件" },
            { label: "Other" },
            { label: "Type your own answer" },
          ],
        },
      ],
    });
    assert.equal(questions.length, 1);
    assert.deepEqual(
      questions[0]?.options.map((item) => item.label),
      ["SQLite (Recommended)"],
    );
    const frame = formatQuestionFrame(createQuestionnaireState(questions));
    assert.match(frame, /1\. > SQLite \(Recommended\)/);
    assert.match(frame, /2\.\s+Type your own answer/);
    assert.equal(frame.includes(CUSTOM_LABEL), true);
  });

  it("puts Type your own answer second-last and Submit last on multi-select", () => {
    const questions = parseQuestions({
      questions: [
        {
          question: "要哪些功能？",
          header: "功能",
          multiple: true,
          options: [
            { label: "搜索", description: "全文" },
            { label: "缓存", description: "Redis" },
            { label: "提交答案" },
          ],
        },
      ],
    });
    const frame = formatQuestionFrame(createQuestionnaireState(questions));
    assert.match(frame, /1\. > \[ \] 搜索/);
    assert.match(frame, /3\.\s+\[ \] Type your own answer/);
    assert.match(frame, /4\.\s+提交答案/);
    assert.ok(frame.indexOf(CUSTOM_LABEL) < frame.indexOf("提交答案"));
  });

  it("requires at least one real preset option", () => {
    assert.throws(
      () =>
        parseQuestions({
          questions: [{ question: "x", options: [{ label: "其他" }] }],
        }),
      /预设选项/,
    );
  });
});

describe("questionnaire keys", () => {
  it("submits a single-select question immediately", () => {
    const result = drive([storage], ["1"]);
    assert.equal(result.type, "submit");
    if (result.type === "submit") assert.deepEqual(result.answers, [["SQLite (Recommended)"]]);
  });

  it("lets the last option type a custom answer", () => {
    const result = drive([storage], ["3", "n", "e", "o", "4", "j", "\r"]);
    assert.equal(result.type, "submit");
    if (result.type === "submit") assert.deepEqual(result.answers, [["neo4j"]]);
  });

  it("advances through multiple questions then confirms", () => {
    const afterFirst = drive([storage, port], ["1"]);
    assert.equal(afterFirst.type, "state");
    if (afterFirst.type !== "state") return;
    assert.equal(afterFirst.state.tab, 1);
    const afterSecond = applyQuestionKey(afterFirst.state, "2");
    assert.equal(afterSecond.type, "state");
    if (afterSecond.type !== "state") return;
    assert.equal(isConfirmTab(afterSecond.state), true);
    assert.match(formatQuestionFrame(afterSecond.state), /Review/);
    assert.match(formatQuestionFrame(afterSecond.state), /存储: SQLite \(Recommended\)/);
    const submitted = applyQuestionKey(afterSecond.state, "\r");
    assert.equal(submitted.type, "submit");
    if (submitted.type === "submit") {
      assert.deepEqual(submitted.answers, [["SQLite (Recommended)"], ["8080"]]);
    }
  });

  it("toggles multi-select and submits from the last Submit answers row", () => {
    const features: QuestionInfo = {
      question: "要哪些功能？",
      header: "功能",
      options: [
        { label: "搜索", description: "全文" },
        { label: "缓存", description: "Redis" },
      ],
      multiple: true,
    };
    const frame = formatQuestionFrame(createQuestionnaireState([features]));
    assert.match(frame, /3\.\s+\[ \] Type your own answer/);
    assert.match(frame, /4\.\s+提交答案/);
    const result = drive([features], ["1", "2", "4"]);
    assert.equal(result.type, "submit");
    if (result.type === "submit") assert.deepEqual(result.answers, [["搜索", "缓存"]]);
  });

  it("advances a multi-select question with Submit, then confirms the rest", () => {
    const features: QuestionInfo = {
      question: "要哪些功能？",
      header: "功能",
      options: [
        { label: "搜索", description: "全文" },
        { label: "缓存", description: "Redis" },
      ],
      multiple: true,
    };
    const afterMulti = drive([features, port], ["1", "4"]);
    assert.equal(afterMulti.type, "state");
    if (afterMulti.type !== "state") return;
    assert.equal(afterMulti.state.tab, 1);
    const afterPort = applyQuestionKey(afterMulti.state, "1");
    assert.equal(afterPort.type, "state");
    if (afterPort.type !== "state") return;
    assert.equal(isConfirmTab(afterPort.state), true);
    const submitted = applyQuestionKey(afterPort.state, "\r");
    assert.equal(submitted.type, "submit");
    if (submitted.type === "submit") {
      assert.deepEqual(submitted.answers, [["搜索"], ["3000"]]);
    }
  });

  it("esc dismisses the questionnaire", () => {
    const result = drive([storage], ["\x1b"]);
    assert.equal(result.type, "reject");
  });
});

describe("formatQuestionResult", () => {
  it("lists answers for the model", () => {
    const text = formatQuestionResult([storage, port], [["SQLite (Recommended)"], []]);
    assert.match(text, /- 存储: SQLite \(Recommended\)/);
    assert.match(text, /- 端口: （未答）/);
    assert.match(text, /User has answered your questions/);
    assert.match(text, /"监听端口？"="Unanswered"/);
  });
});

function drive(questions: QuestionInfo[], keys: string[]): QuestionKeyResult {
  let state: QuestionnaireState = createQuestionnaireState(questions);
  let last: QuestionKeyResult = { type: "state", state };
  for (const key of keys) {
    last = applyQuestionKey(state, key);
    if (last.type !== "state") return last;
    state = last.state;
  }
  return last;
}
