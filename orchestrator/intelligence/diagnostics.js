function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(value) {
  const number = numberOrNull(value);
  return number === null
    ? null
    : number.toLocaleString("en-NG", { maximumFractionDigits: 2 });
}

function count(value) {
  const number = numberOrNull(value);
  return number === null ? 0 : Math.max(0, number);
}

const STAGES = {
  productView: {
    label: "product-page discovery",
    action: "Check landing-page relevance, navigation, product availability and PRODUCT_VIEW tracking.",
  },
  addToCart: {
    label: "product-to-cart progression",
    action: "Review product price, stock, delivery costs, product information and trust signals; verify ADD_TO_CART tracking.",
  },
  checkout: {
    label: "cart-to-checkout progression",
    action: "Check cart usability, shipping costs and delivery details, then verify CHECKOUT_STARTED tracking.",
  },
  purchase: {
    label: "checkout-to-purchase completion",
    action: "Test mobile checkout, payment failures, shipping fees and purchase-event delivery.",
  },
};

const DOWNSTREAM_FIRST = ["purchase", "checkout", "addToCart", "productView"];

function stageLabel(stage) {
  return STAGES[stage]?.label || String(stage || "shopping journey");
}

function formatStageRate(funnel, stage) {
  const current = numberOrNull(funnel?.current?.rates?.[stage]);
  const baseline = numberOrNull(funnel?.averages?.[stage]);
  if (current === null || baseline === null) return "";
  return ` The recorded rate is ${(current * 100).toFixed(1)}% versus ${(baseline * 100).toFixed(1)}% in comparable periods.`;
}

/**
 * Diagnose the most actionable supported sales signal. This is a concise
 * deterministic business diagnosis, not a causal attribution claim.
 */
export function diagnoseSales(evidence = {}, { allowFallback = true } = {}) {
  const traffic = evidence.trafficBaseline || {};
  const revenueBaseline = evidence.revenueBaseline || {};
  const funnel = evidence.funnelBaseline || {};
  const purchases = count(evidence.purchases);
  const revenue = money(evidence.purchaseRevenue);
  const recordedRevenue = revenue === null ? "" : ` Recorded purchase revenue is ${revenue}.`;

  // Missing downstream events can mean either a real journey break or broken
  // instrumentation. Validate before recommending commercial changes.
  if (Array.isArray(funnel.trackingValidationStages) && funnel.trackingValidationStages.length) {
    const stage = DOWNSTREAM_FIRST.find((candidate) => funnel.trackingValidationStages.includes(candidate))
      || funnel.trackingValidationStages[0];
    return `REDEN sees upstream visits but no recorded ${stageLabel(stage)} events. This could be a real drop-off or missing tracking. ${STAGES[stage]?.action || "Run a test journey and verify the event reaches REDEN."} Do this before changing ads, prices or discounts.`;
  }

  if (revenueBaseline.status === "purchase_summary_mismatch") {
    return "Purchase events and purchased-session records do not agree, so the revenue comparison is not reliable. Run a test order and verify that the PURCHASE event and purchased session are both recorded before changing ads or offers.";
  }

  if (traffic.status === "below_baseline") {
    const current = numberOrNull(traffic.currentSessions);
    const average = numberOrNull(traffic.averageSessions);
    const comparison = current !== null && average !== null
      ? ` (${current} visits so far versus a same-time average of ${average.toFixed(0)} across ${count(traffic.daysWithTraffic)} recent days)`
      : "";
    const funnelStage = DOWNSTREAM_FIRST.find((stage) => Array.isArray(funnel.lowStages) && funnel.lowStages.includes(stage));
    const conversionNote = funnelStage
      ? ` REDEN also flags ${stageLabel(funnelStage)}; investigate that step if visits recover but purchases do not.`
      : " First confirm the storefront is reachable and PAGE_VIEW tracking works.";
    return `Fewer people are visiting your store than usual${comparison}, so fewer potential buyers are entering the funnel. Check ad delivery, traffic sources and broken links; if tracking is healthy, test a targeted campaign for qualified shoppers.${conversionNote}`;
  }

  if (Array.isArray(funnel.lowStages) && funnel.lowStages.length) {
    const stage = DOWNSTREAM_FIRST.find((candidate) => funnel.lowStages.includes(candidate))
      || funnel.lowStages[0];
    return `The clearest warning sign is ${stageLabel(stage)}.${formatStageRate(funnel, stage)} ${STAGES[stage]?.action || "Inspect this step of the shopping journey and verify its event tracking."} More advertising will not fix a weak conversion step.`;
  }

  if (revenueBaseline.status === "below_baseline") {
    const current = money(revenueBaseline.currentRevenue);
    const average = money(revenueBaseline.averageRevenue);
    const comparison = current !== null && average !== null
      ? ` (${current} recorded so far versus ${average} in comparable periods)`
      : "";
    return `Recorded purchase revenue is below its usual level${comparison}.${recordedRevenue} Compare purchase count and average order value, then verify payment and purchase tracking. If visits are also down, review acquisition; if visits are steady, investigate product pages and checkout.`;
  }

  if (revenueBaseline.status === "purchase_tracking_unconfirmed" || purchases === 0) {
    return "REDEN has no confirmed purchase event for this period. That could mean no orders or missing purchase tracking. Run a test order first; if tracking works, check visits, add-to-cart activity and checkout to find where shoppers stop before increasing ad spend.";
  }

  if (traffic.status === "not_markedly_below_baseline") {
    if (purchases <= 1) {
      return `Only ${purchases} purchase${purchases === 1 ? "" : "s"} ${purchases === 1 ? "has" : "have"} been recorded so far.${recordedRevenue} Visits are not clearly below normal, so do not default to more advertising. Check product interest, add-to-cart activity and checkout completion; I cannot confirm a decline without a comparable purchase baseline.`;
    }
    if (!allowFallback) return null;
    return `REDEN recorded ${purchases} purchases so far.${recordedRevenue} Visits are not clearly below normal, so more advertising may not be the first fix. Check product-page interest, add-to-cart activity and checkout completion for the next bottleneck.`;
  }

  if (!allowFallback) return null;

  if (purchases <= 1) {
    return `Only ${purchases} purchase${purchases === 1 ? "" : "s"} ${purchases === 1 ? "has" : "have"} been recorded so far.${recordedRevenue} I cannot confirm this is below your usual level without comparable history. Verify purchase tracking, then compare traffic and the product-to-cart and checkout steps before deciding whether to invest more in advertising.`;
  }

  return `REDEN recorded ${purchases} purchases so far.${recordedRevenue} I cannot confirm a sales decline without comparable historical data. Compare traffic first: if visits are down, investigate acquisition; if visits are steady, inspect product-page, cart and checkout conversion.`;
}
