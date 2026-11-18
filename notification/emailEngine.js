import { Resend } from "resend";
import { toMerchantLanguage } from "../orchestrator/intelligence/merchantLanguage.js";

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
      from: from || "REDEN <noreply@prethim.site>",
      to,
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    });

    if (response.error) {
      console.error("[EMAIL ERROR]", response.error);
      return {
        ok: false,
        error: response.error.message || "email_send_failed",
      };
    }

    if (!response.data?.id) {
      console.error("[EMAIL ERROR] Provider returned no message ID");
      return {
        ok: false,
        error: "email_provider_returned_no_message_id",
      };
    }

    console.log("[EMAIL SENT]", response.data.id);

    return {
      ok: true,
      id: response.data.id,
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

function formatMoney(value, currency) {
  if (value === null || value === undefined || value === "") return "Not available";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "Not available";
  if (typeof currency === "string" && /^[A-Z]{3}$/.test(currency)) {
    try { return new Intl.NumberFormat("en", {style:"currency",currency,maximumFractionDigits:2}).format(amount); } catch {}
  }
  return `${amount.toLocaleString("en",{minimumFractionDigits:2,maximumFractionDigits:2})} (currency not provided)`;
}

/* ─────────────────────────────────────────────
   REDEN EMAIL SHELL
───────────────────────────────────────────── */

function emailShell({ merchantName, eyebrow, title, intro, content }) {
  return `<div style="margin:0;padding:28px 18px;background:#ffffff;color:#202124;font-family:Arial,Helvetica,sans-serif;"><div style="max-width:640px;margin:0 auto;font-size:15px;line-height:1.7;">
    <p style="margin:0 0 18px;color:#555;font-size:12px;letter-spacing:.04em;text-transform:uppercase;">${escapeHtml(eyebrow||"REDEN")}</p>
    <h1 style="margin:0 0 8px;color:#171717;font-size:25px;line-height:1.3;font-weight:600;">${escapeHtml(title)}</h1>
    ${merchantName?`<p style="margin:0 0 20px;color:#666;">${escapeHtml(merchantName)}</p>`:""}
    ${intro?`<p style="margin:0 0 24px;color:#333;">${intro}</p>`:""}
    ${content}
    <p style="margin:30px 0 0;padding-top:16px;border-top:1px solid #e5e5e5;color:#666;font-size:12px;">REDEN by PRETHIM<br/>Adaptive commerce intelligence</p>
  </div></div>`;
}

function intelligenceText(item) {
  const title=escapeHtml(toMerchantLanguage(item?.title||"Store activity overview"));
  const paragraphs=[item?.summary,item?.why_it_matters,item?.likely_cause?`Possible explanation: ${item.likely_cause}`:null,item?.recommendation?`Recommended next step: ${item.recommendation}`:null].filter(Boolean);
  return `<section style="margin:0 0 22px;"><h2 style="margin:0 0 8px;color:#171717;font-size:18px;line-height:1.4;font-weight:600;">${title}</h2>${paragraphs.map(p=>`<p style="margin:0 0 10px;color:#333;">${escapeHtml(toMerchantLanguage(p))}</p>`).join("")}</section>`;
}
function reportEvidence(metrics={},heading="Store activity") {
  const rows=[["Visits",formatNumber(metrics.total)],["Product views",formatNumber(metrics.productViews)],["Items added to cart",formatNumber(metrics.addToCarts)],["Checkout starts",formatNumber(metrics.checkoutStarts)],["Purchases",formatNumber(metrics.conversions)],["Recorded sales",formatMoney(metrics.revenue,metrics.currency)]];
  return `<section style="margin:26px 0 0;"><h2 style="margin:0 0 10px;color:#171717;font-size:16px;font-weight:600;">${escapeHtml(heading)}</h2><table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;">${rows.map(([label,value])=>`<tr><td style="padding:7px 12px 7px 0;border-bottom:1px solid #eee;color:#555;">${label}</td><td style="padding:7px 0;border-bottom:1px solid #eee;text-align:right;color:#202124;font-weight:600;">${escapeHtml(value)}</td></tr>`).join("")}</table></section>`;
}
function defaultObservation(metrics={},period="this period") {
  const visits=Number(metrics.total||0),views=Number(metrics.productViews||0),carts=Number(metrics.addToCarts||0),checkouts=Number(metrics.checkoutStarts||0),purchases=Number(metrics.conversions||0);
  if(!visits)return {title:`REDEN did not record store visits for ${period}`,summary:"No page-view sessions were recorded. This may mean the store received no visits, or that tracking did not capture them. The available data cannot distinguish between those explanations.",recommendation:"Open your storefront and confirm that the REDEN installation is active and recording page views before drawing conclusions about demand."};
  if(!views)return {title:"Visitors arrived, but no product views were recorded",summary:`REDEN recorded ${formatNumber(visits)} visiting sessions, but no product views for ${period}.`,why_it_matters:"The recorded activity shows visitors reaching the store without a recorded product-page view. There is not enough evidence to tell whether shoppers found the products they wanted or whether product-view tracking is missing.",recommendation:"Review how visitors reach product listings and confirm that product pages send PRODUCT_VIEW events."};
  if(!carts)return {title:"Shoppers viewed products, but no items were added to carts",summary:`The store recorded ${formatNumber(views)} product views, but no add-to-cart events for ${period}.`,why_it_matters:"Product discovery is happening, but the recorded journey does not show shoppers progressing to a cart. Product fit, pricing, product information or event tracking may be contributing factors; the data does not identify which.",recommendation:"Review the most-viewed product pages, prices, availability and add-to-cart functionality. Confirm that ADD_TO_CART events are being tracked."};
  if(!checkouts)return {title:"Items were added to carts, but no checkout starts were recorded",summary:`REDEN recorded ${formatNumber(carts)} add-to-cart events, but no checkout starts for ${period}.`,why_it_matters:"Shoppers showed buying interest, but the recorded journey did not progress to checkout. Cart costs, delivery information, account requirements or checkout tracking may be contributing factors.",recommendation:"Review the cart-to-checkout journey, including delivery charges and unexpected fees. Confirm that CHECKOUT_STARTED events are being recorded."};
  if(!purchases)return {title:"Checkout activity was recorded, but no purchases were completed",summary:`REDEN recorded ${formatNumber(checkouts)} checkout starts and ${formatNumber(carts)} add-to-cart events, but no purchases for ${period}.`,why_it_matters:"Shoppers reached checkout, but no completed purchase was recorded. Payment failures, checkout friction or missing purchase events could explain the gap; the available data does not establish the cause.",recommendation:"Test the full checkout and payment process, and confirm that successful orders trigger PURCHASE events."};
  return {title:`Your store recorded ${formatNumber(purchases)} purchase${purchases===1?"":"s"} for ${period}`,summary:`REDEN recorded ${formatNumber(visits)} visiting sessions, ${formatNumber(views)} product views, ${formatNumber(carts)} add-to-cart events, ${formatNumber(checkouts)} checkout starts and ${formatNumber(purchases)} purchases. Recorded sales: ${formatMoney(metrics.revenue,metrics.currency)}.`,why_it_matters:"The recorded events show activity across the shopping journey. Comparing these stages over time can reveal where more shoppers progress or drop off; one reporting period alone does not establish a trend.",recommendation:"Keep the product, cart and checkout journey working smoothly. Compare the next report with this one to see whether purchase activity and the steps leading to it are increasing or declining."};
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

  const observations=important.length?important:[defaultObservation(metrics,"yesterday")];
  const content=`${observations.map(intelligenceText).join("")}${reportEvidence(metrics,"Yesterday's store activity")}`;

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
    subject: "REDEN Morning Brief",
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

  const observations=important.length?important:[defaultObservation(metrics,"today")];
  const content=`${observations.map(intelligenceText).join("")}${reportEvidence(metrics,"Today's store activity")}`;

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
    subject: "REDEN Evening Store Brief",
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

export async function sendWelcomeEmail({ to }) {
  const html = `
    <div style="margin:0;padding:32px 20px;background:#ffffff;color:#242424;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:560px;margin:0 auto;font-size:15px;line-height:1.75;">
        <p style="margin:0 0 24px;color:#777777;font-size:13px;letter-spacing:0.04em;">REDEN</p>

        <p style="margin:0 0 18px;">Hello,</p>

        <h1 style="margin:0 0 20px;font-size:25px;line-height:1.3;font-weight:600;color:#171717;">
          Congratulations on taking this step for your business. 🎊
        </h1>

        <p style="margin:0 0 16px;">
          Welcome to REDEN. Your account is ready, and we're glad you've chosen to bring a clearer understanding of your store's activity into the way you run your business.
        </p>

        <p style="margin:0 0 16px;">
          As REDEN begins receiving activity from your store, it will help you make sense of what is happening across your commerce journey — from customer visits and buying behaviour to sales and opportunities that deserve your attention.
        </p>

        <p style="margin:0 0 24px;">
          Building a business takes good decisions, and better decisions start with better understanding. We're looking forward to being part of that journey.
        </p>

        <p style="margin:0 0 4px;">Welcome aboard,</p>
        <p style="margin:0 0 28px;font-weight:600;color:#171717;">The REDEN Team</p>

        <p style="margin:24px 0 0;color:#999999;font-size:12px;">REDEN by PRETHIM</p>
      </div>
    </div>
  `;

  return sendEmail({
    to,
    subject: "Welcome to REDEN — congratulations on your next step",
    html,
  });
}

/* ─────────────────────────────────────────────
   RECOVERY EMAIL
───────────────────────────────────────────── */

export async function sendRecoveryEmail({ to, cart = {} }) {
  const html = `
    <div style="margin:0;padding:28px 18px;background:#ffffff;color:#202124;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:600px;margin:0 auto;font-size:15px;line-height:1.7;">
        <p style="margin:0 0 18px;color:#666;font-size:12px;letter-spacing:.04em;text-transform:uppercase;">REDEN by PRETHIM</p>
        <h1 style="margin:0 0 14px;color:#171717;font-size:24px;line-height:1.3;font-weight:600;">Your cart is still waiting</h1>
        <p style="margin:0 0 16px;color:#333;">You left items in your cart before completing checkout. If you still want them, return to the store and continue where you left off.</p>
        <p style="margin:0 0 16px;color:#333;">If you had trouble checking out, the store may be able to help.</p>
        <p style="margin:28px 0 0;padding-top:16px;border-top:1px solid #e5e5e5;color:#777;font-size:12px;">This reminder was sent by REDEN by PRETHIM.</p>
      </div>
    </div>
  `;

  return sendEmail({
    to,
    subject: "Your cart is still waiting",
    html,
  });
}
