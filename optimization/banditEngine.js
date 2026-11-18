import { db } from "../infrastructure/db.js";

const ACTIONS = ["NONE", "INCENTIVE_LOW", "INCENTIVE_MED", "INCENTIVE_HIGH"];
const DISCOUNT_PERCENT = {
  NONE: 0,
  INCENTIVE_LOW: 5,
  INCENTIVE_MED: 10,
  INCENTIVE_HIGH: 20,
};
const CONTEXT_MIN_PULLS = 3;
const EXPLORATION_RATE = 0.05;

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function bool(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function randomItem(items, random = Math.random) {
  if (!items.length) return "NONE";
  return items[Math.floor(random() * items.length)];
}

/** Stable, bounded context buckets prevent high-cardinality state growth. */
export function deriveBanditContext({ cart_value = 0, behavior = {} } = {}) {
  const cart = number(cart_value);
  const intentValue = behavior.intent_score ?? behavior.intentScore;
  let intent = Number(intentValue);
  if (!Number.isFinite(intent)) {
    intent = number(behavior.page_views) * 0.02 +
      number(behavior.product_views) * 0.08 +
      number(behavior.cart_additions) * 0.2 +
      (bool(behavior.checkout_started) ? 0.3 : 0);
  }
  if (intent > 1) intent /= 100;
  const intentBand = intent >= 0.7 ? "high" : intent >= 0.35 ? "medium" : "low";
  const cartBand = cart === 0 ? "none" : cart < 1000 ? "small" : cart < 10000 ? "medium" : "large";
  const returning = bool(behavior.returning_customer ?? behavior.returningCustomer);
  return `intent:${intentBand}|cart:${cartBand}|returning:${returning ? "yes" : "no"}`;
}

export function eligibleBanditActions(cartValue) {
  const cart = number(cartValue);
  if (cart <= 0) return ["NONE"];
  const actions = ["NONE", "INCENTIVE_LOW"];
  if (cart >= 500) actions.push("INCENTIVE_MED");
  if (cart >= 1000) actions.push("INCENTIVE_HIGH");
  return actions;
}

// Marsaglia-Tsang gamma sampler; supports shape values below 1.
function sampleGamma(shape, random = Math.random) {
  if (shape < 1) return sampleGamma(shape + 1, random) * Math.pow(Math.max(random(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 100; i++) {
    let x;
    let v;
    do {
      const u1 = Math.max(random(), 1e-12);
      const u2 = Math.max(random(), 1e-12);
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x * x * x * x ||
        Math.log(Math.max(u, 1e-12)) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
  return shape; // bounded fallback; keeps the decision endpoint fail-safe
}

export function sampleBeta(alpha, beta, random = Math.random) {
  const a = sampleGamma(Math.max(0.01, alpha), random);
  const b = sampleGamma(Math.max(0.01, beta), random);
  return a / Math.max(a + b, 1e-12);
}

function posteriorFor(action, row = {}) {
  const pulls = number(row.pulls);
  const rewards = Math.min(pulls, number(row.rewards));
  // Conservative priors: no incentive starts with a slightly stronger baseline.
  const prior = action === "NONE" ? { alpha: 2, beta: 3 } : { alpha: 1, beta: 4 };
  return { alpha: prior.alpha + rewards, beta: prior.beta + pulls - rewards };
}

/** Pure selector used by the optimizer and unit tests. */
export function selectBanditAction({ actions, stats = {}, random = Math.random } = {}) {
  const eligible = (actions || []).filter((action) => ACTIONS.includes(action));
  if (!eligible.length) return "NONE";
  if (random() < EXPLORATION_RATE) return randomItem(eligible, random);

  let best = "NONE";
  let bestUtility = -Infinity;
  for (const action of eligible) {
    const posterior = posteriorFor(action, stats[action] || {});
    const sampledConversion = sampleBeta(posterior.alpha, posterior.beta, random);
    // Discount cost is penalized because margin data is not currently available.
    const costPenalty = (DISCOUNT_PERCENT[action] / 100) * 0.5;
    const utility = sampledConversion - costPenalty;
    if (utility > bestUtility) {
      bestUtility = utility;
      best = action;
    }
  }
  return best;
}

async function ensureBanditState(siteId) {
  await db.query(
    `INSERT INTO bandit_state (site_id, action, pulls, rewards, updated_at)
     SELECT $1, action, 0, 0, NOW() FROM unnest($2::text[]) AS action
     ON CONFLICT (site_id, action) DO NOTHING`,
    [siteId, ACTIONS]
  );
}

export async function pickAction({ site_id, session_id = null, cart_value = 0, behavior = {}, context_key = null } = {}) {
  try {
    if (!site_id) return "NONE";
    await ensureBanditState(site_id);
    const contextKey = context_key || deriveBanditContext({ cart_value, behavior });
    const eligible = eligibleBanditActions(cart_value);

    const [globalResult, contextualResult] = await Promise.all([
      db.query(`SELECT action, pulls, rewards FROM bandit_state WHERE site_id = $1`, [site_id]),
      db.query(`SELECT action, pulls, rewards FROM bandit_context_state WHERE site_id = $1 AND context_key = $2`, [site_id, contextKey]),
    ]);

    const globalStats = Object.fromEntries((globalResult.rows || []).map((row) => [row.action, row]));
    const contextualStats = Object.fromEntries((contextualResult.rows || []).map((row) => [row.action, row]));
    const effectiveStats = {};
    for (const action of eligible) {
      const contextual = contextualStats[action];
      effectiveStats[action] = contextual && number(contextual.pulls) >= CONTEXT_MIN_PULLS
        ? contextual
        : globalStats[action] || {};
    }

    return selectBanditAction({ actions: eligible, stats: effectiveStats });
  } catch (error) {
    console.error("[BANDIT PICK ERROR]", error);
    return "NONE";
  }
}

export async function updateBandit(site_id, action, converted, context_key = null) {
  try {
    if (!site_id || !ACTIONS.includes(action)) return;
    const reward = bool(converted) ? 1 : 0;
    const contextKey = typeof context_key === "string" && context_key.length <= 100
      ? context_key
      : "context:unknown|cart:unknown|returning:unknown";

    await db.query(
      `INSERT INTO bandit_state (site_id, action, pulls, rewards, updated_at)
       VALUES ($1, $2, 1, $3, NOW())
       ON CONFLICT (site_id, action) DO UPDATE SET
         pulls = bandit_state.pulls + 1,
         rewards = bandit_state.rewards + EXCLUDED.rewards,
         updated_at = NOW()`,
      [site_id, action, reward]
    );

    await db.query(
      `INSERT INTO bandit_context_state (site_id, context_key, action, pulls, rewards, updated_at)
       VALUES ($1, $2, $3, 1, $4, NOW())
       ON CONFLICT (site_id, context_key, action) DO UPDATE SET
         pulls = bandit_context_state.pulls + 1,
         rewards = bandit_context_state.rewards + EXCLUDED.rewards,
         updated_at = NOW()`,
      [site_id, contextKey, action, reward]
    );
  } catch (error) {
    console.error("[BANDIT UPDATE ERROR]", error);
  }
}

export async function getBanditStats(site_id) {
  if (!site_id) return [];
  try {
    const result = await db.query(
      `SELECT action, pulls, rewards,
         CASE WHEN pulls > 0 THEN ROUND((rewards::numeric / pulls::numeric) * 100, 2) ELSE 0 END AS conversion_rate,
         updated_at
       FROM bandit_state WHERE site_id = $1
       ORDER BY conversion_rate DESC, pulls DESC`,
      [site_id]
    );
    return result.rows || [];
  } catch (error) {
    console.error("[BANDIT STATS ERROR]", error);
    return [];
  }
}
