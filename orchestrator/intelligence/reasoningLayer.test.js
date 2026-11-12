import test from "node:test";
import assert from "node:assert/strict";
import { composeReasonedResponse, resolveReasoningIntents } from "./reasoningLayer.js";

test("understands merchant meaning expressed without analytics keywords", () => {
  assert.deepEqual(
    resolveReasoningIntents("Nobody is buying even though people visit"),
    ["diagnostic", "traffic", "purchases"]
  );
});

test("recognises shoppers leaving before payment as funnel and checkout diagnosis", () => {
  assert.deepEqual(
    resolveReasoningIntents("Why are shoppers leaving before paying?"),
    ["diagnostic", "cart", "funnel"]
  );
});

test("combines product performance and purchase questions", () => {
  assert.deepEqual(
    resolveReasoningIntents("Which products are performing best?"),
    ["product_interest", "purchases"]
  );
});

test("resolves a contextual why follow-up from the previous commerce topic", () => {
  assert.deepEqual(
    resolveReasoningIntents("And why?", [], {
      question: "How much did I make today?",
      answer: "Your store recorded sales.",
      intents: ["revenue"],
    }),
    ["diagnostic", "revenue"]
  );
});

test("resolves follow-up advice without losing the previous conversation", () => {
  assert.deepEqual(
    resolveReasoningIntents("How do I fix that?", [], {
      question: "Why are sales down?",
      answer: "Recorded purchases are below baseline.",
      intents: ["diagnostic", "purchases"],
    }),
    ["merchant_priority"]
  );
});

test("combines evidence and action sections without fabricating a conclusion", () => {
  const answer = composeReasonedResponse({
    question: "How are sales and traffic, and what should I do?",
    intents: ["traffic", "revenue", "merchant_priority"],
    sections: [
      "REDEN recorded 20 visits today.",
      "Recorded sales were 10,000 today.",
      "Verify tracking, then inspect the traffic source before changing spend.",
    ],
  });
  assert.match(answer, /Here's the picture from your store data/);
  assert.match(answer, /What I recommend/);
  assert.match(answer, /10,000/);
  assert.match(answer, /Verify tracking/);
});

test("deduplicates repeated sections and admits when evidence is unavailable", () => {
  assert.equal(
    composeReasonedResponse({ sections: ["Same evidence.", "Same evidence."] }),
    "Same evidence."
  );
  assert.match(composeReasonedResponse({ sections: [] }), /don't have enough reliable store evidence/);
});


test("understands everyday descriptions of store performance without analytics terms", () => {
  assert.deepEqual(
    resolveReasoningIntents("My shop is busy but nobody is buying"),
    ["diagnostic", "traffic", "purchases"]
  );
  assert.deepEqual(
    resolveReasoningIntents("People look at products but don't put anything in the basket"),
    ["diagnostic", "product_interest", "cart"]
  );
});

test("understands checkout drop-off described as shoppers disappearing before payment", () => {
  assert.deepEqual(
    resolveReasoningIntents("People add items to their basket then disappear before paying"),
    ["diagnostic", "cart", "funnel"]
  );
});

test("understands product demand and customer acquisition in ordinary language", () => {
  assert.deepEqual(
    resolveReasoningIntents("Which items are moving fastest?"),
    ["product_interest", "purchases"]
  );
  assert.deepEqual(
    resolveReasoningIntents("How do I bring in more buyers?"),
    ["growth", "traffic", "conversion"]
  );
});
