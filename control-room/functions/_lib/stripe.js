// Stripe: the REST client (stripeApi), where the key and webhook secret come from, and the Payments health light.
// The key is saved on Setup (secret:stripe_key) or, from before Setup could take it, in Cloudflare (STRIPE_SECRET_KEY).
// Neither the key nor the webhook secret is ever returned to the browser or put in an error.
// Setup's Connect Stripe (connectStripe) saves the key and makes the webhook; stripeStatus is what the Setup card shows.
// The Payments light is registered with stage 0's registerLight when this module loads (tick.js imports it).
import { registerLight } from "./health.js";
import { beat } from "./routines.js";
import { getSecret, getSetting as getText, setSecret, setSetting } from "./settings.js";
import { closeTodos } from "./todo.js";
import { now as nowIso, parseJson } from "./util.js";

// Pinned so the webhook payloads keep the shape the code reads (invoice.subscription, line.type…), on every call
// and on the webhook endpoint.
export const STRIPE_VERSION = "2024-06-20";
export const WEBHOOK_EVENTS = ["checkout.session.completed", "checkout.session.expired", "invoice.paid",
  "invoice.payment_failed", "customer.subscription.deleted", "charge.refunded"];

const API = "https://api.stripe.com/v1/";
const NOT_CONNECTED = "Stripe isn't connected: connect it on Setup.";
const BAD_KEY = "Stripe didn't accept that key. Copy it again from Stripe → Developers → API keys.";
const NOT_ALLOWED_WEBHOOKS = 'That key isn\'t allowed to create webhooks. Use the secret key, or a restricted key with "Full access – except sensitive operations".';
const UNREACHABLE = "Couldn't reach Stripe. Try again in a minute.";
// Anything shaped like a Stripe key or webhook secret, so a Stripe message that quotes one never reaches a log.
const SECRET_RE = /\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9*]+|\bwhsec_[A-Za-z0-9*]+/g;

/** Short fingerprint of a key (16 hex), so switching to a different Stripe account (or key) is noticed. */
export async function keyId(key) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(key || "")));
  return [...new Uint8Array(hash)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "live" for sk_live_…/rk_live_… keys, otherwise "test". */
export const stripeMode = (key) => (/^(sk|rk)_live_/.test(String(key || "")) ? "live" : "test");

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

function stripeError(message, status) {
  return Object.assign(new Error(String(message).replace(SECRET_RE, "[key hidden]")), { status });
}

/**
 * One Stripe API call: form-encoded, Stripe-Version pinned. GET and DELETE params go in the query string (a GET or
 * DELETE never sends a body); POST params are the form body. Returns Stripe's JSON; throws an Error with a plain-English message and the HTTP `status` (0 when
 * there's no key or Stripe can't be reached).
 */
export async function stripeApi(key, method, path, params = null, fetchImpl = fetch) {
  if (!key) throw stripeError(NOT_CONNECTED, 0);
  const verb = String(method || "GET").toUpperCase();
  const inQuery = verb === "GET" || verb === "DELETE";
  const query = params && inQuery ? encode(params).toString() : "";
  const url = API + path + (query ? (String(path).includes("?") ? "&" : "?") + query : "");
  let resp;
  try {
    resp = await fetchImpl(url, {
      method: verb,
      headers: {
        authorization: `Bearer ${key}`,
        "stripe-version": STRIPE_VERSION,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params && !inQuery ? encode(params).toString() : undefined,
    });
  } catch {
    throw stripeError(UNREACHABLE, 0);
  }
  const data = await resp.json().catch(() => ({}));
  if (resp.ok) return data;
  if (resp.status === 401) throw stripeError(BAD_KEY, 401);
  if (resp.status === 403 && /^webhook_endpoints/.test(String(path))) throw stripeError(NOT_ALLOWED_WEBHOOKS, 403);
  const message = data?.error?.message;
  if (message) throw stripeError(`Stripe: ${message}`, resp.status);
  throw stripeError(`Stripe answered ${resp.status}. Try again in a minute.`, resp.status);
}

/** The key to use: the one saved on Setup first, else Cloudflare's STRIPE_SECRET_KEY; null when there's neither. */
export async function stripeKey(env, DB) {
  const saved = DB ? await getSecret(DB, "stripe_key") : null;
  if (saved) return { key: saved, source: "setup" };
  if (env?.STRIPE_SECRET_KEY) return { key: String(env.STRIPE_SECRET_KEY), source: "cloudflare" };
  return null;
}

/** The webhook signing secret: Connect Stripe's (secret:stripe_webhook), else the old payment-link setup's. */
export async function webhookSecret(DB) {
  const saved = await getSecret(DB, "stripe_webhook");
  if (saved) return saved;
  const legacy = parseJson(await getText(DB, "stripe"), null)?.webhook?.secret;
  return typeof legacy === "string" && legacy ? legacy : null;
}

/**
 * Is the saved webhook (settings "stripe:webhook" = {id, url, events, mode, key_id, created_at}, parsed) the one this
 * key would make now: same key, same mode, and exactly WEBHOOK_EVENTS?
 */
export async function webhookCurrent(saved, key) {
  if (!key || !saved || typeof saved !== "object" || !saved.id || !Array.isArray(saved.events)) return false;
  const events = new Set(saved.events);
  return saved.mode === stripeMode(key) && saved.key_id === (await keyId(key))
    && events.size === WEBHOOK_EVENTS.length && WEBHOOK_EVENTS.every((e) => events.has(e));
}

/** The subscription an invoice belongs to, in both payload shapes (2024-06-20's and the newer `parent`). */
export function invoiceSubscription(inv) {
  const sub = inv?.subscription ?? inv?.parent?.subscription_details?.subscription ?? null;
  if (sub && typeof sub === "object") return sub.id || null; // expanded
  return typeof sub === "string" && sub ? sub : null;
}

const LIGHT_RED_HOURS = 24;

/**
 * The Payments health light (pure). beat = the `stripe` heartbeats row {ok, last_at, detail} or null.
 * grey: no key; amber: key but no or outdated webhook; red: the last beat failed less than 24 hours ago; else green.
 */
export function stripeLight({ hasKey, webhookCurrent: current, beat } = {}, now = new Date()) {
  const name = "payments";
  if (!hasKey) return { name, level: "grey", detail: "Not connected", fix: "Paste your Stripe key on Setup and press Connect Stripe" };
  if (!current) return { name, level: "amber", detail: "Stripe can't send us payment messages yet", fix: "Press Connect Stripe on Setup" };
  if (beat && !(beat.ok === true || Number(beat.ok) === 1)) {
    const age = new Date(now).getTime() - Date.parse(beat.last_at ?? "");
    if (age < LIGHT_RED_HOURS * 3600_000) {
      return { name, level: "red", detail: String(beat.detail ?? ""), fix: "Open Setup → Payments (Stripe). If it says connected, press Connect Stripe again" };
    }
  }
  return { name, level: "green", detail: "Working", fix: "" };
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

// ---------------------------------------------------------------- Connect Stripe (Setup)

const KEY_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const PUBLISHABLE = "That's the publishable key (pk_…). Paste the secret key instead: Stripe → Developers → API keys.";
const NOT_A_KEY = "That doesn't look like a Stripe secret key. It starts with sk_ or rk_ (Stripe → Developers → API keys).";
const NO_KEY = "Paste your Stripe secret key first (Stripe → Developers → API keys), then press Connect Stripe.";
const NO_ORIGIN = "Couldn't work out this Control Room's web address for Stripe's messages. Open Setup from its usual address and try again.";
const NO_SECRET = "Stripe made the webhook but didn't send back its signing secret. Press Connect Stripe again.";
const PREVIEW = "That's a preview link of one deployment, so Stripe's messages would go to an old copy of the Control Room. Open the Control Room from its usual address and press Connect Stripe there.";
// Cloudflare Pages' per-deployment links: <8 hex>.<project>.pages.dev (a preview's own bindings, frozen code).
const PREVIEW_HOST_RE = /^[0-9a-f]{8}\.[a-z0-9-]+\.pages\.dev$/i;

const keyError = (message) => Object.assign(new Error(message), { status: 400 });

// DELETE an endpoint we made before; one already deleted in Stripe's dashboard (404) is fine.
async function deleteEndpoint(key, id, fetchImpl) {
  try {
    await stripeApi(key, "DELETE", `webhook_endpoints/${encodeURIComponent(id)}`, null, fetchImpl);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

// Make the webhook; returns Stripe's endpoint (with its signing secret) or throws Part A's text.
async function createEndpoint(key, url, fetchImpl) {
  const hook = await stripeApi(key, "POST", "webhook_endpoints", {
    url,
    enabled_events: WEBHOOK_EVENTS,
    api_version: STRIPE_VERSION,
    description: "Aetos Control Room: payments land on the Money page",
  }, fetchImpl);
  if (!hook?.id || typeof hook.secret !== "string" || !hook.secret) throw Object.assign(new Error(NO_SECRET), { status: 502 });
  return hook;
}

/**
 * Setup's Connect Stripe: check the key's shape, delete the endpoint we made earlier with this same key (Connect
 * Stripe's, and the old payment-link setup's), make the webhook (STRIPE_VERSION, the six WEBHOOK_EVENTS) at
 * {origin}/api/stripe/webhook, then save secret:stripe_key (only a key typed on Setup; without one, the saved key or
 * Cloudflare's STRIPE_SECRET_KEY is used), secret:stripe_webhook and the setting "stripe:webhook" =
 * JSON {id, url, events, mode, key_id, created_at}, close the setup:stripe todo and set the `stripe` heartbeat
 * good (pressing Connect Stripe is the red light's fix). Nothing is saved when any Stripe call fails; only when the
 * old endpoint was deleted and making the new one then failed, the "stripe:webhook" setting naming the deleted one is
 * removed, so the card and the light say "not connected" instead of "connected ✓". Throws an Error with Part A's
 * plain-English text (never the key).
 */
export async function connectStripe(DB, env, { key, origin } = {}, { fetchImpl = fetch } = {}) {
  const typed = typeof key === "string" ? key.trim() : "";
  if (typed && /^pk_/.test(typed)) throw keyError(PUBLISHABLE);
  if (typed && !KEY_RE.test(typed)) throw keyError(NOT_A_KEY);
  const use = typed || (await stripeKey(env, DB))?.key;
  if (!use) throw keyError(NO_KEY);
  let base;
  try {
    base = new URL(String(origin)).origin;
  } catch {
    throw keyError(NO_ORIGIN);
  }
  if (!/^https?:\/\//.test(base)) throw keyError(NO_ORIGIN);
  if (PREVIEW_HOST_RE.test(new URL(base).hostname)) throw keyError(PREVIEW);

  const mode = stripeMode(use);
  const key_id = await keyId(use);
  const saved = parseJson(await getText(DB, "stripe:webhook"), null);
  const legacy = parseJson(await getText(DB, "stripe"), null);
  const old = new Set();
  if (saved?.id && saved.key_id === key_id) old.add(String(saved.id));
  if (legacy?.webhook?.id && legacy.key === key_id) old.add(String(legacy.webhook.id));
  for (const id of old) await deleteEndpoint(use, id, fetchImpl);

  const url = `${base}/api/stripe/webhook`;
  let hook;
  try {
    hook = await createEndpoint(use, url, fetchImpl);
  } catch (err) {
    // The saved endpoint is gone from Stripe now: don't leave the card saying "connected ✓".
    if (saved?.id && old.has(String(saved.id))) await DB.prepare("DELETE FROM settings WHERE key = 'stripe:webhook'").run();
    throw err;
  }

  const events = Array.isArray(hook.enabled_events) && hook.enabled_events.length ? hook.enabled_events.map(String) : [...WEBHOOK_EVENTS];
  if (typed) await setSecret(DB, "stripe_key", typed);
  await setSecret(DB, "stripe_webhook", hook.secret);
  await setSetting(DB, "stripe:webhook", JSON.stringify({ id: String(hook.id), url: String(hook.url || url), events, mode, key_id, created_at: nowIso() }));
  await closeTodos(DB, "setup:stripe");
  await beat(DB, "stripe", true, `Connect Stripe pressed (${mode} mode)`);
  return { mode, webhook_url: String(hook.url || url) };
}

// Everything the Setup card and the Payments light need, in one statement: the key saved on Setup (read only on the
// server, never returned: webhookCurrent needs its fingerprint and mode), the saved webhook and the `stripe` heartbeat;
// the Setup card also reads the newest stripe_events row (the light doesn't, so a health check never scans that table).
const factsSql = (withEvent) => `SELECT
  (SELECT value FROM settings WHERE key = 'secret:stripe_key') AS saved_key,
  (SELECT value FROM settings WHERE key = 'stripe:webhook') AS webhook,
  h.ok AS beat_ok, h.last_at AS beat_at, h.detail AS beat_detail${withEvent ? `,
  e.type AS event_type, e.at AS event_at, e.result AS event_result` : ""}
  FROM (SELECT 1) AS one
  LEFT JOIN heartbeats AS h ON h.name = 'stripe'${withEvent ? `
  LEFT JOIN (SELECT type, at, result FROM stripe_events ORDER BY at DESC, rowid DESC LIMIT 1) AS e ON 1 = 1` : ""}`;
const STATUS_SQL = factsSql(true);
const LIGHT_SQL = factsSql(false);

async function stripeFacts(DB, env, sql = STATUS_SQL) {
  const row = (await DB.prepare(sql).first()) || {};
  const setupKey = row.saved_key ? String(row.saved_key) : null; // empty counts as not set, as getSecret does
  const envKey = env?.STRIPE_SECRET_KEY ? String(env.STRIPE_SECRET_KEY) : null;
  const key = setupKey || envKey;
  const saved = parseJson(row.webhook, null);
  return {
    key,
    source: setupKey ? "setup" : envKey ? "cloudflare" : null,
    saved: saved && typeof saved === "object" ? saved : null,
    beat: row.beat_at ? { ok: row.beat_ok, last_at: row.beat_at, detail: row.beat_detail ?? "" } : null,
    event: row.event_type ? { type: row.event_type, at: row.event_at, result: row.event_result } : null,
  };
}

/**
 * The Setup card's facts. Never the key or the webhook secret: only whether there is a key, where it's from and its
 * mode, whether a webhook was made and is current for this key, the newest Stripe message, and the last beat's
 * error (null once a message has been handled). 1 D1 statement.
 */
export async function stripeStatus(DB, env) {
  const f = await stripeFacts(DB, env);
  const failed = f.beat && !(f.beat.ok === true || Number(f.beat.ok) === 1);
  return {
    key: !!f.key,
    key_source: f.source,
    mode: f.key ? stripeMode(f.key) : null,
    webhook: !!f.saved?.id,
    webhook_current: await webhookCurrent(f.saved, f.key),
    last_event: f.event,
    last_error: failed ? String(f.beat.detail || "A Stripe message failed") : null,
  };
}

/** The Payments health light from the database: stripeLight on stripeFacts. 1 D1 statement. */
export async function paymentsLight(DB, env, now = new Date()) {
  const f = await stripeFacts(DB, env, LIGHT_SQL);
  return stripeLight({ hasKey: !!f.key, webhookCurrent: await webhookCurrent(f.saved, f.key), beat: f.beat }, now);
}

// ---------------------------------------------------------------- JSON settings helpers
// The old JSON-valued settings (stripe, territory, setup_done…); outreach-db.js, find.js and others still use them.

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

// The Payments light, in every isolate that loads this module (tick.js imports it, so /api/health and the health
// tick always have it).
registerLight(paymentsLight);
