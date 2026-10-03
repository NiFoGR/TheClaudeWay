// Stripe: products, payment links and webhooks, so client payments land on the Money page by themselves.
// The secret key lives in Cloudflare (STRIPE_SECRET_KEY); everything Stripe gives back is stored in the settings table.
import { PACKAGES } from "./money.js";

// Pinned so the webhook payloads keep the shape the code below reads (invoice.subscription, line.type…).
export const STRIPE_VERSION = "2024-06-20";
export const WEBHOOK_EVENTS = ["checkout.session.completed", "invoice.paid", "invoice.payment_failed", "customer.subscription.deleted"];

export const stripeMode = (env) => (String(env.STRIPE_SECRET_KEY || "").startsWith("sk_live") || String(env.STRIPE_SECRET_KEY || "").startsWith("rk_live") ? "live" : "test");

/** Stripe's form encoding: {a: {b: 1}, c: [x]} → a[b]=1&c[0]=x */
export function encode(params, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") encode(Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [i, x])) : v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(env, method, path, params) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Stripe isn't connected: add STRIPE_SECRET_KEY in Cloudflare (see Setup).");
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "stripe-version": STRIPE_VERSION,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params && method !== "GET" ? encode(params) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data.error?.message || `Stripe answered ${resp.status}`;
    throw new Error(resp.status === 401 ? "Stripe rejected the key. Copy the secret key again into STRIPE_SECRET_KEY and redeploy." : `Stripe: ${msg}`);
  }
  return data;
}

/** Check a webhook really came from Stripe (Stripe-Signature: t=…,v1=…), within 5 minutes. */
export async function verifySignature(body, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(String(header || "").split(",").map((p) => p.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = String(header || "").split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!parts.t || !sigs.length || Math.abs(nowSeconds - Number(parts.t)) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${parts.t}.${body}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === expected.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0);
}

// ---------------------------------------------------------------- settings helpers

export async function getSetting(DB, key) {
  const row = await DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  try {
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

export const putSetting = (DB, key, value) =>
  DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, JSON.stringify(value)).run();

// ---------------------------------------------------------------- one-press setup

const THANKS = "Payment received, thank you! We'll be in touch today to get your website started. Your 7-day clock starts as soon as you've filled in the short onboarding form we send you.";

/** Create (once per test/live mode) the products, prices, a payment link per package, and the webhook. */
export async function setUpStripe(env, DB, origin) {
  const mode = stripeMode(env);
  const existing = await getSetting(DB, "stripe");
  if (existing?.mode === mode && existing.links && existing.webhook) return existing;

  const build = await stripe(env, "POST", "products", { name: "Website build", description: "Your new website, live in 7 days, guaranteed." });
  const monthly = await stripe(env, "POST", "products", { name: "Monthly growth plan", description: "Hosting, updates, Google Business Profile and getting you onto the front page of Google." });
  const monthlyPrice = await stripe(env, "POST", "prices", { product: monthly.id, currency: "gbp", unit_amount: PACKAGES.full.monthly, recurring: { interval: "month" } });
  const buildPrices = {};
  for (const amount of new Set(Object.values(PACKAGES).map((p) => p.build))) {
    buildPrices[amount] = await stripe(env, "POST", "prices", { product: build.id, currency: "gbp", unit_amount: amount });
  }

  const links = {};
  for (const [key, p] of Object.entries(PACKAGES)) {
    const common = {
      metadata: { goldbar_package: key },
      custom_fields: [{ key: "business", label: { type: "custom", custom: "Business name" }, type: "text" }],
      phone_number_collection: { enabled: true },
      after_completion: { type: "hosted_confirmation", hosted_confirmation: { custom_message: THANKS } },
    };
    const params = p.monthly
      ? { ...common, line_items: [{ price: buildPrices[p.build].id, quantity: 1 }, { price: monthlyPrice.id, quantity: 1 }],
          subscription_data: { trial_period_days: p.freeDays, metadata: { goldbar_package: key } } }
      : { ...common, line_items: [{ price: buildPrices[p.build].id, quantity: 1 }], customer_creation: "always" };
    const link = await stripe(env, "POST", "payment_links", params);
    links[key] = { id: link.id, url: link.url };
  }

  if (existing?.webhook?.id && existing.mode === mode) {
    await stripe(env, "DELETE", `webhook_endpoints/${existing.webhook.id}`).catch(() => {});
  }
  const hook = await stripe(env, "POST", "webhook_endpoints", {
    url: `${origin}/api/stripe/webhook`, enabled_events: WEBHOOK_EVENTS, api_version: STRIPE_VERSION,
    description: "GoldBar Control Room: payments onto the Money page",
  });
  const saved = { mode, links, webhook: { id: hook.id, secret: hook.secret, url: hook.url } };
  await putSetting(DB, "stripe", saved);
  return saved;
}
