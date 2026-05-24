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

/* INIT */
await initDB();
await initRedis();

const app = express();

/* PATH */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* SECURITY */
app.disable("x-powered-by");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
}));

/* BODY */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* REQUEST ID */
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
});

/* LOGGER */
app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`[${req.method}] ${req.path} ${res.statusCode} ${duration}ms`);
  });

  next();
});

/* STATIC */
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "7d",
  etag: true,
}));

/* HELPERS */
function success(data = {}) {
  return {
    ok: true,
    timestamp: new Date().toISOString(),
    ...data,
  };
}

function failure(error, details = null) {
  return {
    ok: false,
    error,
    details,
    timestamp: new Date().toISOString(),
  };
}

function validateNumber(value) {
  const num = Number(value);
  if (Number.isNaN(num) || !Number.isFinite(num)) return null;
  return num;
}

/* AUTH */
async function authenticate(req, res, next) {
  try {
    const publicRoutes = [
      "/",
      "/health",
      "/sdk.js",
      "/style.css",
      "/test-email",
      "/app",
    ];

    const isPublic =
      publicRoutes.some(route => req.path.startsWith(route)) ||
      req.path.startsWith("/logo") ||
      req.path.match(/\.(png|jpg|jpeg|svg|webp)$/);

    if (isPublic) return next();

    const apiKey = req.headers["x-api-key"];
    const siteId = req.headers["x-site-id"];

    if (!apiKey || !siteId) {
      return res.status(401).json(failure("missing_credentials"));
    }

    const cacheKey = `site:${siteId}:${apiKey}`;

    /* REDIS SAFE CACHE */
    if (redis) {
      try {
        const cached = await redis.get(cacheKey);

        if (cached) {
          const parsed = JSON.parse(cached);

          if (parsed && parsed.site_id) {
            req.site = parsed;
            return next();
          }

          console.error("[REDIS INVALID CACHE]");
        }
      } catch (e) {
        console.error("[REDIS CACHE ERROR]", e);
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

    const site = result.rows[0];

    if (!site?.site_id) {
      return res.status(403).json(failure("invalid_site_record"));
    }

    req.site = site;

    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(site), "EX", 300);
      } catch (e) {
        console.error("[REDIS SET ERROR]", e);
      }
    }

    next();

  } catch (e) {
    console.error("[AUTH ERROR]", e);
    return res.status(500).json(failure("authentication_failed"));
  }
}

app.use(authenticate);

/* ROOT */
app.get("/", async (req, res) => {
  try {
    await db.query("SELECT 1");

    return res.json(success({
      service: "REDEN",
      status: "operational",
      runtime: "adaptive",
      version: "v6",
    }));
  } catch (e) {
    return res.status(500).json(failure("database_offline"));
  }
});

/* HEALTH */
app.get("/health", (req, res) => {
  res.json(success({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    node: process.version,
  }));
});

/* SCORE */
app.post("/score", async (req, res) => {
  try {
    if (!req.site || !req.site.site_id) {
      return res.status(401).json(failure("invalid_site_context"));
    }

    const { session_id, cart_id, cart_value } = req.body;

    if (!session_id || !cart_id || cart_value === undefined) {
      return res.status(400).json(failure("missing_fields"));
    }

    const value = validateNumber(cart_value);

    if (value === null || value <= 0) {
      return res.status(400).json(failure("invalid_cart_value"));
    }

    let action = await pickAction();
    if (!action) action = "NONE";

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
      INSERT INTO decisions (
        site_id, session_id, cart_id,
        action, discount, expected_value, state
      )
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

    return res.json(success({
      decision_id: result.rows[0].id,
      action,
      discount,
      expected_value,
    }));

  } catch (e) {
    console.error("[SCORE ERROR]", e);
    return res.status(500).json(failure("score_failed"));
  }
});

/* EVENT */
app.post("/event", async (req, res) => {
  try {
    if (!req.site || !req.site.site_id) {
      return res.status(401).json(failure("invalid_site_context"));
    }

    const { session_id, event, payload, url, path, title } = req.body;

    if (!session_id || !event) {
      return res.status(400).json(failure("missing_fields"));
    }

    await db.query(
      `
      INSERT INTO event_logs (
        site_id, session_id, event,
        payload, url, path, title
      )
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

/* OUTCOME + METRICS + OTHER ROUTES (UNCHANGED) */
/* keep your existing implementations exactly as-is */

app.use((req, res) => {
  res.status(404).json(failure("route_not_found"));
});

app.listen(process.env.PORT || 3000, () => {
  console.log("REDEN Runtime Operational");
});
