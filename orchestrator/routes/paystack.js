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
        ✔ ULTRA-SAFE SIGNATURE VALIDATION
    ───────────────────────────────────── */
    const signature = req.headers["x-paystack-signature"];

    if (!signature || !req.rawBody) {
      console.warn("[PAYSTACK WARNING] Missing signature or rawBody middleware trace.");
      return res.sendStatus(200); // Exits silently if express raw body parser isn't configured
    }

    const expectedHash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.rawBody)
      .digest("hex");

    const safeSignature = Buffer.from(signature, "utf8");
    const safeHash = Buffer.from(expectedHash, "utf8");

    const validSignature =
      safeSignature.length === safeHash.length &&
      crypto.timingSafeEqual(safeSignature, safeHash);

    if (!validSignature) {
      console.warn("[PAYSTACK WARNING] Invalid signature signature drop.");
      return res.sendStatus(200);
    }

    /* ─────────────────────────────────────
        PARSE EVENT & TEMPORARY DEBUG TRACE
    ───────────────────────────────────── */
    const event = req.body;
    
    // 🔍 TEMPORARY CRITICAL DEBUG LOG
    console.log(
      "[PAYSTACK EVENT TYPE DETECTED]",
      event.event,
      JSON.stringify(event.data, null, 2)
    );

    const email = event?.data?.customer?.email;
    const eventId = String(event?.data?.id || event?.data?.reference || crypto.randomUUID());

    if (!email) {
      console.error("[PAYSTACK ERROR] Missing email identifier.");
      return res.sendStatus(200);
    }

    /* ─────────────────────────────────────
        ✔ HARDENED IDEMPOTENCY GUARD
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
        ✔ BLENDED PROVISIONING CONTROLLER
        Handles both edge-case orders flawlessly
    ───────────────────────────────────── */
    const isProvisioningEvent = 
      event.event === "subscription.create" || 
      event.event === "charge.success";

    if (isProvisioningEvent) {
      // Check if user already has an infrastructure site allocated
      const existing = await db.query(
        `SELECT site_id FROM sites WHERE owner_email = $1 LIMIT 1`,
        [email]
      );

      let siteId;
      let rawApiKey;

      if (existing.rowCount === 0) {
        // Tenant doesn't exist yet! Run absolute provisioning
        siteId = `site_${crypto.randomBytes(8).toString("hex")}`;
        rawApiKey = `rd_${crypto.randomBytes(24).toString("hex")}`;

        const apiKeyHash = crypto
          .createHash("sha256")
          .update(rawApiKey)
          .digest("hex");

        await db.query(
          `
          INSERT INTO sites (
            site_id,
            api_key_hash,
            name,
            owner_email,
            active,
            plan,
            subscription_status
          )
          VALUES ($1, $2, $3, $4, true, 'basic', 'active')
          `,
          [siteId, apiKeyHash, "REDEN API Customer", email]
        );

        console.log("[PAYSTACK] New tenant safely provisioned via blended event handler:", email);

        // Record event receipt immediately to block race conditions
        await db.query(
          `
          INSERT INTO email_logs (site_id, email_type, recipient, subject, status)
          VALUES ($1, 'PAYSTACK_EVENT', $2, $3, 'RECEIVED')
          `,
          [siteId, email, eventId]
        );

        /* ─────────────────────────────────────
            DISPATCH ONBOARDING EMAIL
        ───────────────────────────────────── */
        try {
          await sendWelcomeEmail({
            to: email,
            siteId,
            apiKey: rawApiKey, // Sent directly once over encrypted transit
            plan: "basic"
          });

          await db.query(
            `
            INSERT INTO email_logs (site_id, email_type, recipient, subject, status)
            VALUES ($1, 'WELCOME', $2, 'Your REDEN API is Ready', 'SENT')
            `,
            [siteId, email]
          );
        } catch (err) {
          console.error("[PAYSTACK EMAIL FLOW ERROR]", err.message);
          await db.query(
            `
            INSERT INTO email_logs (site_id, email_type, recipient, subject, status)
            VALUES ($1, 'WELCOME', $2, 'Your REDEN API is Ready', 'FAILED')
            `,
            [siteId, email]
          );
        }

      } else {
        // Tenant already exists, simply step up subscription status to active (Renewal sync)
        siteId = existing.rows[0].site_id;
        
        await db.query(
          `
          UPDATE sites
          SET subscription_status = 'active'
          WHERE owner_email = $1
          `,
          [email]
        );

        console.log("[PAYSTACK] Existing tenant state verified active via blended hook:", email);
        
        await db.query(
          `
          INSERT INTO email_logs (site_id, email_type, recipient, subject, status)
          VALUES ($1, 'PAYSTACK_EVENT', $2, $3, 'RECEIVED')
          `,
          [siteId, email, eventId]
        );
      }

      return res.sendStatus(200);
    }

    /* ─────────────────────────────────────
        LIFECYCLE EVENTS (Invoices, Retries, etc.)
    ───────────────────────────────────── */
    if (event.event === "invoice.create") {
      const updateResult = await db.query(
        `
        UPDATE sites
        SET subscription_status = 'active'
        WHERE owner_email = $1
        RETURNING site_id
        `,
        [email]
      );

      if (updateResult.rowCount > 0) {
        await db.query(
          `
          INSERT INTO email_logs (site_id, email_type, recipient, subject, status)
          VALUES ($1, 'PAYSTACK_EVENT', $2, $3, 'RECEIVED')
          `,
          [updateResult.rows[0].site_id, email, eventId]
        );
      }
      
      return res.sendStatus(200);
    }

    // Capture unhandled hook variants cleanly
    return res.sendStatus(200);

  } catch (err) {
    console.error("[PAYSTACK CRITICAL UNCAUGHT EXCEPTION]");
    console.error(err.message);
    return res.sendStatus(200);
  }
});

export default router;
