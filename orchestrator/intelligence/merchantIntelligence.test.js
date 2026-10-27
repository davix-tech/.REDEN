import test from "node:test";
import assert from "node:assert/strict";
import { composeMerchantIntelligence } from "./merchantIntelligence.js";

test("intent response reports recent high-intent sessions without calling the score a probability", () => {
  const answer = composeMerchantIntelligence("intent_opportunities", {
    localDate: "2026-10-28",
    intentSummary: {
      recentSessions: 12,
      highIntentUnpurchased: 3,
      highIntentWithCart: 2,
      highIntentWithCheckout: 1,
      highIntentCartValue: 8400,
    },
  });
  assert.match(answer, /3 recently active, high-behavioural-intent session/);
  assert.match(answer, /not a calibrated probability/i);
  assert.match(answer, /discount is necessary/i);
});

test("intent response distinguishes no recent telemetry from no demand", () => {
  const answer = composeMerchantIntelligence("intent_opportunities", {
    intentSummary: { recentSessions: 0 },
  });
  assert.match(answer, /does not prove there are no shoppers/i);
  assert.match(answer, /tracking/i);
});

test("intervention response reports outcomes but refuses causal attribution", () => {
  const answer = composeMerchantIntelligence("intervention_effectiveness", {
    localDate: "2026-10-28",
    interventionOutcomes: [{
      action: "INCENTIVE_LOW",
      actioned: 10,
      completed: 8,
      conversions: 3,
      recordedRevenue: 15000,
    }],
  });
  assert.match(answer, /37.5% observed conversion/i);
  assert.match(answer, /not proof of incremental lift/i);
  assert.match(answer, /randomized holdout/i);
});

test("intervention response explains missing outcomes without treating them as failures", () => {
  const answer = composeMerchantIntelligence("intervention_effectiveness", {
    interventionOutcomes: [],
  });
  assert.match(answer, /not interpret missing outcomes as failed actions/i);
});

test("priority response selects instrumentation validation before business changes", () => {
  const answer = composeMerchantIntelligence("merchant_priority", {
    funnelBaseline: { trackingValidationStages: ["purchase"] },
  });
  assert.match(answer, /validate tracking at purchase/i);
  assert.match(answer, /before changing prices/i);
});

test("priority response does not invent an action when evidence is insufficient", () => {
  const answer = composeMerchantIntelligence("merchant_priority", {});
  assert.match(answer, /cannot responsibly identify a single highest-value action/i);
});

test("unknown merchant-intelligence intent returns null", () => {
  assert.equal(composeMerchantIntelligence("not-an-intent", {}), null);
});
