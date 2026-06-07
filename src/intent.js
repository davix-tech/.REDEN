/**
 * REDEN Intent Engine v2
 * Adaptive Revenue Intent System
 *
 * Output:
 * {
 *   score: 0-100,
 *   state: BROWSING | EXPLORING | CONSIDERING | HIGH_INTENT | BUY_READY,
 *   actions: string[],
 *   signals: object
 * }
 */

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function calculateIntent(session = {}) {
  const now = Date.now();

  const {
    pageViews = 0,
    productViews = 0,
    addToCartCount = 0,
    checkoutStarted = false,
    purchased = false,
    cartValue = 0,
    timeOnSite = 0, // seconds
    returnVisits = 0,

    // NEW (important for adaptiveness)
    lastActivityTimestamp = now,
    repeatProductSwitching = 0,
    cartAbandonments = 0,
    checkoutBounce = false
  } = session;

  /**
   * -------------------------
   * 1. Normalized Signals
   * -------------------------
   */
  const norm = {
    engagement: clamp(pageViews / 10),
    productInterest: clamp(productViews / 8),
    cartEngagement: clamp(addToCartCount / 3),
    checkoutSignal: checkoutStarted ? 1 : 0,
    cartStrength: clamp(cartValue / 200),
    loyalty: clamp(returnVisits / 5)
  };

  /**
   * -------------------------
   * 2. Velocity (intent speed)
   * -------------------------
   */
  const velocity = clamp(
    (productViews + addToCartCount * 2 + (checkoutStarted ? 3 : 0)) /
      Math.max(timeOnSite / 60, 1),
    0,
    1
  );

  /**
   * -------------------------
   * 3. Recency Decay
   * -------------------------
   */
  const timeSinceLastAction = (now - lastActivityTimestamp) / 1000; // seconds
  const recencyFactor = Math.exp(-timeSinceLastAction / 600); // ~10 min decay window

  /**
   * -------------------------
   * 4. Friction (intent reduction)
   * -------------------------
   */
  const friction =
    repeatProductSwitching * 0.15 +
    cartAbandonments * 0.35 +
    (checkoutBounce ? 0.5 : 0);

  /**
   * -------------------------
   * 5. Base Intent Score (non-linear)
   * -------------------------
   */
  let intentRaw =
    norm.engagement * 0.15 +
    norm.productInterest * 0.25 +
    norm.cartEngagement * 0.3 +
    norm.checkoutSignal * 0.4 +
    norm.cartStrength * 0.2 +
    norm.loyalty * 0.1;

  /**
   * Amplification layer (key differentiator)
   */
  intentRaw *= 0.6 + velocity * 0.6;
  intentRaw *= recencyFactor;

  /**
   * Apply friction penalty
   */
  intentRaw -= friction;

  /**
   * If purchase happened → force max intent
   */
  if (purchased) intentRaw = 1;

  intentRaw = clamp(intentRaw, 0, 1);

  const score = Math.round(intentRaw * 100);

  /**
   * -------------------------
   * 6. Intent State Machine
   * -------------------------
   */
  let state = "BROWSING";

  if (score >= 85 || checkoutStarted) {
    state = "BUY_READY";
  } else if (score >= 65) {
    state = "HIGH_INTENT";
  } else if (score >= 40) {
    state = "CONSIDERING";
  } else if (score >= 20) {
    state = "EXPLORING";
  }

  /**
   * -------------------------
   * 7. Action Engine (core REDEN value)
   * -------------------------
   */
  const actions = getActions(state);

  return {
    score,
    state,
    actions,
    signals: {
      norm,
      velocity,
      recencyFactor,
      friction
    }
  };
}

/**
 * -------------------------
 * 8. Action Mapping Layer
 * -------------------------
 */
function getActions(state) {
  switch (state) {
    case "BUY_READY":
      return [
        "trigger_checkout_reminder",
        "apply_dynamic_discount",
        "priority_email_recovery"
      ];

    case "HIGH_INTENT":
      return [
        "show_urgency_banner",
        "cart_nudge",
        "social_proof_popup"
      ];

    case "CONSIDERING":
      return [
        "recommend_similar_products",
        "comparison_module",
        "email_capture"
      ];

    case "EXPLORING":
      return [
        "personalized_recommendations"
      ];

    default:
      return [
        "collect_behavior_data"
      ];
  }
    }
