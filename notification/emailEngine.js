import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

/* ─────────────────────────────────────────────
   CORE SEND ENGINE
───────────────────────────────────────────── */
export async function sendEmail({ to, subject, html, from, replyTo }) {
  try {
    const response = await resend.emails.send({
      from: from || "REDEN <noreply@dcore.name.ng>",
      to,
      subject,
      html,
      reply_to: replyTo || "redenbydcore@gmail.com",
    });

    console.log("[EMAIL SENT]", response.data?.id);

    return {
      ok: true,
      id: response.data?.id,
    };
  } catch (e) {
    console.error("[EMAIL ERROR]", e);

    return {
      ok: false,
      error: e.message,
    };
  }
}

/* ─────────────────────────────────────────────
   WELCOME EMAIL (WITH STEP-BY-STEP ADVICE)
───────────────────────────────────────────── */
export async function sendWelcomeEmail({ to, siteId, apiKey, plan = "basic" }) {
  return sendEmail({
    to,
    subject: "Your REDEN Infrastructure Is Ready",
    html: `
      <div
        style="
          background:#05070b;
          color:#ffffff;
          padding:40px;
          font-family:Inter,Arial,sans-serif;
        "
      >
        <h1
          style="
            font-size:32px;
            margin-bottom:10px;
            letter-spacing:-0.04em;
          "
        >
          REDEN Operational
        </h1>

        <p
          style="
            color:#9ca3af;
            line-height:1.7;
          "
        >
          Your adaptive decision infrastructure has been provisioned successfully under the <strong>${plan}</strong> tier.
        </p>

        <!-- SECURITY CREDENTIALS CONTAINER -->
        <div
          style="
            margin-top:30px;
            padding:20px;
            border:1px solid #1f2937;
            border-radius:14px;
            background:#0b0f17;
          "
        >
          <p style="margin:0 0 5px 0; color:#9ca3af;"><strong>Site ID</strong></p>
          <code style="color:#38bdf8; font-family:monospace; font-size:14px;">${siteId}</code>

          <br /><br />

          <p style="margin:0 0 5px 0; color:#9ca3af;"><strong>API Key</strong></p>
          <code style="color:#34d399; font-family:monospace; font-size:14px;">${apiKey}</code>
        </div>

        <!-- EMBED INSTRUCTIONS -->
        <div
          style="
            margin-top:30px;
          "
        >
          <p style="color:#9ca3af; margin-bottom:10px;">SDK Integration Code:</p>
          <pre
            style="
              background:#0b0f17;
              padding:15px;
              border:1px solid #1f2937;
              border-radius:8px;
              overflow-x:auto;
              margin:0;
            "
          ><code style="color:#e2e8f0; font-size:12px;">&lt;script 
  src="https://api.dcore.name.ng/sdk.js"
  data-site-id="${siteId}"
  data-api-key="${apiKey}"
&gt;&lt;/script&gt;</code></pre>
        </div>

        <!-- 🚀 NEXT STEPS ACTIONABLE ADVICE -->
        <div
          style="
            margin-top:40px;
            border-top:1px solid #1f2937;
            padding-top:30px;
          "
        >
          <h3 style="font-size:18px; color:#ffffff; margin-bottom:15px; margin-top:0;">What to do next:</h3>
          
          <ol style="color:#9ca3af; line-height:1.8; padding-left:20px; margin:0;">
            <li style="margin-bottom:12px;">
              <strong style="color:#ffffff;">Install the Script:</strong> Copy the script tag above and paste it inside the <code style="color:#e2e8f0; background:#0b0f17; padding:2px 6px; border-radius:4px; font-family:monospace;">&lt;head&gt;</code> element of your website or store app layout.
            </li>
            <li style="margin-bottom:12px;">
              <strong style="color:#ffffff;">Verify Base Telemetry:</strong> Reload your website live. Check your server metrics log dashboard stream to verify that the automatic <code style="color:#38bdf8; font-family:monospace;">PAGE_VIEW</code> pipeline fires.
            </li>
            <li style="margin-bottom:12px;">
              <strong style="color:#ffffff;">Track Your Checkouts:</strong> Ensure your application triggers payloads on checkout events to begin feeding the automated Multi-Armed Bandit model optimizations.
            </li>
          </ol>
          
          <div
            style="
              margin-top:25px;
              background:#0b0f17;
              padding:15px;
              border-radius:8px;
              border:1px dashed #1f2937;
            "
          >
            <p style="margin:0; font-size:13px; color:#9ca3af;">
              💡 <strong>Developer Support:</strong> If you need any architectural assistance or integration troubleshooting, simply reply to this email directly.
            </p>
          </div>
        </div>

      </div>
    `,
  });
}

/* ─────────────────────────────────────────────
   DAILY OWNER REPORT
───────────────────────────────────────────── */
export async function sendDailyReport({ to, merchantName, metrics }) {
  // Destructure metrics layer variables safely to guard against structural mismatches
  const total = metrics?.total ?? 0;
  const conversions = metrics?.conversions ?? 0;
  const revenue = metrics?.revenue ?? 0;

  return sendEmail({
    to,
    subject: "REDEN Daily Intelligence Report",
    html: `
      <div
        style="
          background:#05070b;
          color:#ffffff;
          padding:40px;
          font-family:Inter,Arial,sans-serif;
        "
      >
        <h1 style="font-size:24px; margin-bottom:5px;">Daily Performance Summary</h1>
        <p style="color:#9ca3af; margin-top:0;">Tenant: <strong>${merchantName || "Active Merchant"}</strong></p>

        <div
          style="
            margin-top:30px;
            background:#0b0f17;
            border:1px solid #1f2937;
            border-radius:14px;
            padding:24px;
          "
        >
          <table style="width:100%; border-collapse:collapse; color:#ffffff;">
            <tr>
              <td style="padding:12px 0; color:#9ca3af; border-bottom:1px solid #1f2937;">Total Checked Evaluations:</td>
              <td style="padding:12px 0; text-align:right; font-weight:bold; border-bottom:1px solid #1f2937;">${total}</td>
            </tr>
            <tr>
              <td style="padding:12px 0; color:#9ca3af; border-bottom:1px solid #1f2937;">Optimized Conversions:</td>
              <td style="padding:12px 0; text-align:right; font-weight:bold; color:#34d399; border-bottom:1px solid #1f2937;">${conversions}</td>
            </tr>
            <tr>
              <td style="padding:12px 0; color:#9ca3af;">Tracked Pipeline Revenue:</td>
              <td style="padding:12px 0; text-align:right; font-weight:bold; color:#38bdf8;">$${revenue}</td>
            </tr>
          </table>
        </div>

      </div>
    `,
  });
}

/* ─────────────────────────────────────────────
   RECOVERY EMAIL
───────────────────────────────────────────── */
export async function sendRecoveryEmail({ to, incentive, cart }) {
  // Gracefully handles both raw data strings or objects parsed out of CRON rows
  const rewardLabel = incentive || "Special Promotional Reward";

  return sendEmail({
    to,
    subject: "Complete your checkout session",
    html: `
      <div
        style="
          background:#05070b;
          color:#ffffff;
          padding:40px;
          font-family:Inter,Arial,sans-serif;
        "
      >
        <h1 style="font-size:24px; margin-bottom:15px;">Continue Your Session</h1>

        <p
          style="
            color:#9ca3af;
            line-height:1.7;
          "
        >
          We noticed you left items in your cart configuration. To help streamline your evaluation, we have locked in a reward option for your checkout path.
        </p>

        <div
          style="
            margin-top:30px;
            background:#0b0f17;
            border:1px solid #1f2937;
            border-radius:14px;
            padding:24px;
            text-align:center;
          "
        >
          <p style="color:#9ca3af; margin:0 0 10px 0; font-size:14px; text-transform:uppercase; letter-spacing:0.05em;">
            Incentive Allocated:
          </p>

          <h2 style="color:#f43f5e; font-size:36px; margin:0; font-weight:800; letter-spacing:-0.02em;">
            ${rewardLabel}
          </h2>
        </div>

      </div>
    `,
  });
}
