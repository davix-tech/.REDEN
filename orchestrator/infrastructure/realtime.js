const subscribers = new Map();

/**
 * Subscribe to committed events for one merchant site.
 * Returns an idempotent unsubscribe function.
 */
export function subscribeToSite(siteId, listener) {
  if (typeof siteId !== "string" || !siteId || typeof listener !== "function") {
    throw new TypeError("siteId and listener are required");
  }

  let listeners = subscribers.get(siteId);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(siteId, listeners);
  }

  listeners.add(listener);
  let active = true;

  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    if (listeners.size === 0) subscribers.delete(siteId);
  };
}

/**
 * Broadcast a small, non-sensitive notification to dashboards
 * subscribed to this site. Database state remains authoritative.
 */
export function publishSiteEvent(siteId, event) {
  const listeners = subscribers.get(siteId);
  if (!listeners?.size) return 0;

  let delivered = 0;
  for (const listener of [...listeners]) {
    try {
      listener(event);
      delivered += 1;
    } catch (error) {
      // A broken dashboard connection must never fail event ingestion.
      console.error("[REALTIME LISTENER ERROR]", error);
    }
  }

  return delivered;
}

export function getSiteSubscriberCount(siteId) {
  return subscribers.get(siteId)?.size ?? 0;
}
