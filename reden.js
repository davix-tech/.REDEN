import express from "express";
import dotenv from "dotenv";

import path from "path";
import { fileURLToPath } from "url";

import { db, initDB } from "./db.js";
import { pickAction, updateBandit } from "./bandit.js";
import { initRedis, redis } from "./redis.js";

dotenv.config();

/* ─────────────────────────────────────────────
   INIT
───────────────────────────────────────────── */

await initDB();

initRedis();

const app = express();

/* ─────────────────────────────────────────────
   PATH SETUP
───────────────────────────────────────────── */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

/* ─────────────────────────────────────────────
   MIDDLEWARE
───────────────────────────────────────────── */

app.use(express.json());

/* STATIC FILES */

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* ─────────────────────────────────────────────
   AUTHENTICATION
───────────────────────────────────────────── */

async function authenticate(
  req,
  res,
  next
) {

  try {

    /* PUBLIC ROUTES */

    const publicRoutes = [
      "/",
      "/sdk.js",
      "/style.css",
    ];

    const isPublic =
      publicRoutes.includes(req.path) ||
      req.path.startsWith("/logo") ||
      req.path.includes(".png") ||
      req.path.includes(".jpg") ||
      req.path.includes(".svg");

    if (isPublic) {
      return next();
    }

    /* API HEADERS */

    const apiKey =
      req.headers["x-api-key"];

    const siteId =
      req.headers["x-site-id"];

    if (!apiKey || !siteId) {

      return res.status(401).json({
        error:
          "missing_credentials",
      });

    }

    /* VERIFY CLIENT */

    const result =
      await db.query(
        `
        SELECT
          id,
          site_id,
          name,
          active
        FROM sites
        WHERE
          api_key = $1
          AND site_id = $2
          AND active = true
        LIMIT 1
        `,
        [
          apiKey,
          siteId,
        ]
      );

    if (
      result.rowCount === 0
    ) {

      return res.status(403).json({
        error:
          "invalid_credentials",
      });

    }

    req.site =
      result.rows[0];

    next();

  } catch (e) {

    console.error(
      "[AUTH ERROR]",
      e.message
    );

    return res.status(500).json({
      error:
        "authentication_failed",
    });

  }

}

app.use(authenticate);

/* ─────────────────────────────────────────────
   HEALTH
───────────────────────────────────────────── */

app.get("/", async (req, res) => {

  try {

    await db.query("SELECT 1");

    return res.json({
      status: "ok",
      service: "REDEN",
      database: "connected",
      redis:
        redis
          ? "enabled"
          : "disabled",
      version: "v3",
    });

  } catch (e) {

    return res.status(500).json({
      status: "error",
      database: "offline",
    });

  }

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
      title,
    } = req.body;

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
        $1,$2,$3,$4,$5,$6,$7
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

    return res.json({
      ok: true,
    });

  } catch (e) {

    console.error(
      "[EVENT ERROR]",
      e.message
    );

    return res.status(500).json({
      error:
        "event_failed",
    });

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
    } = req.body;

    if (
      !session_id ||
      !cart_id ||
      cart_value === undefined
    ) {

      return res.status(400).json({
        error:
          "missing_fields",
      });

    }

    const value =
      Number(cart_value);

    if (
      isNaN(value) ||
      value <= 0
    ) {

      return res.status(400).json({
        error:
          "invalid_cart_value",
      });

    }

    let action =
      await pickAction();

    if (!action) {
      action = "NONE";
    }

    let discount = 0;

    if (
      action ===
      "INCENTIVE_LOW"
    ) {
      discount = 5;
    }

    if (
      action ===
      "INCENTIVE_MED"
    ) {
      discount = 10;
    }

    if (
      action ===
      "INCENTIVE_HIGH"
    ) {
      discount = 20;
    }

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
          $1,$2,$3,$4,$5,$6,
          'SCORED'
        )
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

    const decision_id =
      result.rows[0].id;

    if (redis) {

      try {

        await redis.set(
          `decision:${decision_id}`,

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

    return res.json({
      decision_id,
      action,
      discount,
      expected_value,
      explored:
        Math.random() < 0.1,
    });

  } catch (e) {

    console.error(
      "[SCORE ERROR]",
      e.message
    );

    return res.status(500).json({
      error:
        "score_failed",
    });

  }

});

/* ─────────────────────────────────────────────
   ACTION
───────────────────────────────────────────── */

app.post("/action", async (req, res) => {

  try {

    const {
      decision_id,
    } = req.body;

    if (!decision_id) {

      return res.status(400).json({
        error:
          "missing_decision_id",
      });

    }

    const result =
      await db.query(
        `
        UPDATE decisions
        SET state='ACTIONED'
        WHERE id=$1
        AND state='SCORED'
        `,
        [decision_id]
      );

    if (
      result.rowCount === 0
    ) {

      return res.status(409).json({
        error:
          "invalid_state",
      });

    }

    return res.json({
      ok: true,
    });

  } catch (e) {

    console.error(
      "[ACTION ERROR]",
      e.message
    );

    return res.status(500).json({
      error:
        "action_failed",
    });

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
      revenue,
    } = req.body;

    if (!decision_id) {

      return res.status(400).json({
        error:
          "missing_decision_id",
      });

    }

    const existing =
      await db.query(
        `
        SELECT action, state
        FROM decisions
        WHERE id=$1
        `,
        [decision_id]
      );

    if (
      existing.rowCount === 0
    ) {

      return res.status(404).json({
        error:
          "decision_not_found",
      });

    }

    const row =
      existing.rows[0];

    if (
      row.state ===
      "COMPLETED"
    ) {

      return res.status(409).json({
        error:
          "already_completed",
      });

    }

    await db.query(
      `
      UPDATE decisions
      SET
        state='COMPLETED',
        converted=$1,
        revenue=$2
      WHERE id=$3
      `,
      [
        Boolean(converted),
        Number(revenue || 0),
        decision_id,
      ]
    );

    await updateBandit(
      row.action,
      Boolean(converted)
    );

    return res.json({
      ok: true,
    });

  } catch (e) {

    console.error(
      "[OUTCOME ERROR]",
      e.message
    );

    return res.status(500).json({
      error:
        "outcome_failed",
    });

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
          ) AS avg_revenue

        FROM decisions

        WHERE
          state='COMPLETED'
          AND site_id=$1
        `,
        [req.site.site_id]
      );

    const row =
      result.rows[0];

    const total =
      Number(row.total || 0);

    const conversions =
      Number(
        row.conversions || 0
      );

    return res.json({
      total,

      conversions,

      conversion_rate:
        total > 0
          ? conversions /
            total
          : 0,

      avg_revenue:
        Number(
          row.avg_revenue || 0
        ),
    });

  } catch (e) {

    console.error(
      "[METRICS ERROR]",
      e.message
    );

    return res.status(500).json({
      error:
        "metrics_failed",
    });

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
            ) AS conversion_rate

          FROM decisions

          WHERE
            state='COMPLETED'
            AND site_id=$1

          GROUP BY action

          ORDER BY conversion_rate DESC
          `,
          [req.site.site_id]
        );

      return res.json(
        result.rows
      );

    } catch (e) {

      console.error(
        "[ACTION METRICS ERROR]",
        e.message
      );

      return res.status(500).json({
        error:
          "metrics_actions_failed",
      });

    }

  }
);

/* ─────────────────────────────────────────────
   404
───────────────────────────────────────────── */

app.use((req, res) => {

  return res.status(404).json({
    error:
      "route_not_found",
  });

});

/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    `REDEN running on port ${PORT}`
  );

});
