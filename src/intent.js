/**
 * REDEN Intent Engine v1
 *
 * Returns:
 * {
 *   score: 0-100,
 *   level: LOW | MEDIUM | HIGH,
 *   factors: {}
 * }
 */

export function calculateIntent(session = {}) {
  let score = 0;

  const {
    pageViews = 0,
    productViews = 0,
    addToCartCount = 0,
    checkoutStarted = false,
    purchased = false,
    cartValue = 0,
    timeOnSite = 0, // seconds
    returnVisits = 0
  } = session;

  // Page engagement
  score += Math.min(pageViews * 1, 10);

  // Product interest
  score += Math.min(productViews * 3, 20);

  // Cart actions
  score += Math.min(addToCartCount * 10, 20);

  // Checkout intent
  if (checkoutStarted) {
    score += 25;
  }

  // Cart value influence
  if (cartValue >= 50) score += 5;
  if (cartValue >= 100) score += 5;
  if (cartValue >= 250) score += 5;

  // Session duration
  if (timeOnSite >= 60) score += 5;
  if (timeOnSite >= 180) score += 5;
  if (timeOnSite >= 300) score += 5;

  // Returning visitors
  score += Math.min(returnVisits * 3, 10);

  // Already purchased
  if (purchased) {
    score = 100;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let level = "LOW";

  if (score >= 70) {
    level = "HIGH";
  } else if (score >= 40) {
    level = "MEDIUM";
  }

  return {
    score,
    level,
    factors: {
      pageViews,
      productViews,
      addToCartCount,
      checkoutStarted,
      cartValue,
      timeOnSite,
      returnVisits
    }
  };
    }
