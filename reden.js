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
      "/app",
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
   EMBEDDED APP
───────────────────────────────────────────── */

app.get("/app", (req, res) => {

  res.send(`
    <html>
      <body style="background:#05070b;color:white;font-family:Arial;padding:40px;">
        <h1>REDEN Runtime</h1>

        <p>
          Embedded app online.
        </p>
      </body>
    </html>
  `);

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
      `&scope=${encodeURIComponent(process.env.SHOPIFY_SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}`;

    console.log(
      "[SHOPIFY INSTALL URL]",
      installUrl
    );

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

      console.log(
        "[SHOPIFY CALLBACK HIT]"
      );

      console.log(
        "[SHOPIFY QUERY]",
        req.query
      );

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

      console.log(
        "[SHOPIFY HMAC VALID]",
        validHmac
      );

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

      console.log(
        "[SHOPIFY TOKEN STATUS]",
        tokenRequest.status
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
        "[SHOPIFY CALLBACK ERROR]"
      );

      console.error(e);

      console.error(
        e?.stack
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
