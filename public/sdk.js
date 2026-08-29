(function (window, document) {
  "use strict";

  const SDK_VERSION = "1.0.0";

  const DEFAULTS = {
    apiBase: "https://reden.dcore.name.ng",
    sessionKey: "reden_session_id",
    timeout: 8000,
    autoTrack: true,
    autoPageview: true,
    autoOptimize: false,
    debug: false,
  };

  let config = { ...DEFAULTS };

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

  function persistSession(id) {
    try {
      localStorage.setItem(config.sessionKey, id);
    } catch {}
  }

  function getStoredSession() {
    try {
      return localStorage.getItem(config.sessionKey);
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
    const current = document.currentScript;
    if (!current) {
      return {};
    }
    return {
      apiKey: current.dataset.apiKey || "",
      siteId: current.dataset.siteId || "",
      debug: current.dataset.debug === "true",
      autoOptimize: current.dataset.autoOptimize === "true",
    };
  }

  /* ─────────────────────────────────────────────
     REQUEST ENGINE
  ───────────────────────────────────────────── */

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout);

    try {
      const response = await fetch(config.apiBase + path, {
        method: options.method || "GET",
        keepalive: options.keepalive || false,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "x-site-id": config.siteId,
          "x-sdk-version": SDK_VERSION,
          ...(options.headers || {})
        },
        body: options.body || null,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      let data = null;

      try {
        data = await response.json();
      } catch {
        data = {
          ok: false,
          error: "invalid_json_response",
        };
      }

      if (!response.ok) {
        throw new Error(data?.error || "request_failed");
      }

      return data;
    } catch (e) {
      clearTimeout(timeout);
      warn("request failed", path, e.message);
      throw e;
    }
  }

  /* ─────────────────────────────────────────────
     TRACKING

     `event` MUST be one of the event names REDEN
     recognizes server-side:

       PAGE_VIEW, PRODUCT_VIEW, ADD_TO_CART,
       CHECKOUT_STARTED, PURCHASE, SESSION_START,
       SESSION_END, BEHAVIOR

     Anything else is rejected with 400 invalid_event.
     Internal auto-tracking below only ever sends one
     of these; storefront integration code calling
     Reden.track(...) directly must do the same.
  ───────────────────────────────────────────── */

  async function track(event, payload = {}, options = {}) {
    try {
      return await request("/event", {
        method: "POST",
        keepalive: options.keepalive || false,
        body: JSON.stringify({
          session_id: state.sessionId,
          event,
          payload,
          url: location.href,
          path: location.pathname,
          title: document.title,
          ts: now(),
        }),
      });
    } catch {
      return null;
    }
  }

  /* ─────────────────────────────────────────────
     DECISION ENGINE
  ───────────────────────────────────────────── */

  async function score(cartValue = 0, meta = {}) {
    const body = {
      session_id: state.sessionId,
      cart_id: meta.cart_id || uuid(),
      cart_value: Number(cartValue || 0),
      meta,
    };

    const decision = await request("/score", {
      method: "POST",
      body: JSON.stringify(body),
    });

    state.activeDecision = {
      ...decision,
      created_at: now(),
    };

    return decision;
  }

  async function action(decisionId) {
    if (!decisionId) {
      return null;
    }
    return request("/action", {
      method: "POST",
      body: JSON.stringify({ decision_id: decisionId }),
    });
  }

  async function outcome({ decision_id, converted, revenue }) {
    if (!decision_id) {
      return null;
    }
    return request("/outcome", {
      method: "POST",
      body: JSON.stringify({
        decision_id,
        converted: Boolean(converted),
        revenue: Number(revenue || 0),
      }),
    });
  }

  /* ─────────────────────────────────────────────
     DOM ENGINE
  ───────────────────────────────────────────── */

  function query(selector) {
    return document.querySelector(selector);
  }

  function updateText(selector, value) {
    const el = query(selector);
    if (!el) return false;
    el.textContent = value;
    return true;
  }

  function updateHTML(selector, value) {
    const el = query(selector);
    if (!el) return false;
    el.innerHTML = value;
    return true;
  }

  function addClass(selector, value) {
    const el = query(selector);
    if (!el) return false;
    el.classList.add(value);
    return true;
  }

  function injectBanner(content) {
    const banner = document.createElement("div");
    banner.innerHTML = content;
    banner.style.position = "fixed";
    banner.style.bottom = "20px";
    banner.style.right = "20px";
    banner.style.padding = "14px 18px";
    banner.style.background = "#111827";
    banner.style.color = "#ffffff";
    banner.style.zIndex = "999999";
    banner.style.borderRadius = "14px";
    banner.style.fontFamily = "Inter, sans-serif";
    banner.style.boxShadow = "0 10px 40px rgba(0,0,0,0.35)";

    document.body.appendChild(banner);
    return banner;
  }

  /* ─────────────────────────────────────────────
     RULE ENGINE
  ───────────────────────────────────────────── */

  function applyRule(rule) {
    if (!rule) return;
    const { selector, action, value } = rule;

    switch (action) {
      case "replace_text":
        updateText(selector, value);
        break;
      case "replace_html":
        updateHTML(selector, value);
        break;
      case "add_class":
        addClass(selector, value);
        break;
      case "banner":
        injectBanner(value);
        break;
      default:
        warn("unknown rule", action);
    }
  }

  function applyRules(rules) {
    if (!Array.isArray(rules)) return;
    for (const rule of rules) {
      applyRule(rule);
    }
  }

  /* ─────────────────────────────────────────────
     OPTIMIZER
  ───────────────────────────────────────────── */

  async function optimize(options = {}) {
    const decision = await score(options.cartValue || 0, options.meta || {});
    if (!decision) return null;

    if (Array.isArray(decision.rules)) {
      applyRules(decision.rules);
    } else {
      switch (decision.action) {
        case "INCENTIVE_HIGH":
          injectBanner(`
            <strong>Special Offer</strong><br/>
            Unlock premium savings today.
          `);
          break;
        case "INCENTIVE_MED":
          updateText(options.ctaSelector || "button", "Claim Offer");
          break;
        case "INCENTIVE_LOW":
          updateText(options.ctaSelector || "button", "Continue");
          break;
      }
    }

    if (decision.decision_id) {
      await action(decision.decision_id);
    }

    return decision;
  }

  /* ─────────────────────────────────────────────
     AUTO TRACKING
  ───────────────────────────────────────────── */

  function setupPageTracking() {
    if (!config.autoPageview) return;
    track("PAGE_VIEW", {
      referrer: document.referrer || null,
    });
  }

  function setupClickTracking() {
    if (!config.autoTrack) return;
    document.addEventListener("click", function (e) {
      const el = e.target;
      if (!el) return;

      const tag = (el.tagName || "").toLowerCase();

      /*
       * Generic clicks are a behavioral signal, not one of
       * REDEN's funnel-specific event types. They MUST be
       * sent as "BEHAVIOR" -- the server rejects any event
       * name outside its fixed VALID_EVENTS set with a 400.
       *
       * Sending the raw DOM event name ("click") here was
       * the original bug: it gets uppercased to "CLICK" by
       * the server, which isn't a recognized event, so every
       * click anywhere on the page -- including checkout
       * buttons -- was rejected.
       */

      // Skip capturing text content from form fields — may contain PII
      if (["input", "textarea", "select"].includes(tag)) {
        track("BEHAVIOR", {
          type: "click",
          tag: el.tagName || null,
          id: el.id || null,
          class: el.className || null,
        });
        return;
      }

      track("BEHAVIOR", {
        type: "click",
        tag: el.tagName || null,
        id: el.id || null,
        class: el.className || null,
        text: (el.innerText || "").trim().slice(0, 120),
      });
    }, true);
  }

  function setupUnloadTracking() {
    const handleSessionEnd = () => {
      track(
        "SESSION_END",
        { duration: now() - state.pageStart },
        { keepalive: true } // Crucial for reliable exit tracking
      );
    };

    // Standard desktop close/refresh
    window.addEventListener("beforeunload", handleSessionEnd);

    // Modern mobile visibility handling (iOS Safari)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        handleSessionEnd();
      }
    });
  }

  /* ─────────────────────────────────────────────
     ANALYTICS
  ───────────────────────────────────────────── */

  async function metrics() {
    return request("/metrics");
  }

  /* ─────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────── */

  function init(userConfig = {}) {
    if (state.initialized) {
      warn("already initialized");
      return api;
    }

    const scriptConfig = getScriptConfig();
    config = {
      ...DEFAULTS,
      ...scriptConfig,
      ...userConfig,
    };

    if (!config.siteId) warn("missing siteId");
    if (!config.apiKey) warn("missing apiKey");

    ensureSession();
    setupPageTracking();
    setupClickTracking();
    setupUnloadTracking();

    state.initialized = true;
    log("SDK initialized", SDK_VERSION);

    if (config.autoOptimize) {
      optimize().catch(() => {});
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
    getConfig() {
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

  const autoConfig = getScriptConfig();

  if (autoConfig.siteId && autoConfig.apiKey) {
    window.Reden.init(autoConfig);
  }

})(window, document);
