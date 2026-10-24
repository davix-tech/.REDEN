/**
 * REDEN intelligence knowledge base.
 *
 * This file stores versioned, reviewable business knowledge separately
 * from request handling and SQL. Keep claims general, testable, and
 * explicitly conditional; merchant-specific conclusions must come from
 * the evidence assembled by the intelligence pipeline.
 */
export const REDEN_KNOWLEDGE_VERSION = "2026-10-24.1";

export const REDEN_KNOWLEDGE = {
  sales_diagnosis: {
    title: "Diagnosing a decline in sales",
    domain: "ecommerce",
    purpose: "Identify which observed part of the sales system changed before recommending an intervention.",
    hypotheses: [
      {
        id: "traffic_decline",
        label: "Fewer store visits",
        evidence: ["same-time historical PAGE_VIEW sessions", "traffic-source changes"],
        interpretation: "A meaningful fall in recorded visits can contribute to lower sales, but tracking health must be checked before treating missing events as zero traffic.",
        first_checks: ["Confirm the storefront loads", "Verify PAGE_VIEW events are being recorded", "Inspect source and campaign delivery"],
        avoid: ["Increasing ad spend before checking tracking and campaign delivery"]
      },
      {
        id: "product_interest_decline",
        label: "Lower product interest",
        evidence: ["product views", "product-view rate relative to visits", "product availability"],
        interpretation: "Stable traffic with fewer product views may indicate a change in landing-page relevance, navigation, product visibility, or availability. Today's counts alone cannot prove which cause applies.",
        first_checks: ["Compare product views per session with a comparable historical period", "Check product pages and stock status"]
      },
      {
        id: "cart_intent_decline",
        label: "Fewer add-to-cart actions",
        evidence: ["add-to-cart events", "add-to-cart rate relative to product views"],
        interpretation: "A fall in add-to-cart activity relative to product views can indicate weaker product-to-price fit, availability, offer clarity, or purchase intent. Validate the event instrumentation first.",
        first_checks: ["Compare add-to-cart rate with historical periods", "Review price, shipping, stock, and product information"]
      },
      {
        id: "checkout_friction",
        label: "Checkout friction",
        evidence: ["checkout-start events", "purchase events", "checkout completion rate", "payment errors if integrated"],
        interpretation: "A large checkout-to-purchase event gap is a diagnostic signal, not a confirmed abandonment count; event counts may not represent unique customers and tracking can be incomplete.",
        first_checks: ["Test checkout on mobile and desktop", "Verify payment and purchase events", "Inspect shipping fees and payment failures"]
      },
      {
        id: "average_order_value",
        label: "Lower order value",
        evidence: ["revenue per purchase", "order-value distribution", "discounts and product mix"],
        interpretation: "Revenue can fall even when order count is stable if average order value falls. Compare the same metric over comparable periods before concluding.",
        first_checks: ["Compare revenue per purchase", "Review product mix, discounting, and order-value distribution"]
      }
    ],
    reasoning_rules: [
      "A decline can only be established by comparing comparable time windows; a single-day snapshot cannot prove that sales are down.",
      "Use the merchant's configured timezone and clearly label the reporting period.",
      "Do not confuse purchase-event counts with unique orders unless order identifiers are available and deduplicated.",
      "Do not confuse storefront purchase revenue with revenue attributed to REDEN decisions.",
      "Missing events are unknown instrumentation or collection status, not proof that the real-world activity was zero.",
      "Treat a possible cause as a hypothesis unless supporting evidence distinguishes it from alternatives.",
      "When a required baseline is unavailable, state exactly what is missing and give low-risk checks instead of inventing a cause."
    ],
    response_contract: [
      "State what changed and the comparison period, if a valid comparison exists.",
      "Cite the observed metrics that support the diagnosis.",
      "Separate confirmed observations from hypotheses.",
      "Give one or two prioritized, reversible next actions.",
      "State what to measure next and when to re-check."
    ]
  },
  revenue_reporting: {
    title: "Reporting storefront revenue",
    domain: "commerce_finance",
    rules: [
      "Report the value and reporting period together.",
      "Use the configured store currency when it is known; do not infer currency from the numeric value.",
      "Describe the existing REDEN purchaseRevenue field as recorded storefront purchase revenue unless payment settlement, refunds, taxes, and currency conversion are explicitly reconciled.",
      "Keep storefront purchase revenue separate from REDEN-attributed decision revenue.",
      "A purchase event is a tracked event, not independent proof that a payment settled or that an order was not later refunded.",
      "If currency or accounting basis is unknown, say so rather than implying net profit or settled proceeds."
    ]
  },
  funnel_analysis: {
    title: "Interpreting the commerce funnel",
    domain: "conversion_optimization",
    rules: [
      "Distinguish event counts from distinct sessions, people, and orders.",
      "Compare stage rates across comparable periods and use the same denominator definition.",
      "Check event tracking before interpreting a missing funnel stage as a business failure.",
      "Avoid claiming checkout abandonment from the difference between raw checkout and purchase event counts."
    ]
  },
  recommendation_quality: {
    title: "Evidence-led recommendations",
    rules: [
      "Prefer reversible diagnostic checks before expensive interventions.",
      "Do not recommend increasing advertising spend solely because sales are down.",
      "Avoid causal claims from correlation or small samples.",
      "Explain uncertainty and the evidence that would change the recommendation.",
      "Measure the result after the intervention over a defined, comparable period."
    ]
  }
};
