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

import {
  pickAction,
  updateBandit
} from "../optimization/banditEngine.js";

import {
  initRedis,
  redis
} from "../infrastructure/redis.js";

import {
  sendDailyReport,
  sendRecoveryEmail
} from "../notification/emailEngine.js";

import paystackRoutes from "./routes/paystack.js";

dotenv.config();

/* =========================================================
   ENVIRONMENT
========================================================= */

const INTERNAL_ADMIN_SECRET =
  process.env.ADMIN_SECRET ||
  process.env.REDEN_ADMIN_SECRET;

const requiredEnv = [
  "DATABASE_URL",
  "PAYSTACK_SECRET_KEY"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(
      `Missing mandatory environment variable: ${key}`
    );
  }
}

if (!INTERNAL_ADMIN_SECRET) {
  throw new Error(
    "Missing REDEN internal admin secret. Set ADMIN_SECRET."
  );
}

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

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

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_sites_owner_name
    ON sites(owner_email, name);
  `);

  console.log(
    "[DB INIT] Core architecture tables & optimization indexes verified."
  );
} catch (err) {
  console.error(
    "[DB INIT ERROR] Failed to verify schema infrastructure:",
    err
  );
}

await initRedis();

/* =========================================================
   APP
========================================================= */

const app = express();

app.set("trust proxy", true);
app.disable("x-powered-by");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================================================
   SECURITY
========================================================= */

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: {
      policy: "cross-origin"
    }
  })
);

app.use(compression());

/* =========================================================
   CORS
========================================================= */

app.use((req, res, next) => {
  const publicOrigins = [
    "/event",
    "/score",
    "/action",
    "/outcome",
    "/sdk.js"
  ];

  const isPublicRouteForCors =
    publicOrigins.some((route) =>
      req.path.startsWith(route)
    );

  if (isPublicRouteForCors) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Api-Key, X-Site-Id, X-Request-Id, X-SDK-Version"
    );
  } else {
    res.setHeader(
      "Access-Control-Allow-Origin",
      "null"
    );
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

/* =========================================================
   RATE LIMITING
========================================================= */

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
    const siteId =
      req.headers["x-site-id"] ||
      "anonymous";

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

/* =========================================================
   BODY PARSING
========================================================= */

app.use(
  express.json({
    limit: "1mb",

    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(timeout("15s"));

const haltOnTimeout = (req, res, next) => {
  if (req.timedout) {
    return;
  }

  next();
};

app.use(haltOnTimeout);

/* =========================================================
   RESPONSE HELPERS
========================================================= */

const success = (data = {}) => ({
  ok: true,
  timestamp: new Date().toISOString(),
  ...data
});

const failure = (
  error,
  details = null
) => ({
  ok: false,
  error,
  details,
  timestamp: new Date().toISOString()
});

/* =========================================================
   UTILS
========================================================= */

function validateNumber(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return 0;
  }

  const num = Number(value);

  return Number.isNaN(num) ||
    !Number.isFinite(num)
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

/* =========================================================
   ROUTE CLASSIFICATION
========================================================= */

/*
 * These routes do NOT require merchant credentials.
 */
const isPublicRoute = (req) =>
  isPublicAsset(req.path) ||
  req.path === "/api/v1/verify" ||
  req.path.startsWith("/paystack");

/*
 * These routes are internal PRETHIM -> REDEN routes.
 *
 * They use ADMIN_SECRET.
 *
 * IMPORTANT:
 * They must NEVER fall through to merchant
 * x-api-key authentication.
 */
const isAdminRoute = (req) =>
  req.path === "/api/v1/intelligence" ||
  req.path === "/api/v1/installation" ||
  req.path === "/api/v1/onboard";

/* =========================================================
   STATIC ASSETS
========================================================= */

app.get(
  "/sdk.js",
  (req, res) => {
    res.type("application/javascript");

    res.sendFile(
      path.join(
        __dirname,
        "..",
        "public",
        "sdk.js"
      )
    );
  }
);

app.use(
  express.static(
    path.join(
      __dirname,
      "..",
      "public"
    )
  )
);

/* =========================================================
   AUTHENTICATION
========================================================= */

async function authenticate(req, res, next) {
  try {
    /*
     * Public routes bypass authentication.
     */
    if (isPublicRoute(req)) {
      return next();
    }

    /*
     * INTERNAL PRETHIM -> REDEN
     *
     * These routes use ADMIN_SECRET.
     */
    if (isAdminRoute(req)) {
      const adminSecret =
        req.headers["x-admin-secret"];

      if (
        typeof adminSecret !== "string" ||
        !safeCompare(
          adminSecret,
          INTERNAL_ADMIN_SECRET
        )
      ) {
        console.error(
          `[AUTH] Unauthorized internal access: ${req.method} ${req.path}`
        );

        return res
          .status(401)
          .json(
            failure(
              "unauthorized_internal_access"
            )
          );
      }

      req.isAdminRoute = true;

      return next();
    }

    /*
     * MERCHANT SDK AUTHENTICATION
     *
     * Only actual storefront/SDK routes come here.
     */
    const apiKey =
      req.headers["x-api-key"] ||
      req.body?.api_key;

    const siteId =
      req.headers["x-site-id"] ||
      req.body?.site_id;

    if (
      typeof apiKey !== "string" ||
      typeof siteId !== "string" ||
      !apiKey.trim() ||
      !siteId.trim()
    ) {
      return res
        .status(401)
        .json(
          failure(
            "missing_credentials"
          )
        );
    }

    const normalizedApiKey =
      apiKey.trim();

    const normalizedSiteId =
      siteId.trim();

    const cacheKey =
      `site:${normalizedSiteId}:${normalizedApiKey}`;

    if (redis) {
      const cached =
        await redis.get(cacheKey);

      if (cached) {
        req.site =
          JSON.parse(cached);

        return next();
      }
    }

    const result =
      await db.query(
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
        [
          normalizedApiKey,
          normalizedSiteId
        ]
      );

    if (!result.rowCount) {
      return res
        .status(403)
        .json(
          failure(
            "invalid_credentials"
          )
        );
    }

    req.site =
      result.rows[0];

    if (redis) {
      await redis.set(
        cacheKey,
        JSON.stringify(req.site),
        "EX",
        300
      );
    }

    return next();
  } catch (error) {
    console.error(
      "[AUTH ERROR]",
      error
    );

    return res
      .status(500)
      .json(
        failure(
          "auth_failed"
        )
      );
  }
}

app.use(authenticate);

/* =========================================================
   SITE CONTEXT
========================================================= */

app.use((req, res, next) => {
  if (isPublicRoute(req)) {
    return next();
  }

  /*
   * Internal REDEN routes already have their
   * own authenticated context.
   */
  if (isAdminRoute(req)) {
    return next();
  }

  if (!req.site?.site_id) {
    return res
      .status(401)
      .json(
        failure(
          "invalid_site_context"
        )
      );
  }

  next();
});

app.use(haltOnTimeout);

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json(
      success({
        service: "REDEN API",
        status: "operational",
        redis: !!redis
      })
    );
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  async (req, res) => {
    let dbStatus = "healthy";

    try {
      await db.query("SELECT 1");
    } catch {
      dbStatus = "unhealthy";
    }

    const payload =
      success({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        database: dbStatus
      });

    return dbStatus === "healthy"
      ? res.json(payload)
      : res.status(503).json(payload);
  }
);

/* =========================================================
   INTERNAL INSTALLATION LOOKUP
========================================================= */

/*
 * PRETHIM uses this endpoint to resolve the REDEN
 * installation belonging to the authenticated user.
 *
 * This is NOT a merchant SDK endpoint.
 *
 * Therefore:
 *
 *   x-admin-secret
 *        ↓
 *   REDEN installation lookup
 *
 * No x-api-key.
 * No x-site-id.
 */
app.get(
  "/api/v1/installation",
  async (req, res) => {
    try {
      if (!req.isAdminRoute) {
        return res
          .status(401)
          .json(
            failure(
              "unauthorized_internal_access"
            )
          );
      }

      const ownerEmail =
        typeof req.query.owner_email === "string"
          ? req.query.owner_email
              .trim()
              .toLowerCase()
          : "";

      if (!ownerEmail) {
        return res
          .status(400)
          .json(
            failure(
              "owner_email_required"
            )
          );
      }

      /*
       * Return the active installation.
       *
       * Most PRETHIM accounts should have one
       * installation.
       */
      const result =
        await db.query(
          `
            SELECT
              site_id,
              name,
              owner_email,
              active,
              plan,
              subscription_status,
              created_at
            FROM sites
            WHERE LOWER(owner_email) = $1
              AND active = true
            ORDER BY created_at DESC
            LIMIT 1
          `,
          [ownerEmail]
        );

      if (!result.rowCount) {
        return res
          .status(404)
          .json(
            failure(
              "reden_installation_not_found"
            )
          );
      }

      const site =
        result.rows[0];

      return res.json(
        success({
          installation: {
            site_id: site.site_id,
            store_name: site.name,
            owner_email: site.owner_email,
            status:
              site.active
                ? "active"
                : "inactive",
            plan: site.plan,
            subscription_status:
              site.subscription_status,
            created_at: site.created_at
          }
        })
      );
    } catch (error) {
      console.error(
        "[INSTALLATION LOOKUP ERROR]",
        error
      );

      return res
        .status(500)
        .json(
          failure(
            "installation_lookup_failed"
          )
        );
    }
  }
);

/* =========================================================
   ONBOARD
========================================================= */

app.post(
  "/api/v1/onboard",
  async (req, res) => {
    try {
      if (!req.isAdminRoute) {
        return res
          .status(401)
          .json(
            failure(
              "unauthorized_internal_access"
            )
          );
      }

      const name =
        typeof req.body?.name === "string"
          ? req.body.name.trim()
          : "";

      const ownerEmail =
        typeof req.body?.owner_email === "string"
          ? req.body.owner_email
              .trim()
              .toLowerCase()
          : "";

      if (!name || !ownerEmail) {
        return res
          .status(400)
          .json(
            failure(
              "missing_fields",
              {
                required: [
                  "name",
                  "owner_email"
                ]
              }
            )
          );
      }

      const existing =
        await db.query(
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
        const site =
          existing.rows[0];

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

        if (redis) {
          await redis.del(
            `site:${site.site_id}:${site.api_key}`
          );
        }

        console.log(
          `[ONBOARD] Existing installation returned: ${site.site_id}`
        );

        return res
          .status(200)
          .json(
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

      return res
        .status(201)
        .json(
          success({
            existing: false,
            siteId,
            apiKey,
            name,
            plan: "basic",
            subscriptionStatus: "active"
          })
        );
    } catch (error) {
      console.error(
        "[ONBOARD ERROR]",
        error
      );

      return res
        .status(500)
        .json(
          failure(
            "onboard_failed"
          )
        );
    }
  }
);

/* =========================================================
   INSTALLATION VERIFICATION
========================================================= */

app.get(
  "/api/v1/verify",
  async (req, res) => {
    try {
      const siteId =
        typeof req.query.siteId === "string"
          ? req.query.siteId.trim()
          : "";

      if (!siteId) {
        return res
          .status(400)
          .json(
            failure(
              "site_id_required"
            )
          );
      }

      const result =
        await db.query(
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
            failure(
              "installation_not_found"
            )
          );
      }

      const site =
        result.rows[0];

      const eventResult =
        await db.query(
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
          connected:
            Boolean(lastEventAt),
          lastEventAt,
          createdAt: site.created_at
        })
      );
    } catch (error) {
      console.error(
        "[VERIFY ERROR]",
        error
      );

      return res
        .status(500)
        .json(
          failure(
            "verification_failed"
          )
        );
    }
  }
);

/* =========================================================
   REDEN INTELLIGENCE
========================================================= */

app.post(
  "/api/v1/intelligence",
  async (req, res) => {
    try {
      if (!req.isAdminRoute) {
        return res
          .status(401)
          .json(
            failure(
              "unauthorized_internal_access"
            )
          );
      }

      const siteId =
        typeof req.body?.siteId === "string"
          ? req.body.siteId.trim()
          : "";

      const question =
        typeof req.body?.question === "string"
          ? req.body.question.trim()
          : "";

      if (!siteId) {
        return res
          .status(400)
          .json(
            failure(
              "site_id_required"
            )
          );
      }

      if (!question) {
        return res
          .status(400)
          .json(
            failure(
              "question_required"
            )
          );
      }

      if (question.length > 2000) {
        return res
          .status(400)
          .json(
            failure(
              "question_too_long"
            )
          );
      }

      /*
       * Verify installation.
       */
      const siteResult =
        await db.query(
          `
            SELECT
              site_id,
              name,
              owner_email,
              active,
              plan,
              subscription_status
            FROM sites
            WHERE site_id = $1
            LIMIT 1
          `,
          [siteId]
        );

      if (!siteResult.rowCount) {
        return res
          .status(404)
          .json(
            failure(
              "installation_not_found"
            )
          );
      }

      const site =
        siteResult.rows[0];

      if (!site.active) {
        return res
          .status(403)
          .json(
            failure(
              "installation_inactive"
            )
          );
      }

      /* =====================================================
         EVENT TELEMETRY
      ===================================================== */

      const eventsResult =
        await db.query(
          `
            SELECT
              event,
              COUNT(*)::int AS count
            FROM event_logs
            WHERE site_id = $1
              AND created_at >= NOW()
                - INTERVAL '24 hours'
            GROUP BY event
            ORDER BY count DESC
          `,
          [siteId]
        );

      /* =====================================================
         DECISION PERFORMANCE
      ===================================================== */

      const decisionsResult =
        await db.query(
          `
            SELECT
              COUNT(*)::int AS completed_decisions,

              COUNT(*) FILTER (
                WHERE converted = true
              )::int AS conversions,

              COALESCE(
                SUM(revenue) FILTER (
                  WHERE converted = true
                ),
                0
              ) AS revenue
            FROM decisions
            WHERE site_id = $1
              AND state = 'COMPLETED'
              AND completed_at >= NOW()
                - INTERVAL '24 hours'
          `,
          [siteId]
        );

      /* =====================================================
         RECOVERY
      ===================================================== */

      const recoveryResult =
        await db.query(
          `
            SELECT
              COUNT(*)::int AS total,

              COUNT(*) FILTER (
                WHERE status = 'PENDING'
              )::int AS pending,

              COUNT(*) FILTER (
                WHERE status = 'PROCESSING'
              )::int AS processing,

              COUNT(*) FILTER (
                WHERE status = 'SENT'
              )::int AS sent,

              COUNT(*) FILTER (
                WHERE status = 'COMPLETED'
              )::int AS completed,

              COUNT(*) FILTER (
                WHERE status = 'FAILED'
              )::int AS failed
            FROM recovery_queue
            WHERE site_id = $1
              AND created_at >= NOW()
                - INTERVAL '24 hours'
          `,
          [siteId]
        );

      /* =====================================================
         EMAILS
      ===================================================== */

      const emailResult =
        await db.query(
          `
            SELECT
              email_type,
              status,
              COUNT(*)::int AS count
            FROM email_logs
            WHERE site_id = $1
              AND created_at >= NOW()
                - INTERVAL '24 hours'
            GROUP BY
              email_type,
              status
            ORDER BY count DESC
          `,
          [siteId]
        );

      const events =
        eventsResult.rows.map(
          (row) => ({
            event: row.event,
            count: Number(row.count)
          })
        );

      const decision =
        decisionsResult.rows[0] || {};

      const recovery =
        recoveryResult.rows[0] || {};

      const emails =
        emailResult.rows.map(
          (row) => ({
            type: row.email_type,
            status: row.status,
            count: Number(row.count)
          })
        );

      const completedDecisions =
        Number(
          decision.completed_decisions || 0
        );

      const conversions =
        Number(
          decision.conversions || 0
        );

      const revenue =
        Number(
          decision.revenue || 0
        );

      const conversionRate =
        completedDecisions > 0
          ? Number(
              (
                (conversions /
                  completedDecisions) *
                100
              ).toFixed(2)
            )
          : 0;

      const eventCount = (name) =>
        events.find(
          (item) =>
            item.event === name
        )?.count || 0;

      const pageViews =
        eventCount("PAGE_VIEW");

      const productViews =
        eventCount("PRODUCT_VIEW");

      const addToCart =
        eventCount("ADD_TO_CART");

      const checkoutStarted =
        eventCount("CHECKOUT_STARTED");

      const purchases =
        eventCount("PURCHASE");

      const checkoutGap =
        Math.max(
          0,
          checkoutStarted - purchases
        );

      const recoveryPending =
        Number(
          recovery.pending || 0
        );

      const recoveryProcessing =
        Number(
          recovery.processing || 0
        );

      const recoverySent =
        Number(
          recovery.sent || 0
        );

      const recoveryCompleted =
        Number(
          recovery.completed || 0
        );

      const recoveryFailed =
        Number(
          recovery.failed || 0
        );

      const totalEmails =
        emails.reduce(
          (sum, item) =>
            sum + item.count,
          0
        );

      /* =====================================================
         GROUNDED ANSWER ENGINE
      ===================================================== */

      const q =
        question.toLowerCase();

      let answer;

      if (
        q.includes("performance") ||
        q.includes("today") ||
        q.includes("happening") ||
        q.includes("happened") ||
        q.includes("overview") ||
        q.includes("summary")
      ) {
        answer =
          `Over the last 24 hours, ${site.name} recorded ` +
          `${completedDecisions} completed decisions, ` +
          `${conversions} conversions, and ` +
          `${revenue} in attributed revenue. ` +
          `The decision conversion rate was ` +
          `${conversionRate}%. ` +
          `Telemetry recorded ${pageViews} page views, ` +
          `${productViews} product views, ` +
          `${addToCart} add-to-cart events, ` +
          `${checkoutStarted} checkout starts, ` +
          `and ${purchases} purchase events.`;
      } else if (
        q.includes("abandon") ||
        q.includes("checkout") ||
        q.includes("cart")
      ) {
        answer =
          `REDEN recorded ${checkoutStarted} checkout starts ` +
          `and ${purchases} purchase events in the last 24 hours. ` +
          `The observed checkout-to-purchase gap is ` +
          `${checkoutGap}. ` +
          `The recovery queue currently has ` +
          `${recoveryPending} pending, ` +
          `${recoverySent} sent, ` +
          `${recoveryCompleted} completed, and ` +
          `${recoveryFailed} failed records.`;
      } else if (
        q.includes("recovery") ||
        q.includes("recover")
      ) {
        answer =
          `Recovery activity over the last 24 hours: ` +
          `${recoveryPending} pending, ` +
          `${recoveryProcessing} processing, ` +
          `${recoverySent} sent, ` +
          `${recoveryCompleted} completed, and ` +
          `${recoveryFailed} failed.`;
      } else if (
        q.includes("conversion") ||
        q.includes("convert")
      ) {
        answer =
          `${site.name} recorded ${conversions} conversions ` +
          `from ${completedDecisions} completed decisions ` +
          `in the last 24 hours. ` +
          `That produces a ${conversionRate}% conversion rate ` +
          `and ${revenue} in attributed revenue.`;
      } else if (
        q.includes("revenue") ||
        q.includes("sales") ||
        q.includes("money") ||
        q.includes("earned")
      ) {
        answer =
          `REDEN attributed ${revenue} in revenue to ` +
          `completed decisions during the last 24 hours. ` +
          `${conversions} conversions were recorded from ` +
          `${completedDecisions} completed decisions.`;
      } else if (
        q.includes("email") ||
        q.includes("mail")
      ) {
        answer =
          `REDEN recorded ${totalEmails} email operations ` +
          `during the last 24 hours. ` +
          `The recovery queue currently has ` +
          `${recoveryPending} pending, ` +
          `${recoverySent} sent, ` +
          `${recoveryCompleted} completed, and ` +
          `${recoveryFailed} failed records.`;
      } else if (
        q.includes("traffic") ||
        q.includes("visitor") ||
        q.includes("visitors") ||
        q.includes("views")
      ) {
        answer =
          `Storefront telemetry recorded ` +
          `${pageViews} page views and ` +
          `${productViews} product views during the last 24 hours. ` +
          `There were ${addToCart} add-to-cart events, ` +
          `${checkoutStarted} checkout starts, and ` +
          `${purchases} purchases.`;
      } else if (
        q.includes("site") ||
        q.includes("store") ||
        q.includes("status") ||
        q.includes("connected")
      ) {
        answer =
          `${site.name} is currently active on REDEN ` +
          `under the ${site.plan} plan. ` +
          `The subscription status is ` +
          `${site.subscription_status}.`;
      } else {
        answer =
          `I can analyze ${site.name}'s REDEN data, including ` +
          `performance, revenue, conversions, traffic, ` +
          `checkout abandonment, recovery activity, ` +
          `and email operations. ` +
          `Ask me a question about any of those areas.`;
      }

      return res.json(
        success({
          answer,

          site: {
            siteId: site.site_id,
            name: site.name,
            plan: site.plan,
            subscriptionStatus:
              site.subscription_status
          },

          evidence: {
            period: "last_24_hours",

            events,

            decisions: {
              completed:
                completedDecisions,
              conversions,
              conversionRate,
              revenue
            },

            recovery: {
              total:
                Number(
                  recovery.total || 0
                ),
              pending:
                recoveryPending,
              processing:
                recoveryProcessing,
              sent:
                recoverySent,
              completed:
                recoveryCompleted,
              failed:
                recoveryFailed
            },

            emails
          }
        })
      );
    } catch (error) {
      console.error(
        "[INTELLIGENCE ERROR]",
        error
      );

      return res
        .status(500)
        .json(
          failure(
            "intelligence_failed"
          )
        );
    }
  }
);

/* =========================================================
   EVENT
========================================================= */

app.post(
  "/event",
  async (req, res) => {
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
            failure(
              "missing_fields"
            )
          );
      }

      const normalizedEvent =
        event.toUpperCase();

      if (
        !VALID_EVENTS.has(
          normalizedEvent
        )
      ) {
        return res
          .status(400)
          .json(
            failure(
              "invalid_event"
            )
          );
      }

      const safeEventId =
        event_id ||
        `evt_${crypto.randomUUID()}`;

      const safePayload =
        JSON.stringify(
          payload || {}
        );

      const safeCart =
        JSON.stringify(
          payload?.cart || {}
        );

      if (
        Buffer.byteLength(
          safeCart
        ) > 20000 ||
        Buffer.byteLength(
          safePayload
        ) > 50000
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
        req.headers[
          "x-forwarded-for"
        ]
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
        normalizedEvent ===
          "CHECKOUT_STARTED" &&
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

      return res.json(
        success({
          event_id: safeEventId
        })
      );
    } catch (error) {
      console.error(
        "[EVENT ERROR]",
        error
      );

      return res
        .status(500)
        .json(
          failure(
            "event_failed"
          )
        );
    }
  }
);

/* =========================================================
   SCORE
========================================================= */

app.post(
  "/score",
  async (req, res) => {
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
            failure(
              "missing_session_id"
            )
          );
      }

      const value =
        validateNumber(
          cart_value
        );

      if (value === null) {
        return res
          .status(400)
          .json(
            failure(
              "invalid_cart_value"
            )
          );
      }

      const action =
        (await pickAction({
          session_id,
          cart_value: value,
          behavior:
            payload || {}
        })) || "NONE";

      const discountMap = {
        NONE: 0,
        INCENTIVE_LOW: 5,
        INCENTIVE_MED: 10,
        INCENTIVE_HIGH: 20
      };

      const discount =
        discountMap[action] || 0;

      const result =
        await db.query(
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

      return res.json(
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
    } catch (error) {
      console.error(
        "[SCORE ERROR]",
        error
      );

      return res
        .status(500)
        .json(
          failure(
            "score_failed"
          )
        );
    }
  }
);

/* =========================================================
   ACTION
========================================================= */

app.post(
  "/action",
  async (req, res) => {
    try {
      const {
        decision_id
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

      const r =
        await db.query(
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
            failure(
              "not_found"
            )
          );
      }

      return res.json(
        success({
          actioned: true
        })
      );
    } catch (error) {
      console.error(
        "[ACTION ERROR]",
        error
      );

      return res
        .status(500)
        .json(
          failure(
            "action_failed"
          )
        );
    }
  }
);

/* =========================================================
   OUTCOME
========================================================= */

app.post(
  "/outcome",
  async (req, res) => {
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
        validateNumber(
          revenue
        );

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
            failure(
              "not_found"
            )
          );
      }

      if (
        existing.rows[0].state ===
        "COMPLETED"
      ) {
        return res
          .status(409)
          .json(
            failure(
              "already_done"
            )
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

      return res.json(
        success({
          updated: true
        })
      );
    } catch (error) {
      console.error(
        "[OUTCOME ERROR]",
        error
      );

      return res
        .status(500)
        .json(
          failure(
            "outcome_failed"
          )
        );
    }
  }
);

/* =========================================================
   METRICS
========================================================= */

app.get(
  "/metrics",
  async (req, res) => {
    try {
      const r =
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
          `,
          [req.site.site_id]
        );

      const row =
        r.rows[0];

      return res.json(
        success({
          total:
            Number(row.total),
          conversions:
            Number(row.conversions),
          revenue:
            Number(row.revenue)
        })
      );
    } catch (error) {
      console.error(
        "[METRICS ERROR]",
        error
      );

      return res
        .status(500)
        .json(
          failure(
            "metrics_failed"
          )
        );
    }
  }
);

/* =========================================================
   PAYSTACK
========================================================= */

app.use(
  "/paystack",
  paystackRoutes
);

/* =========================================================
   RECOVERY CRON
========================================================= */

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
              AND created_at >= NOW()
                - INTERVAL '7 days'
            FOR UPDATE SKIP LOCKED
            LIMIT 20
          )
          RETURNING *
        `);

      claimed =
        batch.rows;

      await client.query(
        "COMMIT"
      );
    } catch (error) {
      await client.query(
        "ROLLBACK"
      );

      console.error(
        "[CRON BATCH CLAIM ERROR]",
        error
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
          conversionCheck.rowCount > 0
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
          to:
            item.customer_email,
          incentive:
            item.incentive,
          cart:
            item.cart_data
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
      } catch (error) {
        console.error(
          `[RECOVERY EMAIL SEND ERROR] Target: ${item.customer_email}`,
          error
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

/* =========================================================
   DAILY REPORT CRON
========================================================= */

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
                AND completed_at >= NOW()
                  - INTERVAL '1 day'
            `,
            [m.site_id]
          );

        const metrics =
          stats.rows[0];

        await sendDailyReport({
          to:
            m.owner_email,

          merchantName:
            m.name,

          metrics: {
            total:
              Number(
                metrics.total
              ),

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
    } catch (error) {
      console.error(
        "[DAILY REPORT CRON FAILURE]",
        error
      );
    }
  },
  {
    timezone: "UTC"
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) =>
    res
      .status(404)
      .json(
        failure(
          "not_found"
        )
      )
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "[UNHANDLED ERROR]",
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    return res
      .status(500)
      .json(
        failure(
          "internal_error"
        )
      );
  }
);

/* =========================================================
   SERVER
========================================================= */

const PORT =
  process.env.PORT || 3000;

const server =
  app.listen(
    PORT,
    () => {
      console.log(
        `REDEN API fully hardened instance up on port ${PORT}`
      );
    }
  );

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

const shutdownHandler =
  async (signal) => {
    console.log(
      `\n[${signal}] processing teardown signal. Draining server threads.`
    );

    server.close(
      async () => {
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
        } catch (error) {
          console.error(
            "[SHUTDOWN ERROR]",
            error
          );

          process.exit(1);
        }
      }
    );
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
