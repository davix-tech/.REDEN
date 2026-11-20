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

test("does not mistake general who-questions for the connected store identity", () => {
  assert.deepEqual(detectIntents("Who won an event yesterday?"), []);
  assert.deepEqual(detectIntents("Who are you?"), ["reden_identity"]);
  assert.deepEqual(detectIntents("What is my store called?"), ["identity"]);
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

test("routes PRETHIM and simple assistant identity questions to reviewed knowledge", () => {
  assert.deepEqual(detectIntents("What is PRETHIM?"), ["prethim_identity"]);
  assert.deepEqual(detectIntents("What's PRETHIM?"), ["prethim_identity"]);
  assert.deepEqual(detectIntents("Tell me about PRETHIM"), ["prethim_identity"]);
  assert.deepEqual(detectIntents("What does PRETHIM do?"), ["prethim_identity"]);
  assert.deepEqual(detectIntents("Tell me your name"), ["reden_identity"]);
  assert.deepEqual(detectIntents("What does REDEN stand for?"), ["reden_identity"]);
  assert.deepEqual(detectIntents("What's your name?"), ["reden_identity"]);
  assert.deepEqual(detectIntents("How are you?"), ["greeting"]);
});

test("resolves short follow-up questions using the previous turn", () => {
  const weeklyTurn = {
    question: "How much did I make this week?",
    answer: "Your store recorded sales this week.",
    intents: ["weekly_revenue"],
  };
  assert.deepEqual(detectIntents("And last week?", weeklyTurn), ["weekly_revenue"]);
  assert.deepEqual(detectIntents("What about today?", weeklyTurn), ["revenue"]);
  assert.deepEqual(detectIntents("Why?", weeklyTurn), ["weekly_revenue", "diagnostic"]);
  assert.deepEqual(detectIntents("Tell me more", weeklyTurn), ["contextual_follow_up"]);
});

test("routes follow-up action requests to merchant prioritization", () => {
  const previousTurn = {
    question: "Why are sales down?",
    answer: "Recorded sales are below the recent baseline.",
    intents: ["diagnostic"],
  };
  assert.deepEqual(detectIntents("What should I do then?", previousTurn), ["merchant_priority"]);
  assert.deepEqual(detectIntents("How do I fix it?", previousTurn), ["merchant_priority"]);
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


test("routes specific REDEN sales-growth requests to the growth advisor", () => {
  assert.deepEqual(detectIntents("How can REDEN help me increase sales?"), ["growth"]);
  assert.deepEqual(detectIntents("How can REDEN help our store grow revenue?"), ["growth"]);
  assert.deepEqual(detectIntents("What can REDEN help me do?"), ["capabilities"]);
});


test("routes current purchase-intent opportunities to the dedicated handler", () => {
  assert.deepEqual(detectIntents("Which visitors are showing strong purchase intent right now?"), ["intent_opportunities"]);
  assert.deepEqual(detectIntents("Which lost revenue opportunities are realistically recoverable?"), ["intent_opportunities"]);
});

test("routes incrementality and intervention-effectiveness questions to the dedicated handler", () => {
  assert.deepEqual(detectIntents("Are REDEN's interventions actually generating extra sales?"), ["intervention_effectiveness"]);
  assert.deepEqual(detectIntents("Which discounts are driving incremental sales?"), ["intervention_effectiveness"]);
  assert.deepEqual(detectIntents("Would this customer have bought anyway?"), ["intervention_effectiveness"]);
});

test("routes next-best-action questions to evidence-aware prioritization", () => {
  assert.deepEqual(detectIntents("What is the best next action for my store?"), ["merchant_priority"]);
  assert.deepEqual(detectIntents("What single most valuable action should I take this week?"), ["merchant_priority"]);
});

test("keeps the purchase-intent definition in reviewed commerce knowledge", () => {
  assert.deepEqual(detectIntents("What is purchase intent?"), ["commerce_knowledge"]);
});

test("routes everyday sales and traffic wording through the language dictionary", () => {
  assert.deepEqual(detectIntents("How much cash from sales came in today?"), ["revenue"]);
  assert.deepEqual(detectIntents("How many people visited my store today?"), ["traffic", "overview"]);
});

test("routes store health and business growth questions to overview", () => {
  assert.deepEqual(detectIntents("How are things going with my store?"), ["overview"]);
  assert.deepEqual(detectIntents("Is my business growing?"), ["overview"]);
});

test("recognizes returning-customer questions as retention", () => {
  assert.deepEqual(detectIntents("Are customers coming back?"), ["retention"]);
  assert.deepEqual(detectIntents("How many returning customers do I have?"), ["retention"]);
  assert.deepEqual(detectIntents("Are customers returning to my website?"), ["retention"]);
});

test("recognizes cart abandonment inflections", () => {
  assert.deepEqual(detectIntents("How many customers abandoned their carts?"), ["cart"]);
  assert.deepEqual(detectIntents("Why are customers abandoning their carts?"), ["cart"]);
});

test("routes remaining merchant questions to existing intelligence handlers", () => {
  const cases = [
    ["What is happening in my store?", ["overview"]],
    ["What is going well in my business?", ["overview"]],
    ["How much are customers spending?", ["revenue"]],
    ["Which page gets the most attention?", ["traffic"]],
    ["Am I attracting the right customers?", ["traffic"]],
    ["What do customers do before buying?", ["diagnostic"]],
    ["What are customers struggling with?", ["diagnostic"]],
    ["What actions show that someone wants to buy?", ["intent_opportunities"]],
    ["What does customer activity tell us about my business?", ["overview"]],
    ["Is my store converting well?", ["conversion"]],
    ["Am I depending too much on new customers?", ["retention"]],
    ["Are customers responding to my offers?", ["bandit"]],
    ["Am I giving away too many discounts?", ["advice"]],
    ["What behaviour suggests someone is about to buy?", ["intent_opportunities"]],
    ["Can you identify potential buyers?", ["intent_opportunities"]],
    ["Why is my business not growing?", ["diagnostic"]],
    ["What is wrong with my store?", ["diagnostic"]],
    ["What is the biggest weakness in my store?", ["diagnostic"]],
    ["What opportunities am I missing?", ["intent_opportunities"]],
    ["Is my website helping customers buy?", ["diagnostic"]],
    ["Which pages might be confusing customers?", ["diagnostic"]],
    ["Are things looking good?", ["overview"]],
    ["Am I making progress?", ["overview"]],
    ["What do you think I should do about my store?", ["merchant_priority"]],
    ["What's moving in the store?", ["product_interest", "purchases"]],
    ["Do shoppers keep trying to buy the same item?", ["product_interest", "purchases"]],
    ["Are my discounts eating into my margins?", ["advice"]],
    ["Are my prices too low?", ["advice"]],
    ["Am I actually making a profit?", ["advice"]],
    ["What questions might customers have before buying?", ["advice"]],
    ["What can I learn from repeated visits?", ["retention"]],
    ["What might make customers trust my store more?", ["advice"]],
    ["What has declined recently?", ["diagnostic"]],
  ];

  for (const [question, expected] of cases) {
    assert.deepEqual(detectIntents(question), expected, question);
  }
});


test("recognizes informal store-health and earnings wording", () => {
  for (const question of ["How is business?", "How's business?", "How is the store?", "How's my shop?"]) {
    assert.deepEqual(detectIntents(question), ["overview"], question);
  }
  for (const question of ["What's happening in the store?", "What's going on with my business?", "What is happening in my shop?"]) {
    assert.deepEqual(detectIntents(question), ["overview"], question);
  }
  for (const question of ["How much is earnings?", "What are my earnings?", "How much income did my store make?"]) {
    assert.deepEqual(detectIntents(question), ["revenue"], question);
  }
});
