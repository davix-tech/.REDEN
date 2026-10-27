import { db } from "../infrastructure/db.js";

export async function updateSessionContext({
  siteId,
  sessionId,
  event,
  payload = {},
}) {
  if (!siteId || !sessionId || !event) {
    return null;
  }

  try {
    const safePayload =
      payload && typeof payload === "object" ? payload : {};

    const cartValue = Number(
      safePayload.cart_value ??
      safePayload.cartValue ??
      safePayload.cart?.value ??
      0
    );

    const normalizedCartValue =
      Number.isFinite(cartValue) ? Math.max(0, cartValue) : 0;

    const revenue = Number(safePayload.revenue ?? 0);

    const normalizedRevenue =
      Number.isFinite(revenue) ? Math.max(0, revenue) : 0;

    const isPurchase = event === "PURCHASE";
    const isCheckout = event === "CHECKOUT_STARTED";
    const pageView = event === "PAGE_VIEW";
    const productView = event === "PRODUCT_VIEW";
    const addToCart = event === "ADD_TO_CART";

    await db.query(
      `
        INSERT INTO session_summaries (
          site_id,
          session_id,

          page_views,
          product_views,
          cart_additions,

          checkout_started,
          purchased,

          cart_value,
          revenue,
          intent_score,

          purchased_at,

          first_seen_at,
          last_seen_at,
          updated_at
        )

        VALUES (
          $1,
          $2,

          $3,
          $4,
          $5,

          $6,
          $7,

          $8,
          $9,
          LEAST(
            1,
            ($3 * 0.02) +
            ($4 * 0.08) +
            ($5 * 0.20) +
            CASE WHEN $6 THEN 0.30 ELSE 0 END +
            CASE WHEN $7 THEN 0.50 ELSE 0 END
          ),

          CASE WHEN $7 THEN NOW() ELSE NULL END,

          NOW(),
          NOW(),
          NOW()
        )

        ON CONFLICT (
          site_id,
          session_id
        )

        DO UPDATE SET

          page_views =
            session_summaries.page_views
            + EXCLUDED.page_views,

          product_views =
            session_summaries.product_views
            + EXCLUDED.product_views,

          cart_additions =
            session_summaries.cart_additions
            + EXCLUDED.cart_additions,

          checkout_started =
            session_summaries.checkout_started
            OR EXCLUDED.checkout_started,

          purchased =
            session_summaries.purchased
            OR EXCLUDED.purchased,

          cart_value =
            CASE
              WHEN EXCLUDED.cart_value > 0
              THEN EXCLUDED.cart_value
              ELSE session_summaries.cart_value
            END,

          /*
           * revenue ACCUMULATES across repeat purchases on the
           * same session_id (see original note: session_id
           * persists indefinitely in localStorage). Safe against
           * double-count because /event only calls this function
           * when the event_logs insert actually happened
           * (ON CONFLICT DO NOTHING already filtered retries).
           */
          revenue =
            session_summaries.revenue
            + EXCLUDED.revenue,

          /*
           * purchased_at tracks the MOST RECENT purchase event
           * on this session, not the first. This is what lets
           * "today's purchase revenue" queries filter correctly
           * by calendar day instead of drifting with unrelated
           * session activity (page views, cart edits, etc.)
           * the way updated_at did.
           *
           * KNOWN LIMITATION: because revenue is a single
           * cumulative total per session row, a session that
           * purchases on two different calendar days will have
           * its ENTIRE historical revenue attributed to
           * whichever day purchased_at last reflects. This is a
           * pre-existing consequence of the one-row-per-session
           * schema, not something this fix introduces -- flagging
           * it now so it's a known, documented tradeoff rather
           * than a surprise later. A per-purchase-event ledger
           * table would be the eventual correct fix if repeat
           * purchases across days become common.
           */
          purchased_at =
            CASE
              WHEN EXCLUDED.purchased
              THEN NOW()
              ELSE session_summaries.purchased_at
            END,

          last_seen_at = NOW(),

          /*
           * Keep the session-level intent proxy current for intelligence
           * queries. This is a deterministic behavioural score, not a
           * calibrated probability of purchase.
           */
          intent_score = LEAST(
            1,
            (
              (session_summaries.page_views + EXCLUDED.page_views) * 0.02 +
              (session_summaries.product_views + EXCLUDED.product_views) * 0.08 +
              (session_summaries.cart_additions + EXCLUDED.cart_additions) * 0.20 +
              CASE
                WHEN session_summaries.checkout_started OR EXCLUDED.checkout_started
                THEN 0.30
                ELSE 0
              END +
              CASE
                WHEN session_summaries.purchased OR EXCLUDED.purchased
                THEN 0.50
                ELSE 0
              END
            )
          ),

          updated_at = NOW()
      `,
      [
        siteId,
        sessionId,
        pageView ? 1 : 0,
        productView ? 1 : 0,
        addToCart ? 1 : 0,
        isCheckout,
        isPurchase,
        normalizedCartValue,
        normalizedRevenue,
      ]
    );

    return getSessionContext(siteId, sessionId);
  } catch (error) {
    console.error("[CONTEXT UPDATE ERROR]", error);
    return null;
  }
}

export async function getSessionContext(siteId, sessionId) {
  if (!siteId || !sessionId) {
    return null;
  }

  try {
    const result = await db.query(
      `
        SELECT
          session_id,
          page_views,
          product_views,
          cart_additions,
          checkout_started,
          purchased,
          cart_value,
          revenue,
          intent_score,
          purchased_at,
          first_seen_at,
          last_seen_at,
          updated_at
        FROM session_summaries
        WHERE site_id = $1
          AND session_id = $2
        LIMIT 1
      `,
      [siteId, sessionId]
    );

    if (!result.rowCount) {
      return null;
    }

    return result.rows[0];
  } catch (error) {
    console.error("[CONTEXT READ ERROR]", error);
    return null;
  }
}
