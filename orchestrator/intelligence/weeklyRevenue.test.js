import test from "node:test";
import assert from "node:assert/strict";
import { composeWeeklyRevenue } from "./weeklyRevenue.js";

test("reports week-to-date recorded sales and distinguishes revenue from profit", () => {
  const answer = composeWeeklyRevenue({
    available: true,
    periodLabel: "Monday through Wednesday",
    visits: 120,
    purchases: 6,
    purchasingSessions: 6,
    revenue: 45000,
    revenueAvailable: true,
    previous: {
      revenue: 30000,
      revenueAvailable: true,
    },
  });
  assert.match(answer, /45,000\.00 in sales/i);
  assert.match(answer, /not profit/i);
  assert.match(answer, /5\.0%/);
  assert.match(answer, /higher by 50\.0%/i);
});

test("does not turn missing order amounts into zero revenue", () => {
  const answer = composeWeeklyRevenue({
    available: true,
    visits: 20,
    purchases: 2,
    revenue: 0,
    revenueAvailable: false,
  });
  assert.match(answer, /do not include usable order amounts/i);
  assert.doesNotMatch(answer, /0\.00 in sales/i);
});

test("handles missing data without inventing a weekly total", () => {
  const answer = composeWeeklyRevenue({ available: false });
  assert.match(answer, /could not retrieve reliable store activity/i);
});

test("does not calculate a percentage comparison against zero prior sales", () => {
  const answer = composeWeeklyRevenue({
    available: true,
    visits: 20,
    purchases: 2,
    revenue: 10000,
    revenueAvailable: true,
    previous: { revenue: 0, revenueAvailable: true },
  });
  assert.match(answer, /percentage change cannot be calculated/i);
});
