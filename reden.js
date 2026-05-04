#!/usr/bin/env node

const express = require('express'); const sqlite3 = require('sqlite3').verbose(); const crypto = require('crypto');

const app = express(); app.use(express.json());

const PORT = process.env.PORT || 3000;

const ENGINE_VERSION = 'v2.2.0';

// ============================================ // DATABASE // ============================================

const db = new sqlite3.Database('./reden.db');

db.serialize(() => { db.run('PRAGMA foreign_keys = ON'); db.run('PRAGMA journal_mode = WAL');

db.run(CREATE TABLE IF NOT EXISTS sessions ( id TEXT PRIMARY KEY, experiment_group TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP ));

db.run(CREATE TABLE IF NOT EXISTS decision_policies ( id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT UNIQUE, rules TEXT, active BOOLEAN DEFAULT 0 ));

db.run(CREATE TABLE IF NOT EXISTS decisions ( id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT UNIQUE, session_id TEXT, cart_id TEXT, action TEXT, composite_score REAL, est_net_expected_value REAL, experiment_group TEXT, state TEXT DEFAULT 'EVALUATED', created_at DATETIME DEFAULT CURRENT_TIMESTAMP ));

db.run(CREATE TABLE IF NOT EXISTS outcomes ( id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id INTEGER, converted BOOLEAN, final_revenue REAL, discount_applied REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP ));

db.run( INSERT OR IGNORE INTO decision_policies (version, rules, active) VALUES (?, ?, 1), ['policy:v2.2', JSON.stringify({ weights: { velocity: 0.35, tab: 0.25, cart: 0.25, friction: 0.15 }, discount: { cap: 50 } })] ); });

// ============================================ // EXPERIMENT // ============================================

function assignGroup(sessionId) { const hash = crypto.createHash('md5').update(sessionId).digest('hex'); const bucket = parseInt(hash.slice(0, 8), 16) % 100; return bucket < 20 ? 'CONTROL' : 'TREATMENT'; }

// ============================================ // CORE MODEL // ============================================

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function computeScore(signals, weights) { return ( signals.velocity * weights.velocity + signals.tab * weights.tab + signals.cart * weights.cart + signals.friction * weights.friction ); }

function estimateConversion(score) { return sigmoid(3 * (score - 0.5)); }

function computeLift(score) { return 0.05 + (1 - score) * 0.25; }

function getDiscountPct(cart_value) { if (cart_value < 50) return 0.05; if (cart_value < 200) return 0.10; return 0.15; }

// ============================================ // POLICY // ============================================

function getPolicy() { return new Promise((resolve, reject) => { db.get( SELECT * FROM decision_policies WHERE active=1 LIMIT 1, (err, row) => { if (err) return reject(err); resolve({ id: row.id, rules: JSON.parse(row.rules) }); } ); }); }

// ============================================ // SCORE (NO SIGNATURE) // ============================================

app.post('/score', async (req, res) => { try { const { session_id, cart_id, cart_value = 0, signals = {}, time_since_last_activity = 0 } = req.body;

if (!session_id || !cart_id) {
  return res.status(400).json({
    error: 'Missing session_id or cart_id'
  });
}

const idempotency_key =
  req.body.idempotency_key ||
  crypto.randomBytes(12).toString('hex');

const existing = await new Promise((resolve) => {
  db.get(
    `SELECT * FROM decisions WHERE idempotency_key=?`,
    [idempotency_key],
    (_, row) => resolve(row)
  );
});

if (existing) {
  if (existing.cart_id !== cart_id) {
    return res.status(409).json({
      error: 'Idempotency key reused with different cart'
    });
  }
  return res.json(existing);
}

const policy = await getPolicy();
const group = assignGroup(session_id);

db.run(
  `INSERT OR IGNORE INTO sessions (id, experiment_group)
   VALUES (?, ?)`,
  [session_id, group]
);

const fullSignals = {
  velocity: signals.velocity || 0.5,
  tab: signals.tab || 0.5,
  cart: signals.cart || 0.5,
  friction: signals.friction || 0.5
};

let score = computeScore(fullSignals, policy.rules.weights);

const timeScore = Math.min(1, time_since_last_activity / 1800);
score = score * (1 - 0.5 * timeScore);

const pNo = estimateConversion(score);
const lift = computeLift(score);
const pYes = Math.min(1, pNo + lift);

const discountPct = getDiscountPct(cart_value);

const discount = Math.min(
  cart_value * discountPct,
  policy.rules.discount.cap
);

const evNo = pNo * cart_value * 0.35;
const evYes = pYes * (cart_value - discount) * 0.35;

let action = 'NONE';

if (evYes > evNo && evYes > 0) {
  if (discountPct <= 0.05) action = 'INCENTIVE_LOW';
  else if (discountPct <= 0.10) action = 'INCENTIVE_MED';
  else action = 'INCENTIVE_HIGH';
}

if (group === 'CONTROL') {
  action = 'NONE';
}

const netEV = Math.max(evYes, evNo);

console.log({
  session_id,
  score,
  action,
  evNo,
  evYes,
  group
});

const decisionId = await new Promise((resolve, reject) => {
  db.run(
    `INSERT INTO decisions
    (idempotency_key, session_id, cart_id, action,
     composite_score, est_net_expected_value, experiment_group)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      idempotency_key,
      session_id,
      cart_id,
      action,
      score,
      netEV,
      group
    ],
    function (err) {
      if (err) reject(err);
      else resolve(this.lastID);
    }
  );
});

res.json({
  decision_id: decisionId,
  action,
  score,
  ev_no: evNo,
  ev_yes: evYes,
  lift,
  discount,
  group
});

} catch (e) { res.status(500).json({ error: e.message }); } });

// ============================================ // ACTION (STATE TRANSITION) // ============================================

app.post('/action', (req, res) => { const { decision_id } = req.body;

if (!decision_id) { return res.status(400).json({ error: 'Missing decision_id' }); }

db.run( UPDATE decisions SET state='ACTIONED' WHERE id=? AND state='EVALUATED', [decision_id], function () { if (this.changes === 0) { return res.status(409).json({ error: 'Invalid state' }); } res.json({ ok: true }); } ); });

// ============================================

app.listen(PORT, () => { console.log([REDEN] ${ENGINE_VERSION} running); });
    
