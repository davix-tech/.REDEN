import test from "node:test";
import assert from "node:assert/strict";
import { detectIntents } from "./intentRouter.js";
import { resolveReasoningIntents } from "./reasoningLayer.js";

function ask(question, previousTurn = null) {
  const detected = detectIntents(question, previousTurn);
  const intents = resolveReasoningIntents(question, detected, previousTurn);
  return {
    question,
    answer: `Test evidence for: ${question}`,
    intents,
  };
}

function runConversation(turns) {
  const transcript = [];
  let previousTurn = null;

  for (const turn of turns) {
    const result = ask(turn.question, previousTurn);
    const missing = (turn.expected ?? []).filter((intent) => !result.intents.includes(intent));
    transcript.push({
      question: turn.question,
      expected: turn.expected ?? [],
      actual: result.intents,
      missing,
      matched: missing.length === 0,
    });
    previousTurn = result;
  }

  return transcript;
}

const conversations = [
  {
    id: "weekly-sales-investigation",
    turns: [
      { question: "How much did my store make this week?", expected: ["weekly_revenue"] },
      { question: "Why?", expected: ["weekly_revenue", "diagnostic"] },
      { question: "What should I do now?", expected: ["merchant_priority"] },
    ],
  },
  {
    id: "vague-reference-follow-up",
    turns: [
      { question: "How much revenue came in today?", expected: ["revenue"] },
      { question: "What about that?", expected: ["contextual_follow_up"] },
    ],
  },
  {
    id: "period-comparison",
    turns: [
      { question: "How much did my store make this week?", expected: ["weekly_revenue"] },
      { question: "And last week?", expected: ["weekly_revenue"] },
      { question: "Can you compare that with last week?", expected: ["weekly_revenue"] },
    ],
  },
  {
    id: "topic-switch-and-follow-up",
    turns: [
      { question: "How much revenue came in today?", expected: ["revenue"] },
      { question: "Which products are performing best?", expected: ["product_interest", "purchases"] },
      { question: "Why?", expected: ["contextual_follow_up"] },
    ],
  },
  {
    id: "retention-investigation",
    turns: [
      { question: "Are customers coming back?", expected: ["retention"] },
      { question: "Why?", expected: ["diagnostic", "retention"] },
      { question: "What should I do about it?", expected: ["merchant_priority"] },
    ],
  },
  {
    id: "cart-abandonment-investigation",
    turns: [
      { question: "How many customers abandoned their carts?", expected: ["cart"] },
      { question: "What caused that?", expected: ["diagnostic", "cart"] },
      { question: "How do I fix that?", expected: ["merchant_priority"] },
    ],
  },
];

test("known multi-turn paths preserve the expected context across a conversation", () => {
  const result = runConversation(conversations[0].turns);
  assert.deepEqual(result.map((turn) => turn.matched), [true, true, true]);
});

test("weekly period follow-ups retain the weekly revenue context", () => {
  const result = runConversation(conversations[2].turns);
  assert.deepEqual(result.map((turn) => turn.matched), [true, true, true]);
});

test("vague follow-ups are tied to the immediately preceding answer", () => {
  const result = runConversation(conversations[1].turns);
  assert.deepEqual(result.map((turn) => turn.matched), [true, true]);
});

test("topic changes do not inherit unrelated intents from the previous turn", () => {
  const result = runConversation(conversations[3].turns);
  assert.deepEqual(result[1].actual, ["product_interest", "purchases"]);
  assert.deepEqual(result[2].actual, ["contextual_follow_up"]);
});

test("full conversation diagnostics report unsupported continuity instead of hiding it", () => {
  const results = conversations.map((conversation) => {
    const transcript = runConversation(conversation.turns);
    const failedTurns = transcript.filter((turn) => !turn.matched);
    return {
      id: conversation.id,
      turns: transcript.length,
      matchedTurns: transcript.length - failedTurns.length,
      mismatches: failedTurns,
    };
  });
  const totalTurns = results.reduce((sum, item) => sum + item.turns, 0);
  const matchedTurns = results.reduce((sum, item) => sum + item.matchedTurns, 0);
  const mismatches = results.flatMap((item) =>
    item.mismatches.map((mismatch) => ({ conversation: item.id, ...mismatch }))
  );

  console.log("\\n[REDEN MULTI-TURN CONVERSATION QUALITY]");
  console.log(JSON.stringify({
    conversations: results.length,
    totalTurns,
    matchedTurns,
    mismatchedTurns: mismatches.length,
    matchPercent: Number((matchedTurns / totalTurns * 100).toFixed(1)),
    conversations: results,
  }, null, 2));

  assert.equal(results.length, conversations.length);
  assert.equal(totalTurns, conversations.reduce((sum, item) => sum + item.turns.length, 0));
});
