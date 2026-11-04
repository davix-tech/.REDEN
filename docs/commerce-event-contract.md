# REDEN commerce event contract

REDEN accepts the existing `Reden.track(event, payload, options)` interface. Existing integrations that send only a session ID and event name remain valid. Richer fields improve product, cart, order, customer and acquisition intelligence.

## Event identity

The SDK now generates a unique `event_id` for every tracking call. The backend enforces uniqueness per site. If an integration retries the same logical event itself, it should pass the same stable ID:

```js
await Reden.track("PURCHASE", purchasePayload, {
  eventId: `checkout-${order.id}-purchase`,
});
```

Do not reuse one event ID for different events. The backend acknowledges duplicate event IDs without incrementing session metrics or broadcasting another live update.

## Product views

```js
Reden.track("PRODUCT_VIEW", {
  product_id: product.id,
  product_name: product.name,
  sku: product.sku,
  variant_id: product.selectedVariantId,
  category: product.category,
  unit_price: product.price,
  currency: "NGN",
});
```

## Cart additions

```js
Reden.track("ADD_TO_CART", {
  cart_id: cart.id,
  product_id: product.id,
  product_name: product.name,
  sku: product.sku,
  variant_id: variant.id,
  quantity: 2,
  unit_price: product.price,
  currency: "NGN",
  cart_value: cart.total,
});
```

Use the same `cart_id` as the shopper progresses through the same cart.

## Checkout start

```js
Reden.track("CHECKOUT_STARTED", {
  cart_id: cart.id,
  cart_value: cart.total,
  currency: "NGN",
  customer_ref: customer.analyticsId,
  items: cart.items.map((item) => ({
    product_id: item.productId,
    sku: item.sku,
    name: item.name,
    variant_id: item.variantId,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    currency: "NGN",
  })),
});
```

If the existing recovery-email workflow needs an email address, it can continue receiving `email` or `customer_email` on checkout events. Those fields are not used as customer analytics identifiers and are stripped from the general event payload before it is stored.

## Purchase

```js
Reden.track("PURCHASE", {
  order_id: order.id,
  cart_id: order.cartId,
  customer_ref: customer.analyticsId,
  order_total: order.total,
  currency: "NGN",
  payment_status: "paid",
  items: order.items.map((item) => ({
    product_id: item.productId,
    sku: item.sku,
    name: item.name,
    variant_id: item.variantId,
    category: item.category,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    currency: "NGN",
  })),
});
```

`order_id` is essential for unique order reconciliation. The backend stores one order per site and order ID. A second purchase event carrying the same order ID is retained in the event log for audit, but it does not increment session revenue a second time.

Older integrations without an order ID continue to be accepted. Those purchase events are labelled unidentified and cannot be reliably deduplicated as orders.

## Customer identity and privacy

Supply a stable, merchant-generated pseudonymous `customer_ref` (for example, an internal analytics ID or a non-reversible identifier). Do not send email addresses, phone numbers, names, billing addresses or shipping addresses as customer analytics identifiers. REDEN rejects email- and phone-shaped customer references and does not expose customer references in merchant-facing summaries.

## Acquisition attribution

Automatic page-view tracking captures the landing path, referrer host and available `utm_source`, `utm_medium`, `utm_campaign`, `utm_term` and `utm_content` query parameters. The first-touch values are retained for the session and are not overwritten by later navigation.

Attribution reports describe sessions and recorded revenue by source/campaign. They are not ROAS or acquisition profitability. Those require campaign spend data.

## Data interpretation

- Product and cart events are event counts, not unique shoppers.
- A product-level revenue estimate requires product IDs, quantities and line-item prices.
- A verified unique order requires `order_id`.
- Customer cohort analysis requires a stable pseudonymous `customer_ref`.
- Recorded revenue is not profit or proof of settled payment.
- REDEN does not infer advertising ROI without campaign spend evidence.
