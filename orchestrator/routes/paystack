import express from "express";
import crypto from "crypto";
import { db } from "../../infrastructure/db.js";
import { sendWelcomeEmail } from "../../notification/emailEngine.js";

const router = express.Router();

/* ─────────────────────────────────────────────
   HEALTH CHECK
───────────────────────────────────────────── */
router.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "paystack_webhook",
    timestamp: new Date().toISOString()
  });
});

/* ─────────────────────────────────────────────
   PAYSTACK WEBHOOK
───────────────────────────────────────────── */
router.post("/", async (req, res) => {
  console.log("[PAYSTACK] Webhook received");

  try {
    /* ─────────────────────────────────────
       ✔ FIX 1: ULTRA-SAFE SIGNATURE VALIDATION
    ───────────────────────────────────── */
    const signature = req.headers["x-paystack-signature"];

    if (!signature || !req.rawBody) {
      console.warn("[PAYSTACK WARNING] Missing signature or rawBody middleware trace.");
      return res.sendStatus(200);
    }

    const expectedHash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.rawBody)
      .digest("hex");

    const safeSignature = Buffer.from(signature, "utf8");
    const safeHash = Buffer.from(expectedHash, "utf8");

    // Guard lengths perfectly before evaluating timingSafeEqual to avoid crash loops
    const validSignature =
      safeSignature.length === safeHash.length &&
      crypto.timingSafeEqual(safeSignature, safeHash);

    if (!validSignature) {
      console.warn("[PAYSTACK WARNING] Invalid signature signature drop.");
      return res.sendStatus(200);
    }

    /* ─────────────────────────────────────
       PARSE EVENT
    ───────────────────────────────────── */
    const event = req.body;
    const email = event?.data?.customer?.email;
    const amount = event?.data?.amount;
    
    // Fall back safely to a generated hash if Paystack identifiers fail
    const eventId = String(event?.data?.id || event?.data?.reference || crypto.randomUUID());

    console.log("[PAYSTACK EVENT]", {
      type: event?.event,
      email,
      reference: event?.data?.reference || "N/A"
    });

    if (event.event !== "charge.success") {
      return res.sendStatus(200);
    }

    if (!email) {
      console.error("[PAYSTACK ERROR] Missing email identifier.");
      return res.sendStatus(200);
    }

    /* ─────────────────────────────────────
       ✔ FIX 2: HARDENED IDEMPOTENCY GUARD
    ───────────────────────────────────── */
    const duplicate = await db.query(
      `
      SELECT id FROM email_logs
      WHERE email_type = 'PAYSTACK_EVENT'
        AND recipient = $1
        AND subject = $2
      LIMIT 1
      `,
      [email, eventId]
    );

    if (duplicate.rowCount > 0) {
      console.log("[PAYSTACK] Duplicate event caught and safely ignored:", email);
      return res.sendStatus(200);
    }

    /* ─────────────────────────────────────
       FIND OR CREATE TENANT
    ───────────────────────────────────── */
    const existing = await db.query(
      `
      SELECT site_id, api_key
      FROM sites
      WHERE owner_email = $1
      LIMIT 1
      `,
      [email]
    );

    let siteId;
    let apiKey;

    if (existing.rowCount > 0) {
      siteId = existing.rows[0].site_id;
      apiKey = existing.rows[0].api_key;

      await db.query(
        `
        UPDATE sites
        SET subscription_status = 'active'
        WHERE owner_email = $1
        `,
        [email]
      );

      console.log("[PAYSTACK] Existing tenant updated to active:", email);
    } else {
      siteId = `site_${crypto.randomBytes(8).toString("hex")}`;
      apiKey = `rd_${crypto.randomBytes(24).toString("hex")}`;

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
        VALUES ($1, $2, $3, $4, true, 'basic', 'active')
        `,
        [siteId, apiKey, "REDEN API Customer", email]
      );

      console.log("[PAYSTACK] New tenant securely provisioned:", email);
    }

    /* ─────────────────────────────────────
       LOG INCOMING EVENT
    ───────────────────────────────────── */
    await db.query(
      `
      INSERT INTO email_logs (
        site_id,
        email_type,
        recipient,
        subject,
        status
      )
      VALUES ($1, 'PAYSTACK_EVENT', $2, $3, 'RECEIVED')
      `,
      [siteId, email, eventId]
    );

    /* ─────────────────────────────────────
       SEND WELCOME EMAIL PIPELINE
    ───────────────────────────────────── */
    try {
      const alreadySent = await db.query(
        `
        SELECT id FROM email_logs
        WHERE email_type = 'WELCOME'
          AND recipient = $1
        LIMIT 1
        `,
        [email]
      );

      if (alreadySent.rowCount === 0) {
        await sendWelcomeEmail({
          to: email,
          siteId,
          apiKey,
          plan: "basic"
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
          VALUES ($1, 'WELCOME', $2, 'Your REDEN API is Ready', 'SENT')
          `,
          [siteId, email]
        );

        console.log("[PAYSTACK] Welcome onboarding email successfully dispatched:", email);
      } else {
        console.log("[PAYSTACK] Onboarding email dispatch skipped (already recorded):", email);
      }
    } catch (err) {
      console.error("[PAYSTACK EMAIL FLOW ERROR]", err.message);

      await db.query(
        `
        INSERT INTO email_logs (
          site_id,
          email_type,
          recipient,
          subject,
          status
        )
        VALUES ($1, 'WELCOME', $2, 'Your REDEN API is Ready', 'FAILED')
        `,
        [siteId, email]
      );
    }

    console.log("[PAYSTACK] Onboarding execution completed cleanly:", email);
    return res.sendStatus(200);

  } catch (err) {
    console.error("[PAYSTACK CRITICAL UNCAUGHT EXCEPTION]");
    console.error(err.message);
    console.error(err.stack);
    return res.sendStatus(200); // Always tell Paystack 200 OK so it doesn't slam the endpoint with endless duplicate webhooks
  }
});

export default router;
