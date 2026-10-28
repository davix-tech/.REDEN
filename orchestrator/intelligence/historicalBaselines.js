/**
 * Historical same-time baselines for REDEN intelligence.
 *
 * These queries are read-only and tenant-scoped. Missing event streams are
 * treated as unknown rather than confirmed zero activity. The baseline is
 * advisory evidence, not a causal attribution model.
 */

const MIN_COMPARABLE_DAYS = 5;
const LOW_BASELINE_RATIO = 0.5;

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

const FUNNEL_STAGE_METRICS = {
  productView: {
    numerator: "productViewSessions",
    denominator: "pageViewSessions",
  },
  addToCart: {
    numerator: "addToCartSessions",
    denominator: "productViewSessions",
  },
  checkout: {
    numerator: "checkoutSessions",
    denominator: "addToCartSessions",
  },
  purchase: {
    numerator: "purchaseSessions",
    denominator: "checkoutSessions",
  },
};

function dailyRate(day, stage) {
  const metric = FUNNEL_STAGE_METRICS[stage];
  const denominator = day[metric.denominator];
  return denominator > 0 ? day[metric.numerator] / denominator : null;
}

export async function loadHistoricalBaselines({
  db,
  siteId,
  timeZone,
  baselineStartUTC,
  startUTC,
  endUTC,
  localDate,
  localTime,
}) {
  const empty = {
    revenueBaseline: {
      status: "insufficient_history",
      metric: "same_time_recorded_storefront_purchase_revenue",
      currentRevenue: null,
      averageRevenue: null,
      daysWithComparablePurchases: 0,
      windowDays: 7,
      comparisonThreshold: LOW_BASELINE_RATIO,
    },
    funnelBaseline: {
      status: "insufficient_history",
      metric: "conditional_session_funnel_rates",
      current: null,
      averages: null,
      daysWithTraffic: 0,
      windowDays: 7,
      comparisonThreshold: LOW_BASELINE_RATIO,
      lowStages: [],
    },
  };

  const eventDaysResult = await db.query(
    `
      WITH session_flags AS (
        SELECT
          (created_at AT TIME ZONE $2)::date::text AS local_date,
          session_id,
          MIN(created_at) FILTER (WHERE event = 'PAGE_VIEW') AS page_view_at,
          MIN(created_at) FILTER (WHERE event = 'PRODUCT_VIEW') AS product_view_at,
          MIN(created_at) FILTER (WHERE event = 'ADD_TO_CART') AS add_to_cart_at,
          MIN(created_at) FILTER (WHERE event = 'CHECKOUT_STARTED') AS checkout_started_at,
          MIN(created_at) FILTER (WHERE event = 'PURCHASE') AS purchase_at
        FROM event_logs
        WHERE site_id = $1
          AND created_at >= $3
          AND created_at < $4
          AND (created_at AT TIME ZONE $2)::time <= $5::time
        GROUP BY (created_at AT TIME ZONE $2)::date, session_id
      )
      SELECT
        local_date,
        COUNT(*) FILTER (
          WHERE page_view_at IS NOT NULL AND session_id IS NOT NULL
        )::INTEGER AS page_view_sessions,
        COUNT(*) FILTER (
          WHERE page_view_at IS NOT NULL
            AND product_view_at >= page_view_at
            AND session_id IS NOT NULL
        )::INTEGER AS product_view_sessions,
        COUNT(*) FILTER (
          WHERE page_view_at IS NOT NULL
            AND product_view_at >= page_view_at
            AND add_to_cart_at >= product_view_at
            AND session_id IS NOT NULL
        )::INTEGER AS add_to_cart_sessions,
        COUNT(*) FILTER (
          WHERE page_view_at IS NOT NULL
            AND product_view_at >= page_view_at
            AND add_to_cart_at >= product_view_at
            AND checkout_started_at >= add_to_cart_at
            AND session_id IS NOT NULL
        )::INTEGER AS checkout_sessions,
        COUNT(*) FILTER (
          WHERE page_view_at IS NOT NULL
            AND product_view_at >= page_view_at
            AND add_to_cart_at >= product_view_at
            AND checkout_started_at >= add_to_cart_at
            AND purchase_at >= checkout_started_at
            AND session_id IS NOT NULL
        )::INTEGER AS purchase_sessions,
        COUNT(*) FILTER (
          WHERE purchase_at IS NOT NULL AND session_id IS NOT NULL
        )::INTEGER AS purchase_event_sessions
      FROM session_flags
      GROUP BY local_date
      ORDER BY local_date
    `,
    [siteId, timeZone, baselineStartUTC, endUTC, localTime]
  );

  const revenueDaysResult = await db.query(
    `
      WITH purchase_sessions AS (
        SELECT
          site_id,
          session_id,
          (created_at AT TIME ZONE $2)::date AS purchase_local_date
        FROM event_logs
        WHERE site_id = $1
          AND event = 'PURCHASE'
          AND created_at >= $3
          AND created_at < $4
          AND (created_at AT TIME ZONE $2)::time <= $5::time
        GROUP BY
          site_id,
          session_id,
          (created_at AT TIME ZONE $2)::date
      )
      SELECT
        (ss.purchased_at AT TIME ZONE $2)::date::text AS local_date,
        COALESCE(SUM(ss.revenue), 0)::NUMERIC AS revenue,
        COUNT(*) FILTER (WHERE ss.purchased = TRUE)::INTEGER AS purchased_sessions
      FROM session_summaries ss
      JOIN purchase_sessions ps
        ON ps.site_id = ss.site_id
        AND ps.session_id = ss.session_id
        AND ps.purchase_local_date = (ss.purchased_at AT TIME ZONE $2)::date
      WHERE ss.site_id = $1
        AND ss.purchased = TRUE
        AND ss.purchased_at >= $3
        AND ss.purchased_at < $4
        AND (ss.purchased_at AT TIME ZONE $2)::time <= $5::time
      GROUP BY (ss.purchased_at AT TIME ZONE $2)::date
      ORDER BY local_date
    `,
    [siteId, timeZone, baselineStartUTC, endUTC, localTime]
  );

  const eventDays = new Map(eventDaysResult.rows.map((row) => [
    row.local_date,
    {
      date: row.local_date,
      pageViewSessions: asNumber(row.page_view_sessions),
      productViewSessions: asNumber(row.product_view_sessions),
      addToCartSessions: asNumber(row.add_to_cart_sessions),
      checkoutSessions: asNumber(row.checkout_sessions),
      purchaseSessions: asNumber(row.purchase_sessions),
      purchaseEventSessions: asNumber(row.purchase_event_sessions),
    },
  ]));
  const revenueDays = new Map(revenueDaysResult.rows.map((row) => [
    row.local_date,
    {
      revenue: asNumber(row.revenue),
      purchasedSessions: asNumber(row.purchased_sessions),
    },
  ]));

  const current = eventDays.get(localDate) ?? {
    date: localDate,
    pageViewSessions: 0,
    productViewSessions: 0,
    addToCartSessions: 0,
    checkoutSessions: 0,
    purchaseSessions: 0,
    purchaseEventSessions: 0,
  };
  const currentRevenueRow = revenueDays.get(localDate) ?? null;

  const historicalTrafficDays = [...eventDays.values()].filter(
    (day) => day.date < localDate && day.pageViewSessions > 0
  );

  const funnelAverages = {};
  const funnelDaysByStage = {};
  for (const stage of Object.keys(FUNNEL_STAGE_METRICS)) {
    const denominatorKey = FUNNEL_STAGE_METRICS[stage].denominator;
    // Include zero stage counts when the preceding stage has recorded sessions.
    // A zero may still indicate a tracking problem, so it is not treated as a
    // confirmed current-day decline without a separate instrumentation check.
    const observedStageDays = historicalTrafficDays.filter(
      (day) => day[denominatorKey] > 0
    );
    funnelDaysByStage[stage] = observedStageDays.length;
    funnelAverages[stage] = average(
      observedStageDays
        .map((day) => dailyRate(day, stage))
        .filter((rate) => rate !== null)
    );
  }

  const currentRates = {};
  for (const stage of Object.keys(FUNNEL_STAGE_METRICS)) {
    currentRates[stage] = dailyRate(current, stage);
  }

  const funnelBaseline = {
    ...empty.funnelBaseline,
    current: {
      pageViewSessions: current.pageViewSessions,
      productViewSessions: current.productViewSessions,
      addToCartSessions: current.addToCartSessions,
      checkoutSessions: current.checkoutSessions,
      purchaseSessions: current.purchaseSessions,
      rates: currentRates,
    },
    averages: funnelAverages,
    daysByStage: funnelDaysByStage,
    daysWithTraffic: historicalTrafficDays.length,
    trackingValidationStages: [],
  };

  // A zero current-stage count after meaningful upstream traffic is ambiguous:
  // it may be a real funnel break or a missing event integration. Surface it
  // explicitly so REDEN recommends validation rather than silently hiding it.
  for (const [stage, metric] of Object.entries(FUNNEL_STAGE_METRICS)) {
    const denominator = current[metric.denominator];
    const stageCount = current[metric.numerator];
    if (
      historicalTrafficDays.length >= MIN_COMPARABLE_DAYS &&
      funnelDaysByStage[stage] >= MIN_COMPARABLE_DAYS &&
      denominator >= 5 &&
      stageCount === 0 &&
      Number(funnelAverages[stage]) > 0
    ) {
      funnelBaseline.trackingValidationStages.push(stage);
    }
  }

  if (historicalTrafficDays.length >= MIN_COMPARABLE_DAYS) {
    funnelBaseline.status = "available";
    funnelBaseline.lowStages = Object.entries(funnelAverages)
      .filter(([stage, baselineRate]) => {
        const currentRate = currentRates[stage];
        const currentStageCount = current[FUNNEL_STAGE_METRICS[stage].numerator];
        const currentDenominator = current[FUNNEL_STAGE_METRICS[stage].denominator];
        // A zero count can indicate missing instrumentation. Do not label it
        // a confirmed conversion decline without an independent tracking check.
        return current.pageViewSessions >= 5 &&
          currentDenominator > 0 &&
          currentStageCount > 0 &&
          baselineRate > 0 &&
          funnelDaysByStage[stage] >= MIN_COMPARABLE_DAYS &&
          currentRate < baselineRate * LOW_BASELINE_RATIO;
      })
      .map(([stage]) => stage);
    if (funnelBaseline.lowStages.length) {
      funnelBaseline.status = "below_baseline";
    }
  }

  const historicalPurchaseDays = [...eventDays.values()]
    .filter((day) => day.date < localDate && day.pageViewSessions > 0 &&
      day.purchaseEventSessions > 0)
    .filter((day) => {
      const revenueDay = revenueDays.get(day.date);
      return revenueDay && revenueDay.purchasedSessions > 0;
    });
  const historicalRevenue = historicalPurchaseDays.map(
    (day) => revenueDays.get(day.date).revenue
  );
  const averageRevenue = average(historicalRevenue);

  const revenueBaseline = {
    ...empty.revenueBaseline,
    currentRevenue: currentRevenueRow?.revenue ?? null,
    averageRevenue,
    daysWithComparablePurchases: historicalPurchaseDays.length,
  };

  if (current.purchaseEventSessions === 0) {
    revenueBaseline.status = "purchase_tracking_unconfirmed";
  } else if (!currentRevenueRow || currentRevenueRow.purchasedSessions === 0) {
    revenueBaseline.status = "purchase_summary_mismatch";
  } else if (
    historicalPurchaseDays.length >= MIN_COMPARABLE_DAYS &&
    averageRevenue !== null &&
    averageRevenue > 0
  ) {
    revenueBaseline.status =
      currentRevenueRow.revenue < averageRevenue * LOW_BASELINE_RATIO
        ? "below_baseline"
        : "not_markedly_below_baseline";
  }

  return { revenueBaseline, funnelBaseline };
}
