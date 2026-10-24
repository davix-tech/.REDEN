import test from "node:test";
import assert from "node:assert/strict";
import { detectIntents } from "./intentRouter.js";

test("routes plain-language earnings question to revenue only", () => {
  assert.deepEqual(detectIntents("How much did I make?"), ["revenue"]);
});

test("routes a sales decline question to both summary and diagnosis", () => {
  assert.deepEqual(detectIntents("Why are sales down?"), ["sales", "diagnostic"]);
});

test("routes funnel questions to funnel analysis", () => {
  assert.deepEqual(detectIntents("Show me the checkout funnel"), ["cart", "funnel"]);
});

test("routes revenue decline questions to revenue and diagnosis", () => {
  assert.deepEqual(detectIntents("Why has revenue dropped?"), ["revenue", "diagnostic"]);
});

test("returns no intent for an unrecognized question so the API can apply its fallback", () => {
  assert.deepEqual(detectIntents("Can you explain this?"), []);
});

test("normalizes punctuation and repeated whitespace", () => {
  assert.deepEqual(detectIntents("  HOW MUCH DID I MAKE?!  "), ["revenue"]);
});
