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
    state TEXT DEFAULT 'EVALUATED',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER,
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

  db.run(
    `INSERT INTO decisions (session_id, cart_id, action)
     VALUES (?, ?, ?)`,
    [session_id, cart_id, action],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      res.json({
        decision_id: this.lastID,
        action
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
// OUTCOME
// ============================================

app.post('/outcome', (req, res) => {
  const { decision_id, converted = false, revenue = 0 } = req.body;

  if (!decision_id) {
    return res.status(400).json({ error: 'Missing decision_id' });
  }

  db.run(
    `INSERT INTO outcomes (decision_id, converted, final_revenue)
     VALUES (?, ?, ?)`,
    [decision_id, converted ? 1 : 0, revenue],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ ok: true });
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

app.listen(PORT, () => {
  console.log(`REDEN v1 running on ${PORT}`);
});
