import { REDEN_KNOWLEDGE, REDEN_KNOWLEDGE_VERSION } from "./knowledgeBase.js";

/**
 * Deterministic conversation layer for situations that should not trigger
 * merchant analytics. It intentionally does not pretend to be a general
 * language model or answer factual questions without a knowledge source.
 */
export const REDEN_RESPONSE_POLICY_VERSION = "2026-10-24.1";

export function composeConversationResponse(intent, question = "") {
  const policy = REDEN_KNOWLEDGE.conversation_policy;

  switch (intent) {
    case "greeting":
      return "Hi. I’m REDEN, your store’s commerce intelligence assistant. I can help you understand sales, traffic, conversion, checkout, customer recovery, and what to investigate next.";

    case "gratitude":
      return "You’re welcome. What would you like to understand or improve next?";

    case "capabilities":
      return "I can explain your store’s recorded sales and traffic, investigate funnel changes, review recovery and decision activity, and suggest evidence-based next steps. I’ll distinguish measured facts from hypotheses and won’t call revenue profit. Some recommendations require more history or cost data before they can be trusted.";

    case "general_help":
      return "I’m not confident I can answer that reliably from the information available to me right now. I can help with your store’s sales, traffic, conversion, checkout, recovery, marketing signals, and practical next steps. If you tell me what you’re trying to achieve, I’ll help narrow it down rather than guess.";

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
