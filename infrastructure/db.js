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
        cart_id TEXT,
        action TEXT NOT NULL,
        discount NUMERIC DEFAULT 0,
        expected_value NUMERIC DEFAULT 0,
        converted BOOLEAN DEFAULT false,
        revenue NUMERIC DEFAULT 0,
        state TEXT NOT NULL,
        completed_at TIMESTAMP,
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

    /* EVENT LOGS TABLE (Missing from original) */
    await db.query(`
      CREATE TABLE IF NOT EXISTS event_logs (
        id SERIAL PRIMARY KEY,
        event_id TEXT UNIQUE NOT NULL,
        site_id VARCHAR(50) NOT NULL,
        session_id TEXT NOT NULL,
        event TEXT NOT NULL,
        payload JSONB,
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    /* RECOVERY QUEUE TABLE (Missing from original) */
    await db.query(`
      CREATE TABLE IF NOT EXISTS recovery_queue (
        id SERIAL PRIMARY KEY,
        site_id VARCHAR(50) NOT NULL,
        session_id TEXT NOT NULL,
        customer_email TEXT NOT NULL,
        cart_data JSONB,
        incentive TEXT,
        status TEXT DEFAULT 'PENDING',
        processed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(session_id, customer_email)
      )
    `);

    /* REDEN INSTALLATIONS */
await db.query(`
  CREATE TABLE IF NOT EXISTS reden_installations (
    id SERIAL PRIMARY KEY,
    site_id VARCHAR(100) UNIQUE NOT NULL,
    name TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'disabled')),
    first_event_at TIMESTAMP,
    last_event_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_reden_installations_owner_email
  ON reden_installations(owner_email)
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_reden_installations_status
  ON reden_installations(status)
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_event_logs_site_id
  ON event_logs(site_id)
`);
    
    /* EMAIL LOGS TABLE (Missing from original) */
    await db.query(`
      CREATE TABLE IF NOT EXISTS email_logs (
        id SERIAL PRIMARY KEY,
        site_id VARCHAR(50) NOT NULL,
        email_type TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT,
        status TEXT,
        created_at TIMESTAMP DEFAULT NOW()
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

    console.log("[DB] initialized all tables");
  } catch (e) {
    console.error("[DB INIT ERROR]", e.message);
  }
}
