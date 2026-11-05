/**
 * REDEN's no-provider conversational reasoning layer.
 *
 * This layer interprets common merchant-language paraphrases, resolves
 * context-dependent follow-ups, and assembles multiple evidence-backed
 * sections into one readable answer. It does not generate facts: all
 * merchant claims must still come from the existing evidence composers.
 */

const REFERENTIAL_FOLLOW_UP = /^(and why|why though|why is that|why did that happen|what caused it|what caused that|what about that|what about it|would that help|will that help|would that work|will that work|is that good|is that enough|what should i do about it|how do i fix that|how can i improve it|can you explain why|explain why)$/i;

const SEMANTIC_PATTERNS = [
  {
    pattern: /\b(nobody|no one|not many people|people are not|people aren't|customers are not|customers aren't)\s+(?:(?:is|are)\s+)?(buying|purchasing|checking out)\b|\b(sales are not moving|sales aren't moving|nothing is selling|visitors but no (sales|orders|purchases))\b/i,
    intents: ["diagnostic", "traffic", "purchases"],
  },
  {
    pattern: /\b(people|visitors|shoppers|customers)\s+(keep )?(leaving|dropping off|backing out)\b|\b(before|without)\s+(they )?(paying|purchasing|completing (the )?order)\b/i,
    intents: ["diagnostic", "cart", "funnel"],
  },
  {
    pattern: /\b(why|how come)\b.*\b(less|fewer|declining|dropping|falling)\b.*\b(buyers|customers|orders|sales|purchases)\b/i,
    intents: ["diagnostic", "purchases", "sales"],
  },
  {
    pattern: /\b(which|what)\s+(product|products|items)\b.*\b(best|popular|selling|performing|interest)\b/i,
    intents: ["product_interest", "purchases"],
  },
  {
    pattern: /\b(where|at what point)\b.*\b(lose|losing|drop|dropping off)\b.*\b(customers|shoppers|buyers|visitors)\b/i,
    intents: ["diagnostic", "funnel", "cart"],
  },
  {
    pattern: /\b(get|bring|attract)\s+more\s+(buyers|customers|orders|sales)\b|\b(turn|convert)\s+(more\s+)?visitors into (buyers|customers)\b/i,
    intents: ["growth", "traffic", "conversion"],
  },
];

const ACTION_INTENTS = new Set([
  "advice", "growth", "merchant_priority", "intent_opportunities",
  "intervention_effectiveness",
]);
const DIAGNOSTIC_INTENTS = new Set(["diagnostic", "funnel", "overview"]);

function parseIntents(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function resolveReasoningIntents(question, detectedIntents = [], previousTurn = null) {
  const text = String(question ?? "").trim();
  const normalized = text.toLowerCase().replace(/[?!.,]+$/g, "").trim();
  const intents = [...parseIntents(detectedIntents)];

  for (const item of SEMANTIC_PATTERNS) {
    if (item.pattern.test(text)) intents.push(...item.intents);
  }

  if (REFERENTIAL_FOLLOW_UP.test(normalized) && previousTurn?.question && previousTurn?.answer) {
    const previous = parseIntents(previousTurn.intents);
    if (/^(and why|why though|why is that|why did that happen|what caused it|what caused that|can you explain why|explain why)$/i.test(text)) {
      if (previous.includes("weekly_revenue")) intents.push("weekly_revenue", "diagnostic");
      else if (previous.some((intent) => ["revenue", "sales", "purchases", "overview"].includes(intent))) {
        intents.push("diagnostic", "revenue");
      } else if (previous.some((intent) => ["diagnostic", "funnel", "cart"].includes(intent))) {
        intents.push("diagnostic");
      } else {
        intents.push("contextual_follow_up");
      }
    } else if (/^(what should i do about it|how do i fix that|how can i improve it|would that help|will that help|would that work|will that work)$/i.test(normalized)) {
      intents.push("merchant_priority");
    } else {
      intents.push("contextual_follow_up");
    }
  }

  return unique(intents);
}

/**
 * Group already-composed, evidence-backed sections by their role.
 * No new metric, causal claim, or recommendation is created here.
 */
export function composeReasonedResponse({ question = "", intents = [], sections = [] } = {}) {
  const cleanSections = [];
  const seen = new Set();

  for (const section of sections) {
    const value = String(section ?? "").trim();
    const key = value.toLowerCase().replace(/\s+/g, " ");
    if (!value || seen.has(key)) continue;
    seen.add(key);
    cleanSections.push(value);
  }

  if (!cleanSections.length) {
    return "I don't have enough reliable store evidence or reviewed knowledge to answer that accurately. If you clarify what you mean, I can examine the relevant store activity.";
  }
  if (cleanSections.length === 1) return cleanSections[0];

  const intentList = parseIntents(intents);
  const actionIndexes = new Set();
  const diagnosticIndexes = new Set();

  intentList.forEach((intent, index) => {
    if (ACTION_INTENTS.has(intent)) actionIndexes.add(index);
    if (DIAGNOSTIC_INTENTS.has(intent)) diagnosticIndexes.add(index);
  });

  // Sections are composed in intent order. Keep every supported section and
  // add only lightweight structure; never infer a relationship not in data.
  const hasAction = intentList.some((intent) => ACTION_INTENTS.has(intent));
  const hasDiagnostic = intentList.some((intent) => DIAGNOSTIC_INTENTS.has(intent));

  if (hasAction) {
    const actionSection = cleanSections[cleanSections.length - 1];
    const evidenceSections = cleanSections.slice(0, -1);
    if (evidenceSections.length) {
      return `Here's the picture from your store data:\n\n${evidenceSections.join("\n\n")}\n\nWhat I recommend:\n${actionSection}`;
    }
  }

  if (hasDiagnostic && cleanSections.length > 1) {
    return `The available evidence points to these areas:\n\n${cleanSections.join("\n\n")}\n\nThese records show where to investigate; they do not by themselves prove a single cause.`;
  }

  return `Looking at those points together:\n\n${cleanSections.join("\n\n")}`;
}
