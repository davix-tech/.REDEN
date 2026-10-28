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

import { db, initDB } from "./infrastructure/db.js";
import { pickAction, updateBandit } from "./optimization/banditEngine.js";
import {
  updateSessionContext,
  getSessionContext,
} from "./adaptive/contextEngine.js";
import { initRedis, redis } from "./infrastructure/redis.js";
import {
  sendRecoveryEmail,
  sendDailyReport,
} from "./notification/emailEngine.js";
import { diagnoseSales } from "./intelligence/diagnostics.js";
import { detectIntents } from "./intelligence/intentRouter.js";
import { composeConversationResponse } from "./intelligence/responsePolicy.js";
import { composeKnowledgeGuidance } from "./intelligence/knowledgeAdvisor.js";
import { composeGrowthAdvice } from "./intelligence/growthAdvisor.js";
import { loadHistoricalBaselines } from "./intelligence/historicalBaselines.js";
import { composeMerchantIntelligence } from "./intelligence/merchantIntelligence.js";
import { applyIntelligenceAnswerContract } from "./intelligence/answerContract.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 3000);
const ADMIN_SECRET =
  process.env.REDEN_ADMIN_SECRET || process.env.ADMIN_SECRET;

const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

if (!ADMIN_SECRET) {
  throw new Error("REDEN_ADMIN_SECRET or ADMIN_SECRET is required");
}

/* =========================================================
   PROCESS SAFETY
========================================================= */

process.on("uncaughtException", (error) => {
  console.error("[UNCAUGHT EXCEPTION]", error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error("[UNHANDLED REJECTION]", error);
  process.exit(1);
});

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

await initDB();

await db.query(`
  CREATE TABLE IF NOT EXISTS sites (
    id SERIAL PRIMARY KEY,
    site_id VARCHAR(100) UNIQUE NOT NULL,
    api_key VARCHAR(150) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    owner_email VARCHAR(255),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    plan VARCHAR(50) NOT NULL DEFAULT 'basic',
    subscription_status VARCHAR(50) NOT NULL DEFAULT 'inactive',
    timezone VARCHAR(64) NOT NULL DEFAULT 'Africa/Lagos',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

await db.query(`
  ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64)
  NOT NULL DEFAULT 'Africa/Lagos';
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_sites_owner_email
  ON sites (LOWER(owner_email));
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_sites_name
  ON sites (LOWER(name));
`);

await db.query(`
  ALTER TABLE session_summaries
  ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ;
`);

/*
 * TRAFFIC ATTRIBUTION
 *
 * traffic_source and utm_campaign are written ONCE per
 * session, the first time REDEN sees that session_id, and
 * are never overwritten afterward. This is deliberate: a
 * session that starts from a paid social ad and later
 * triggers a direct-navigation event (e.g. a refresh) should
 * still be attributed to the original paid social click, not
 * relabeled as direct.
 */
await db.query(`
  ALTER TABLE session_summaries
  ADD COLUMN IF NOT EXISTS traffic_source VARCHAR(50);
`);

await db.query(`
  ALTER TABLE session_summaries
  ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(255);
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_session_summaries_traffic_source
  ON session_summaries (site_id, traffic_source);
`);

/*
 * IMPORTANT:
 * Do not backfill purchased_at from updated_at.
 *
 * updated_at is session activity time, not purchase time.
 *
 * Historical purchase timestamps must come from actual
 * PURCHASE events in event_logs.
 */
await db.query(`
  UPDATE session_summaries ss
  SET purchased_at = (
    SELECT MIN(el.created_at)
    FROM event_logs el
    WHERE el.site_id = ss.site_id
      AND el.session_id = ss.session_id
      AND el.event = 'PURCHASE'
  )
  WHERE ss.purchased = TRUE
    AND ss.purchased_at IS NULL;
`);

/*
 * RECOVERY QUEUE — customer_email
 *
 * Required so sendRecoveryEmail() has a real recipient.
 * Nullable at the schema level (a CHECKOUT_STARTED event
 * without an email in its payload can't be recovered by
 * email), but the /event handler below always attempts to
 * capture it when present.
 */
await db.query(`
  ALTER TABLE recovery_queue
  ADD COLUMN IF NOT EXISTS customer_email TEXT;
`);

await db.query(`
  CREATE TABLE IF NOT EXISTS intelligence_answers (
    id BIGSERIAL PRIMARY KEY,
    site_id VARCHAR(100) NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    intents JSONB NOT NULL DEFAULT '[]'::jsonb,
    latency_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_intelligence_answers_site_created
  ON intelligence_answers (site_id, created_at DESC);
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_event_logs_site_created
  ON event_logs (site_id, created_at DESC);
`);

await db.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_event_logs_site_event_id
  ON event_logs (site_id, event_id);
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_decisions_site_completed
  ON decisions (site_id, completed_at DESC);
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_decisions_site_session_state
  ON decisions (site_id, session_id, state);
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_session_summaries_site_updated
  ON session_summaries (site_id, updated_at DESC);
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_session_summaries_site_session
  ON session_summaries (site_id, session_id);
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_email_logs_site_created
  ON email_logs (site_id, created_at DESC);
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_recovery_site_status
  ON recovery_queue (site_id, status);
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_bandit_state_site
  ON bandit_state (site_id);
`);

await initRedis();

/* =========================================================
   SECURITY
========================================================= */

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },
  })
);

app.use(compression());

/* =========================================================
   REQUEST ID
========================================================= */

app.use((req, res, next) => {
  const incoming = req.get("x-request-id");

  const requestId =
    typeof incoming === "string" &&
    incoming.length > 0 &&
    incoming.length <= 100
      ? incoming
      : crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  next();
});

/* =========================================================
   CORS
========================================================= */

const PUBLIC_CORS_PATHS = new Set([
  "/event",
  "/score",
  "/action",
  "/outcome",
  "/sdk.js",
  "/api/v1/verify",
]);

function isPublicAsset(req) {
  if (req.path === "/" || req.path === "/health") {
    return true;
  }

  if (req.path === "/sdk.js") {
    return true;
  }

  return /\.(js|css|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf)$/i.test(
    req.path
  );
}

function isPublicRoute(req) {
  return isPublicAsset(req) || PUBLIC_CORS_PATHS.has(req.path);
}

/*
 * isAuthExempt is DELIBERATELY narrower than isPublicRoute.
 *
 * isPublicRoute controls which routes get permissive CORS
 * headers -- /event, /score, /action, /outcome NEED this
 * because they're called cross-origin from arbitrary merchant
 * storefronts.
 *
 * isAuthExempt controls which routes SKIP authentication
 * entirely. Those four routes must NOT skip auth -- they
 * still require a valid x-site-id/x-api-key pair. Reusing
 * isPublicRoute for both previously caused every tracked
 * event to bypass auth, leaving req.site unset and crashing
 * every handler that reads req.site.site_id.
 */
function isAuthExempt(req) {
  return isPublicAsset(req) || req.path === "/api/v1/verify";
}

app.use((req, res, next) => {
  if (isPublicRoute(req)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      [
        "Content-Type",
        "X-Api-Key",
        "X-Site-Id",
        "X-Request-Id",
        "X-SDK-Version",
      ].join(", ")
    );
    res.setHeader("Access-Control-Max-Age", "600");

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
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
  legacyHeaders: false,
  skip: (req) => req.path === "/event",
});

const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const siteId =
      req.headers["x-site-id"] ||
      req.body?.site_id ||
      req.body?.siteId ||
      "unknown";

    return `${siteId}:${req.ip}`;
  },
});

app.use(generalLimiter);

app.use("/event", telemetryLimiter);

/* =========================================================
   BODY PARSING
========================================================= */

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

/* =========================================================
   TIMEOUT
========================================================= */

app.use(timeout("15s"));

app.use((req, res, next) => {
  if (!req.timedout) {
    return next();
  }

  console.error("[REQUEST TIMEOUT]", {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
  });

  return res.status(408).json({
    success: false,
    error: "Request timeout",
    requestId: req.requestId,
  });
});

/* =========================================================
   HELPERS
========================================================= */

function success(res, data = {}) {
  return res.status(200).json({
    success: true,
    ...data,
  });
}

function failure(res, status, error, details = undefined) {
  const body = {
    success: false,
    error,
  };

  if (details !== undefined) {
    body.details = details;
  }

  return res.status(status).json(body);
}

function validateNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }

  return Boolean(value);
}

function normalizeString(value, maxLength = 500) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function normalizeEmail(value) {
  const email = normalizeString(value, 255).toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "";
  }

  return email;
}

function safeCompare(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    !a ||
    !b
  ) {
    return false;
  }

  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function hashAuthKey(siteId, apiKey) {
  return crypto
    .createHash("sha256")
    .update(`${siteId}:${apiKey}`)
    .digest("hex");
}

function safePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  try {
    const serialized = JSON.stringify(payload);

    if (serialized.length > 50_000) {
      return {};
    }

    return JSON.parse(serialized);
  } catch {
    return {};
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function generateSiteId() {
  return `site_${crypto.randomBytes(8).toString("hex")}`;
}

function generateApiKey() {
  return `rd_${crypto.randomBytes(24).toString("hex")}`;
}

/* =========================================================
   TRAFFIC ATTRIBUTION HELPERS
========================================================= */

const KNOWN_SOCIAL_HOSTS = [
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "pinterest.com",
  "snapchat.com",
  "youtube.com",
];

const KNOWN_SEARCH_HOSTS = [
  "google.",
  "bing.com",
  "yahoo.com",
  "duckduckgo.com",
  "baidu.com",
  "yandex.",
];

function extractHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/*
 * classifyTrafficSource is intentionally conservative:
 * explicit UTM params always win over referrer-guessing,
 * because a merchant running paid campaigns has already told
 * us the channel -- we shouldn't override that with a guess.
 *
 * Only PAGE_VIEW / SESSION_START payloads are expected to
 * carry referrer/utm data (the SDK captures this once, at
 * session start), but this function is defensive against
 * receiving it on any event.
 */
function classifyTrafficSource({ referrer, utmSource, utmMedium }) {
  const source = normalizeString(utmSource, 100).toLowerCase();
  const medium = normalizeString(utmMedium, 100).toLowerCase();

  if (source) {
    if (medium.includes("cpc") || medium.includes("paid")) {
      return `paid_${source}`;
    }

    return source;
  }

  const ref = normalizeString(referrer, 500);

  if (!ref) {
    return "direct";
  }

  const host = extractHost(ref);

  if (!host) {
    return "direct";
  }

  if (KNOWN_SOCIAL_HOSTS.some((h) => host.includes(h))) {
    return "social";
  }

  if (KNOWN_SEARCH_HOSTS.some((h) => host.includes(h))) {
    return "organic_search";
  }

  return "referral";
}

/* =========================================================
   TIMEZONE / CALENDAR HELPERS
========================================================= */

function zonedDateTimeToUtc(
  year,
  month,
  day,
  hour,
  minute,
  second,
  timeZone
) {
  const target = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second)
  );

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(target);

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }

  const asUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second
  );

  const offset = asUtc - target.getTime();

  return new Date(target.getTime() - offset);
}

function getSiteDayBounds(timeZone, referenceDate = new Date()) {
  let validTimeZone = timeZone || "Africa/Lagos";

  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: validTimeZone,
    }).format(referenceDate);
  } catch {
    throw new Error(`Invalid site timezone: ${validTimeZone}`);
  }

  const localDateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: validTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(referenceDate);

  const parts = {};

  for (const part of localDateParts) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }

  const startUTC = zonedDateTimeToUtc(
    parts.year,
    parts.month,
    parts.day,
    0,
    0,
    0,
    validTimeZone
  );

  const tomorrow = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day) +
      24 * 60 * 60 * 1000
  );

  const nextPartsRaw = new Intl.DateTimeFormat("en-US", {
    timeZone: validTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(tomorrow);

  const nextParts = {};

  for (const part of nextPartsRaw) {
    if (part.type !== "literal") {
      nextParts[part.type] = Number(part.value);
    }
  }

  const endUTC = zonedDateTimeToUtc(
    nextParts.year,
    nextParts.month,
    nextParts.day,
    0,
    0,
    0,
    validTimeZone
  );

  return {
    startUTC,
    endUTC,
    localDate: `${String(parts.year).padStart(4, "0")}-${String(
      parts.month
    ).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    timeZone: validTimeZone,
  };
}

/* =========================================================
   INTELLIGENCE HELPERS
========================================================= */

function composeIdentity(site) {
  return `${site.name} is the connected merchant site in REDEN.`;
}

function composeRevenue(evidence) {
  const amount = Number(evidence.purchaseRevenue || 0).toFixed(2);
  return `Your store recorded ${amount} in sales revenue today. This is recorded revenue, not verified profit. The store currency has not been confirmed.`;
}

function composeTraffic(evidence) {
  const baseline = evidence.trafficBaseline;
  const visits = baseline?.currentSessions;
  const visitCount = Number(visits);

  if (baseline?.status === "insufficient_history" && visits == null) {
    return "I could not reliably read PAGE_VIEW session counts for the current period, so I cannot assess today's visits or compare them with the historical baseline yet. Check event tracking and try again.";
  }

  if (!baseline || baseline.status === "insufficient_history") {
    return `Today REDEN recorded ${visitCount} visits (sessions with a PAGE_VIEW event) by ${baseline?.asOfLocalTime || "the current"} site-local time. I do not yet have enough reliable historical page-view data to determine whether this is unusually low.`;
  }

  const comparison = baseline.averageSessions > 0
    ? Math.round((baseline.currentSessions / baseline.averageSessions) * 100)
    : null;

  if (baseline.status === "below_baseline") {
    return `Today REDEN recorded ${visits} visits by ${baseline.asOfLocalTime} site-local time, compared with an average of ${baseline.averageSessions.toFixed(1)} visits by the same time across ${baseline.daysWithTraffic} of the previous 7 days with recorded page views. That is ${comparison}% of the recent baseline, so recorded visits are materially below their usual level at this point in the day.`;
  }

  return `Today REDEN recorded ${visits} visits by ${baseline.asOfLocalTime}. This is not at least 50% below the average of ${baseline.averageSessions.toFixed(1)} visits by the same time across ${baseline.daysWithTraffic} of the previous 7 days with recorded page views.`;
}

function composePurchases(evidence) {
  return `Today REDEN recorded ${evidence.purchases} purchase events across ${evidence.purchasedSessions} purchased sessions, with storefront purchase revenue of ${evidence.purchaseRevenue.toFixed(
    2
  )}.`;
}

function composeConversion(evidence) {
  if (evidence.decisions === 0) {
    return "There are no completed REDEN decisions today, so a decision conversion rate cannot be calculated.";
  }

  const rate =
    (evidence.conversions / evidence.decisions) * 100;

  return `Today REDEN completed ${evidence.decisions} decisions and recorded ${evidence.conversions} conversions, giving a decision conversion rate of ${rate.toFixed(
    2
  )}%.`;
}

function composeSales(evidence) {
  return `Today there were ${evidence.purchases} purchase events and ${evidence.purchaseRevenue.toFixed(
    2
  )} in recorded storefront purchase revenue.`;
}

function composeCart(evidence) {
  const gap = Math.max(
    0,
    evidence.checkoutStarted - evidence.purchases
  );

  return `Today REDEN recorded ${evidence.checkoutStarted} checkout starts and ${evidence.purchases} purchase events. The difference between those event counts is ${gap}. This is a checkout-to-purchase event gap, not a confirmed abandonment count.`;
}

function composeRecovery(evidence) {
  return `Recovery activity today: ${evidence.recovery.pending} pending, ${evidence.recovery.sent} sent, ${evidence.recovery.completed} completed, and ${evidence.recovery.failed} failed.`;
}

function composeEmail(evidence) {
  return `Today REDEN recorded ${evidence.emails.total} email records: ${evidence.emails.sent} sent, ${evidence.emails.delivered} delivered, and ${evidence.emails.failed} failed.`;
}

function composeProductInterest(evidence) {
  return `Today REDEN recorded ${evidence.productViews} product-view events and ${evidence.addToCart} add-to-cart events.`;
}

function composeBandit(evidence) {
  if (!evidence.bandit) {
    return "No bandit state is currently available for this site.";
  }

  return `The current bandit state contains ${evidence.bandit.pulls} recorded pulls across ${evidence.bandit.actions} actions.`;
}

function composeAdvice(evidence) {
  const recommendations = [];
  const trafficBaseline = evidence.trafficBaseline;

  if (trafficBaseline?.status === "below_baseline") {
    recommendations.push(
      `Recorded visits are materially below their recent same-time baseline: ${trafficBaseline.currentSessions} visits so far versus an average of ${trafficBaseline.averageSessions.toFixed(1)} across ${trafficBaseline.daysWithTraffic} recent days with recorded PAGE_VIEW events. First verify that the storefront is reachable and PAGE_VIEW tracking is working. If both are healthy, inspect traffic-source delivery, campaign status, and broken or outdated links. Recheck later today before increasing ad spend.`
    );
  } else if (trafficBaseline?.status === "insufficient_history") {
    recommendations.push(
      "I cannot reliably label today's traffic as unusually low yet because fewer than five of the previous seven days have usable recorded traffic. Verify PAGE_VIEW tracking and allow more data to accumulate before making a traffic-spend decision."
    );
  }

  if (
    evidence.checkoutStarted > 0 &&
    evidence.purchases === 0
  ) {
    recommendations.push(
      "Monitor the checkout-to-purchase gap because checkout activity is present without a recorded purchase event today."
    );
  }

  if (
    evidence.checkoutStarted > 0 &&
    evidence.purchases > 0 &&
    evidence.checkoutStarted > evidence.purchases * 2
  ) {
    recommendations.push(
      "Review the checkout-to-purchase event gap and verify that purchase tracking is firing reliably."
    );
  }

  if (
    evidence.purchases === 0 &&
    evidence.uniqueSessions > 0
  ) {
    recommendations.push(
      "There is traffic without a recorded purchase event today; verify the storefront purchase event before interpreting this as a conversion problem."
    );
  }

  if (
    evidence.attribution &&
    evidence.attribution.length >= 2
  ) {
    const bestByAOV = [...evidence.attribution]
      .filter((row) => row.purchases > 0)
      .sort((a, b) => b.avgOrderValue - a.avgOrderValue)[0];

    const worstByAOV = [...evidence.attribution]
      .filter((row) => row.purchases > 0)
      .sort((a, b) => a.avgOrderValue - b.avgOrderValue)[0];

    if (
      bestByAOV &&
      worstByAOV &&
      bestByAOV.trafficSource !== worstByAOV.trafficSource &&
      bestByAOV.avgOrderValue > 0
    ) {
      recommendations.push(
        `Sessions from ${bestByAOV.trafficSource} have the highest average order value today (${bestByAOV.avgOrderValue.toFixed(
          2
        )}), compared to ${worstByAOV.trafficSource} (${worstByAOV.avgOrderValue.toFixed(
          2
        )}). This is today's data only; confirm the pattern holds over a longer period before shifting ad budget.`
      );
    }
  }

  const revenueBaseline = evidence.revenueBaseline;
  if (revenueBaseline?.status === "below_baseline") {
    recommendations.push(
      `Same-time recorded storefront purchase revenue is materially below its comparable baseline (${Number(revenueBaseline.currentRevenue).toFixed(2)} versus ${Number(revenueBaseline.averageRevenue).toFixed(2)} across ${revenueBaseline.daysWithComparablePurchases} eligible purchase days). Compare purchase count and average order value, and verify order/payment tracking before changing prices or ad spend.`
    );
  } else if (
    revenueBaseline?.status === "purchase_tracking_unconfirmed" ||
    revenueBaseline?.status === "purchase_summary_mismatch"
  ) {
    recommendations.push(
      "Revenue comparison is currently unreliable because purchase events and purchased-session summaries are missing or inconsistent. Verify a test purchase end to end before making a performance decision."
    );
  }

  const funnelBaseline = evidence.funnelBaseline;
  if (funnelBaseline?.status === "below_baseline" && funnelBaseline.current) {
    const labels = {
      productView: "product-page discovery",
      addToCart: "add-to-cart",
      checkout: "checkout",
      purchase: "purchase completion",
    };
    const affectedStages = funnelBaseline.lowStages
      .map((stage) => labels[stage] || stage)
      .join(", ");
    recommendations.push(
      `Recorded session-level rates are materially below the comparable baseline at these stages: ${affectedStages}. Check the affected customer journey and verify event tracking before changing offers or spending.`
    );
  }

  if (!recommendations.length) {
    return "No existing rule has identified a strong intervention from today's signals. This does not establish that performance is healthy; compare against a reliable historical baseline and verify event tracking before deciding that no action is needed.";
  }

  return recommendations.join(" ");
}

function composeOverview(evidence) {
  const conversionRate =
    evidence.decisions > 0
      ? (evidence.conversions / evidence.decisions) * 100
      : null;

  const conversionText =
    conversionRate === null
      ? "no completed REDEN decision conversion rate is available"
      : `a REDEN decision conversion rate of ${conversionRate.toFixed(
          2
        )}%`;

  const baseline = evidence.trafficBaseline;
  let trafficContext = "";

  if (baseline?.status === "below_baseline") {
    trafficContext = ` Recorded visits are materially below their recent same-time baseline: ${baseline.currentSessions} visits so far versus an average of ${baseline.averageSessions.toFixed(1)} across ${baseline.daysWithTraffic} of the previous 7 days with recorded PAGE_VIEW events. I recommend first checking storefront availability and PAGE_VIEW tracking, then reviewing traffic sources and campaign status if tracking is healthy.`;
  } else if (baseline?.status === "insufficient_history") {
    trafficContext = " REDEN does not yet have enough reliable historical traffic to determine whether today's visits are unusually low.";
  }

  return `Today REDEN recorded ${evidence.uniqueSessions} unique sessions, ${evidence.totalEvents} events, ${evidence.purchases} purchase events, and ${evidence.purchaseRevenue.toFixed(
    2
  )} in storefront purchase revenue. It also completed ${
    evidence.decisions
  } decisions with ${evidence.conversions} conversions, giving ${conversionText}.${trafficContext}`;
}

function composeFunnel(evidence) {
  const summary = `Today's observed funnel events are ${evidence.pageViews} page views, ${evidence.productViews} product views, ${evidence.addToCart} add-to-cart events, ${evidence.checkoutStarted} checkout starts, and ${evidence.purchases} purchase events. These are event counts, not unique-user stage counts.`;
  const baseline = evidence.funnelBaseline;

  if (!baseline || baseline.status === "insufficient_history") {
    return `${summary} REDEN does not yet have five eligible historical days with recorded page-view sessions for a reliable same-time funnel comparison.`;
  }

  if (baseline.status === "below_baseline" && baseline.current) {
    const labels = {
      productView: "product-view",
      addToCart: "add-to-cart",
      checkout: "checkout",
      purchase: "purchase",
    };
    const details = baseline.lowStages.map((stage) => {
      const currentRate = Number(baseline.current.rates?.[stage]) * 100;
      const averageRate = Number(baseline.averages?.[stage]) * 100;
      return `${labels[stage]} session rate is ${currentRate.toFixed(1)}% versus a same-time historical average of ${averageRate.toFixed(1)}%.`;
    });
    return `${summary} Recorded funnel rates are materially below their baseline: ${details.join(" ")} Treat these as tracking signals to investigate, not proof of a specific cause.`;
  }

  return `${summary} The available recorded session-level rates are not materially below the baseline under REDEN's current threshold. This does not rule out other causes of a sales decline.`;
}

function composeAttribution(evidence) {
  if (!evidence.attribution || !evidence.attribution.length) {
    return "No sessions with attribution data were recorded today.";
  }

  const rows = [...evidence.attribution].sort(
    (a, b) => b.sessions - a.sessions
  );

  const MIN_SAMPLE = 5;

  const lines = rows.map((row) => {
    const lowSample = row.sessions < MIN_SAMPLE;

    const base = `${row.trafficSource}: ${row.sessions} session${
      row.sessions === 1 ? "" : "s"
    }, ${row.purchases} purchase${
      row.purchases === 1 ? "" : "s"
    }, ${row.revenue.toFixed(2)} revenue, ${row.avgOrderValue.toFixed(
      2
    )} average order value`;

    return lowSample
      ? `${base} (small sample, treat as directional only)`
      : base;
  });

  return `Today's traffic by source: ${lines.join("; ")}.`;
}

function composeIntent(intent, evidence, site, question = "") {
  switch (intent) {
    case "greeting":
    case "gratitude":
    case "capabilities":
    case "general_help":
    case "reden_identity":
    case "commerce_knowledge":
      return composeConversationResponse(intent, question);

    case "identity":
      return composeIdentity(site);

    case "revenue":
      return composeRevenue(evidence);

    case "traffic":
      return composeTraffic(evidence);

    case "purchases":
      return composePurchases(evidence);

    case "conversion":
      return composeConversion(evidence);

    case "sales":
      return composeSales(evidence);

    case "diagnostic":
      return diagnoseSales(evidence);

    case "cart":
      return composeCart(evidence);

    case "recovery":
      return composeRecovery(evidence);

    case "email":
      return composeEmail(evidence);

    case "product_interest":
      return composeProductInterest(evidence);

    case "bandit":
      return composeBandit(evidence);

    case "advice":
      return composeKnowledgeGuidance(question, evidence) || composeAdvice(evidence);

    case "growth":
      return composeGrowthAdvice(evidence);

    case "overview":
      return composeOverview(evidence);

    case "funnel":
      return composeFunnel(evidence);

    case "attribution":
      return composeAttribution(evidence);

    case "intent_opportunities":
    case "intervention_effectiveness":
    case "merchant_priority":
      return composeMerchantIntelligence(intent, evidence);

    default:
      return null;
  }
}

/* =========================================================
   AUTHENTICATION
========================================================= */

const ADMIN_ROUTES = new Set([
  "/api/v1/intelligence",
  "/api/v1/onboard",
]);

async function authenticate(req, res, next) {
  try {
    if (isAuthExempt(req)) {
      return next();
    }

    if (ADMIN_ROUTES.has(req.path)) {
      const providedSecret = req.get("x-admin-secret");

      if (!safeCompare(providedSecret, ADMIN_SECRET)) {
        return failure(res, 401, "Unauthorized");
      }

      req.authType = "admin";
      return next();
    }

    const siteId = normalizeString(
      req.get("x-site-id") ||
        req.body?.site_id ||
        req.body?.siteId,
      100
    );

    const apiKey = normalizeString(
      req.get("x-api-key") ||
        req.body?.api_key ||
        req.body?.apiKey,
      150
    );

    if (!siteId || !apiKey) {
      return failure(res, 401, "Missing site credentials");
    }

    const cacheKey = `site_auth:${hashAuthKey(
      siteId,
      apiKey
    )}`;

    /*
     * Cache hits are trusted for up to 300s (5 min). A site
     * deactivated mid-window can still authenticate until the
     * cache entry expires. Lower the TTL below if that window
     * is wider than your risk tolerance.
     */
    try {
      const cached = await redis?.get?.(cacheKey);

      if (cached) {
        const cachedSite = JSON.parse(cached);

        if (cachedSite?.active === true) {
          req.site = cachedSite;
          req.authType = "merchant";
          return next();
        }
      }
    } catch (error) {
      console.error("[REDIS AUTH READ ERROR]", error);
    }

    const result = await db.query(
      `
        SELECT
          id,
          site_id,
          api_key,
          name,
          owner_email,
          active,
          plan,
          subscription_status,
          timezone,
          created_at
        FROM sites
        WHERE site_id = $1
          AND api_key = $2
          AND active = TRUE
        LIMIT 1
      `,
      [siteId, apiKey]
    );

    if (!result.rowCount) {
      return failure(res, 401, "Invalid site credentials");
    }

    const site = result.rows[0];

    req.site = site;
    req.authType = "merchant";

    try {
      await redis?.set?.(
        cacheKey,
        JSON.stringify(site),
        "EX",
        300
      );
    } catch (error) {
      console.error("[REDIS AUTH WRITE ERROR]", error);
    }

    next();
  } catch (error) {
    console.error("[AUTH ERROR]", error);
    return failure(res, 500, "Authentication failed");
  }
}

app.use(authenticate);

/* =========================================================
   SITE CONTEXT
========================================================= */

app.use((req, res, next) => {
  if (
    isAuthExempt(req) ||
    req.authType === "admin"
  ) {
    return next();
  }

  if (!req.site?.site_id) {
    return failure(res, 401, "Missing site context");
  }

  next();
});

/* =========================================================
   STATIC SDK
========================================================= */

app.get("/sdk.js", (req, res) => {
  res.setHeader(
    "Cache-Control",
    "public, max-age=300, must-revalidate"
  );

  return res.sendFile(path.join(PUBLIC_DIR, "sdk.js"));
});

app.use(express.static(PUBLIC_DIR));

/* =========================================================
   ROOT
========================================================= */

app.get("/", async (req, res) => {
  let redisHealthy = false;

  try {
    if (redis?.ping) {
      const result = await redis.ping();
      redisHealthy = result === "PONG";
    }
  } catch {
    redisHealthy = false;
  }

  return success(res, {
    service: "REDEN API",
    operational: true,
    redis: redisHealthy,
  });
});

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");

    return success(res, {
      database: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[HEALTH ERROR]", error);

    return failure(res, 503, "Database unavailable");
  }
});

/* =========================================================
   ONBOARD
========================================================= */

app.post("/api/v1/onboard", async (req, res) => {
  const name = normalizeString(req.body?.name, 255);
  const ownerEmail = normalizeEmail(req.body?.owner_email);

  if (!name || !ownerEmail) {
    return failure(
      res,
      400,
      "name and owner_email are required"
    );
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        SELECT pg_advisory_xact_lock(
          hashtext($1),
          hashtext($2)
        )
      `,
      [ownerEmail, name.toLowerCase()]
    );

    const existing = await client.query(
      `
        SELECT
          site_id,
          api_key,
          name,
          owner_email,
          active,
          plan,
          subscription_status,
          timezone,
          created_at
        FROM sites
        WHERE LOWER(owner_email) = LOWER($1)
          AND LOWER(name) = LOWER($2)
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [ownerEmail, name]
    );

    if (existing.rowCount) {
      await client.query("COMMIT");

      return success(res, {
        existing: true,
        site: existing.rows[0],
      });
    }

    const siteId = generateSiteId();
    const apiKey = generateApiKey();

    const inserted = await client.query(
      `
        INSERT INTO sites (
          site_id,
          api_key,
          name,
          owner_email,
          active,
          plan,
          subscription_status,
          timezone
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          TRUE,
          'basic',
          'active',
          'Africa/Lagos'
        )
        RETURNING
          site_id,
          api_key,
          name,
          owner_email,
          active,
          plan,
          subscription_status,
          timezone,
          created_at
      `,
      [siteId, apiKey, name, ownerEmail]
    );

    await client.query("COMMIT");

    return success(res, {
      existing: false,
      site: inserted.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("[ONBOARD ERROR]", error);

    return failure(res, 500, "Onboarding failed");
  } finally {
    client.release();
  }
});

/* =========================================================
   VERIFY
========================================================= */

app.get("/api/v1/verify", async (req, res) => {
  const clientEmail = normalizeEmail(
    req.query?.clientEmail ||
      req.query?.client_email
  );

  const siteId = normalizeString(
    req.query?.siteId ||
      req.query?.site_id,
    100
  );

  if (!siteId) {
    return failure(
      res,
      400,
      "siteId is required"
    );
  }

  try {
    const result = clientEmail
      ? await db.query(
          `
            SELECT
              site_id,
              name,
              owner_email,
              active,
              plan,
              subscription_status,
              timezone,
              created_at
            FROM sites
            WHERE site_id = $1
              AND LOWER(owner_email) = LOWER($2)
            LIMIT 1
          `,
          [siteId, clientEmail]
        )
      : await db.query(
          `
            SELECT
              site_id,
              name,
              owner_email,
              active,
              plan,
              subscription_status,
              timezone,
              created_at
            FROM sites
            WHERE site_id = $1
            LIMIT 1
          `,
          [siteId]
        );

    if (!result.rowCount) {
      return failure(
        res,
        404,
        "Site verification failed"
      );
    }

    const site = result.rows[0];

    let lastEventAt = null;

    const eventResult = await db.query(
      `
        SELECT created_at
        FROM event_logs
        WHERE site_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [site.site_id]
    );

    if (eventResult.rowCount) {
      lastEventAt = eventResult.rows[0].created_at;
    }

    return success(res, {
      verified: true,
      siteId: site.site_id,
      clientEmail: clientEmail || site.owner_email,
      name: site.name,
      active: site.active,
      plan: site.plan,
      subscriptionStatus: site.subscription_status,
      connected: Boolean(lastEventAt),
      lastEventAt,
      createdAt: site.created_at,
      timezone: site.timezone,
    });
  } catch (error) {
    console.error("[VERIFY ERROR]", error);

    return failure(res, 500, "Verification failed");
  }
});

/* =========================================================
   INTEGRATION HEALTH
========================================================= */

app.get("/api/v1/integration-health", async (req, res) => {
  const siteId = req.site.site_id;

  try {
    const result = await db.query(
      `
        SELECT
          event,
          COUNT(*)::INTEGER AS count,
          MAX(created_at) AS last_at
        FROM event_logs
        WHERE site_id = $1
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY event
      `,
      [siteId]
    );

    const events = {};

    for (const row of result.rows) {
      events[row.event] = {
        count: row.count,
        lastAt: row.last_at,
      };
    }

    const sdkInstalled =
      Number(events.PAGE_VIEW?.count || 0) > 0;

    const requiredBusinessEvents = [
      "PRODUCT_VIEW",
      "ADD_TO_CART",
      "CHECKOUT_STARTED",
      "PURCHASE",
    ];

    const requiredBusinessEventsReceived =
      requiredBusinessEvents.every(
        (event) => Number(events[event]?.count || 0) > 0
      );

    return success(res, {
      siteId,
      sdkInstalled,
      requiredBusinessEventsReceived,
      events,
      checkedPeriod: "last_30_days",
    });
  } catch (error) {
    console.error(
      "[INTEGRATION HEALTH ERROR]",
      error
    );

    return failure(
      res,
      500,
      "Unable to determine integration health"
    );
  }
});

/* =========================================================
   INTELLIGENCE
========================================================= */

app.post("/api/v1/intelligence", async (req, res) => {
  const startedAt = Date.now();

  const siteId = normalizeString(
    req.body?.siteId ||
      req.body?.site_id,
    100
  );

  const question = normalizeString(
    req.body?.question,
    2_000
  );

  if (!siteId || !question) {
    return failure(
      res,
      400,
      "siteId and question are required"
    );
  }

  try {
    const siteResult = await db.query(
      `
        SELECT
          site_id,
          name,
          owner_email,
          active,
          plan,
          subscription_status,
          timezone,
          created_at
        FROM sites
        WHERE site_id = $1
          AND active = TRUE
        LIMIT 1
      `,
      [siteId]
    );

    if (!siteResult.rowCount) {
      return failure(res, 404, "Site not found");
    }

    const site = siteResult.rows[0];

    const referenceNow = new Date();
    const {
      startUTC,
      endUTC,
      localDate,
      timeZone,
    } = getSiteDayBounds(site.timezone, referenceNow);

    const eventResult = await db.query(
      `
        SELECT
          event,
          COUNT(*)::INTEGER AS count
        FROM event_logs
        WHERE site_id = $1
          AND created_at >= $2
          AND created_at < $3
        GROUP BY event
      `,
      [siteId, startUTC, endUTC]
    );

    const eventCounts = {};

    for (const row of eventResult.rows) {
      eventCounts[row.event] = Number(row.count || 0);
    }

    const sessionResult = await db.query(
      `
        SELECT COUNT(DISTINCT session_id)::INTEGER AS count
        FROM event_logs
        WHERE site_id = $1
          AND created_at >= $2
          AND created_at < $3
      `,
      [siteId, startUTC, endUTC]
    );

    const uniqueSessions = Number(
      sessionResult.rows[0]?.count || 0
    );

    let trafficSessions = 0;

    // Compare today's partial traffic with the same local-time cutoff
    // across the previous seven local calendar days.
    const localTimeParts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(referenceNow);
    const localTimeValues = {};
    for (const part of localTimeParts) {
      if (part.type !== "literal") {
        localTimeValues[part.type] = part.value;
      }
    }
    const localTime =
      `${localTimeValues.hour}:${localTimeValues.minute}:${localTimeValues.second}`;

    const [year, month, day] = localDate.split("-").map(Number);
    const baselineCounts = new Map();
    for (let daysAgo = 1; daysAgo <= 7; daysAgo += 1) {
      const date = new Date(Date.UTC(year, month - 1, day - daysAgo));
      baselineCounts.set(date.toISOString().slice(0, 10), 0);
    }

    const trafficBaseline = {
      status: "insufficient_history",
      currentSessions: null,
      averageSessions: null,
      daysWithTraffic: 0,
      windowDays: 7,
      asOfLocalTime: localTime,
      comparisonThreshold: 0.5,
      metric: "distinct_sessions_with_page_view",
      baselineDays: [],
    };

    try {
      // This query is inside the guarded baseline block so a traffic-baseline
      // failure never breaks the merchant's existing intelligence response.
      const trafficSessionResult = await db.query(
        `
          SELECT COUNT(DISTINCT session_id)::INTEGER AS count
          FROM event_logs
          WHERE site_id = $1
            AND event = 'PAGE_VIEW'
            AND created_at >= $2
            AND created_at < $3
        `,
        [siteId, startUTC, endUTC]
      );
      trafficSessions = Number(
        trafficSessionResult.rows[0]?.count || 0
      );
      trafficBaseline.currentSessions = trafficSessions;

      const firstBaselineDate = new Date(
        Date.UTC(year, month - 1, day - 7)
      );
      const baselineStartUTC = zonedDateTimeToUtc(
        firstBaselineDate.getUTCFullYear(),
        firstBaselineDate.getUTCMonth() + 1,
        firstBaselineDate.getUTCDate(),
        0,
        0,
        0,
        timeZone
      );

      const baselineResult = await db.query(
        `
          SELECT
            (created_at AT TIME ZONE $2)::date::text AS local_date,
            COUNT(*)::INTEGER AS page_view_events,
            COUNT(DISTINCT session_id)::INTEGER AS sessions
          FROM event_logs
          WHERE site_id = $1
            AND event = 'PAGE_VIEW'
            AND created_at >= $3
            AND created_at < $4
            AND (created_at AT TIME ZONE $2)::time <= $5::time
          GROUP BY (created_at AT TIME ZONE $2)::date
          ORDER BY local_date DESC
        `,
        [siteId, timeZone, baselineStartUTC, startUTC, localTime]
      );

      const recordedPageViewDays = new Set();
      for (const row of baselineResult.rows) {
        if (baselineCounts.has(row.local_date) && Number(row.page_view_events) > 0) {
          const sessions = Number(row.sessions || 0);
          baselineCounts.set(row.local_date, sessions);
          recordedPageViewDays.add(row.local_date);
        }
      }

      // A day without PAGE_VIEW records cannot distinguish zero real visits
      // from broken/missing tracking, so it is excluded rather than treated
      // as a confirmed zero-traffic day.
      const eligibleDayCounts = [...recordedPageViewDays]
        .map((date) => baselineCounts.get(date))
        .filter((count) => Number.isFinite(count) && count > 0);
      const averageSessions = eligibleDayCounts.length
        ? eligibleDayCounts.reduce((sum, count) => sum + count, 0) /
          eligibleDayCounts.length
        : null;

      trafficBaseline.daysWithTraffic = eligibleDayCounts.length;
      trafficBaseline.baselineDays = [...recordedPageViewDays].sort();
      trafficBaseline.averageSessions = averageSessions;

      if (
        eligibleDayCounts.length >= 5 &&
        Number.isFinite(averageSessions) &&
        averageSessions > 0
      ) {
        trafficBaseline.status =
          trafficBaseline.currentSessions < averageSessions * trafficBaseline.comparisonThreshold
            ? "below_baseline"
            : "not_markedly_below_baseline";
      }
    } catch (baselineError) {
      // The baseline is an enhancement, not a reason to break the existing
      // intelligence endpoint. Keep the answer usable and disclose uncertainty.
      console.error(
        "[INTELLIGENCE TRAFFIC BASELINE ERROR]",
        baselineError
      );
    }

    let historicalBaselines = {
      revenueBaseline: {
        status: "insufficient_history",
        metric: "same_time_recorded_storefront_purchase_revenue",
        currentRevenue: null,
        averageRevenue: null,
        daysWithComparablePurchases: 0,
        windowDays: 7,
        comparisonThreshold: 0.5,
      },
      funnelBaseline: {
        status: "insufficient_history",
        metric: "distinct_page_view_sessions_by_stage",
        current: null,
        averages: null,
        daysWithTraffic: 0,
        windowDays: 7,
        comparisonThreshold: 0.5,
        lowStages: [],
      },
    };

    try {
      const firstHistoricalDate = new Date(
        Date.UTC(year, month - 1, day - 7)
      );
      const historicalStartUTC = zonedDateTimeToUtc(
        firstHistoricalDate.getUTCFullYear(),
        firstHistoricalDate.getUTCMonth() + 1,
        firstHistoricalDate.getUTCDate(),
        0,
        0,
        0,
        timeZone
      );

      historicalBaselines = await loadHistoricalBaselines({
        db,
        siteId,
        timeZone,
        baselineStartUTC: historicalStartUTC,
        startUTC,
        endUTC,
        localDate,
        localTime,
      });
    } catch (historicalBaselineError) {
      // Historical diagnostics must never make the core intelligence request fail.
      console.error(
        "[INTELLIGENCE HISTORICAL BASELINE ERROR]",
        historicalBaselineError
      );
    }

    const decisionResult = await db.query(
      `
        SELECT
          COUNT(*)::INTEGER AS decisions,
          COUNT(*) FILTER (
            WHERE converted = TRUE
          )::INTEGER AS conversions,
          COALESCE(
            SUM(revenue) FILTER (
              WHERE completed_at >= $2
                AND completed_at < $3
            ),
            0
          )::NUMERIC AS revenue
        FROM decisions
        WHERE site_id = $1
          AND completed_at >= $2
          AND completed_at < $3
      `,
      [siteId, startUTC, endUTC]
    );

    const decisionRow = decisionResult.rows[0] || {};

    const decisions = Number(
      decisionRow.decisions || 0
    );

    const conversions = Number(
      decisionRow.conversions || 0
    );

    const decisionRevenue = Number(
      decisionRow.revenue || 0
    );

    const purchaseResult = await db.query(
      `
        SELECT
          COALESCE(
            SUM(revenue),
            0
          )::NUMERIC AS revenue,

          COUNT(*) FILTER (
            WHERE purchased = TRUE
          )::INTEGER AS purchased_sessions
        FROM session_summaries
        WHERE site_id = $1
          AND purchased = TRUE
          AND purchased_at >= $2
          AND purchased_at < $3
      `,
      [siteId, startUTC, endUTC]
    );

    const purchaseRow = purchaseResult.rows[0] || {};

    const purchaseRevenue = Number(
      purchaseRow.revenue || 0
    );

    const purchasedSessions = Number(
      purchaseRow.purchased_sessions || 0
    );

    const recoveryResult = await db.query(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE status = 'PENDING'
          )::INTEGER AS pending,

          COUNT(*) FILTER (
            WHERE status = 'SENT'
          )::INTEGER AS sent,

          COUNT(*) FILTER (
            WHERE status = 'COMPLETED'
          )::INTEGER AS completed,

          COUNT(*) FILTER (
            WHERE status = 'FAILED'
          )::INTEGER AS failed
        FROM recovery_queue
        WHERE site_id = $1
          AND created_at >= $2
          AND created_at < $3
      `,
      [siteId, startUTC, endUTC]
    );

    const recoveryRow = recoveryResult.rows[0] || {};

    const recovery = {
      pending: Number(recoveryRow.pending || 0),
      sent: Number(recoveryRow.sent || 0),
      completed: Number(
        recoveryRow.completed || 0
      ),
      failed: Number(recoveryRow.failed || 0),
    };

    const emailResult = await db.query(
      `
        SELECT
          COUNT(*)::INTEGER AS total,

          COUNT(*) FILTER (
            WHERE status IN ('SENT', 'DELIVERED')
          )::INTEGER AS sent,

          COUNT(*) FILTER (
            WHERE status = 'DELIVERED'
          )::INTEGER AS delivered,

          COUNT(*) FILTER (
            WHERE status = 'FAILED'
          )::INTEGER AS failed

        FROM email_logs
        WHERE site_id = $1
          AND created_at >= $2
          AND created_at < $3
      `,
      [siteId, startUTC, endUTC]
    );

    const emailRow = emailResult.rows[0] || {};

    const emails = {
      total: Number(emailRow.total || 0),
      sent: Number(emailRow.sent || 0),
      delivered: Number(
        emailRow.delivered || 0
      ),
      failed: Number(emailRow.failed || 0),
    };

    /*
     * Recent behavioural intent is computed from session events and is a
     * heuristic, not a calibrated purchase probability. Keep the window short
     * so this is useful for timely triage rather than historical reporting.
     */
    const intentSummaryResult = await db.query(
      `
        SELECT
          COUNT(*)::INTEGER AS recent_sessions,
          COUNT(*) FILTER (
            WHERE intent_score >= 0.70
              AND purchased = FALSE
          )::INTEGER AS high_intent_unpurchased,
          COUNT(*) FILTER (
            WHERE intent_score >= 0.70
              AND purchased = FALSE
              AND cart_additions > 0
          )::INTEGER AS high_intent_with_cart,
          COUNT(*) FILTER (
            WHERE intent_score >= 0.70
              AND purchased = FALSE
              AND checkout_started = TRUE
          )::INTEGER AS high_intent_with_checkout,
          COALESCE(
            SUM(cart_value) FILTER (
              WHERE intent_score >= 0.70
                AND purchased = FALSE
          ), 0)::NUMERIC AS high_intent_cart_value
        FROM session_summaries
        WHERE site_id = $1
          AND last_seen_at >= NOW() - INTERVAL '30 minutes'
      `,
      [siteId]
    );

    const intentSummaryRow = intentSummaryResult.rows[0] || {};
    const intentSummary = {
      windowMinutes: 30,
      recentSessions: Number(intentSummaryRow.recent_sessions || 0),
      highIntentUnpurchased: Number(intentSummaryRow.high_intent_unpurchased || 0),
      highIntentWithCart: Number(intentSummaryRow.high_intent_with_cart || 0),
      highIntentWithCheckout: Number(intentSummaryRow.high_intent_with_checkout || 0),
      highIntentCartValue: Number(intentSummaryRow.high_intent_cart_value || 0),
      scoreType: "behavioural_heuristic",
      threshold: 0.70,
    };

    /*
     * Outcome reporting compares recorded action outcomes. It is deliberately
     * not labelled incremental lift: the current system does not maintain a
     * randomized holdout or equivalent counterfactual baseline.
     */
    const interventionOutcomeResult = await db.query(
      `
        SELECT
          action,
          COUNT(*) FILTER (
            WHERE actioned_at >= $2
              AND actioned_at < $3
          )::INTEGER AS actioned,
          COUNT(*) FILTER (
            WHERE state = 'COMPLETED'
              AND completed_at >= $2
              AND completed_at < $3
          )::INTEGER AS completed,
          COUNT(*) FILTER (
            WHERE state = 'COMPLETED'
              AND converted = TRUE
              AND completed_at >= $2
              AND completed_at < $3
          )::INTEGER AS conversions,
          COALESCE(
            SUM(revenue) FILTER (
              WHERE state = 'COMPLETED'
                AND completed_at >= $2
                AND completed_at < $3
            ), 0
          )::NUMERIC AS recorded_revenue
        FROM decisions
        WHERE site_id = $1
          AND (
            (created_at >= $2 AND created_at < $3)
            OR (actioned_at >= $2 AND actioned_at < $3)
            OR (completed_at >= $2 AND completed_at < $3)
          )
        GROUP BY action
        ORDER BY action
      `,
      [siteId, startUTC, endUTC]
    );

    const interventionOutcomes = interventionOutcomeResult.rows.map((row) => ({
      action: row.action,
      actioned: Number(row.actioned || 0),
      completed: Number(row.completed || 0),
      conversions: Number(row.conversions || 0),
      recordedRevenue: Number(row.recorded_revenue || 0),
    }));

    const banditResult = await db.query(
      `
        SELECT *
        FROM bandit_state
        WHERE site_id = $1
      `,
      [siteId]
    );

    let bandit = null;

    if (banditResult.rowCount) {
      const rows = banditResult.rows;

      let pulls = 0;

      for (const row of rows) {
        pulls += Number(
          row.pulls ??
            row.total_pulls ??
            row.count ??
            0
        );
      }

      bandit = {
        pulls,
        actions: rows.length,
      };
    }

    /*
     * ATTRIBUTION
     *
     * Grouped by traffic_source on session_summaries, scoped
     * to sessions FIRST SEEN today (not purchased today,
     * since attribution is about the session's origin, not
     * its purchase timing). A session's revenue column is
     * cumulative for that session (see contextEngine.js), so
     * this reflects revenue attributable to sessions that
     * originated today.
     */
    const attributionResult = await db.query(
      `
        SELECT
          COALESCE(traffic_source, 'unknown') AS traffic_source,
          COUNT(*)::INTEGER AS sessions,
          COUNT(*) FILTER (
            WHERE purchased = TRUE
          )::INTEGER AS purchases,
          COALESCE(SUM(revenue), 0)::NUMERIC AS revenue
        FROM session_summaries
        WHERE site_id = $1
          AND first_seen_at >= $2
          AND first_seen_at < $3
        GROUP BY COALESCE(traffic_source, 'unknown')
      `,
      [siteId, startUTC, endUTC]
    );

    const attribution = attributionResult.rows.map((row) => {
      const purchases = Number(row.purchases || 0);
      const revenue = Number(row.revenue || 0);

      return {
        trafficSource: row.traffic_source,
        sessions: Number(row.sessions || 0),
        purchases,
        revenue,
        avgOrderValue:
          purchases > 0 ? revenue / purchases : 0,
      };
    });

    const evidence = {
      period: "today",
      localDate,
      timeZone,

      periodStart: startUTC.toISOString(),
      periodEnd: endUTC.toISOString(),

      uniqueSessions,
      trafficBaseline,
      revenueBaseline: historicalBaselines.revenueBaseline,
      funnelBaseline: historicalBaselines.funnelBaseline,
      totalEvents: Object.values(eventCounts).reduce(
        (sum, count) => sum + Number(count || 0),
        0
      ),

      pageViews: Number(
        eventCounts.PAGE_VIEW || 0
      ),

      productViews: Number(
        eventCounts.PRODUCT_VIEW || 0
      ),

      addToCart: Number(
        eventCounts.ADD_TO_CART || 0
      ),

      checkoutStarted: Number(
        eventCounts.CHECKOUT_STARTED || 0
      ),

      purchases: Number(
        eventCounts.PURCHASE || 0
      ),

      decisions,
      conversions,

      decisionRevenue,
      purchaseRevenue,

      purchasedSessions,

      recovery,
      emails,

      bandit,

      attribution,

      intentSummary,
      interventionOutcomes,

      eventCounts,
    };

    let intents = detectIntents(question);

    if (!intents.length) {
      // Unknown/general questions must not be misrepresented as a store overview.
      intents = ["general_help"];
    }

    const sections = [];

    for (const intent of intents) {
      const section = composeIntent(
        intent,
        evidence,
        site,
        question
      );

      if (section) {
        sections.push(section);
      }
    }

    let answer = sections.join("\n\n");

    if (!answer) {
      answer =
        "I could not produce an evidence-backed answer from the available REDEN data.";
    }

    answer = applyIntelligenceAnswerContract(
      answer,
      intents,
      evidence
    );

    const latencyMs = Date.now() - startedAt;

    try {
      await db.query(
        `
          INSERT INTO intelligence_answers (
            site_id,
            question,
            answer,
            evidence,
            intents,
            latency_ms
          )
          VALUES (
            $1,
            $2,
            $3,
            $4::jsonb,
            $5::jsonb,
            $6
          )
        `,
        [
          siteId,
          question,
          answer,
          safeJson(evidence),
          safeJson(intents),
          latencyMs,
        ]
      );
    } catch (auditError) {
      console.error(
        "[INTELLIGENCE AUDIT ERROR]",
        auditError
      );
    }

    return success(res, {
      answer,

      site: {
        siteId: site.site_id,
        name: site.name,
        plan: site.plan,
        subscriptionStatus:
          site.subscription_status,
        timezone: site.timezone,
      },

      evidence,
      intents,

      latencyMs,
    });
  } catch (error) {
    console.error("[INTELLIGENCE ERROR]", error);

    return failure(
      res,
      500,
      "Unable to process intelligence request"
    );
  }
});

/* =========================================================
   EVENT
========================================================= */

app.post("/event", async (req, res) => {
  const siteId = req.site.site_id;

  const sessionId = normalizeString(
    req.body?.session_id ||
      req.body?.sessionId,
    128
  );

  const eventId = normalizeString(
    req.body?.event_id ||
      req.body?.eventId,
    200
  );

  const event = normalizeString(
    req.body?.event,
    100
  ).toUpperCase();

  const payload = safePayload(
    req.body?.payload
  );

  if (!sessionId || !event) {
    return failure(
      res,
      400,
      "session_id and event are required"
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
    "BEHAVIOR",
  ]);

  if (!VALID_EVENTS.has(event)) {
    return failure(
      res,
      400,
      "Invalid event"
    );
  }

  const generatedEventId =
    eventId || crypto.randomUUID();

  const cartValue = validateNumber(
    payload.cart_value ??
      payload.cartValue ??
      payload.cart?.value,
    0
  );

  const boundedCartValue = Math.min(
    Math.max(0, cartValue),
    1_000_000_000
  );

  const sanitizedPayload = {
    ...payload,
    cart_value: boundedCartValue,
  };

  /*
   * Captured here so it's available regardless of which event
   * type triggered this request. A CHECKOUT_STARTED payload
   * is the expected source of an email, but this doesn't
   * assume it's the only one.
   */
  const customerEmail = normalizeEmail(
    payload.email || payload.customer_email
  );

  /*
   * Traffic source is only ever WRITTEN when the incoming
   * payload actually carries referrer/UTM data (the SDK sends
   * this once, at session start). The SQL below uses
   * COALESCE so an existing traffic_source on the row is
   * never overwritten by a later event on the same session.
   */
  const referrer = normalizeString(
    payload.referrer || payload.document_referrer,
    500
  );

  const utmSource = normalizeString(
    payload.utm_source || payload.utmSource,
    100
  );

  const utmMedium = normalizeString(
    payload.utm_medium || payload.utmMedium,
    100
  );

  const utmCampaign = normalizeString(
    payload.utm_campaign || payload.utmCampaign,
    255
  );

  const hasAttributionData = Boolean(
    referrer || utmSource || utmCampaign
  );

  const trafficSource = hasAttributionData
    ? classifyTrafficSource({
        referrer,
        utmSource,
        utmMedium,
      })
    : null;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const eventResult = await client.query(
      `
        INSERT INTO event_logs (
          site_id,
          session_id,
          event_id,
          event,
          payload,
          created_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5::jsonb,
          NOW()
        )
        ON CONFLICT (
          site_id,
          event_id
        )
        DO NOTHING
        RETURNING
          id,
          created_at
      `,
      [
        siteId,
        sessionId,
        generatedEventId,
        event,
        safeJson(sanitizedPayload),
      ]
    );

    if (eventResult.rowCount) {
      await updateSessionContext({
        siteId,
        sessionId,
        event,
        payload: sanitizedPayload,
      });
    }

    /*
     * Attribution write is independent of updateSessionContext
     * because it must apply the FIRST time we see attribution
     * data for this session, regardless of which event carried
     * it. A plain INSERT here would fail if
     * updateSessionContext already created the row for this
     * session_id, so this always targets an existing row via
     * UPDATE and only sets the columns if they're still NULL.
     */
    if (hasAttributionData) {
      await client.query(
        `
          UPDATE session_summaries
          SET
            traffic_source = COALESCE(traffic_source, $3),
            utm_campaign = COALESCE(utm_campaign, $4)
          WHERE site_id = $1
            AND session_id = $2
        `,
        [siteId, sessionId, trafficSource, utmCampaign || null]
      );
    }

    /*
     * CHECKOUT_STARTED enters recovery processing.
     *
     * customer_email is stored on the queue row itself so
     * sendRecoveryEmail() (called later, from the cron) has
     * an actual recipient. Without this, the recovery
     * pipeline silently has nothing to send to.
     *
     * ON CONFLICT (site_id, session_id) matches db.js's
     * UNIQUE (site_id, session_id) constraint on
     * recovery_queue, and backfills customer_email on a
     * repeat CHECKOUT_STARTED if the first one didn't have
     * an email but a later one does.
     */
    if (
      event === "CHECKOUT_STARTED" &&
      eventResult.rowCount
    ) {
      await client.query(
        `
          INSERT INTO recovery_queue (
            site_id,
            session_id,
            customer_email,
            status,
            discount_percent,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            'PENDING',
            10,
            NOW(),
            NOW()
          )
          ON CONFLICT (site_id, session_id) DO UPDATE
          SET customer_email = COALESCE(
            EXCLUDED.customer_email,
            recovery_queue.customer_email
          )
        `,
        [siteId, sessionId, customerEmail || null]
      );
    }

    await client.query("COMMIT");

    return success(res, {
      accepted: true,
      duplicate: eventResult.rowCount === 0,
      eventId: generatedEventId,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("[EVENT ERROR]", error);

    return failure(
      res,
      500,
      "Unable to record event"
    );
  } finally {
    client.release();
  }
});

/* =========================================================
   SCORE
========================================================= */

app.post("/score", async (req, res) => {
  const siteId = req.site.site_id;

  const sessionId = normalizeString(
    req.body?.session_id ||
      req.body?.sessionId,
    128
  );

  const cartValue = validateNumber(
    req.body?.cart_value ??
      req.body?.cartValue,
    0
  );

  const behavior = safePayload(
    req.body?.behavior
  );

  if (!sessionId) {
    return failure(
      res,
      400,
      "session_id is required"
    );
  }

  try {
    const context = await getSessionContext(
      siteId,
      sessionId
    );

    const action = await pickAction({
      site_id: siteId,
      session_id: sessionId,
      cart_value: Math.max(0, cartValue),
      behavior: context || behavior,
    });

    const actionMap = {
      NONE: 0,
      INCENTIVE_LOW: 5,
      INCENTIVE_MED: 10,
      INCENTIVE_HIGH: 20,
    };

    const score =
      actionMap[action] ?? 0;

    const result = await db.query(
      `
        INSERT INTO decisions (
          site_id,
          session_id,
          action,
          score,
          state,
          created_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'SCORED',
          NOW()
        )
        RETURNING id
      `,
      [
        siteId,
        sessionId,
        action,
        score,
      ]
    );

    return success(res, {
      decisionId: result.rows[0].id,
      action,
      score,
    });
  } catch (error) {
    console.error("[SCORE ERROR]", error);

    return failure(
      res,
      500,
      "Unable to score session"
    );
  }
});

/* =========================================================
   ACTION
========================================================= */

app.post("/action", async (req, res) => {
  const siteId = req.site.site_id;

  const decisionId = Number(
    req.body?.decision_id ??
      req.body?.decisionId
  );

  if (!Number.isInteger(decisionId)) {
    return failure(
      res,
      400,
      "Valid decision_id is required"
    );
  }

  try {
    const result = await db.query(
      `
        UPDATE decisions
        SET
          state = 'ACTIONED',
          actioned_at = NOW()
        WHERE id = $1
          AND site_id = $2
          AND state = 'SCORED'
        RETURNING
          id,
          session_id,
          action,
          state
      `,
      [decisionId, siteId]
    );

    if (!result.rowCount) {
      return failure(
        res,
        409,
        "Decision is not in SCORED state or does not belong to this site"
      );
    }

    return success(res, {
      decision: result.rows[0],
    });
  } catch (error) {
    console.error("[ACTION ERROR]", error);

    return failure(
      res,
      500,
      "Unable to action decision"
    );
  }
});

/* =========================================================
   OUTCOME
========================================================= */

app.post("/outcome", async (req, res) => {
  const siteId = req.site.site_id;

  const decisionId = Number(
    req.body?.decision_id ??
      req.body?.decisionId
  );

  const converted = normalizeBoolean(
    req.body?.converted
  );

  const revenue = Math.max(
    0,
    validateNumber(req.body?.revenue, 0)
  );

  if (!Number.isInteger(decisionId)) {
    return failure(
      res,
      400,
      "Valid decision_id is required"
    );
  }

  try {
    const result = await db.query(
      `
        UPDATE decisions
        SET
          state = 'COMPLETED',
          converted = $3,
          revenue = $4,
          completed_at = NOW()
        WHERE id = $1
          AND site_id = $2
          AND state = 'ACTIONED'
        RETURNING
          id,
          session_id,
          action,
          converted,
          revenue,
          completed_at
      `,
      [
        decisionId,
        siteId,
        converted,
        revenue,
      ]
    );

    if (!result.rowCount) {
      const existing = await db.query(
        `
          SELECT id, state
          FROM decisions
          WHERE id = $1
            AND site_id = $2
          LIMIT 1
        `,
        [decisionId, siteId]
      );

      if (!existing.rowCount) {
        return failure(
          res,
          404,
          "Decision not found"
        );
      }

      return failure(
        res,
        409,
        "Decision is not in ACTIONED state"
      );
    }

    const decision =
      result.rows[0];

    await updateBandit(
      siteId,
      decision.action,
      converted
    );

    return success(res, {
      decision,
    });
  } catch (error) {
    console.error("[OUTCOME ERROR]", error);

    return failure(
      res,
      500,
      "Unable to record outcome"
    );
  }
});

/* =========================================================
   METRICS
========================================================= */

app.get("/metrics", async (req, res) => {
  const siteId = req.site.site_id;

  try {
    const result = await db.query(
      `
        SELECT
          COUNT(*)::INTEGER AS decisions,

          COUNT(*) FILTER (
            WHERE converted = TRUE
          )::INTEGER AS conversions,

          COALESCE(
            SUM(revenue),
            0
          )::NUMERIC AS revenue

        FROM decisions
        WHERE site_id = $1
          AND state = 'COMPLETED'
      `,
      [siteId]
    );

    const row = result.rows[0];

    return success(res, {
      decisions: Number(row.decisions || 0),
      conversions: Number(
        row.conversions || 0
      ),
      revenue: Number(row.revenue || 0),
    });
  } catch (error) {
    console.error("[METRICS ERROR]", error);

    return failure(
      res,
      500,
      "Unable to load metrics"
    );
  }
});

/* =========================================================
   RECOVERY CRON
========================================================= */

cron.schedule(
  "*/15 * * * *",
  async () => {
    const client = await db.connect();

    try {
      await client.query(`
        UPDATE recovery_queue
        SET
          status = 'PENDING',
          updated_at = NOW()
        WHERE status = 'PROCESSING'
          AND updated_at < NOW() - INTERVAL '30 minutes'
      `);

      await client.query("BEGIN");

      const jobs = await client.query(
        `
          SELECT
            id,
            site_id,
            session_id,
            customer_email,
            discount_percent
          FROM recovery_queue
          WHERE status = 'PENDING'
          ORDER BY created_at ASC
          LIMIT 20
          FOR UPDATE SKIP LOCKED
        `
      );

      for (const job of jobs.rows) {
        await client.query(
          `
            UPDATE recovery_queue
            SET
              status = 'PROCESSING',
              updated_at = NOW()
            WHERE id = $1
          `,
          [job.id]
        );
      }

      await client.query("COMMIT");

      for (const job of jobs.rows) {
        try {
          const converted = await db.query(
            `
              SELECT id
              FROM decisions
              WHERE site_id = $1
                AND session_id = $2
                AND converted = TRUE
                AND state = 'COMPLETED'
              LIMIT 1
            `,
            [
              job.site_id,
              job.session_id,
            ]
          );

          if (converted.rowCount) {
            await db.query(
              `
                UPDATE recovery_queue
                SET
                  status = 'COMPLETED',
                  updated_at = NOW()
                WHERE id = $1
              `,
              [job.id]
            );

            continue;
          }

          /*
           * No email captured on this session -- nothing to
           * send to. Mark FAILED rather than retrying this
           * job every 15 minutes forever.
           */
          if (!job.customer_email) {
            console.warn(
              "[RECOVERY] No customer_email on job, skipping:",
              { jobId: job.id, siteId: job.site_id }
            );

            await db.query(
              `
                UPDATE recovery_queue
                SET
                  status = 'FAILED',
                  updated_at = NOW()
                WHERE id = $1
              `,
              [job.id]
            );

            continue;
          }

          const siteResult = await db.query(
            `
              SELECT
                site_id,
                name,
                owner_email
              FROM sites
              WHERE site_id = $1
                AND active = TRUE
              LIMIT 1
            `,
            [job.site_id]
          );

          if (!siteResult.rowCount) {
            throw new Error(
              `Site ${job.site_id} not found`
            );
          }

          const site =
            siteResult.rows[0];

          await sendRecoveryEmail({
            site,
            sessionId: job.session_id,
            customerEmail: job.customer_email,
            discountPercent:
              job.discount_percent,
          });

          await db.query(
            `
              UPDATE recovery_queue
              SET
                status = 'SENT',
                updated_at = NOW()
              WHERE id = $1
            `,
            [job.id]
          );

          await db.query(
            `
              INSERT INTO email_logs (
                site_id,
                session_id,
                type,
                status,
                created_at
              )
              VALUES (
                $1,
                $2,
                'RECOVERY',
                'SENT',
                NOW()
              )
            `,
            [
              job.site_id,
              job.session_id,
            ]
          );
        } catch (error) {
          console.error(
            "[RECOVERY JOB ERROR]",
            {
              jobId: job.id,
              error,
            }
          );

          await db.query(
            `
              UPDATE recovery_queue
              SET
                status = 'FAILED',
                updated_at = NOW()
              WHERE id = $1
            `,
            [job.id]
          );
        }
      }
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "[RECOVERY CRON ERROR]",
        error
      );
    } finally {
      client.release();
    }
  },
  {
    timezone: "UTC",
  }
);

/* =========================================================
   DAILY REPORT CRON
========================================================= */

cron.schedule(
  "0 8 * * *",
  async () => {
    const client = await db.connect();

    try {
      const lockResult = await client.query(
        `
          SELECT pg_try_advisory_lock(
            hashtext('reden_daily_report')
          ) AS locked
        `
      );

      if (!lockResult.rows[0]?.locked) {
        return;
      }

      try {
        const sitesResult = await client.query(`
          SELECT
            site_id,
            name,
            owner_email,
            timezone
          FROM sites
          WHERE active = TRUE
        `);

        for (const site of sitesResult.rows) {
          try {
            const metricsResult =
              await client.query(
                `
                  SELECT
                    COUNT(*)::INTEGER AS decisions,

                    COUNT(*) FILTER (
                      WHERE converted = TRUE
                    )::INTEGER AS conversions,

                    COALESCE(
                      SUM(revenue),
                      0
                    )::NUMERIC AS revenue

                  FROM decisions
                  WHERE site_id = $1
                    AND state = 'COMPLETED'
                    AND completed_at >= NOW() - INTERVAL '24 hours'
                `,
                [site.site_id]
              );

            const metrics =
              metricsResult.rows[0];

            await sendDailyReport({
              site,
              metrics: {
                decisions: Number(
                  metrics.decisions || 0
                ),
                conversions: Number(
                  metrics.conversions || 0
                ),
                revenue: Number(
                  metrics.revenue || 0
                ),
              },
            });

            await client.query(
              `
                INSERT INTO email_logs (
                  site_id,
                  type,
                  status,
                  created_at
                )
                VALUES (
                  $1,
                  'DAILY_REPORT',
                  'SENT',
                  NOW()
                )
              `,
              [site.site_id]
            );
          } catch (error) {
            console.error(
              "[DAILY REPORT SITE ERROR]",
              {
                siteId: site.site_id,
                error,
              }
            );
          }
        }
      } finally {
        await client.query(
          `
            SELECT pg_advisory_unlock(
              hashtext('reden_daily_report')
            )
          `
        );
      }
    } catch (error) {
      console.error(
        "[DAILY REPORT CRON ERROR]",
        error
      );
    } finally {
      client.release();
    }
  },
  {
    timezone: "UTC",
  }
);

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  return failure(
    res,
    404,
    "Route not found"
  );
});

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  console.error("[GLOBAL ERROR]", {
    requestId: req.requestId,
    error,
  });

  if (res.headersSent) {
    return next(error);
  }

  return failure(
    res,
    500,
    "Internal server error"
  );
});

/* =========================================================
   SERVER
========================================================= */

const server = app.listen(PORT, () => {
  console.log(
    `[REDEN] API listening on port ${PORT}`
  );
});

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(signal) {
  console.log(
    `[REDEN] ${signal} received. Shutting down...`
  );

  server.close(async () => {
    try {
      if (redis?.quit) {
        await redis.quit();
      }
    } catch (error) {
      console.error(
        "[REDIS SHUTDOWN ERROR]",
        error
      );
    }

    try {
      await db.end();
    } catch (error) {
      console.error(
        "[DATABASE SHUTDOWN ERROR]",
        error
      );
    }

    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () =>
  shutdown("SIGTERM")
);

process.on("SIGINT", () =>
  shutdown("SIGINT")
);
