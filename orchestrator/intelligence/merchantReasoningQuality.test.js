import test from "node:test";
import assert from "node:assert/strict";
import { detectIntents } from "./intentRouter.js";
import { resolveReasoningIntents, composeReasonedResponse } from "./reasoningLayer.js";
import { diagnoseSales } from "./diagnostics.js";
import { composeMerchantIntelligence } from "./merchantIntelligence.js";
import { composeStoreOverview } from "./storeOverview.js";

const probes = [
  {
    id: "plain-language-no-sales",
    question: "Nobody is buying even though people visit",
    expected: ["diagnostic", "traffic", "purchases"],
  },
  {
    id: "checkout-dropoff",
    question: "Why are shoppers leaving before paying?",
    expected: ["diagnostic", "cart", "funnel"],
  },
  {
    id: "product-performance",
    question: "Which products are performing best?",
    expected: ["product_interest", "purchases"],
  },
  {
    id: "buyer-growth",
    question: "How do I bring in more buyers?",
    expected: ["growth", "traffic", "conversion"],
  },
  {
    id: "store-health",
    question: "How are things going with my store?",
    expected: ["overview"],
  },
  {
    id: "business-growth",
    question: "Is my business growing?",
    expected: ["overview"],
  },
  {
    id: "retention",
    question: "Are customers coming back?",
    expected: ["retention"],
  },
  {
    id: "cart-abandonment",
    question: "How many customers abandoned their carts?",
    expected: ["cart"],
  },
];

test("reasoning probes report expected-intent mismatches instead of treating any intent as success", () => {
  const results = probes.map((probe) => {
    const detected = detectIntents(probe.question);
    const resolved = resolveReasoningIntents(probe.question, detected);
    const missing = probe.expected.filter((intent) => !resolved.includes(intent));
    return { ...probe, detected, resolved, missing, correct: missing.length === 0 };
  });
  const passed = results.filter((row) => row.correct).length;
  const mismatches = results.filter((row) => !row.correct);

  console.log("\n[REDEN REASONING QUALITY]");
  console.log(JSON.stringify({
    total: results.length,
    expectedIntentMatches: passed,
    mismatches: mismatches.length,
    matchPercent: Number((passed / results.length * 100).toFixed(1)),
    mismatches: mismatches.map(({ id, question, expected, detected, resolved, missing }) => ({
      id, question, expected, detected, resolved, missing,
    })),
  }, null, 2));

  assert.equal(results.length, probes.length);
});

test("diagnosis distinguishes a measured traffic decline from an unproven cause", () => {
  const answer = diagnoseSales({
    purchases: 4,
    purchaseRevenue: 12000,
    trafficBaseline: {
      status: "below_baseline",
      currentSessions: 20,
      averageSessions: 80,
      daysWithTraffic: 6,
    },
    revenueBaseline: { status: "insufficient_history" },
    funnelBaseline: { status: "insufficient_history" },
  });

  assert.match(answer, /Fewer people are visiting your store than usual/i);
  assert.match(answer, /20 visits so far versus a same-time average of 80/i);
  assert.doesNotMatch(answer, /the cause is definitely/i);
});

test("diagnosis prioritizes tracking uncertainty over assuming shoppers abandoned", () => {
  const answer = diagnoseSales({
    purchases: 0,
    purchaseRevenue: null,
    trafficBaseline: { status: "insufficient_history" },
    revenueBaseline: { status: "insufficient_history" },
    funnelBaseline: {
      trackingValidationStages: ["purchase"],
      lowStages: [],
    },
  });

  assert.match(answer, /could be a real drop-off or missing tracking/i);
  assert.match(answer, /verify/i);
  assert.doesNotMatch(answer, /customers abandoned because/i);
});

test("merchant priority refuses to invent a best action without evidence", () => {
  const answer = composeMerchantIntelligence("merchant_priority", {});
  assert.match(answer, /cannot responsibly identify a single highest-value action/i);
  assert.match(answer, /Missing evidence should not be replaced with a guessed recommendation/i);
});

test("overview does not turn missing purchase amounts into zero revenue or profit", () => {
  const answer = composeStoreOverview({
    period: "today",
    uniqueSessions: 8,
    totalEvents: 24,
    pageViews: 12,
    productViews: 6,
    addToCart: 3,
    checkoutStarted: 2,
    purchases: 1,
    purchaseRecords: 1,
    identifiedOrders: 1,
    pricedPurchaseRecords: 0,
    unidentifiedPurchaseEvents: 0,
    purchaseRevenue: 0,
    purchaseRevenueAvailable: false,
    decisions: 0,
    conversions: 0,
    productPerformance: [],
    trafficBaseline: { status: "insufficient_history", daysWithTraffic: 0 },
    revenueBaseline: { status: "insufficient_history", daysWithComparablePurchases: 0 },
    funnelBaseline: { status: "insufficient_history", lowStages: [] },
    attribution: [],
    customerIntelligence: {
      identifiedCustomers: 0,
      returningCustomers: 0,
      firstTimeIdentifiedCustomers: 0,
    },
  });

  assert.match(answer, /1 PURCHASE event/i);
  assert.match(answer, /purchase revenue could not be reliably calculated/i);
  assert.doesNotMatch(answer, /recorded storefront purchase revenue 0/i);
  assert.doesNotMatch(answer, /profit is 0/i);
});

test("response composer keeps evidence separate from the recommended action", () => {
  const answer = composeReasonedResponse({
    question: "How are sales and what should I do?",
    intents: ["revenue", "merchant_priority"],
    sections: [
      "Your store recorded 4 purchases.",
      "First priority: verify purchase tracking before changing prices.",
    ],
  });

  assert.match(answer, /Here's the picture from your store data/i);
  assert.match(answer, /Your store recorded 4 purchases/i);
  assert.match(answer, /What I recommend/i);
  assert.match(answer, /verify purchase tracking/i);
});
