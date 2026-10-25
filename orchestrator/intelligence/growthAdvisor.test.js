import test from "node:test";
import assert from "node:assert/strict";
import { composeGrowthAdvice } from "./growthAdvisor.js";

test("growth advice prioritizes checkout friction when checkout events exist without purchases", () => {
  const answer = composeGrowthAdvice({ purchaseRevenue: 370000, purchases: 0, uniqueSessions: 80, productViews: 40, addToCart: 12, checkoutStarted: 5 });
  assert.match(answer, /370000\.00 in sales revenue/);
  assert.match(answer, /remove checkout friction/);
  assert.match(answer, /payment success\/failure/);
  assert.match(answer, /contribution profit/);
  assert.doesNotMatch(answer, /fewer than five of the previous seven days/);
});

test("growth advice prioritizes product-page improvements when product views have no cart events", () => {
  const answer = composeGrowthAdvice({ uniqueSessions: 30, productViews: 20, addToCart: 0, checkoutStarted: 0, purchases: 0, purchaseRevenue: 0 });
  assert.match(answer, /improve product-page purchase intent/);
  assert.match(answer, /delivery cost and timing/);
});

test("growth advice uses a safe baseline-first plan when no events exist", () => {
  const answer = composeGrowthAdvice({});
  assert.match(answer, /establish a trustworthy baseline/);
  assert.match(answer, /test purchase/);
  assert.match(answer, /cannot responsibly choose/);
});

test("growth advice never equates revenue with profit or promises uplift", () => {
  const answer = composeGrowthAdvice({ purchaseRevenue: 370000, purchases: 1 });
  assert.match(answer, /Revenue is not profit/);
  assert.match(answer, /until the comparison supports it/);
});


test("growth advice prioritizes a measured funnel regression over same-day heuristics", () => {
  const answer = composeGrowthAdvice({
    uniqueSessions: 100,
    productViews: 50,
    addToCart: 10,
    checkoutStarted: 8,
    purchases: 2,
    purchaseRevenue: 500,
    funnelBaseline: {
      status: "below_baseline",
      lowStages: ["checkout", "addToCart"],
      current: { rates: { checkout: 0.25, addToCart: 0.2 } },
      averages: { checkout: 0.6, addToCart: 0.35 }
    }
  });
  assert.match(answer, /investigate checkout completion/i);
  assert.match(answer, /25.0% versus a comparable baseline of 60.0%/);
  assert.match(answer, /payment errors/);
});


test("growth advice prioritizes a measured funnel regression over same-day heuristics", () => {
  const answer = composeGrowthAdvice({
    uniqueSessions: 100,
    productViews: 50,
    addToCart: 10,
    checkoutStarted: 8,
    purchases: 2,
    purchaseRevenue: 500,
    funnelBaseline: {
      status: "below_baseline",
      lowStages: ["checkout", "addToCart"],
      current: { rates: { checkout: 0.25, addToCart: 0.2 } },
      averages: { checkout: 0.6, addToCart: 0.35 }
    }
  });
  assert.match(answer, /investigate checkout completion/i);
  assert.match(answer, /25.0% versus a comparable baseline of 60.0%/);
  assert.match(answer, /payment failures/);
});
