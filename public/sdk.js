(function (window, document) {
  "use strict";

  const SDK_VERSION = "1.0.0";

  const DEFAULT_API_BASE = "https://reden.dcore.name.ng";
  const MAX_SITE_ID_LENGTH = 200;
  const MAX_API_KEY_LENGTH = 500;
  const MAX_SESSION_ID_LENGTH = 128;
  const MAX_SELECTOR_LENGTH = 300;
  const MAX_CLASS_LENGTH = 100;
  const MAX_VALUE_LENGTH = 2000;
  const MAX_EVENT_PAYLOAD_BYTES = 32_000;
  const MAX_META_BYTES = 8_000;
  const MAX_RULES = 20;
  const MAX_REQUEST_PATH_LENGTH = 100;

  const ALLOWED_EVENTS = new Set([
    "PAGE_VIEW",
    "PRODUCT_VIEW",
    "ADD_TO_CART",
    "CHECKOUT_STARTED",
    "PURCHASE",
    "SESSION_START",
    "SESSION_END",
    "BEHAVIOR",
  ]);

  const ALLOWED_RULE_ACTIONS = new Set([
    "replace_text",
    "add_class",
    "banner",
  ]);

  const DEFAULTS = Object.freeze({
    apiBase: DEFAULT_API_BASE,
    sessionKey: "reden_session_id",
    timeout: 8000,
    autoTrack: true,
    autoPageview: true,
    autoOptimize: false,
    debug: false,
    captureClickText: false,
  });

  let config = { ...DEFAULTS };

  const state = {
    initialized: false,
    sessionId: null,
    activeDecision: null,
    pageStart: Date.now(),
    sessionEnded: false,
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

  function cleanString(value, maxLength = 1000) {
    if (typeof value !== "string") {
      return "";
    }

    return value.trim().slice(0, maxLength);
  }

  function safeJsonSize(value, maxBytes) {
    try {
      const serialized = JSON.stringify(value);

      if (typeof serialized !== "string") {
        return false;
      }

      return serialized.length <= maxBytes;
    } catch {
      return false;
    }
  }

  function uuid() {
    if (window.crypto?.randomUUID) {
      return window.crypto.randomUUID();
    }

    if (window.crypto?.getRandomValues) {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);

      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;

      const hex = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");

      return (
        "reden_" +
        hex.slice(0, 8) +
        "-" +
        hex.slice(8, 12) +
        "-" +
        hex.slice(12, 16) +
        "-" +
        hex.slice(16, 20) +
        "-" +
        hex.slice(20)
      );
    }

    return (
      "reden_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 14)
    );
  }

  function now() {
    return Date.now();
  }

  function isValidSessionId(id) {
    return (
      typeof id === "string" &&
      id.length > 0 &&
      id.length <= MAX_SESSION_ID_LENGTH &&
      /^[a-zA-Z0-9._:-]+$/.test(id)
    );
  }

  function persistSession(id) {
    if (!isValidSessionId(id)) {
      return;
    }

    try {
      localStorage.setItem(config.sessionKey, id);
    } catch {
      // Storage can be unavailable in privacy-restricted browsers.
    }
  }

  function getStoredSession() {
    try {
      const value = localStorage.getItem(config.sessionKey);

      return isValidSessionId(value) ? value : null;
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

  function isValidSiteId(siteId) {
    return (
      typeof siteId === "string" &&
      siteId.length > 0 &&
      siteId.length <= MAX_SITE_ID_LENGTH &&
      /^site_[a-zA-Z0-9._-]+$/.test(siteId)
    );
  }

  function isValidApiKey(apiKey) {
    return (
      typeof apiKey === "string" &&
      apiKey.length > 0 &&
      apiKey.length <= MAX_API_KEY_LENGTH
    );
  }

  function getScriptConfig() {
    const current = document.currentScript;

    if (!current) {
      return {};
    }

    return {
      apiKey: cleanString(
        current.dataset.apiKey || "",
        MAX_API_KEY_LENGTH
      ),

      siteId: cleanString(
        current.dataset.siteId || "",
        MAX_SITE_ID_LENGTH
      ),

      debug:
        current.dataset.debug === "true",

      autoOptimize:
        current.dataset.autoOptimize === "true",
    };
  }

  /* ─────────────────────────────────────────────
     CONFIGURATION
     
     apiBase is deliberately NOT user-overridable.
     
     The SDK must never send merchant credentials to
     an arbitrary origin supplied by storefront code.
  ───────────────────────────────────────────── */

  function buildConfig(scriptConfig, userConfig) {
    const safeUserConfig =
      userConfig &&
      typeof userConfig === "object" &&
      !Array.isArray(userConfig)
        ? userConfig
        : {};

    return {
      ...DEFAULTS,

      ...scriptConfig,

      /*
       * Only safe, non-security-sensitive options can be
       * overridden through Reden.init().
       */
      debug:
        typeof safeUserConfig.debug === "boolean"
          ? safeUserConfig.debug
          : scriptConfig.debug,

      autoTrack:
        typeof safeUserConfig.autoTrack === "boolean"
          ? safeUserConfig.autoTrack
          : DEFAULTS.autoTrack,

      autoPageview:
        typeof safeUserConfig.autoPageview === "boolean"
          ? safeUserConfig.autoPageview
          : DEFAULTS.autoPageview,

      autoOptimize:
        typeof safeUserConfig.autoOptimize === "boolean"
          ? safeUserConfig.autoOptimize
          : scriptConfig.autoOptimize,

      captureClickText:
        safeUserConfig.captureClickText === true,
    };
  }

  /* ─────────────────────────────────────────────
     REQUEST ENGINE
  ───────────────────────────────────────────── */

  function isAllowedPath(path) {
    return (
      typeof path === "string" &&
      path.length > 0 &&
      path.length <= MAX_REQUEST_PATH_LENGTH &&
      path.startsWith("/") &&
      !path.startsWith("//") &&
      !path.includes("\\") &&
      !path.includes("..")
    );
  }

  function buildRequestUrl(path) {
    if (!isAllowedPath(path)) {
      throw new Error("invalid_request_path");
    }

    return DEFAULT_API_BASE + path;
  }

  async function request(path, options = {}) {
    if (!state.initialized && !isValidSiteId(config.siteId)) {
      throw new Error("sdk_not_initialized");
    }

    if (!isValidSiteId(config.siteId)) {
      throw new Error("invalid_site_id");
    }

    if (!isValidApiKey(config.apiKey)) {
      throw new Error("invalid_api_key");
    }

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, config.timeout);

    try {
      const method =
        typeof options.method === "string"
          ? options.method.toUpperCase()
          : "GET";

      const response = await fetch(
        buildRequestUrl(path),
        {
          method,

          keepalive:
            options.keepalive === true,

          /*
           * Optional headers are intentionally restricted.
           *
           * Security-sensitive REDEN headers are set AFTER
           * user/internal headers so they cannot be replaced.
           */
          headers: {
            ...(options.headers || {}),

            "Content-Type":
              "application/json",

            Accept:
              "application/json",

            "x-api-key":
              config.apiKey,

            "x-site-id":
              config.siteId,

            "x-sdk-version":
              SDK_VERSION,
          },

          body:
            options.body || null,

          signal:
            controller.signal,
        }
      );

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
        throw new Error(
          cleanString(
            data?.error,
            300
          ) || "request_failed"
        );
      }

      return data;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      if (
        config.debug &&
        message !== "AbortError"
      ) {
        warn(
          "request failed",
          path,
          message
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /* ─────────────────────────────────────────────
     TRACKING
  ───────────────────────────────────────────── */

  async function track(
    event,
    payload = {},
    options = {}
  ) {
    const normalizedEvent =
      cleanString(event, 50).toUpperCase();

    if (!ALLOWED_EVENTS.has(normalizedEvent)) {
      warn(
        "unsupported event",
        normalizedEvent
      );

      return null;
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      payload = {};
    }

    if (
      !safeJsonSize(
        payload,
        MAX_EVENT_PAYLOAD_BYTES
      )
    ) {
      warn("event payload too large");
      return null;
    }

    const body = {
      session_id:
        state.sessionId,

      event:
        normalizedEvent,

      payload,

      url:
        cleanString(
          window.location.href,
          2000
        ),

      path:
        cleanString(
          window.location.pathname,
          1000
        ),

      title:
        cleanString(
          document.title,
          300
        ),

      ts:
        now(),
    };

    if (
      !safeJsonSize(
        body,
        MAX_EVENT_PAYLOAD_BYTES
      )
    ) {
      warn("event body too large");
      return null;
    }

    try {
      return await request(
        "/event",
        {
          method: "POST",
          keepalive:
            options.keepalive === true,
          body:
            JSON.stringify(body),
        }
      );
    } catch {
      return null;
    }
  }

  /* ─────────────────────────────────────────────
     DECISION ENGINE
  ───────────────────────────────────────────── */

  async function score(
    cartValue = 0,
    meta = {}
  ) {
    let numericCartValue =
      Number(cartValue);

    if (
      !Number.isFinite(
        numericCartValue
      )
    ) {
      numericCartValue = 0;
    }

    numericCartValue =
      Math.max(
        0,
        Math.min(
          numericCartValue,
          Number.MAX_SAFE_INTEGER
        )
      );

    if (
      !meta ||
      typeof meta !== "object" ||
      Array.isArray(meta)
    ) {
      meta = {};
    }

    if (
      !safeJsonSize(
        meta,
        MAX_META_BYTES
      )
    ) {
      throw new Error(
        "metadata_too_large"
      );
    }

    const body = {
      session_id:
        state.sessionId,

      cart_id:
        cleanString(
          meta.cart_id,
          200
        ) || uuid(),

      cart_value:
        numericCartValue,

      meta,
    };

    const decision =
      await request(
        "/score",
        {
          method: "POST",
          body:
            JSON.stringify(body),
        }
      );

    if (
      !decision ||
      typeof decision !== "object"
    ) {
      return null;
    }

    state.activeDecision = {
      ...decision,
      created_at: now(),
    };

    return decision;
  }

  async function action(decisionId) {
    const id =
      cleanString(
        decisionId,
        200
      );

    if (!id) {
      return null;
    }

    return request(
      "/action",
      {
        method: "POST",
        body:
          JSON.stringify({
            decision_id: id,
          }),
      }
    );
  }

  async function outcome({
    decision_id,
    converted,
    revenue,
  } = {}) {
    const id =
      cleanString(
        decision_id,
        200
      );

    if (!id) {
      return null;
    }

    let numericRevenue =
      Number(revenue || 0);

    if (
      !Number.isFinite(
        numericRevenue
      )
    ) {
      numericRevenue = 0;
    }

    numericRevenue =
      Math.max(
        0,
        Math.min(
          numericRevenue,
          Number.MAX_SAFE_INTEGER
        )
      );

    return request(
      "/outcome",
      {
        method: "POST",
        body:
          JSON.stringify({
            decision_id: id,
            converted:
              Boolean(converted),
            revenue:
              numericRevenue,
          }),
      }
    );
  }

  /* ─────────────────────────────────────────────
     DOM ENGINE
     
     DOM mutation is deliberately conservative.
     No arbitrary HTML injection.
  ───────────────────────────────────────────── */

  function query(selector) {
    if (
      typeof selector !== "string" ||
      selector.length === 0 ||
      selector.length > MAX_SELECTOR_LENGTH
    ) {
      return null;
    }

    try {
      return document.querySelector(
        selector
      );
    } catch {
      return null;
    }
  }

  function updateText(
    selector,
    value
  ) {
    const el = query(selector);

    if (!el) {
      return false;
    }

    const text =
      cleanString(
        value,
        MAX_VALUE_LENGTH
      );

    el.textContent = text;

    return true;
  }

  /*
   * Kept only as a compatibility-safe operation.
   *
   * It intentionally behaves like updateText instead of
   * executing arbitrary HTML supplied by a decision.
   */
  function updateHTML(
    selector,
    value
  ) {
    warn(
      "updateHTML is disabled; using textContent instead"
    );

    return updateText(
      selector,
      value
    );
  }

  function addClass(
    selector,
    value
  ) {
    const el = query(selector);

    if (!el) {
      return false;
    }

    const className =
      cleanString(
        value,
        MAX_CLASS_LENGTH
      );

    /*
     * Only allow one ordinary CSS class.
     */
    if (
      !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(
        className
      )
    ) {
      return false;
    }

    el.classList.add(
      className
    );

    return true;
  }

  function injectBanner(
    content
  ) {
    if (
      !document.body
    ) {
      return null;
    }

    const existing =
      document.querySelector(
        "[data-reden-banner]"
      );

    if (existing) {
      existing.remove();
    }

    const banner =
      document.createElement(
        "div"
      );

    banner.setAttribute(
      "data-reden-banner",
      "true"
    );

    banner.textContent =
      cleanString(
        content,
        MAX_VALUE_LENGTH
      );

    banner.style.position =
      "fixed";

    banner.style.bottom =
      "20px";

    banner.style.right =
      "20px";

    banner.style.maxWidth =
      "min(420px, calc(100vw - 40px))";

    banner.style.padding =
      "14px 18px";

    banner.style.background =
      "#111827";

    banner.style.color =
      "#ffffff";

    banner.style.zIndex =
      "999999";

    banner.style.borderRadius =
      "14px";

    banner.style.fontFamily =
      "Inter, sans-serif";

    banner.style.boxShadow =
      "0 10px 40px rgba(0,0,0,0.35)";

    banner.style.wordBreak =
      "break-word";

    document.body.appendChild(
      banner
    );

    return banner;
  }

  /* ─────────────────────────────────────────────
     RULE ENGINE
  ───────────────────────────────────────────── */

  function isValidRule(rule) {
    if (
      !rule ||
      typeof rule !== "object" ||
      Array.isArray(rule)
    ) {
      return false;
    }

    const action =
      cleanString(
        rule.action,
        50
      );

    if (
      !ALLOWED_RULE_ACTIONS.has(
        action
      )
    ) {
      return false;
    }

    const value =
      cleanString(
        rule.value,
        MAX_VALUE_LENGTH
      );

    if (!value) {
      return false;
    }

    if (
      action === "banner"
    ) {
      return true;
    }

    const selector =
      cleanString(
        rule.selector,
        MAX_SELECTOR_LENGTH
      );

    return Boolean(
      selector
    );
  }

  function applyRule(rule) {
    if (!isValidRule(rule)) {
      warn(
        "invalid REDEN rule"
      );

      return false;
    }

    const action =
      cleanString(
        rule.action,
        50
      );

    const value =
      cleanString(
        rule.value,
        MAX_VALUE_LENGTH
      );

    const selector =
      cleanString(
        rule.selector,
        MAX_SELECTOR_LENGTH
      );

    switch (action) {
      case "replace_text":
        return updateText(
          selector,
          value
        );

      case "add_class":
        return addClass(
          selector,
          value
        );

      case "banner":
        return Boolean(
          injectBanner(
            value
          )
        );

      default:
        return false;
    }
  }

  function applyRules(
    rules
  ) {
    if (
      !Array.isArray(rules)
    ) {
      return;
    }

    const limitedRules =
      rules.slice(
        0,
        MAX_RULES
      );

    for (
      const rule of limitedRules
    ) {
      try {
        applyRule(rule);
      } catch (error) {
        warn(
          "rule application failed",
          error
        );
      }
    }
  }

  /* ─────────────────────────────────────────────
     OPTIMIZER
  ───────────────────────────────────────────── */

  async function optimize(
    options = {}
  ) {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options)
    ) {
      options = {};
    }

    const decision =
      await score(
        options.cartValue || 0,
        options.meta || {}
      );

    if (
      !decision
    ) {
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
    } else {
      switch (
        cleanString(
          decision.action,
          100
        )
      ) {
        case "INCENTIVE_HIGH":
          injectBanner(
            "Special Offer\nUnlock premium savings today."
          );
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

        default:
          break;
      }
    }

    const decisionId =
      cleanString(
        decision.decision_id,
        200
      );

    if (decisionId) {
      try {
        await action(
          decisionId
        );
      } catch (error) {
        warn(
          "decision action failed",
          error
        );
      }
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

    track(
      "PAGE_VIEW",
      {
        referrer:
          cleanString(
            document.referrer,
            2000
          ) || null,
      }
    );
  }

  function getElementClass(el) {
    if (
      typeof el.className ===
      "string"
    ) {
      return el.className.slice(
        0,
        MAX_CLASS_LENGTH
      );
    }

    return null;
  }

  function getElementId(el) {
    return (
      typeof el.id ===
      "string"
        ? el.id.slice(
            0,
            200
          )
        : null
    );
  }

  function setupClickTracking() {
    if (
      !config.autoTrack
    ) {
      return;
    }

    document.addEventListener(
      "click",
      function (event) {
        let el =
          event.target;

        if (
          !el ||
          !(el instanceof Element)
        ) {
          return;
        }

        /*
         * Track the nearest useful element instead of
         * blindly collecting arbitrary DOM text.
         */
        const interactive =
          el.closest(
            "a,button,[role='button'],input,textarea,select"
          ) || el;

        const tag =
          cleanString(
            interactive.tagName,
            30
          ).toLowerCase();

        const payload = {
          type: "click",

          tag:
            interactive.tagName ||
            null,

          id:
            getElementId(
              interactive
            ),

          class:
            getElementClass(
              interactive
            ),
        };

        /*
         * Click text is OFF by default because visible
         * page text can contain customer information.
         */
        if (
          config.captureClickText &&
          ![
            "input",
            "textarea",
            "select",
          ].includes(tag)
        ) {
          payload.text =
            cleanString(
              interactive.innerText,
              120
            );
        }

        track(
          "BEHAVIOR",
          payload
        );
      },
      true
    );
  }

  /* ─────────────────────────────────────────────
     SESSION END
     
     Exactly one SESSION_END per SDK lifetime.
  ───────────────────────────────────────────── */

  function setupUnloadTracking() {
    const handleSessionEnd =
      () => {
        if (
          state.sessionEnded
        ) {
          return;
        }

        state.sessionEnded =
          true;

        track(
          "SESSION_END",
          {
            duration:
              Math.max(
                0,
                now() -
                  state.pageStart
              ),
          },
          {
            keepalive:
              true,
          }
        );
      };

    window.addEventListener(
      "pagehide",
      handleSessionEnd,
      {
        once: true,
      }
    );

    /*
     * Visibility change is useful for mobile browsers,
     * but only marks the session once.
     */
    document.addEventListener(
      "visibilitychange",
      () => {
        if (
          document.visibilityState ===
          "hidden"
        ) {
          handleSessionEnd();
        }
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

    config =
      buildConfig(
        scriptConfig,
        userConfig
      );

    config.apiBase =
      DEFAULT_API_BASE;

    config.timeout =
      Math.max(
        1000,
        Math.min(
          Number(
            DEFAULTS.timeout
          ),
          30000
        )
      );

    config.sessionKey =
      DEFAULTS.sessionKey;

    if (
      !isValidSiteId(
        config.siteId
      )
    ) {
      warn(
        "invalid or missing siteId"
      );

      return api;
    }

    if (
      !isValidApiKey(
        config.apiKey
      )
    ) {
      warn(
        "invalid or missing apiKey"
      );

      return api;
    }

    ensureSession();

    state.pageStart =
      now();

    state.sessionEnded =
      false;

    setupPageTracking();
    setupClickTracking();
    setupUnloadTracking();

    state.initialized =
      true;

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

    applyRule,

    applyRules,

    updateText,

    /*
     * Compatibility function.
     * Does NOT inject HTML.
     */
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
      /*
       * Never expose the live mutable config object.
       */
      return {
        ...config,
        apiKey:
          config.apiKey
            ? "[REDACTED]"
            : "",
      };
    },
  };

  /* ─────────────────────────────────────────────
     GLOBAL EXPORT
  ───────────────────────────────────────────── */

  window.Reden =
    api;

  /* ─────────────────────────────────────────────
     AUTO INIT
  ───────────────────────────────────────────── */

  const autoConfig =
    getScriptConfig();

  if (
    isValidSiteId(
      autoConfig.siteId
    ) &&
    isValidApiKey(
      autoConfig.apiKey
    )
  ) {
    window.Reden.init(
      autoConfig
    );
  }
})(window, document);
