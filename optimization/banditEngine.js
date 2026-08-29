```js
import { db } from "../infrastructure/db.js";

const ACTIONS = [
  "NONE",
  "INCENTIVE_LOW",
  "INCENTIVE_MED",
  "INCENTIVE_HIGH",
];

const EPSILON = 0.10;
const MIN_PULLS = 3;

/* =========================================================
   HELPERS
========================================================= */

function randomItem(items) {
  if (!items.length) {
    return "NONE";
  }

  return items[
    Math.floor(Math.random() * items.length)
  ];
}

function normalizeNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return 0;
  }

  return number;
}

/* =========================================================
   ENSURE TENANT BANDIT STATE
========================================================= */

async function ensureBanditState(siteId) {
  await db.query(
    `
      INSERT INTO bandit_state (
        site_id,
        action,
        pulls,
        rewards,
        updated_at
      )
      SELECT
        $1,
        action,
        0,
        0,
        NOW()
      FROM unnest($2::text[]) AS actions(action)
      ON CONFLICT (
        site_id,
        action
      )
      DO NOTHING
    `,
    [
      siteId,
      ACTIONS,
    ]
  );
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
      return "NONE";
    }

    await ensureBanditState(site_id);

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

    const rows = result.rows || [];

    if (!rows.length) {
      return "NONE";
    }

    /*
     * Always test actions that have
     * never received an observation.
     */

    const untested = rows.filter(
      (row) =>
        Number(row.pulls || 0) === 0
    );

    if (untested.length) {
      return randomItem(
        untested.map(
          (row) => row.action
        )
      );
    }

    /*
     * Give every action a minimum
     * number of learning opportunities.
     */

    const underExplored = rows.filter(
      (row) =>
        Number(row.pulls || 0) < MIN_PULLS
    );

    if (underExplored.length) {
      return randomItem(
        underExplored.map(
          (row) => row.action
        )
      );
    }

    /*
     * Epsilon exploration.
     */

    if (Math.random() < EPSILON) {
      return randomItem(
        rows.map(
          (row) => row.action
        )
      );
    }

    /*
     * Exploitation.
     *
     * Current reward model:
     *
     * conversion = 1
     * no conversion = 0
     *
     * Therefore rewards / pulls represents
     * observed conversion probability.
     */

    let bestAction = "NONE";
    let bestScore = -Infinity;

    const value = normalizeNumber(
      cart_value
    );

    for (const row of rows) {
      const pulls = Number(
        row.pulls || 0
      );

      const rewards = Number(
        row.rewards || 0
      );

      if (pulls <= 0) {
        continue;
      }

      let score =
        rewards / pulls;

      /*
       * Conservative business constraints.
       *
       * Higher incentives should not automatically
       * dominate simply because they convert better.
       */

      if (
        row.action === "INCENTIVE_HIGH" &&
        value < 1000
      ) {
        score *= 0.85;
      }

      if (
        row.action === "INCENTIVE_MED" &&
        value < 500
      ) {
        score *= 0.90;
      }

      /*
       * Returning customers generally require
       * less aggressive intervention.
       */

      if (
        row.action !== "NONE" &&
        behavior?.returning_customer
      ) {
        score *= 0.97;
      }

      if (score > bestScore) {
        bestScore = score;
        bestAction = row.action;
      }
    }

    return bestAction;
  } catch (error) {
    console.error(
      "[BANDIT PICK ERROR]",
      error
    );

    /*
     * Optimization failure must never
     * break storefront operation.
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
    if (
      !site_id ||
      !ACTIONS.includes(action)
    ) {
      return;
    }

    const reward = converted ? 1 : 0;

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
            bandit_state.rewards +
            EXCLUDED.rewards,

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
    const result = await db.query(
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
```
