#!/usr/bin/env node

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.WEBHOOK_SECRET) {
  console.error("Missing WEBHOOK_SECRET");
  process.exit(1);
}
const SECRET = process.env.WEBHOOK_SECRET;

const ENGINE_VERSION = 'v1.0.1-production';

// ============================================
// DATABASE
// ============================================

const db = new sqlite3.Database('./reden.db');
db.run('PRAGMA foreign_keys = ON');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      cart_id TEXT,
      email TEXT,
      data TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cart_id TEXT,
      experiment_group TEXT CHECK(experiment_group IN ('CONTROL', 'TREATMENT')) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS decision_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      rules TEXT NOT NULL,
      active BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT UNIQUE NOT NULL,
      session_id TEXT NOT NULL,
      cart_id TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      policy_version_id INTEGER NOT NULL,
      state TEXT CHECK(state IN ('EVALUATED', 'ACTIONED', 'DELIVERED')) DEFAULT 'EVALUATED',
      cart_value REAL NOT NULL,
      item_count INTEGER NOT NULL,
      velocity_score REAL,
      tab_score REAL,
      cart_comp_score REAL,
      friction_score REAL,
      composite_score REAL,
      action TEXT CHECK(action IN ('SUPPRESS', 'REMIND', 'INCENTIVISE', 'NONE')) NOT NULL,
      reason_code TEXT NOT NULL,
      experiment_group TEXT CHECK(experiment_group IN ('CONTROL', 'TREATMENT')) NOT NULL,
      discount_type TEXT,
      discount_value REAL,
      discount_cap REAL,
      est_prob_conversion_no_action REAL,
      est_prob_conversion_with_action REAL,
      est_expected_lift_value REAL,
      est_expected_discount_cost REAL,
      est_net_expected_value REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (policy_version_id) REFERENCES decision_policies(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER,
      cart_id TEXT,
      session_id TEXT,
      converted BOOLEAN DEFAULT 0,
      final_revenue REAL DEFAULT 0,
      discount_applied REAL DEFAULT 0,
      final_margin REAL DEFAULT 0,
      observed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(decision_id),
      UNIQUE(cart_id),
      FOREIGN KEY (decision_id) REFERENCES decisions(id)
    )
  `);

  db.run(
    `INSERT OR IGNORE INTO decision_policies (version, rules, active) VALUES (?, ?, 1)`,
    ['policy:v1.0', JSON.stringify({
      velocity_weight: 0.35,
      tab_weight: 0.25,
      cart_comp_weight: 0.25,
      friction_weight: 0.15,
      suppress_threshold: 0.75,
      remind_threshold: 0.40,
      incentivise_discount_pct: 10,
      incentivise_discount_cap: 50
    })]
  );

  db.run(`CREATE INDEX IF NOT EXISTS idx_log_cart_id ON log(cart_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_log_timestamp ON log(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_decisions_session_id ON decisions(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_decisions_cart_id ON decisions(cart_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_outcomes_decision_id ON outcomes(decision_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_outcomes_cart_id ON outcomes(cart_id)`);
});

// ============================================
// HELPERS
// ============================================

function generateIdempotencyKey() {
  return crypto.randomBytes(16).toString('hex');
}

function safeJSONParse(input) {
  try {
    return JSON.parse(input || '{}');
  } catch {
    return {};
  }
}

function safeCompare(a, b) {
  const bufA = Buffer.from(a || '');
  const bufB = Buffer.from(b || '');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function log(type, cartId, email, data) {
  db.run(
    `INSERT INTO log (event_type, cart_id, email, data) VALUES (?, ?, ?, ?)`,
    [type, cartId, email, JSON.stringify(data)],
    (err) => {
      if (err) console.error('LOG ERROR:', err);
    }
  );
}

// ============================================
// EXPERIMENT
// ============================================

function assignExperimentGroup(sessionId) {
  return new Promise((resolve, reject) => {
    const group = Math.random() < 0.05 ? 'CONTROL' : 'TREATMENT';

    db.run(
      `INSERT INTO sessions (id, experiment_group)
       VALUES (?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [sessionId, group],
      (err) => {
        if (err) return reject(err);
        resolve(group);
      }
    );
  });
}

function getExperimentGroup(sessionId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT experiment_group FROM sessions WHERE id = ?`,
      [sessionId],
      (err, row) => {
        if (err) return reject(err);
        if (row?.experiment_group) return resolve(row.experiment_group);
        assignExperimentGroup(sessionId).then(resolve).catch(reject);
      }
    );
  });
}

// ============================================
// POLICY
// ============================================

function getActivePolicy() {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id, version, rules FROM decision_policies WHERE active = 1 LIMIT 1`,
      (err, row) => {
        if (err) return reject(err);
        if (!row) return reject(new Error('No active policy'));
        resolve(row);
      }
    );
  });
}

// ============================================
// SIGNALS
// ============================================

function extractSignals(cartId, decisionTimestamp) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT event_type, data, timestamp FROM log 
       WHERE cart_id = ? AND timestamp <= ?
       ORDER BY timestamp ASC`,
      [cartId, decisionTimestamp],
      (err, rows) => {
        if (err) return reject(err);

        const signals = {
          velocity: 0.5,
          tab: 0.5,
          cart_comp: 0.5,
          friction: 0.5
        };

        if (!rows?.length) return resolve(signals);

        const events = rows.map(r => ({
          type: r.event_type,
          data: safeJSONParse(r.data),
          ts: new Date(r.timestamp)
        }));

        const first = events[0];
        const webhook = [...events].reverse().find(e => e.type === 'webhook');

        if (first && webhook) {
          const delta = (webhook.ts - first.ts) / 1000;
          signals.velocity = delta < 180 ? 1.0 : delta < 600 ? 0.7 : 0.3;
        }

        const tracks = events.filter(e => e.type === 'track');
        if (tracks.length) {
          const last = tracks[tracks.length - 1];
          const tabSwitches = last.data.tab_switch_count || 0;

          signals.tab =
            tabSwitches === 0 ? 1.0 :
            tabSwitches <= 2 ? 0.6 : 0.2;

          if (last.data.friction_clicks?.shipping || last.data.friction_clicks?.returns) {
            signals.friction = 0.7;
          }
        }

        if (webhook) {
          const value = webhook.data.total_price || 0;
          const items = webhook.data.items || 0;

          signals.cart_comp =
            value > 200 && items === 1 ? 0.8 :
            items >= 3 ? 0.4 : 0.6;
        }

        resolve(signals);
      }
    );
  });
}

// ============================================
// SCORING
// ============================================

function scoreSignals(signals, policy) {
  const rules = safeJSONParse(policy.rules);

  return Math.round((
    signals.velocity * rules.velocity_weight +
    signals.tab * rules.tab_weight +
    signals.cart_comp * rules.cart_comp_weight +
    signals.friction * rules.friction_weight
  ) * 100) / 100;
}

function decideAction(score, policy) {
  const rules = safeJSONParse(policy.rules);

  if (score >= rules.suppress_threshold) return 'SUPPRESS';
  if (score >= rules.remind_threshold) return 'REMIND';
  return 'INCENTIVISE';
}

function reasonCodeForAction(action) {
  if (action === 'SUPPRESS') return 'PREMIUM_PROTECTION';
  if (action === 'REMIND') return 'GENTLE_NUDGE';
  return 'MARGIN_RECOVERY';
}

// ============================================
// COUNTERFACTUALS
// ============================================

function calculateCounterfactuals(score, cartValue, action, policy) {
  const rules = safeJSONParse(policy.rules);
  const margin = 0.35;

  const p0 = Math.min(0.95, score);
  const p1 = Math.min(0.95, p0 + 0.15);

  const lift = (p1 - p0) * cartValue * margin;

  let discountCost = 0;
  let discountType = null;
  let discountValue = 0;
  let discountCap = 0;

  if (action === 'INCENTIVISE') {
    discountType = 'percentage';
    discountValue = rules.incentivise_discount_pct;
    discountCap = rules.incentivise_discount_cap;

    const discount = Math.min(cartValue * discountValue / 100, discountCap);
    discountCost = discount * p1;
  }

  return {
    probWithoutAction: Math.round(p0 * 100) / 100,
    probWithAction: Math.round(p1 * 100) / 100,
    expectedLiftValue: Math.round(lift * 100) / 100,
    expectedDiscountCost: Math.round(discountCost * 100) / 100,
    netExpectedValue: Math.round((lift - discountCost) * 100) / 100,
    discountType,
    discountValue,
    discountCap
  };
}

// ============================================
// ENDPOINTS
// ============================================

app.use(express.json({ verify: (req, res, buf) => (req.rawBody = buf) }));

// (rest unchanged: webhook, track, score, action, outcome, health)

app.listen(PORT, () => {
  console.log(`[REDEN] ${ENGINE_VERSION} running`);
});
