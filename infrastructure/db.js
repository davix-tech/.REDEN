import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

/* ─────────────────────────────────────────────
   INIT DATABASE
───────────────────────────────────────────── */

export async function initDB() {
  try {
    /* ─────────────────────────────────────────
       SITES
       Core REDEN merchant installations
    ───────────────────────────────────────── */

    await db.query(`
      CREATE TABLE IF NOT EXISTS sites (
        id SERIAL PRIMARY KEY,
        site_id VARCHAR(100) UNIQUE NOT NULL,
        api_key VARCHAR(150) UNIQUE NOT NULL,
        name VARCHAR(150) NOT NULL,
        owner_email VARCHAR(255),
        active BOOLEAN DEFAULT true,
        plan VARCHAR(50) DEFAULT 'basic',
        subscription_status VARCHAR(50) DEFAULT 'inactive',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    /* ─────────────────────────────────────────
       DECISIONS
       Every revenue decision made by REDEN
    ───────────────────────────────────────── */

    await db.query(`
      CREATE TABLE IF NOT EXISTS decisions (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,
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

    /* ─────────────────────────────────────────
       BANDIT STATE
       Adaptive incentive intelligence
    ───────────────────────────────────────── */

    await db.query(`
      CREATE TABLE IF NOT EXISTS bandit_state (
        action TEXT PRIMARY KEY,
        pulls INTEGER DEFAULT 0,
        rewards NUMERIC DEFAULT 0
      )
    `);

    /* ─────────────────────────────────────────
       EVENT LOGS
       Raw storefront telemetry
    ───────────────────────────────────────── */

    await db.query(`
      CREATE TABLE IF NOT EXISTS event_logs (
        id SERIAL PRIMARY KEY,

        event_id TEXT UNIQUE NOT NULL,
        site_id VARCHAR(100) NOT NULL,
        session_id TEXT NOT NULL,

        event TEXT NOT NULL,
        payload JSONB,

        ip_address TEXT,
        user_agent TEXT,

        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    /* ─────────────────────────────────────────
       RECOVERY QUEUE
       Checkout abandonment / recovery engine
    ───────────────────────────────────────── */

    await db.query(`
      CREATE TABLE IF NOT EXISTS recovery_queue (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,
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

    /* ─────────────────────────────────────────
       REDEN INSTALLATIONS
       Installation registry / integration state
    ───────────────────────────────────────── */

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

    /* ─────────────────────────────────────────
       INTELLIGENCE
       What REDEN has concluded from the evidence
    ───────────────────────────────────────── */

    await db.query(`
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

        evidence JSONB DEFAULT '{}'::jsonb,

        status TEXT NOT NULL DEFAULT 'active'
          CHECK (
            status IN (
              'active',
              'resolved',
              'dismissed'
            )
          ),

        detected_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP,

        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    /* ─────────────────────────────────────────
       RECOMMENDATIONS
       Actions REDEN has recommended to merchant
    ───────────────────────────────────────── */

    await db.query(`
      CREATE TABLE IF NOT EXISTS recommendations (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,
        intelligence_id INTEGER REFERENCES intelligence(id)
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

        created_at TIMESTAMP DEFAULT NOW(),
        acted_at TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);

    /* ─────────────────────────────────────────
       INTELLIGENCE OUTCOMES
       Lets REDEN remember whether an insight
       or recommendation actually changed anything.
    ───────────────────────────────────────── */

    await db.query(`
      CREATE TABLE IF NOT EXISTS intelligence_outcomes (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,
        intelligence_id INTEGER REFERENCES intelligence(id)
          ON DELETE SET NULL,
        recommendation_id INTEGER REFERENCES recommendations(id)
          ON DELETE SET NULL,

        metric TEXT,
        before_value NUMERIC,
        after_value NUMERIC,
        change_percent NUMERIC,

        observed_at TIMESTAMP DEFAULT NOW()
      )
    `);

    /* ─────────────────────────────────────────
       REPORT RUNS
       Twice-daily REDEN intelligence briefings
    ───────────────────────────────────────── */

    await db.query(`
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

        intelligence_count INTEGER DEFAULT 0,

        summary JSONB DEFAULT '{}'::jsonb,

        sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),

        UNIQUE(site_id, report_type, report_date)
      )
    `);

    /* ─────────────────────────────────────────
       EMAIL LOGS
       Delivery history
    ───────────────────────────────────────── */

    await db.query(`
      CREATE TABLE IF NOT EXISTS email_logs (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,

        email_type TEXT NOT NULL,
        recipient TEXT NOT NULL,

        subject TEXT,
        status TEXT,

        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    /* ─────────────────────────────────────────
       SESSION SUMMARIES
       Aggregated behavioral understanding
    ───────────────────────────────────────── */

    await db.query(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id SERIAL PRIMARY KEY,

        site_id VARCHAR(100) NOT NULL,
        session_id TEXT NOT NULL,

        page_views INTEGER DEFAULT 0,
        product_views INTEGER DEFAULT 0,
        cart_additions INTEGER DEFAULT 0,

        checkout_started BOOLEAN DEFAULT false,
        purchased BOOLEAN DEFAULT false,

        cart_value NUMERIC DEFAULT 0,
        revenue NUMERIC DEFAULT 0,

        intent_score NUMERIC DEFAULT 0,

        first_seen_at TIMESTAMP,
        last_seen_at TIMESTAMP,

        updated_at TIMESTAMP DEFAULT NOW(),

        UNIQUE(site_id, session_id)
      )
    `);

    /* ─────────────────────────────────────────
       INDEXES
───────────────────────────────────────────── */

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_sites_owner_name
      ON sites(owner_email, name)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_sites_owner_email
      ON sites(owner_email)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_event_logs_site_id
      ON event_logs(site_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_event_logs_site_created
      ON event_logs(site_id, created_at DESC)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_event_logs_session
      ON event_logs(site_id, session_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_decisions_site_id
      ON decisions(site_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_decisions_site_created
      ON decisions(site_id, created_at DESC)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_decisions_site_state
      ON decisions(site_id, state)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_recovery_queue_status
      ON recovery_queue(status)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_recovery_queue_site
      ON recovery_queue(site_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_email_logs_lookup
      ON email_logs(email_type, recipient, subject)
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
      CREATE INDEX IF NOT EXISTS idx_intelligence_site_priority
      ON intelligence(site_id, priority, detected_at DESC)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_intelligence_site_status
      ON intelligence(site_id, status)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_recommendations_site_status
      ON recommendations(site_id, status)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_report_runs_site_date
      ON report_runs(site_id, report_date DESC)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_session_summaries_site
      ON session_summaries(site_id)
    `);

    /* ─────────────────────────────────────────
       SEED BANDIT ACTIONS
───────────────────────────────────────────── */

    await db.query(`
      INSERT INTO bandit_state (
        action,
        pulls,
        rewards
      )
      VALUES
        ('NONE', 0, 0),
        ('INCENTIVE_LOW', 0, 0),
        ('INCENTIVE_MED', 0, 0),
        ('INCENTIVE_HIGH', 0, 0)
      ON CONFLICT (action)
      DO NOTHING
    `);

    console.log(
      "[DB] REDEN database architecture initialized."
    );

  } catch (e) {
    console.error(
      "[DB INIT ERROR]",
      e
    );

    throw e;
  }
}
