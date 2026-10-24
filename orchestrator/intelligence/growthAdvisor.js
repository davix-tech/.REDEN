/**
 * Prioritizes a practical next action for merchants asking how to grow sales.
 * Uses only supplied evidence; it does not infer causes or promise uplift.
 */
export function composeGrowthAdvice(evidence = {}) {
  const sessions = Number(evidence.uniqueSessions || 0);
  const productViews = Number(evidence.productViews || 0);
  const addToCart = Number(evidence.addToCart || 0);
  const checkouts = Number(evidence.checkoutStarted || 0);
  const purchases = Number(evidence.purchases || 0);
  const revenue = Number(evidence.purchaseRevenue || 0);
  const lines = [];

  lines.push(`Today, REDEN recorded ${revenue.toFixed(2)} in sales revenue from ${purchases} purchase event(s). Revenue is not profit, and the currency and product margins are not confirmed.`);

  // Recommend the most actionable funnel check supported by recorded signals.
  if (sessions >= 10 && productViews > 0 && productViews / sessions < 0.5) {
    lines.push(`**First priority — get more visitors to relevant products.** Only ${productViews} product views were recorded across ${sessions} sessions. Check landing-page relevance, navigation, search, and whether the main product categories are easy to reach. Verify PRODUCT_VIEW tracking before concluding that product discovery is weak.`);
  } else if (productViews >= 10 && addToCart === 0) {
    lines.push(`**First priority — improve product-page purchase intent.** REDEN recorded ${productViews} product views but no add-to-cart events. Check price competitiveness, product photos and descriptions, size/stock availability, delivery cost and timing, returns information, and trust signals. First confirm ADD_TO_CART tracking with a test journey.`);
  } else if (productViews >= 10 && addToCart > 0 && addToCart / productViews < 0.08) {
    lines.push(`**First priority — investigate product-page drop-off.** ${addToCart} add-to-cart events were recorded against ${productViews} product views. Review the highest-viewed products, stock, price, delivery terms, and product information; confirm event tracking before changing offers.`);
  } else if (checkouts >= 3 && purchases === 0) {
    lines.push(`**First priority — remove checkout friction.** REDEN recorded ${checkouts} checkout starts and no purchase events today. Test checkout on a phone, including payment success/failure, shipping fees, delivery promises, account requirements, and error messages. Verify purchase tracking before treating these as lost orders.`);
  } else if (checkouts >= 3 && purchases > 0 && checkouts / purchases >= 2) {
    lines.push(`**First priority — inspect checkout completion.** REDEN recorded ${checkouts} checkout starts and ${purchases} purchase events. Check payment failures, shipping costs, delivery estimates, and checkout errors, and validate both event definitions before estimating abandonment.`);
  } else if (purchases > 0) {
    lines.push(`**First priority — increase profitable order value, not just order count.** Test a relevant product bundle, complementary add-on, or free-shipping threshold only after checking contribution margin. Compare average order value and contribution per order against a baseline or holdout; do not roll out a discount simply because sales can be increased.`);
  } else if (sessions > 0) {
    lines.push(`**First priority — validate the path from visit to purchase.** REDEN recorded ${sessions} sessions but no purchase events today. Run a complete test order and verify PAGE_VIEW, PRODUCT_VIEW, ADD_TO_CART, CHECKOUT_STARTED, and PURCHASE tracking. Then use the first confirmed funnel drop-off to choose the next change.`);
  } else {
    lines.push("**First priority — establish a trustworthy baseline.** Run a test purchase and verify that visit, product-view, cart, checkout, and purchase events are arriving. Until those signals are reliable, REDEN cannot responsibly choose whether to focus on acquisition, conversion, or order value.");
  }

  lines.push("**How to tell whether it worked:** change one thing at a time, compare a similar period or holdout, and track purchase conversion, average order value, refunds, and contribution profit where costs are available. Treat any uplift as unproven until the comparison supports it.");
  return lines.join("\n\n");
}
