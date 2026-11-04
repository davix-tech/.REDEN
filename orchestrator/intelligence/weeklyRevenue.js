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

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function localMidnightToUtc(year, month, day, timeZone) {
  const target = new Date(Date.UTC(year, month - 1, day));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(target);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  const representedUtc = Date.UTC(
    values.year, values.month - 1, values.day,
    values.hour, values.minute, values.second
  );
  return new Date(target.getTime() - (representedUtc - target.getTime()));
}

/**
 * Load recorded sales for the merchant-local week (Monday start) and compare
 * it with the same elapsed period in the previous week.
 */
export async function loadWeeklyRevenue({
  db,
  siteId,
  timeZone = "Africa/Lagos",
  referenceDate = new Date(),
}) {
  try {
    const today = localParts(referenceDate, timeZone);
    const calendarDate = new Date(Date.UTC(today.year, today.month - 1, today.day));
    const daysSinceMonday = (calendarDate.getUTCDay() + 6) % 7;
    const monday = new Date(calendarDate.getTime() - daysSinceMonday * 86400000);
    const previousMonday = new Date(monday.getTime() - 7 * 86400000);

    const startUTC = localMidnightToUtc(
      monday.getUTCFullYear(),
      monday.getUTCMonth() + 1,
      monday.getUTCDate(),
      timeZone
    );
    const previousStartUTC = localMidnightToUtc(
      previousMonday.getUTCFullYear(),
      previousMonday.getUTCMonth() + 1,
      previousMonday.getUTCDate(),
      timeZone
    );
    const previousEndUTC = new Date(
      previousStartUTC.getTime() + (referenceDate.getTime() - startUTC.getTime())
    );

    const result = await db.query(
      `
        WITH periods AS (
          SELECT 'current'::TEXT AS period
          UNION ALL
          SELECT 'previous'::TEXT
        ),
        scoped_events AS (
          SELECT
            CASE
              WHEN created_at >= $2 AND created_at < $3 THEN 'current'
              ELSE 'previous'
            END AS period,
            event,
            session_id,
            payload
          FROM event_logs
          WHERE site_id = $1
            AND (
              (created_at >= $2 AND created_at < $3)
              OR
              (created_at >= $4 AND created_at < $5)
            )
        ),
        normalized_events AS (
          SELECT
            period,
            event,
            session_id,
            CASE
              WHEN event = 'PURCHASE'
                AND COALESCE(
                  NULLIF(payload->>'revenue', ''),
                  NULLIF(payload->>'total', ''),
                  NULLIF(payload->>'value', ''),
                  NULLIF(payload->>'order_total', ''),
                  NULLIF(payload->>'orderTotal', ''),
                  NULLIF(payload->>'amount', ''),
                  NULLIF(payload->>'cart_value', ''),
                  NULLIF(payload->>'cartValue', ''),
                  NULLIF(payload #>> '{cart,value}', '')
                ) ~ '^[0-9]+([.][0-9]+)?$'
              THEN COALESCE(
                NULLIF(payload->>'revenue', ''),
                NULLIF(payload->>'total', ''),
                NULLIF(payload->>'value', ''),
                NULLIF(payload->>'order_total', ''),
                NULLIF(payload->>'orderTotal', ''),
                NULLIF(payload->>'amount', ''),
                NULLIF(payload->>'cart_value', ''),
                NULLIF(payload->>'cartValue', ''),
                NULLIF(payload #>> '{cart,value}', '')
              )::NUMERIC
              ELSE NULL
            END AS amount
          FROM scoped_events
        )
        SELECT
          periods.period,
          COUNT(DISTINCT normalized_events.session_id)
            FILTER (WHERE normalized_events.event = 'PAGE_VIEW')::INTEGER AS visits,
          COUNT(DISTINCT normalized_events.session_id)
            FILTER (WHERE normalized_events.event = 'PURCHASE')::INTEGER AS purchases,
          COALESCE(
            SUM(normalized_events.amount)
              FILTER (WHERE normalized_events.event = 'PURCHASE'),
            0
          )::NUMERIC AS revenue,
          COUNT(normalized_events.amount)
            FILTER (WHERE normalized_events.event = 'PURCHASE')::INTEGER AS priced_purchases
        FROM periods
        LEFT JOIN normalized_events
          ON normalized_events.period = periods.period
        GROUP BY periods.period
      `,
      [siteId, startUTC, referenceDate, previousStartUTC, previousEndUTC]
    );

    const current = result.rows.find((row) => row.period === "current");
    const previous = result.rows.find((row) => row.period === "previous");
    if (!current) return { available: false };

    const dateLabel = (date) => new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date);

    return {
      available: true,
      periodLabel: `${dateLabel(startUTC)} through ${dateLabel(referenceDate)}`,
      visits: Number(current.visits || 0),
      purchases: Number(current.purchases || 0),
      revenue: Number(current.revenue || 0),
      revenueAvailable: Number(current.priced_purchases || 0) > 0,
      previous: previous
        ? {
            visits: Number(previous.visits || 0),
            purchases: Number(previous.purchases || 0),
            revenue: Number(previous.revenue || 0),
            revenueAvailable: Number(previous.priced_purchases || 0) > 0,
          }
        : {},
    };
  } catch (error) {
    console.error("[WEEKLY REVENUE QUERY ERROR]", {
      message: error?.message,
      code: error?.code,
    });
    return { available: false };
  }
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

  if (revenue === null && purchases === 0) {
    lines.push(
      `For ${period}, REDEN has not received any purchase records, so there is no recorded sales amount to total. This does not by itself prove that no sales happened if purchase tracking is incomplete.`
    );
  } else if (revenue === null) {
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
        "No recorded sales were available in the comparable period last week, so a percentage change cannot be calculated."
      );
    }
  }

  lines.push("These figures reflect purchase activity REDEN received. They do not confirm payment settlement, refunds, costs, or profit.");
  return lines.join(" ");
}
