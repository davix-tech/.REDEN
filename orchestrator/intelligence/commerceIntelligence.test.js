import test from "node:test";
import assert from "node:assert/strict";
import {
  recordIdentifiedOrder,
  loadCommerceIntelligence,
} from "./commerceIntelligence.js";

test("records an order once using site-scoped order identity", async () => {
  let captured;
  const client = {
    async query(sql, params) {
      captured = { sql, params };
      return { rowCount: 1, rows: [{ id: 7 }] };
    },
  };
  const inserted = await recordIdentifiedOrder(client, {
    siteId: "site_1",
    orderId: "order_1",
    sessionId: "session_1",
    eventId: "event_1",
    cartId: "cart_1",
    customerRef: "customer_1",
    total: 5000,
    currency: "NGN",
    status: "paid",
    items: [{ product_id: "p1", quantity: 1 }],
  });
  assert.equal(inserted, true);
  assert.match(captured.sql, /ON CONFLICT \(site_id, order_id\) DO NOTHING/);
  assert.deepEqual(captured.params.slice(0, 6), [
    "site_1", "order_1", "session_1", "event_1", "cart_1", "customer_1",
  ]);
});

test("reports duplicate order insertions without incrementing the ledger", async () => {
  const client = { async query() { return { rowCount: 0, rows: [] }; } };
  const inserted = await recordIdentifiedOrder(client, { orderId: "already-recorded" });
  assert.equal(inserted, false);
});

test("maps purchase, product and pseudonymous customer evidence", async () => {
  const responses = [
    { rows: [{
      revenue: "75000",
      purchased_sessions: 4,
      priced_purchase_records: 3,
      identified_orders: 2,
      unidentified_purchase_events: 1,
      purchase_records: 3,
    }] },
    { rows: [{
      product_id: "p-1",
      product_name: "Blue Shirt",
      sku: "BLUE-1",
      category: "Apparel",
      product_views: 12,
      add_to_cart_events: 4,
      purchase_line_items: 2,
      priced_purchase_lines: 2,
      cart_quantity: "6",
      item_revenue: "25000",
      currency: "NGN",
    }] },
    { rows: [{
      identified_customers: 5,
      returning_customers: 2,
      first_time_identified_customers: 3,
    }] },
  ];
  let calls = 0;
  const db = {
    async query(sql, params) {
      assert.match(sql, /site_id = \$1/);
      assert.deepEqual(params, ["site_1", "2026-11-04T00:00:00Z", "2026-11-05T00:00:00Z"]);
      return responses[calls++];
    },
  };
  const result = await loadCommerceIntelligence(db, {
    siteId: "site_1",
    startUTC: "2026-11-04T00:00:00Z",
    endUTC: "2026-11-05T00:00:00Z",
  });
  assert.equal(calls, 3);
  assert.equal(result.purchaseRevenue, 75000);
  assert.equal(result.purchaseRevenueAvailable, true);
  assert.equal(result.identifiedOrders, 2);
  assert.equal(result.unidentifiedPurchaseEvents, 1);
  assert.equal(result.productPerformance[0].productId, "p-1");
  assert.equal(result.productPerformance[0].itemRevenue, 25000);
  assert.equal(result.customerIntelligence.returningCustomers, 2);
  assert.equal(JSON.stringify(result).includes("customer@example.com"), false);
});

test("isolates a failed product query instead of failing the entire intelligence response", async () => {
  let call = 0;
  const db = {
    async query() {
      call += 1;
      if (call === 2) throw new Error("product query unavailable");
      return { rows: [] };
    },
  };
  const result = await loadCommerceIntelligence(db, {
    siteId: "site_1",
    startUTC: "start",
    endUTC: "end",
  });
  assert.equal(call, 3);
  assert.deepEqual(result.productPerformance, []);
  assert.equal(result.purchaseRevenueAvailable, false);
  assert.equal(result.customerIntelligence.identifiedCustomers, 0);
});
