function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatAmount(value) {
  return Number(value).toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Summarises week-to-date storefront sales using only recorded purchase data.
 * Revenue is never described as profit, and missing order amounts stay unknown.
 */
export function composeWeeklyRevenue(data = {}) {
  if (!data || data.available === false) {
    return "I could not retrieve reliable store activity for this week's report. Check that your storefront is sending activity to REDEN, then ask me again.";
  }

  const visits = finiteNumber(data.visits);
  const purchases = finiteNumber(data.purchases);
  const revenue = data.revenueAvailable ? finiteNumber(data.revenue) : null;

  const period = data.periodLabel || "this week so far";
  const lines = [];

  if (revenue === null) {
    lines.push(
      `For ${period}, REDEN recorded ${purchases ?? 0} purchasing session(s), but the purchase records do not contain usable order amounts. I cannot total recorded sales reliably yet.`
    );
  } else {
    lines.push(
      `For ${period}, your store recorded ${formatAmount(revenue)} in sales. This is recorded sales revenue, not verified profit, and the store currency has not been confirmed.`
    );
    lines.push(
      `REDEN recorded ${purchases ?? 0} purchasing session(s)${visits !== null ? ` from ${visits} store visits` : ""}.`
    );
  }

  if (visits !== null && visits > 0 && purchases !== null) {
    const rate = (purchases / visits) * 100;
    lines.push(
      `About ${rate.toFixed(1)}% of recorded visits came from sessions with a purchase. This is a session-based measure, not a count of unique customers.`
    );
  }

  const previous = data.previous || {};
  const previousRevenue = previous.revenueAvailable
    ? finiteNumber(previous.revenue)
    : null;

  if (revenue !== null && previousRevenue !== null) {
    if (previousRevenue > 0) {
      const change = ((revenue - previousRevenue) / previousRevenue) * 100;
      const direction = change > 0 ? "higher" : change < 0 ? "lower" : "unchanged";
      lines.push(
        `Compared with the same elapsed period last week, recorded sales are ${direction} by ${Math.abs(change).toFixed(1)}% (${formatAmount(previousRevenue)} last week).`
      );
    } else if (revenue > 0) {
      lines.push(
        `No recorded sales were available in the comparable period last week, so a percentage change cannot be calculated.`
      );
    }
  }

  lines.push("These figures reflect purchase activity REDEN received. They do not confirm payment settlement, refunds, costs, or profit.");
  return lines.join(" ");
}
