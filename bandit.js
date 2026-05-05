import { db } from "./db.js";

export async function pickAction() {
  const { rows } = await db.query("SELECT * FROM bandit_state");

  let best = null;
  let bestScore = -1;

  for (const r of rows) {
    const alpha = r.wins;
    const beta = r.trials - r.wins;

    const score = Math.random() * (alpha / (alpha + beta));

    if (score > bestScore) {
      bestScore = score;
      best = r.action;
    }
  }

  return best;
}

export async function updateBandit(action, converted) {
  if (converted) {
    await db.query(
      "UPDATE bandit_state SET wins = wins + 1, trials = trials + 1 WHERE action=$1",
      [action]
    );
  } else {
    await db.query(
      "UPDATE bandit_state SET trials = trials + 1 WHERE action=$1",
      [action]
    );
  }
}
