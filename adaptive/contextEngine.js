import { db } from "../infrastructure/db.js";

/* =========================================================
   EVENT → SESSION CONTEXT
========================================================= */

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
      payload &&
      typeof payload === "object"
        ? payload
        : {};

    const cartValue =
      Number(
        safePayload.cart_value ??
        safePayload.cartValue ??
        safePayload.cart?.value ??
        0
      );

    const normalizedCartValue =
      Number.isFinite(cartValue)
        ? Math.max(
            0,
            cartValue
          )
        : 0;

    const revenue =
      Number(
        safePayload.revenue ??
        0
      );

    const normalizedRevenue =
      Number.isFinite(revenue)
        ? Math.max(
            0,
            revenue
          )
        : 0;

    const isPurchase =
      event === "PURCHASE";

    const isCheckout =
      event ===
      "CHECKOUT_STARTED";

    const pageView =
      event ===
      "PAGE_VIEW";

    const productView =
      event ===
      "PRODUCT_VIEW";

    const addToCart =
      event ===
      "ADD_TO_CART";

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
           * IMPORTANT: revenue ACCUMULATES, unlike cart_value.
           *
           * cart_value is a live snapshot of "what's in the
           * cart right now" -- replacing it on each update is
           * correct.
           *
           * revenue represents realized purchase amounts. If
           * this session/browser (session_id persists in
           * localStorage indefinitely -- it is never cleared,
           * not even on SESSION_END) completes more than one
           * purchase over time, each purchase's revenue must
           * be added to the running total, not overwrite the
           * previous one. The prior "replace if positive"
           * logic silently discarded all but the most recent
           * purchase's revenue for any repeat-purchasing
           * session, which is why dashboard revenue reflected
           * only the latest purchase rather than a true sum.
           *
           * This is safe against double-counting from retried
           * requests: updateSessionContext() is only invoked
           * by /event when the underlying event insert into
           * event_logs actually happened (i.e. "recorded" is
           * true). Duplicate event_ids are rejected at the
           * database level via
           * ON CONFLICT (site_id, event_id) DO NOTHING before
           * this function is ever called, so a retried
           * PURCHASE event cannot add its revenue twice.
           */
          revenue =
            session_summaries.revenue
            + EXCLUDED.revenue,

          last_seen_at =
            NOW(),

          updated_at =
            NOW()
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

    return getSessionContext(
      siteId,
      sessionId
    );
  } catch (error) {
    console.error(
      "[CONTEXT UPDATE ERROR]",
      error
    );

    return null;
  }
}

/* =========================================================
   READ SESSION CONTEXT
========================================================= */

export async function getSessionContext(
  siteId,
  sessionId
) {
  if (!siteId || !sessionId) {
    return null;
  }

  try {
    const result =
      await db.query(
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

            first_seen_at,
            last_seen_at,

            updated_at

          FROM session_summaries

          WHERE site_id = $1
            AND session_id = $2

          LIMIT 1
        `,
        [
          siteId,
          sessionId,
        ]
      );

    if (!result.rowCount) {
      return null;
    }

    return result.rows[0];
  } catch (error) {
    console.error(
      "[CONTEXT READ ERROR]",
      error
    );

    return null;
  }
}
