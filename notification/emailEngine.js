import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

/* ─────────────────────────────────────────────
   CORE SEND ENGINE
───────────────────────────────────────────── */

export async function sendEmail({
  to,
  subject,
  html,
  from,
  replyTo,
}) {
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
      error: e?.message || "email_send_failed",
    };
  }
}

/* ─────────────────────────────────────────────
   HTML HELPERS
───────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/* ─────────────────────────────────────────────
   REDEN EMAIL SHELL
───────────────────────────────────────────── */

function emailShell({
  merchantName,
  eyebrow,
  title,
  intro,
  content,
}) {
  return `
    <div
      style="
        background:#05070b;
        color:#ffffff;
        padding:40px 24px;
        font-family:Inter,Arial,sans-serif;
      "
    >
      <div
        style="
          max-width:680px;
          margin:0 auto;
        "
      >

        <div
          style="
            font-size:12px;
            letter-spacing:0.12em;
            text-transform:uppercase;
            color:#6b7280;
            margin-bottom:18px;
          "
        >
          ${escapeHtml(eyebrow || "REDEN")}
        </div>

        <h1
          style="
            font-size:30px;
            line-height:1.15;
            letter-spacing:-0.04em;
            margin:0 0 12px 0;
          "
        >
          ${escapeHtml(title)}
        </h1>

        ${
          merchantName
            ? `
              <p
                style="
                  color:#6b7280;
                  margin:0 0 22px 0;
                  font-size:14px;
                "
              >
                ${escapeHtml(merchantName)}
              </p>
            `
            : ""
        }

        ${
          intro
            ? `
              <p
                style="
                  color:#a1a1aa;
                  line-height:1.75;
                  font-size:15px;
                  margin:0 0 28px 0;
                "
              >
                ${intro}
              </p>
            `
            : ""
        }

        ${content}

        <div
          style="
            margin-top:40px;
            padding-top:20px;
            border-top:1px solid #1f2937;
            color:#52525b;
            font-size:12px;
            line-height:1.6;
          "
        >
          REDEN by DCORE<br />
          Revenue intelligence infrastructure
        </div>

      </div>
    </div>
  `;
}

/* ─────────────────────────────────────────────
   INTELLIGENCE CARD
───────────────────────────────────────────── */

function intelligenceCard(item) {
  const priority = item?.priority || "normal";

  const priorityLabel = {
    critical: "Requires attention",
    high: "Worth your attention",
    normal: "REDEN noticed",
    low: "Observation",
  }[priority] || "REDEN noticed";

  return `
    <div
      style="
        margin-bottom:18px;
        padding:24px;
        background:#0b0f17;
        border:1px solid #1f2937;
        border-radius:14px;
      "
    >

      <div
        style="
          font-size:11px;
          letter-spacing:0.08em;
          text-transform:uppercase;
          color:#6b7280;
          margin-bottom:10px;
        "
      >
        ${escapeHtml(priorityLabel)}
      </div>

      <h2
        style="
          margin:0 0 12px 0;
          font-size:19px;
          line-height:1.35;
          letter-spacing:-0.02em;
        "
      >
        ${escapeHtml(item?.title || "REDEN noticed something.")}
      </h2>

      ${
        item?.summary
          ? `
            <p
              style="
                color:#d4d4d8;
                line-height:1.7;
                margin:0 0 18px 0;
                font-size:14px;
              "
            >
              ${escapeHtml(item.summary)}
            </p>
          `
          : ""
      }

      ${
        item?.why_it_matters
          ? `
            <div style="margin-top:16px;">
              <div
                style="
                  color:#71717a;
                  font-size:11px;
                  text-transform:uppercase;
                  letter-spacing:0.08em;
                  margin-bottom:6px;
                "
              >
                Why it matters
              </div>

              <div
                style="
                  color:#a1a1aa;
                  line-height:1.6;
                  font-size:13px;
                "
              >
                ${escapeHtml(item.why_it_matters)}
              </div>
            </div>
          `
          : ""
      }

      ${
        item?.likely_cause
          ? `
            <div style="margin-top:16px;">
              <div
                style="
                  color:#71717a;
                  font-size:11px;
                  text-transform:uppercase;
                  letter-spacing:0.08em;
                  margin-bottom:6px;
                "
              >
                What REDEN thinks is happening
              </div>

              <div
                style="
                  color:#a1a1aa;
                  line-height:1.6;
                  font-size:13px;
                "
              >
                ${escapeHtml(item.likely_cause)}
              </div>
            </div>
          `
          : ""
      }

      ${
        item?.recommendation
          ? `
            <div
              style="
                margin-top:20px;
                padding:16px;
                background:#080b11;
                border:1px dashed #374151;
                border-radius:10px;
              "
            >
              <div
                style="
                  color:#71717a;
                  font-size:11px;
                  text-transform:uppercase;
                  letter-spacing:0.08em;
                  margin-bottom:7px;
                "
              >
                REDEN recommends
              </div>

              <div
                style="
                  color:#ffffff;
                  line-height:1.6;
                  font-size:13px;
                "
              >
                ${escapeHtml(item.recommendation)}
              </div>
            </div>
          `
          : ""
      }

    </div>
  `;
}

/* ─────────────────────────────────────────────
   NO-INTELLIGENCE STATE
───────────────────────────────────────────── */

function nothingRequiresAttention() {
  return `
    <div
      style="
        padding:30px 24px;
        background:#0b0f17;
        border:1px solid #1f2937;
        border-radius:14px;
        text-align:center;
      "
    >
      <h2
        style="
          margin:0 0 10px 0;
          font-size:19px;
          letter-spacing:-0.02em;
        "
      >
        Nothing requires your attention right now.
      </h2>

      <p
        style="
          color:#71717a;
          line-height:1.7;
          margin:0;
          font-size:14px;
        "
      >
        REDEN is continuing to watch the business.
        If something materially changes, we'll bring it to you.
      </p>
    </div>
  `;
}

/* ─────────────────────────────────────────────
   MORNING INTELLIGENCE
───────────────────────────────────────────── */

export async function sendMorningReport({
  to,
  merchantName,
  intelligence = [],
  metrics = {},
}) {
  const important = intelligence.filter(
    (item) =>
      item?.status !== "dismissed" &&
      item?.status !== "resolved"
  );

  const content =
    important.length > 0
      ? `
        ${important
          .map(intelligenceCard)
          .join("")}

        <div
          style="
            margin-top:26px;
            padding:20px;
            background:#0b0f17;
            border:1px solid #1f2937;
            border-radius:14px;
          "
        >
          <div
            style="
              color:#71717a;
              font-size:11px;
              text-transform:uppercase;
              letter-spacing:0.08em;
              margin-bottom:14px;
            "
          >
            Evidence
          </div>

          <table
            style="
              width:100%;
              border-collapse:collapse;
            "
          >
            <tr>
              <td style="padding:8px 0;color:#71717a;">
                Evaluations
              </td>
              <td style="padding:8px 0;text-align:right;">
                ${formatNumber(metrics.total)}
              </td>
            </tr>

            <tr>
              <td style="padding:8px 0;color:#71717a;">
                Conversions
              </td>
              <td style="padding:8px 0;text-align:right;">
                ${formatNumber(metrics.conversions)}
              </td>
            </tr>

            <tr>
              <td style="padding:8px 0;color:#71717a;">
                Revenue
              </td>
              <td style="padding:8px 0;text-align:right;">
                ${formatMoney(metrics.revenue)}
              </td>
            </tr>
          </table>
        </div>
      `
      : nothingRequiresAttention();

  const html = emailShell({
    merchantName,
    eyebrow: "REDEN Morning Brief",
    title: "Here's what REDEN thinks matters.",
    intro:
      "REDEN reviewed the activity from the previous period and filtered out the noise. These are the things worth knowing before you start the day.",
    content,
  });

  return sendEmail({
    to,
    subject:
      important.length > 0
        ? "REDEN Morning Intelligence Brief"
        : "REDEN Morning Brief — Nothing Requires Attention",
    html,
  });
}

/* ─────────────────────────────────────────────
   EVENING INTELLIGENCE
───────────────────────────────────────────── */

export async function sendEveningReport({
  to,
  merchantName,
  intelligence = [],
  metrics = {},
}) {
  const important = intelligence.filter(
    (item) =>
      item?.status !== "dismissed"
  );

  const content =
    important.length > 0
      ? `
        ${important
          .map(intelligenceCard)
          .join("")}

        <div
          style="
            margin-top:26px;
            padding:20px;
            background:#0b0f17;
            border:1px solid #1f2937;
            border-radius:14px;
          "
        >
          <div
            style="
              color:#71717a;
              font-size:11px;
              text-transform:uppercase;
              letter-spacing:0.08em;
              margin-bottom:14px;
            "
          >
            Today's evidence
          </div>

          <table
            style="
              width:100%;
              border-collapse:collapse;
            "
          >
            <tr>
              <td style="padding:8px 0;color:#71717a;">
                Evaluations
              </td>
              <td style="padding:8px 0;text-align:right;">
                ${formatNumber(metrics.total)}
              </td>
            </tr>

            <tr>
              <td style="padding:8px 0;color:#71717a;">
                Conversions
              </td>
              <td style="padding:8px 0;text-align:right;">
                ${formatNumber(metrics.conversions)}
              </td>
            </tr>

            <tr>
              <td style="padding:8px 0;color:#71717a;">
                Revenue
              </td>
              <td style="padding:8px 0;text-align:right;">
                ${formatMoney(metrics.revenue)}
              </td>
            </tr>
          </table>
        </div>
      `
      : nothingRequiresAttention();

  const html = emailShell({
    merchantName,
    eyebrow: "REDEN Evening Brief",
    title: "Here's what happened today.",
    intro:
      "REDEN reviewed today's business activity and surfaced only the events that materially changed the picture.",
    content,
  });

  return sendEmail({
    to,
    subject:
      important.length > 0
        ? "REDEN Evening Intelligence Brief"
        : "REDEN Evening Brief — Nothing Requires Attention",
    html,
  });
}

/* ─────────────────────────────────────────────
   BACKWARD-COMPATIBLE DAILY REPORT
   Existing server.js can still call this.
───────────────────────────────────────────── */

export async function sendDailyReport({
  to,
  merchantName,
  metrics,
  intelligence = [],
}) {
  return sendEveningReport({
    to,
    merchantName,
    metrics,
    intelligence,
  });
}

/* ─────────────────────────────────────────────
   WELCOME EMAIL
───────────────────────────────────────────── */

export async function sendWelcomeEmail({
  to,
  siteId,
  apiKey,
  plan = "basic",
}) {
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
        <div style="max-width:680px;margin:0 auto;">

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
            Your REDEN infrastructure has been provisioned
            successfully under the
            <strong>${escapeHtml(plan)}</strong> tier.
          </p>

          <div
            style="
              margin-top:30px;
              padding:20px;
              border:1px solid #1f2937;
              border-radius:14px;
              background:#0b0f17;
            "
          >
            <p style="margin:0 0 5px;color:#9ca3af;">
              <strong>Site ID</strong>
            </p>

            <code
              style="
                color:#38bdf8;
                font-family:monospace;
                font-size:14px;
              "
            >
              ${escapeHtml(siteId)}
            </code>

            <br /><br />

            <p style="margin:0 0 5px;color:#9ca3af;">
              <strong>API Key</strong>
            </p>

            <code
              style="
                color:#34d399;
                font-family:monospace;
                font-size:14px;
              "
            >
              ${escapeHtml(apiKey)}
            </code>
          </div>

          <div style="margin-top:30px;">
            <p style="color:#9ca3af;">
              SDK Integration Code:
            </p>

            <pre
              style="
                background:#0b0f17;
                padding:15px;
                border:1px solid #1f2937;
                border-radius:8px;
                overflow-x:auto;
              "
            ><code
              style="
                color:#e2e8f0;
                font-size:12px;
              "
            >&lt;script
  src="https://api.dcore.name.ng/sdk.js"
  data-site-id="${escapeHtml(siteId)}"
  data-api-key="${escapeHtml(apiKey)}"
&gt;&lt;/script&gt;</code></pre>
          </div>

          <div
            style="
              margin-top:40px;
              border-top:1px solid #1f2937;
              padding-top:30px;
            "
          >
            <h3
              style="
                font-size:18px;
                color:#ffffff;
              "
            >
              What to do next
            </h3>

            <ol
              style="
                color:#9ca3af;
                line-height:1.8;
              "
            >
              <li>
                Install the REDEN SDK on your website.
              </li>

              <li>
                Load the website and allow REDEN to
                verify the first telemetry event.
              </li>

              <li>
                Connect checkout events so REDEN can
                understand purchase intent and outcomes.
              </li>
            </ol>
          </div>

        </div>
      </div>
    `,
  });
}

/* ─────────────────────────────────────────────
   RECOVERY EMAIL
───────────────────────────────────────────── */

export async function sendRecoveryEmail({
  to,
  incentive,
  cart,
}) {
  const rewardLabel =
    incentive || "Special Promotional Reward";

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
        <div style="max-width:680px;margin:0 auto;">

          <h1
            style="
              font-size:24px;
              margin-bottom:15px;
            "
          >
            Continue Your Session
          </h1>

          <p
            style="
              color:#9ca3af;
              line-height:1.7;
            "
          >
            We noticed you left items in your cart.
            We've kept an incentive available for your
            checkout path.
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
            <p
              style="
                color:#9ca3af;
                margin:0 0 10px;
                font-size:14px;
                text-transform:uppercase;
                letter-spacing:0.05em;
              "
            >
              Incentive Available
            </p>

            <h2
              style="
                color:#ffffff;
                font-size:36px;
                margin:0;
                font-weight:800;
              "
            >
              ${escapeHtml(rewardLabel)}
            </h2>
          </div>

        </div>
      </div>
    `,
  });
}
