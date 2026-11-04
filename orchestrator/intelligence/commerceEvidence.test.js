import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCommercePayload,
  normalizeAttribution,
  buildOrderRecord,
} from "./commerceEvidence.js";

test("normalizes product identifiers, variants, prices, quantities and currency", () => {
  const result = normalizeCommercePayload("ADD_TO_CART", {
    product: { id: "p-17", title: "Blue Shirt", sku: "SHIRT-BLUE", variantId: "v-2", category: "Apparel", price: "12500" },
    quantity: "2",
    currency: "ngn",
    cart: { id: "cart-9" },
  });
  assert.equal(result.product_id, "p-17");
  assert.equal(result.product_name, "Blue Shirt");
  assert.equal(result.sku, "SHIRT-BLUE");
  assert.equal(result.variant_id, "v-2");
  assert.equal(result.category, "Apparel");
  assert.equal(result.quantity, 2);
  assert.equal(result.unit_price, 12500);
  assert.equal(result.currency, "NGN");
  assert.equal(result.cart_id, "cart-9");
});

test("normalizes item arrays and bounds malformed entries", () => {
  const result = normalizeCommercePayload("CHECKOUT_STARTED", {
    items: [
      { productId: "p1", qty: 1, price: 10 },
      null,
      { product_id: "p2", quantity: -3, price: "bad" },
    ],
  });
  assert.deepEqual(result.items, [
    { product_id: "p1", quantity: 1, unit_price: 10 },
    { product_id: "p2" },
  ]);
});

test("normalizes order and cart identity without requiring legacy integrations to supply them", () => {
  const result = normalizeCommercePayload("PURCHASE", {
    order: { id: "order-44", total: 25000, currency: "NGN", items: [{ id: "p1", quantity: 1, price: 25000 }] },
    cartId: "cart-8",
  });
  assert.equal(result.order_id, "order-44");
  assert.equal(result.order_total, 25000);
  assert.equal(result.cart_id, "cart-8");
  assert.equal(result.order_identity_status, "identified");

  const legacy = normalizeCommercePayload("PURCHASE", { revenue: 25000 });
  assert.equal(legacy.order_identity_status, "missing_order_id");
});

test("rejects email and phone values as customer reference identifiers", () => {
  const result = normalizeCommercePayload("PAGE_VIEW", {
    customer_id: "buyer@example.com",
    customer: { id: "+234 800 000 0000" },
  });
  assert.equal(result.customer_ref, undefined);
  assert.equal(result.customer, undefined);
});

test("normalizes first-touch campaign dimensions and safe referrer host", () => {
  const result = normalizeAttribution({
    utm_source: "instagram",
    utm_medium: "paid_social",
    utm_campaign: "november_launch",
    utm_term: "shirts",
    utm_content: "creative_a",
    referrer: "https://l.instagram.com/path?token=private",
  }, "/collections/shirts?email=private");
  assert.equal(result.utm_source, "instagram");
  assert.equal(result.utm_medium, "paid_social");
  assert.equal(result.utm_campaign, "november_launch");
  assert.equal(result.utm_term, "shirts");
  assert.equal(result.utm_content, "creative_a");
  assert.equal(result.referrer_host, "l.instagram.com");
  assert.equal(result.landing_page, "/collections/shirts");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("creates an order ledger record only when a stable order ID exists", () => {
  const payload = normalizeCommercePayload("PURCHASE", {
    order_id: "order-99",
    order_total: 5000,
    currency: "NGN",
    cart_id: "cart-1",
    customer_ref: "customer-abc",
    items: [{ product_id: "p-1", quantity: 2, price: 2500 }],
  });
  const record = buildOrderRecord({
    siteId: "site_1",
    sessionId: "session_1",
    eventId: "event_1",
    payload,
  });
  assert.equal(record.orderId, "order-99");
  assert.equal(record.total, 5000);
  assert.equal(record.currency, "NGN");
  assert.equal(record.customerRef, "customer-abc");
  assert.equal(record.items.length, 1);
  assert.equal(buildOrderRecord({ siteId: "site_1", sessionId: "s", eventId: "e", payload: {} }), null);
});

test("uses a purchase order total for session revenue and strips nested direct identifiers", () => {
  const result = normalizeCommercePayload("PURCHASE", {
    order: {
      id: "order-101",
      total: 18000,
      customer: { email: "buyer@example.com" },
      items: [{ product_id: "p-1", quantity: 2, price: 9000 }],
    },
    customer: { id: "customer-101", email: "buyer@example.com" },
    email: "buyer@example.com",
    phone: "+2348000000000",
  });
  assert.equal(result.order_id, "order-101");
  assert.equal(result.order_total, 18000);
  assert.equal(result.revenue, 18000);
  assert.equal(result.customer_ref, "customer-101");
  assert.equal(result.email, undefined);
  assert.equal(result.customer, undefined);
  assert.equal(result.order, undefined);
  assert.equal(result.phone, undefined);
  assert.equal(result.items[0].product_id, "p-1");
});
