import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("Missing mandatory environment variable: DATABASE_URL");
}

export const db = new Pool({
  connectionString: DATABASE_URL,

  ssl: {
    rejectUnauthorized: false,
  },

  max: Number(process.env.DB_POOL_MAX || 20),
  min: Number(process.env.DB_POOL_MIN || 2),

  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,

  application_name: "reden-api",
});

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

let initialized = false;
let initializing = null;

export async function initDB() {
  if (initialized) {
    return;
  }

  if (initializing) {
    return initializing;
  }

  initializing = initializeDatabase();

  try {
    await initializing;
    initialized = true;
  } finally {
    initializing = null;
  }
}

/* =========================================================
   SCHEMA

   This schema matches exactly what orchestrator/reden.js
   queries. It is NOT the same shape as earlier REDEN
   iterations -- decisions uses `score`/`actioned_at` here,
   not `discount`/`expected_value`/`cart_id`; recovery_queue
   uses `discount_percent`, not `incentive`/`cart_data`;
   email_logs uses `type`/`session_id`, not
   `email_type`/`recipient`/`subject`. If any other file in
   the codebase still queries the old column names, it will
   break against this schema -- that file needs updating to
   match reden.js, not this file reverted to match it.
========================================================= */

async function initializeDatabase() {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    /* =====================================================
       SITES

       Also created (IF NOT EXISTS) inline in reden.js on
       boot. Defined here too so initDB() alone is sufficient
       if reden.js's inline block is ever skipped or reordered.
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS sites (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) UNIQUE NOT NULL,
        api_key VARCHAR(150) UNIQUE NOT NULL,

        name VARCHAR(255) NOT NULL,
        owner_email VARCHAR(255),

        active BOOLEAN NOT NULL DEFAULT TRUE,

        plan VARCHAR(50) NOT NULL DEFAULT 'basic',

        subscription_status VARCHAR(50)
          NOT NULL DEFAULT 'inactive',

        timezone VARCHAR(64)
          NOT NULL DEFAULT 'Africa/Lagos',

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE sites
      ADD COLUMN IF NOT EXISTS timezone VARCHAR(64)
      NOT NULL DEFAULT 'Africa/Lagos'
    `);

    /* =====================================================
       DECISIONS

       score: numeric weight assigned in /score, replaces
       the old discount/expected_value pair.

       actioned_at: set when /action transitions
       SCORED -> ACTIONED. completed_at: set when /outcome
       transitions ACTIONED -> COMPLETED.
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS decisions (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,
        session_id TEXT NOT NULL,

        action TEXT NOT NULL,

        score NUMERIC(12,4)
          NOT NULL DEFAULT 0,

        converted BOOLEAN
          NOT NULL DEFAULT false,

        revenue NUMERIC(12,2)
          NOT NULL DEFAULT 0,

        state TEXT NOT NULL
          CHECK (
            state IN (
              'SCORED',
              'ACTIONED',
              'COMPLETED'
            )
          ),

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actioned_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      )
    `);

    /* =====================================================
       BANDIT STATE
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS bandit_state (
        site_id VARCHAR(100) NOT NULL,
        action TEXT NOT NULL,

        pulls INTEGER NOT NULL DEFAULT 0
          CHECK (pulls >= 0),

        rewards NUMERIC(12,4) NOT NULL DEFAULT 0
          CHECK (rewards >= 0),

        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        PRIMARY KEY (site_id, action)
      )
    `);

    /* =====================================================
       EVENT LOGS

       payload is the full event payload as JSONB. No
       ip_address/user_agent columns -- reden.js's /event
       insert doesn't populate them, so they aren't declared
       here. Add them back only if /event is updated to
       capture them.
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS event_logs (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,
        session_id TEXT NOT NULL,

        event_id TEXT NOT NULL,
        event TEXT NOT NULL,

        payload JSONB NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (site_id, event_id)
      )
    `);

    /* =====================================================
       RECOVERY QUEUE

       customer_email is nullable here because reden.js's
       current /event handler does not populate it on insert.
       sendRecoveryEmail() has nowhere to send until that
       insert is updated to capture payload.email. Leaving
       the column nullable means the schema won't block that
       fix once it's made -- it does not fix the gap itself.
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS recovery_queue (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,
        session_id TEXT NOT NULL,

        customer_email TEXT,

        discount_percent NUMERIC(5,2)
          NOT NULL DEFAULT 10,

        status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (
            status IN (
              'PENDING',
              'PROCESSING',
              'SENT',
              'COMPLETED',
              'FAILED'
            )
          ),

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (site_id, session_id)
      )
    `);

    // CREATE TABLE IF NOT EXISTS does not add columns to an
    // existing table. Older production schemas may lack updated_at,
    // which the recovery cron uses to recover stale PROCESSING jobs.
    await client.query(`
      ALTER TABLE recovery_queue
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    // Older production databases may predate discount_percent. The
    // CHECKOUT_STARTED event transaction inserts this column, and the
    // recovery cron reads it, so migrate existing tables as well as
    // defining it in CREATE TABLE above.
    await client.query(`
      ALTER TABLE recovery_queue
      ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2)
      NOT NULL DEFAULT 10
    `);

    /* =====================================================
       EMAIL LOGS

       type: 'RECOVERY' | 'DAILY_REPORT'. session_id is
       nullable because DAILY_REPORT entries are per-site,
       not per-session.
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_logs (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,
        session_id TEXT,

        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'SENT',

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* =====================================================
       SESSION SUMMARIES

       purchased_at: set at the moment a PURCHASE event is
       recorded for this session (written by
       contextEngine.updateSessionContext()), NOT bumped by
       unrelated session activity the way updated_at is.
       This is what the intelligence route's purchase-revenue
       query filters on.
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,
        session_id TEXT NOT NULL,

        page_views INTEGER NOT NULL DEFAULT 0,
        product_views INTEGER NOT NULL DEFAULT 0,
        cart_additions INTEGER NOT NULL DEFAULT 0,

        checkout_started BOOLEAN NOT NULL DEFAULT false,
        purchased BOOLEAN NOT NULL DEFAULT false,

        cart_value NUMERIC(12,2) NOT NULL DEFAULT 0,
        revenue NUMERIC(12,2) NOT NULL DEFAULT 0,

        intent_score NUMERIC(8,4) NOT NULL DEFAULT 0,

        first_seen_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        purchased_at TIMESTAMPTZ,

        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (site_id, session_id)
      )
    `);

    // CREATE TABLE IF NOT EXISTS does not upgrade an existing production table.
    // Explicitly migrate every session field used by the SDK and intelligence queries.
    // This keeps older databases from breaking /intelligence when new evidence is queried.
    await client.query(`
      ALTER TABLE session_summaries
        ADD COLUMN IF NOT EXISTS page_views INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS product_views INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cart_additions INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS checkout_started BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS purchased BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS cart_value NUMERIC(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS intent_score NUMERIC(8,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS traffic_source VARCHAR(50),
        ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(255)
    `);

    /*
     * Backfill from the actual first PURCHASE event per
     * session, not from updated_at (which reflects session
     * activity time, not purchase time). Also performed
     * inline in reden.js on boot; kept here too so initDB()
     * alone is sufficient.
     */
    await client.query(`
      UPDATE session_summaries ss
      SET purchased_at = (
        SELECT MIN(el.created_at)
        FROM event_logs el
        WHERE el.site_id = ss.site_id
          AND el.session_id = ss.session_id
          AND el.event = 'PURCHASE'
      )
      WHERE ss.purchased = TRUE
        AND ss.purchased_at IS NULL
    `);

    /* =====================================================
       INTELLIGENCE ANSWERS

       Audit log: every question REDEN answers, the evidence
       it saw, which intents matched, and the answer given.
       Also created inline in reden.js on boot.
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS intelligence_answers (
        id BIGSERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,

        question TEXT NOT NULL,
        answer TEXT NOT NULL,

        evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        intents JSONB NOT NULL DEFAULT '[]'::jsonb,

        latency_ms INTEGER,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* =====================================================
       INDEXES
    ===================================================== */

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sites_owner_email
      ON sites (LOWER(owner_email))
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sites_name
      ON sites (LOWER(name))
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_decisions_site_completed
      ON decisions (site_id, completed_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_decisions_site_session_state
      ON decisions (site_id, session_id, state)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bandit_state_site
      ON bandit_state (site_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_event_logs_site_created
      ON event_logs (site_id, created_at DESC)
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_event_logs_site_event_id
      ON event_logs (site_id, event_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_recovery_site_status
      ON recovery_queue (site_id, status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_logs_site_created
      ON email_logs (site_id, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_summaries_site_updated
      ON session_summaries (site_id, updated_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_summaries_site_session
      ON session_summaries (site_id, session_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_intelligence_answers_site_created
      ON intelligence_answers (site_id, created_at DESC)
    `);

    /* =====================================================
       COMMIT
    ===================================================== */

    await client.query("COMMIT");

    console.log(
      "[DB] REDEN database schema initialized (matches reden.js query shape)."
    );
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("[DB INIT ERROR]", error);

    throw error;
  } finally {
    client.release();
  }
}

/* =========================================================
   CONNECTION ERROR
========================================================= */

db.on("error", (error) => {
  console.error("[DB POOL ERROR]", error);
});
