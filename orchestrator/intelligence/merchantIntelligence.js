/**
 * Evidence-backed merchant intelligence for REDEN.
 *
 * This layer translates the evidence already assembled by the intelligence
 * pipeline into useful merchant decisions. It must not imply causal impact,
 * customer certainty, or unavailable data.
 */

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return number(value).toFixed(2);
}

function formatAction(action) {
  return String(action || "UNKNOWN").replaceAll("_", " ").toLowerCase();
}

export function composeMerchantIntelligence(intent, evidence = {}) {
  if (intent === "intent_opportunities") {
    const summary = evidence.intentSummary;

    if (!summary) {
      return "Purchase-intent assessment is not available in this response. REDEN needs recent session context and a maintained behavioural intent score before identifying current opportunities.";
    }

    const recent = number(summary.recentSessions);
    const highIntent = number(summary.highIntentUnpurchased);
    const cartSessions = number(summary.highIntentWithCart);
    const checkoutSessions = number(summary.highIntentWithCheckout);
    const cartValue = number(summary.highIntentCartValue);

    if (recent === 0) {
      return "REDEN has no recently active sessions recorded in the last 30 minutes. That does not prove there are no shoppers in the store: verify storefront availability and PAGE_VIEW tracking before treating this as zero demand.";
    }

    if (highIntent === 0) {
      return `REDEN recorded ${recent} recently active session(s), but none currently meet its behavioural high-intent threshold without a recorded purchase. This is not a claim that nobody intends to buy. Check tracking coverage and review product/cart behaviour before sending blanket incentives.`;
    }

    const behaviour = [];
    if (cartSessions > 0) behaviour.push(`${cartSessions} have added items to cart`);
    if (checkoutSessions > 0) behaviour.push(`${checkoutSessions} have started checkout`);

    return [
      `REDEN recorded ${highIntent} recently active, high-behavioural-intent session(s) without a recorded purchase, out of ${recent} active sessions in the last 30 minutes.`,
      behaviour.length ? `Observed signals: ${behaviour.join("; ")}.` : "",
      cartValue > 0 ? `Their recorded cart value totals ${money(cartValue)} (currency and margin are not confirmed).` : "",
      "The intent score is a behavioural proxy, not a calibrated probability that a shopper will buy. Prioritise a relevant, low-cost intervention only when eligibility, consent, and store rules permit; do not assume a discount is necessary.",
    ].filter(Boolean).join(" ");
  }

  if (intent === "intervention_effectiveness") {
    const outcomes = Array.isArray(evidence.interventionOutcomes)
      ? evidence.interventionOutcomes
      : [];

    if (!outcomes.length) {
      return "REDEN does not have enough recorded intervention outcomes in the current reporting window to compare actions. Confirm that decisions progress through SCORED → ACTIONED → COMPLETED and that /outcome receives the true result. Do not interpret missing outcomes as failed actions.";
    }

    const rows = outcomes.map((row) => {
      const completed = number(row.completed);
      const conversions = number(row.conversions);
      const rate = completed > 0 ? (conversions / completed) * 100 : null;
      const sampleNote = completed < 5 ? " (very small sample; directional only)" : "";
      const rateText = rate === null ? "no completed outcomes yet" : `${rate.toFixed(1)}% observed conversion among completed outcomes`;
      return `${formatAction(row.action)}: ${number(row.actioned)} actioned, ${completed} completed, ${conversions} recorded conversions, ${rateText}${sampleNote}`;
    });

    return [
      `Recorded intervention outcomes for ${evidence.localDate || "the current store-local day"}:`,
      ...rows.map((row) => `- ${row}`),
      "These are observed outcomes, not proof of incremental lift. Customers may have purchased without an intervention, and actions may be assigned to different kinds of shoppers. To estimate causal impact, compare eligible shoppers against a randomized holdout or another defensible baseline; to estimate profit, REDEN also needs costs and contribution-margin data.",
    ].join("\n");
  }

  if (intent === "merchant_priority") {
    const funnel = evidence.funnelBaseline;
    if (funnel?.trackingValidationStages?.length) {
      return `**First priority: validate tracking at ${funnel.trackingValidationStages.join(", ")}.** The recorded funnel has meaningful upstream activity but zero events at these stage(s). That could be a real journey break or missing instrumentation. Run a test purchase and verify event delivery before changing prices, discounts, or advertising.`;
    }

    if (funnel?.status === "below_baseline" && funnel.lowStages?.length) {
      const stage = funnel.lowStages[0];
      const labels = {
        productView: "product discovery",
        addToCart: "product-to-cart progression",
        checkout: "cart-to-checkout progression",
        purchase: "checkout-to-purchase completion",
      };
      return `**First priority: investigate ${labels[stage] || stage}.** REDEN's comparable session-level baseline flags this stage as materially below its recent level. This is a diagnostic signal, not proof of a specific cause. Verify event tracking, inspect the affected journey, and measure the same rate after the smallest reversible fix.`;
    }

    if (evidence.trafficBaseline?.status === "below_baseline") {
      return "**First priority: verify storefront availability and traffic tracking.** Recorded visits are materially below the same-time baseline. If the storefront and PAGE_VIEW events are healthy, inspect traffic sources and campaign delivery before increasing spend.";
    }

    if (evidence.revenueBaseline?.status === "below_baseline") {
      return "**First priority: identify whether the revenue change comes from order count or order value.** Recorded storefront purchase revenue is materially below its comparable baseline. Check purchase tracking, purchase count and average order value before changing pricing or advertising.";
    }

    if (evidence.intentSummary && number(evidence.intentSummary.highIntentUnpurchased) > 0) {
      return `**First priority: review the ${number(evidence.intentSummary.highIntentUnpurchased)} recently active high-behavioural-intent session(s) without a recorded purchase.** Check their cart/checkout signals and eligibility for a relevant, low-cost intervention. The intent score is not a purchase probability, and the evidence does not prove that a discount is needed.`;
    }

    return "REDEN cannot responsibly identify a single highest-value action from the current evidence. First confirm that event tracking is healthy and compare traffic, funnel rates and purchase revenue against a comparable baseline. Missing evidence should not be replaced with a guessed recommendation.";
  }

  return null;
}
