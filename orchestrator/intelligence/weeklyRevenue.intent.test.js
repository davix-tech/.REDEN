import test from "node:test";
import assert from "node:assert/strict";
import { detectIntents } from "./intentRouter.js";

test("routes weekly revenue questions to week-to-date reporting", () => {
  assert.deepEqual(detectIntents("How much did my store make this week?"), ["weekly_revenue"]);
  assert.deepEqual(detectIntents("What is my income this week?"), ["weekly_revenue"]);
  assert.deepEqual(detectIntents("How much revenue so far this week?"), ["weekly_revenue"]);
});

test("keeps daily revenue questions on the existing daily path", () => {
  assert.deepEqual(detectIntents("How much revenue did I make today?"), ["revenue"]);
});
