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
