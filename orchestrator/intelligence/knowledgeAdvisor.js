import { REDEN_KNOWLEDGE } from "./knowledgeBase.js";

const TOPIC_RULES = [
  { key: "profitability", pattern: /\b(profit|profitable|profitability|margin|margins|costs?|unit economics|break even|break-even)\b/ },
  { key: "pricing_and_promotions", pattern: /\b(discount|discounts|pricing|price|prices|promotion|promotions|coupon|coupons|offer|offers)\b/ },
  { key: "customer_retention", pattern: /\b(retain|retention|repeat purchase|repeat purchases|returning customers|loyalty|churn|customer lifetime)\b/ },
  { key: "marketing_effectiveness", pattern: /\b(marketing|campaign|campaigns|advertising|ad spend|paid traffic|acquisition|utm|traffic source)\b/ },
  { key: "data_quality", pattern: /\b(tracking|missing data|data quality|events missing|event tracking|inaccurate|wrong numbers|instrumentation)\b/ },
];

/**
 * Selects a reviewed knowledge domain for advice questions and keeps
 * general principles distinct from conclusions about a specific merchant.
 */
export function composeKnowledgeGuidance(question, evidence = {}) {
  const q = String(question ?? "").slice(0, 2_000).toLowerCase();
  const match = TOPIC_RULES.find((rule) => rule.pattern.test(q));
  if (!match) return null;

  const topic = REDEN_KNOWLEDGE[match.key];
  const principles = (topic.principles || topic.rules || []).slice(0, 3);
  const lines = [
    `${topic.title}:`,
    ...principles.map((principle) => `- ${principle}`),
  ];

  if (topic.first_checks?.length) {
    lines.push(`First checks: ${topic.first_checks.slice(0, 2).join("; ")}.`);
  }
  if (topic.measures?.length) {
    lines.push(`Measure the result using: ${topic.measures.slice(0, 3).join(", ")}.`);
  }

  if (match.key === "profitability") {
    lines.push("I cannot calculate verified profit from revenue alone. Product cost, discounts, payment fees, fulfilment costs, refunds, and other variable costs are needed.");
  } else if (match.key === "customer_retention") {
    lines.push("I do not have enough customer-cohort or repeat-purchase evidence in this response to diagnose your store specifically.");
  } else if (match.key === "marketing_effectiveness") {
    lines.push("Treat this as general guidance, not proof that a channel caused the observed sales. Channel cost and a comparable baseline are needed to assess profitability.");
  } else if (match.key === "pricing_and_promotions") {
    lines.push("Treat this as general guidance. Choose a promotion only after checking margin and measuring incremental outcomes.");
  } else if (match.key === "data_quality" && evidence.trafficBaseline?.status === "insufficient_history") {
    lines.push("REDEN currently lacks enough reliable historical traffic data for a confident comparison; missing events are not proof of zero activity.");
  }

  return lines.join("\n");
}
