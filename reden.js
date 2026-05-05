// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Redis from "ioredis";
import { Queue, Worker } from "bullmq";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ─────────────────────────────
// CONFIG
// ─────────────────────────────
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || null;

// ─────────────────────────────
// REDIS (safe fallback)
// ─────────────────────────────
let redis = null;
let queue = null;

if (REDIS_URL) {
  redis = new Redis(REDIS_URL);
  queue = new Queue("outcomes", { connection: redis });

  new Worker(
    "outcomes",
    async job => {
      const { decision_id, converted, revenue } = job.data;

      const d = decisions.get(decision_id);
      if (!d) return;

      d.state = "ACTIONED";
      d.converted = converted;
      d.revenue = revenue;

      metrics.total++;
      if (converted) {
        metrics.conversions++;
        metrics.revenue += revenue;
      }
    },
    { connection: redis }
  );

  console.log("✔ Redis + Queue active");
} else {
  console.log("⚠ Running WITHOUT Redis (dev mode)");
}

// ─────────────────────────────
// IN-MEMORY STORE (replace with DB later)
// ─────────────────────────────
const decisions = new Map();

const metrics = {
  total: 0,
  conversions: 0,
  revenue: 0
};

// ─────────────────────────────
// HELPERS
// ─────────────────────────────
function pickAction(cart) {
  if (cart < 50) return "INCENTIVE_LOW";
  if (cart < 150) return "INCENTIVE_MED";
  return "INCENTIVE_HIGH";
}

function discountFor(action) {
  switch (action) {
    case "INCENTIVE_LOW": return 5;
    case "INCENTIVE_MED": return 10;
    case "INCENTIVE_HIGH": return 20;
    default: return 0;
  }
}

// ─────────────────────────────
// ROUTES
// ─────────────────────────────

// SCORE
app.post("/score", (req, res) => {
  const { session_id, cart_value } = req.body;

  if (!session_id || typeof cart_value !== "number") {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const action = pickAction(cart_value);
  const discount = discountFor(action);
  const explored = Math.random() < 0.2;

  const decision_id = Math.floor(Math.random() * 1e6);

  const expected_value = cart_value - discount;

  decisions.set(decision_id, {
    session_id,
    cart_value,
    action,
    discount,
    explored,
    state: "EVALUATED"
  });

  res.json({
    decision_id,
    action,
    discount,
    expected_value,
    explored
  });
});

// ACTION
app.post("/action", (req, res) => {
  const { decision_id } = req.body;

  const d = decisions.get(decision_id);
  if (!d || d.state !== "EVALUATED") {
    return res.status(409).json({ error: "Invalid state" });
  }

  d.state = "ACTIONED";

  res.json({ ok: true });
});

// OUTCOME
app.post("/outcome", async (req, res) => {
  const { decision_id, converted, revenue } = req.body;

  if (queue) {
    await queue.add("record", { decision_id, converted, revenue });
  } else {
    // fallback
    const d = decisions.get(decision_id);
    if (d) {
      metrics.total++;
      if (converted) {
        metrics.conversions++;
        metrics.revenue += revenue;
      }
    }
  }

  res.json({ ok: true });
});

// METRICS
app.get("/metrics", (req, res) => {
  const rate = metrics.total
    ? metrics.conversions / metrics.total
    : 0;

  res.json({
    total: metrics.total,
    conversions: metrics.conversions,
    conversion_rate: rate,
    avg_revenue: metrics.total
      ? metrics.revenue / metrics.total
      : 0
  });
});

// ACTION METRICS (simple mock)
app.get("/metrics/actions", (req, res) => {
  res.json([
    { action: "NONE", total: 10, conversion_rate: 0.1 },
    { action: "INCENTIVE_LOW", total: 20, conversion_rate: 0.25 },
    { action: "INCENTIVE_MED", total: 30, conversion_rate: 0.4 },
    { action: "INCENTIVE_HIGH", total: 25, conversion_rate: 0.55 }
  ]);
});

// ─────────────────────────────
// STATIC FRONTEND
// ─────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// ─────────────────────────────
// START
// ─────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
