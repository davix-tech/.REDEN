/*!
 * REDEN SDK v1
 * Autonomous Decision Runtime
 * https://api.dcore.name.ng
 */

(function (window, document) {
  "use strict";

  /* ─────────────────────────────────────────────
     VERSION
  ───────────────────────────────────────────── */

  const SDK_VERSION = "2.0.0";

  /* ─────────────────────────────────────────────
     DEFAULT CONFIG
  ───────────────────────────────────────────── */

  const DEFAULTS = {
    apiBase: "https://api.dcore.name.ng",
    apiKey: "",
    siteId: "",
    debug: false,
    autoTrack: true,
    autoPageview: true,
    autoOptimize: false,
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
     LOGGING
  ───────────────────────────────────────────── */

  function log(...args) {
    if (config.debug) {
      console.log("[REDEN]", ...args);
    }
  }

  function warn(...args) {
    console.warn("[REDEN]", ...args);
  }

  /* ─────────────────────────────────────────────
     UTILITIES
  ───────────────────────────────────────────── */

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

  function getScriptConfig() {
    const current =
      document.currentScript;

    if (!current) return {};

    return {
      apiKey:
        current.dataset.apiKey || "",
      siteId:
        current.dataset.siteId || "",
      autoOptimize:
        current.dataset.autoOptimize ===
        "true",
      debug:
        current.dataset.debug ===
        "true",
    };
  }

  /* ─────────────────────────────────────────────
     NETWORK
  ───────────────────────────────────────────── */

  async function request(
    path,
    options = {}
  ) {
    const url =
      config.apiBase + path;

    try {

      const res = await fetch(url, {
        headers: {
          "Content-Type":
            "application/json",

          "x-api-key":
            config.apiKey || "",

          "x-site-id":
            config.siteId || "",
        },

        ...options,
      });

      const data =
        await res.json();

      if (!res.ok) {
        throw new Error(
          data.error ||
            "request_failed"
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

  async function track(
    event,
    payload = {}
  ) {
    const body = {
      session_id:
        state.sessionId,

      site_id:
        config.siteId,

      event,

      payload,

      url: location.href,

      path:
        location.pathname,

      title: document.title,

      ts: now(),

      sdk_version:
        SDK_VERSION,
    };

    log("track", body);

    try {

      return await request(
        "/event",
        {
          method: "POST",

          body: JSON.stringify(
            body
          ),
        }
      );

    } catch {

      return null;

    }
  }

  /* ─────────────────────────────────────────────
     DECISION SYSTEM
  ───────────────────────────────────────────── */

  async function score(
    cartValue = 0,
    meta = {}
  ) {
    const body = {
      site_id:
        config.siteId,

      session_id:
        state.sessionId,

      cart_id:
        meta.cart_id || uuid(),

      cart_value:
        Number(cartValue || 0),

      meta,
    };

    log(
      "score request",
      body
    );

    const decision =
      await request(
        "/score",
        {
          method: "POST",

          body: JSON.stringify(
            body
          ),
        }
      );

    state.activeDecision = {
      ...decision,
      created_at: now(),
    };

    log("decision", decision);

    return decision;
  }

  async function action(
    decisionId
  ) {
    if (!decisionId) {
      warn(
        "missing decision_id"
      );

      return null;
    }

    return request("/action", {
      method: "POST",

      body: JSON.stringify({
        decision_id:
          decisionId,
      }),
    });
  }

  async function outcome({
    decision_id,
    converted,
    revenue,
  }) {
    if (!decision_id) {

      warn(
        "missing decision_id"
      );

      return null;
    }

    return request(
      "/outcome",
      {
        method: "POST",

        body: JSON.stringify({
          decision_id,

          converted:
            Boolean(
              converted
            ),

          revenue:
            Number(
              revenue || 0
            ),
        }),
      }
    );
  }

  /* ─────────────────────────────────────────────
     DOM ENGINE
  ───────────────────────────────────────────── */

  function updateText(
    selector,
    text
  ) {
    const el =
      document.querySelector(
        selector
      );

    if (!el) return false;

    el.textContent = text;

    return true;
  }

  function updateHTML(
    selector,
    html
  ) {
    const el =
      document.querySelector(
        selector
      );

    if (!el) return false;

    el.innerHTML = html;

    return true;
  }

  function addClass(
    selector,
    className
  ) {
    const el =
      document.querySelector(
        selector
      );

    if (!el) return false;

    el.classList.add(className);

    return true;
  }

  function injectBanner(
    content
  ) {
    const banner =
      document.createElement(
        "div"
      );

    banner.innerHTML = content;

    banner.style.position =
      "fixed";

    banner.style.bottom =
      "20px";

    banner.style.right =
      "20px";

    banner.style.zIndex =
      "999999";

    banner.style.padding =
      "14px 18px";

    banner.style.background =
      "#111827";

    banner.style.color =
      "#fff";

    banner.style.borderRadius =
      "14px";

    banner.style.fontFamily =
      "Inter,sans-serif";

    banner.style.boxShadow =
      "0 10px 40px rgba(0,0,0,0.4)";

    document.body.appendChild(
      banner
    );

    return banner;
  }

  /* ─────────────────────────────────────────────
     REMOTE RULE ENGINE
  ───────────────────────────────────────────── */

  function applyRule(rule) {

    if (!rule) return;

    const {
      selector,
      action,
      value,
    } = rule;

    switch (action) {

      case "replace_text":

        updateText(
          selector,
          value
        );

        break;

      case "replace_html":

        updateHTML(
          selector,
          value
        );

        break;

      case "add_class":

        addClass(
          selector,
          value
        );

        break;

      case "banner":

        injectBanner(value);

        break;

      default:

        warn(
          "unknown rule action",
          action
        );
    }
  }

  function applyRules(rules) {

    if (!Array.isArray(rules))
      return;

    for (const rule of rules) {
      applyRule(rule);
    }
  }

  /* ─────────────────────────────────────────────
     OPTIMIZATION ENGINE
  ───────────────────────────────────────────── */

  async function optimize(
    options = {}
  ) {
    const decision =
      await score(
        options.cartValue || 0,
        options.meta || {}
      );

    if (!decision) {
      return null;
    }

    if (
      Array.isArray(
        decision.rules
      )
    ) {
      applyRules(
        decision.rules
      );
    }

    else {

      switch (
        decision.action
      ) {

        case "INCENTIVE_HIGH":

          injectBanner(`
            <strong>Special Offer</strong><br/>
            Unlock premium savings today.
          `);

          break;

        case "INCENTIVE_MED":

          updateText(
            options.ctaSelector ||
              "button",

            "Claim Offer"
          );

          break;

        case "INCENTIVE_LOW":

          updateText(
            options.ctaSelector ||
              "button",

            "Continue"
          );

          break;
      }
    }

    await action(
      decision.decision_id
    );

    return decision;
  }

  /* ─────────────────────────────────────────────
     AUTO TRACKING
  ───────────────────────────────────────────── */

  function setupPageTracking() {

    if (
      !config.autoPageview
    ) {
      return;
    }

    track("pageview", {
      referrer:
        document.referrer ||
        null,
    });
  }

  function setupClickTracking() {

    if (!config.autoTrack) {
      return;
    }

    document.addEventListener(
      "click",

      (e) => {

        const el =
          e.target;

        if (!el) return;

        track("click", {
          tag:
            el.tagName ||
            null,

          id:
            el.id || null,

          class:
            el.className ||
            null,

          text:
            (
              el.innerText ||
              ""
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
          now() -
          state.pageStart;

        navigator.sendBeacon(
          config.apiBase +
            "/event",

          JSON.stringify({
            session_id:
              state.sessionId,

            site_id:
              config.siteId,

            event:
              "session_end",

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
     ANALYTICS
  ───────────────────────────────────────────── */

  async function metrics() {
    return request(
      "/metrics"
    );
  }

  async function actionMetrics() {
    return request(
      "/metrics/actions"
    );
  }

  /* ─────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────── */

  function init(
    userConfig = {}
  ) {
    if (
      state.initialized
    ) {

      warn(
        "already initialized"
      );

      return api;
    }

    const scriptConfig =
      getScriptConfig();

    config = {
      ...DEFAULTS,
      ...scriptConfig,
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

    if (
      config.autoOptimize
    ) {

      optimize().catch(
        () => {}
      );
    }

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

    applyRule,

    applyRules,

    updateText,

    updateHTML,

    addClass,

    injectBanner,

    getSession() {
      return state.sessionId;
    },

    getDecision() {
      return state.activeDecision;
    },

    config() {
      return config;
    },
  };

  /* ─────────────────────────────────────────────
     GLOBAL EXPORT
  ───────────────────────────────────────────── */

  window.Reden = api;

  /* ─────────────────────────────────────────────
     AUTO INIT
  ───────────────────────────────────────────── */

  const autoConfig =
    getScriptConfig();

  if (
    autoConfig.siteId
  ) {

    window.Reden.init(
      autoConfig
    );
  }

})(window, document);
