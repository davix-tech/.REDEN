import crypto from "crypto";

export function verifyHmac(query) {
  const { hmac, ...params } = query;

  const message = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join("&");

  const generated = crypto
    .createHmac(
      "sha256",
      process.env.SHOPIFY_API_SECRET
    )
    .update(message)
    .digest("hex");

  return generated === hmac;
}
