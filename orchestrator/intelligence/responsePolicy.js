import { REDEN_KNOWLEDGE, REDEN_KNOWLEDGE_VERSION } from "./knowledgeBase.js";
import { composeCommerceKnowledge } from "./commerceKnowledge.js";

/**
 * Deterministic product and conversation knowledge. This is reviewed,
 * version-controlled knowledge, not a claim that REDEN has a connected
 * general-purpose language model or live internet access.
 */
export const REDEN_RESPONSE_POLICY_VERSION = "2026-10-24.2";

export function composeConversationResponse(intent, question = "") {
  const policy = REDEN_KNOWLEDGE.conversation_policy;

  switch (intent) {
    case "greeting":
      return "Hi. I’m REDEN, PRETHIM’s commerce-intelligence assistant. I can help explain e-commerce concepts and investigate your store’s recorded sales, traffic, conversion, checkout, recovery, and possible next steps.";

    case "gratitude":
      return "You’re welcome. What would you like to understand or improve next?";

    case "capabilities":
      return "I can answer basic questions about REDEN and e-commerce, summarise recorded store activity, investigate supported funnel signals, review recovery and decision activity, and suggest evidence-based next steps. I’ll distinguish measured facts from hypotheses, and I won’t call revenue profit. Automated actions and store-specific conclusions depend on working integrations and reliable data.";

    case "reden_identity":
    case "commerce_knowledge":
      return composeCommerceKnowledge(question);

    case "general_help":
      return "I’m REDEN, PRETHIM’s commerce-intelligence assistant. I’m not confident I can answer that reliably from the information available to me right now. I can answer common e-commerce questions and help with your store’s recorded sales, traffic, conversion, checkout, recovery, and practical next steps; I’ll say what I can’t verify rather than guess.";

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
