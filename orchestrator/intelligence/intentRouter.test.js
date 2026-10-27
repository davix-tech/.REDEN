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

test("routes open-ended earn-more questions to a growth plan", () => {
  assert.deepEqual(detectIntents("How could we earn more?"), ["growth"]);
  assert.deepEqual(detectIntents("How can we make more money?"), ["growth"]);
  assert.deepEqual(detectIntents("How do I increase sales?"), ["growth"]);
});


test("routes REDEN identity questions separately from merchant-store identity", () => {
  assert.deepEqual(detectIntents("What is your name?"), ["reden_identity"]);
  assert.deepEqual(detectIntents("Who are you?"), ["reden_identity"]);
  assert.deepEqual(detectIntents("What is REDEN?"), ["reden_identity"]);
  assert.deepEqual(detectIntents("Who built you?"), ["reden_identity"]);
  assert.deepEqual(detectIntents("What is my store called?"), ["identity"]);
});

test("routes basic e-commerce definitions to reviewed knowledge", () => {
  assert.deepEqual(detectIntents("What is conversion rate?"), ["commerce_knowledge"]);
  assert.deepEqual(detectIntents("Explain purchase intent"), ["commerce_knowledge"]);
  assert.deepEqual(detectIntents("What is an abandoned cart?"), ["commerce_knowledge"]);
  assert.deepEqual(detectIntents("What is average order value?"), ["commerce_knowledge"]);
});


test("routes REDEN product-value questions to capabilities, not merchant metrics", () => {
  assert.deepEqual(detectIntents("What can REDEN help me do?"), ["capabilities"]);
  assert.deepEqual(detectIntents("How is REDEN different from a cart recovery tool?"), ["capabilities"]);
  assert.deepEqual(detectIntents("Why use REDEN instead of another email sending tool?"), ["capabilities"]);
});


test("routes REDEN value questions through the capability answer", () => {
  assert.deepEqual(detectIntents("What can REDEN help me do?"), ["capabilities"]);
  assert.deepEqual(detectIntents("How is REDEN different from a cart recovery tool?"), ["capabilities"]);
  assert.deepEqual(detectIntents("Why use REDEN instead of another email sending tool?"), ["capabilities"]);
});


test("routes merchant loss and priority questions to diagnosis before generic metrics", () => {
  assert.deepEqual(detectIntents("Where am I losing sales?"), ["diagnostic"]);
  assert.deepEqual(detectIntents("What is stopping sales?"), ["diagnostic"]);
  assert.deepEqual(detectIntents("What should I fix first?"), ["diagnostic"]);
  assert.deepEqual(detectIntents("Where should we focus?"), ["diagnostic"]);
});


test("routes REDEN value questions to the capability explanation", () => {
  assert.deepEqual(detectIntents("What can REDEN help me do?"), ["capabilities"]);
  assert.deepEqual(detectIntents("How is REDEN different from a cart recovery tool?"), ["capabilities"]);
  assert.deepEqual(detectIntents("Why use REDEN instead of another email sending tool?"), ["capabilities"]);
});
