/**
 * Standard answer contract for REDEN's highest-stakes merchant questions.
 *
 * Keeps the existing plain-text API response compatible while making the
 * distinction between evidence, inference, uncertainty, and action explicit.
 */

const MERCHANT_INTELLIGENCE_INTENTS = new Set([
  "intent_opportunities",
  "intervention_effectiveness",
  "merchant_priority",
]);

function evidenceSummary(intent, evidence = {}) {
  if (intent === "intent_opportunities") {
    const summary = evidence.intentSummary;
    if (!summary) return "No recent intent aggregate was available.";
    return [
      `Window: last ${Number(summary.windowMinutes) || 30} minutes.`,
      `Recorded active sessions: ${Number(summary.recentSessions) || 0}.`,
      `High behavioural-intent sessions without a recorded purchase: ${Number(summary.highIntentUnpurchased) || 0}.`,
      `Of those, with a cart: ${Number(summary.highIntentWithCart) || 0}; with checkout started: ${Number(summary.highIntentWithCheckout) || 0}.`,
      `Scoring method: ${summary.scoreType || "unspecified"}; threshold: ${Number(summary.threshold) || "not available"}.`,
    ].join(" ");
  }

  if (intent === "intervention_effectiveness") {
    const outcomes = Array.isArray(evidence.interventionOutcomes)
      ? evidence.interventionOutcomes
      : [];
    if (!outcomes.length) return "No intervention outcomes were recorded in the reporting window.";
    return outcomes.map((row) =>
      `${String(row.action || "unknown action")}: ${Number(row.actioned) || 0} actioned, ${Number(row.completed) || 0} completed, ${Number(row.conversions) || 0} recorded conversions.`
    ).join(" ");
  }

  const funnel = evidence.funnelBaseline;
  const traffic = evidence.trafficBaseline;
  const revenue = evidence.revenueBaseline;
  return [
    funnel?.status ? `Funnel baseline: ${funnel.status}.` : "",
    funnel?.lowStages?.length ? `Flagged funnel stages: ${funnel.lowStages.join(", ")}.` : "",
    traffic?.status ? `Traffic baseline: ${traffic.status}.` : "",
    revenue?.status ? `Revenue baseline: ${revenue.status}.` : "",
  ].filter(Boolean).join(" ") || "No comparable baseline signal was available.";
}

function uncertainty(intent, evidence = {}) {
  if (intent === "intent_opportunities") {
    return "The score ranks observed behaviour; it is not a calibrated purchase probability. Session-level events cannot reveal a shopper's private reason for leaving. Missing or delayed SDK events can also change the result.";
  }
  if (intent === "intervention_effectiveness") {
    return "Observed conversions after an action do not establish incremental lift. Without randomized holdouts or a defensible causal design, REDEN cannot know how many would have purchased anyway. Revenue alone is not profit; intervention cost and contribution margin are also needed.";
  }
  return "A baseline flags where to investigate, not the root cause. Missing events can mimic a real funnel failure. The recommendation should change after tracking validation or a comparable post-change measurement.";
}

function confidence(intent, evidence = {}) {
  if (intent === "intent_opportunities") {
    const summary = evidence.intentSummary;
    if (!summary || Number(summary.recentSessions) === 0) {
      return "Low: there is no recent session evidence to rank.";
    }
    return "Moderate for the recorded event counts if SDK tracking is healthy; low for the underlying reason for hesitation or the probability of purchase.";
  }
  if (intent === "intervention_effectiveness") {
    const outcomes = Array.isArray(evidence.interventionOutcomes)
      ? evidence.interventionOutcomes
      : [];
    const completed = outcomes.reduce((sum, row) => sum + (Number(row.completed) || 0), 0);
    if (completed < 5) return "Low: fewer than five completed intervention outcomes are recorded, or the outcome evidence is absent.";
    return "Moderate for descriptive recorded outcome rates; low for causal impact because no randomized holdout is established.";
  }
  return "Low to moderate, depending on the amount of comparable baseline history and whether event tracking has been validated.";
}

function recommendationChange(intent) {
  if (intent === "intent_opportunities") {
    return "Recheck after verifying SDK events and reviewing the actual cart/checkout journey. A verified blocker, customer-provided reason, or new outcome data could change the intervention; intent alone should not trigger a discount.";
  }
  if (intent === "intervention_effectiveness") {
    return "A randomized holdout, reliable action assignment, completed outcome events, and intervention-cost/contribution-margin data could change the conclusion.";
  }
  return "A verified tracking test, reproducible technical fault, or a comparable post-fix funnel measurement could change the priority.";
}

export function applyIntelligenceAnswerContract(answer, intents = [], evidence = {}) {
  const intent = intents.find((candidate) => MERCHANT_INTELLIGENCE_INTENTS.has(candidate));
  if (!intent || !answer) return answer;

  return [
    "WHAT REDEN FOUND",
    answer,
    "",
    "EVIDENCE",
    evidenceSummary(intent, evidence),
    "",
    "CONFIDENCE",
    confidence(intent, evidence),
    "",
    "WHAT REDEN CANNOT ESTABLISH YET",
    uncertainty(intent, evidence),
    "",
    "RECOMMENDED NEXT STEP",
    intent === "intent_opportunities"
      ? "Review the observed cart/checkout signals and choose the least costly eligible action. Prefer useful information or no intervention over a discount unless evidence supports an incentive."
      : intent === "intervention_effectiveness"
        ? "Treat the reported rates as descriptive. Set up a randomized holdout before claiming incremental sales, and include intervention costs before claiming profit."
        : "Verify tracking and inspect the flagged journey before making pricing, discount, or advertising changes.",
    "",
    "WHAT WOULD CHANGE THIS RECOMMENDATION",
    recommendationChange(intent),
  ].join("\n");
}
