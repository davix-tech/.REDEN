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

import { db, initDB } from "../infrastructure/db.js";
import { pickAction, updateBandit } from "../optimization/banditEngine.js";
import { initRedis, redis } from "../infrastructure/redis.js";
import {
  sendDailyReport,
  sendRecoveryEmail
} from "../notification/emailEngine.js";

// Paystack routes
import paystackRoutes from "./routes/paystack.js";

dotenv.config();

/* ─────────────────────────────────────────────
   ENV VALIDATION
───────────────────────────────────────────── */

const requiredEnv = [
  "DATABASE_URL",
  "ADMIN_SECRET",
  "PAYSTACK_SECRET_KEY"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing mandatory environment variable: ${key}`);
  }
}

/* ─────────────────────────────────────────────
   INITIALIZATION & INDEX OPTIMIZATION
───────────────────────────────────────────── */

await initDB();

try {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id SERIAL PRIMARY KEY,
      site_id VARCHAR(50) UNIQUE NOT NULL,
      api_key VARCHAR(100) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      owner_email VARCHAR(255),
      active BOOLEAN DEFAULT true,
      plan VARCHAR(50) DEFAULT 'basic',
      subscription_status VARCHAR(50) DEFAULT 'inactive',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_email_logs_lookup
    ON email_logs(email_type, recipient, subject);
  `);

  /*
   * Helps REDEN quickly find an existing installation
   * when a merchant reconnects the same storefront.
   */
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_sites_owner_name
    ON sites(owner_email, name);
  `);

  console.log(
    "[DB INIT] Core architecture tables & optimization indexes verified."
  );
} catch (err) {
  console.error(
    "[DB INIT ERROR] Failed to auto-create schema infrastructures:",
    err
  );
}

await initRedis();

const app = express();

app.set("trust proxy", true);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ─────────────────────────────────────────────
   SECURITY AND GLOBAL CORS LAYER
───────────────────────────────────────────── */

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: {
      policy: "cross-origin"
    }
  })
);

app.use(compression());

app.use((req, res, next) => {
  const publicOrigins = [
    "/event",
    "/score",
    "/action",
    "/outcome",
    "/sdk.js"
  ];

  const isPublicRouteForCors = publicOrigins.some((route) =>
    req.path.startsWith(route)
  );

  if (isPublicRouteForCors) {
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Api-Key, X-Site-Id, X-Request-Id, X-SDK-Version"
    );
  } else {
    res.setHeader("Access-Control-Allow-Origin", "null");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

/* ─────────────────────────────────────────────
   RATE LIMITERS
───────────────────────────────────────────── */

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,

  keyGenerator: (req) => {
    const siteId = req.headers["x-site-id"] || "anonymous";
    return `${siteId}:${req.ip}`;
  },

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    ok: false,
    error: "tenant_rate_limit_exceeded"
  }
});

app.use("/event", telemetryLimiter);
app.use(generalLimiter);

/* ─────────────────────────────────────────────
   BODY PARSING
───────────────────────────────────────────── */

app.use(
  express.json({
    limit: "1mb",

    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  })
);

app.use(express.urlencoded({ extended: true }));

app.use(timeout("15s"));

const haltOnTimeout = (req, res, next) => {
  if (req.timedout) {
    return;
  }

  next();
};

app.use(haltOnTimeout);

/* ─────────────────────────────────────────────
   UTILS & GLOBAL ROUTE GUARDS
───────────────────────────────────────────── */

const success = (data = {}) => ({
  ok: true,
  timestamp: new Date().toISOString(),
  ...data
});

const failure = (error, details = null) => ({
  ok: false,
  error,
  details,
  timestamp: new Date().toISOString()
});

function validateNumber(value) {
  if (value === undefined || value === null) {
    return 0;
  }

  const num = Number(value);

  return Number.isNaN(num) || !Number.isFinite(num)
    ? null
    : num;
}

function safeCompare(input, secret) {
  if (
    !input ||
    !secret ||
    typeof input !== "string" ||
    typeof secret !== "string" ||
    input.length !== secret.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(input, "utf8"),
    Buffer.from(secret, "utf8")
  );
}

const VALID_EVENTS = new Set([
  "PAGE_VIEW",
  "PRODUCT_VIEW",
  "ADD_TO_CART",
  "CHECKOUT_STARTED",
  "PURCHASE",
  "SESSION_START",
  "SESSION_END",
  "BEHAVIOR"
]);

const isPublicAsset = (p) =>
  ["/", "/health", "/sdk.js"].includes(p) ||
  /\.(png|jpg|jpeg|svg|css|js)$/i.test(p);

/*
 * Routes that do not require merchant SDK credentials.
 *
 * /api/v1/onboard
 *    PRETHIM server → REDEN server
 *
 * /api/v1/verify
 *    PRETHIM server → REDEN server
 */
const isPublicRoute = (req) =>
  isPublicAsset(req.path) ||
  req.path === "/api/v1/onboard" ||
  req.path === "/api/v1/verify" ||
  req.path.startsWith("/paystack");

/* ─────────────────────────────────────────────
   STATIC ASSET HANDLING & EXPLICIT ROUTES
───────────────────────────────────────────── */

app.get("/sdk.js", (req, res) => {
  res.type("application/javascript");

  res.sendFile(
    path.join(__dirname, "..", "public", "sdk.js")
  );
});

app.use(
  express.static(
    path.join(__dirname, "..", "public")
  )
);

/* ─────────────────────────────────────────────
   AUTH MIDDLEWARE
───────────────────────────────────────────── */

async function authenticate(req, res, next) {
  try {
    if (isPublicRoute(req)) {
      return next();
    }

    const apiKey =
      req.headers["x-api-key"] ||
      req.body?.api_key;

    const siteId =
      req.headers["x-site-id"] ||
      req.body?.site_id;

    if (!apiKey || !siteId) {
      return res
        .status(401)
        .json(failure("missing_credentials"));
    }

    const cacheKey = `site:${siteId}:${apiKey}`;

    if (redis) {
      const cached = await redis.get(cacheKey);

      if (cached) {
        req.site = JSON.parse(cached);
        return next();
      }
    }

    const result = await db.query(
      `
        SELECT
          id,
          site_id,
          name,
          active
        FROM sites
        WHERE api_key = $1
          AND site_id = $2
          AND active = true
        LIMIT 1
      `,
      [apiKey, siteId]
    );

    if (!result.rowCount) {
      return res
        .status(403)
        .json(failure("invalid_credentials"));
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

    res
      .status(500)
      .json(failure("auth_failed"));
  }
}

app.use(authenticate);

app.use((req, res, next) => {
  if (isPublicRoute(req)) {
    return next();
  }

  if (!req.site?.site_id) {
    return res
      .status(401)
      .json(failure("invalid_site_context"));
  }

  next();
});

app.use(haltOnTimeout);

/* ─────────────────────────────────────────────
   CORE ENGINE ROUTES
───────────────────────────────────────────── */

app.get("/", (req, res) => {
  res.json(
    success({
      service: "REDEN API",
      status: "operational",
      redis: !!redis
    })
  );
});

app.get("/health", async (req, res) => {
  let dbStatus = "healthy";

  try {
    await db.query("SELECT 1");
  } catch {
    dbStatus = "unhealthy";
  }

  const payload = success({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    database: dbStatus
  });

  return dbStatus === "healthy"
    ? res.json(payload)
    : res.status(503).json(payload);
});

/* ─────────────────────────────────────────────
   ONBOARD
───────────────────────────────────────────── */

app.post("/api/v1/onboard", async (req, res) => {
  try {
    /*
     * Only the authenticated PRETHIM server should be
     * allowed to create/retrieve REDEN installations.
     */
    const adminSecret = req.headers["x-admin-secret"];

    if (
      !adminSecret ||
      !safeCompare(
        adminSecret,
        process.env.ADMIN_SECRET
      )
    ) {
      return res
        .status(401)
        .json(
          failure(
            "unauthorized_onboarding_access"
          )
        );
    }

    const name =
      typeof req.body?.name === "string"
        ? req.body.name.trim()
        : "";

    const ownerEmail =
      typeof req.body?.owner_email === "string"
        ? req.body.owner_email.trim().toLowerCase()
        : "";

    if (!name || !ownerEmail) {
      return res
        .status(400)
        .json(
          failure("missing_fields", {
            required: ["name", "owner_email"]
          })
        );
    }

    /*
     * ─────────────────────────────────────────
     * EXISTING INSTALLATION
     * ─────────────────────────────────────────
     *
     * A merchant should not receive a new REDEN
     * installation every time they reconnect.
     *
     * owner_email + store name identifies the
     * existing installation.
     */

    const existing = await db.query(
      `
        SELECT
          site_id,
          api_key,
          name,
          owner_email,
          active,
          plan,
          subscription_status,
          created_at
        FROM sites
        WHERE LOWER(owner_email) = $1
          AND LOWER(name) = $2
        LIMIT 1
      `,
      [
        ownerEmail,
        name.toLowerCase()
      ]
    );

    if (existing.rowCount > 0) {
      const site = existing.rows[0];

      /*
       * If the installation was disabled, reconnecting
       * it makes it active again.
       */
      if (!site.active) {
        await db.query(
          `
            UPDATE sites
            SET
              active = true,
              subscription_status = 'active'
            WHERE site_id = $1
          `,
          [site.site_id]
        );
      }

      /*
       * Clear any cached authentication record so
       * the next request receives the current site state.
       */
      if (redis) {
        await redis.del(
          `site:${site.site_id}:${site.api_key}`
        );
      }

      console.log(
        `[ONBOARD] Existing installation returned: ${site.site_id}`
      );

      return res.status(200).json(
        success({
          existing: true,
          siteId: site.site_id,
          apiKey: site.api_key,
          name: site.name,
          plan: site.plan,
          subscriptionStatus: "active"
        })
      );
    }

    /*
     * ─────────────────────────────────────────
     * NEW INSTALLATION
     * ─────────────────────────────────────────
     */

    const siteId =
      `site_${crypto.randomBytes(8).toString("hex")}`;

    const apiKey =
      `rd_${crypto.randomBytes(24).toString("hex")}`;

    await db.query(
      `
        INSERT INTO sites (
          site_id,
          api_key,
          name,
          owner_email,
          active,
          plan,
          subscription_status
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          true,
          'basic',
          'active'
        )
      `,
      [
        siteId,
        apiKey,
        name,
        ownerEmail
      ]
    );

    console.log(
      `[ONBOARD] New installation created: ${siteId}`
    );

    return res.status(201).json(
      success({
        existing: false,
        siteId,
        apiKey,
        name,
        plan: "basic",
        subscriptionStatus: "active"
      })
    );
  } catch (e) {
    console.error(
      "[ONBOARD ERROR]",
      e
    );

    return res
      .status(500)
      .json(
        failure("onboard_failed")
      );
  }
});

/* ─────────────────────────────────────────────
   INSTALLATION VERIFICATION
───────────────────────────────────────────── */

app.get("/api/v1/verify", async (req, res) => {
  try {
    const siteId =
      typeof req.query.siteId === "string"
        ? req.query.siteId.trim()
        : "";

    if (!siteId) {
      return res
        .status(400)
        .json(
          failure("site_id_required")
        );
    }

    const result = await db.query(
      `
        SELECT
          site_id,
          name,
          active,
          plan,
          subscription_status,
          created_at
        FROM sites
        WHERE site_id = $1
        LIMIT 1
      `,
      [siteId]
    );

    if (!result.rowCount) {
      return res
        .status(404)
        .json(
          failure("installation_not_found")
        );
    }

    const site = result.rows[0];

    /*
     * The first storefront event proves that the
     * SDK is actually connected.
     */
    const eventResult = await db.query(
      `
        SELECT
          created_at
        FROM event_logs
        WHERE site_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [siteId]
    );

    const lastEventAt =
      eventResult.rowCount > 0
        ? eventResult.rows[0].created_at
        : null;

    return res.json(
      success({
        siteId: site.site_id,
        name: site.name,
        active: site.active,
        plan: site.plan,
        subscriptionStatus:
          site.subscription_status,
        connected: Boolean(lastEventAt),
        lastEventAt,
        createdAt: site.created_at
      })
    );
  } catch (e) {
    console.error(
      "[VERIFY ERROR]",
      e
    );

    return res
      .status(500)
      .json(
        failure("verification_failed")
      );
  }
});

/* ─────────────────────────────────────────────
   MAB TELEMETRY EVENTS
───────────────────────────────────────────── */

app.post("/event", async (req, res) => {
  try {
    const {
      session_id,
      event,
      payload,
      event_id
    } = req.body;

    if (!session_id || !event) {
      return res
        .status(400)
        .json(
          failure("missing_fields")
        );
    }

    const normalizedEvent =
      event.toUpperCase();

    if (!VALID_EVENTS.has(normalizedEvent)) {
      return res
        .status(400)
        .json(
          failure("invalid_event")
        );
    }

    const safeEventId =
      event_id ||
      `evt_${crypto.randomUUID()}`;

    const safePayload =
      JSON.stringify(payload || {});

    const safeCart =
      JSON.stringify(
        payload?.cart || {}
      );

    if (
      Buffer.byteLength(safeCart) > 20000 ||
      Buffer.byteLength(safePayload) > 50000
    ) {
      return res
        .status(413)
        .json(
          failure(
            "payload_bounds_exceeded"
          )
        );
    }

    const clientIp =
      req.headers["x-forwarded-for"]
        ?.split(",")[0]
        ?.trim() ||
      req.ip;

    await db.query(
      `
        INSERT INTO event_logs (
          event_id,
          site_id,
          session_id,
          event,
          payload,
          ip_address,
          user_agent
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7
        )
      `,
      [
        safeEventId,
        req.site.site_id,
        session_id,
        normalizedEvent,
        safePayload,
        clientIp,
        req.headers["user-agent"]
      ]
    );

    if (
      normalizedEvent === "CHECKOUT_STARTED" &&
      payload?.email
    ) {
      await db.query(
        `
          INSERT INTO recovery_queue (
            site_id,
            session_id,
            customer_email,
            cart_data,
            incentive
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5
          )
          ON CONFLICT (
            session_id,
            customer_email
          )
          DO NOTHING
        `,
        [
          req.site.site_id,
          session_id,
          payload.email,
          safeCart,
          "10% OFF"
        ]
      );
    }

    res.json(
      success({
        event_id: safeEventId
      })
    );
  } catch (e) {
    console.error(e);

    res
      .status(500)
      .json(
        failure("event_failed")
      );
  }
});

/* ─────────────────────────────────────────────
   SCORE
───────────────────────────────────────────── */

app.post("/score", async (req, res) => {
  try {
    const {
      session_id,
      cart_id,
      cart_value,
      payload
    } = req.body;

    if (!session_id) {
      return res
        .status(400)
        .json(
          failure("missing_session_id")
        );
    }

    const value =
      validateNumber(cart_value);

    if (value === null) {
      return res
        .status(400)
        .json(
          failure("invalid_cart_value")
        );
    }

    const action =
      (await pickAction({
        session_id,
        cart_value: value,
        behavior: payload || {}
      })) || "NONE";

    const discountMap = {
      NONE: 0,
      INCENTIVE_LOW: 5,
      INCENTIVE_MED: 10,
      INCENTIVE_HIGH: 20
    };

    const discount =
      discountMap[action] || 0;

    const result = await db.query(
      `
        INSERT INTO decisions (
          site_id,
          session_id,
          cart_id,
          action,
          discount,
          expected_value,
          state
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          'SCORED'
        )
        RETURNING id
      `,
      [
        req.site.site_id,
        session_id,
        cart_id || null,
        action,
        discount,
        Math.max(
          0,
          value - discount
        )
      ]
    );

    res.json(
      success({
        decision_id:
          result.rows[0].id,
        action,
        discount,
        propensity_score:
          payload?.scroll_depth
            ? payload.scroll_depth / 100
            : 0.5
      })
    );
  } catch (e) {
    console.error(e);

    res
      .status(500)
      .json(
        failure("score_failed")
      );
  }
});

/* ─────────────────────────────────────────────
   ACTION
───────────────────────────────────────────── */

app.post("/action", async (req, res) => {
  try {
    const { decision_id } =
      req.body;

    if (!decision_id) {
      return res
        .status(400)
        .json(
          failure(
            "missing_decision_id"
          )
        );
    }

    const r = await db.query(
      `
        UPDATE decisions
        SET state = 'ACTIONED'
        WHERE id = $1
          AND site_id = $2
      `,
      [
        decision_id,
        req.site.site_id
      ]
    );

    if (!r.rowCount) {
      return res
        .status(404)
        .json(
          failure("not_found")
        );
    }

    res.json(
      success({
        actioned: true
      })
    );
  } catch (e) {
    console.error(e);

    res
      .status(500)
      .json(
        failure("action_failed")
      );
  }
});

/* ─────────────────────────────────────────────
   OUTCOME
───────────────────────────────────────────── */

app.post("/outcome", async (req, res) => {
  try {
    const {
      decision_id,
      converted,
      revenue
    } = req.body;

    if (!decision_id) {
      return res
        .status(400)
        .json(
          failure(
            "missing_decision_id"
          )
        );
    }

    const revenueValue =
      validateNumber(revenue);

    const existing =
      await db.query(
        `
          SELECT
            action,
            state
          FROM decisions
          WHERE id = $1
            AND site_id = $2
        `,
        [
          decision_id,
          req.site.site_id
        ]
      );

    if (!existing.rowCount) {
      return res
        .status(404)
        .json(
          failure("not_found")
        );
    }

    if (
      existing.rows[0].state ===
      "COMPLETED"
    ) {
      return res
        .status(409)
        .json(
          failure("already_done")
        );
    }

    await db.query(
      `
        UPDATE decisions
        SET
          state = 'COMPLETED',
          converted = $1,
          revenue = $2,
          completed_at = NOW()
        WHERE id = $3
          AND site_id = $4
      `,
      [
        !!converted,
        revenueValue || 0,
        decision_id,
        req.site.site_id
      ]
    );

    await updateBandit(
      existing.rows[0].action,
      !!converted
    );

    res.json(
      success({
        updated: true
      })
    );
  } catch (e) {
    console.error(e);

    res
      .status(500)
      .json(
        failure("outcome_failed")
      );
  }
});

/* ─────────────────────────────────────────────
   METRICS
───────────────────────────────────────────── */

app.get("/metrics", async (req, res) => {
  try {
    const r = await db.query(
      `
        SELECT
          COUNT(*) total,
          COUNT(*) FILTER (
            WHERE converted = true
          ) conversions,
          COALESCE(
            SUM(revenue),
            0
          ) revenue
        FROM decisions
        WHERE site_id = $1
          AND state = 'COMPLETED'
      `,
      [req.site.site_id]
    );

    const row = r.rows[0];

    res.json(
      success({
        total: Number(row.total),
        conversions:
          Number(row.conversions),
        revenue:
          Number(row.revenue)
      })
    );
  } catch (e) {
    console.error(e);

    res
      .status(500)
      .json(
        failure("metrics_failed")
      );
  }
});

/* ─────────────────────────────────────────────
   PAYSTACK WEBHOOK
───────────────────────────────────────────── */

app.use(
  "/paystack",
  paystackRoutes
);

/* ─────────────────────────────────────────────
   CRON SYSTEM ENGINE
───────────────────────────────────────────── */

cron.schedule(
  "*/15 * * * *",
  async () => {
    if (
      !db ||
      typeof db.connect !== "function"
    ) {
      return;
    }

    const client =
      await db.connect();

    let claimed = [];

    try {
      await client.query(
        "BEGIN"
      );

      const batch =
        await client.query(`
          UPDATE recovery_queue
          SET status = 'PROCESSING'
          WHERE id IN (
            SELECT id
            FROM recovery_queue
            WHERE status = 'PENDING'
              AND created_at >= NOW() - INTERVAL '7 days'
            FOR UPDATE SKIP LOCKED
            LIMIT 20
          )
          RETURNING *
        `);

      claimed = batch.rows;

      await client.query(
        "COMMIT"
      );
    } catch (e) {
      await client.query(
        "ROLLBACK"
      );

      console.error(
        "[CRON BATCH CLAIM ERROR]",
        e
      );
    } finally {
      client.release();
    }

    for (const item of claimed) {
      try {
        const conversionCheck =
          await db.query(
            `
              SELECT id
              FROM decisions
              WHERE session_id = $1
                AND converted = true
              LIMIT 1
            `,
            [item.session_id]
          );

        if (
          conversionCheck.rowCount >
          0
        ) {
          await db.query(
            `
              UPDATE recovery_queue
              SET status = 'COMPLETED'
              WHERE id = $1
            `,
            [item.id]
          );

          continue;
        }

        await sendRecoveryEmail({
          to: item.customer_email,
          incentive: item.incentive,
          cart: item.cart_data
        });

        await db.query(
          `
            UPDATE recovery_queue
            SET
              status = 'SENT',
              processed_at = NOW()
            WHERE id = $1
          `,
          [item.id]
        );

        await db.query(
          `
            INSERT INTO email_logs (
              site_id,
              email_type,
              recipient,
              subject,
              status
            )
            VALUES (
              $1,
              'RECOVERY',
              $2,
              'Complete your checkout',
              'SENT'
            )
          `,
          [
            item.site_id,
            item.customer_email
          ]
        );
      } catch (e) {
        console.error(
          `[RECOVERY EMAIL SEND ERROR] Target: ${item.customer_email}`,
          e
        );

        await db.query(
          `
            UPDATE recovery_queue
            SET
              status = 'FAILED',
              processed_at = NOW()
            WHERE id = $1
          `,
          [item.id]
        );
      }
    }
  }
);

cron.schedule(
  "0 8 * * *",
  async () => {
    if (redis) {
      const lockKey =
        `lock:cron:daily_report:${new Date()
          .toISOString()
          .split("T")[0]}`;

      const acquired =
        await redis.set(
          lockKey,
          "locked",
          "NX",
          "PX",
          3600000
        );

      if (!acquired) {
        return;
      }
    }

    try {
      const merchants =
        await db.query(
          `
            SELECT *
            FROM sites
            WHERE active = true
          `
        );

      for (const m of merchants.rows) {
        const stats =
          await db.query(
            `
              SELECT
                COUNT(*) total,
                COUNT(*) FILTER (
                  WHERE converted = true
                ) conversions,
                COALESCE(
                  SUM(revenue),
                  0
                ) revenue
              FROM decisions
              WHERE site_id = $1
                AND state = 'COMPLETED'
                AND completed_at >= NOW() - INTERVAL '1 day'
            `,
            [m.site_id]
          );

        const metrics =
          stats.rows[0];

        await sendDailyReport({
          to: m.owner_email,
          merchantName: m.name,

          metrics: {
            total:
              Number(metrics.total),

            conversions:
              Number(
                metrics.conversions
              ),

            revenue:
              Number(
                metrics.revenue
              )
          }
        });

        await db.query(
          `
            INSERT INTO email_logs (
              site_id,
              email_type,
              recipient,
              subject,
              status
            )
            VALUES (
              $1,
              'DAILY_REPORT',
              $2,
              'Daily REDEN API Performance Report',
              'SENT'
            )
          `,
          [
            m.site_id,
            m.owner_email
          ]
        );
      }
    } catch (e) {
      console.error(
        "[DAILY REPORT CRON FAILURE]",
        e
      );
    }
  },
  {
    timezone: "UTC"
  }
);

/* ─────────────────────────────────────────────
   ERROR HANDLING
───────────────────────────────────────────── */

app.use((req, res) =>
  res
    .status(404)
    .json(
      failure("not_found")
    )
);

app.use(
  (err, req, res, next) => {
    console.error(err);

    res
      .status(500)
      .json(
        failure("internal_error")
      );
  }
);

/* ─────────────────────────────────────────────
   SERVER
───────────────────────────────────────────── */

const PORT =
  process.env.PORT || 3000;

const server = app.listen(
  PORT,
  () =>
    console.log(
      `REDEN API fully hardened instance up on port ${PORT}`
    )
);

/* ─────────────────────────────────────────────
   GRACEFUL SHUTDOWN
───────────────────────────────────────────── */

const shutdownHandler =
  async (signal) => {
    console.log(
      `\n[${signal}] processing teardown signal. Draining server threads.`
    );

    server.close(async () => {
      try {
        if (
          db &&
          typeof db.end === "function"
        ) {
          await db.end();
        }

        if (redis) {
          await redis.quit();
        }

        process.exit(0);
      } catch (e) {
        console.error(
          "[SHUTDOWN ERROR]",
          e
        );

        process.exit(1);
      }
    });
  };

process.on(
  "SIGINT",
  () =>
    shutdownHandler("SIGINT")
);

process.on(
  "SIGTERM",
  () =>
    shutdownHandler("SIGTERM")
);
