import test from "node:test";
import assert from "node:assert/strict";
import { detectIntents } from "./intentRouter.js";
import { resolveReasoningIntents } from "./reasoningLayer.js";
import { MERCHANT_QUESTION_CORPUS } from "./merchantQuestionCorpus.js";

test("merchant question corpus contains at least 200 unique, categorized questions", () => {
  assert.ok(MERCHANT_QUESTION_CORPUS.length >= 200);
  const ids = MERCHANT_QUESTION_CORPUS.map((item) => item.id);
  const questions = MERCHANT_QUESTION_CORPUS.map((item) => item.question.toLowerCase());
  assert.equal(new Set(ids).size, ids.length, "question IDs must be unique");
  assert.equal(new Set(questions).size, questions.length, "question wording must be unique");
  for (const item of MERCHANT_QUESTION_CORPUS) {
    assert.ok(item.category && item.question.trim(), "every item needs a category and question");
  }
});

test("baseline: report how the current router handles the merchant question corpus", () => {
  const results = MERCHANT_QUESTION_CORPUS.map(({ id, category, question }) => {
    const detected = detectIntents(question);
    const resolved = resolveReasoningIntents(question, detected);
    return { id, category, question, detected, resolved, recognized: resolved.length > 0 };
  });

  const recognized = results.filter((item) => item.recognized);
  const unrecognized = results.filter((item) => !item.recognized);
  const byCategory = Object.fromEntries(
    [...new Set(results.map((item) => item.category))].map((category) => {
      const rows = results.filter((item) => item.category === category);
      return [category, {
        total: rows.length,
        recognized: rows.filter((item) => item.recognized).length,
        unrecognized: rows.filter((item) => !item.recognized).map((item) => item.question),
      }];
    })
  );

  console.log("\n[REDEN MERCHANT QUESTION BASELINE]");
  console.log(JSON.stringify({
    total: results.length,
    recognized: recognized.length,
    unrecognized: unrecognized.length,
    coveragePercent: Number((recognized.length / results.length * 100).toFixed(1)),
    byCategory,
  }, null, 2));

  // This is a measurement test, not a pass/fail assertion that current
  // production routing already supports every merchant question.
  assert.equal(results.length, MERCHANT_QUESTION_CORPUS.length);
});
