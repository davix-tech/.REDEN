import test from "node:test";
import assert from "node:assert/strict";
import { composeGrowthAdvice } from "./growthAdvisor.js";

test("does not prescribe a store-specific intervention without a supported diagnosis", () => {
  const answer = composeGrowthAdvice({});
  assert.match(answer, /sufficiently supported diagnosis or comparable historical baseline/i);
  assert.doesNotMatch(answer, /run a test purchase|run a test order|offer a discount|launch a campaign/i);
});

test("reports recorded revenue and purchase count without calling revenue profit", () => {
  const answer = composeGrowthAdvice({ purchaseRevenue: 370000, purchases: 2 });
  assert.match(answer, /370,000 in purchase revenue from 2 purchase event/i);
  assert.match(answer, /Revenue is not profit/i);
});

test("uses a measured funnel regression as the basis for a recommendation", () => {
  const answer = composeGrowthAdvice({
    purchases: 2,
    purchaseRevenue: 500,
    funnelBaseline: {
      status: "below_baseline",
      lowStages: ["checkout"],
      current: { rates: { checkout: 0.25 } },
      averages: { checkout: 0.6 }
    }
  });
  assert.match(answer, /Evidence-backed priority/i);
  assert.match(answer, /cart-to-checkout progression/i);
  assert.match(answer, /25.0% versus 60.0% in comparable periods/);
});

test("does not convert small same-day samples into arbitrary commercial advice", () => {
  const answer = composeGrowthAdvice({
    uniqueSessions: 30,
    productViews: 20,
    addToCart: 0,
    checkoutStarted: 0,
    purchases: 0,
    purchaseRevenue: 0
  });
  assert.match(answer, /do not establish which intervention will improve sales/i);
  assert.doesNotMatch(answer, /improve product-page purchase intent|test a relevant product bundle/i);
});


test("does not report missing purchase revenue as zero", () => {
  const answer = composeGrowthAdvice({ purchases: 2, purchaseRevenue: null });
  assert.match(answer, /2 purchase event/i);
  assert.match(answer, /purchase revenue is unavailable/i);
  assert.doesNotMatch(answer, /purchase revenue is 0/i);
});
