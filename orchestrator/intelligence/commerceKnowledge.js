/**
 * REDEN's version-controlled starter knowledge pack.
 *
 * These are reviewed definitions and operating principles, not merchant data
 * and not a claim that a live language model or every integration is available.
 * Merchant-specific conclusions must come from authenticated store evidence.
 */
export const REDEN_PRODUCT_PROFILE = {
  name: "REDEN",
  maker: "PRETHIM",
  category: "adaptive commerce orchestration for e-commerce",
  purpose: "Turn supported storefront behaviour into evidence-based decisions, appropriate actions, and measurable outcomes.",
  positioning: "One integration. Every commerce capability.",
  productionLimit: "The product vision is broader than capabilities verified end to end in production. Do not claim an action or integration works without verification."
};

export const ECOMMERCE_KNOWLEDGE = [
  {
    id: "conversion-rate",
    patterns: [/\bconversion rate\b/i],
    answer: "Conversion rate is the proportion of a defined group of visitors or sessions that complete a chosen goal. For purchases, a session-based rate is purchasing sessions divided by eligible sessions, multiplied by 100. Define the denominator and time window consistently; raw event counts can mislead."
  },
  {
    id: "purchase-intent",
    patterns: [/\bpurchase intent\b/i],
    answer: "Purchase intent is an estimate of a shopper's likelihood to buy, inferred from observed behavioural signals. It is probabilistic, not certainty. Use only events the integration actually records and do not trigger incentives without sufficient confidence, eligibility, and margin checks."
  },
  {
    id: "cart-abandonment",
    patterns: [/\babandoned cart\b/i, /\bcart abandonment\b/i],
    answer: "Cart abandonment generally means a shopper adds an item to a cart but leaves without completing the purchase. Checkout-start events minus purchase events do not prove an abandonment count: link events to a shopper, session, or cart, deduplicate them, and account for delayed purchases and tracking failures."
  },
  {
    id: "average-order-value",
    patterns: [/\baverage order value\b/i, /\baov\b/i],
    answer: "Average order value (AOV) is total order revenue divided by valid orders in the same period. It is not profit. Refunds, discounts, taxes, currency, and duplicate purchase events need consistent treatment before comparing AOV."
  },
  {
    id: "commerce-funnel",
    patterns: [/\be-?commerce funnel\b/i, /\bsales funnel\b/i],
    answer: "An e-commerce funnel tracks progression through stages such as store visit, product view, add to cart, checkout, and purchase. Each rate needs a clear denominator and consistent session/order identity. Missing events can indicate broken tracking rather than customer drop-off."
  },
  {
    id: "revenue-versus-profit",
    patterns: [/\brevenue (and|vs|versus) profit\b/i, /\bdifference between revenue and profit\b/i, /\bwhat is profit\b/i],
    answer: "Revenue is money recorded from sales; profit is what remains after relevant costs. A contribution-profit estimate may subtract product cost, discounts, payment fees, fulfilment costs, and other variable costs from revenue. REDEN must not label recorded sales revenue as profit without cost inputs and a clear accounting basis."
  },
  {
    id: "discount-economics",
    patterns: [/\bwhy are discounts risky\b/i, /\bshould i give (a )?discount\b/i, /\bwhat is a discount\b/i],
    answer: "A discount may persuade some shoppers to buy, but it reduces the amount earned per order and may reward customers who would have bought anyway. Check contribution margin first, target only where evidence supports it, and compare results against a baseline or holdout."
  },
  {
    id: "reden-name",
    patterns: [/\\b(what is your name|what s your name|who are you)\\b/i],
    answer: "My name is REDEN. I’m PRETHIM’s commerce-intelligence assistant, designed to help merchants understand store performance and decide what to investigate or improve next."
  },
  {
    id: "reden-maker",
    patterns: [/\\b(who built you|who created you|which company (built|created) you)\\b/i],
    answer: "I’m being developed by PRETHIM, a technology company focused on using APIs and intelligent software systems to solve everyday technology problems."
  },
  {
    id: "reden-product",
    patterns: [/\bwhat is reden\b/i, /\bwhat s reden\b/i, /\btell me about reden\b/i, /\bwhat is commerce orchestration\b/i],
    answer: "REDEN is PRETHIM's e-commerce product. It is being built to turn storefront behaviour into evidence-based decisions, appropriate automated actions, and measured outcomes. Its code includes a storefront-event pipeline and an evolving commerce-intelligence layer; not every planned automation or adaptive capability has been verified as production-ready."
  },
  {
    id: "reden-workflow",
    patterns: [/\bhow does reden work\b/i, /\bhow do you work\b/i, /\bhow does it work\b/i],
    answer: "The intended cycle is to collect supported storefront events, analyse behaviour, evaluate an opportunity, choose an eligible action, and measure the outcome. The current implementation has parts of this pipeline, but each live integration and automated action must be verified before claiming the whole cycle works for a store."
  },
  {
    id: "cart-recovery",
    patterns: [/\bcart recovery\b/i, /\babandoned cart recovery\b/i],
    answer: "Cart recovery attempts to help an eligible shopper complete a purchase after cart or checkout inactivity. It requires a valid contact address, appropriate consent, suppression and opt-out handling, and a working delivery integration. Measure sent and delivered messages separately from subsequent orders; attribution alone does not prove incremental recovery."
  },
  {
    id: "marketing-attribution",
    patterns: [/\bmarketing attribution\b/i, /\battributed revenue\b/i],
    answer: "Attribution assigns credit for a conversion to a recorded source, touchpoint, or campaign under a chosen model. Attributed revenue is not automatically incremental revenue. Assess profitability only when campaign costs and defensible margin data are available."
  }
];

export function composeCommerceKnowledge(question = "") {
  const q = String(question ?? "").slice(0, 2_000);
  const match = ECOMMERCE_KNOWLEDGE.find((entry) =>
    entry.patterns.some((pattern) => pattern.test(q))
  );
  if (match) return match.answer;
  return "I can explain REDEN and common e-commerce concepts from my reviewed knowledge. I don’t have enough information to answer that exact question reliably yet; ask about conversion rate, purchase intent, cart abandonment, average order value, the sales funnel, cart recovery, or revenue versus profit.";
}
