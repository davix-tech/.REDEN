import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseSales } from "./diagnostics.js";

const baseEvidence = {
  purchases: 2,
  purchaseRevenue: 120,
  checkoutStarted: 5,
  trafficBaseline: { status: "insufficient_history" },
  revenueBaseline: { status: "insufficient_history" },
  funnelBaseline: { status: "insufficient_history" },
};

test("does not claim a cause when historical evidence is insufficient", () => {
  const answer = diagnoseSales(baseEvidence);
  assert.match(answer, /cannot yet confirm why sales are down/i);
  assert.match(answer, /historical revenue and funnel comparisons/i);
  assert.doesNotMatch(answer, /sales are down because/i);
});

test("reports revenue below baseline as an observation, not a cause", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    revenueBaseline: {
      status: "below_baseline",
      currentRevenue: 120,
      averageRevenue: 500,
      daysWithComparablePurchases: 5,
    },
  });
  assert.match(answer, /materially below the recent comparable baseline/i);
  assert.match(answer, /not proof of its cause/i);
});

test("recommends tracking verification when current purchase events are absent", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    purchases: 0,
    revenueBaseline: { status: "purchase_tracking_unconfirmed" },
  });
  assert.match(answer, /no PURCHASE event is recorded/i);
  assert.match(answer, /test purchase/i);
});

test("describes weak funnel rates using session-level evidence", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    funnelBaseline: {
      status: "below_baseline",
      current: { rates: { addToCart: 0.1 } },
      averages: { addToCart: 0.4 },
      lowStages: ["addToCart"],
    },
  });
  assert.match(answer, /add-to-cart sessions are 10.0%/i);
  assert.match(answer, /not proof of a single underlying cause/i);
});
