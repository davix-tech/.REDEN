#!/usr/bin/env node

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

// ============================================
// BASIC HEALTH (IMPORTANT FOR BROWSER)
// ============================================

app.get('/', (req, res) => {
  res.send('REDEN v1 LIVE');
});

// quick sanity test (end-to-end check)
app.get('/testflow', (req, res) => {
  res.json({ ok: true, message: 'API working' });
});

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
// LEARNED PROBABILITIES
// ============================================

function getConversionRates(callback) {
  db.all(
    `
    SELECT d.action,
           COUNT(*) as total,
           SUM(o.converted) as conversions
    FROM outcomes o
    JOIN decisions d ON o.decision_id = d.id
    GROUP BY d.action
    `,
    (err, rows) => {
      if (err) return callback(err);

      const rates = {
        NONE: 0.2,
        INCENTIVE_LOW: 0.25,
        INCENTIVE_MED: 0.3,
        INCENTIVE_HIGH: 0.35
      };

      rows.forEach(r => {
        if (r.total > 0) {
          rates[r.action] = r.conversions / r.total;
        }
      });

      callback(null, rates);
    }
  );
}

// ============================================
// SCORE
// ============================================

app.post('/score', (req, res) => {
  const { session_id, cart_id, cart_value = 0 } = req.body;

  if (!session_id || !cart_id) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  getConversionRates((err, rates) => {
    if (err) return res.status(500).json({ error: err.message });

    const dLow = 5;
    const dMed = 10;
    const dHigh = 15;

    const evNone = rates.NONE * cart_value;
    const evLow = rates.INCENTIVE_LOW * (cart_value - dLow);
    const evMed = rates.INCENTIVE_MED * (cart_value - dMed);
    const evHigh = rates.INCENTIVE_HIGH * (cart_value - dHigh);

    let action = 'NONE';
    let discount = 0;
    let bestEV = evNone;

    if (evLow > bestEV) {
      action = 'INCENTIVE_LOW';
      discount = dLow;
      bestEV = evLow;
    }

    if (evMed > bestEV) {
      action = 'INCENTIVE_MED';
      discount = dMed;
      bestEV = evMed;
    }

    if (evHigh > bestEV) {
      action = 'INCENTIVE_HIGH';
      discount = dHigh;
      bestEV = evHigh;
    }

    // exploration
    if (Math.random() < 0.1) {
      action = 'NONE';
      discount = 0;
    }

    db.run(
      `INSERT INTO decisions (session_id, cart_id, action, discount)
       VALUES (?, ?, ?, ?)`,
      [session_id, cart_id, action, discount],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });

        console.log('DECISION:', action, discount);

        res.json({
          decision_id: this.lastID,
          action,
          discount,
          expected_value: bestEV,
          rates_used: rates
        });
      }
    );
  });
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

  db.get(
    `SELECT state FROM decisions WHERE id=?`,
    [decision_id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });

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

          console.log('OUTCOME:', decision_id, converted, revenue);

          res.json({ ok: true });
        }
      );
    }
  );
});

// ============================================
// OUTCOMES
// ============================================

app.get('/outcomes', (req, res) => {
  db.all(
    `SELECT * FROM outcomes ORDER BY created_at DESC LIMIT 50`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ============================================
// METRICS
// ============================================

app.get('/metrics', (req, res) => {
  db.all(`SELECT * FROM outcomes`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

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
// METRICS BY ACTION
// ============================================

app.get('/metrics/actions', (req, res) => {
  db.all(
    `
    SELECT 
      d.action,
      COUNT(*) as total,
      SUM(o.converted) as conversions,
      AVG(o.final_revenue) as avg_revenue
    FROM outcomes o
    JOIN decisions d ON o.decision_id = d.id
    GROUP BY d.action
    `,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const result = rows.map(r => ({
        action: r.action,
        total: r.total,
        conversions: r.conversions || 0,
        conversion_rate: r.total ? r.conversions / r.total : 0,
        avg_revenue: r.avg_revenue || 0
      }));

      res.json(result);
    }
  );
});

// ============================================

app.listen(PORT, () => {
  console.log(`REDEN v1 FINAL running on ${PORT}`);
});
