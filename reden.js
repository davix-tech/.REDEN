import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import Redis from "ioredis";
import { Queue, Worker } from "bullmq";
import { db } from "./db.js";
import { pickAction, updateBandit } from "./bandit.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL);
const queue = new Queue("outcomes", { connection: redis });

// Worker (async learning)
new Worker(
  "outcomes",
  async job => {
    const { decision_id, converted, revenue, action } = job.data;

    await db.query(
      "INSERT INTO outcomes(decision_id, converted, revenue) VALUES($1,$2,$3)",
      [decision_id, converted, revenue]
    );

    await updateBandit(action, converted);
  },
  { connection: redis }
);

// Discount map
const discounts = {
  NONE: 0,
  INCENTIVE_LOW: 5,
  INCENTIVE_MED: 10,
  INCENTIVE_HIGH: 20
};

// ───────── SCORE
app.post("/score", async (req, res) => {
  try {
    const { session_id, cart_value } = req.body;

    if (!session_id || typeof cart_value !== "number") {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const action = await pickAction();
    const discount = discounts[action];
    const explored = Math.random() < 0.2;

    const ev = cart_value - discount;

    const result = await db.query(
      `INSERT INTO decisions(session_id, cart_value, action, discount, explored, state)
       VALUES($1,$2,$3,$4,$5,'EVALUATED')
       RETURNING id`,
      [session_id, cart_value, action, discount, explored]
    );

    res.json({
      decision_id: result.rows[0].id,
      action,
      discount,
      expected_value: ev,
      explored
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ───────── ACTION
app.post("/action", async (req, res) => {
  const { decision_id } = req.body;

  const r = await db.query(
    `UPDATE decisions SET state='ACTIONED'
     WHERE id=$1 AND state='EVALUATED'`,
    [decision_id]
  );

  if (r.rowCount === 0) {
    return res.status(409).json({ error: "Invalid state" });
  }

  res.json({ ok: true });
});

// ───────── OUTCOME
app.post("/outcome", async (req, res) => {
  const { decision_id, converted, revenue } = req.body;

  const d = await db.query(
    "SELECT action FROM decisions WHERE id=$1",
    [decision_id]
  );

  if (!d.rows.length) {
    return res.status(404).json({ error: "Decision not found" });
  }

  await queue.add("record", {
    decision_id,
    converted,
    revenue,
    action: d.rows[0].action
  });

  res.json({ ok: true });
});

// ───────── METRICS
app.get("/metrics", async (req, res) => {
  const r = await db.query(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN converted THEN 1 ELSE 0 END) as conversions,
      AVG(revenue) as avg_revenue
    FROM outcomes
  `);

  const total = Number(r.rows[0].total || 0);
  const conversions = Number(r.rows[0].conversions || 0);

  res.json({
    total,
    conversions,
    conversion_rate: total ? conversions / total : 0,
    avg_revenue: Number(r.rows[0].avg_revenue || 0)
  });
});

// ───────── ACTION METRICS
app.get("/metrics/actions", async (req, res) => {
  const r = await db.query(`
    SELECT d.action,
           COUNT(o.*) as total,
           AVG(CASE WHEN o.converted THEN 1 ELSE 0 END) as conversion_rate
    FROM decisions d
    LEFT JOIN outcomes o ON d.id = o.decision_id
    GROUP BY d.action
  `);

  res.json(r.rows);
});

// ───────── STATIC
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "public/index.html"))
);

app.listen(process.env.PORT, () =>
  console.log("REDEN production server running")
);
