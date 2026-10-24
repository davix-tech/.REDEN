import { REDEN_KNOWLEDGE, REDEN_KNOWLEDGE_VERSION } from "./knowledgeBase.js";

/**
 * Deterministic product and conversation knowledge. This is reviewed,
 * version-controlled knowledge, not a claim that REDEN has a connected
 * general-purpose language model or live internet access.
 */
export const REDEN_RESPONSE_POLICY_VERSION = "2026-10-24.2";

const PRODUCT_KNOWLEDGE = [
  {
    pattern: /\b(what is reden|what s reden|tell me about reden|what is commerce orchestration)\b/i,
    answer: "REDEN is PRETHIM's e-commerce product. It is being built to turn storefront behaviour into evidence-based decisions, appropriate automated actions, and measured outcomes. Its code includes a storefront-event pipeline and an evolving commerce-intelligence layer; not every planned automation or adaptive capability has been verified as production-ready."
  },
  {
    pattern: /\b(what is your name|what s your name|who are you)\b/i,
    answer: "My name is REDEN. I’m PRETHIM’s commerce-intelligence assistant, designed to help merchants understand store performance and decide what to investigate or improve next."
  },
  {
    pattern: /\b(who built you|who created you|which company (built|created) you)\b/i,
    answer: "I’m being developed by PRETHIM, a technology company focused on using APIs and intelligent software systems to solve everyday technology problems."
  },
  {
    pattern: /\b(how does reden work|how do you work|how does it work)\b/i,
    answer: "The intended cycle is: collect supported storefront events, analyse behaviour, evaluate an opportunity, choose an eligible action, and measure the outcome. The current implementation has parts of this pipeline, but each live integration and automated action must be verified before I can claim the whole cycle is working for your store."
  },
  {
    pattern: /\b(conversion rate)\b/i,
    answer: "Conversion rate is the share of a defined group of visitors or sessions that complete a chosen goal. For store purchases, a session-based rate is typically purchasing sessions divided by eligible sessions, multiplied by 100. The numerator, denominator, and time window must be consistent; raw event counts alone can mislead."
  },
  {
    pattern: /\b(purchase intent)\b/i,
    answer: "Purchase intent is an estimate of how likely a visitor is to buy, inferred from observed signals such as product views, cart activity, and checkout progress. It is not certainty. REDEN should use only signals its integration actually records and avoid incentives when confidence or eligibility is insufficient."
  },
  {
    pattern: /\b(abandoned cart|cart abandonment)\b/i,
    answer: "Cart abandonment generally means a shopper adds an item to a cart but leaves without completing the purchase. A checkout-start event minus purchase events is not enough to count abandoned carts: events need to be linked to a shopper, session, or cart, deduplicated, and checked against purchase tracking."
  },
  {
    pattern: /\b(average order value|aov)\b/i,
    answer: "Average order value (AOV) is total order revenue divided by the number of valid orders in the same period. It is not profit. Refunds, discounts, taxes, currency, and duplicate purchase events need consistent treatment before comparing AOV."
  },
  {
    pattern: /\b(ecommerce funnel|e-commerce funnel|sales funnel)\b/i,
    answer: "An e-commerce funnel tracks progression through stages such as store visit, product view, add to cart, checkout, and purchase. Each rate needs a clear denominator and consistent session/order identity. Missing events can indicate broken tracking rather than customer drop-off."
  },
  {
    pattern: /\b(revenue (and|vs|versus) profit|difference between revenue and profit|what is profit)\b/i,
    answer: "Revenue is money recorded from sales; profit is what remains after the relevant costs. A useful contribution-profit estimate may subtract product cost, discounts, payment fees, fulfilment costs, and other variable costs from revenue. REDEN must not label recorded sales revenue as profit without those cost inputs and a clear accounting basis."
  },
  {
    pattern: /\b(why are discounts risky|should i give (a )?discount|what is a discount)\b/i,
    answer: "A discount may persuade some shoppers to buy, but it also reduces the amount earned on each order and may reward customers who would have bought anyway. Check contribution margin first, target only where evidence supports it, and compare results against a baseline or holdout."
  }
];

export function composeCommerceKnowledge(question = "") {
  const q = String(question ?? "").slice(0, 2_000);
  const match = PRODUCT_KNOWLEDGE.find((entry) => entry.pattern.test(q));
  if (match) return match.answer;

  return "I can explain REDEN and common e-commerce concepts from my reviewed knowledge. I don’t have enough information to answer that exact question reliably yet; ask about conversion rate, purchase intent, cart abandonment, average order value, the sales funnel, or revenue versus profit.";
}

export function composeConversationResponse(intent, question = "") {
  const policy = REDEN_KNOWLEDGE.conversation_policy;

  switch (intent) {
    case "greeting":
      return "Hi. I’m REDEN, PRETHIM’s commerce-intelligence assistant. I can help explain e-commerce concepts and investigate your store’s recorded sales, traffic, conversion, checkout, recovery, and possible next steps.";

    case "gratitude":
      return "You’re welcome. What would you like to understand or improve next?";

    case "capabilities":
      return "I can answer basic questions about REDEN and e-commerce, summarise recorded store activity, investigate supported funnel signals, review recovery and decision activity, and suggest evidence-based next steps. I’ll distinguish measured facts from hypotheses. Automated actions and store-specific conclusions depend on working integrations and reliable data.";

    case "reden_identity":
    case "commerce_knowledge":
      return composeCommerceKnowledge(question);

    case "general_help":
      return "I’m REDEN, PRETHIM’s commerce-intelligence assistant. I can answer some common e-commerce questions and help with your store’s recorded sales, traffic, conversion, checkout, recovery, and practical next steps. For questions outside my reviewed knowledge or connected data, I’ll say what I can’t verify rather than guess.";

    default:
      return "I couldn’t determine a reliable response for that request. " + policy.response_shapes.out_of_scope + " (Knowledge version: " + REDEN_KNOWLEDGE_VERSION + ".)";
  }
}

export function getResponsePolicy() {
  return {
    version: REDEN_RESPONSE_POLICY_VERSION,
    knowledgeVersion: REDEN_KNOWLEDGE_VERSION,
    principles: [...REDEN_KNOWLEDGE.conversation_policy.principles],
    responseShapes: { ...REDEN_KNOWLEDGE.conversation_policy.response_shapes },
  };
}
