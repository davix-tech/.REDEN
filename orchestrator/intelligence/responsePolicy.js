import { REDEN_KNOWLEDGE, REDEN_KNOWLEDGE_VERSION } from "./knowledgeBase.js";
import { composeCommerceKnowledge } from "./commerceKnowledge.js";
import {
  chooseBusinessRedirectVariant,
  composeContextualFollowUp,
} from "./conversationMemory.js";

/**
 * Deterministic product and conversation knowledge. This is reviewed,
 * version-controlled knowledge, not a claim that REDEN has a connected
 * general-purpose language model or live internet access.
 */
export const REDEN_RESPONSE_POLICY_VERSION = "2026-10-24.2";

export function composeConversationResponse(intent, question = "", recentTurns = [], previousTurn = null) {
  const policy = REDEN_KNOWLEDGE.conversation_policy;

  switch (intent) {
    case "greeting": {
      const greetings = [
        "Hi. I’m REDEN, PRETHIM’s commerce intelligence assistant. I can help you understand your store’s activity and decide what deserves attention.",
        "Hello. I’m REDEN. I work with your store’s recorded activity to help explain sales, shopper behaviour, and useful next steps.",
        "Good to hear from you. I’m REDEN, here to help you make sense of your store and its customers. What should we look into?"
      ];
      return greetings[recentTurns.length % greetings.length];
    }

    case "gratitude":
      return recentTurns.length % 2 === 0
        ? "You’re welcome. Is there another part of your store you’d like me to examine?"
        : "Anytime. We can look at sales, shopper behaviour, checkout activity, or your next business decision.";

    case "contextual_follow_up":
      return composeContextualFollowUp(question, previousTurn);

    case "capabilities":
      return "REDEN is meant to help you decide what to do to improve commerce performance, not merely send another recovery email. It can analyse the storefront events it actually receives, examine the path from visit to product view, cart, checkout and purchase, surface likely bottlenecks when the evidence supports them, compare performance with a usable baseline, and recommend evidence-based next steps with a measurable next action. It can also help evaluate recovery and other interventions against outcomes rather than treating emails sent or clicks as success.\n\nThe difference from a standalone cart-recovery or email tool is the decision layer: what problem is worth solving, which eligible action fits the evidence, whether an incentive is economically sensible, and whether the result improved sales or contribution profit. I won't call revenue profit. REDEN must not claim it has solved that full loop when the relevant event tracking, cost data, integrations, or outcome measurement are missing. In the current implementation, some of this is analysis and guidance; do not assume every intervention is automatically executed.";

    case "reden_identity":
    case "prethim_identity":
    case "commerce_knowledge":
      return composeCommerceKnowledge(question);

    case "general_help":
      return "I can’t reliably answer that from my reviewed knowledge, and I won’t make something up. " + chooseBusinessRedirectVariant(question, recentTurns);

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
