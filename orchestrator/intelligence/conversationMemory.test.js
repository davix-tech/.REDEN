import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseBusinessRedirectVariant,
  composeContextualFollowUp,
  detectFollowUpIntent,
  parseConversationIntents,
  selectContextTurn,
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
  assert.deepEqual(detectFollowUpIntent("What does that mean?", previousTurn), ["contextual_follow_up"]);
  assert.deepEqual(detectFollowUpIntent("What about it?", previousTurn), ["contextual_follow_up"]);
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

test("why and cause follow-ups preserve cart and retention topics", () => {
  assert.deepEqual(detectFollowUpIntent("Why?", {
    question: "Are customers coming back?",
    answer: "Returning-customer evidence is limited.",
    intents: ["retention"],
  }), ["diagnostic", "retention"]);
  assert.deepEqual(detectFollowUpIntent("What caused that?", {
    question: "How many customers abandoned their carts?",
    answer: "Recorded cart abandonment events were found.",
    intents: ["cart"],
  }), ["diagnostic", "cart"]);
});

test("why after product performance does not become a revenue diagnosis", () => {
  assert.equal(detectFollowUpIntent("Why?", {
    question: "Which products are performing best?",
    answer: "These products have the strongest recorded activity.",
    intents: ["product_interest", "purchases"],
  }), null);
});

test("handles contextual merchant follow-ups only with relevant prior turns", () => {
  const revenueTurn = {
    question: "How much revenue came in today?",
    answer: "Your store recorded 12,000 in sales.",
    intents: ["revenue"],
  };
  const weeklyTurn = {
    question: "How much did my store make this week?",
    answer: "Your store recorded week-to-date sales.",
    intents: ["weekly_revenue"],
  };
  const diagnosticTurn = {
    question: "Why are sales down?",
    answer: "Recorded purchases are below the recent baseline.",
    intents: ["diagnostic", "purchases"],
  };

  assert.deepEqual(detectFollowUpIntent("Why?", revenueTurn), ["diagnostic", "revenue"]);
  assert.deepEqual(detectFollowUpIntent("What caused that?", revenueTurn), ["diagnostic", "revenue"]);
  assert.deepEqual(detectFollowUpIntent("What should I do then?", diagnosticTurn), ["merchant_priority"]);
  assert.deepEqual(detectFollowUpIntent("Can you explain that more simply?", revenueTurn), ["contextual_follow_up"]);
  assert.deepEqual(detectFollowUpIntent("Is that good or bad?", revenueTurn), ["contextual_follow_up"]);
  assert.deepEqual(detectFollowUpIntent("How can I fix it?", diagnosticTurn), ["merchant_priority"]);
  assert.deepEqual(detectFollowUpIntent("What does that mean for my business?", revenueTurn), ["contextual_follow_up"]);
  assert.deepEqual(detectFollowUpIntent("Can you compare that with last week?", weeklyTurn), ["weekly_revenue"]);
  assert.deepEqual(detectFollowUpIntent("Which one should I deal with first?", diagnosticTurn), ["merchant_priority"]);
  assert.equal(detectFollowUpIntent("What about yesterday?", revenueTurn), null);
});


test("selects the last substantive turn instead of a generic follow-up reply", () => {
  const history = [
    { question: "Explain that simply.", answer: "Plain explanation.", intents: ["contextual_follow_up"] },
    { question: "Why?", answer: "Diagnosis based on recorded data.", intents: ["diagnostic", "revenue"] },
    { question: "How much have I made?", answer: "Recorded sales.", intents: ["revenue"] },
  ];
  assert.equal(selectContextTurn("Why should I do that?", history), history[1]);
  assert.equal(selectContextTurn("Explain that simply.", history), history[1]);
});

test("does not unnecessarily anchor a clear new topic to older context", () => {
  const history = [{ question: "Why?", answer: "Sales explanation.", intents: ["diagnostic", "revenue"] }];
  assert.equal(selectContextTurn("Which products are performing best?", history), history[0]);
});
