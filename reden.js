import express from "express";
import dotenv from "dotenv";
import path from "path";
import crypto from "crypto";
import timeout from "connect-timeout";
import { fileURLToPath } from "url";
import cron from "node-cron";

import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";

import { db, initDB } from "./db.js";
import { pickAction, updateBandit } from "./bandit.js";
import { initRedis, redis } from "./redis.js";
import { sendEmail, sendDailyReport, sendRecoveryEmail } from "./email.js";

dotenv.config();

/* ─────────────────────────────────────────────
   ENV VALIDATION
───────────────────────────────────────────── */
const requiredEnv = ["DATABASE_URL", "ADMIN_SECRET"];
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`Missing mandatory environment variable: ${key}`);
}

/* ─────────────────────────────────────────────
   INITIALIZATION
───────────────────────────────────────────── */
await initDB();
await initRedis();

const app = express();
app.set("trust proxy", true); // Production edge/CDN config safety

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ─────────────────────────────────────────────
   SECURITY AND GLOBAL CORS LAYER
───────────────────────────────────────────── */
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

app.use((req, res, next) => {
  const publicOrigins = ["/event", "/score", "/action", "/outcome", "/sdk.js"];
  const isPublicRoute = publicOrigins.some(route => req.path.startsWith(route));

  if (isPublicRoute) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key, X-Site-Id");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "null"); 
  }

  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ABUSE PROTECTION RATE LIMITERS
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000, 
  keyGenerator: (req) => req.headers["x-site-id"] || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "tenant_rate_limit_exceeded" }
});

app.use("/event", telemetryLimiter);
app.use(generalLimiter);

/* ─────────────────────────────────────────────
   BODY PARSING & TIMEOUT MIDDLEWARE
───────────────────────────────────────────── */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(timeout("15s"));

const haltOnTimeout = (req, res, next) => {
  if (req.timedout) return;
  next();
};
app.use(haltOnTimeout);

/* ─────────────────────────────────────────────
   UTILITIES & VALIDATORS
───────────────────────────────────────────── */
const success = (data = {}) => ({ ok: true, timestamp: new Date().toISOString(), ...data });
const failure = (error, details = null) => ({ ok: false, error, details, timestamp: new Date().toISOString() });

function validateNumber(value) {
  const num = Number(value);
  return Number.isNaN(num) || !Number.isFinite(num) ? null : num;
}

const VALID_EVENTS = new Set([
  "PAGE_VIEW",
  "ADD_TO_CART",
  "CHECKOUT_STARTED",
  "PURCHASE",
  "SESSION_START",
  "SESSION_END"
]);

const PUBLIC_ROUTES = ["/", "/health", "/sdk.js", "/api/v1/onboard"];
const isPublic = (p) => PUBLIC_ROUTES.includes(p) || /\.(png|jpg|jpeg|svg|css|js)$/i.test(p);

/* ─────────────────────────────────────────────
   AUTHENTICATION LAYER WITH CRASH PROTECTION
───────────────────────────────────────────── */
async function authenticate(req, res, next) {
  try {
    if (isPublic(req.path)) return next();

    const apiKey = req.headers["x-api-key"];
    const siteId = req.headers["x-site-id"];

    if (!apiKey || !siteId) return res.status(401).json(failure("missing_credentials"));

    const cacheKey = `site:${siteId}:${apiKey}`;

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          req.site = JSON.parse(cached);
          return next();
        }
      } catch (e) {
        console.error("[REDIS READ ERROR]", e);
      }
    }

    const result = await db.query(
      `SELECT id, site_id, name, active FROM sites WHERE api_key = $1 AND site_id = $2 AND active = true LIMIT 1`,
      [apiKey, siteId]
    );

    if (!result.rowCount) return res.status(403).json(failure("invalid_credentials"));

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
    res.status(500).json(failure("auth_failed"));
  }
}

app.use(authenticate);

// Catch-all runtime site safety check
app.use((req, res, next) => {
  if (isPublic(req.path)) return next();
  if (!req.site || !req.site.site_id) return res.status(401).json(failure("invalid_site_context"));
  next();
});
app.use(haltOnTimeout);

/* ─────────────────────────────────────────────
   CORE ROUTING
───────────────────────────────────────────── */
app.get("/", async (req, res) => {
  await db.query("SELECT 1");
  res.json(success({ service: "REDEN", status: "operational", redis: !!redis }));
});

app.get("/health", async (req, res) => {
  let dbStatus = "healthy";
  try {
    await db.query("SELECT 1");
  } catch {
    dbStatus = "unhealthy";
  }

  const payload = success({ uptime: process.uptime(), memory: process.memoryUsage(), database: dbStatus });
  return dbStatus === "healthy" ? res.json(payload) : res.status(503).json(payload);
});

/* ─────────────────────────────────────────────
   SECURE MERCHANT ONBOARDING
───────────────────────────────────────────── */
app.post("/api/v1/onboard", async (req, res) => {
  try {
    const adminSecret = req.headers["x-admin-secret"];
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json(failure("unauthorized_onboarding_access"));
    }

    const { name, owner_email } = req.body;
    if (!name || !owner_email) return res.status(400).json(failure("missing_fields"));

    const siteId = `site_${crypto.randomBytes(8).toString("hex")}`;
    const apiKey = `rd_${crypto.randomBytes(24).toString("hex")}`;

    await db.query(
      `INSERT INTO sites(site_id, api_key, name, owner_email, active) VALUES ($1,$2,$3,$4,true)`,
      [siteId, apiKey, name, owner_email]
    );

    res.status(201).json(success({ siteId, apiKey }));
  } catch (e) {
    console.error(e);
    res.status(500).json(failure("onboard_failed"));
  }
});

/* ─────────────────────────────────────────────
   TELEMETRY AND EVENTS (TRUE IDEMPOTENCY)
───────────────────────────────────────────── */
app.post("/event", async (req, res) => {
  try {
    const { session_id, event, payload, event_id } = req.body;

    if (!session_id || !event) return res.status(400).json(failure("missing_fields"));
    if (!VALID_EVENTS.has(event)) return res.status(400).json(failure("invalid_event"));
    if (!event_id) return res.status(400).json(failure("missing_event_id"));

    let safePayload, safeCart;
    try {
      safePayload = JSON.stringify(payload || {});
      safeCart = JSON.stringify(payload?.cart || {});
    } catch {
      return res.status(400).json(failure("invalid_payload_serialization"));
    }

    if (safeCart.length > 20000 || safePayload.length > 50000) {
      return res.status(413).json(failure("payload_bounds_exceeded"));
    }

    const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;

    try {
      await db.query(
        `INSERT INTO event_logs(event_id, site_id, session_id, event, payload, ip_address, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [event_id, req.site.site_id, session_id, event, safePayload, clientIp, req.headers["user-agent"]]
      );
    } catch (e) {
      if (e.code === "23505") return res.json(success({ duplicate: true, event_tracked: event_id }));
      throw e;
    }

    if (event === "CHECKOUT_STARTED" && payload?.email) {
      const exists = await db.query(
        `SELECT 1 FROM recovery_queue WHERE session_id=$1 AND customer_email=$2 LIMIT 1`,
        [session_id, payload.email]
      );

      if (!exists.rowCount) {
        await db.query(
          `INSERT INTO recovery_queue(site_id, session_id, customer_email, cart_data, incentive)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [req.site.site_id, session_id, payload.email, safeCart, "10% OFF"]
        );
      }
    }

    res.json(success({ event_id }));
  } catch (e) {
    console.error(e);
    res.status(500).json(failure("event_failed"));
  }
});

/* ─────────────────────────────────────────────
   OPTIMIZATION SCORE ENGINE
───────────────────────────────────────────── */
app.post("/score", async (req, res) => {
  try {
    const { session_id, cart_id, cart_value } = req.body;
    const value = validateNumber(cart_value);

    if (!session_id || !cart_id || value === null || value <= 0) {
      return res.status(400).json(failure("invalid_input"));
    }

    const action = (await pickAction()) || "NONE";
    const discountMap = { NONE: 0, LOW: 5, MED: 10, HIGH: 20 };
    const discount = discountMap[action] || 0;

    const result = await db.query(
      `INSERT INTO decisions(site_id, session_id, cart_id, action, discount, expected_value, state)
       VALUES ($1,$2,$3,$4,$5,$6,'SCORED') RETURNING id`,
      [req.site.site_id, session_id, cart_id, action, discount, value - discount]
    );

    res.json(success({ decision_id: result.rows[0].id, action, discount }));
  } catch (e) {
    console.error(e);
    res.status(500).json(failure("score_failed"));
  }
});

app.post("/action", async (req, res) => {
  try {
    const { decision_id } = req.body;
    if (!decision_id) return res.status(400).json(failure("missing_decision_id"));

    const r = await db.query(
      `UPDATE decisions SET state='ACTIONED' WHERE id=$1 AND site_id=$2`,
      [decision_id, req.site.site_id]
    );

    if (!r.rowCount) return res.status(404).json(failure("not_found"));
    res.json(success({ actioned: true }));
  } catch (e) {
    res.status(500).json(failure("action_failed"));
  }
});

app.post("/outcome", async (req, res) => {
  try {
    const { decision_id, converted, revenue } = req.body;
    if (!decision_id) return res.status(400).json(failure("missing_decision_id"));

    const revenueValue = validateNumber(revenue);
    if (revenue !== undefined && revenueValue === null) {
      return res.status(400).json(failure("invalid_revenue"));
    }

    const existing = await db.query(
      `SELECT action, state FROM decisions WHERE id=$1 AND site_id=$2`,
      [decision_id, req.site.site_id]
    );

    if (!existing.rowCount) return res.status(404).json(failure("not_found"));
    if (existing.rows[0].state === "COMPLETED") return res.status(409).json(failure("already_done"));

    await db.query(
      `UPDATE decisions SET state='COMPLETED', converted=$1, revenue=$2, completed_at=NOW() WHERE id=$3 AND site_id=$4`,
      [!!converted, revenueValue || 0, decision_id, req.site.site_id]
    );

    await updateBandit(existing.rows[0].action, !!converted);
    res.json(success({ updated: true }));
  } catch (e) {
    res.status(500).json(failure("outcome_failed"));
  }
});

/* ─────────────────────────────────────────────
   METRICS
───────────────────────────────────────────── */
app.get("/metrics", async (req, res) => {
  try {
    const r = await db.query(
      `SELECT COUNT(*) total, COUNT(*) FILTER (WHERE converted=true) conversions, COALESCE(SUM(revenue),0) revenue
       FROM decisions WHERE site_id=$1 AND state='COMPLETED'`,
      [req.site.site_id]
    );
    const row = r.rows[0];
    res.json(success({ total: Number(row.total), conversions: Number(row.conversions), revenue: Number(row.revenue) }));
  } catch (e) {
    res.status(500).json(failure("metrics_failed"));
  }
});

/* ─────────────────────────────────────────────
   BACKGROUND AUTOMATION CRON AGENTS
───────────────────────────────────────────── */

// 1. RECOVERY SYSTEM (Atomic claim-first processing loop)
cron.schedule("*/15 * * * *", async () => {
  if (!db || typeof db.connect !== "function") return;
  
  const client = await db.connect();
  let claimed = [];

  try {
    await client.query("BEGIN");
    const batch = await client.query(`
      UPDATE recovery_queue
      SET status = 'PROCESSING'
      WHERE id IN (
        SELECT id FROM recovery_queue
        WHERE status = 'PENDING' AND created_at >= NOW() - INTERVAL '7 days'
        FOR UPDATE SKIP LOCKED LIMIT 20
      ) RETURNING *
    `);
    claimed = batch.rows;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[CRON BATCH CLAIM ERROR]", e);
  } finally {
    client.release();
  }

  // Network I/O runs completely outside transaction scope
  for (const item of claimed) {
    try {
      const conversionCheck = await db.query(
        `SELECT id FROM decisions WHERE session_id = $1 AND converted = true LIMIT 1`,
        [item.session_id]
      );

      if (conversionCheck.rowCount > 0) {
        await db.query(`UPDATE recovery_queue SET status='COMPLETED' WHERE id=$1`, [item.id]);
        continue;
      }

      await sendRecoveryEmail({ to: item.customer_email, incentive: item.incentive, cart: item.cart_data });
      await db.query(`UPDATE recovery_queue SET status='SENT', processed_at=NOW() WHERE id=$1`, [item.id]);
      await db.query(
        `INSERT INTO email_logs (site_id, email_type, recipient, subject, status) VALUES ($1, 'RECOVERY', $2, 'Complete your checkout', 'SENT')`,
        [item.site_id, item.customer_email]
      );
    } catch (e) {
      console.error(`[RECOVERY EMAIL SEND ERROR] Target: ${item.customer_email}`, e);
      await db.query(`UPDATE recovery_queue SET status='FAILED', processed_at=NOW() WHERE id=$1`, [item.id]);
    }
  }
});

// 2. DAILY MERCHANT PERFORMANCE DISPATCH
cron.schedule("0 8 * * *", async () => {
  try {
    const merchants = await db.query(`SELECT * FROM sites WHERE active=true`);

    for (const m of merchants.rows) {
      const stats = await db.query(
        `SELECT COUNT(*) total, COUNT(*) FILTER (WHERE converted=true) conversions, COALESCE(SUM(revenue),0) revenue
         FROM decisions WHERE site_id=$1 AND state='COMPLETED' AND completed_at >= NOW() - INTERVAL '1 day'`,
        [m.site_id]
      );

      const metrics = stats.rows[0];
      await sendDailyReport({
        to: m.owner_email,
        merchantName: m.name,
        metrics: { total: Number(metrics.total), conversions: Number(metrics.conversions), revenue: Number(metrics.revenue) },
      });

      await db.query(
        `INSERT INTO email_logs (site_id, email_type, recipient, subject, status) VALUES ($1, 'DAILY_REPORT', $2, 'Daily REDEN Performance Report', 'SENT')`,
        [m.site_id, m.owner_email]
      );
    }
  } catch (e) {
    console.error("[DAILY REPORT CRON FAILURE]", e);
  }
}, { timezone: "UTC" });

/* ─────────────────────────────────────────────
   ERROR ROUTING & GRACEFUL MULTI-SIGNAL SHUTDOWN
───────────────────────────────────────────── */
app.use((req, res) => res.status(404).json(failure("not_found")));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json(failure("internal_error"));
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`REDEN fully hardened instance up on port ${PORT}`));

const shutdownHandler = async (signal) => {
  console.log(`\n[${signal}] processing teardown signal. Draining server threads.`);
  server.close(async () => {
    try {
      if (redis) await redis.quit();
      process.exit(0);
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  });
};

process.on("SIGINT", () => shutdownHandler("SIGINT"));
process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
