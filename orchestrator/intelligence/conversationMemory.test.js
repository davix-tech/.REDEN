import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseBusinessRedirectVariant,
  composeContextualFollowUp,
  detectFollowUpIntent,
  parseConversationIntents,
} from "./conversationMemory.js";

test("parses intent history from PostgreSQL arrays and JSON strings", () => {
  assert.deepEqual(parseConversationIntents(["revenue", "diagnostic"]), ["revenue", "diagnostic"]);
  assert.deepEqual(parseConversationIntents('["weekly_revenue"]'), ["weekly_revenue"]);
  assert.deepEqual(parseConversationIntents("invalid"), []);
});

test("uses the previous weekly sales turn to understand short follow-ups", () => {
  const previousTurn = {
    question: "How much did my store make this week?",
    answer: "Your store recorded sales this week.",
    intents: ["weekly_revenue"],
  };
  assert.deepEqual(detectFollowUpIntent("And last week?", previousTurn), ["weekly_revenue"]);
  assert.deepEqual(detectFollowUpIntent("What about today?", previousTurn), ["revenue"]);
  assert.deepEqual(detectFollowUpIntent("Why?", previousTurn), ["weekly_revenue", "diagnostic"]);
});

test("asks for the previous context when none is available", () => {
  assert.match(composeContextualFollowUp("Explain that", null), /repeat the part/i);
});

test("contextual clarification uses the previous answer and topic", () => {
  const answer = composeContextualFollowUp("Tell me more", {
    answer: "Recorded sales are 12% lower than last week. Check checkout completion.",
    intents: ["weekly_revenue"],
  });
  assert.match(answer, /week-to-date sales figures/i);
  assert.match(answer, /12% lower than last week/i);
});

test("business redirects rotate after a previous redirect", () => {
  const first = chooseBusinessRedirectVariant("Tell me a joke");
  const second = chooseBusinessRedirectVariant("Tell me a joke", [{ answer: first }]);
  assert.notEqual(first, second);
});
