import { diagnoseSales } from "./diagnostics.js";

/**
 * Produces merchant-specific growth guidance only when REDEN has a supported
 * diagnostic signal. Raw event counts alone are descriptive, not proof that
 * a particular commercial intervention will help.
 */
export function composeGrowthAdvice(evidence = {}) {
  const purchases = Number(evidence.purchases);
  const revenue = Number(evidence.purchaseRevenue);
  const hasPurchaseCount = Number.isFinite(purchases);
  const hasRevenue = Number.isFinite(revenue);
  const lines = [];

  if (hasPurchaseCount || hasRevenue) {
    const purchaseText = hasPurchaseCount ? Math.max(0, purchases) : null;
    const revenueText = hasRevenue
      ? revenue.toLocaleString("en-NG", { maximumFractionDigits: 2 })
      : null;
    if (revenueText !== null && purchaseText !== null) {
      lines.push(`Today, REDEN recorded ${revenueText} in purchase revenue from ${purchaseText} purchase event(s). Revenue is not profit; currency and costs must be verified separately.`);
    } else if (purchaseText !== null) {
      lines.push(`Today, REDEN recorded ${purchaseText} purchase event(s). Purchase revenue is unavailable in the evidence returned for this question.`);
    } else {
      lines.push(`Today, REDEN recorded ${revenueText} in purchase revenue. The purchase count is unavailable in the evidence returned for this question.`);
    }
  }

  const diagnosis = diagnoseSales(evidence, { allowFallback: false });
  if (diagnosis) {
    lines.push("**Evidence-backed priority:** " + diagnosis);
  } else {
    lines.push(
      "I don't have a sufficiently supported diagnosis or comparable historical baseline to recommend a store-specific change yet. The recorded figures describe activity; they do not establish which intervention will improve sales. I won't prescribe a test purchase, discount, campaign, or checkout change without evidence that it is relevant."
    );
  }

  return lines.join("\n\n");
}
