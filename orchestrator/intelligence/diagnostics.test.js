import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseSales } from "./diagnostics.js";

const baseEvidence = {
  purchases: 2,
  purchaseRevenue: 120,
  trafficBaseline: { status: "insufficient_history" },
  revenueBaseline: { status: "insufficient_history" },
  funnelBaseline: { status: "insufficient_history" },
};

test("does not invent a decline when comparable history is unavailable", () => {
  const answer = diagnoseSales(baseEvidence, { allowFallback: false });
  assert.equal(answer, null);
});

test("uses a measured traffic decline as evidence before discussing acquisition", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    trafficBaseline: { status: "below_baseline", currentSessions: 20, averageSessions: 80, daysWithTraffic: 5 },
  });
  assert.match(answer, /Fewer people are visiting your store than usual/i);
  assert.match(answer, /20 visits so far versus a same-time average of 80/i);
});

test("reports missing downstream events as an instrumentation uncertainty, not a proven funnel failure", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    funnelBaseline: { trackingValidationStages: ["productView"], lowStages: [] },
  });
  assert.match(answer, /could be a real drop-off or missing tracking/i);
  assert.match(answer, /event-delivery logs/i);
  assert.doesNotMatch(answer, /run a test purchase|run a test order/i);
});

test("prioritizes the most downstream confirmed funnel weakness", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    funnelBaseline: {
      status: "below_baseline",
      lowStages: ["productView", "addToCart", "checkout", "purchase"],
      current: { rates: { purchase: 0.1 } },
      averages: { purchase: 0.4 },
    },
  });
  assert.match(answer, /checkout-to-purchase completion/i);
  assert.match(answer, /10.0% versus 40.0%/i);
  assert.match(answer, /payment-provider failure logs/i);
});

test("does not recommend a test order when purchase tracking is unconfirmed", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    purchases: 0,
    revenueBaseline: { status: "purchase_tracking_unconfirmed" },
  });
  assert.match(answer, /no confirmed purchase event/i);
  assert.match(answer, /inspect purchase-event delivery and order records/i);
  assert.doesNotMatch(answer, /run a test order/i);
});

test("treats mismatched purchase and session records as a data-quality issue", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    revenueBaseline: { status: "purchase_summary_mismatch" },
  });
  assert.match(answer, /do not agree/i);
  assert.match(answer, /underlying purchase-event and session records/i);
  assert.doesNotMatch(answer, /run a test order/i);
});

test("does not invent zero revenue when revenue evidence is absent", () => {
  const answer = diagnoseSales({ ...baseEvidence, purchaseRevenue: null });
  assert.doesNotMatch(answer, /recorded purchase revenue is 0/i);
});
