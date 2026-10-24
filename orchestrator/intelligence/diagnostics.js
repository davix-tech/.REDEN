import { REDEN_KNOWLEDGE } from "./knowledgeBase.js";

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Produces a cautious, evidence-linked sales diagnosis.
 * This does not claim a cause when the available evidence cannot establish one.
 */
export function diagnoseSales(evidence) {
  const knowledge = REDEN_KNOWLEDGE.sales_diagnosis;
  const baseline = evidence.trafficBaseline;
  const observations = [
    `Today REDEN recorded ${evidence.purchases} purchase event(s) and ${numberOrNull(evidence.purchaseRevenue)?.toFixed(2) ?? "an unavailable amount"} in storefront purchase revenue.`
  ];
  const hypotheses = [];
  const actions = [];

  if (baseline?.status === "below_baseline") {
    hypotheses.push(
      `Recorded traffic is materially below its same-time baseline (${baseline.currentSessions} sessions so far versus a historical average of ${baseline.averageSessions.toFixed(1)} across ${baseline.daysWithTraffic} eligible days). This may be contributing to lower sales, but it does not by itself prove the cause.`
    );
    actions.push(
      "First verify storefront availability and PAGE_VIEW tracking. If both are healthy, inspect traffic sources and campaign delivery before changing spend."
    );
  } else if (baseline?.status === "not_markedly_below_baseline") {
    hypotheses.push(
      "Recorded PAGE_VIEW sessions are not materially below the available same-time baseline. That makes a large traffic drop less evident in the current data; product interest, cart activity, checkout completion, and order value still need comparable historical baselines."
    );
  } else {
    hypotheses.push(
      "I cannot yet confirm why sales are down: REDEN needs a reliable comparable-period revenue and purchase baseline, and its current traffic history is insufficient to establish whether visits have fallen."
    );
    actions.push(
      "Verify PAGE_VIEW and PURCHASE tracking, then compare revenue, purchase count, and funnel-stage rates with the same local-time window on recent days."
    );
  }

  if (evidence.checkoutStarted > 0 && evidence.purchases > 0 &&
      evidence.checkoutStarted > evidence.purchases * 2) {
    hypotheses.push(
      `There are ${evidence.checkoutStarted} checkout-start events versus ${evidence.purchases} purchase event(s). This is an event-count gap, not a confirmed count of abandoned checkouts.`
    );
    actions.push(
      "Test checkout and payment completion, and confirm that successful orders reliably emit PURCHASE events."
    );
  } else if (evidence.checkoutStarted > 0 && evidence.purchases === 0) {
    hypotheses.push(
      "Checkout starts are recorded without a purchase event today. This could reflect checkout friction or missing purchase tracking; the current evidence cannot distinguish them."
    );
    actions.push(
      "Run a test purchase and verify payment completion and PURCHASE-event delivery before diagnosing a conversion failure."
    );
  }

  const uniqueActions = [...new Set(actions)];
  const uncertainty = baseline?.status === "below_baseline" ||
    baseline?.status === "not_markedly_below_baseline"
    ? ""
    : " A confirmed cause requires historical revenue and funnel comparisons; those comparisons are not yet available in this response.";

  return [
    "Sales diagnosis (evidence-led):",
    ...observations,
    ...hypotheses.map((item) => `- ${item}`),
    uniqueActions.length
      ? `Recommended checks: ${uniqueActions.join(" ")}`
      : "Recommended next step: compare today's product-view, add-to-cart, checkout, purchase, and revenue metrics with a comparable historical period before choosing an intervention.",
    uncertainty,
    `Reasoning framework: ${knowledge.reasoning_rules[0]}`
  ].filter(Boolean).join(" ");
}
