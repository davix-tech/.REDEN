/*!
 * REDEN SDK v2
 * Adaptive Revenue Runtime
 * https://reden.dcore.name.ng
 */

(function (window, document) {
  "use strict";

  /* ─────────────────────────────────────────────
     VERSION
  ───────────────────────────────────────────── */

  const SDK_VERSION = "2.0.0";

  /* ─────────────────────────────────────────────
     CONFIG
  ───────────────────────────────────────────── */

  const DEFAULTS = {
    apiBase: "https://reden.dcore.name.ng",

    siteId: "",
    apiKey: "",

    debug: false,

    autoTrack: true,
    autoPageview: true,
    autoOptimize: false,

    sessionKey: "__reden_session",

    timeout: 10000,
  };

  let config = { ...DEFAULTS };

  /* ─────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────── */

  const state = {
    initialized: false,
    sessionId: null,
    activeDecision: null,
    pageStart: Date.now(),
  };

  /* ─────────────────────────────────────────────
     LOGGER
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
      "reden_" +
      Math.random().toString(36).slice(2) +
      Date.now()
    );
  }

  function now() {
    return Date.now();
  }

  function saveSession(id) {
    try {
      localStorage.setItem(
        config.sessionKey,
        id
      );
    } catch {}
  }

  function getSession() {
    try {
      return localStorage.getItem(
        config.sessionKey
      );
    } catch {
      return null;
    }
  }

  function ensureSession() {
    let session = getSession();

    if (!session) {
      session = uuid();
      saveSession(session);
    }

    state.sessionId = session;

    return session;
  }

  function getScriptConfig() {
    const current =
      document.currentScript;

    if (!current) {
      return {};
    }

    return {
      siteId:
        current.dataset.siteId || "",

      apiKey:
        current.dataset.apiKey || "",

      debug:
        current.dataset.debug === "true",

      autoOptimize:
        current.dataset.autoOptimize ===
        "true",
    };
  }

  /* ─────────────────────────────────────────────
     REQUEST ENGINE
  ───────────────────────────────────────────── */

  async function request(
    path,
    options = {}
  ) {
    const controller =
      new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      config.timeout
    );

    try {

      const response = await fetch(
        config.apiBase + path,
        {
          method: "GET",

          headers: {
            "Content-Type":
              "application/json",

            "x-site-id":
              config.siteId,

            "x-api-key":
              config.apiKey,

            "x-sdk-version":
              SDK_VERSION,
          },

          signal:
            controller.signal,

          ...options,
        }
      );

      clearTimeout(timeout);

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
          "request_failed"
        );
      }

      return data;

    } catch (e) {

      clearTimeout(timeout);

      warn(
        "Request failed:",
        path,
        e.message
      );

      throw e;
    }
  }

  /* ─────────────────────────────────────────────
     EVENT TRACKING
  ───────────────────────────────────────────── */

  async function track(
    event,
    payload = {}
  ) {
    try {

      return await request(
        "/event",
        {
          method: "POST",

          body: JSON.stringify({
            session_id:
              state.sessionId,

            event,

            payload,

            url:
              window.location.href,

            path:
              window.location.pathname,

            title:
              document.title,
          }),
        }
      );

    } catch {

      return null;

    }
  }

  /* ─────────────────────────────────────────────
     SCORING
  ───────────────────────────────────────────── */

  async function score(
    cartValue = 0,
    meta = {}
  ) {

    const result =
      await request(
        "/score",
        {
          method: "POST",

          body: JSON.stringify({
            session_id:
              state.sessionId,

            cart_id:
              meta.cart_id || uuid(),

            cart_value:
              Number(cartValue || 0),
          }),
        }
      );

    state.activeDecision = result;

    return result;
  }

  /* ─────────────────────────────────────────────
     ACTION
  ───────────────────────────────────────────── */

  async function action(
    decisionId
  ) {

    if (!decisionId) {
      return null;
    }

    return request(
      "/action",
      {
        method: "POST",

        body: JSON.stringify({
          decision_id:
            decisionId,
        }),
      }
    );
  }

  /* ─────────────────────────────────────────────
     OUTCOME
  ───────────────────────────────────────────── */

  async function outcome({
    decision_id,
    converted,
    revenue,
  }) {

    if (!decision_id) {
      return null;
    }

    return request(
      "/outcome",
      {
        method: "POST",

        body: JSON.stringify({
          decision_id,

          converted:
            Boolean(converted),

          revenue:
            Number(revenue || 0),
        }),
      }
    );
  }

  /* ─────────────────────────────────────────────
     DOM ENGINE
  ───────────────────────────────────────────── */

  function updateText(
    selector,
    value
  ) {
    const el =
      document.querySelector(
        selector
      );

    if (!el) {
      return false;
    }

    el.textContent = value;

    return true;
  }

  function updateHTML(
    selector,
    value
  ) {
    const el =
      document.querySelector(
        selector
      );

    if (!el) {
      return false;
    }

    el.innerHTML = value;

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

    if (!el) {
      return false;
    }

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

    banner.style.background =
      "#05070b";

    banner.style.color =
      "#ffffff";

    banner.style.padding =
      "14px 18px";

    banner.style.borderRadius =
      "14px";

    banner.style.zIndex =
      "999999";

    banner.style.fontFamily =
      "Arial, sans-serif";

    banner.style.boxShadow =
      "0 10px 40px rgba(0,0,0,0.35)";

    document.body.appendChild(
      banner
    );

    return banner;
  }

  /* ─────────────────────────────────────────────
     OPTIMIZER
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

    switch (
      decision.action
    ) {

      case "INCENTIVE_HIGH":

        injectBanner(`
          <strong>Special Offer</strong><br>
          Unlock premium savings now.
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

    if (
      decision.decision_id
    ) {

      await action(
        decision.decision_id
      );
    }

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
        document.referrer || null,
    });
  }

  function setupClickTracking() {

    if (!config.autoTrack) {
      return;
    }

    document.addEventListener(
      "click",

      function (e) {

        const el = e.target;

        if (!el) {
          return;
        }

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

      function () {

        const duration =
          now() -
          state.pageStart;

        navigator.sendBeacon(
          config.apiBase + "/event",

          JSON.stringify({
            session_id:
              state.sessionId,

            event:
              "session_end",

            payload: {
              duration,
            },
          })
        );
      }
    );
  }

  /* ─────────────────────────────────────────────
     METRICS
  ───────────────────────────────────────────── */

  async function metrics() {
    return request("/metrics");
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
        "Already initialized"
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

    if (!config.siteId) {
      warn("Missing siteId");
    }

    if (!config.apiKey) {
      warn("Missing apiKey");
    }

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
    version:
      SDK_VERSION,

    init,

    track,

    score,

    action,

    outcome,

    optimize,

    metrics,

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

    getConfig() {
      return config;
    },
  };

  /* ─────────────────────────────────────────────
     EXPORT
  ───────────────────────────────────────────── */

  window.Reden = api;

  /* ─────────────────────────────────────────────
     AUTO INIT
  ───────────────────────────────────────────── */

  const autoConfig =
    getScriptConfig();

  if (
    autoConfig.siteId &&
    autoConfig.apiKey
  ) {

    window.Reden.init(
      autoConfig
    );
  }

})(window, document);
