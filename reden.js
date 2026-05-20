import express from "express";
import dotenv from "dotenv";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

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

import { verifyHmac } from "./shopify.js";

dotenv.config();

/* ─────────────────────────────────────────────
   INIT
───────────────────────────────────────────── */

await initDB();
await initRedis();

const app = express();

/* ─────────────────────────────────────────────
   PATH SETUP
───────────────────────────────────────────── */

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
   MIDDLEWARE
───────────────────────────────────────────── */

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* REQUEST ID */

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();

  res.setHeader(
    "x-request-id",
    req.requestId
  );

  next();
});

/* RESPONSE TIME */

app.use((req, res, next) => {

  const start = Date.now();

  res.on("finish", () => {

    const duration =
      Date.now() - start;

    console.log(
      `[${req.method}] ${req.path} ${res.statusCode} ${duration}ms`
    );
  });

  next();
});

/* STATIC FILES */

app.use(
  express.static(
    path.join(__dirname, "public"),
    {
      maxAge: "7d",
      etag: true,
    }
  )
);

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */

function success(data = {}) {

  return {
    ok: true,
    timestamp:
      new Date().toISOString(),
    ...data,
  };
}

function failure(error, details = null) {

  return {
    ok: false,
    error,
    details,
    timestamp:
      new Date().toISOString(),
  };
}

function validateNumber(value) {

  const num = Number(value);

  if (
    Number.isNaN(num) ||
    !Number.isFinite(num)
  ) {
    return null;
  }

  return num;
}

/* ─────────────────────────────────────────────
   AUTHENTICATION
───────────────────────────────────────────── */

async function authenticate(
  req,
  res,
  next
) {

  try {

    const publicRoutes = [
      "/",
      "/health",
      "/sdk.js",
      "/style.css",
      "/test-email",
      "/auth",
      "/auth/callback",
    ];

    const isPublic =
      publicRoutes.some(route =>
        req.path.startsWith(route)
      ) ||
      req.path.startsWith("/logo") ||
      req.path.includes(".png") ||
      req.path.includes(".jpg") ||
      req.path.includes(".jpeg") ||
      req.path.includes(".svg") ||
      req.path.includes(".webp");

    if (isPublic) {
      return next();
    }

    const apiKey =
      req.headers["x-api-key"];

    const siteId =
      req.headers["x-site-id"];

    if (!apiKey || !siteId) {
      return res
        .status(401)
        .json(
          failure(
            "missing_credentials"
          )
        );
    }

    const cacheKey =
      `site:${siteId}:${apiKey}`;

    /* REDIS CACHE */

    if (redis) {

      try {

        const cached =
          await redis.get(cacheKey);

        if (cached) {

          req.site =
            JSON.parse(cached);

          return next();
        }

      } catch {}
    }

    const result =
      await db.query(
        `
        SELECT
          id,
          site_id,
          name,
          active,
          created_at
        FROM sites
        WHERE
          api_key = $1
          AND site_id = $2
          AND active = true
        LIMIT 1
        `,
        [
          apiKey,
          siteId
        ]
      );

    if (result.rowCount === 0) {

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

    /* CACHE SITE */

    if (redis) {

      try {

        await redis.set(
          cacheKey,
          JSON.stringify(req.site),
          "EX",
          300
        );

      } catch {}
    }

    next();

  } catch (e) {

    console.error(
      "[AUTH ERROR]",
      e
    );

    return res
      .status(500)
      .json(
        failure(
          "authentication_failed"
        )
      );
  }
}

app.use(authenticate);

/* ─────────────────────────────────────────────
   HEALTH
───────────────────────────────────────────── */

app.get("/", async (req, res) => {

  try {

    await db.query("SELECT 1");

    return res.json(
      success({
        service: "REDEN",
        status: "operational",
        database: "connected",
        redis:
          redis
            ? "enabled"
            : "disabled",
        runtime: "adaptive",
        version: "v5",
      })
    );

  } catch (e) {

    console.error(
      "[ROOT ERROR]",
      e
    );

    return res
      .status(500)
      .json(
        failure(
          "database_offline"
        )
      );
  }
});

app.get("/health", async (req, res) => {

  return res.json(
    success({
      uptime:
        process.uptime(),

      memory:
        process.memoryUsage(),

      node:
        process.version,
    })
  );
});

/* ─────────────────────────────────────────────
   EVENT TRACKING
───────────────────────────────────────────── */

app.post("/event", async (req, res) => {

  try {

    const {
      session_id,
      event,
      payload,
      url,
      path,
      title
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

    await db.query(
      `
      INSERT INTO event_logs
      (
        site_id,
        session_id,
        event,
        payload,
        url,
        path,
        title
      )
      VALUES
      (
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
        req.site.site_id,
        session_id,
        event,
        payload || {},
        url || null,
        path || null,
        title || null,
      ]
    );

    return res.json(
      success()
    );

  } catch (e) {

    console.error(
      "[EVENT ERROR]",
      e
    );

    return res
      .status(500)
      .json(
        failure(
          "event_failed"
        )
      );
  }
});

/* ─────────────────────────────────────────────
   IDENTIFY CUSTOMER
───────────────────────────────────────────── */

app.post("/identify", async (req, res) => {

  try {

    const {
      session_id,
      customer_id,
      email,
      first_name,
      last_name,
      metadata,
    } = req.body;

    if (
      !session_id ||
      !email
    ) {

      return res
        .status(400)
        .json(
          failure(
            "missing_fields"
          )
        );
    }

    const existing =
      await db.query(
        `
        SELECT
          id,
          email
        FROM customers
        WHERE
          site_id = $1
          AND email = $2
        LIMIT 1
        `,
        [
          req.site.site_id,
          email
        ]
      );

    let customerRef;

    if (
      existing.rowCount === 0
    ) {

      const created =
        await db.query(
          `
          INSERT INTO customers
          (
            site_id,
            customer_id,
            email,
            first_name,
            last_name,
            metadata,
            created_at
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            NOW()
          )
          RETURNING id
          `,
          [
            req.site.site_id,
            customer_id || null,
            email,
            first_name || null,
            last_name || null,
            metadata || {},
          ]
        );

      customerRef =
        created.rows[0].id;

      try {

        await sendEmail({
          to: email,

          subject:
            "Your Session With REDEN Is Active",

          html: `
            <div style="background:#05070b;color:#ffffff;padding:40px;font-family:Inter,Arial,sans-serif;">
              <h1 style="font-size:30px;margin-bottom:10px;">
                Connected
              </h1>

              <p style="color:#9ca3af;line-height:1.7;">
                Your interaction session has been initialized successfully.
              </p>

              <div style="margin-top:30px;padding:24px;border-radius:14px;background:#0b0f17;border:1px solid #1f2937;">
                <p>Session ID:</p>
                <code>${session_id}</code>
              </div>
            </div>
          `,
        });

      } catch (emailError) {

        console.error(
          "[WELCOME EMAIL ERROR]",
          emailError
        );
      }

    } else {

      customerRef =
        existing.rows[0].id;
    }

    const existingSession =
      await db.query(
        `
        SELECT id
        FROM customer_sessions
        WHERE
          site_id = $1
          AND session_id = $2
        LIMIT 1
        `,
        [
          req.site.site_id,
          session_id
        ]
      );

    if (
      existingSession.rowCount === 0
    ) {

      await db.query(
        `
        INSERT INTO customer_sessions
        (
          site_id,
          customer_ref,
          session_id,
          created_at
        )
        VALUES
        (
          $1,
          $2,
          $3,
          NOW()
        )
        `,
        [
          req.site.site_id,
          customerRef,
          session_id
        ]
      );
    }

    return res.json(
      success({
        customer_ref:
          customerRef,

        identified: true,
      })
    );

  } catch (e) {

    console.error(
      "[IDENTIFY ERROR]",
      e
    );

    return res
      .status(500)
      .json(
        failure(
          "identify_failed"
        )
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
      cart_value
    } = req.body;

    if (
      !session_id ||
      !cart_id ||
      cart_value === undefined
    ) {

      return res
        .status(400)
        .json(
          failure(
            "missing_fields"
          )
        );
    }

    const value =
      validateNumber(
        cart_value
      );

    if (
      value === null ||
      value <= 0
    ) {

      return res
        .status(400)
        .json(
          failure(
            "invalid_cart_value"
          )
        );
    }

    let action =
      await pickAction();

    if (!action) {
      action = "NONE";
    }

    const discounts = {
      NONE: 0,
      INCENTIVE_LOW: 5,
      INCENTIVE_MED: 10,
      INCENTIVE_HIGH: 20,
    };

    const discount =
      discounts[action] || 0;

    const expected_value =
      Math.max(
        value - discount,
        0
      );

    const result =
      await db.query(
        `
        INSERT INTO decisions
        (
          site_id,
          session_id,
          cart_id,
          action,
          discount,
          expected_value,
          state
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          'SCORED'
        )
        RETURNING id, created_at
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

    const decision =
      result.rows[0];

    if (redis) {

      try {

        await redis.set(
          `decision:${decision.id}`,

          JSON.stringify({
            action,
            discount,
            expected_value,
          }),

          "EX",
          300
        );

      } catch {}
    }

    return res.json(
      success({
        decision_id:
          decision.id,

        action,
        discount,
        expected_value,

        explored:
          Math.random() < 0.1,
      })
    );

  } catch (e) {

    console.error(
      "[SCORE ERROR]",
      e
    );

    return res
      .status(500)
      .json(
        failure(
          "score_failed"
        )
      );
  }
});

/* ─────────────────────────────────────────────
   ACTION
───────────────────────────────────────────── */

app.post("/action", async (req, res) => {

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
        SET
          state = 'ACTIONED',
          actioned_at = NOW()
        WHERE
          id = $1
          AND state = 'SCORED'
        `,
        [decision_id]
      );

    if (
      result.rowCount === 0
    ) {

      return res
        .status(409)
        .json(
          failure(
            "invalid_state"
          )
        );
    }

    return res.json(
      success()
    );

  } catch (e) {

    console.error(
      "[ACTION ERROR]",
      e
    );

    return res
      .status(500)
      .json(
        failure(
          "action_failed"
        )
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

    const existing =
      await db.query(
        `
        SELECT
          action,
          state
        FROM decisions
        WHERE id = $1
        `,
        [decision_id]
      );

    if (
      existing.rowCount === 0
    ) {

      return res
        .status(404)
        .json(
          failure(
            "decision_not_found"
          )
        );
    }

    const row =
      existing.rows[0];

    if (
      row.state === "COMPLETED"
    ) {

      return res
        .status(409)
        .json(
          failure(
            "already_completed"
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
      `,
      [
        Boolean(converted),
        Number(revenue || 0),
        decision_id
      ]
    );

    await updateBandit(
      row.action,
      Boolean(converted)
    );

    return res.json(
      success({
        updated: true,
      })
    );

  } catch (e) {

    console.error(
      "[OUTCOME ERROR]",
      e
    );

    return res
      .status(500)
      .json(
        failure(
          "outcome_failed"
        )
      );
  }
});

/* ─────────────────────────────────────────────
   METRICS
───────────────────────────────────────────── */

app.get("/metrics", async (req, res) => {

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
            AVG(revenue),
            0
          ) AS avg_revenue,

          COALESCE(
            SUM(revenue),
            0
          ) AS total_revenue

        FROM decisions

        WHERE
          state = 'COMPLETED'
          AND site_id = $1
        `,
        [req.site.site_id]
      );

    const row =
      result.rows[0];

    const total =
      Number(
        row.total || 0
      );

    const conversions =
      Number(
        row.conversions || 0
      );

    return res.json(
      success({
        total,
        conversions,

        conversion_rate:
          total > 0
            ? conversions / total
            : 0,

        avg_revenue:
          Number(
            row.avg_revenue || 0
          ),

        total_revenue:
          Number(
            row.total_revenue || 0
          ),
      })
    );

  } catch (e) {

    console.error(
      "[METRICS ERROR]",
      e
    );

    return res
      .status(500)
      .json(
        failure(
          "metrics_failed"
        )
      );
  }
});

/* ─────────────────────────────────────────────
   ACTION METRICS
───────────────────────────────────────────── */

app.get(
  "/metrics/actions",
  async (req, res) => {

    try {

      const result =
        await db.query(
          `
          SELECT
            action,

            COUNT(*) AS total,

            AVG(
              CASE
                WHEN converted = true
                THEN 1
                ELSE 0
              END
            ) AS conversion_rate,

            COALESCE(
              AVG(revenue),
              0
            ) AS avg_revenue

          FROM decisions

          WHERE
            state = 'COMPLETED'
            AND site_id = $1

          GROUP BY action

          ORDER BY conversion_rate DESC
          `,
          [req.site.site_id]
        );

      return res.json(
        success({
          actions:
            result.rows,
        })
      );

    } catch (e) {

      console.error(
        "[ACTION METRICS ERROR]",
        e
      );

      return res
        .status(500)
        .json(
          failure(
            "metrics_actions_failed"
          )
        );
    }
  }
);

/* ─────────────────────────────────────────────
   RUNTIME INSIGHTS
───────────────────────────────────────────── */

app.get("/runtime", async (req, res) => {

  try {

    const result =
      await db.query(
        `
        SELECT
          state,
          COUNT(*) AS total

        FROM decisions

        WHERE
          site_id = $1

        GROUP BY state
        `,
        [req.site.site_id]
      );

    return res.json(
      success({
        runtime:
          result.rows,
      })
    );

  } catch (e) {

    console.error(
      "[RUNTIME ERROR]",
      e
    );

    return res
      .status(500)
      .json(
        failure(
          "runtime_failed"
        )
      );
  }
});

/* ─────────────────────────────────────────────
   TEST EMAIL
───────────────────────────────────────────── */

app.get("/test-email", async (req, res) => {

  try {

    const result =
      await sendEmail({
        to:
          "redenbydcore@gmail.com",

        subject:
          "REDEN Runtime Operational",

        html: `
          <div style="background:#05070b;color:#ffffff;padding:40px;font-family:Arial,sans-serif;">
            <h1>REDEN Runtime Online</h1>

            <p>
              Adaptive infrastructure communication layer active.
            </p>

            <p>
              Timestamp:
              ${new Date().toISOString()}
            </p>
          </div>
        `,
      });

    return res.json(
      success(result)
    );

  } catch (e) {

    console.error(
      "[TEST EMAIL ERROR]",
      e
    );

    return res
      .status(500)
      .json(
        failure(
          "test_email_failed"
        )
      );
  }
});

/* ─────────────────────────────────────────────
   SHOPIFY AUTH
───────────────────────────────────────────── */

app.get("/auth", async (req, res) => {

  try {

    const { shop } =
      req.query;

    if (!shop) {

      return res
        .status(400)
        .send("Missing shop");
    }

    const redirectUri =
      `${process.env.SHOPIFY_APP_URL}/auth/callback`;

    const installUrl =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${process.env.SHOPIFY_API_KEY}` +
      `&scope=${process.env.SHOPIFY_SCOPES}` +
      `&redirect_uri=${redirectUri}`;

    return res.redirect(
      installUrl
    );

  } catch (e) {

    console.error(
      "[SHOPIFY AUTH ERROR]",
      e
    );

    return res
      .status(500)
      .send("auth_failed");
  }
});

/* ─────────────────────────────────────────────
   SHOPIFY CALLBACK
───────────────────────────────────────────── */

app.get(
  "/auth/callback",
  async (req, res) => {

    try {

      console.log({
        SHOPIFY_APP_URL:
          process.env.SHOPIFY_APP_URL,

        SHOPIFY_API_KEY:
          !!process.env.SHOPIFY_API_KEY,

        SHOPIFY_API_SECRET:
          !!process.env.SHOPIFY_API_SECRET,
      });

      const {
        shop,
        code,
        hmac
      } = req.query;

      if (
        !shop ||
        !code ||
        !hmac
      ) {

        return res
          .status(400)
          .send(
            "Missing parameters"
          );
      }

      const validHmac =
        verifyHmac(req.query);

      if (!validHmac) {

        return res
          .status(403)
          .send("Invalid HMAC");
      }

      const tokenRequest =
        await fetch(
          `https://${shop}/admin/oauth/access_token`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              client_id:
                process.env.SHOPIFY_API_KEY,

              client_secret:
                process.env.SHOPIFY_API_SECRET,

              code,
            }),
          }
        );

      if (!tokenRequest.ok) {

        const raw =
          await tokenRequest.text();

        console.error(
          "[SHOPIFY TOKEN ERROR]",
          raw
        );

        return res
          .status(500)
          .send(
            "token_exchange_failed"
          );
      }

      const tokenData =
  await tokenRequest.json();

console.log(
  "[SHOPIFY TOKEN RESPONSE]",
  tokenData
);

const accessToken =
  tokenData.access_token;
      if (!accessToken) {

        console.error(
          "[SHOPIFY ACCESS TOKEN MISSING]",
          tokenData
        );

        return res
          .status(500)
          .send("token_failed");
      }

      await db.query(
        `
        INSERT INTO shopify_stores
        (
          shop,
          access_token,
          created_at
        )

        VALUES
        (
          $1,
          $2,
          NOW()
        )

        ON CONFLICT (shop)

        DO UPDATE
        SET
          access_token =
          EXCLUDED.access_token
        `,
        [
          shop,
          accessToken,
        ]
      );

      console.log(
        "[SHOPIFY INSTALL SUCCESS]",
        shop
      );

      return res.send(`
        <html>
          <body style="background:#05070b;color:white;font-family:Arial;padding:40px;">
            <h1>
              REDEN Installed Successfully
            </h1>

            <p>
              ${shop}
              is now connected to REDEN.
            </p>
          </body>
        </html>
      `);

    } catch (e) {

      console.error(
        "[SHOPIFY CALLBACK ERROR]",
        e
      );

      return res
        .status(500)
        .send("callback_failed");
    }
  }
);

/* ─────────────────────────────────────────────
   404
───────────────────────────────────────────── */

app.use((req, res) => {

  return res
    .status(404)
    .json(
      failure(
        "route_not_found"
      )
    );
});

/* ─────────────────────────────────────────────
   GLOBAL ERROR HANDLER
───────────────────────────────────────────── */

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

    return res
      .status(500)
      .json(
        failure(
          "internal_server_error"
        )
      );
  }
);

/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(`
  ┌────────────────────────────────────────┐
    REDEN Runtime Operational
    Port: ${PORT}
    Environment:
    ${process.env.NODE_ENV || "development"}
  └────────────────────────────────────────┘
  `);
});
