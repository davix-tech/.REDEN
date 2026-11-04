/**
 * Merchant-facing language boundary.
 *
 * Internal event names, decision states, and scoring terminology stay inside
 * REDEN. This deterministic pass translates known implementation vocabulary
 * in customer-facing answers without changing evidence or decision logic.
 */
const REPLACEMENTS = [
  [/\\bPURCHASE_INTENT\\b/g, "signs that a shopper may be ready to buy"],
  [/\\bHIGH_INTENT\\b/g, "strong signs of wanting to buy"],
  [/\\bLOW_INTENT\\b/g, "limited signs of wanting to buy"],
  [/\\bABANDONED_CART\\b/g, "a cart with items left before purchase"],
  [/\\bRECOVERY_SUCCESS\\b/g, "a sale recovered after a reminder"],
  [/\\bSESSION_SUMMARY\\b/g, "visit summary"],
  [/\\bBANDIT_STATE\\b/g, "REDEN's decision history"],
  [/\\bCONVERSION_DROP\\b/g, "fewer visitors completing purchases"],
  [/high-behavioural-intent session\(s\)/gi, "shoppers showing strong signs of wanting to buy"],
  [/high-behavioural-intent sessions?/gi, "shoppers showing strong signs of wanting to buy"],
  [/behavioural high-intent threshold/gi, "strong buying-signal threshold"],
  [/behavioural intent score/gi, "measure of shoppers' buying behaviour"],
  [/purchase-intent assessment/gi, "assessment of shoppers' buying behaviour"],
  [/intent score/gi, "buying-interest measure"],
  [/PURCHASE events?/g, "purchase records"],
  [/PAGE_VIEW/g, "store visits"],
  [/PRODUCT_VIEW/g, "product-page views"],
  [/ADD_TO_CART/g, "items added to cart"],
  [/CHECKOUT_STARTED/g, "checkouts started"],
  [/\bPURCHASE\b/g, "purchases"],
  [/SCORED\s*→\s*ACTIONED\s*→\s*COMPLETED/g, "recorded, carried out, and measured"],
  [/telemetry/gi, "store activity data"],
  [/instrumentation/gi, "tracking setup"],
  [/event tracking/gi, "store activity tracking"],
  [/behavioural proxy/gi, "indicator based on shopper behaviour"],
  [/high-intent/gi, "strong buying-interest"],
  [/low-intent/gi, "limited buying-interest"],
  [/intent_opportunities/gi, "buying opportunities"],
];

export function toMerchantLanguage(value) {
  if (typeof value !== "string" || !value) return value ?? "";
  return REPLACEMENTS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value
  );
}
