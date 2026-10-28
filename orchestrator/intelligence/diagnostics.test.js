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

test("gives a concise practical recommendation when comparable evidence is insufficient", () => {
  const answer = diagnoseSales(baseEvidence);
  assert.match(answer, /cannot confirm a decline without comparable historical data/i);
  assert.match(answer, /advertising or conversion/i);
  assert.ok(answer.length < 500, "merchant answer should stay concise");
});

test("recommends advertising review when traffic is below baseline", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    trafficBaseline: { status: "below_baseline", currentSessions: 20, averageSessions: 80, daysWithTraffic: 5 },
  });
  assert.match(answer, /Fewer people are visiting your store than usual/i);
  assert.match(answer, /targeted campaign/i);
});

test("does not treat low funnel conversion as an advertising problem by default", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    funnelBaseline: { status: "below_baseline", lowStages: ["addToCart"] },
  });
  assert.match(answer, /add-to-cart activity/i);
  assert.match(answer, /More advertising may bring visitors, but it will not fix a weak conversion step/i);
});

test("reports revenue below baseline and suggests the next useful distinction", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    revenueBaseline: { status: "below_baseline", currentRevenue: 120, averageRevenue: 500, daysWithComparablePurchases: 5 },
  });
  assert.match(answer, /Sales revenue is below your usual level/i);
  assert.match(answer, /purchase count or average order value/i);
});

test("recommends tracking verification when purchase events are absent", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    purchases: 0,
    revenueBaseline: { status: "purchase_tracking_unconfirmed" },
  });
  assert.match(answer, /No purchase has been recorded/i);
  assert.match(answer, /Verify tracking with a test order/i);
});

test("when traffic is steady, prioritizes conversion checks over more advertising", () => {
  const answer = diagnoseSales({
    ...baseEvidence,
    trafficBaseline: { status: "not_markedly_below_baseline" },
  });
  assert.match(answer, /Visits are not clearly below normal/i);
  assert.match(answer, /more advertising may not be the first fix/i);
});
