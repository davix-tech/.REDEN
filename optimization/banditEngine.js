import { db } from "./db.js";

const ACTIONS = [
  "NONE",
  "INCENTIVE_LOW",
  "INCENTIVE_MED",
  "INCENTIVE_HIGH"
];

const EPSILON = 0.1;

/* ─────────────────────────────────────────────
   PICK ACTION
───────────────────────────────────────────── */

export async function pickAction() {

  try {

    const result = await db.query(`
      SELECT
        action,
        pulls,
        rewards
      FROM bandit_state
    `);

    const rows = result.rows || [];

    /* FALLBACK IF TABLE EMPTY */

    if (rows.length === 0) {

      return ACTIONS[
        Math.floor(Math.random() * ACTIONS.length)
      ];

    }

    /* EXPLORATION */

    if (Math.random() < EPSILON) {

      return rows[
        Math.floor(Math.random() * rows.length)
      ].action;

    }

    /* EXPLOITATION */

    let bestAction = rows[0].action;
    let bestScore = -1;

    for (const row of rows) {

      const pulls = Number(row.pulls || 0);
      const rewards = Number(row.rewards || 0);

      const score =
        pulls === 0
          ? 0
          : rewards / pulls;

      if (score > bestScore) {
        bestScore = score;
        bestAction = row.action;
      }

    }

    return bestAction || "NONE";

  } catch (e) {

    console.error("[BANDIT PICK ERROR]", e.message);

    return "NONE";

  }

}

/* ─────────────────────────────────────────────
   UPDATE BANDIT
───────────────────────────────────────────── */

export async function updateBandit(action, converted) {

  try {

    await db.query(
      `
      UPDATE bandit_state
      SET
        pulls = pulls + 1,
        rewards = rewards + $1
      WHERE action = $2
      `,
      [
        converted ? 1 : 0,
        action
      ]
    );

  } catch (e) {

    console.error("[BANDIT UPDATE ERROR]", e.message);

  }

                             }
