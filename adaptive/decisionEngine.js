import {
  pickAction,
} from "../optimization/banditEngine.js";

import {
  getSessionContext,
} from "./contextEngine.js";

/* =========================================================
   ACTION CONFIGURATION
========================================================= */

const ACTION_CONFIG = {
  NONE: {
    discount: 0,
    type: "none",
  },

  INCENTIVE_LOW: {
    discount: 5,
    type: "percentage",
  },

  INCENTIVE_MED: {
    discount: 10,
    type: "percentage",
  },

  INCENTIVE_HIGH: {
    discount: 20,
    type: "percentage",
  },
};

/* =========================================================
   INTENT
========================================================= */

function calculateIntent(
  context
) {
  if (!context) {
    return 0;
  }

  let score = 0;

  score +=
    Number(
      context.page_views || 0
    ) *
    0.02;

  score +=
    Number(
      context.product_views || 0
    ) *
    0.08;

  score +=
    Number(
      context.cart_additions || 0
    ) *
    0.20;

  if (
    context.checkout_started
  ) {
    score += 0.30;
  }

  if (
    context.purchased
  ) {
    score += 0.50;
  }

  return Math.min(
    1,
    Number(
      score.toFixed(4)
    )
  );
}

/* =========================================================
   DECISION
========================================================= */

export async function makeDecision({
  siteId,
  sessionId,
  cartValue = 0,
  behavior = {},
}) {
  if (!siteId) {
    throw new Error(
      "siteId is required"
    );
  }

  if (!sessionId) {
    throw new Error(
      "sessionId is required"
    );
  }

  const context =
    await getSessionContext(
      siteId,
      sessionId
    );

  const mergedContext = {
    ...(context || {}),
    ...behavior,
  };

  const intentScore =
    calculateIntent(
      context
    );

  const action =
    await pickAction({
      site_id: siteId,
      session_id: sessionId,
      cart_value: cartValue,
      behavior: {
        ...mergedContext,
        intent_score:
          intentScore,
      },
    });

  const config =
    ACTION_CONFIG[action] ||
    ACTION_CONFIG.NONE;

  let reason =
    "adaptive_policy";

  if (
    intentScore >= 0.7
  ) {
    reason =
      "high_purchase_intent";
  } else if (
    intentScore >= 0.4
  ) {
    reason =
      "moderate_purchase_intent";
  } else if (
    intentScore < 0.2
  ) {
    reason =
      "low_purchase_intent";
  }

  return {
    action,

    discount:
      config.discount,

    type:
      config.type,

    intentScore,

    reason,

    context: {
      pageViews:
        Number(
          context?.page_views || 0
        ),

      productViews:
        Number(
          context?.product_views || 0
        ),

      cartAdditions:
        Number(
          context?.cart_additions || 0
        ),

      checkoutStarted:
        Boolean(
          context?.checkout_started
        ),

      purchased:
        Boolean(
          context?.purchased
        ),
    },
  };
}
