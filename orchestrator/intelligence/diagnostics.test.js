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

test("is concise and gives a practical next step when history is insufficient", () => {
  const answer = diagnoseSales(baseEvidence);
  assert.match(answer, /cannot confirm a sales decline without comparable historical data/i);
  assert.match(answer, /if visits are down/i);
  assert.ok(answer.length < 500);
});

test("recommends acquisition checks when traffic is materially below its same-time baseline", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    trafficBaseline: { status: "below_baseline", currentSessions: 20, averageSessions: 80, daysWithTraffic: 5 },
  });
  assert.match(answer, /Fewer people are visiting your store than usual/i);
  assert.match(answer, /targeted campaign/i);
  assert.match(answer, /20 visits so far versus a same-time average of 80/i);
});

test("validates missing downstream instrumentation before recommending ads", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    trafficBaseline: { status: "below_baseline", currentSessions: 20, averageSessions: 80, daysWithTraffic: 5 },
    funnelBaseline: { trackingValidationStages: ["productView", "purchase"], lowStages: [] },
  });
  assert.match(answer, /no recorded product-page discovery events/i);
  assert.match(answer, /missing tracking/i);
  assert.match(answer, /before changing ads/i);
  assert.doesNotMatch(answer, /targeted campaign/i);
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
  assert.match(answer, /payment failures/i);
  assert.match(answer, /More advertising will not fix/i);
});

test("does not treat low funnel conversion as an advertising problem", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    funnelBaseline: { status: "below_baseline", lowStages: ["addToCart"] },
  });
  assert.match(answer, /product-to-cart progression/i);
  assert.match(answer, /verify ADD_TO_CART tracking/i);
  assert.match(answer, /More advertising will not fix/i);
});

test("reports revenue decline and separates order count from order value", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    revenueBaseline: { status: "below_baseline", currentRevenue: 120, averageRevenue: 500, daysWithComparablePurchases: 5 },
  });
  assert.match(answer, /purchase revenue is below its usual level/i);
  assert.match(answer, /120 recorded so far versus 500 in comparable periods/i);
  assert.match(answer, /purchase count and average order value/i);
});

test("recommends tracking verification when purchase events are absent", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    purchases: 0,
    revenueBaseline: { status: "purchase_tracking_unconfirmed" },
  });
  assert.match(answer, /no confirmed purchase event/i);
  assert.match(answer, /Run a test order first/i);
  assert.match(answer, /before increasing ad spend/i);
});

test("treats mismatched purchase and session records as a data-quality issue", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    revenueBaseline: { status: "purchase_summary_mismatch" },
  });
  assert.match(answer, /do not agree/i);
  assert.match(answer, /Run a test order/i);
});

test("when traffic is steady, prioritizes conversion checks over advertising", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    trafficBaseline: { status: "not_markedly_below_baseline" },
  });
  assert.match(answer, /Visits are not clearly below normal/i);
  assert.match(answer, /more advertising may not be the first fix/i);
});

test("does not claim that one purchase proves a decline or always recommends ads", () => {
  const answer = diagnoseSales({ ...baseEvidence, purchases: 1, purchaseRevenue: 925000 });
  assert.match(answer, /Only 1 purchase has been recorded/i);
  assert.match(answer, /cannot confirm a decline without a comparable purchase baseline/i);
  assert.match(answer, /Check product interest/i);
  assert.doesNotMatch(answer, /targeted campaign/i);
  assert.ok(answer.length < 500);
});

test("formats unavailable revenue without inventing zero revenue", () => {
  const answer = diagnoseSales({ ...baseEvidence, purchaseRevenue: null });
  assert.doesNotMatch(answer, /recorded purchase revenue is 0/i);
});
