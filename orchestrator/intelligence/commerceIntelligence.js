async function safeCommerceQuery(db, sql, params, label) {
  try {
    return await db.query(sql, params);
  } catch (error) {
    console.error("[COMMERCE INTELLIGENCE QUERY ERROR]", label, error);
    return { rows: [] };
  }
}

export async function recordIdentifiedOrder(client, order) {
  if (!order?.orderId) return false;
  const result = await client.query(
    `
      INSERT INTO commerce_orders (
        site_id, order_id, session_id, event_id, cart_id, customer_ref,
        total, currency, status, items, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW(), NOW())
      ON CONFLICT (site_id, order_id) DO NOTHING
      RETURNING id
    `,
    [order.siteId, order.orderId, order.sessionId, order.eventId, order.cartId,
      order.customerRef, order.total, order.currency, order.status,
      JSON.stringify(order.items || [])]
  );
  return result.rowCount > 0;
}

export async function loadCommerceIntelligence(db, { siteId, startUTC, endUTC }) {
  const [purchaseResult, productResult, customerResult] = await Promise.all([
    safeCommerceQuery(db,
      `
        WITH identified_orders AS (
          SELECT session_id, total AS amount, 'identified'::TEXT AS identity_type
          FROM commerce_orders
          WHERE site_id = $1 AND created_at >= $2 AND created_at < $3
        ),
        legacy_purchase_events AS (
          SELECT session_id,
            COALESCE(
              NULLIF(payload->>'revenue', ''), NULLIF(payload->>'total', ''),
              NULLIF(payload->>'value', ''), NULLIF(payload->>'order_total', ''),
              NULLIF(payload->>'orderTotal', ''), NULLIF(payload->>'amount', ''),
              NULLIF(payload->>'cart_value', ''), NULLIF(payload->>'cartValue', ''),
              NULLIF(payload #>> '{cart,value}', '')
            ) AS amount_text
          FROM event_logs
          WHERE site_id = $1 AND event = 'PURCHASE'
            AND created_at >= $2 AND created_at < $3
            AND COALESCE(
              NULLIF(payload->>'order_id', ''), NULLIF(payload->>'orderId', ''),
              NULLIF(payload #>> '{order,id}', '')
            ) IS NULL
        ),
        normalized_legacy AS (
          SELECT session_id,
            CASE WHEN amount_text ~ '^[0-9]+([.][0-9]+)?$'
              THEN amount_text::NUMERIC ELSE NULL END AS amount,
            'unidentified'::TEXT AS identity_type
          FROM legacy_purchase_events
        ),
        all_purchase_records AS (
          SELECT * FROM identified_orders
          UNION ALL
          SELECT * FROM normalized_legacy
        )
        SELECT
          COALESCE(SUM(amount), 0)::NUMERIC AS revenue,
          COUNT(DISTINCT session_id)::INTEGER AS purchased_sessions,
          COUNT(*) FILTER (WHERE amount IS NOT NULL)::INTEGER AS priced_purchase_records,
          COUNT(*) FILTER (WHERE identity_type = 'identified')::INTEGER AS identified_orders,
          COUNT(*) FILTER (WHERE identity_type = 'unidentified')::INTEGER AS unidentified_purchase_events,
          COUNT(*)::INTEGER AS purchase_records
        FROM all_purchase_records
      `,
      [siteId, startUTC, endUTC]
    ),
    safeCommerceQuery(db,
      `
        WITH product_events AS (
          SELECT el.event, el.payload AS item_data
          FROM event_logs el
          WHERE el.site_id = $1 AND el.event IN ('PRODUCT_VIEW', 'ADD_TO_CART')
            AND el.created_at >= $2 AND el.created_at < $3
            AND CASE WHEN jsonb_typeof(el.payload->'items') = 'array'
              THEN jsonb_array_length(el.payload->'items') = 0 ELSE TRUE END
          UNION ALL
          SELECT el.event, expanded.item_data
          FROM event_logs el
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(el.payload->'items') = 'array'
              THEN el.payload->'items' ELSE '[]'::jsonb END
          ) AS expanded(item_data)
          WHERE el.site_id = $1 AND el.event IN ('PRODUCT_VIEW', 'ADD_TO_CART')
            AND el.created_at >= $2 AND el.created_at < $3
          UNION ALL
          SELECT 'PURCHASE'::TEXT AS event, expanded.item_data
          FROM commerce_orders co
          CROSS JOIN LATERAL jsonb_array_elements(co.items) AS expanded(item_data)
          WHERE co.site_id = $1 AND co.created_at >= $2 AND co.created_at < $3
          UNION ALL
          SELECT el.event, el.payload AS item_data
          FROM event_logs el
          WHERE el.site_id = $1 AND el.event = 'PURCHASE'
            AND el.created_at >= $2 AND el.created_at < $3
            AND COALESCE(
              NULLIF(el.payload->>'order_id', ''), NULLIF(el.payload->>'orderId', ''),
              NULLIF(el.payload #>> '{order,id}', '')
            ) IS NULL
            AND CASE WHEN jsonb_typeof(el.payload->'items') = 'array'
              THEN jsonb_array_length(el.payload->'items') = 0 ELSE TRUE END
          UNION ALL
          SELECT el.event, expanded.item_data
          FROM event_logs el
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(el.payload->'items') = 'array'
              THEN el.payload->'items' ELSE '[]'::jsonb END
          ) AS expanded(item_data)
          WHERE el.site_id = $1 AND el.event = 'PURCHASE'
            AND el.created_at >= $2 AND el.created_at < $3
            AND COALESCE(
              NULLIF(el.payload->>'order_id', ''), NULLIF(el.payload->>'orderId', ''),
              NULLIF(el.payload #>> '{order,id}', '')
            ) IS NULL
        )
        SELECT
          COALESCE(NULLIF(item_data->>'product_id', ''), NULLIF(item_data->>'productId', '')) AS product_id,
          MAX(COALESCE(item_data->>'product_name', item_data->>'name', item_data->>'title')) AS product_name,
          MAX(item_data->>'sku') AS sku,
          MAX(item_data->>'category') AS category,
          COUNT(*) FILTER (WHERE event = 'PRODUCT_VIEW')::INTEGER AS product_views,
          COUNT(*) FILTER (WHERE event = 'ADD_TO_CART')::INTEGER AS add_to_cart_events,
          COUNT(*) FILTER (WHERE event = 'PURCHASE')::INTEGER AS purchase_line_items,
          COUNT(*) FILTER (
            WHERE event = 'PURCHASE'
              AND COALESCE(item_data->>'unit_price', item_data->>'price', '') ~ '^[0-9]+([.][0-9]+)?$'
          )::INTEGER AS priced_purchase_lines,
          COALESCE(SUM(
            CASE WHEN event = 'ADD_TO_CART'
              AND COALESCE(item_data->>'quantity', item_data->>'qty', '1') ~ '^[0-9]+([.][0-9]+)?$'
              THEN COALESCE(item_data->>'quantity', item_data->>'qty', '1')::NUMERIC
              ELSE 0 END
          ), 0)::NUMERIC AS cart_quantity,
          COALESCE(SUM(
            CASE WHEN event = 'PURCHASE'
              AND COALESCE(item_data->>'unit_price', item_data->>'price', '') ~ '^[0-9]+([.][0-9]+)?$'
              AND COALESCE(item_data->>'quantity', item_data->>'qty', '1') ~ '^[0-9]+([.][0-9]+)?$'
              THEN COALESCE(item_data->>'unit_price', item_data->>'price', '0')::NUMERIC
                * COALESCE(item_data->>'quantity', item_data->>'qty', '1')::NUMERIC
              ELSE 0 END
          ), 0)::NUMERIC AS item_revenue,
          MAX(item_data->>'currency') AS currency
        FROM product_events
        WHERE COALESCE(NULLIF(item_data->>'product_id', ''), NULLIF(item_data->>'productId', '')) IS NOT NULL
        GROUP BY 1
        ORDER BY item_revenue DESC, purchase_line_items DESC, product_views DESC
        LIMIT 20
      `,
      [siteId, startUTC, endUTC]
    ),
    safeCommerceQuery(db,
      `
        WITH current_customers AS (
          SELECT DISTINCT customer_ref
          FROM commerce_orders
          WHERE site_id = $1 AND created_at >= $2 AND created_at < $3
            AND customer_ref IS NOT NULL
        ),
        prior_customer_orders AS (
          SELECT customer_ref, COUNT(*)::INTEGER AS prior_orders
          FROM commerce_orders
          WHERE site_id = $1 AND created_at < $2 AND customer_ref IS NOT NULL
          GROUP BY customer_ref
        )
        SELECT
          (SELECT COUNT(*) FROM current_customers)::INTEGER AS identified_customers,
          COUNT(*) FILTER (WHERE COALESCE(p.prior_orders, 0) > 0)::INTEGER AS returning_customers,
          COUNT(*) FILTER (WHERE COALESCE(p.prior_orders, 0) = 0)::INTEGER AS first_time_identified_customers
        FROM current_customers c
        LEFT JOIN prior_customer_orders p USING (customer_ref)
      `,
      [siteId, startUTC, endUTC]
    ),
  ]);

  const purchase = purchaseResult.rows?.[0] || {};
  const customer = customerResult.rows?.[0] || {};
  return {
    purchaseRevenue: Number(purchase.revenue || 0),
    purchasedSessions: Number(purchase.purchased_sessions || 0),
    purchaseRevenueAvailable: Number(purchase.priced_purchase_records || 0) > 0,
    purchaseRecords: Number(purchase.purchase_records || 0),
    identifiedOrders: Number(purchase.identified_orders || 0),
    pricedPurchaseRecords: Number(purchase.priced_purchase_records || 0),
    unidentifiedPurchaseEvents: Number(purchase.unidentified_purchase_events || 0),
    productPerformance: (productResult.rows || []).map((row) => ({
      productId: row.product_id,
      name: row.product_name || null,
      sku: row.sku || null,
      category: row.category || null,
      productViews: Number(row.product_views || 0),
      addToCartEvents: Number(row.add_to_cart_events || 0),
      purchaseLineItems: Number(row.purchase_line_items || 0),
      cartQuantity: Number(row.cart_quantity || 0),
      itemRevenue: Number(row.item_revenue || 0),
      pricedPurchaseLines: Number(row.priced_purchase_lines || 0),
      currency: row.currency || null,
    })),
    customerIntelligence: {
      identifiedCustomers: Number(customer.identified_customers || 0),
      returningCustomers: Number(customer.returning_customers || 0),
      firstTimeIdentifiedCustomers: Number(customer.first_time_identified_customers || 0),
      customerIdentityCoverage: "pseudonymous merchant-supplied customer_ref only",
    },
  };
}
