import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://localhost/reden_test";

const {
  deriveBanditContext,
  eligibleBanditActions,
  sampleBeta,
  selectBanditAction,
} = await import("./banditEngine.js");

test("bandit context is stable and uses bounded behavioural buckets", () => {
  const key = deriveBanditContext({
    cart_value: 12000,
    behavior: { intent_score: 0.85, returning_customer: true },
  });
  assert.equal(key, "intent:high|cart:large|returning:yes");
});

test("strong purchase intent is not eligible for discount arms", () => {
  assert.deepEqual(
    eligibleBanditActions(5000, { intent_score: 0.85 }),
    ["NONE"],
  );
});

test("moderate intent only permits the low incentive", () => {
  assert.deepEqual(
    eligibleBanditActions(5000, { intent_score: 0.55 }),
    ["NONE", "INCENTIVE_LOW"],
  );
});

test("low intent receives only cart-value-eligible arms", () => {
  assert.deepEqual(
    eligibleBanditActions(1200, { intent_score: 0.15 }),
    ["NONE", "INCENTIVE_LOW", "INCENTIVE_MED", "INCENTIVE_HIGH"],
  );
});

test("zero cart value cannot select an incentive", () => {
  assert.deepEqual(eligibleBanditActions(0, { intent_score: 0.1 }), ["NONE"]);
  assert.equal(selectBanditAction({ actions: ["NONE"], random: () => 0.9 }), "NONE");
});

test("beta samples remain bounded probabilities", () => {
  for (let i = 0; i < 25; i++) {
    const value = sampleBeta(2, 5);
    assert.ok(value >= 0 && value <= 1);
  }
});
