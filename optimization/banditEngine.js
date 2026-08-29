import { db } from "../infrastructure/db.js";

const ACTIONS = [
  "NONE",
  "INCENTIVE_LOW",
  "INCENTIVE_MED",
  "INCENTIVE_HIGH",
];

const EPSILON = 0.10;

/*
 * Minimum number of observations before an action
 * can be considered properly exploited.
 */
const MIN_EXPLORATION_PULLS = 3;

/* =========================================================
   RANDOM ACTION
========================================================= */

function randomAction(actions = ACTIONS) {
  if (!actions.length) {
    return "NONE";
  }

  return actions[
    Math.floor(
      Math.random() * actions.length
    )
  ];
}

/* =========================================================
   PICK ACTION
========================================================= */

export async function pickAction({
  site_id,
  session_id = null,
  cart_value = 0,
  behavior = {},
} = {}) {
  try {
    if (!site_id) {
      console.warn(
        "[BANDIT] Missing site_id. Falling back to NONE."
      );

      return "NONE";
    }

    const result = await db.query(
      `
        SELECT
          action,
          pulls,
          rewards
        FROM bandit_state
        WHERE site_id = $1
        ORDER BY action
      `,
      [site_id]
    );

    let rows = result.rows || [];

    /*
     * Ensure every action exists for the tenant.
     *
     * This protects against old installations that were
     * created before the tenant-scoped bandit schema.
     */

    if (rows.length < ACTIONS.length) {
      await db.query(
        `
          INSERT INTO bandit_state (
            site_id,
            action,
            pulls,
            rewards
          )
          SELECT
            $1,
            action,
            0,
            0
          FROM unnest($2::text[]) AS action
          ON CONFLICT (
            site_id,
            action
          )
          DO NOTHING
        `,
        [
          site_id,
          ACTIONS,
        ]
      );

      const refreshed =
        await db.query(
          `
            SELECT
              action,
              pulls,
              rewards
            FROM bandit_state
            WHERE site_id = $1
          `,
          [site_id]
        );

      rows =
        refreshed.rows || [];
    }

    /*
     * First priority:
     * deliberately explore actions that have never
     * been observed.
     */

    const untested =
      rows.filter(
        (row) =>
          Number(row.pulls || 0) === 0
      );

    if (untested.length) {
      return randomAction(
        untested.map(
          (row) => row.action
        )
      );
    }

    /*
     * Second priority:
     * make sure every action gets a small amount
     * of exploration before exploitation dominates.
     */

    const underExplored =
      rows.filter(
        (row) =>
          Number(row.pulls || 0) <
          MIN_EXPLORATION_PULLS
      );

    if (underExplored.length) {
      return randomAction(
        underExplored.map(
          (row) => row.action
        )
      );
    }

    /*
     * Epsilon exploration.
     */

    if (Math.random() < EPSILON) {
      return randomAction(
        rows.map(
          (row) => row.action
        )
      );
    }

    /*
     * Exploitation.
     *
     * Current reward is conversion probability.
     */

    let bestAction = "NONE";
    let bestScore = -Infinity;

    for (const row of rows) {
      const pulls =
        Number(
          row.pulls || 0
        );

      const rewards =
        Number(
          row.rewards || 0
        );

      if (pulls <= 0) {
        continue;
      }

      const conversionRate =
        rewards / pulls;

      /*
       * Small context adjustment.
       *
       * This is intentionally conservative.
       * We do not allow cart value or behavior
       * to completely override learned conversion.
       */

      let score =
        conversionRate;

      const value =
        Number(
          cart_value || 0
        );

      if (
        row.action ===
          "INCENTIVE_HIGH" &&
        value < 1000
      ) {
        score *= 0.85;
      }

      if (
        row.action ===
          "NONE" &&
        behavior?.returning_customer
      ) {
        score *= 1.05;
      }

      if (score > bestScore) {
        bestScore =
          score;

        bestAction =
          row.action;
      }
    }

    return (
      bestAction ||
      "NONE"
    );
  } catch (error) {
    console.error(
      "[BANDIT PICK ERROR]",
      error
    );

    /*
     * The optimization layer must NEVER take
     * the storefront decision API down.
     */

    return "NONE";
  }
}

/* =========================================================
   UPDATE BANDIT
========================================================= */

export async function updateBandit(
  site_id,
  action,
  converted
) {
  try {
    if (!site_id) {
      console.warn(
        "[BANDIT UPDATE] Missing site_id."
      );

      return;
    }

    if (!ACTIONS.includes(action)) {
      console.warn(
        `[BANDIT UPDATE] Invalid action: ${action}`
      );

      return;
    }

    const reward =
      converted ? 1 : 0;

    await db.query(
      `
        INSERT INTO bandit_state (
          site_id,
          action,
          pulls,
          rewards,
          updated_at
        )
        VALUES (
          $1,
          $2,
          1,
          $3,
          NOW()
        )

        ON CONFLICT (
          site_id,
          action
        )

        DO UPDATE SET
          pulls =
            bandit_state.pulls + 1,

          rewards =
            bandit_state.rewards + EXCLUDED.rewards,

          updated_at =
            NOW()
      `,
      [
        site_id,
        action,
        reward,
      ]
    );
  } catch (error) {
    console.error(
      "[BANDIT UPDATE ERROR]",
      error
    );
  }
}

/* =========================================================
   BANDIT STATS
========================================================= */

export async function getBanditStats(
  site_id
) {
  if (!site_id) {
    return [];
  }

  try {
    const result =
      await db.query(
        `
          SELECT
            action,
            pulls,
            rewards,

            CASE
              WHEN pulls > 0
              THEN ROUND(
                (
                  rewards /
                  pulls
                ) * 100,
                2
              )
              ELSE 0
            END AS conversion_rate,

            updated_at

          FROM bandit_state

          WHERE site_id = $1

          ORDER BY
            conversion_rate DESC,
            pulls DESC
        `,
        [site_id]
      );

    return result.rows || [];
  } catch (error) {
    console.error(
      "[BANDIT STATS ERROR]",
      error
    );

    return [];
  }
}
