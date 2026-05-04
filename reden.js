#!/usr/bin/env node

const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ============================================
// DATABASE
// ============================================

const db = new sqlite3.Database('./reden.db');

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    cart_id TEXT,
    action TEXT,
    discount REAL DEFAULT 0,
    state TEXT DEFAULT 'EVALUATED',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER UNIQUE,
    converted BOOLEAN,
    final_revenue REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ============================================
// SCORE
// ============================================

app.post('/score', (req, res) => {
  const { session_id, cart_id, cart_value = 0 } = req.body;

  if (!session_id || !cart_id) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  let action = 'NONE';

  if (cart_value > 200) action = 'INCENTIVE_HIGH';
  else if (cart_value > 100) action = 'INCENTIVE_MED';
  else if (cart_value > 50) action = 'INCENTIVE_LOW';

  // Exploration (10% chance override)
  if (Math.random() < 0.1) {
    action = 'NONE';
  }

  let discount = 0;
  if (action === 'INCENTIVE_LOW') discount = 5;
  if (action === 'INCENTIVE_MED') discount = 10;
  if (action === 'INCENTIVE_HIGH') discount = 15;

  db.run(
    `INSERT INTO decisions (session_id, cart_id, action, discount)
     VALUES (?, ?, ?, ?)`,
    [session_id, cart_id, action, discount],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      res.json({
        decision_id: this.lastID,
        action,
        discount
      });
    }
  );
});

// ============================================
// ACTION
// ============================================

app.post('/action', (req, res) => {
  const { decision_id } = req.body;

  if (!decision_id) {
    return res.status(400).json({ error: 'Missing decision_id' });
  }

  db.run(
    `UPDATE decisions
     SET state='ACTIONED'
     WHERE id=? AND state='EVALUATED'`,
    [decision_id],
    function () {
      if (this.changes === 0) {
        return res.status(409).json({ error: 'Invalid state' });
      }
      res.json({ ok: true });
    }
  );
});

// ============================================
// OUTCOME (VALIDATED)
// ============================================

app.post('/outcome', (req, res) => {
  const { decision_id, converted = false, revenue = 0 } = req.body;

  if (!decision_id) {
    return res.status(400).json({ error: 'Missing decision_id' });
  }

  db.get(
    `SELECT state FROM decisions WHERE id=?`,
    [decision_id],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      if (!row || row.state !== 'ACTIONED') {
        return res.status(409).json({ error: 'Decision not actioned' });
      }

      db.run(
        `INSERT INTO outcomes (decision_id, converted, final_revenue)
         VALUES (?, ?, ?)`,
        [decision_id, converted ? 1 : 0, revenue],
        function (err) {
          if (err) {
            return res.status(409).json({ error: 'Outcome already recorded' });
          }
          res.json({ ok: true });
        }
      );
    }
  );
});

// ============================================
// OUTCOMES (READ)
// ============================================

app.get('/outcomes', (req, res) => {
  db.all(
    `SELECT * FROM outcomes ORDER BY created_at DESC LIMIT 50`,
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

// ============================================
// METRICS
// ============================================

app.get('/metrics', (req, res) => {
  db.all(`SELECT * FROM outcomes`, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    const total = rows.length;
    const conversions = rows.filter(r => r.converted).length;
    const revenue = rows.reduce((sum, r) => sum + r.final_revenue, 0);

    res.json({
      total,
      conversions,
      conversion_rate: total ? conversions / total : 0,
      avg_revenue: total ? revenue / total : 0
    });
  });
});

// ============================================

app.listen(PORT, () => {
  console.log(`REDEN v1.1 running on ${PORT}`);
});
