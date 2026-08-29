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
  updateSessionContext
} from "../optimization/contextEngine.js";

import {
  initRedis,
  redis
} from "../infrastructure/redis.js";

import {
  sendDailyReport,
  sendRecoveryEmail
} from "../notification/emailEngine.js";

dotenv.config();

/* =========================================================
   ENVIRONMENT
========================================================= */

const PORT = process.env.PORT || 3000;

const DATABASE_URL =
  process.env.DATABASE_URL;

const ADMIN_SECRET =
  process.env.REDEN_ADMIN_SECRET ||
  process.env.ADMIN_SECRET;

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

  /*
   * Best-effort event deduplication index.
   *
   * If old duplicate data prevents creation, REDEN continues
   * operating and logs the reason.
   */
  try {
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      idx_event_logs_site_event_id
      ON event_logs(site_id, event_id);
    `);
  } catch (error) {
    console.warn(
      "[DB INDEX] event_id uniqueness index skipped:",
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

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_recovery_site_status
      ON recovery_queue(site_id, status, created_at DESC);
    `);
  } catch (error) {
    console.warn(
      "[DB INDEX] recovery index skipped:",
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

/*
 * REDEN is normally deployed behind one trusted reverse proxy
 * such as Render's proxy.
 */
app.set(
  "trust proxy",
  Number(
    process.env.TRUST_PROXY_HOPS || 1
  )
);

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

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

app.use(
  (req, res, next) => {
    const publicCorsRoutes = [
      "/event",
      "/score",
      "/action",
      "/outcome",
      "/sdk.js",
      "/api/v1/verify"
    ];

    const isPublicCorsRoute =
      publicCorsRoutes.some(
        (route) =>
          req.path === route ||
          req.path.startsWith(`${route}/`)
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

      res.setHeader(
        "Access-Control-Max-Age",
        "600"
      );
    }

    if (req.method === "OPTIONS") {
      if (isPublicCorsRoute) {
        return res.sendStatus(204);
      }

      return res.sendStatus(403);
    }

    next();
  }
);

/* =========================================================
   RATE LIMITING
========================================================= */

const generalLimiter =
  rateLimit({
    windowMs: 60 * 1000,

    max: 120,

    standardHeaders: true,

    legacyHeaders: false,

    message: {
      ok: false,
      error: "rate_limit_exceeded"
    }
  });

const telemetryLimiter =
  rateLimit({
    windowMs: 60 * 1000,

    max: 1000,

    keyGenerator: (req) => {
      const siteId =
        typeof req.headers[
          "x-site-id"
        ] === "string"
          ? req.headers[
              "x-site-id"
            ].trim()
          : "anonymous";

      return `${siteId}:${req.ip}`;
    },

    standardHeaders: true,

    legacyHeaders: false,

    message: {
      ok: false,
      error:
        "tenant_rate_limit_exceeded"
    }
  });

app.use(
  "/event",
  telemetryLimiter
);

app.use(
  generalLimiter
);

/* =========================================================
   BODY PARSING
========================================================= */

app.use(
  express.json({
    limit: "100kb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "100kb"
  })
);

app.use(
  timeout("15s")
);

const haltOnTimeout =
  (req, res, next) => {
    if (req.timedout) {
      return;
    }

    next();
  };

app.use(
  haltOnTimeout
);

/* =========================================================
   RESPONSE HELPERS
========================================================= */

const success =
  (data = {}) => ({
    ok: true,

    timestamp:
      new Date().toISOString(),

    ...data
  });

const failure =
  (
    error,
    details = null
  ) => ({
    ok: false,

    error,

    details,

    timestamp:
      new Date().toISOString()
  });

/* =========================================================
   UTILITIES
========================================================= */

function validateNumber(
  value,
  {
    defaultValue = 0,
    allowNull = false
  } = {}
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    if (allowNull) {
      return null;
    }

    return defaultValue;
  }

  const number =
    Number(value);

  if (
    Number.isNaN(number) ||
    !Number.isFinite(number)
  ) {
    return null;
  }

  if (number < 0) {
    return null;
  }

  return number;
}

function normalizeBoolean(
  value
) {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    (
      typeof value === "string" &&
      value.toLowerCase() === "true"
    )
  );
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
    Buffer.from(
      input,
      "utf8"
    );

  const secretBuffer =
    Buffer.from(
      secret,
      "utf8"
    );

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

function normalizeString(
  value,
  maxLength
) {
  if (
    typeof value !==
    "string"
  ) {
    return "";
  }

  const normalized =
    value.trim();

  if (
    normalized.length >
    maxLength
  ) {
    return "";
  }

  return normalized;
}

function normalizeEmail(
  value
) {
  if (
    typeof value !==
    "string"
  ) {
    return "";
  }

  const email =
    value
      .trim()
      .toLowerCase();

  if (
    email.length < 3 ||
    email.length > 255
  ) {
    return "";
  }

  /*
   * Deliberately simple validation.
   * Final delivery validation belongs to the email provider.
   */
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      email
    )
  ) {
    return "";
  }

  return email;
}

function hashAuthKey(
  siteId,
  apiKey
) {
  return crypto
    .createHash("sha256")
    .update(
      `${siteId}:${apiKey}`,
      "utf8"
    )
    .digest("hex");
}

const VALID_EVENTS =
  new Set([
    "PAGE_VIEW",
    "PRODUCT_VIEW",
    "ADD_TO_CART",
    "CHECKOUT_STARTED",
    "PURCHASE",
    "SESSION_START",
    "SESSION_END",
    "BEHAVIOR"
  ]);

const isPublicAsset =
  (pathname) => {
    if (
      pathname === "/" ||
      pathname === "/health" ||
      pathname === "/sdk.js"
    ) {
      return true;
    }

    /*
     * Static assets are public, but API routes are never
     * classified as public merely because they end in .js/.css/etc.
     */
    if (
      pathname.startsWith("/api/")
    ) {
      return false;
    }

    return (
      /\.(png|jpg|jpeg|svg|css|js|ico|webp|woff|woff2|ttf)$/i.test(
        pathname
      )
    );
  };

/* =========================================================
   ROUTE CLASSIFICATION
========================================================= */

const isPublicRoute =
  (req) =>
    isPublicAsset(
      req.path
    ) ||
    req.path ===
      "/api/v1/verify";

const isAdminRoute =
  (req) =>
    req.path ===
      "/api/v1/intelligence" ||
    req.path ===
      "/api/v1/onboard" ||
    req.path ===
      "/api/v1/installation";

/* =========================================================
   STATIC FILES
========================================================= */

app.get(
  "/sdk.js",
  (req, res) => {
    res.type(
      "application/javascript"
    );

    return res.sendFile(
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
     * PUBLIC ROUTES
     */

    if (
      isPublicRoute(req)
    ) {
      return next();
    }

    /*
     * INTERNAL PRETHIM -> REDEN
     *
     * Intelligence, onboarding and installation lookup
     * require the REDEN admin secret.
     */
    if (
      isAdminRoute(req)
    ) {
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

      req.isAdminRoute =
        true;

      return next();
    }

    /*
     * MERCHANT / SDK AUTHENTICATION
     */

    const apiKey =
      typeof req.headers[
        "x-api-key"
      ] === "string"
        ? req.headers[
            "x-api-key"
          ]
        : req.body?.api_key;

    const siteId =
      typeof req.headers[
        "x-site-id"
      ] === "string"
        ? req.headers[
            "x-site-id"
          ]
        : req.body?.site_id;

    if (
      typeof apiKey !==
        "string" ||
      typeof siteId !==
        "string"
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

    if (
      !normalizedApiKey ||
      !normalizedSiteId ||
      normalizedApiKey.length >
        150 ||
      normalizedSiteId.length >
        100
    ) {
      return res
        .status(401)
        .json(
          failure(
            "invalid_credentials"
          )
        );
    }

    const cacheKey =
      `site_auth:${hashAuthKey(
        normalizedSiteId,
        normalizedApiKey
      )}`;

    /*
     * REDIS CACHE
     *
     * Short TTL prevents a recently-deactivated site from
     * remaining authorized for several minutes.
     */
    if (redis) {
      try {
        const cached =
          await redis.get(
            cacheKey
          );

        if (cached) {
          req.site =
            JSON.parse(
              cached
            );

          if (
            req.site?.active ===
            true
          ) {
            return next();
          }
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

    if (
      !result.rowCount
    ) {
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
     * Cache authenticated site context.
     *
     * 60 seconds instead of 300 seconds.
     */
    if (redis) {
      try {
        await redis.set(
          cacheKey,
          JSON.stringify(
            req.site
          ),
          "EX",
          60
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

app.use(
  authenticate
);

/* =========================================================
   SITE CONTEXT
========================================================= */

app.use(
  (req, res, next) => {
    if (
      isPublicRoute(req)
    ) {
      return next();
    }

    if (
      isAdminRoute(req)
    ) {
      return next();
    }

    if (
      !req.site?.site_id
    ) {
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

app.use(
  haltOnTimeout
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {
    return res.json(
      success({
        service:
          "REDEN API",

        status:
          "operational",

        redis:
          Boolean(redis)
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
    let client;

    try {
      if (
        !req.isAdminRoute
      ) {
        return res
          .status(401)
          .json(
            failure(
              "unauthorized_internal_access"
            )
          );
      }

      const name =
        normalizeString(
          req.body?.name,
          255
        );

      const ownerEmail =
        normalizeEmail(
          req.body?.owner_email
        );

      if (
        !name ||
        !ownerEmail
      ) {
        return res
          .status(400)
          .json(
            failure(
              "missing_or_invalid_fields",
              {
                required: [
                  "name",
                  "owner_email"
                ]
              }
            )
          );
      }

      client =
        await db.connect();

      await client.query(
        "BEGIN"
      );

      /*
       * Prevent two simultaneous onboarding requests for the
       * same merchant/store from creating two sites.
       */
      await client.query(
        `
          SELECT
            pg_advisory_xact_lock(
              hashtext($1)
            )
        `,
        [
          `reden:onboard:${ownerEmail}:${name.toLowerCase()}`
        ]
      );

      const existing =
        await client.query(
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

        /*
         * Do NOT silently reactivate an inactive site.
         *
         * Inactive subscription/account state must be changed
         * through the appropriate billing/account flow.
         */
        await client.query(
          "COMMIT"
        );

        client.release();
        client = null;

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
                site.subscription_status,

              active:
                site.active
            })
          );
      }

      const siteId =
        `site_${crypto
          .randomBytes(8)
          .toString("hex")}`;

      const apiKey =
        `rd_${crypto
          .randomBytes(24)
          .toString("hex")}`;

      await client.query(
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

      await client.query(
        "COMMIT"
      );

      client.release();
      client = null;

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

            plan:
              "basic",

            subscriptionStatus:
              "active"
          })
        );
    } catch (error) {
      try {
        if (client) {
          await client.query(
            "ROLLBACK"
          );
        }
      } catch {}

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
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

/* =========================================================
   INSTALLATION LOOKUP
========================================================= */

app.get(
  "/api/v1/installation",
  async (req, res) => {
    try {
      if (
        !req.isAdminRoute
      ) {
        return res
          .status(401)
          .json(
            failure(
              "unauthorized_internal_access"
            )
          );
      }

      const ownerEmail =
        normalizeEmail(
          req.query?.owner_email
        );

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
          [
            ownerEmail
          ]
        );

      if (
        !result.rowCount
      ) {
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
        normalizeString(
          req.query?.siteId,
          100
        );

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
          [
            siteId
          ]
        );

      if (
        !result.rowCount
      ) {
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
            [
              siteId
            ]
          );

        if (
          eventResult.rowCount
        ) {
          lastEventAt =
            eventResult.rows[0]
              .created_at;
        }
      } catch (error) {
        console.warn(
          "[VERIFY] Could not read last event:",
          error.message
        );
      }

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
      if (
        !req.isAdminRoute
      ) {
        return res
          .status(401)
          .json(
            failure(
              "unauthorized_internal_access"
            )
          );
      }

      const siteId =
        normalizeString(
          req.body?.siteId,
          100
        );

      const question =
        normalizeString(
          req.body?.question,
          2000
        );

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

      /* ===================================================
         SITE
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
          [
            siteId
          ]
        );

      if (
        !siteResult.rowCount
      ) {
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
            [
              siteId
            ]
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
         UNIQUE VISITORS / SESSIONS
      =================================================== */

      let uniqueVisitors = 0;

      try {
        const result =
          await db.query(
            `
              SELECT
                COUNT(
                  DISTINCT session_id
                )::int AS visitors
              FROM event_logs
              WHERE site_id = $1
                AND created_at >= NOW()
                  - INTERVAL '24 hours'
            `,
            [
              siteId
            ]
          );

        if (
          result.rowCount
        ) {
          uniqueVisitors =
            Number(
              result.rows[0]
                .visitors || 0
            );
        }
      } catch (error) {
        console.warn(
          "[INTELLIGENCE] visitor count unavailable:",
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
            [
              siteId
            ]
          );

        if (
          result.rowCount
        ) {
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
            [
              siteId
            ]
          );

        if (
          result.rowCount
        ) {
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
            [
              siteId
            ]
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
        completedDecisions > 0
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

      const eventCount =
        (eventName) =>
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
         BRAIN HELPERS
      =================================================== */

      const q =
        question
          .toLowerCase()
          .replace(
            /[?!.,;:]+/g,
            " "
          )
          .replace(
            /\s+/g,
            " "
          )
          .trim();

      const hasAny =
        (phrases) =>
          phrases.some(
            (phrase) =>
              q.includes(
                phrase
              )
          );

      const money =
        new Intl.NumberFormat(
          "en-NG",
          {
            maximumFractionDigits: 2
          }
        ).format(
          revenue
        );

      const formatNumber =
        (value) =>
          new Intl.NumberFormat(
            "en-NG"
          ).format(
            Number(
              value || 0
            )
          );

      const checkoutGap =
        Math.max(
          0,
          checkoutStarted -
            purchases
        );

      const totalEmails =
        emails.reduce(
          (sum, item) =>
            sum +
            Number(
              item.count || 0
            ),
          0
        );

      /* ===================================================
         QUESTION UNDERSTANDING
      =================================================== */

      let answer = "";

      /*
       * IDENTITY / BUSINESS UNDERSTANDING
       */

      if (
        hasAny([
          "what do you think i do",
          "what do i do",
          "what is my business",
          "what kind of business",
          "what business am i in",
          "what do you know about my business",
          "what does my business do"
        ])
      ) {
        answer =
          `Based on the activity REDEN monitors, ` +
          `${site.name} operates as an online storefront or digital business. ` +
          `REDEN currently monitors its visitor activity, product interest, ` +
          `cart activity, checkout behavior, purchases, decisions, ` +
          `conversions and attributed revenue. ` +
          `I can use those signals to help you understand how the business is performing.`;
      }

      /*
       * REVENUE
       */

      else if (
        hasAny([
          "how much did i earn",
          "how much have i earned",
          "how much money did i make",
          "how much money have i made",
          "how much did i make",
          "how much have i made",
          "what did i earn",
          "what have i earned",
          "what did i make",
          "what have i made",
          "how much revenue",
          "what is my revenue",
          "whats my revenue",
          "revenue",
          "earnings",
          "money made",
          "money earned",
          "sales revenue",
          "income",
          "how much did we earn",
          "how much did we make",
          "how much have we made",
          "how much have we earned"
        ])
      ) {
        answer =
          `Over the last 24 hours, REDEN attributes ` +
          `${money} in revenue to completed decisions for ${site.name}. ` +
          `There were ${formatNumber(conversions)} conversions ` +
          `from ${formatNumber(completedDecisions)} completed decisions.`;
      }

      /*
       * TRAFFIC / VISITORS
       */

      else if (
        hasAny([
          "how many people entered",
          "how many people came",
          "how many people visited",
          "how many visitors",
          "how many users visited",
          "how many users came",
          "how many people came to my site",
          "how many people entered my site",
          "how many people visited my site",
          "how many visitors did i get",
          "how many visitors do i have",
          "how many visitors came",
          "how many people viewed my site",
          "how many people saw my site",
          "how much traffic",
          "what is my traffic",
          "whats my traffic",
          "site traffic",
          "visitors",
          "visitor count",
          "people on my site",
          "people visited",
          "traffic"
        ])
      ) {
        answer =
          `Over the last 24 hours, REDEN recorded approximately ` +
          `${formatNumber(uniqueVisitors)} unique sessions on ${site.name}. ` +
          `There were ${formatNumber(pageViews)} page views, ` +
          `${formatNumber(productViews)} product views, ` +
          `${formatNumber(addToCart)} add-to-cart events, ` +
          `${formatNumber(checkoutStarted)} checkout starts, ` +
          `and ${formatNumber(purchases)} purchase events.`;
      }

      /*
       * PURCHASES / ORDERS
       */

      else if (
        hasAny([
          "did anyone buy",
          "did anybody buy",
          "did someone buy",
          "did anyone purchase",
          "did anybody purchase",
          "how many people bought",
          "how many people purchased",
          "how many purchases",
          "how many orders",
          "how many sales did i make",
          "how many sales did we make",
          "how many customers bought",
          "how many customers purchased",
          "did i make any sales",
          "did we make any sales",
          "any sales",
          "any purchases",
          "any orders",
          "people bought",
          "customers bought",
          "purchases"
        ])
      ) {
        answer =
          `REDEN recorded ${formatNumber(purchases)} purchase events ` +
          `over the last 24 hours. ` +
          `There were ${formatNumber(conversions)} conversions ` +
          `attributed to completed REDEN decisions.`;
      }

      /*
       * CONVERSION
       */

      else if (
        hasAny([
          "conversion rate",
          "convert",
          "converted",
          "conversions",
          "how many converted",
          "how many customers converted",
          "how many people converted",
          "are people converting",
          "did people convert",
          "conversion"
        ])
      ) {
        answer =
          `REDEN recorded ${formatNumber(conversions)} conversions ` +
          `from ${formatNumber(completedDecisions)} completed decisions ` +
          `over the last 24 hours. ` +
          `The decision conversion rate is ${conversionRate}%. ` +
          `Attributed revenue is ${money}.`;
      }

      /*
       * SALES
       */

      else if (
        hasAny([
          "how are sales",
          "how is sales",
          "how are my sales",
          "how is my sales",
          "sales doing",
          "how is business",
          "how's business",
          "how is the business",
          "how is my business",
          "business doing",
          "are sales good",
          "sales performance",
          "sales"
        ])
      ) {
        answer =
          `Over the last 24 hours, ${site.name} recorded ` +
          `${formatNumber(purchases)} purchases, ` +
          `${formatNumber(conversions)} REDEN-attributed conversions, ` +
          `and ${money} in attributed revenue. ` +
          `The decision conversion rate is ${conversionRate}%.`;
      }

      /*
       * CHECKOUT / CART
       */

      else if (
        hasAny([
          "abandon",
          "abandoned",
          "abandonment",
          "left my cart",
          "left their cart",
          "left the cart",
          "lost carts",
          "lost cart",
          "cart abandonment",
          "checkout abandonment",
          "checkout",
          "cart"
        ])
      ) {
        answer =
          `REDEN recorded ${formatNumber(checkoutStarted)} checkout starts ` +
          `and ${formatNumber(purchases)} purchase events over the last 24 hours. ` +
          `The observed checkout-to-purchase event gap is ${formatNumber(checkoutGap)}. ` +
          `The recovery queue currently contains ` +
          `${formatNumber(recovery.pending)} pending, ` +
          `${formatNumber(recovery.processing)} processing, ` +
          `${formatNumber(recovery.sent)} sent, ` +
          `${formatNumber(recovery.completed)} completed, ` +
          `and ${formatNumber(recovery.failed)} failed records.`;
      }

      /*
       * RECOVERY
       */

      else if (
        hasAny([
          "recovery",
          "recover",
          "recoveries",
          "recovered customers",
          "recover customers",
          "recovery emails",
          "recovery email"
        ])
      ) {
        answer =
          `REDEN's recovery activity over the last 24 hours is ` +
          `${formatNumber(recovery.pending)} pending, ` +
          `${formatNumber(recovery.processing)} processing, ` +
          `${formatNumber(recovery.sent)} sent, ` +
          `${formatNumber(recovery.completed)} completed, ` +
          `and ${formatNumber(recovery.failed)} failed. ` +
          `There are ${formatNumber(recovery.total)} recovery records in the period.`;
      }

      /*
       * EMAIL
       */

      else if (
        hasAny([
          "email",
          "emails",
          "mail",
          "email activity",
          "email performance"
        ])
      ) {
        answer =
          `REDEN recorded ${formatNumber(totalEmails)} email operations ` +
          `over the last 24 hours.`;
      }

      /*
       * PRODUCT INTEREST
       */

      else if (
        hasAny([
          "product views",
          "products viewed",
          "people viewing products",
          "people viewed products",
          "product interest",
          "interested in products",
          "product activity"
        ])
      ) {
        answer =
          `REDEN recorded ${formatNumber(productViews)} product views ` +
          `over the last 24 hours. ` +
          `There were also ${formatNumber(addToCart)} add-to-cart events ` +
          `and ${formatNumber(purchases)} purchase events.`;
      }

      /*
       * PERFORMANCE / OVERVIEW
       */

      else if (
        hasAny([
          "performance",
          "how am i doing",
          "how are we doing",
          "how is everything",
          "what is happening",
          "what happened",
          "what's happening",
          "whats happening",
          "give me an overview",
          "give me a summary",
          "summary",
          "overview",
          "today",
          "store doing",
          "store performance",
          "business performance"
        ])
      ) {
        answer =
          `For ${site.name}, over the last 24 hours, REDEN recorded ` +
          `${formatNumber(completedDecisions)} completed decisions, ` +
          `${formatNumber(conversions)} conversions, and ` +
          `${money} in attributed revenue. ` +
          `The decision conversion rate is ${conversionRate}%. ` +
          `Storefront activity includes ` +
          `${formatNumber(uniqueVisitors)} unique sessions, ` +
          `${formatNumber(pageViews)} page views, ` +
          `${formatNumber(productViews)} product views, ` +
          `${formatNumber(addToCart)} add-to-cart events, ` +
          `${formatNumber(checkoutStarted)} checkout starts, ` +
          `and ${formatNumber(purchases)} purchase events.`;
      }

      /*
       * FUNNEL
       */

      else if (
        hasAny([
          "funnel",
          "customer journey",
          "journey",
          "where are customers dropping",
          "where are people dropping",
          "where do people drop",
          "where do customers drop"
        ])
      ) {
        answer =
          `The current 24-hour event funnel for ${site.name} is ` +
          `${formatNumber(pageViews)} page views → ` +
          `${formatNumber(productViews)} product views → ` +
          `${formatNumber(addToCart)} add-to-cart events → ` +
          `${formatNumber(checkoutStarted)} checkout starts → ` +
          `${formatNumber(purchases)} purchase events.`;
      }

      /*
       * FALLBACK
       */

      else {
        answer =
          `REDEN is monitoring ${site.name}. ` +
          `Over the last 24 hours there were ` +
          `${formatNumber(uniqueVisitors)} unique sessions, ` +
          `${formatNumber(pageViews)} page views, ` +
          `${formatNumber(productViews)} product views, ` +
          `${formatNumber(addToCart)} add-to-cart events, ` +
          `${formatNumber(checkoutStarted)} checkout starts, ` +
          `${formatNumber(purchases)} purchase events, ` +
          `${formatNumber(conversions)} conversions, ` +
          `and ${money} in attributed revenue. ` +
          `You can ask me naturally about your visitors, ` +
          `sales, revenue, purchases, conversions, carts, ` +
          `checkout activity, recovery, products, or overall business performance.`;
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

            visitors:
              uniqueVisitors,

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

      const sessionId =
        normalizeString(
          session_id,
          200
        );

      if (!sessionId) {
        return res
          .status(400)
          .json(
            failure(
              "missing_session_id"
            )
          );
      }

      const normalizedEvent =
        typeof event ===
        "string"
          ? event
              .trim()
              .toUpperCase()
          : "";

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
        normalizeString(
          event_id,
          200
        ) ||
        `evt_${crypto.randomUUID()}`;

      const safePayloadObject =
        payload &&
        typeof payload ===
          "object"
          ? payload
          : {};

      const safePayload =
        JSON.stringify(
          safePayloadObject
        );

      const safeCart =
        JSON.stringify(
          safePayloadObject.cart &&
          typeof safePayloadObject.cart ===
            "object"
            ? safePayloadObject.cart
            : {}
        );

      if (
        Buffer.byteLength(
          safePayload,
          "utf8"
        ) > 50000 ||
        Buffer.byteLength(
          safeCart,
          "utf8"
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
        req.ip || null;

      /*
       * Idempotent event insert.
       *
       * Requires the unique site_id/event_id index where possible.
       */
      const insertResult =
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
            ON CONFLICT DO NOTHING
          `,
          [
            safeEventId,
            req.site.site_id,
            sessionId,
            normalizedEvent,
            safePayload,
            clientIp,
            req.headers[
              "user-agent"
            ]
          ]
        );

      /*
       * Only update session context when this was a newly
       * inserted event. This prevents duplicate event IDs
       * from inflating session statistics.
       */
      if (
        insertResult.rowCount
      ) {
        try {
          await updateSessionContext({
            siteId:
              req.site.site_id,

            sessionId,

            event:
              normalizedEvent,

            payload:
              safePayloadObject
          });
        } catch (error) {
          /*
           * Context must never break telemetry.
           */
          console.warn(
            "[EVENT CONTEXT ERROR]",
            error.message
          );
        }
      }

      /*
       * CHECKOUT RECOVERY
       */

      const customerEmail =
        normalizeEmail(
          safePayloadObject.email
        );

      if (
        insertResult.rowCount &&
        normalizedEvent ===
          "CHECKOUT_STARTED" &&
        customerEmail
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
            sessionId,
            customerEmail,
            safeCart,
            "10% OFF"
          ]
        );
      }

      return res.json(
        success({
          event_id:
            safeEventId,

          recorded:
            Boolean(
              insertResult.rowCount
            )
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

      const sessionId =
        normalizeString(
          session_id,
          200
        );

      if (!sessionId) {
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

      if (
        value === null
      ) {
        return res
          .status(400)
          .json(
            failure(
              "invalid_cart_value"
            )
          );
      }

      const cartId =
        normalizeString(
          cart_id,
          200
        ) || null;

      const behavior =
        payload &&
        typeof payload ===
          "object"
          ? payload
          : {};

      /*
       * IMPORTANT:
       * site_id was previously missing here.
       *
       * The bandit is tenant-specific, so the site ID must
       * always be passed.
       */
      const action =
        (
          await pickAction({
            site_id:
              req.site.site_id,

            session_id:
              sessionId,

            cart_value:
              value,

            behavior
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
        discountMap[action] ??
        0;

      /*
       * discount is a percentage.
       *
       * Example:
       * ₦1,000 cart + 10% discount
       * = ₦100 discount
       * = ₦900 expected value
       */
      const discountAmount =
        value *
        (
          discount / 100
        );

      const expectedValue =
        Math.max(
          0,
          value -
            discountAmount
        );

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
            sessionId,
            cartId,
            action,
            discount,
            expectedValue
          ]
        );

      return res.json(
        success({
          decision_id:
            result.rows[0]
              .id,

          action,

          discount,

          discount_amount:
            discountAmount,

          expected_value:
            expectedValue
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
      const decisionId =
        normalizeString(
          String(
            req.body?.decision_id ??
              ""
          ),
          100
        );

      if (!decisionId) {
        return res
          .status(400)
          .json(
            failure(
              "missing_decision_id"
            )
          );
      }

      /*
       * Strict state transition:
       *
       * SCORED -> ACTIONED
       *
       * A completed decision can no longer be rewritten.
       */
      const result =
        await db.query(
          `
            UPDATE decisions
            SET
              state = 'ACTIONED'
            WHERE id = $1
              AND site_id = $2
              AND state = 'SCORED'
          `,
          [
            decisionId,
            req.site.site_id
          ]
        );

      if (
        !result.rowCount
      ) {
        return res
          .status(409)
          .json(
            failure(
              "invalid_decision_state"
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
      const decisionId =
        normalizeString(
          String(
            req.body?.decision_id ??
              ""
          ),
          100
        );

      if (!decisionId) {
        return res
          .status(400)
          .json(
            failure(
              "missing_decision_id"
            )
          );
      }

      const converted =
        normalizeBoolean(
          req.body?.converted
        );

      const revenueValue =
        validateNumber(
          req.body?.revenue
        );

      if (
        revenueValue === null
      ) {
        return res
          .status(400)
          .json(
            failure(
              "invalid_revenue"
            )
          );
      }

      /*
       * Atomic state transition.
       *
       * This prevents two simultaneous outcome requests from
       * both completing the same decision and both rewarding
       * the bandit.
       */
      const result =
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
              AND state = 'ACTIONED'
            RETURNING
              id,
              action
          `,
          [
            converted,
            revenueValue,
            decisionId,
            req.site.site_id
          ]
        );

      if (
        !result.rowCount
      ) {
        /*
         * Determine whether the decision exists so the API can
         * distinguish "not found" from "already completed/invalid state".
         */
        const existing =
          await db.query(
            `
              SELECT
                id,
                state
              FROM decisions
              WHERE id = $1
                AND site_id = $2
              LIMIT 1
            `,
            [
              decisionId,
              req.site.site_id
            ]
          );

        if (
          !existing.rowCount
        ) {
          return res
            .status(404)
            .json(
              failure(
                "not_found"
              )
            );
        }

        return res
          .status(409)
          .json(
            failure(
              "invalid_decision_state"
            )
          );
      }

      const action =
        result.rows[0]
          .action;

      /*
       * IMPORTANT:
       * updateBandit signature is:
       *
       * updateBandit(site_id, action, converted)
       *
       * The old server passed the arguments incorrectly.
       */
      await updateBandit(
        req.site.site_id,
        action,
        converted
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
          [
            req.site.site_id
          ]
        );

      const row =
        result.rows[0];

      return res.json(
        success({
          total:
            Number(
              row.total || 0
            ),

          conversions:
            Number(
              row.conversions ||
                0
            ),

          revenue:
            Number(
              row.revenue || 0
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
      /*
       * Recover jobs that were marked PROCESSING but whose
       * worker died before completing them.
       *
       * This is deliberately conservative: only jobs that have
       * been processing for at least 30 minutes are reset.
       */
      await db.query(
        `
          UPDATE recovery_queue
          SET
            status = 'PENDING'
          WHERE status = 'PROCESSING'
            AND created_at <
              NOW() - INTERVAL '30 minutes'
        `
      );

      client =
        await db.connect();

      await client.query(
        "BEGIN"
      );

      const batch =
        await client.query(
          `
            UPDATE recovery_queue
            SET
              status = 'PROCESSING'
            WHERE id IN (
              SELECT id
              FROM recovery_queue
              WHERE status = 'PENDING'
                AND created_at >= NOW()
                  - INTERVAL '7 days'
              ORDER BY created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 20
            )
            RETURNING *
          `
        );

      await client.query(
        "COMMIT"
      );

      for (
        const item of
          batch.rows
      ) {
        try {
          /*
           * IMPORTANT:
           * Recovery conversion checks must be tenant-scoped.
           */
          const conversionCheck =
            await db.query(
              `
                SELECT id
                FROM decisions
                WHERE site_id = $1
                  AND session_id = $2
                  AND converted = true
                LIMIT 1
              `,
              [
                item.site_id,
                item.session_id
              ]
            );

          if (
            conversionCheck.rowCount
          ) {
            await db.query(
              `
                UPDATE recovery_queue
                SET
                  status = 'COMPLETED',
                  processed_at = NOW()
                WHERE id = $1
              `,
              [
                item.id
              ]
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
                AND status = 'PROCESSING'
            `,
            [
              item.id
            ]
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

          try {
            await db.query(
              `
                UPDATE recovery_queue
                SET
                  status = 'FAILED',
                  processed_at = NOW()
                WHERE id = $1
              `,
              [
                item.id
              ]
            );
          } catch (
            updateError
          ) {
            console.error(
              "[RECOVERY STATUS UPDATE ERROR]",
              updateError
            );
          }
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
    let lockClient;

    try {
      /*
       * PostgreSQL advisory lock protects the daily report
       * when REDEN is running on multiple server instances.
       */
      lockClient =
        await db.connect();

      const lockResult =
        await lockClient.query(
          `
            SELECT
              pg_try_advisory_lock(
                hashtext(
                  'reden:cron:daily_report'
                )
              ) AS acquired
          `
        );

      const acquired =
        Boolean(
          lockResult.rows[0]
            ?.acquired
        );

      if (!acquired) {
        lockClient.release();
        lockClient = null;

        return;
      }

      const merchants =
        await lockClient.query(
          `
            SELECT
              site_id,
              name,
              owner_email,
              active
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

        try {
          const stats =
            await lockClient.query(
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

          await lockClient.query(
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
        } catch (merchantError) {
          /*
           * One merchant's email failure must not stop the
           * daily reports for every other merchant.
           */
          console.error(
            `[DAILY REPORT] Failed for site ${merchant.site_id}:`,
            merchantError
          );
        }
      }

      try {
        await lockClient.query(
          `
            SELECT
              pg_advisory_unlock(
                hashtext(
                  'reden:cron:daily_report'
                )
              )
          `
        );
      } catch {}
    } catch (error) {
      console.error(
        "[DAILY REPORT CRON ERROR]",
        error
      );
    } finally {
      if (lockClient) {
        lockClient.release();
      }
    }
  },
  {
    timezone:
      "UTC"
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

    if (
      res.headersSent
    ) {
      return next(error);
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
        `[REDEN] Installation lookup: INTERNAL`
      );

      console.log(
        `[REDEN] Installation verification: PUBLIC`
      );

      console.log(
        `[REDEN] Dashboard intelligence: ENABLED`
      );

      console.log(
        `[REDEN] Session context integration: ENABLED`
      );

      console.log(
        `[REDEN] Paystack dependency: DISABLED`
      );
    }
  );

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

let shuttingDown = false;

const shutdownHandler =
  async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

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
