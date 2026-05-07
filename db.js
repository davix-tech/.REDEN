import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* ─────────────────────────────
   INIT DATABASE
───────────────────────────── */
export async function initDB() {
  try {

    /* DECISIONS TABLE */
    await db.query(`
      CREATE TABLE IF NOT EXISTS decisions (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        cart_id TEXT NOT NULL,
        action TEXT NOT NULL,
        discount NUMERIC DEFAULT 0,
        expected_value NUMERIC DEFAULT 0,
        converted BOOLEAN DEFAULT false,
        revenue NUMERIC DEFAULT 0,
        state TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    /* BANDIT STATE TABLE */
    await db.query(`
      CREATE TABLE IF NOT EXISTS bandit_state (
        action TEXT PRIMARY KEY,
        pulls INTEGER DEFAULT 0,
        rewards NUMERIC DEFAULT 0
      )
    `);

    /* SEED ACTIONS */
    await db.query(`
      INSERT INTO bandit_state (action, pulls, rewards)
      VALUES
      ('NONE', 0, 0),
      ('INCENTIVE_LOW', 0, 0),
      ('INCENTIVE_MED', 0, 0),
      ('INCENTIVE_HIGH', 0, 0)
      ON CONFLICT (action) DO NOTHING
    `);

    console.log("[DB] initialized");

  } catch (e) {
    console.error("[DB INIT ERROR]", e.message);
  }
}
