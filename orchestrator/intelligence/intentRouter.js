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

  if (/\b(advice|recommend|recommendation|suggest|suggestion|what should|how can|improve|improvement)\b/.test(q)) {
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
