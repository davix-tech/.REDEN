import { Resend } from "resend";

const resend =
  new Resend(
    process.env.RESEND_API_KEY
  );

/* ─────────────────────────────────────────────
   CORE SEND
───────────────────────────────────────────── */

export async function sendEmail({
  to,
  subject,
  html,
  from,
  replyTo,
}) {

  try {

    const response =
      await resend.emails.send({

        from:
          from ||
          "REDEN <noreply@dcore.name.ng>",

        to,

        subject,

        html,

        reply_to:
          replyTo ||
          "redenbydcore@gmail.com",
      });

    console.log(
      "[EMAIL SENT]",
      response.data?.id
    );

    return {
      ok: true,
      id:
        response.data?.id,
    };

  } catch (e) {

    console.error(
      "[EMAIL ERROR]",
      e
    );

    return {
      ok: false,
      error:
        e.message,
    };

  }

}

/* ─────────────────────────────────────────────
   WELCOME EMAIL
───────────────────────────────────────────── */

export async function sendWelcomeEmail({
  to,
  siteId,
  apiKey,
}) {

  return sendEmail({

    to,

    subject:
      "Your REDEN Infrastructure Is Ready",

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
          Your adaptive decision
          infrastructure has been
          provisioned successfully.
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

          <p>
            <strong>Site ID</strong>
          </p>

          <code>${siteId}</code>

          <br /><br />

          <p>
            <strong>API Key</strong>
          </p>

          <code>${apiKey}</code>

        </div>

        <div
          style="
            margin-top:30px;
          "
        >

          <p>
            SDK:
          </p>

          <code>
            &lt;script
            src="https://api.dcore.name.ng/sdk.js"
            data-site-id="${siteId}"
            data-api-key="${apiKey}"
            &gt;&lt;/script&gt;
          </code>

        </div>

      </div>
    `,
  });

}

/* ─────────────────────────────────────────────
   DAILY OWNER REPORT
───────────────────────────────────────────── */

export async function sendDailyReport({
  to,
  totalVisitors,
  conversions,
  revenue,
}) {

  return sendEmail({

    to,

    subject:
      "REDEN Daily Intelligence Report",

    html: `
      <div
        style="
          background:#05070b;
          color:#ffffff;
          padding:40px;
          font-family:Inter,Arial,sans-serif;
        "
      >

        <h1>
          Daily Report
        </h1>

        <div
          style="
            margin-top:30px;
            background:#0b0f17;
            border:1px solid #1f2937;
            border-radius:14px;
            padding:24px;
          "
        >

          <p>
            Visitors:
            <strong>
              ${totalVisitors}
            </strong>
          </p>

          <p>
            Conversions:
            <strong>
              ${conversions}
            </strong>
          </p>

          <p>
            Revenue:
            <strong>
              $${revenue}
            </strong>
          </p>

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
  discount,
}) {

  return sendEmail({

    to,

    subject:
      "Your Session Is Still Active",

    html: `
      <div
        style="
          background:#05070b;
          color:#ffffff;
          padding:40px;
          font-family:Inter,Arial,sans-serif;
        "
      >

        <h1>
          Continue Your Session
        </h1>

        <p
          style="
            color:#9ca3af;
            line-height:1.7;
          "
        >
          REDEN detected
          purchase intent but
          incomplete conversion.
        </p>

        <div
          style="
            margin-top:30px;
            background:#0b0f17;
            border:1px solid #1f2937;
            border-radius:14px;
            padding:24px;
          "
        >

          <p>
            Incentive Available:
          </p>

          <h2>
            ${discount}% OFF
          </h2>

        </div>

      </div>
    `,
  });

}
