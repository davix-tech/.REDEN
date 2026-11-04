/**
 * Small, bounded conversation context for REDEN's merchant assistant.
 * The caller supplies only turns from the same authenticated chat session.
 */

function normalizedText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseConversationIntents(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item) => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function detectFollowUpIntent(question, previousTurn) {
  if (!previousTurn?.question || !previousTurn?.answer) return null;

  const q = normalizedText(question);
  const prior = parseConversationIntents(previousTurn.intents);

  if (/^(why|why is that|why did that happen|what caused that|what is causing that)$/.test(q)) {
    if (prior.includes("weekly_revenue")) return ["weekly_revenue", "diagnostic"];
    if (prior.some((intent) => ["revenue", "overview", "purchases", "sales"].includes(intent))) {
      return ["diagnostic", "revenue"];
    }
    if (prior.includes("diagnostic") || prior.includes("merchant_priority")) {
      return ["diagnostic"];
    }
  }

  if (/^(what should i do|what should i do now|what should i do next|what should i do then|what now|what next|what do you recommend|how do i fix it)$/.test(q)) {
    return ["merchant_priority"];
  }

  if (
    prior.includes("weekly_revenue") &&
    /^(what about last week|and last week|previous week|compare with last week|how about last week)$/.test(q)
  ) {
    return ["weekly_revenue"];
  }

  if (
    prior.includes("weekly_revenue") &&
    /^(what about today|and today|how about today|today instead)$/.test(q)
  ) {
    return ["revenue"];
  }

  if (/^(tell me more|explain that|what do you mean|can you explain|how so|elaborate)$/.test(q)) {
    return ["contextual_follow_up"];
  }

  return null;
}

const INTENT_LABELS = {
  weekly_revenue: "your week-to-date sales figures",
  revenue: "your recorded sales",
  overview: "your store's recent activity",
  diagnostic: "the possible reasons behind the change",
  merchant_priority: "the next useful action for your store",
  traffic: "your store visits",
  purchases: "your recorded purchases",
  conversion: "the share of visits that lead to purchases",
  cart: "cart and checkout activity",
  recovery: "cart recovery activity",
  capabilities: "what REDEN can do for your store",
  reden_identity: "what REDEN is",
  commerce_knowledge: "the e-commerce concept we discussed",
};

export function composeContextualFollowUp(question, previousTurn) {
  if (!previousTurn?.answer) {
    return "I don't have the earlier point in this conversation. Could you repeat the part you'd like me to explain?";
  }

  const q = normalizedText(question);
  const prior = parseConversationIntents(previousTurn.intents);
  const topic = prior.map((intent) => INTENT_LABELS[intent]).find(Boolean) || "the point in my previous answer";
  const firstSentence = String(previousTurn.answer)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)[0]
    .slice(0, 260);

  if (/^(tell me more|elaborate)$/.test(q)) {
    return `I was referring to ${topic}. The key point was: ${firstSentence} I can break down the figures, the possible explanation, or the next step.`;
  }

  return `When I mentioned ${topic}, I meant: ${firstSentence} Which part would you like me to unpack—the evidence, what it suggests, or what to do next?`;
}

export function chooseBusinessRedirectVariant(question, recentTurns = []) {
  const q = normalizedText(question);
  const answers = recentTurns
    .map((turn) => String(turn?.answer ?? ""))
    .filter(Boolean);
  const templates = [
    "My focus is helping you understand and improve your store. I can look at sales, visits, customer behaviour, checkout activity, or what to do next. Which would be useful?",
    "I’m REDEN, so I’m most useful when we’re working on your commerce business. Ask me about sales, shoppers, checkout, recovery, or a decision you’re considering.",
    "I can help you find what is happening in your store and what deserves attention. We can start with traffic, purchases, sales performance, or customer behaviour.",
    "Let's bring this back to your store. I can investigate where shoppers are dropping off, how sales are changing, or which action is worth considering."
  ];
  const previousRedirects = answers.filter((answer) =>
    /my focus is helping you understand|i’m reden, so i’m most useful|i can help you find what is happening|let's bring this back to your store/i.test(answer)
  ).length;
  const index = previousRedirects % templates.length;
  return templates[index];
}
