function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function count(value) {
  const parsed = finite(value);
  return parsed === null ? 0 : Math.max(0, parsed);
}

function amount(value) {
  const parsed = finite(value);
  return parsed === null
    ? null
    : parsed.toLocaleString("en-NG", { maximumFractionDigits: 2 });
}

const FUNNEL_STAGES = {
  productView: {
    label: "product discovery",
    rateLabel: "product-view rate",
    action: "Check landing-page relevance, navigation, product visibility and stock; verify PRODUCT_VIEW tracking.",
  },
  addToCart: {
    label: "product-to-cart progression",
    rateLabel: "add-to-cart rate",
    action: "Review product pricing, stock, delivery cost, product information and trust signals; verify ADD_TO_CART tracking.",
  },
  checkout: {
    label: "cart-to-checkout progression",
    rateLabel: "checkout-start rate",
    action: "Review cart usability, shipping costs and delivery details; verify CHECKOUT_STARTED tracking.",
  },
  purchase: {
    label: "checkout completion",
    rateLabel: "purchase-after-checkout rate",
    action: "Test mobile checkout, payment methods, shipping fees and purchase-event delivery.",
  },
};

const PRIORITY_ORDER = ["purchase", "checkout", "addToCart", "productView"];

function stageComparison(baseline, stage) {
  const current = finite(baseline?.current?.rates?.[stage]);
  const average = finite(baseline?.averages?.[stage]);
  if (current === null || average === null) return null;
  return {
    current: current * 100,
    average: average * 100,
    label: FUNNEL_STAGES[stage].rateLabel,
  };
}

/**
 * Turns the full evidence bundle already collected by REDEN into a
 * merchant-facing performance diagnosis. Observations, hypotheses and
 * measurement gaps are kept distinct; no causal claims are inferred.
 */
export function composeStoreOverview(evidence = {}) {
  const sessions = count(evidence.uniqueSessions);
  const events = count(evidence.totalEvents);
  const pageViews = count(evidence.pageViews);
  const productViews = count(evidence.productViews);
  const carts = count(evidence.addToCart);
  const checkouts = count(evidence.checkoutStarted);
  const purchases = count(evidence.purchases);
  const decisions = count(evidence.decisions);
  const conversions = count(evidence.conversions);
  const revenue = evidence.purchaseRevenueAvailable === false
    ? null
    : amount(evidence.purchaseRevenue);
  const revenuePerPurchase = purchases > 0 && revenue !== null
    ? (count(evidence.purchaseRevenue) / purchases)
    : null;

  const sections = [];
  sections.push(
    `**Performance snapshot**\nToday, REDEN recorded ${sessions} unique session(s) and ${events} events. The store recorded ${purchases} PURCHASE event(s)${revenue === null ? "; purchase revenue could not be reliably calculated" : `, representing ${revenue} in recorded storefront purchase revenue`}. ${revenuePerPurchase === null ? "" : `That is ${amount(revenuePerPurchase)} per purchase event on average, not verified average order value unless purchase events map one-to-one to unique orders.`}`
  );

  sections.push(
    `**Shopping journey**\nREDEN recorded ${pageViews} page views, ${productViews} product views, ${carts} add-to-cart events and ${checkouts} checkout starts. These are event counts, not necessarily distinct shoppers or orders.`
  );

  const funnel = evidence.funnelBaseline;
  const traffic = evidence.trafficBaseline;
  const revenueBaseline = evidence.revenueBaseline;

  const comparisons = PRIORITY_ORDER
    .map((stage) => ({ stage, comparison: stageComparison(funnel, stage) }))
    .filter((item) => item.comparison);

  if (funnel?.status === "available" || funnel?.status === "below_baseline") {
    const details = comparisons.map(({ stage, comparison }) =>
      `${comparison.label}: ${comparison.current.toFixed(1)}% versus ${comparison.average.toFixed(1)}% across comparable historical days`
    );
    sections.push(
      `**Funnel quality**\n${details.length ? details.join("; ") + "." : "Historical session-level funnel rates are available, but no stage has a valid current rate yet."} ${count(funnel.daysWithTraffic)} prior day(s) had recorded traffic in the comparison window.`
    );
  } else {
    sections.push(
      `**Funnel quality**\nThere is not yet enough historical traffic for a reliable same-time funnel comparison. Today's event counts show activity, but do not establish whether each stage is performing above or below normal.`
    );
  }

  if (traffic?.status === "below_baseline") {
    sections.push(
      `**Traffic comparison**\nRecorded visits are below the recent same-time baseline: ${count(traffic.currentSessions)} so far versus an average of ${finite(traffic.averageSessions)?.toFixed(1) ?? "unknown"} across ${count(traffic.daysWithTraffic)} comparable day(s).`
    );
  } else if (traffic?.status === "not_markedly_below_baseline") {
    sections.push(
      `**Traffic comparison**\nRecorded visits are not at least 50% below the recent same-time baseline. This does not by itself mean traffic quality or sales performance is healthy.`
    );
  } else {
    sections.push(
      `**Traffic comparison**\nREDEN does not yet have enough reliable historical traffic to determine whether today's visits are unusually low.`
    );
  }

  if (revenueBaseline?.status === "below_baseline") {
    sections.push(
      `**Revenue comparison**\nRecorded storefront purchase revenue is below the same-time historical average: ${amount(revenueBaseline.currentRevenue) ?? "unavailable"} today versus ${amount(revenueBaseline.averageRevenue) ?? "unavailable"} across ${count(revenueBaseline.daysWithComparablePurchases)} comparable purchase day(s).`
    );
  } else if (revenueBaseline?.status === "not_markedly_below_baseline") {
    sections.push(
      `**Revenue comparison**\nRecorded purchase revenue is not materially below the available same-time historical average. This is a revenue comparison, not a profitability assessment.`
    );
  } else {
    sections.push(
      `**Revenue comparison**\nThere is not enough comparable purchase history to judge whether today's recorded revenue is unusually high or low.`
    );
  }

  sections.push(
    decisions > 0
      ? `**REDEN decision performance**\nREDEN completed ${decisions} decisions and recorded ${conversions} associated conversions (${((conversions / decisions) * 100).toFixed(1)}% descriptive decision conversion). This is not the store's overall purchase conversion rate and does not prove incremental lift.`
      : "**REDEN decision performance**\nNo completed REDEN decisions were recorded in this period, so a REDEN decision conversion rate is unavailable. This does not mean the store had zero sales; storefront purchases are measured separately."
  );

  const priorities = [];
  const trackingStages = Array.isArray(funnel?.trackingValidationStages)
    ? funnel.trackingValidationStages
    : [];
  const trackingStage = PRIORITY_ORDER.find((stage) => trackingStages.includes(stage));

  if (trackingStage) {
    priorities.push(
      `1. **Verify ${FUNNEL_STAGES[trackingStage].label} tracking first.** REDEN recorded upstream activity but no downstream events at this stage. This may be a real drop-off or missing instrumentation. ${FUNNEL_STAGES[trackingStage].action}`
    );
  } else if (traffic?.status === "below_baseline") {
    priorities.push(
      "1. **Check acquisition and storefront availability.** Confirm the site loads, PAGE_VIEW tracking works, and traffic-source or campaign delivery has not changed. Do not increase ad spend until tracking and campaign delivery are verified."
    );
  }

  const lowStage = PRIORITY_ORDER.find((stage) =>
    Array.isArray(funnel?.lowStages) && funnel.lowStages.includes(stage)
  );
  if (lowStage && !trackingStage) {
    const comparison = stageComparison(funnel, lowStage);
    priorities.push(
      `${priorities.length + 1}. **Investigate ${FUNNEL_STAGES[lowStage].label}.** ${comparison ? `The recorded ${comparison.label} is ${comparison.current.toFixed(1)}% versus ${comparison.average.toFixed(1)}% in comparable periods. ` : ""}${FUNNEL_STAGES[lowStage].action}`
    );
  }

  if (sessions <= 5 && !priorities.length) {
    priorities.push(
      `${priorities.length + 1}. **Build a reliable sample before making commercial changes.** Only ${sessions} unique session(s) were recorded. Verify the full customer journey with a test order and let more real traffic accumulate before drawing conclusions about demand or conversion.`
    );
  }

  if (purchases > sessions && sessions > 0) {
    priorities.push(
      `${priorities.length + 1}. **Reconcile purchase events with order records.** There are ${purchases} purchase events but only ${sessions} unique session(s). One session can contain multiple legitimate orders, but event counts alone cannot establish that. Verify unique order IDs and duplicate-event handling before treating purchase events as distinct orders.`
    );
  }

  if (!priorities.length) {
    priorities.push(
      "1. **Keep monitoring the funnel rather than making a broad change.** The current evidence does not isolate a single confirmed bottleneck. Track visits, product discovery, cart progression, checkout completion and purchase revenue over comparable periods."
    );
  }

  sections.push(`**What deserves attention**\n${priorities.join("\n\n")}`);
  sections.push(
    "**Interpretation limits**\nRecorded storefront revenue is not profit or necessarily settled cash. REDEN decision conversions are separate from store purchases. A single day's activity, especially with a small session count, cannot establish a trend or prove why customers bought or did not buy."
  );

  return sections.join("\n\n");
}
