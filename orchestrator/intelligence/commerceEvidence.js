const MAX_TEXT = 255;
const MAX_ITEMS = 100;

function text(value, max = MAX_TEXT) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).trim().slice(0, max);
  return result || null;
}

function number(value, { integer = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return integer ? Math.floor(parsed) : parsed;
}

function currency(value) {
  const normalized = text(value, 3)?.toUpperCase();
  return normalized && /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const productId = text(first(item.product_id, item.productId, item.id), 200);
  const sku = text(item.sku, 100);
  const name = text(first(item.product_name, item.productName, item.name, item.title), 255);
  const variantId = text(first(item.variant_id, item.variantId, item.variant?.id), 200);
  const quantity = number(first(item.quantity, item.qty), { integer: true });
  const unitPrice = number(first(item.unit_price, item.unitPrice, item.price));
  const itemCurrency = currency(first(item.currency, item.price_currency));
  const category = text(first(item.category, item.product_category), 150);
  const normalized = {};
  if (productId) normalized.product_id = productId;
  if (sku) normalized.sku = sku;
  if (name) normalized.name = name;
  if (variantId) normalized.variant_id = variantId;
  if (quantity !== null && quantity > 0) normalized.quantity = Math.min(quantity, 10000);
  if (unitPrice !== null) normalized.unit_price = Math.min(unitPrice, 1_000_000_000);
  if (itemCurrency) normalized.currency = itemCurrency;
  if (category) normalized.category = category;
  return Object.keys(normalized).length ? normalized : null;
}

function safeCustomerRef(value) {
  const candidate = text(value, 200);
  // Customer email addresses and phone-like identifiers are not accepted here.
  if (!candidate || candidate.includes("@") || /^\+?[0-9 ()-]{7,}$/.test(candidate)) return null;
  return /^[a-zA-Z0-9._:-]+$/.test(candidate) ? candidate : null;
}

export function normalizeCommercePayload(event, payload = {}) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
  const product = source.product && typeof source.product === "object" ? source.product : {};
  const cart = source.cart && typeof source.cart === "object" ? source.cart : {};
  const order = source.order && typeof source.order === "object" ? source.order : {};
  const customer = source.customer && typeof source.customer === "object" ? source.customer : {};

  const result = { ...source };
  const productId = text(first(source.product_id, source.productId, product.id), 200);
  const productName = text(first(source.product_name, source.productName, product.name, product.title), 255);
  const sku = text(first(source.sku, product.sku), 100);
  const variantId = text(first(source.variant_id, source.variantId, product.variant_id, product.variantId), 200);
  const category = text(first(source.category, source.product_category, product.category), 150);
  const quantity = number(first(source.quantity, source.qty), { integer: true });
  const unitPrice = number(first(source.unit_price, source.unitPrice, source.price, product.price));
  const cartId = text(first(source.cart_id, source.cartId, cart.id), 200);
  const orderId = text(first(source.order_id, source.orderId, order.id, source.transaction_id), 200);
  const orderTotal = number(first(source.order_total, source.orderTotal, order.total, source.total, source.revenue, source.amount));
  const customerRef = safeCustomerRef(first(source.customer_ref, source.customerRef, source.customer_id, source.customerId, customer.id));
  const normalizedCurrency = currency(first(source.currency, order.currency, cart.currency));

  if (productId) result.product_id = productId;
  if (productName) result.product_name = productName;
  if (sku) result.sku = sku;
  if (variantId) result.variant_id = variantId;
  if (category) result.category = category;
  if (quantity !== null && quantity > 0) result.quantity = Math.min(quantity, 10000);
  if (unitPrice !== null) result.unit_price = Math.min(unitPrice, 1_000_000_000);
  if (cartId) result.cart_id = cartId;
  if (orderId) result.order_id = orderId;
  if (orderTotal !== null) result.order_total = Math.min(orderTotal, 1_000_000_000);
  if (customerRef) result.customer_ref = customerRef;
  if (normalizedCurrency) result.currency = normalizedCurrency;

  const rawItems = Array.isArray(source.items)
    ? source.items
    : Array.isArray(cart.items)
      ? cart.items
      : Array.isArray(order.items)
        ? order.items
        : [];
  if (rawItems.length) {
    result.items = rawItems.slice(0, MAX_ITEMS).map(normalizeItem).filter(Boolean);
  }

  // Do not retain direct customer identifiers in the event payload.
  delete result.email;
  delete result.customer_email;
  delete result.customer;

  if (event === "PURCHASE" && !orderId) {
    result.order_identity_status = "missing_order_id";
  } else if (event === "PURCHASE") {
    result.order_identity_status = "identified";
  }

  return result;
}

export function normalizeAttribution(payload = {}, pagePath = null) {
  const source = payload && typeof payload === "object" ? payload : {};
  const result = {};
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
    const value = text(first(source[key], source[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())]), key === "utm_campaign" ? 255 : 150);
    if (value) result[key] = value;
  }

  const referrer = text(first(source.referrer, source.document_referrer), 2000);
  if (referrer) {
    try {
      const parsed = new URL(referrer);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        result.referrer_host = parsed.hostname.toLowerCase().slice(0, 255);
      }
    } catch {
      // Ignore malformed or non-web referrers.
    }
  }
  const landingPage = text(first(source.landing_page, pagePath), 1000);
  if (landingPage && landingPage.startsWith("/") && !landingPage.startsWith("//")) {
    result.landing_page = landingPage.split("?")[0].split("#")[0];
  }
  return result;
}

export function buildOrderRecord({ siteId, sessionId, eventId, payload }) {
  const orderId = text(payload?.order_id, 200);
  if (!orderId) return null;
  const items = Array.isArray(payload.items) && payload.items.length
    ? payload.items
    : normalizeItem(payload) ? [normalizeItem(payload)] : [];
  return {
    siteId,
    sessionId,
    eventId,
    orderId,
    cartId: text(payload.cart_id, 200),
    customerRef: safeCustomerRef(payload.customer_ref),
    total: number(first(payload.order_total, payload.revenue, payload.total)),
    currency: currency(payload.currency),
    status: text(first(payload.payment_status, payload.order_status), 50) || "purchase_event",
    items,
  };
}
