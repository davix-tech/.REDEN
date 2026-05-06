// redis.js
import Redis from "ioredis";

let redis = null;

export function initRedis() {
  const url = process.env.REDIS_URL;

  if (!url) {
    console.log("[REDIS] disabled (no REDIS_URL)");
    return null;
  }

  try {
    redis = new Redis(url, {
      lazyConnect: true,          // don't connect immediately
      maxRetriesPerRequest: 0,    // prevent hanging
      enableReadyCheck: false,
      reconnectOnError: () => false // no infinite reconnect loop
    });

    redis.connect()
      .then(() => console.log("[REDIS] connected"))
      .catch(() => console.log("[REDIS] unavailable — continuing without it"));

  } catch (e) {
    console.log("[REDIS] init failed — continuing without it");
    redis = null;
  }

  return redis;
}

export { redis };
