import express from "express";
import dotenv from "dotenv";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";

import { db, initDB } from "./db.js";
import { pickAction, updateBandit } from "./bandit.js";
import { initRedis, redis } from "./redis.js";

import {
  sendEmail,
  sendDailyReport,
  sendRecoveryEmail
} from "./email.js";

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ─────────────────────────────────────────────
   CORE INIT
───────────────────────────────────────────── */
await initDB();
await initRedis();

/* ─────────────────────────────────────────────
   SECURITY
───────────────────────────────────────────── */
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use(compression());

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* ─────────────────────────────────────────────
   REQUEST ID
───────────────────────────────────────────── */
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
});

/* ─────────────────────────────────────────────
   LOGGING
───────────────────────────────────────────── */
app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    console.log(
      `[${req.method}] ${req.path} ${res.statusCode} ${Date.now() - start}ms`
    );
  });

  next();
});

/* ─────────────────────────────────────────────
   STATIC
───────────────────────────────────────────── */
app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "7d",
    etag: true,
  })
);

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */
const success = (data = {}) => ({
  ok: true,
  timestamp: new Date().toISOString(),
  ...data,
});

const failure = (error, details = null) => ({
  ok: false,
  error,
  details,
  timestamp: new Date().toISOString(),
});

const validateNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ─────────────────────────────────────────────
   AUTH (CRITICAL FIXED CACHE SAFETY)
───────────────────────────────────────────── */
async function authenticate(req, res, next) {
  const publicRoutes = ["/", "/health", "/sdk.js", "/app"];

  const isPublic =
    publicRoutes.some(r => req.path.startsWith(r)) ||
    req.path.match(/\.(png|jpg|jpeg|svg|webp|css|js)$/);

  if (isPublic) return next();

  const apiKey = req.headers["x-api-key"];
  const siteId = req.headers["x-site-id"];

  if (!apiKey || !siteId) {
    return res.status(401).json(failure("missing_credentials"));
  }

  try {
    const cacheKey = `site:${siteId}:${apiKey}`;

    if (redis) {
      const cached = await redis.get(cacheKey);

      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed?.site_id) {
          req.site = parsed;
          return next();
        }
      }
    }

    const result = await db.query(
      `
      SELECT id, site_id, name, active
      FROM sites
      WHERE api_key = $1 AND site_id = $2 AND active = true
      LIMIT 1
      `,
      [apiKey, siteId]
    );

    if (result.rowCount === 0) {
      return res.status(403).json(failure("invalid_credentials"));
    }

    req.site = result.rows[0];

    if (redis) {
      await redis.set(
        cacheKey,
        JSON.stringify(req.site),
        "EX",
        300
      );
    }

    next();
  } catch (e) {
    console.error("[AUTH ERROR]", e);
    return res.status(500).json(failure("authentication_failed"));
  }
}

app.use(authenticate);

/* ─────────────────────────────────────────────
   HARD GUARANTEE: SITE CONTEXT
───────────────────────────────────────────── */
app.use((req, res, next) => {
  if (!req.site?.site_id) {
    return res.status(401).json(failure("invalid_site_context"));
  }
  next();
});

/* ─────────────────────────────────────────────
   ROUTES
───────────────────────────────────────────── */

app.get("/", async (req, res) => {
  await db.query("SELECT 1");

  return res.json(success({
    service: "REDEN",
    status: "operational",
    runtime: "adaptive"
  }));
});

app.get("/health", (req, res) => {
  return res.json(success({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    node: process.version,
  }));
});

app.get("/app", (req, res) => {
  res.send(`<h1>REDEN Runtime Online</h1>`);
});

app.get("/sdk.js", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sdk.js"));
});

/* ─────────────────────────────────────────────
   EVENT
───────────────────────────────────────────── */
app.post("/event", async (req, res) => {
  try {
    const { session_id, event, payload, url, path } = req.body;

    if (!session_id || !event) {
      return res.status(400).json(failure("missing_fields"));
    }

    await db.query(
      `
      INSERT INTO event_logs
      (site_id, session_id, event, payload, url, path)
      VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [
        req.site.site_id,
        session_id,
        event,
        JSON.stringify(payload || {}),
        url || null,
        path || null
      ]
    );

    return res.json(success());
  } catch (e) {
    console.error("[EVENT ERROR]", e);
    return res.status(500).json(failure("event_failed"));
  }
});

/* ─────────────────────────────────────────────
   SCORE
───────────────────────────────────────────── */
app.post("/score", async (req, res) => {
  try {
    const { session_id, cart_id, cart_value } = req.body;

    if (!session_id || !cart_id) {
      return res.status(400).json(failure("missing_fields"));
    }

    const value = validateNumber(cart_value);
    if (value === null || value <= 0) {
      return res.status(400).json(failure("invalid_cart_value"));
    }

    const action = (await pickAction()) || "NONE";

    const discounts = {
      NONE: 0,
      INCENTIVE_LOW: 5,
      INCENTIVE_MED: 10,
      INCENTIVE_HIGH: 20,
    };

    const discount = discounts[action] || 0;
    const expected_value = Math.max(value - discount, 0);

    const result = await db.query(
      `
      INSERT INTO decisions
      (site_id, session_id, cart_id, action, discount, expected_value, state)
      VALUES ($1,$2,$3,$4,$5,$6,'SCORED')
      RETURNING id
      `,
      [
        req.site.site_id,
        session_id,
        cart_id,
        action,
        discount,
        expected_value
      ]
    );

    return res.json(success({
      decision_id: result.rows[0].id,
      action,
      discount,
      expected_value
    }));
  } catch (e) {
    console.error("[SCORE ERROR]", e);
    return res.status(500).json(failure("score_failed"));
  }
});

/* ─────────────────────────────────────────────
   ACTION
───────────────────────────────────────────── */
app.post("/action", async (req, res) => {
  try {
    const { decision_id } = req.body;

    if (!decision_id) {
      return res.status(400).json(failure("missing_decision_id"));
    }

    const result = await db.query(
      `
      UPDATE decisions
      SET state='ACTIONED'
      WHERE id=$1 AND site_id=$2
      RETURNING id
      `,
      [decision_id, req.site.site_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json(failure("decision_not_found"));
    }

    return res.json(success({ actioned: true }));
  } catch (e) {
    console.error("[ACTION ERROR]", e);
    return res.status(500).json(failure("action_failed"));
  }
});

/* ─────────────────────────────────────────────
   OUTCOME
───────────────────────────────────────────── */
app.post("/outcome", async (req, res) => {
  try {
    const { decision_id, converted, revenue } = req.body;

    if (!decision_id) {
      return res.status(400).json(failure("missing_decision_id"));
    }

    const existing = await db.query(
      `SELECT action FROM decisions WHERE id=$1 AND site_id=$2`,
      [decision_id, req.site.site_id]
    );

    if (existing.rowCount === 0) {
      return res.status(404).json(failure("decision_not_found"));
    }

    await db.query(
      `
      UPDATE decisions
      SET state='COMPLETED', converted=$1, revenue=$2, completed_at=NOW()
      WHERE id=$3 AND site_id=$4
      `,
      [
        Boolean(converted),
        Number(revenue || 0),
        decision_id,
        req.site.site_id
      ]
    );

    try {
      await updateBandit(existing.rows[0].action, Boolean(converted));
    } catch (e) {
      console.error("[BANDIT ERROR]", e);
    }

    return res.json(success({ updated: true }));
  } catch (e) {
    console.error("[OUTCOME ERROR]", e);
    return res.status(500).json(failure("outcome_failed"));
  }
});

/* ─────────────────────────────────────────────
   METRICS
───────────────────────────────────────────── */
app.get("/metrics", async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE converted=true) AS conversions,
        COALESCE(AVG(revenue),0) AS avg_revenue,
        COALESCE(SUM(revenue),0) AS total_revenue
      FROM decisions
      WHERE site_id=$1 AND state='COMPLETED'
      `,
      [req.site.site_id]
    );

    const r = result.rows[0];

    return res.json(success({
      total: Number(r.total),
      conversions: Number(r.conversions),
      conversion_rate: r.total > 0 ? r.conversions / r.total : 0,
      avg_revenue: Number(r.avg_revenue),
      total_revenue: Number(r.total_revenue),
    }));
  } catch (e) {
    console.error("[METRICS ERROR]", e);
    return res.status(500).json(failure("metrics_failed"));
  }
});

/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`REDEN running on port ${PORT}`);
});
