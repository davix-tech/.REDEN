import { REDEN_KNOWLEDGE } from "./knowledgeBase.js";

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(value) {
  const number = numberOrNull(value);
  return number === null ? null : number.toLocaleString("en-NG", { maximumFractionDigits: 2 });
}

/** Give merchants a concise, evidence-led diagnosis and practical next step. */
export function diagnoseSales(evidence) {
  const baseline = evidence.trafficBaseline;
  const revenueBaseline = evidence.revenueBaseline;
  const funnelBaseline = evidence.funnelBaseline;
  const purchases = Math.max(0, Number(evidence.purchases) || 0);
  const revenue = money(evidence.purchaseRevenue);

  if (baseline && baseline.status === "below_baseline") {
    return "Fewer people are visiting your store than usual (" + baseline.currentSessions + " visits so far versus a typical " + Number(baseline.averageSessions).toFixed(0) + "). That means fewer potential buyers. Review your ad delivery and traffic sources, then consider a targeted campaign to attract qualified shoppers. If traffic recovers but purchases do not, we should investigate product pages and checkout.";
  }

  if (funnelBaseline && funnelBaseline.status === "below_baseline" && funnelBaseline.lowStages && funnelBaseline.lowStages.length) {
    const labels = { productView: "product views", addToCart: "add-to-cart activity", checkout: "checkout completion", purchase: "purchases" };
    const stage = funnelBaseline.lowStages[0];
    return "The clearest warning sign is " + (labels[stage] || stage) + ": it is below your usual level. More advertising may bring visitors, but it will not fix a weak conversion step. Check that part of the shopping journey first, then measure whether purchases improve.";
  }

  if (revenueBaseline && revenueBaseline.status === "below_baseline") {
    return "Sales revenue is below your usual level (" + money(revenueBaseline.currentRevenue) + " now versus " + money(revenueBaseline.averageRevenue) + " in comparable periods). Check whether purchase count or average order value has fallen. If visits are down too, review advertising; if visits are steady, focus on product pages and checkout.";
  }

  if ((revenueBaseline && revenueBaseline.status === "purchase_tracking_unconfirmed") || purchases === 0) {
    return "No purchase has been recorded in the current comparison window. Customers may not be buying, or purchase tracking may be missing orders. Verify tracking with a test order; if it works, check visits, add-to-cart activity and checkout before increasing ad spend.";
  }

  if (baseline && baseline.status === "not_markedly_below_baseline") {
    return "Your store recorded " + purchases + " purchase" + (purchases === 1 ? "" : "s") + " today" + (revenue === null ? "" : " and " + revenue + " in purchase revenue") + ". Visits are not clearly below normal, so more advertising may not be the first fix. Check product-page interest, add-to-cart activity and checkout completion to find where shoppers may be dropping off.";
  }

  if (purchases <= 1) {
    return "Only " + purchases + " purchase" + (purchases === 1 ? "" : "s") + " " + (purchases === 1 ? "has" : "have") + " been recorded today" + (revenue === null ? "" : " (" + revenue + " in revenue)") + ", so sales activity looks low. I would try a targeted campaign to bring in more qualified shoppers. Before increasing spend heavily, check traffic: if people are visiting but not buying, improve the product page or checkout instead. I cannot confirm this is below your usual level without historical comparison."; 
  }

  return "Your store recorded " + purchases + " purchases today" + (revenue === null ? "" : " and " + revenue + " in purchase revenue") + ". I cannot confirm a decline without comparable historical data. Check whether visits are down or shoppers are leaving during product selection or checkout; that will tell us whether to focus on advertising or conversion.";
}
