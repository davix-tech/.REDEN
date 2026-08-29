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
========================================================= */

async function initializeDatabase() {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    /* =====================================================
       SITES
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS sites (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) UNIQUE NOT NULL,
        api_key VARCHAR(150) UNIQUE NOT NULL,

        name VARCHAR(255) NOT NULL,
        owner_email VARCHAR(255),

        active BOOLEAN NOT NULL DEFAULT true,

        plan VARCHAR(50) NOT NULL DEFAULT 'basic',

        subscription_status VARCHAR(50)
          NOT NULL DEFAULT 'inactive',

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* =====================================================
       DECISIONS
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS decisions (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,

        session_id TEXT NOT NULL,
        cart_id TEXT,

        action TEXT NOT NULL,

        discount NUMERIC(12,2)
          NOT NULL DEFAULT 0,

        expected_value NUMERIC(12,2)
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

        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* =====================================================
       BANDIT STATE
       IMPORTANT:
       Bandit state is tenant-specific.
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
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS event_logs (
        id SERIAL PRIMARY KEY,

        event_id TEXT NOT NULL,
        site_id VARCHAR(100) NOT NULL,

        session_id TEXT NOT NULL,

        event TEXT NOT NULL,

        payload JSONB NOT NULL DEFAULT '{}'::jsonb,

        ip_address INET,
        user_agent TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE(site_id, event_id)
      )
    `);

    /* =====================================================
       RECOVERY QUEUE
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS recovery_queue (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,

        session_id TEXT NOT NULL,
        customer_email TEXT NOT NULL,

        cart_data JSONB NOT NULL DEFAULT '{}'::jsonb,

        incentive TEXT,

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

        attempts INTEGER NOT NULL DEFAULT 0
          CHECK (attempts >= 0),

        last_error TEXT,

        processed_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE(site_id, session_id, customer_email)
      )
    `);

    /* =====================================================
       INSTALLATIONS
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS reden_installations (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) UNIQUE NOT NULL,

        name TEXT NOT NULL,
        owner_email TEXT NOT NULL,

        api_key_hash TEXT NOT NULL,

        status TEXT NOT NULL DEFAULT 'active'
          CHECK (
            status IN (
              'active',
              'disabled'
            )
          ),

        first_event_at TIMESTAMPTZ,
        last_event_at TIMESTAMPTZ,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* =====================================================
       INTELLIGENCE
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS intelligence (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,

        type TEXT NOT NULL,

        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK (
            priority IN (
              'low',
              'normal',
              'high',
              'critical'
            )
          ),

        title TEXT NOT NULL,
        summary TEXT NOT NULL,

        why_it_matters TEXT,
        likely_cause TEXT,
        recommendation TEXT,

        evidence JSONB NOT NULL DEFAULT '{}'::jsonb,

        status TEXT NOT NULL DEFAULT 'active'
          CHECK (
            status IN (
              'active',
              'resolved',
              'dismissed'
            )
          ),

        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        resolved_at TIMESTAMPTZ,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* =====================================================
       RECOMMENDATIONS
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS recommendations (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,

        intelligence_id INTEGER
          REFERENCES intelligence(id)
          ON DELETE SET NULL,

        recommendation TEXT NOT NULL,

        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (
            status IN (
              'pending',
              'accepted',
              'rejected',
              'completed',
              'expired'
            )
          ),

        outcome TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        acted_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      )
    `);

    /* =====================================================
       INTELLIGENCE OUTCOMES
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS intelligence_outcomes (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,

        intelligence_id INTEGER
          REFERENCES intelligence(id)
          ON DELETE SET NULL,

        recommendation_id INTEGER
          REFERENCES recommendations(id)
          ON DELETE SET NULL,

        metric TEXT,

        before_value NUMERIC(12,4),
        after_value NUMERIC(12,4),
        change_percent NUMERIC(12,4),

        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* =====================================================
       REPORT RUNS
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS report_runs (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,

        report_type TEXT NOT NULL
          CHECK (
            report_type IN (
              'MORNING',
              'EVENING'
            )
          ),

        report_date DATE NOT NULL,

        status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (
            status IN (
              'PENDING',
              'SENT',
              'FAILED',
              'SKIPPED'
            )
          ),

        intelligence_count INTEGER NOT NULL DEFAULT 0,

        summary JSONB NOT NULL DEFAULT '{}'::jsonb,

        sent_at TIMESTAMPTZ,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE(
          site_id,
          report_type,
          report_date
        )
      )
    `);

    /* =====================================================
       EMAIL LOGS
    ===================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_logs (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,

        email_type TEXT NOT NULL,

        recipient TEXT NOT NULL,

        subject TEXT,

        status TEXT NOT NULL DEFAULT 'SENT',

        provider_message_id TEXT,

        error_message TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* =====================================================
       SESSION SUMMARIES
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

        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE(site_id, session_id)
      )
    `);

    /* =====================================================
       INDEXES
    ===================================================== */

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sites_owner_email
      ON sites(owner_email)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sites_owner_name
      ON sites(owner_email, name)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_event_logs_site_created
      ON event_logs(site_id, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_event_logs_session
      ON event_logs(site_id, session_id, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_event_logs_event
      ON event_logs(site_id, event, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_decisions_site_created
      ON decisions(site_id, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_decisions_site_state
      ON decisions(site_id, state)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_decisions_completed
      ON decisions(site_id, completed_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_recovery_queue_pending
      ON recovery_queue(
        status,
        next_attempt_at,
        created_at
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_recovery_queue_site
      ON recovery_queue(site_id, status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_logs_lookup
      ON email_logs(
        site_id,
        email_type,
        created_at DESC
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_intelligence_site_status
      ON intelligence(
        site_id,
        status,
        detected_at DESC
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_recommendations_site_status
      ON recommendations(
        site_id,
        status,
        created_at DESC
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_report_runs_site_date
      ON report_runs(
        site_id,
        report_date DESC
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_summaries_site
      ON session_summaries(site_id)
    `);

    /* =====================================================
       SEED BANDIT ACTIONS FOR EXISTING SITES
    ===================================================== */

    await client.query(`
      INSERT INTO bandit_state (
        site_id,
        action,
        pulls,
        rewards
      )
      SELECT
        site_id,
        action,
        0,
        0
      FROM sites
      CROSS JOIN (
        VALUES
          ('NONE'),
          ('INCENTIVE_LOW'),
          ('INCENTIVE_MED'),
          ('INCENTIVE_HIGH')
      ) AS actions(action)

      ON CONFLICT (
        site_id,
        action
      )
      DO NOTHING
    `);

    await client.query("COMMIT");

    console.log(
      "[DB] REDEN production database architecture initialized."
    );
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "[DB INIT ERROR]",
      error
    );

    throw error;
  } finally {
    client.release();
  }
}

/* =========================================================
   CONNECTION ERROR
========================================================= */

db.on("error", (error) => {
  console.error(
    "[DB POOL ERROR]",
    error
  );
});
