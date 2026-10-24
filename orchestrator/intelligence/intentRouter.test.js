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

test("routes greetings away from merchant analytics", () => {
  assert.deepEqual(detectIntents("Hello!"), ["greeting"]);
  assert.deepEqual(detectIntents("Good morning"), ["greeting"]);
});

test("routes gratitude away from merchant analytics", () => {
  assert.deepEqual(detectIntents("Thanks"), ["gratitude"]);
  assert.deepEqual(detectIntents("Thank you very much"), ["gratitude"]);
});

test("routes capability questions to a focused response", () => {
  assert.deepEqual(detectIntents("What can you do?"), ["capabilities"]);
  assert.deepEqual(detectIntents("How can you help me?"), ["capabilities"]);
});

test("keeps direct earnings questions focused when they include today", () => {
  assert.deepEqual(detectIntents("How much did I earn today?"), ["revenue"]);
  assert.deepEqual(detectIntents("How much have I earned today?"), ["revenue"]);
});

test("routes topic-specific decisions to knowledge-guided advice", () => {
  assert.deepEqual(detectIntents("Should I give customers a discount?"), ["advice"]);
  assert.deepEqual(detectIntents("How can I make my store more profitable?"), ["advice"]);
});

test("routes repeat-purchase improvement questions to knowledge-guided advice", () => {
  assert.deepEqual(detectIntents("How do I improve repeat purchases?"), ["advice"]);
});
