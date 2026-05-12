/*!
 * REDEN SDK v1
 * Autonomous Decision Runtime
 * https://api.dcore.name.ng
 */

(function (window, document) {
  "use strict";

  /* ─────────────────────────────────────────────
     CONFIG
  ───────────────────────────────────────────── */

  const SDK_VERSION = "1.0.0";

  const DEFAULTS = {
    apiBase: "https://api.dcore.name.ng",
    debug: false,
    autoTrack: true,
    autoPageview: true,
    sessionKey: "__reden_session",
    decisionTTL: 1000 * 60 * 30,
  };

  /* ─────────────────────────────────────────────
     INTERNAL STATE
  ───────────────────────────────────────────── */

  let config = { ...DEFAULTS };

  const state = {
    initialized: false,
    sessionId: null,
    activeDecision: null,
    pageStart: Date.now(),
    queue: [],
  };

  /* ─────────────────────────────────────────────
     UTILITIES
  ───────────────────────────────────────────── */

  function log(...args) {
    if (config.debug) {
      console.log("[REDEN]", ...args);
    }
  }

  function warn(...args) {
    console.warn("[REDEN]", ...args);
  }

  function uuid() {
    if (window.crypto?.randomUUID) {
      return window.crypto.randomUUID();
    }

    return (
      "reden-" +
      Math.random().toString(36).slice(2) +
      Date.now()
    );
  }

  function now() {
    return Date.now();
  }

  function safeJsonParse(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function persistSession(id) {
    try {
      localStorage.setItem(
        config.sessionKey,
        id
      );
    } catch {}
  }

  function getStoredSession() {
    try {
      return localStorage.getItem(
        config.sessionKey
      );
    } catch {
      return null;
    }
  }

  function ensureSession() {
    let sid = getStoredSession();

    if (!sid) {
      sid = uuid();
      persistSession(sid);
    }

    state.sessionId = sid;

    return sid;
  }

  /* ─────────────────────────────────────────────
     NETWORK
  ───────────────────────────────────────────── */

  async function request(path, options = {}) {
    const url =
      config.apiBase + path;

    try {
      const res = await fetch(url, {
        headers: {
          "Content-Type":
            "application/json",
        },
        ...options,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(
          data.error || "request_failed"
        );
      }

      return data;

    } catch (e) {

      warn(
        "API request failed",
        path,
        e.message
      );

      throw e;
    }
  }

  /* ─────────────────────────────────────────────
     TRACKING
  ───────────────────────────────────────────── */

  async function track(event, payload = {}) {

    const body = {
      session_id: state.sessionId,
      event,
      payload,
      url: location.href,
      path: location.pathname,
      title: document.title,
      ts: now(),
      sdk_version: SDK_VERSION,
    };

    log("track", body);

    try {

      return await request("/event", {
        method: "POST",
        body: JSON.stringify(body),
      });

    } catch {
      return null;
    }
  }

  /* ─────────────────────────────────────────────
     DECISION ENGINE CLIENT
  ───────────────────────────────────────────── */

  async function score(cartValue = 0, meta = {}) {

    const body = {
      session_id: state.sessionId,
      cart_id: meta.cart_id || uuid(),
      cart_value: Number(cartValue || 0),
      meta,
    };

    log("score request", body);

    const decision = await request(
      "/score",
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );

    state.activeDecision = {
      ...decision,
      created_at: now(),
    };

    log("decision", decision);

    return decision;
  }

  async function action(decisionId) {

    if (!decisionId) {
      warn("missing decision_id");
      return null;
    }

    return request("/action", {
      method: "POST",
      body: JSON.stringify({
        decision_id: decisionId,
      }),
    });
  }

  async function outcome({
    decision_id,
    converted,
    revenue,
  }) {

    if (!decision_id) {
      warn("missing decision_id");
      return null;
    }

    return request("/outcome", {
      method: "POST",
      body: JSON.stringify({
        decision_id,
        converted:
          Boolean(converted),
        revenue:
          Number(revenue || 0),
      }),
    });
  }

  /* ─────────────────────────────────────────────
     AUTO TRACKING
  ───────────────────────────────────────────── */

  function setupPageTracking() {

    if (!config.autoPageview) {
      return;
    }

    track("pageview", {
      referrer:
        document.referrer || null,
    });
  }

  function setupClickTracking() {

    if (!config.autoTrack) {
      return;
    }

    document.addEventListener(
      "click",
      (e) => {

        const el = e.target;

        if (!el) return;

        track("click", {
          tag:
            el.tagName || null,
          id:
            el.id || null,
          class:
            el.className || null,
          text:
            (
              el.innerText || ""
            )
              .trim()
              .slice(0, 120),
        });

      },
      true
    );
  }

  function setupUnloadTracking() {

    window.addEventListener(
      "beforeunload",
      () => {

        const duration =
          now() - state.pageStart;

        navigator.sendBeacon(
          config.apiBase + "/event",
          JSON.stringify({
            session_id:
              state.sessionId,
            event: "session_end",
            payload: {
              duration,
            },
            ts: now(),
          })
        );

      }
    );
  }

  /* ─────────────────────────────────────────────
     DOM OPTIMIZATION HELPERS
  ───────────────────────────────────────────── */

  function updateText(selector, text) {

    const el =
      document.querySelector(selector);

    if (!el) {
      return false;
    }

    el.textContent = text;

    return true;
  }

  function injectBanner(content) {

    const banner =
      document.createElement("div");

    banner.innerHTML = content;

    banner.style.position = "fixed";
    banner.style.bottom = "20px";
    banner.style.right = "20px";
    banner.style.zIndex = "999999";
    banner.style.padding = "14px 18px";
    banner.style.background = "#111827";
    banner.style.color = "#fff";
    banner.style.borderRadius = "14px";
    banner.style.fontFamily =
      "Inter,sans-serif";
    banner.style.boxShadow =
      "0 10px 40px rgba(0,0,0,0.4)";

    document.body.appendChild(banner);

    return banner;
  }

  async function optimize(options = {}) {

    const decision =
      await score(
        options.cartValue || 0,
        options.meta || {}
      );

    if (!decision) {
      return null;
    }

    if (
      decision.action ===
      "INCENTIVE_HIGH"
    ) {

      injectBanner(`
        <strong>Special Offer</strong><br/>
        Unlock premium savings today.
      `);

    }

    if (
      decision.action ===
      "INCENTIVE_MED"
    ) {

      updateText(
        options.ctaSelector ||
          "button",
        "Claim Offer"
      );

    }

    if (
      decision.action ===
      "INCENTIVE_LOW"
    ) {

      updateText(
        options.ctaSelector ||
          "button",
        "Continue"
      );

    }

    await action(
      decision.decision_id
    );

    return decision;
  }

  /* ─────────────────────────────────────────────
     METRICS
  ───────────────────────────────────────────── */

  async function metrics() {
    return request("/metrics");
  }

  async function actionMetrics() {
    return request("/metrics/actions");
  }

  /* ─────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────── */

  function init(userConfig = {}) {

    if (state.initialized) {
      warn("already initialized");
      return;
    }

    config = {
      ...DEFAULTS,
      ...userConfig,
    };

    ensureSession();

    setupPageTracking();
    setupClickTracking();
    setupUnloadTracking();

    state.initialized = true;

    log(
      "SDK initialized",
      SDK_VERSION
    );

    return api;
  }

  /* ─────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────── */

  const api = {
    version: SDK_VERSION,

    init,

    track,

    score,

    action,

    outcome,

    optimize,

    metrics,

    actionMetrics,

    updateText,

    injectBanner,

    getSession() {
      return state.sessionId;
    },

    getDecision() {
      return state.activeDecision;
    },
  };

  /* ─────────────────────────────────────────────
     GLOBAL
  ───────────────────────────────────────────── */

  window.Reden = api;

})(window, document);
