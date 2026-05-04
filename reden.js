#!/usr/bin/env node

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ENGINE_VERSION = 'v1.0';

// ============================================
// DATABASE
// ============================================

const db = new sqlite3.Database('./reden.db');

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA journal_mode = WAL');

  db.run(`CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT UNIQUE,
    session_id TEXT,
    cart_id TEXT,
    action TEXT,
    state TEXT DEFAULT 'EVALUATED',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ============================================
// SCORE (BASIC)
// ============================================

app.post('/score', (req, res) => {
  const { session_id, cart_id } = req.body;

  if (!session_id || !cart_id) {
    return res.status(400).json({
      error: 'Missing session_id or cart_id'
    });
  }

  const idempotency_key =
    req.body.idempotency_key ||
    crypto.randomBytes(12).toString('hex');

  db.get(
    `SELECT * FROM decisions WHERE idempotency_key=?`,
    [idempotency_key],
    (err, existing) => {
      if (existing) return res.json(existing);

      const action = 'NONE';

      db.run(
        `INSERT INTO decisions
        (idempotency_key, session_id, cart_id, action)
        VALUES (?, ?, ?, ?)`,
        [idempotency_key, session_id, cart_id, action],
        function () {
          res.json({
            decision_id: this.lastID,
            action
          });
        }
      );
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

app.listen(PORT, () => {
  console.log(`[REDEN] ${ENGINE_VERSION} running`);
});
