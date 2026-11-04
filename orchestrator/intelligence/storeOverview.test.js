import test from "node:test";
import assert from "node:assert/strict";
import { composeStoreOverview } from "./storeOverview.js";

const base = {
  uniqueSessions: 1,
  totalEvents: 21,
  pageViews: 5,
  productViews: 4,
  addToCart: 3,
  checkoutStarted: 2,
  purchases: 2,
  purchaseRevenue: 370000,
  purchaseRevenueAvailable: true,
  decisions: 0,
  conversions: 0,
  trafficBaseline: { status: "insufficient_history" },
  revenueBaseline: { status: "insufficient_history" },
  funnelBaseline: { status: "insufficient_history", daysWithTraffic: 0 },
};

test("overview interprets small samples and flags purchase-event/order reconciliation", () => {
  const answer = composeStoreOverview(base);
  assert.match(answer, /1 unique session/i);
  assert.match(answer, /2 PURCHASE event/);
  assert.match(answer, /Verify unique order IDs/);
  assert.match(answer, /not enough reliable historical traffic/i);
  assert.match(answer, /decision conversion rate is unavailable/i);
  assert.match(answer, /not profit/i);
});

test("overview prioritizes a funnel stage below historical baseline", () => {
  const answer = composeStoreOverview({
    ...base,
    uniqueSessions: 80,
    purchases: 4,
    decisions: 3,
    conversions: 1,
    trafficBaseline: { status: "not_markedly_below_baseline", currentSessions: 80, averageSessions: 75, daysWithTraffic: 6 },
    revenueBaseline: { status: "below_baseline", currentRevenue: 10000, averageRevenue: 25000, daysWithComparablePurchases: 6 },
    funnelBaseline: {
      status: "below_baseline",
      daysWithTraffic: 6,
      current: { rates: { productView: 0.7, addToCart: 0.1, checkout: 0.4, purchase: 0.5 } },
      averages: { productView: 0.75, addToCart: 0.3, checkout: 0.5, purchase: 0.6 },
      lowStages: ["addToCart"],
      trackingValidationStages: [],
    },
  });
  assert.match(answer, /add-to-cart rate: 10.0% versus 30.0%/);
  assert.match(answer, /Investigate product-to-cart progression/);
  assert.match(answer, /below the same-time historical average/);
});

test("overview prioritizes instrumentation validation over commercial interventions", () => {
  const answer = composeStoreOverview({
    ...base,
    uniqueSessions: 20,
    trafficBaseline: { status: "below_baseline", currentSessions: 20, averageSessions: 60, daysWithTraffic: 6 },
    funnelBaseline: {
      status: "available",
      daysWithTraffic: 6,
      current: { rates: {} },
      averages: { purchase: 0.2 },
      lowStages: [],
      trackingValidationStages: ["purchase"],
    },
  });
  assert.match(answer, /Verify checkout completion tracking first/);
  assert.match(answer, /real drop-off or missing instrumentation/);
});

test("overview does not call purchase events unique orders", () => {
  const answer = composeStoreOverview({ ...base, purchases: 1, uniqueSessions: 4 });
  assert.doesNotMatch(answer, /1 orders/);
  assert.match(answer, /purchase event/);
});
