/**
 * REDEN's controlled merchant-language dictionary.
 *
 * Maps common merchant wording to canonical commerce concepts before
 * deterministic intent routing. Definitions and merchant-specific facts
 * remain in the reviewed knowledge and evidence layers.
 */
export const LANGUAGE_DICTIONARY_VERSION = "2026-11-04.1";

export const LANGUAGE_DICTIONARY = [
  {
    id: "revenue",
    canonical: "revenue",
    aliases: ["turnover", "takings", "gross takings", "sales income", "money made", "money earned"],
    meaning: "The value recorded from sales during a defined period, before subtracting business costs.",
    intent: "revenue",
  },
  {
    id: "traffic",
    canonical: "traffic",
    aliases: ["footfall", "foot traffic", "store traffic", "site traffic", "website traffic"],
    meaning: "Visits to a storefront. Traffic counts must distinguish sessions, people and page-view events.",
    intent: "traffic",
  },
  {
    id: "cart",
    canonical: "cart",
    aliases: ["basket", "shopping basket", "shopping bag"],
    meaning: "A collection of products a shopper intends to purchase.",
    intent: "cart",
  },
  {
    id: "cart-abandonment",
    canonical: "cart abandonment",
    aliases: ["basket abandonment", "basket drop off", "cart drop off"],
    meaning: "A shopper adds products to a cart but does not complete the purchase within the defined measurement window.",
    intent: "cart",
  },
  {
    id: "product-views",
    canonical: "product views",
    aliases: ["product page views", "product-page views", "product visits"],
    meaning: "Recorded views of product pages. These are events, not necessarily unique shoppers.",
    intent: "product_interest",
  },
  {
    id: "purchase-intent",
    canonical: "purchase intent",
    aliases: ["buying interest", "buying intent", "intent to buy"],
    meaning: "An estimate of buying interest inferred from observed shopper behaviour; it is not certainty that a shopper will purchase.",
    intent: "commerce_knowledge",
  },
  {
    id: "conversion-rate",
    canonical: "conversion rate",
    aliases: ["purchase rate", "sales conversion rate", "visitor-to-customer rate"],
    meaning: "The percentage of a clearly defined eligible group that completes a chosen goal during a stated period.",
    intent: "commerce_knowledge",
  },
  {
    id: "average-order-value",
    canonical: "average order value",
    aliases: ["aov", "average basket value", "average purchase value"],
    meaning: "Total qualifying order revenue divided by the number of qualifying orders in the same period.",
    intent: "commerce_knowledge",
  },
  {
    id: "profit",
    canonical: "profit",
    aliases: ["business profit", "net profit"],
    meaning: "The amount remaining after the relevant costs are deducted from revenue, using a clearly defined accounting basis.",
    intent: "commerce_knowledge",
  },
];

const ALIASES = LANGUAGE_DICTIONARY
  .flatMap((entry) => entry.aliases.map((alias) => ({ alias, canonical: entry.canonical })))
  .sort((a, b) => b.alias.length - a.alias.length);

export function normalizeMerchantQuestion(question) {
  let normalized = String(question ?? "").slice(0, 2_000).toLowerCase();
  normalized = normalized
    .replace(/[’']/g, "")
    .replace(/[^\\w\\s$%.-]/g, " ")
    .replace(/\\s+/g, " ")
    .trim();

  for (const { alias, canonical } of ALIASES) {
    const escaped = alias.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
    normalized = normalized.replace(
      new RegExp(`(^|\\\\b)${escaped}(?=$|\\\\b)`, "g"),
      (match, prefix) => `${prefix}${canonical}`
    );
  }

  return normalized.replace(/\\s+/g, " ").trim();
}

export function findDictionaryEntry(question) {
  const normalized = normalizeMerchantQuestion(question);
  return LANGUAGE_DICTIONARY.find((entry) =>
    new RegExp(`(^|\\\\b)${entry.canonical.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?=$|\\\\b)`).test(normalized)
  ) || null;
}
