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

const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL;

const ADMIN_SECRET =
  process.env.REDEN_ADMIN_SECRET ||
  process.env.ADMIN_SECRET;

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY;

if (!DATABASE_URL) {
  throw new Error(
    "Missing mandatory environment variable: DATABASE_URL"
  );
}

if (!ADMIN_SECRET) {
  throw new Error(
    "Missing mandatory environment variable: REDEN_ADMIN_SECRET or ADMIN_SECRET"
  );
}

if (!PAYSTACK_SECRET_KEY) {
  console.warn(
    "[ENV] PAYSTACK_SECRET_KEY is missing. Paystack functionality may be unavailable."
  );
}

/* =========================================================
   INITIALIZATION
========================================================= */

await initDB();

try {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id SERIAL PRIMARY KEY,
      site_id VARCHAR(100) UNIQUE NOT NULL,
      api_key VARCHAR(150) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      owner_email VARCHAR(255),
      active BOOLEAN DEFAULT true,
      plan VARCHAR(50) DEFAULT 'basic',
      subscription_status VARCHAR(50) DEFAULT 'inactive',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_sites_owner_email
    ON sites(owner_email);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_sites_owner_name
    ON sites(owner_email, name);
  `);

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_event_logs_site_created
      ON event_logs(site_id, created_at DESC);
    `);
  } catch (error) {
    console.warn(
      "[DB INDEX] event_logs index skipped:",
      error.message
    );
  }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_decisions_site_completed
      ON decisions(site_id, completed_at DESC);
    `);
  } catch (error) {
    console.warn(
      "[DB INDEX] decisions index skipped:",
      error.message
    );
  }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_email_logs_lookup
      ON email_logs(email_type, recipient, subject);
    `);
  } catch (error) {
    console.warn(
      "[DB INDEX] email_logs index skipped:",
      error.message
    );
  }

  console.log(
    "[DB INIT] REDEN database infrastructure verified."
  );
} catch (error) {
  console.error(
    "[DB INIT ERROR]",
    error
  );

  throw error;
}

await initRedis();

const app = express();

app.set("trust proxy", true);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================================================
   SECURITY
========================================================= */

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

  const isPublicCorsRoute =
    publicOrigins.some((route) =>
      req.path.startsWith(route)
    );

  if (isPublicCorsRoute) {
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
      [
        "Content-Type",
        "X-Api-Key",
        "X-Site-Id",
        "X-Request-Id",
        "X-SDK-Version"
      ].join(", ")
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

    verify: (req, res, buffer) => {
      req.rawBody = buffer.toString();
    }
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(timeout("15s"));

const haltOnTimeout = (
  req,
  res,
  next
) => {
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
   UTILITIES
========================================================= */

function validateNumber(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return 0;
  }

  const number = Number(value);

  if (
    Number.isNaN(number) ||
    !Number.isFinite(number)
  ) {
    return null;
  }

  return number;
}

function safeCompare(
  input,
  secret
) {
  if (
    typeof input !== "string" ||
    typeof secret !== "string" ||
    !input ||
    !secret
  ) {
    return false;
  }

  const inputBuffer =
    Buffer.from(input, "utf8");

  const secretBuffer =
    Buffer.from(secret, "utf8");

  if (
    inputBuffer.length !==
    secretBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    inputBuffer,
    secretBuffer
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

const isPublicAsset = (pathname) =>
  [
    "/",
    "/health",
    "/sdk.js"
  ].includes(pathname) ||
  /\.(png|jpg|jpeg|svg|css|js)$/i.test(
    pathname
  );

/* =========================================================
   ROUTE CLASSIFICATION
========================================================= */

/*
 * Public routes.
 *
 * Installation lookup is intentionally public.
 * It only returns installation metadata and never
 * returns the merchant API key.
 */

const isPublicRoute = (req) =>
  isPublicAsset(req.path) ||
  req.path === "/api/v1/verify" ||
  req.path === "/api/v1/installation" ||
  req.path.startsWith("/paystack");

/*
 * Internal PRETHIM -> REDEN routes.
 *
 * These use REDEN_ADMIN_SECRET / ADMIN_SECRET.
 *
 * IMPORTANT:
 *
 * /api/v1/intelligence does NOT use merchant
 * x-api-key authentication.
 */

const isAdminRoute = (req) =>
  req.path === "/api/v1/intelligence" ||
  req.path === "/api/v1/onboard";

/* =========================================================
   STATIC FILES
========================================================= */

app.get(
  "/sdk.js",
  (req, res) => {
    res.type(
      "application/javascript"
    );

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
   INTERNAL AUTHENTICATION
========================================================= */

async function authenticate(
  req,
  res,
  next
) {
  try {
    /*
     * PUBLIC
     */

    if (isPublicRoute(req)) {
      return next();
    }

    /*
     * INTERNAL PRETHIM -> REDEN
     */

    if (isAdminRoute(req)) {
      const suppliedSecret =
        req.headers[
          "x-admin-secret"
        ];

      if (
        typeof suppliedSecret !==
        "string"
      ) {
        console.warn(
          `[INTERNAL AUTH] Missing x-admin-secret for ${req.method} ${req.path}`
        );

        return res
          .status(401)
          .json(
            failure(
              "unauthorized_internal_access"
            )
          );
      }

      if (
        !safeCompare(
          suppliedSecret,
          ADMIN_SECRET
        )
      ) {
        console.warn(
          `[INTERNAL AUTH] Invalid internal secret for ${req.method} ${req.path}`
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
     * MERCHANT / SDK AUTHENTICATION
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

    /*
     * REDIS CACHE
     */

    if (redis) {
      try {
        const cached =
          await redis.get(cacheKey);

        if (cached) {
          req.site =
            JSON.parse(cached);

          return next();
        }
      } catch (error) {
        console.warn(
          "[AUTH REDIS READ ERROR]",
          error.message
        );
      }
    }

    /*
     * DATABASE VERIFICATION
     */

    const result =
      await db.query(
        `
          SELECT
            id,
            site_id,
            name,
            owner_email,
            active,
            plan,
            subscription_status
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

    /*
     * CACHE AUTHENTICATED SITE
     */

    if (redis) {
      try {
        await redis.set(
          cacheKey,
          JSON.stringify(
            req.site
          ),
          "EX",
          300
        );
      } catch (error) {
        console.warn(
          "[AUTH REDIS WRITE ERROR]",
          error.message
        );
      }
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

app.use(
  (req, res, next) => {
    /*
     * Public route.
     */

    if (isPublicRoute(req)) {
      return next();
    }

    /*
     * Internal route.
     */

    if (isAdminRoute(req)) {
      return next();
    }

    /*
     * Merchant route.
     */

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
  }
);

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
        redis: Boolean(redis)
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
    let database =
      "healthy";

    try {
      await db.query(
        "SELECT 1"
      );
    } catch {
      database =
        "unhealthy";
    }

    const payload =
      success({
        uptime:
          process.uptime(),

        database,

        redis:
          Boolean(redis)
      });

    if (
      database !==
      "healthy"
    ) {
      return res
        .status(503)
        .json(payload);
    }

    return res.json(
      payload
    );
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
        typeof req.body?.name ===
        "string"
          ? req.body.name.trim()
          : "";

      const ownerEmail =
        typeof req.body
          ?.owner_email ===
        "string"
          ? req.body.owner_email
              .trim()
              .toLowerCase()
          : "";

      if (
        !name ||
        !ownerEmail
      ) {
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

      if (
        existing.rowCount
      ) {
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
          try {
            await redis.del(
              `site:${site.site_id}:${site.api_key}`
            );
          } catch {}
        }

        return res
          .status(200)
          .json(
            success({
              existing: true,
              siteId:
                site.site_id,
              apiKey:
                site.api_key,
              name:
                site.name,
              plan:
                site.plan,
              subscriptionStatus:
                "active"
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
        `[ONBOARD] Created ${siteId} for ${ownerEmail}`
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
            subscriptionStatus:
              "active"
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
   INSTALLATION LOOKUP
========================================================= */

/*
 * IMPORTANT:
 *
 * This remains PUBLIC.
 *
 * The dashboard question flow should NOT depend on
 * this endpoint for intelligence.
 *
 * It returns installation metadata only.
 * It never returns api_key.
 */

app.get(
  "/api/v1/installation",
  async (req, res) => {
    try {
      const ownerEmail =
        typeof req.query
          ?.owner_email ===
        "string"
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
            WHERE LOWER(owner_email) = $1
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
              "installation_not_found"
            )
          );
      }

      const site =
        result.rows[0];

      return res.json(
        success({
          installation: {
            site_id:
              site.site_id,

            store_name:
              site.name,

            status:
              site.active
                ? "active"
                : "inactive",

            active:
              site.active,

            plan:
              site.plan,

            subscription_status:
              site.subscription_status,

            created_at:
              site.created_at
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
   INSTALLATION VERIFICATION
========================================================= */

app.get(
  "/api/v1/verify",
  async (req, res) => {
    try {
      const siteId =
        typeof req.query
          ?.siteId ===
        "string"
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

      let lastEventAt =
        null;

      try {
        const eventResult =
          await db.query(
            `
              SELECT created_at
              FROM event_logs
              WHERE site_id = $1
              ORDER BY created_at DESC
              LIMIT 1
            `,
            [siteId]
          );

        if (eventResult.rowCount) {
          lastEventAt =
            eventResult.rows[0]
              .created_at;
        }
      } catch {}

      return res.json(
        success({
          siteId:
            site.site_id,

          name:
            site.name,

          active:
            site.active,

          plan:
            site.plan,

          subscriptionStatus:
            site.subscription_status,

          connected:
            Boolean(lastEventAt),

          lastEventAt,

          createdAt:
            site.created_at
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
      /*
       * This route is ONLY accessible through
       * the internal x-admin-secret authentication.
       */

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
        typeof req.body?.siteId ===
        "string"
          ? req.body.siteId.trim()
          : "";

      const question =
        typeof req.body?.question ===
        "string"
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

      if (
        question.length >
        2000
      ) {
        return res
          .status(400)
          .json(
            failure(
              "question_too_long"
            )
          );
      }

      /* ===================================================
         VERIFY INSTALLATION
      =================================================== */

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

      /* ===================================================
         EVENT TELEMETRY
      =================================================== */

      let events = [];

      try {
        const result =
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

        events =
          result.rows.map(
            (row) => ({
              event:
                row.event,

              count:
                Number(
                  row.count
                )
            })
          );
      } catch (error) {
        console.warn(
          "[INTELLIGENCE] event telemetry unavailable:",
          error.message
        );
      }

      /* ===================================================
         DECISIONS
      =================================================== */

      let decision = {
        completed_decisions: 0,
        conversions: 0,
        revenue: 0
      };

      try {
        const result =
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

        if (result.rowCount) {
          decision =
            result.rows[0];
        }
      } catch (error) {
        console.warn(
          "[INTELLIGENCE] decision data unavailable:",
          error.message
        );
      }

      /* ===================================================
         RECOVERY
      =================================================== */

      let recovery = {
        total: 0,
        pending: 0,
        processing: 0,
        sent: 0,
        completed: 0,
        failed: 0
      };

      try {
        const result =
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

        if (result.rowCount) {
          recovery = {
            total:
              Number(
                result.rows[0]
                  .total || 0
              ),

            pending:
              Number(
                result.rows[0]
                  .pending || 0
              ),

            processing:
              Number(
                result.rows[0]
                  .processing || 0
              ),

            sent:
              Number(
                result.rows[0]
                  .sent || 0
              ),

            completed:
              Number(
                result.rows[0]
                  .completed || 0
              ),

            failed:
              Number(
                result.rows[0]
                  .failed || 0
              )
          };
        }
      } catch (error) {
        console.warn(
          "[INTELLIGENCE] recovery data unavailable:",
          error.message
        );
      }

      /* ===================================================
         EMAILS
      =================================================== */

      let emails = [];

      try {
        const result =
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

        emails =
          result.rows.map(
            (row) => ({
              type:
                row.email_type,

              status:
                row.status,

              count:
                Number(
                  row.count
                )
            })
          );
      } catch (error) {
        console.warn(
          "[INTELLIGENCE] email data unavailable:",
          error.message
        );
      }

      /* ===================================================
         NORMALIZED METRICS
      =================================================== */

      const completedDecisions =
        Number(
          decision.completed_decisions ||
            0
        );

      const conversions =
        Number(
          decision.conversions ||
            0
        );

      const revenue =
        Number(
          decision.revenue ||
            0
        );

      const conversionRate =
        completedDecisions >
        0
          ? Number(
              (
                (
                  conversions /
                  completedDecisions
                ) *
                100
              ).toFixed(2)
            )
          : 0;

      const eventCount = (
        eventName
      ) =>
        events.find(
          (item) =>
            item.event ===
            eventName
        )?.count || 0;

      const pageViews =
        eventCount(
          "PAGE_VIEW"
        );

      const productViews =
        eventCount(
          "PRODUCT_VIEW"
        );

      const addToCart =
        eventCount(
          "ADD_TO_CART"
        );

      const checkoutStarted =
        eventCount(
          "CHECKOUT_STARTED"
        );

      const purchases =
        eventCount(
          "PURCHASE"
        );

      /* ===================================================
         QUESTION UNDERSTANDING
      =================================================== */

      const q =
        question
          .toLowerCase()
          .replace(
            /[?!.,]/g,
            " "
          )
          .replace(
            /\s+/g,
            " "
          )
          .trim();

      /*
       * REDEN IS A BUSINESS INTELLIGENCE ENGINE.
       *
       * It must not answer unrelated/general questions.
       */

      const businessTerms = [
        "performance",
        "today",
        "yesterday",
        "happening",
        "overview",
        "summary",
        "conversion",
        "convert",
        "converting",
        "revenue",
        "sales",
        "money",
        "earned",
        "income",
        "traffic",
        "visitor",
        "visitors",
        "views",
        "view",
        "page",
        "pages",
        "product",
        "products",
        "cart",
        "checkout",
        "abandon",
        "abandoned",
        "purchase",
        "purchases",
        "customer",
        "customers",
        "buyer",
        "buyers",
        "recovery",
        "recover",
        "email",
        "emails",
        "mail",
        "decision",
        "decisions",
        "discount",
        "incentive",
        "funnel",
        "store",
        "shop",
        "merchant",
        "business",
        "order",
        "orders",
        "activity",
        "analytics",
        "metric",
        "metrics",
        "reden"
      ];

      const hasBusinessIntent =
        businessTerms.some(
          (term) =>
            q.includes(term)
        );

      let answer = "";

      /* ===================================================
         NON-BUSINESS / ABSTRACT
      =================================================== */

      if (!hasBusinessIntent) {
        answer =
          "Sorry, I can only answer questions related to your business. " +
          "Ask me about performance, sales, revenue, conversions, " +
          "traffic, customers, checkout activity, cart abandonment, " +
          "recovery, email activity, or REDEN decisions.";
      }

      /* ===================================================
         PERFORMANCE
      =================================================== */

      else if (
        q.includes(
          "performance"
        ) ||
        q.includes(
          "today"
        ) ||
        q.includes(
          "happening"
        ) ||
        q.includes(
          "overview"
        ) ||
        q.includes(
          "summary"
        )
      ) {
        answer =
          `For ${site.name}, over the last 24 hours, REDEN recorded ` +
          `${completedDecisions} completed decisions, ` +
          `${conversions} conversions, and ` +
          `${revenue} in attributed revenue. ` +
          `The decision conversion rate is ` +
          `${conversionRate}%. ` +
          `Storefront activity includes ` +
          `${pageViews} page views, ` +
          `${productViews} product views, ` +
          `${addToCart} add-to-cart events, ` +
          `${checkoutStarted} checkout starts, ` +
          `and ${purchases} purchases.`;
      }

      /* ===================================================
         CONVERSION
      =================================================== */

      else if (
        q.includes(
          "conversion"
        ) ||
        q.includes(
          "convert"
        ) ||
        q.includes(
          "converting"
        )
      ) {
        answer =
          `REDEN recorded ${conversions} conversions from ` +
          `${completedDecisions} completed decisions in the last 24 hours. ` +
          `That gives a conversion rate of ` +
          `${conversionRate}%. ` +
          `Attributed revenue is ${revenue}.`;
      }

      /* ===================================================
         REVENUE / SALES
      =================================================== */

      else if (
        q.includes(
          "revenue"
        ) ||
        q.includes(
          "sales"
        ) ||
        q.includes(
          "money"
        ) ||
        q.includes(
          "earned"
        ) ||
        q.includes(
          "income"
        )
      ) {
        answer =
          `REDEN currently attributes ${revenue} in revenue ` +
          `to completed decisions over the last 24 hours. ` +
          `There were ${conversions} conversions from ` +
          `${completedDecisions} completed decisions.`;
      }

      /* ===================================================
         CHECKOUT / CART / ABANDONMENT
      =================================================== */

      else if (
        q.includes(
          "abandon"
        ) ||
        q.includes(
          "checkout"
        ) ||
        q.includes(
          "cart"
        )
      ) {
        const checkoutGap =
          Math.max(
            0,
            checkoutStarted -
              purchases
          );

        answer =
          `REDEN recorded ${checkoutStarted} checkout starts and ` +
          `${purchases} purchases in the last 24 hours. ` +
          `The observed checkout-to-purchase gap is ` +
          `${checkoutGap}. ` +
          `The recovery queue currently contains ` +
          `${recovery.pending} pending, ` +
          `${recovery.processing} processing, ` +
          `${recovery.sent} sent, ` +
          `${recovery.completed} completed, and ` +
          `${recovery.failed} failed records.`;
      }

      /* ===================================================
         RECOVERY
      =================================================== */

      else if (
        q.includes(
          "recovery"
        ) ||
        q.includes(
          "recover"
        )
      ) {
        answer =
          `REDEN's recovery activity over the last 24 hours is ` +
          `${recovery.pending} pending, ` +
          `${recovery.processing} processing, ` +
          `${recovery.sent} sent, ` +
          `${recovery.completed} completed, and ` +
          `${recovery.failed} failed. ` +
          `There are ${recovery.total} recovery records in the period.`;
      }

      /* ===================================================
         EMAIL
      =================================================== */

      else if (
        q.includes(
          "email"
        ) ||
        q.includes(
          "emails"
        ) ||
        q.includes(
          "mail"
        )
      ) {
        const totalEmails =
          emails.reduce(
            (sum, item) =>
              sum +
              Number(
                item.count ||
                  0
              ),
            0
          );

        answer =
          `REDEN recorded ${totalEmails} email operations ` +
          `over the last 24 hours.`;
      }

      /* ===================================================
         TRAFFIC
      =================================================== */

      else if (
        q.includes(
          "traffic"
        ) ||
        q.includes(
          "visitor"
        ) ||
        q.includes(
          "visitors"
        ) ||
        q.includes(
          "views"
        ) ||
        q.includes(
          "view"
        ) ||
        q.includes(
          "page"
        )
      ) {
        answer =
          `In the last 24 hours, REDEN recorded ` +
          `${pageViews} page views and ` +
          `${productViews} product views. ` +
          `There were also ${addToCart} add-to-cart events, ` +
          `${checkoutStarted} checkout starts, and ` +
          `${purchases} purchase events.`;
      }

      /* ===================================================
         PURCHASES / ORDERS
      =================================================== */

      else if (
        q.includes(
          "purchase"
        ) ||
        q.includes(
          "purchases"
        ) ||
        q.includes(
          "order"
        ) ||
        q.includes(
          "orders"
        )
      ) {
        answer =
          `REDEN recorded ${purchases} purchase events in the last ` +
          `24 hours. There were ${conversions} conversions from ` +
          `${completedDecisions} completed decisions.`;
      }

      /* ===================================================
         DECISIONS
      =================================================== */

      else if (
        q.includes(
          "decision"
        ) ||
        q.includes(
          "decisions"
        )
      ) {
        answer =
          `REDEN completed ${completedDecisions} decisions over the ` +
          `last 24 hours. ${conversions} converted, producing a ` +
          `${conversionRate}% decision conversion rate and ` +
          `${revenue} in attributed revenue.`;
      }

      /* ===================================================
         CUSTOMER / STORE ACTIVITY
      =================================================== */

      else if (
        q.includes(
          "customer"
        ) ||
        q.includes(
          "customers"
        ) ||
        q.includes(
          "buyer"
        ) ||
        q.includes(
          "buyers"
        ) ||
        q.includes(
          "store"
        ) ||
        q.includes(
          "business"
        )
      ) {
        answer =
          `${site.name} recorded ${pageViews} page views, ` +
          `${productViews} product views, ${addToCart} add-to-cart events, ` +
          `${checkoutStarted} checkout starts, and ${purchases} purchases ` +
          `over the last 24 hours. REDEN recorded ${conversions} conversions ` +
          `and ${revenue} in attributed revenue.`;
      }

      /* ===================================================
         BUSINESS FALLBACK
      =================================================== */

      else {
        answer =
          `REDEN is monitoring ${site.name}. ` +
          `Over the last 24 hours there were ` +
          `${pageViews} page views, ` +
          `${productViews} product views, ` +
          `${addToCart} add-to-cart events, ` +
          `${checkoutStarted} checkout starts, ` +
          `${purchases} purchases, ` +
          `${conversions} conversions, and ` +
          `${revenue} in attributed revenue.`;
      }

      /* ===================================================
         RESPONSE
      =================================================== */

      return res.json(
        success({
          answer,

          site: {
            siteId:
              site.site_id,

            name:
              site.name,

            plan:
              site.plan,

            subscriptionStatus:
              site.subscription_status
          },

          evidence: {
            period:
              "last_24_hours",

            events,

            decisions: {
              completed:
                completedDecisions,

              conversions,

              conversionRate,

              revenue
            },

            recovery,

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
   EVENT TELEMETRY
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

      if (
        !session_id ||
        !event
      ) {
        return res
          .status(400)
          .json(
            failure(
              "missing_fields"
            )
          );
      }

      const normalizedEvent =
        String(event)
          .toUpperCase();

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
          payload?.cart ||
            {}
        );

      if (
        Buffer.byteLength(
          safePayload
        ) > 50000 ||
        Buffer.byteLength(
          safeCart
        ) > 20000
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
          req.headers[
            "user-agent"
          ]
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
          event_id:
            safeEventId
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
        (
          await pickAction({
            session_id,
            cart_value:
              value,
            behavior:
              payload || {}
          })
        ) ||
        "NONE";

      const discountMap = {
        NONE: 0,
        INCENTIVE_LOW: 5,
        INCENTIVE_MED: 10,
        INCENTIVE_HIGH: 20
      };

      const discount =
        discountMap[action] ||
        0;

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
            cart_id ||
              null,
            action,
            discount,
            Math.max(
              0,
              value -
                discount
            )
          ]
        );

      return res.json(
        success({
          decision_id:
            result.rows[0]
              .id,

          action,

          discount,

          propensity_score:
            payload?.scroll_depth
              ? payload.scroll_depth /
                100
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

      const result =
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

      if (!result.rowCount) {
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
        existing.rows[0]
          .state ===
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
          Boolean(
            converted
          ),
          revenueValue || 0,
          decision_id,
          req.site.site_id
        ]
      );

      await updateBandit(
        existing.rows[0]
          .action,
        Boolean(
          converted
        )
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
      const result =
        await db.query(
          `
            SELECT
              COUNT(*) AS total,

              COUNT(*) FILTER (
                WHERE converted = true
              ) AS conversions,

              COALESCE(
                SUM(revenue),
                0
              ) AS revenue

            FROM decisions

            WHERE site_id = $1
              AND state = 'COMPLETED'
          `,
          [req.site.site_id]
        );

      const row =
        result.rows[0];

      return res.json(
        success({
          total:
            Number(
              row.total ||
                0
            ),

          conversions:
            Number(
              row.conversions ||
                0
            ),

          revenue:
            Number(
              row.revenue ||
                0
            )
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
      typeof db.connect !==
        "function"
    ) {
      return;
    }

    let client;

    try {
      client =
        await db.connect();

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

      await client.query(
        "COMMIT"
      );

      for (
        const item of
          batch.rows
      ) {
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
            conversionCheck.rowCount
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
            "[RECOVERY EMAIL ERROR]",
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
    } catch (error) {
      try {
        if (client) {
          await client.query(
            "ROLLBACK"
          );
        }
      } catch {}

      console.error(
        "[RECOVERY CRON ERROR]",
        error
      );
    } finally {
      if (client) {
        client.release();
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
    try {
      if (redis) {
        const date =
          new Date()
            .toISOString()
            .split("T")[0];

        const lockKey =
          `lock:cron:daily_report:${date}`;

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

      const merchants =
        await db.query(
          `
            SELECT *
            FROM sites
            WHERE active = true
          `
        );

      for (
        const merchant of
          merchants.rows
      ) {
        if (
          !merchant.owner_email
        ) {
          continue;
        }

        const stats =
          await db.query(
            `
              SELECT
                COUNT(*) AS total,

                COUNT(*) FILTER (
                  WHERE converted = true
                ) AS conversions,

                COALESCE(
                  SUM(revenue),
                  0
                ) AS revenue

              FROM decisions

              WHERE site_id = $1
                AND state = 'COMPLETED'
                AND completed_at >= NOW()
                  - INTERVAL '1 day'
            `,
            [
              merchant.site_id
            ]
          );

        const metrics =
          stats.rows[0];

        await sendDailyReport({
          to:
            merchant.owner_email,

          merchantName:
            merchant.name,

          metrics: {
            total:
              Number(
                metrics.total ||
                  0
              ),

            conversions:
              Number(
                metrics.conversions ||
                  0
              ),

            revenue:
              Number(
                metrics.revenue ||
                  0
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
            merchant.site_id,
            merchant.owner_email
          ]
        );
      }
    } catch (error) {
      console.error(
        "[DAILY REPORT CRON ERROR]",
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
  (req, res) => {
    return res
      .status(404)
      .json(
        failure(
          "not_found"
        )
      );
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "[UNHANDLED ERROR]",
      error
    );

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

const server =
  app.listen(
    PORT,
    () => {
      console.log(
        `REDEN API running on port ${PORT}`
      );

      console.log(
        `[REDEN] Internal intelligence authentication: ENABLED`
      );

      console.log(
        `[REDEN] Installation lookup: ENABLED`
      );

      console.log(
        `[REDEN] Dashboard intelligence: ENABLED`
      );
    }
  );

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

const shutdownHandler =
  async (signal) => {
    console.log(
      `[${signal}] REDEN shutting down...`
    );

    server.close(
      async () => {
        try {
          if (
            db &&
            typeof db.end ===
              "function"
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
    shutdownHandler(
      "SIGINT"
    )
);

process.on(
  "SIGTERM",
  () =>
    shutdownHandler(
      "SIGTERM"
    )
);
