import express from "express";
import dotenv from "dotenv";
import { db } from "./db.js";
import { pickAction, updateBandit } from "./bandit.js";
import { initRedis, redis } from "./redis.js";

dotenv.config();

const app = express();

// ─── MIDDLEWARE ───
app.use(express.json());
app.use(express.static("public"));

// ─── INIT REDIS (SAFE) ───
initRedis();

// ─── HEALTH CHECK ───
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "REDEN",
    redis: redis ? "enabled" : "disabled"
  });
});

// ─── SCORE ───
app.post("/score", async (req, res) => {
  try {
    const { session_id, cart_id, cart_value } = req.body;

    if (!session_id || !cart_id || cart_value == null) {
      return res.status(400).json({
        error: "missing_fields"
      });
    }

    const action = await pickAction();

    let discount = 0;

    if (action === "INCENTIVE_LOW") discount = 5;
    if (action === "INCENTIVE_MED") discount = 10;
    if (action === "INCENTIVE_HIGH") discount = 20;

    const expected_value = Number(cart_value) - discount;

    const result = await db.query(
      `
      INSERT INTO decisions
      (
        session_id,
        cart_id,
        action,
        discount,
        expected_value,
        state
      )
      VALUES ($1,$2,$3,$4,$5,'SCORED')
      RETURNING id
      `,
      [
        session_id,
        cart_id,
        action,
        discount,
        expected_value
      ]
    );

    const decision_id = result.rows[0].id;

    // Optional Redis cache
    if (redis) {
      try {
        await redis.set(
          `decision:${decision_id}`,
          JSON.stringify({
            action,
            discount,
            expected_value
          }),
          "EX",
          300
        );
      } catch (e) {
        console.log("[REDIS] cache skipped");
      }
    }

    res.json({
      decision_id,
      action,
      discount,
      expected_value,
      explored: Math.random() < 0.1
    });

  } catch (e) {
    console.error("SCORE ERROR:", e.message);

    res.status(500).json({
      error: "score_failed"
    });
  }
});

// ─── ACTION ───
app.post("/action", async (req, res) => {
  try {
    const { decision_id } = req.body;

    if (!decision_id) {
      return res.status(400).json({
        error: "missing_decision_id"
      });
    }

    const result = await db.query(
      `
      UPDATE decisions
      SET state='ACTIONED'
      WHERE id=$1
      AND state='SCORED'
      `,
      [decision_id]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        error: "invalid_state"
      });
    }

    res.json({
      ok: true
    });

  } catch (e) {
    console.error("ACTION ERROR:", e.message);

    res.status(500).json({
      error: "action_failed"
    });
  }
});

// ─── OUTCOME ───
app.post("/outcome", async (req, res) => {
  try {
    const {
      decision_id,
      converted,
      revenue
    } = req.body;

    if (!decision_id) {
      return res.status(400).json({
        error: "missing_decision_id"
      });
    }

    const d = await db.query(
      `
      SELECT action
      FROM decisions
      WHERE id=$1
      `,
      [decision_id]
    );

    if (d.rowCount === 0) {
      return res.status(404).json({
        error: "decision_not_found"
      });
    }

    const action = d.rows[0].action;

    await db.query(
      `
      UPDATE decisions
      SET
        state='COMPLETED',
        converted=$1,
        revenue=$2
      WHERE id=$3
      `,
      [
        converted,
        revenue,
        decision_id
      ]
    );

    await updateBandit(action, converted);

    res.json({
      ok: true
    });

  } catch (e) {
    console.error("OUTCOME ERROR:", e.message);

    res.status(500).json({
      error: "outcome_failed"
    });
  }
});

// ─── METRICS ───
app.get("/metrics", async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) as total,
        SUM(
          CASE
            WHEN converted THEN 1
            ELSE 0
          END
        ) as conversions,
        AVG(revenue) as avg_revenue
      FROM decisions
      WHERE state='COMPLETED'
    `);

    const total = Number(rows[0].total || 0);
    const conversions = Number(rows[0].conversions || 0);

    res.json({
      total,
      conversions,
      conversion_rate:
        total > 0
          ? conversions / total
          : 0,
      avg_revenue:
        Number(rows[0].avg_revenue || 0)
    });

  } catch (e) {
    console.error("METRICS ERROR:", e.message);

    res.status(500).json({
      error: "metrics_failed"
    });
  }
});

// ─── ACTION METRICS ───
app.get("/metrics/actions", async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        action,
        COUNT(*) as total,
        AVG(
          CASE
            WHEN converted THEN 1
            ELSE 0
          END
        ) as conversion_rate
      FROM decisions
      WHERE state='COMPLETED'
      GROUP BY action
    `);

    res.json(rows);

  } catch (e) {
    console.error("ACTION METRICS ERROR:", e.message);

    res.status(500).json({
      error: "metrics_actions_failed"
    });
  }
});

// ─── FALLBACK 404 ───
app.use((req, res) => {
  res.status(404).json({
    error: "route_not_found"
  });
});

// ─── START SERVER ───
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`REDEN running on port ${PORT}`);
});
