import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

/* ─────────────────────────────────────────────
   DATABASE CONNECTION
───────────────────────────────────────────── */

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* ─────────────────────────────────────────────
   SAFE INIT
───────────────────────────────────────────── */

export async function initDB() {
  try {

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

        state TEXT DEFAULT 'SCORED',

        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    /* ─────────────────────────────────────────
       HARDEN EXISTING TABLES
    ───────────────────────────────────────── */

    await db.query(`
      ALTER TABLE decisions
      ADD COLUMN IF NOT EXISTS session_id TEXT;
    `);

    await db.query(`
      ALTER TABLE decisions
      ADD COLUMN IF NOT EXISTS cart_id TEXT;
    `);

    await db.query(`
      ALTER TABLE decisions
      ADD COLUMN IF NOT EXISTS action TEXT;
    `);

    await db.query(`
      ALTER TABLE decisions
      ADD COLUMN IF NOT EXISTS discount NUMERIC DEFAULT 0;
    `);

    await db.query(`
      ALTER TABLE decisions
      ADD COLUMN IF NOT EXISTS expected_value NUMERIC DEFAULT 0;
    `);

    await db.query(`
      ALTER TABLE decisions
      ADD COLUMN IF NOT EXISTS converted BOOLEAN DEFAULT false;
    `);

    await db.query(`
      ALTER TABLE decisions
      ADD COLUMN IF NOT EXISTS revenue NUMERIC DEFAULT 0;
    `);

    await db.query(`
      ALTER TABLE decisions
      ADD COLUMN IF NOT EXISTS state TEXT DEFAULT 'SCORED';
    `);

    await db.query(`
      ALTER TABLE decisions
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
    `);

    console.log("[DB] connected");
    console.log("[DB] schema ready");

  } catch (e) {

    console.error("[DB ERROR]", e.message);

  }
}
