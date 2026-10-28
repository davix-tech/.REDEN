import test from "node:test";
import assert from "node:assert/strict";
import { applyIntelligenceAnswerContract } from "./answerContract.js";

test("purchase-intent answer includes evidence, confidence, limits, action, and reassessment criteria", () => {
  const answer = applyIntelligenceAnswerContract(
    "REDEN recorded 3 high-intent sessions.",
    ["intent_opportunities"],
    {
      intentSummary: {
        windowMinutes: 30,
        recentSessions: 12,
        highIntentUnpurchased: 3,
        highIntentWithCart: 2,
        highIntentWithCheckout: 1,
        scoreType: "behavioural_heuristic",
        threshold: 0.7,
      },
    }
  );
  for (const heading of [
    "WHAT REDEN FOUND",
    "EVIDENCE",
    "CONFIDENCE",
    "WHAT REDEN CANNOT ESTABLISH YET",
    "RECOMMENDED NEXT STEP",
    "WHAT WOULD CHANGE THIS RECOMMENDATION",
  ]) assert.ok(answer.includes(heading), `Missing heading: ${heading}`);
  assert.match(answer, /not a calibrated purchase probability/i);
  assert.match(answer, /intent alone should not trigger a discount/i);
  assert.match(answer, /Recorded active sessions: 12/i);
});

test("intervention answer distinguishes observed conversion from incremental lift", () => {
  const answer = applyIntelligenceAnswerContract(
    "3 conversions were recorded.",
    ["intervention_effectiveness"],
    {
      interventionOutcomes: [{
        action: "INCENTIVE_LOW",
        actioned: 10,
        completed: 8,
        conversions: 3,
      }],
    }
  );
  assert.match(answer, /do not establish incremental lift/i);
  assert.match(answer, /randomized holdout/i);
  assert.match(answer, /intervention costs/i);
});

test("priority answer warns that a baseline signal is not a root cause", () => {
  const answer = applyIntelligenceAnswerContract(
    "Investigate checkout-to-purchase completion.",
    ["merchant_priority"],
    {
      funnelBaseline: {
        status: "below_baseline",
        lowStages: ["purchase"],
      },
      trafficBaseline: { status: "not_markedly_below_baseline" },
      revenueBaseline: { status: "insufficient_history" },
    }
  );
  assert.match(answer, /not the root cause/i);
  assert.match(answer, /Verify tracking/i);
});

test("non-merchant answer types remain unchanged", () => {
  const original = "Hello. How can I help?";
  assert.equal(applyIntelligenceAnswerContract(original, ["greeting"], {}), original);
});
