/*!
 * REDEN SDK v2 (FIXED)
 * Adaptive Revenue Runtime
 * https://reden.dcore.name.ng
 */

(function (window, document) {
  "use strict";

  const SDK_VERSION = "2.0.1";

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

  const state = {
    initialized: false,
    sessionId: null,
    activeDecision: null,
    pageStart: Date.now(),
  };

  function log(...args) {
    if (config.debug) console.log("[REDEN]", ...args);
  }

  function warn(...args) {
    console.warn("[REDEN]", ...args);
  }

  function uuid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return "reden_" + Math.random().toString(36).slice(2) + Date.now();
  }

  function now() {
    return Date.now();
  }

  function saveSession(id) {
    try {
      localStorage.setItem(config.sessionKey, id);
    } catch {}
  }

  function getSession() {
    try {
      return localStorage.getItem(config.sessionKey);
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
    const current = document.currentScript;
    if (!current) return {};

    return {
      siteId: current.dataset.siteId || "",
      apiKey: current.dataset.apiKey || "",
      debug: current.dataset.debug === "true",
      autoOptimize: current.dataset.autoOptimize === "true",
    };
  }

  /* ─────────────────────────────────────────────
     REQUEST ENGINE (FIXED)
  ───────────────────────────────────────────── */

  async function request(path, options = {}) {
    const controller = new AbortController();

    const timeout = setTimeout(() => controller.abort(), config.timeout);

    try {
      const method = options.method || "GET";

      const response = await fetch(config.apiBase + path, {
        method,

        headers: {
          "Content-Type": "application/json",
          "x-site-id": config.siteId,
          "x-api-key": config.apiKey,
          "x-sdk-version": SDK_VERSION,
        },

        body: method !== "GET" ? options.body : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "request_failed");
      }

      return data;
    } catch (e) {
      clearTimeout(timeout);
      warn("Request failed:", path, e.message);
      throw e;
    }
  }

  async function track(event, payload = {}) {
    try {
      return await request("/event", {
        method: "POST",
        body: JSON.stringify({
          session_id: state.sessionId,
          event,
          payload,
          url: window.location.href,
          path: window.location.pathname,
          title: document.title,
        }),
      });
    } catch {
      return null;
    }
  }

  async function score(cartValue = 0, meta = {}) {
    const result = await request("/score", {
      method: "POST",
      body: JSON.stringify({
        session_id: state.sessionId,
        cart_id: meta.cart_id || uuid(),
        cart_value: Number(cartValue || 0),
      }),
    });

    state.activeDecision = result;
    return result;
  }

  async function action(decisionId) {
    if (!decisionId) return null;

    return request("/action", {
      method: "POST",
      body: JSON.stringify({
        decision_id: decisionId,
      }),
    });
  }

  async function outcome({ decision_id, converted, revenue }) {
    if (!decision_id) return null;

    return request("/outcome", {
      method: "POST",
      body: JSON.stringify({
        decision_id,
        converted: Boolean(converted),
        revenue: Number(revenue || 0),
      }),
    });
  }

  function setupPageTracking() {
    if (!config.autoPageview) return;
    track("pageview", { referrer: document.referrer || null });
  }

  function setupClickTracking() {
    if (!config.autoTrack) return;

    document.addEventListener(
      "click",
      (e) => {
        const el = e.target;
        if (!el) return;

        track("click", {
          tag: el.tagName || null,
          id: el.id || null,
          class: el.className || null,
          text: (el.innerText || "").trim().slice(0, 120),
        });
      },
      true
    );
  }

  function setupUnloadTracking() {
    window.addEventListener("beforeunload", function () {
      const duration = now() - state.pageStart;

      navigator.sendBeacon(
        config.apiBase + "/event",
        JSON.stringify({
          session_id: state.sessionId,
          event: "session_end",
          payload: { duration },
        })
      );
    });
  }

  async function metrics() {
    return request("/metrics");
  }

  function init(userConfig = {}) {
    if (state.initialized) return api;

    const scriptConfig = getScriptConfig();

    config = {
      ...DEFAULTS,
      ...scriptConfig,
      ...userConfig,
    };

    if (!config.siteId) warn("Missing siteId");
    if (!config.apiKey) warn("Missing apiKey");

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

  const api = {
    version: SDK_VERSION,
    init,
    track,
    score,
    action,
    outcome,
    metrics,
    getSession: () => state.sessionId,
    getDecision: () => state.activeDecision,
    getConfig: () => config,
  };

  window.Reden = api;

  const autoConfig = getScriptConfig();

  if (autoConfig.siteId && autoConfig.apiKey) {
    window.Reden.init(autoConfig);
  }
})(window, document);
