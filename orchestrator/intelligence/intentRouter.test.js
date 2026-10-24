import test from "node:test";
import assert from "node:assert/strict";
import { detectIntents } from "./intentRouter.js";

test("routes plain-language earnings question to revenue only", () => {
  assert.deepEqual(detectIntents("How much did I make?"), ["revenue"]);
});

test("prioritizes diagnosis instead of returning only a generic sales summary", () => {
  assert.deepEqual(detectIntents("Why are sales down?"), ["diagnostic"]);
});

test("routes funnel questions to funnel analysis", () => {
  assert.deepEqual(detectIntents("Show me the checkout funnel"), ["cart", "funnel"]);
});

test("routes revenue decline questions to revenue and diagnosis", () => {
  assert.deepEqual(detectIntents("Why has revenue dropped?"), ["diagnostic", "revenue"]);
});

test("returns no intent for an unrecognized question so the API can apply its fallback", () => {
  assert.deepEqual(detectIntents("Can you explain this?"), []);
});

test("normalizes punctuation and repeated whitespace", () => {
  assert.deepEqual(detectIntents("  HOW MUCH DID I MAKE?!  "), ["revenue"]);
});


test("keeps a simple earnings question focused when it includes today", () => {
  assert.deepEqual(detectIntents("How much did I earn today?"), ["revenue"]);
});
