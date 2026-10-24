/**
 * Deterministic first-pass intent routing for REDEN intelligence.
 * Keep routing rules isolated and covered by unit tests; merchant facts
 * and business conclusions belong in the evidence/diagnostics layers.
 */

function normalizeQuestion(question) {
  return String(question ?? "")
    .slice(0, 2_000)
    .toLowerCase()
    .replace(/[^\w\s$%.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectIntents(question) {
  const q = normalizeQuestion(question);

  // Conversational turns should not fall through to a merchant analytics report.
  // REDEN identity is distinct from the connected merchant store identity.
  if (/\b(what is your name|what s your name|who are you|what is reden|what s reden|tell me about reden|who built you|who created you|which company (built|created) you)\b/.test(q)) {
    return ["reden_identity"];
  }

  // Route common e-commerce definitions to reviewed product knowledge.
  if (/\b(what is|what does|explain|define|meaning of|how does)\b/.test(q) &&
      /\b(conversion rate|purchase intent|abandoned cart|average order value|aov|ecommerce funnel|sales funnel|revenue|profit|reden|commerce orchestration|discount)\b/.test(q)) {
    return ["commerce_knowledge"];
  }

  if (/\b(what is my store called|what is my store name|what is this store called|which store is connected)\b/.test(q)) {
    return ["identity"];
  }
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|howdy|hiya)$/.test(q)) {
    return ["greeting"];
  }

  if (/^(thanks|thank you|thanks a lot|thank you very much|appreciate it)$/.test(q)) {
    return ["gratitude"];
  }

  if (/\b(what can you do|what do you do|how can you help|what can you help with|what are you capable of|help me use reden)\b/.test(q)) {
    return ["capabilities"];
  }

  // Growth questions need a prioritized action plan, not a list of metrics.
  if (
    /\bhow (can|could|do) (we|i) (earn|make|generate) more\b/.test(q) ||
    /\b(how to|ways to|help me) (increase|grow|boost) (sales|revenue|orders|profit)\b/.test(q) ||
    /\b(increase|grow|boost) (my |our |store )?(sales|revenue|orders|profit)\b/.test(q) ||
    /\bget more sales\b/.test(q)
  ) {
    return ["growth"];
  }

  const intents = [];

  if (/\b(who|identity|name|merchant|store|business|company)\b/.test(q)) {
    intents.push("identity");
  }

  if (
    /\b(revenue|income|money|earnings|earned|earn|turnover)\b/.test(q) ||
    /\bhow much (did|have) i (make|made|earn|earned)\b/.test(q) ||
    /\b(how much|total) (money|sales|revenue)\b/.test(q) ||
    /\bsales revenue\b/.test(q)
  ) {
    intents.push("revenue");
  }

  if (/\b(visitor|visitors|traffic|sessions|users|people)\b/.test(q)) {
    intents.push("traffic");
  }

  if (/\b(purchase|purchases|bought|orders|order|sales volume)\b/.test(q)) {
    intents.push("purchases");
  }

  if (/\b(conversion|conversions|convert|converted|rate)\b/.test(q)) {
    intents.push("conversion");
  }

  if (/\b(sales|sold|selling)\b/.test(q)) {
    intents.push("sales");
  }

  if (
    /\b(why|cause|reason|what changed|down|declin\w*|drop\w*|fall\w*|decreas\w*|less)\b/.test(q) &&
    /\b(sales|revenue|income|purchase|purchases|orders|conversion|turnover)\b/.test(q)
  ) {
    intents.push("diagnostic");
  }

  if (/\b(cart|checkout|checkouts|basket|abandon)\b/.test(q)) {
    intents.push("cart");
  }

  if (/\b(recovery|recover|recovered|recovery email)\b/.test(q)) {
    intents.push("recovery");
  }

  if (/\b(email|emails|mail|messages)\b/.test(q)) {
    intents.push("email");
  }

  if (/\b(product|products|interest|interested|viewed)\b/.test(q)) {
    intents.push("product_interest");
  }

  if (/\b(bandit|experiment|exploration|exploit|incentive|discount|offer|action)\b/.test(q)) {
    intents.push("bandit");
  }

  if (/\b(advice|recommend|recommendation|suggest|suggestion|what should|should i|how can|how do i|is it worth|improve|improvement)\b/.test(q)) {
    intents.push("advice");
  }

  if (/\b(overview|summary|performance|performing|doing|today)\b/.test(q)) {
    intents.push("overview");
  }

  if (/\b(funnel|journey|flow|stage|stages)\b/.test(q)) {
    intents.push("funnel");
  }

  if (/\b(channel|channels|source|sources|campaign|campaigns|ads|ad spend|marketing|attribution|utm|referral|social|organic|paid)\b/.test(q)) {
    intents.push("attribution");
  }

  const uniqueIntents = [...new Set(intents)];

  // Topic-specific decision questions should receive the knowledge-guided answer,
  // not a competing raw metric section such as bandit state.
  if (
    uniqueIntents.includes("advice") &&
    /\b(profit|profitable|profitability|margins?|discounts?|pricing|promotions?|repeat purchases?|retention|loyalty|churn|marketing|campaigns?|advertising|tracking|data quality)\b/.test(q) &&
    !uniqueIntents.includes("diagnostic")
  ) {
    return ["advice"];
  }

  // A direct earnings question should not inherit the "today" overview intent.
  if (
    /\bhow much (did|have) i (make|made|earn|earned)\b/.test(q) &&
    !uniqueIntents.includes("diagnostic")
  ) {
    return ["revenue"];
  }

  // A diagnostic question should receive the diagnosis first, not a generic
  // sales summary that can look like the answer to "why are sales down?".
  if (uniqueIntents.includes("diagnostic")) {
    return [
      "diagnostic",
      ...uniqueIntents.filter(
        (intent) => intent !== "diagnostic" &&
          intent !== "sales" &&
          intent !== "overview"
      ),
    ];
  }

  return uniqueIntents;
}
