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
  sendRecoveryEmail,
} from "./email.js";

dotenv.config();

/* ─────────────────────────────────────────────
   INIT
───────────────────────────────────────────── */
await initDB();
await initRedis();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

/* ─────────────────────────────────────────────
   BODY PARSING
───────────────────────────────────────────── */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* ─────────────────────────────────────────────
   REQUEST CONTEXT
───────────────────────────────────────────── */
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
});

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

function validateNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ─────────────────────────────────────────────
   AUTH MIDDLEWARE
───────────────────────────────────────────── */
async function authenticate(req, res, next) {
  try {
    const publicRoutes = ["/", "/health", "/sdk.js", "/app", "/test-email"];

    const isPublic =
      publicRoutes.some((r) => req.path.startsWith(r)) ||
      /\.(png|jpg|jpeg|svg|webp|css|js)$/i.test(req.path);

    if (isPublic) return next();

    const apiKey = req.headers["x-api-key"];
    const siteId = req.headers["x-site-id"];

    if (!apiKey || !siteId) {
      return res.status(401).json(failure("missing_credentials"));
    }

    const cacheKey = `site:${siteId}:${apiKey}`;

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed?.site_id) {
            req.site = parsed;
            return next();
          }
        }
      } catch (e) {
        console.error("[REDIS READ ERROR]", e);
      }
    }

    const result = await db.query(
      `
      SELECT id, site_id, name, active, created_at
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
      try {
        await redis.set(cacheKey, JSON.stringify(req.site), "EX", 300);
      } catch (e) {
        console.error("[REDIS WRITE ERROR]", e);
      }
    }

    next();
  } catch (e) {
    console.error("[AUTH ERROR]", e);
    return res.status(500).json(failure("authentication_failed"));
  }
}

app.use(authenticate);

/* ─────────────────────────────────────────────
   HARD SAFETY CHECK (CRITICAL FIX)
───────────────────────────────────────────── */
app.use((req, res, next) => {
  if (!req.site || !req.site.site_id) {
    return res.status(401).json(failure("invalid_site_context"));
  }
  next();
});

/* ─────────────────────────────────────────────
   ROUTES
───────────────────────────────────────────── */

app.get("/", async (req, res) => {
  await db.query("SELECT 1");

  return res.json(
    success({
      service: "REDEN",
      status: "operational",
      database: "connected",
      redis: redis ? "enabled" : "disabled",
      version: "v6",
    })
  );
});

app.get("/health", (req, res) => {
  return res.json(
    success({
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      node: process.version,
    })
  );
});

app.get("/app", (req, res) => {
  res.send(`
    <html>
      <body style="background:#05070b;color:white;font-family:Arial;padding:40px;">
        <h1>REDEN Runtime</h1>
        <p>Operational</p>
      </body>
    </html>
  `);
});

app.get("/sdk.js", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sdk.js"));
});

app.get("/test-email", async (req, res) => {
  try {
    const result = await sendEmail({
      to: "redenbydcore@gmail.com",
      subject: "REDEN Runtime Online",
      html: `<h1>OK</h1>`,
    });

    return res.json(success(result));
  } catch (e) {
    console.error(e);
    return res.status(500).json(failure("test_email_failed"));
  }
});

/* ─────────────────────────────────────────────
   EVENT
───────────────────────────────────────────── */
app.post("/event", async (req, res) => {
  try {
    const { session_id, event, payload, url, path, title } = req.body;

    if (!session_id || !event) {
      return res.status(400).json(failure("missing_fields"));
    }

    await db.query(
      `
      INSERT INTO event_logs
      (site_id, session_id, event, payload, url, path, title)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      `,
      [
        req.site.site_id,
        session_id,
        event,
        payload || {},
        url || null,
        path || null,
        title || null,
      ]
    );

    return res.json(success());
  } catch (e) {
    console.error("[EVENT ERROR]", e);
    return res.status(500).json(failure("event_failed"));
  }
});

/* ─────────────────────────────────────────────
   SCORE ENGINE
───────────────────────────────────────────── */
app.post("/score", async (req, res) => {
  try {
    const { session_id, cart_id, cart_value } = req.body;

    if (!session_id || !cart_id || cart_value === undefined) {
      return res.status(400).json(failure("missing_fields"));
    }

    const value = validateNumber(cart_value);
    if (value === null || value <= 0) {
      return res.status(400).json(failure("invalid_cart_value"));
    }

    const action = (await pickAction()) || "NONE";

    const map = { NONE: 0, INCENTIVE_LOW: 5, INCENTIVE_MED: 10, INCENTIVE_HIGH: 20 };
    const discount = map[action] || 0;

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
        expected_value,
      ]
    );

    return res.json(
      success({
        decision_id: result.rows[0].id,
        action,
        discount,
        expected_value,
      })
    );
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
    console.error(e);
    return res.status(500).json(failure("action_failed"));
  }
});

/* ─────────────────────────────────────────────
   OUTCOME
───────────────────────────────────────────── */
app.post("/outcome", async (req, res) => {
  try {
    const { decision_id, converted, revenue } = req.body;

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
      [Boolean(converted), Number(revenue || 0), decision_id, req.site.site_id]
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

    const row = result.rows[0];

    return res.json(
      success({
        total: Number(row.total),
        conversions: Number(row.conversions),
        conversion_rate:
          Number(row.total) > 0
            ? Number(row.conversions) / Number(row.total)
            : 0,
        avg_revenue: Number(row.avg_revenue),
        total_revenue: Number(row.total_revenue),
      })
    );
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
  console.log(`REDEN running on ${PORT}`);
});
