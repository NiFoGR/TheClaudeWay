// Stripe helpers (stripe.js) and Money's "Stopped paying". Run: node --test control-room/tests/stripe.test.mjs
// The webhook and its events are tested in stripe-events.test.mjs (and a paid checkout in stripe-fulfil.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { setSecret, setSetting } from "../functions/_lib/settings.js";
import {
  STRIPE_VERSION, WEBHOOK_EVENTS, encode, invoiceSubscription, keyId, stripeApi, stripeKey, stripeLight, stripeMode,
  verifySignature, webhookCurrent, webhookSecret,
} from "../functions/_lib/stripe.js";
import { onRequestPatch as patchClient } from "../functions/api/money/clients/[id].js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { decodeForm, fakeStripe } from "./helpers/fakeStripe.mjs";

// ---------------------------------------------------------------- the Stripe client helpers

test("constants: version pinned, the six webhook events", () => {
  assert.equal(STRIPE_VERSION, "2024-06-20");
  assert.deepEqual(WEBHOOK_EVENTS, ["checkout.session.completed", "checkout.session.expired", "invoice.paid",
    "invoice.payment_failed", "customer.subscription.deleted", "charge.refunded"]);
});

test("stripeApi pins version and form-encodes", async () => {
  const { fetchImpl, calls } = fakeStripe({ "POST checkout/sessions": { id: "cs_1" } });
  assert.deepEqual(await stripeApi("sk_test_x", "POST", "checkout/sessions", { a: { b: 1 } }, fetchImpl), { id: "cs_1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "checkout/sessions");
  assert.equal(calls[0].headers["stripe-version"], "2024-06-20");
  assert.equal(calls[0].headers.authorization, "Bearer sk_test_x");
  assert.equal(calls[0].headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(calls[0].params, { a: { b: "1" } });
  // the raw body is a[b]=1
  const seen = [];
  await stripeApi("sk_test_x", "POST", "checkout/sessions", { a: { b: 1 } }, async (url, init) => {
    seen.push({ url, body: String(init.body) });
    return new Response("{}", { status: 200 });
  });
  assert.equal(seen[0].url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(decodeURIComponent(seen[0].body), "a[b]=1");
});

test("stripeApi: GET and DELETE send no body; GET params go in the query string", async () => {
  const { fetchImpl, calls } = fakeStripe({
    "GET charges/ch_1?expand[]=balance_transaction": { balance_transaction: { fee: 2950 } },
    "DELETE webhook_endpoints/we_0": { id: "we_0", deleted: true },
    "GET checkout/sessions/cs_1": { id: "cs_1" },
  });
  assert.equal((await stripeApi("sk_test_x", "GET", "charges/ch_1?expand[]=balance_transaction", null, fetchImpl)).balance_transaction.fee, 2950);
  assert.equal((await stripeApi("sk_test_x", "DELETE", "webhook_endpoints/we_0", undefined, fetchImpl)).deleted, true);
  await stripeApi("sk_test_x", "GET", "checkout/sessions/cs_1", { expand: ["subscription"] }, fetchImpl);
  assert.deepEqual(calls[0].params, { expand: ["balance_transaction"] }); // a GET's params are its query string
  assert.equal(calls[1].params, null);
  assert.equal(calls[2].path, "checkout/sessions/cs_1?expand[0]=subscription");
  assert.deepEqual(calls[2].params, { expand: ["subscription"] });
});

test("stripeApi: DELETE params go in the query string, never a body", async () => {
  const seen = [];
  await stripeApi("sk_test_x", "DELETE", "subscriptions/sub_1", { invoice_now: true }, async (url, init) => {
    seen.push({ url, body: init.body, method: init.method });
    return new Response("{}", { status: 200 });
  });
  assert.equal(seen[0].method, "DELETE");
  assert.equal(seen[0].url, "https://api.stripe.com/v1/subscriptions/sub_1?invoice_now=true");
  assert.equal(seen[0].body, undefined);
});

test("stripeApi errors are plain English", async () => {
  const { fetchImpl } = fakeStripe({
    "POST bad/key": { status: 401, error: { message: "Invalid API Key provided: sk_test_****abcd" } },
    "POST prices": { status: 400, error: { message: "No such price" } },
    "POST webhook_endpoints": { status: 403, error: { message: "The provided key does not have the required permissions" } },
    "POST odd": { status: 500, error: {} },
  });
  await assert.rejects(stripeApi("sk_test_x", "POST", "bad/key", {}, fetchImpl), (e) => {
    assert.equal(e.message, "Stripe didn't accept that key. Copy it again from Stripe → Developers → API keys.");
    assert.equal(e.status, 401);
    return true;
  });
  await assert.rejects(stripeApi("sk_test_x", "POST", "prices", {}, fetchImpl), (e) => {
    assert.equal(e.message, "Stripe: No such price");
    assert.equal(e.status, 400);
    return true;
  });
  await assert.rejects(stripeApi("sk_test_x", "POST", "webhook_endpoints", {}, fetchImpl), (e) => {
    assert.equal(e.message, 'That key isn\'t allowed to create webhooks. Use the secret key, or a restricted key with "Full access – except sensitive operations".');
    assert.equal(e.status, 403);
    return true;
  });
  await assert.rejects(stripeApi("sk_test_x", "POST", "odd", {}, fetchImpl), (e) => e.status === 500 && /^Stripe answered 500/.test(e.message));
  // a 403 anywhere but webhook_endpoints keeps Stripe's own words (the webhook text would be untrue there)
  const { fetchImpl: perm } = fakeStripe({ "POST checkout/sessions": { status: 403, error: "This key can't create Checkout Sessions" } });
  await assert.rejects(stripeApi("rk_test_x", "POST", "checkout/sessions", {}, perm), (e) => e.status === 403 && e.message === "Stripe: This key can't create Checkout Sessions");
  // network failure
  const down = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(stripeApi("sk_test_x", "GET", "balance", null, down), (e) => e.message === "Couldn't reach Stripe. Try again in a minute.");
  // a route that throws is a network failure too
  const { fetchImpl: throwing } = fakeStripe({ "GET balance": () => { throw new Error("offline"); } });
  await assert.rejects(stripeApi("sk_test_x", "GET", "balance", null, throwing), /Couldn't reach Stripe/);
  // a string error (stage 10's tests use this shape)
  const { fetchImpl: str } = fakeStripe({ "POST subscriptions/sub_x": { status: 400, error: "No such subscription: 'sub_x'" } });
  await assert.rejects(stripeApi("sk_test_x", "POST", "subscriptions/sub_x", {}, str), (e) => e.message === "Stripe: No such subscription: 'sub_x'");
});

test("stripeApi with no key makes no call", async () => {
  const { fetchImpl, calls } = fakeStripe({});
  await assert.rejects(stripeApi(undefined, "POST", "subscriptions/sub_1", {}, fetchImpl), (e) => e.message === "Stripe isn't connected: connect it on Setup.");
  await assert.rejects(stripeApi(null, "GET", "balance", null, fetchImpl));
  assert.equal(calls.length, 0);
});

test("stripeApi never puts a key in an error", async () => {
  const { fetchImpl } = fakeStripe({ "POST x": { status: 400, error: { message: "Key rk_test_abc123456789 and whsec_abc12345 are odd" } } });
  await assert.rejects(stripeApi("rk_test_abc123456789", "POST", "x", {}, fetchImpl), (e) => !/abc123|whsec_abc/.test(e.message));
});

test("stripeKey prefers Setup", async () => {
  const DB = fakeD1();
  assert.equal(await stripeKey({}, DB), null);
  assert.deepEqual(await stripeKey({ STRIPE_SECRET_KEY: "sk_test_env" }, DB), { key: "sk_test_env", source: "cloudflare" });
  await setSecret(DB, "stripe_key", "rk_test_setup");
  assert.deepEqual(await stripeKey({ STRIPE_SECRET_KEY: "sk_test_env" }, DB), { key: "rk_test_setup", source: "setup" });
  assert.deepEqual(await stripeKey({}, DB), { key: "rk_test_setup", source: "setup" });
});

test("stripeMode", () => {
  assert.equal(stripeMode("sk_live_abc"), "live");
  assert.equal(stripeMode("rk_live_abc"), "live");
  assert.equal(stripeMode("sk_test_abc"), "test");
  assert.equal(stripeMode("rk_test_abc"), "test");
});

test("keyId is a 16-hex fingerprint that tells keys apart", async () => {
  const a = await keyId("rk_test_kofi");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(await keyId("rk_test_kofi"), a);
  assert.notEqual(await keyId("rk_test_aetos"), a);
});

test("webhookSecret falls back to legacy", async () => {
  const DB = fakeD1();
  assert.equal(await webhookSecret(DB), null);
  await setSetting(DB, "stripe", JSON.stringify({ webhook: { secret: "whsec_old" } }));
  assert.equal(await webhookSecret(DB), "whsec_old");
  await setSecret(DB, "stripe_webhook", "whsec_new");
  assert.equal(await webhookSecret(DB), "whsec_new");
  const broken = fakeD1();
  await setSetting(broken, "stripe", "{not json");
  assert.equal(await webhookSecret(broken), null);
});

test("webhookCurrent: same key, same mode, the six events", async () => {
  const key = "rk_test_kofi";
  const saved = { id: "we_1", url: "https://x.test/api/stripe/webhook", events: [...WEBHOOK_EVENTS].reverse(), mode: "test", key_id: await keyId(key) };
  assert.equal(await webhookCurrent(saved, key), true);
  assert.equal(await webhookCurrent(saved, "rk_test_other"), false);
  assert.equal(await webhookCurrent({ ...saved, events: WEBHOOK_EVENTS.slice(0, 4) }, key), false);
  assert.equal(await webhookCurrent({ ...saved, mode: "live" }, key), false);
  assert.equal(await webhookCurrent(null, key), false);
  assert.equal(await webhookCurrent(saved, null), false);
});

test("invoiceSubscription both shapes", () => {
  assert.equal(invoiceSubscription({ subscription: "sub_1" }), "sub_1");
  assert.equal(invoiceSubscription({ parent: { subscription_details: { subscription: "sub_2" } } }), "sub_2");
  assert.equal(invoiceSubscription({ subscription: { id: "sub_3" } }), "sub_3"); // expanded
  assert.equal(invoiceSubscription({}), null);
  assert.equal(invoiceSubscription(null), null);
});

test("stripeLight", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const ago = (h) => new Date(now.getTime() - h * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const results = {
    none: stripeLight({ hasKey: false, webhookCurrent: false, beat: null }, now),
    noHook: stripeLight({ hasKey: true, webhookCurrent: false, beat: null }, now),
    red: stripeLight({ hasKey: true, webhookCurrent: true, beat: { ok: 0, last_at: ago(1), detail: "x" } }, now),
    old: stripeLight({ hasKey: true, webhookCurrent: true, beat: { ok: 0, last_at: ago(25) } }, now),
    fine: stripeLight({ hasKey: true, webhookCurrent: true, beat: { ok: 1, last_at: ago(1), detail: "ok" } }, now),
    never: stripeLight({ hasKey: true, webhookCurrent: true, beat: null }, now),
  };
  for (const light of Object.values(results)) {
    assert.equal(light.name, "payments");
    assert.deepEqual(Object.keys(light).sort(), ["detail", "fix", "level", "name"]);
  }
  assert.deepEqual(results.none, { name: "payments", level: "grey", detail: "Not connected", fix: "Paste your Stripe key on Setup and press Connect Stripe" });
  assert.deepEqual(results.noHook, { name: "payments", level: "amber", detail: "Stripe can't send us payment messages yet", fix: "Press Connect Stripe on Setup" });
  assert.deepEqual(results.red, { name: "payments", level: "red", detail: "x", fix: "Open Setup → Payments (Stripe). If it says connected, press Connect Stripe again" });
  assert.deepEqual(results.old, { name: "payments", level: "green", detail: "Working", fix: "" });
  assert.equal(results.fine.level, "green");
  assert.equal(results.never.level, "green");
});

test("fakeStripe decodes Stripe's form encoding", () => {
  assert.deepEqual(decodeForm(encode({ pause_collection: "", metadata: { a: "" }, events: ["x", "y"], n: 5 }).toString()),
    { pause_collection: "", metadata: { a: "" }, events: ["x", "y"], n: "5" });
  assert.equal(decodeForm(""), null);
});

// ---------------------------------------------------------------- Money → Stopped paying cancels the Stripe subscription

async function stopPaying(DB, env, fetchStub) {
  const real = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    const request = new Request("https://control.x/api/money/clients/cl_1", { method: "PATCH", body: JSON.stringify({ cancelled_on: "2026-12-01" }) });
    const resp = await patchClient({ request, env: { DB, ...env }, params: { id: "cl_1" } });
    return { status: resp.status, body: await resp.json() };
  } finally {
    globalThis.fetch = real;
  }
}

function seedCardClient() {
  const DB = fakeD1();
  DB.raw.exec(`INSERT INTO clients (id, name, package, build_fee_pence, monthly_pence, free_days, paid_on, created_at)
    VALUES ('cl_1', 'Smith Roofing', 'full', 195000, 24900, 60, '2026-10-01', '2026-10-01T12:00:00Z')`);
  DB.raw.exec(`INSERT INTO client_links (client_id, stripe_customer, stripe_subscription) VALUES ('cl_1', 'cus_1', 'sub_1')`);
  return DB;
}

test("Stopped paying cancels the subscription with the key saved on Setup", async () => {
  const DB = seedCardClient();
  await setSecret(DB, "stripe_key", "rk_test_setup123456");
  const { fetchImpl, calls } = fakeStripe({ "DELETE subscriptions/sub_1": { id: "sub_1", status: "canceled" } });
  const res = await stopPaying(DB, { STRIPE_SECRET_KEY: "sk_test_old" }, fetchImpl);
  assert.equal(res.status, 200);
  assert.equal(res.body.client.cancelled_on, "2026-12-01");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].path, "subscriptions/sub_1");
  assert.equal(calls[0].headers.authorization, "Bearer rk_test_setup123456");
  assert.equal(calls[0].headers["stripe-version"], "2024-06-20");
});

test("Stopped paying: already gone in Stripe still stops; no key or a refusal leaves it unchanged", async () => {
  const gone = seedCardClient();
  await setSecret(gone, "stripe_key", "sk_test_k");
  const missing = fakeStripe({ "DELETE subscriptions/sub_1": { status: 404, error: "No such subscription: 'sub_1'" } });
  assert.equal((await stopPaying(gone, {}, missing.fetchImpl)).body.client.cancelled_on, "2026-12-01");

  const noKey = seedCardClient();
  const none = fakeStripe({});
  const res = await stopPaying(noKey, {}, none.fetchImpl);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, "Couldn't cancel their card payments in Stripe: Stripe isn't connected: connect it on Setup.");
  assert.equal(none.calls.length, 0);
  assert.equal(noKey.raw.prepare("SELECT cancelled_on FROM clients").get().cancelled_on, null);

  const refused = seedCardClient();
  await setSecret(refused, "stripe_key", "sk_test_k");
  const bad = fakeStripe({ "DELETE subscriptions/sub_1": { status: 401, error: "Invalid API Key provided: sk_test_****k" } });
  const res2 = await stopPaying(refused, {}, bad.fetchImpl);
  assert.equal(res2.status, 502);
  assert.match(res2.body.error, /Stripe didn't accept that key/);
  assert.equal(refused.raw.prepare("SELECT cancelled_on FROM clients").get().cancelled_on, null);
});

test("Stripe form encoding handles nested objects and arrays", () => {
  const s = encode({ line_items: [{ price: "p1", quantity: 1 }], subscription_data: { trial_period_days: 60 } }).toString();
  assert.equal(decodeURIComponent(s), "line_items[0][price]=p1&line_items[0][quantity]=1&subscription_data[trial_period_days]=60");
});

test("webhook signature: genuine passes, tampered or stale fails", async () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1"}';
  const t = 1_800_000_000;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(await verifySignature(body, `t=${t},v1=${sig}`, secret, t + 10), true);
  assert.equal(await verifySignature(body + " ", `t=${t},v1=${sig}`, secret, t + 10), false);
  assert.equal(await verifySignature(body, `t=${t},v1=${sig}`, secret, t + 1000), false);
  assert.equal(await verifySignature(body, "", secret, t), false);
});
