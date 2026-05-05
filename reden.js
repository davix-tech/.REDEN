#!/usr/bin/env node

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHOW_RATES = process.env.SHOW_RATES === 'true';

// ============================================
// DATABASE
// ============================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/', (req, res) => {
  res.json({
    status: "REDEN v1 LIVE",
    mode: "production",
    timestamp: new Date()
  });
});

// ============================================
// LEARNING ENGINE
// ============================================

async function getConversionRates() {
  const { rows } = await pool.query(`
    SELECT d.action,
           COUNT(*) as total,
           SUM(CASE WHEN o.converted THEN 1 ELSE 0 END) as conversions
    FROM outcomes o
    JOIN decisions d ON o.decision_id = d.id
    GROUP BY d.action
  `);

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

  return rates;
}

// ============================================
// SCORE
// ============================================

app.post('/score', async (req, res) => {
  try {
    const { session_id, cart_id, cart_value } = req.body;

    // ✅ STRICT VALIDATION
    if (!session_id || !cart_id || !cart_value || cart_value <= 0) {
      return res.status(400).json({ error: 'Missing or invalid fields' });
    }

    const rates = await getConversionRates();

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

    // EV map (for accurate reporting)
    const evMap = {
      NONE: evNone,
      INCENTIVE_LOW: evLow,
      INCENTIVE_MED: evMed,
      INCENTIVE_HIGH: evHigh
    };

    // ✅ FIXED EXPLORATION
    if (Math.random() < 0.1) {
      const actions = Object.keys(evMap);
      const discounts = {
        NONE: 0,
        INCENTIVE_LOW: 5,
        INCENTIVE_MED: 10,
        INCENTIVE_HIGH: 15
      };

      action = actions[Math.floor(Math.random() * actions.length)];
      discount = discounts[action];
    }

    const result = await pool.query(
      `INSERT INTO decisions (session_id, cart_id, action, discount, state)
       VALUES ($1, $2, $3, $4, 'EVALUATED')
       RETURNING id`,
      [session_id, cart_id, action, discount]
    );

    const response = {
      decision_id: result.rows[0].id,
      action,
      discount,
      expected_value: evMap[action] // ✅ accurate EV
    };

    // ✅ HIDE INTERNALS UNLESS ENABLED
    if (SHOW_RATES) {
      response.rates_used = rates;
    }

    res.json(response);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ACTION
// ============================================

app.post('/action', async (req, res) => {
  try {
    const { decision_id } = req.body;

    if (!decision_id) {
      return res.status(400).json({ error: 'Missing decision_id' });
    }

    const result = await pool.query(
      `UPDATE decisions
       SET state='ACTIONED'
       WHERE id=$1 AND state='EVALUATED'`,
      [decision_id]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'Invalid state' });
    }

    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// OUTCOME
// ============================================

app.post('/outcome', async (req, res) => {
  try {
    const { decision_id, converted = false, revenue = 0 } = req.body;

    if (!decision_id) {
      return res.status(400).json({ error: 'Missing decision_id' });
    }

    const check = await pool.query(
      `SELECT state FROM decisions WHERE id=$1`,
      [decision_id]
    );

    if (!check.rows.length || check.rows[0].state !== 'ACTIONED') {
      return res.status(409).json({ error: 'Decision not actioned' });
    }

    await pool.query(
      `INSERT INTO outcomes (decision_id, converted, final_revenue)
       VALUES ($1, $2, $3)`,
      [decision_id, converted, revenue]
    );

    res.json({ ok: true });

  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Outcome already recorded' });
    }
    return res.status(500).json({ error: err.message });
  }
});

// ============================================
// OUTCOMES
// ============================================

app.get('/outcomes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM outcomes ORDER BY created_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// METRICS
// ============================================

app.get('/metrics', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        COUNT(*) AS total,
        SUM(CASE WHEN converted THEN 1 ELSE 0 END) AS conversions,
        AVG(final_revenue) AS avg_revenue
      FROM outcomes
    `);

    const r = rows[0];

    res.json({
      total: Number(r.total),
      conversions: Number(r.conversions || 0),
      conversion_rate: r.total ? r.conversions / r.total : 0,
      avg_revenue: Number(r.avg_revenue || 0)
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ACTION METRICS
// ============================================

app.get('/metrics/actions', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT d.action,
             COUNT(*) as total,
             SUM(CASE WHEN o.converted THEN 1 ELSE 0 END) as conversions
      FROM outcomes o
      JOIN decisions d ON o.decision_id = d.id
      GROUP BY d.action
    `);

    const result = rows.map(r => ({
      action: r.action,
      total: Number(r.total),
      conversions: Number(r.conversions),
      conversion_rate: r.total ? r.conversions / r.total : 0
    }));

    res.json(result);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// START (DB CHECK)
// ============================================

pool.query('SELECT 1')
  .then(() => {
    app.listen(PORT, () => {
      console.log(`REDEN v1 (Production Final) running on ${PORT}`);
    });
  })
  .catch(err => {
    console.error('DB connection failed:', err.message);
    process.exit(1);
  });
