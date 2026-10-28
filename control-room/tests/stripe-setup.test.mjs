// Connect Stripe on Setup, its status (never a secret) and the Payments health light (08-order-pay Task 11).
// Run: node --test control-room/tests/stripe-setup.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { healthFromDb, healthStep, registerLight } from "../functions/_lib/health.js";
import { getSecret, getSetting, setSecret, setSetting } from "../functions/_lib/settings.js";
import { WEBHOOK_EVENTS, connectStripe, keyId, paymentsLight, stripeStatus } from "../functions/_lib/stripe.js";
import { addTodo } from "../functions/_lib/todo.js";
import { onRequestGet, onRequestPost } from "../functions/api/stripe/setup.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { fakeStripe } from "./helpers/fakeStripe.mjs";

const KEY = "rk_test_abc123456789";
const NOW = new Date("2026-10-28T12:00:00Z");
const HOOK = { id: "we_1", secret: "whsec_new", url: "https://x.test/api/stripe/webhook" };

const PUBLISHABLE = "That's the publishable key (pk_…). Paste the secret key instead: Stripe → Developers → API keys.";
const NOT_A_KEY = "That doesn't look like a Stripe secret key. It starts with sk_ or rk_ (Stripe → Developers → API keys).";
const BAD_KEY = "Stripe didn't accept that key. Copy it again from Stripe → Developers → API keys.";
const NO_WEBHOOKS = 'That key isn\'t allowed to create webhooks. Use the secret key, or a restricted key with "Full access – except sensitive operations".';
const UNREACHABLE = "Couldn't reach Stripe. Try again in a minute.";

const todo = (DB, dedupe) => DB.prepare("SELECT * FROM todos WHERE dedupe = ?").bind(dedupe).first();
const openTodo = (DB, dedupe) => DB.prepare("SELECT * FROM todos WHERE dedupe = ? AND status = 'open'").bind(dedupe).first();

// A saved key with the webhook Connect Stripe would make for it now.
async function connected(DB, { key = KEY, events = WEBHOOK_EVENTS } = {}) {
  await setSecret(DB, "stripe_key", key);
  await setSecret(DB, "stripe_webhook", "whsec_saved");
  await setSetting(DB, "stripe:webhook", JSON.stringify({
    id: "we_0", url: "https://x.test/api/stripe/webhook", events, mode: "test", key_id: await keyId(key), created_at: "2026-10-01T09:00:00Z",
  }));
}

async function rejects(promise, message) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.message, message);
    return true;
  });
}

// ---------------------------------------------------------------- connectStripe

test("connect with a new key", async () => {
  const DB = fakeD1();
  await addTodo(DB, { kind: "setup", title: "Connect Stripe: Ace Roofing tried to order", link: "/#/setup", dedupe: "setup:stripe" });
  const { fetchImpl, calls } = fakeStripe({ "POST webhook_endpoints": HOOK });
  const out = await connectStripe(DB, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl });
  assert.equal(out.mode, "test");
  assert.equal(out.webhook_url, "https://x.test/api/stripe/webhook");
  assert.deepEqual(Object.keys(out).sort(), ["mode", "webhook_url"]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "webhook_endpoints");
  assert.equal(calls[0].params.url, "https://x.test/api/stripe/webhook");
  assert.equal(calls[0].params.api_version, "2024-06-20");
  assert.deepEqual(calls[0].params.enabled_events, WEBHOOK_EVENTS);
  assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);

  assert.equal(await getSecret(DB, "stripe_key"), KEY);
  assert.equal(await getSecret(DB, "stripe_webhook"), "whsec_new");
  const saved = JSON.parse(await getSetting(DB, "stripe:webhook"));
  assert.deepEqual(Object.keys(saved).sort(), ["created_at", "events", "id", "key_id", "mode", "url"]);
  assert.equal(saved.id, "we_1");
  assert.equal(saved.url, "https://x.test/api/stripe/webhook");
  assert.deepEqual(saved.events, WEBHOOK_EVENTS);
  assert.equal(saved.mode, "test");
  assert.equal(saved.key_id, await keyId(KEY));
  assert.match(saved.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.doesNotMatch(JSON.stringify(saved), /whsec_|rk_test_/, "the settings row holds no secret");

  assert.equal(await openTodo(DB, "setup:stripe"), null);
  const closed = (await DB.prepare("SELECT status FROM todos WHERE dedupe LIKE 'setup:stripe@%'").all()).results;
  assert.deepEqual(closed, [{ status: "done" }]);
  // The webhook is now current for this key.
  const s = await stripeStatus(DB, {});
  assert.equal(s.webhook, true);
  assert.equal(s.webhook_current, true);
});

test("connect: a live key gives live mode; a key with spaces around it is trimmed", async () => {
  const DB = fakeD1();
  const { fetchImpl } = fakeStripe({ "POST webhook_endpoints": HOOK });
  const live = "sk_live_ABCdef1234567890";
  assert.equal((await connectStripe(DB, {}, { key: `  ${live}\n`, origin: "https://x.test" }, { fetchImpl })).mode, "live");
  assert.equal(await getSecret(DB, "stripe_key"), live);
  assert.equal(JSON.parse(await getSetting(DB, "stripe:webhook")).mode, "live");
});

test("reconnect replaces the old endpoint", async () => {
  const DB = fakeD1();
  await connected(DB);
  const { fetchImpl, calls } = fakeStripe({ "DELETE webhook_endpoints/we_0": { id: "we_0", deleted: true }, "POST webhook_endpoints": HOOK });
  await connectStripe(DB, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["DELETE webhook_endpoints/we_0", "POST webhook_endpoints"]);
  assert.equal(JSON.parse(await getSetting(DB, "stripe:webhook")).id, "we_1");
  assert.equal(await getSecret(DB, "stripe_webhook"), "whsec_new");
});

test("reconnect: an old endpoint already deleted in Stripe (404) is fine; a different key's endpoint is left alone", async () => {
  const DB = fakeD1();
  await connected(DB);
  const gone = fakeStripe({ "DELETE webhook_endpoints/we_0": { status: 404, error: "No such webhook endpoint: 'we_0'" }, "POST webhook_endpoints": HOOK });
  await connectStripe(DB, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl: gone.fetchImpl });
  assert.deepEqual(gone.calls.map((c) => c.method), ["DELETE", "POST"]);

  const other = fakeD1();
  await connected(other); // saved for KEY
  const { fetchImpl, calls } = fakeStripe({ "POST webhook_endpoints": HOOK });
  await connectStripe(other, {}, { key: "rk_test_otheraccount99", origin: "https://x.test" }, { fetchImpl });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST webhook_endpoints"]);
});

test("reconnect: the old payment-link setup's webhook (same key) is deleted too", async () => {
  const DB = fakeD1();
  await setSetting(DB, "stripe", JSON.stringify({ mode: "test", key: await keyId(KEY), links: {}, webhook: { id: "we_old", secret: "whsec_old", url: "u" } }));
  const { fetchImpl, calls } = fakeStripe({ "DELETE webhook_endpoints/we_old": { id: "we_old", deleted: true }, "POST webhook_endpoints": HOOK });
  await connectStripe(DB, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["DELETE webhook_endpoints/we_old", "POST webhook_endpoints"]);
});

test("connect with no key typed uses the saved one (Setup's, else Cloudflare's) and doesn't save Cloudflare's", async () => {
  const DB = fakeD1();
  await connected(DB);
  const saved = fakeStripe({ "DELETE webhook_endpoints/we_0": { deleted: true }, "POST webhook_endpoints": HOOK });
  await connectStripe(DB, {}, { origin: "https://x.test" }, { fetchImpl: saved.fetchImpl });
  assert.equal(saved.calls.at(-1).headers.authorization, `Bearer ${KEY}`);

  const cf = fakeD1();
  const { fetchImpl, calls } = fakeStripe({ "POST webhook_endpoints": HOOK });
  await connectStripe(cf, { STRIPE_SECRET_KEY: "sk_test_fromcloudflare1" }, { key: "", origin: "https://x.test" }, { fetchImpl });
  assert.equal(calls[0].headers.authorization, "Bearer sk_test_fromcloudflare1");
  assert.equal(await getSecret(cf, "stripe_key"), null, "only a key typed on Setup is saved");
  assert.equal(await getSecret(cf, "stripe_webhook"), "whsec_new");
  const s = await stripeStatus(cf, { STRIPE_SECRET_KEY: "sk_test_fromcloudflare1" });
  assert.equal(s.key_source, "cloudflare");
  assert.equal(s.webhook_current, true);

  const none = fakeStripe({});
  await assert.rejects(connectStripe(fakeD1(), {}, { origin: "https://x.test" }, { fetchImpl: none.fetchImpl }), /Paste your Stripe secret key/);
  assert.equal(none.calls.length, 0);
});

test("key errors", async () => {
  const DB = fakeD1();
  const { fetchImpl, calls } = fakeStripe({ "POST webhook_endpoints": HOOK });
  await rejects(connectStripe(DB, {}, { key: "pk_test_abc123456789", origin: "https://x.test" }, { fetchImpl }), PUBLISHABLE);
  await rejects(connectStripe(DB, {}, { key: "pk_live_abc123456789", origin: "https://x.test" }, { fetchImpl }), PUBLISHABLE);
  await rejects(connectStripe(DB, {}, { key: "hello", origin: "https://x.test" }, { fetchImpl }), NOT_A_KEY);
  await rejects(connectStripe(DB, {}, { key: "sk_test_short", origin: "https://x.test" }, { fetchImpl }), NOT_A_KEY);
  await rejects(connectStripe(DB, {}, { key: "whsec_abc123456789", origin: "https://x.test" }, { fetchImpl }), NOT_A_KEY);
  assert.equal(calls.length, 0, "a key that's the wrong shape never reaches Stripe");

  const denied = fakeStripe({ "POST webhook_endpoints": { status: 401, error: "Invalid API Key provided: rk_test_***6789" } });
  await rejects(connectStripe(DB, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl: denied.fetchImpl }), BAD_KEY);
  const narrow = fakeStripe({ "POST webhook_endpoints": { status: 403, error: "The provided key does not have the required permissions" } });
  await rejects(connectStripe(DB, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl: narrow.fetchImpl }), NO_WEBHOOKS);
  const down = fakeStripe({ "POST webhook_endpoints": () => { throw new Error("connect ECONNREFUSED"); } });
  await rejects(connectStripe(DB, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl: down.fetchImpl }), UNREACHABLE);

  // Nothing saved by any of them.
  assert.equal(await getSecret(DB, "stripe_key"), null);
  assert.equal(await getSecret(DB, "stripe_webhook"), null);
  assert.equal(await getSetting(DB, "stripe:webhook"), null);
});

test("key errors: a 401 on the old endpoint's DELETE stops before anything is made or saved", async () => {
  const DB = fakeD1();
  await connected(DB);
  const { fetchImpl, calls } = fakeStripe({ "DELETE webhook_endpoints/we_0": { status: 401, error: "Expired API Key provided" }, "POST webhook_endpoints": HOOK });
  await rejects(connectStripe(DB, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl }), BAD_KEY);
  assert.deepEqual(calls.map((c) => c.method), ["DELETE"]);
  assert.equal(JSON.parse(await getSetting(DB, "stripe:webhook")).id, "we_0");
});

test("reconnect: when the old endpoint was deleted and making the new one fails, the card stops saying connected", async () => {
  const DB = fakeD1();
  await connected(DB);
  const { fetchImpl, calls } = fakeStripe({
    "DELETE webhook_endpoints/we_0": { id: "we_0", deleted: true },
    "POST webhook_endpoints": () => { throw new Error("socket hang up"); },
  });
  await rejects(connectStripe(DB, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl }), UNREACHABLE);
  assert.deepEqual(calls.map((c) => c.method), ["DELETE", "POST"]);
  assert.equal(await getSetting(DB, "stripe:webhook"), null, "the setting naming the deleted endpoint is gone");
  const s = await stripeStatus(DB, {});
  assert.equal(s.webhook, false);
  assert.equal(s.webhook_current, false);
  assert.equal((await paymentsLight(DB, {}, NOW)).level, "amber");
  assert.equal(await getSecret(DB, "stripe_key"), KEY, "the key stays");

  // A failure before anything was deleted leaves the saved webhook as it was.
  const other = fakeD1();
  await connected(other);
  const narrow = fakeStripe({ "DELETE webhook_endpoints/we_0": { status: 403, error: "no permission" } });
  await rejects(connectStripe(other, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl: narrow.fetchImpl }), NO_WEBHOOKS);
  assert.equal(JSON.parse(await getSetting(other, "stripe:webhook")).id, "we_0");
});

test("connect from a deployment's preview link is refused before Stripe is called", async () => {
  const DB = fakeD1();
  const { fetchImpl, calls } = fakeStripe({ "POST webhook_endpoints": HOOK });
  await assert.rejects(connectStripe(DB, {}, { key: KEY, origin: "https://3f2a9c1b.control-room.pages.dev" }, { fetchImpl }),
    /preview link of one deployment/);
  await assert.rejects(connectStripe(DB, {}, { key: KEY, origin: "not a url" }, { fetchImpl }), /web address/);
  assert.equal(calls.length, 0);
  assert.equal(await getSecret(DB, "stripe_key"), null);
  // The project's own address and a branch alias are fine.
  await connectStripe(DB, {}, { key: KEY, origin: "https://control-room.pages.dev" }, { fetchImpl });
  assert.equal(calls.at(-1).params.url, "https://control-room.pages.dev/api/stripe/webhook");
});

test("connect clears a red Payments light: pressing Connect Stripe is its fix", async () => {
  const DB = fakeD1();
  await connected(DB);
  await DB.prepare("INSERT INTO heartbeats (name, last_at, ok, detail) VALUES ('stripe', ?, 0, ?)")
    .bind(new Date(Date.now() - 3600_000).toISOString(), "Checkout refused: Stripe didn't accept that key.").run();
  assert.equal((await paymentsLight(DB, {}, new Date())).level, "red");
  const { fetchImpl } = fakeStripe({ "DELETE webhook_endpoints/we_0": { deleted: true }, "POST webhook_endpoints": HOOK });
  await connectStripe(DB, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl });
  assert.equal((await paymentsLight(DB, {}, new Date())).level, "green");
  assert.equal((await stripeStatus(DB, {})).last_error, null);
  const beat = await DB.prepare("SELECT ok, detail FROM heartbeats WHERE name = 'stripe'").first();
  assert.equal(Number(beat.ok), 1);
  assert.doesNotMatch(beat.detail, /rk_|whsec_/);
});

// ---------------------------------------------------------------- stripeStatus

test("status never leaks", async () => {
  const DB = fakeD1();
  const { fetchImpl } = fakeStripe({ "POST webhook_endpoints": HOOK });
  await connectStripe(DB, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl });
  const s = await stripeStatus(DB, {});
  const text = JSON.stringify(s);
  assert.ok(!text.includes("rk_test_abc"), text);
  assert.ok(!text.includes("whsec_new"), text);
  assert.deepEqual(Object.keys(s).sort(), ["key", "key_source", "last_error", "last_event", "mode", "webhook", "webhook_current"]);
  assert.deepEqual(s, { key: true, key_source: "setup", mode: "test", webhook: true, webhook_current: true, last_event: null, last_error: null });

  // Cloudflare's key is never shown either.
  const cf = JSON.stringify(await stripeStatus(fakeD1(), { STRIPE_SECRET_KEY: "sk_live_secretvalue123" }));
  assert.ok(!cf.includes("sk_live_secretvalue123"), cf);

  // The saved events differ from WEBHOOK_EVENTS (the old payment-link setup had 4) → not current.
  const old = fakeD1();
  await connected(old, { events: WEBHOOK_EVENTS.slice(0, 4) });
  const o = await stripeStatus(old, {});
  assert.equal(o.webhook, true);
  assert.equal(o.webhook_current, false);
});

test("status: nothing connected", async () => {
  assert.deepEqual(await stripeStatus(fakeD1(), {}), {
    key: false, key_source: null, mode: null, webhook: false, webhook_current: false, last_event: null, last_error: null,
  });
});

test("last event", async () => {
  const DB = fakeD1();
  await connected(DB);
  await DB.prepare("INSERT INTO stripe_events (id, type, result, at) VALUES (?, ?, ?, ?)").bind("evt_1", "checkout.session.completed", "client made", "2026-10-28T09:00:00Z").run();
  await DB.prepare("INSERT INTO stripe_events (id, type, result, at) VALUES (?, ?, ?, ?)").bind("evt_2", "invoice.paid", "recorded £1,950 from Ace", "2026-10-28T10:00:00Z").run();
  const s = await stripeStatus(DB, {});
  assert.equal(s.last_event.type, "invoice.paid");
  assert.deepEqual(s.last_event, { type: "invoice.paid", at: "2026-10-28T10:00:00Z", result: "recorded £1,950 from Ace" });
  assert.equal(s.last_error, null);

  // A failed beat is the last error (its detail has already had secrets taken out by the webhook handler).
  await DB.prepare("INSERT INTO heartbeats (name, last_at, ok, detail) VALUES ('stripe', ?, 0, ?)").bind("2026-10-28T11:00:00Z", "Stripe message invoice.paid failed: boom").run();
  assert.equal((await stripeStatus(DB, {})).last_error, "Stripe message invoice.paid failed: boom");
  await DB.prepare("UPDATE heartbeats SET ok = 1, detail = 'invoice.paid' WHERE name = 'stripe'").run();
  assert.equal((await stripeStatus(DB, {})).last_error, null);
});

test("status is one D1 statement", async () => {
  const DB = fakeD1();
  await connected(DB);
  const counted = countingDB(DB);
  await stripeStatus(counted.DB, {});
  assert.equal(counted.used(), 1);
});

// ---------------------------------------------------------------- the route

test("GET /api/stripe/setup → stripeStatus; POST with a bad key → 400 + the plain-English error", async () => {
  const DB = fakeD1();
  await connected(DB);
  const got = await onRequestGet({ request: new Request("https://x.test/api/stripe/setup"), env: { DB } });
  assert.equal(got.status, 200);
  const body = await got.json();
  assert.equal(body.key, true);
  assert.equal(body.webhook_current, true);
  assert.ok(!JSON.stringify(body).includes(KEY));
  assert.ok(!JSON.stringify(body).includes("whsec_saved"));

  const post = (data) => onRequestPost({
    request: new Request("https://x.test/api/stripe/setup", { method: "POST", headers: { "content-type": "application/json" }, body: data }),
    env: { DB },
  });
  const pk = await post(JSON.stringify({ key: "pk_test_abc123456789" }));
  assert.equal(pk.status, 400);
  assert.deepEqual(await pk.json(), { error: PUBLISHABLE });
  const hello = await post(JSON.stringify({ key: "hello" }));
  assert.equal(hello.status, 400);
  assert.deepEqual(await hello.json(), { error: NOT_A_KEY });
  const junk = await post("not json");
  assert.equal(junk.status, 400);
  assert.equal(await getSecret(DB, "stripe_key"), KEY, "nothing changed");
});

test("GET/POST /api/stripe/setup without a database → 500 with db()'s plain-English fix", async () => {
  for (const res of [
    await onRequestGet({ request: new Request("https://x.test/api/stripe/setup"), env: {} }),
    await onRequestPost({ request: new Request("https://x.test/api/stripe/setup", { method: "POST", body: "{}" }), env: {} }),
  ]) {
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /database isn't connected/);
  }
});

test("Home's Stripe step is done once Connect Stripe ran with a live key", async () => {
  const { onRequestGet: today } = await import("../functions/api/today.js");
  const DB = fakeD1();
  const stripeStep = async () => (await (await today({ env: { DB } })).json()).setup.find((s) => s.key === "stripe");
  const { fetchImpl } = fakeStripe({ "POST webhook_endpoints": HOOK });
  await connectStripe(DB, {}, { key: KEY, origin: "https://x.test" }, { fetchImpl });
  const test = await stripeStep();
  assert.equal(test.done, false, "test mode isn't live yet");
  assert.match(test.how, /Connect Stripe/);
  await connectStripe(DB, {}, { key: "rk_live_abc123456789", origin: "https://x.test" }, { fetchImpl });
  assert.equal((await stripeStep()).done, true);
});

// ---------------------------------------------------------------- the Payments light

test("light is registered", async () => {
  await import("../functions/_lib/tick.js");
  const DB = fakeD1();
  await connected(DB);
  const green = (await healthFromDb(DB, {}, NOW)).lights.filter((l) => l.name === "payments");
  assert.equal(green.length, 1, "registered once");
  assert.deepEqual(green[0], { name: "payments", level: "green", detail: "Working", fix: "" });

  const empty = fakeD1();
  const grey = (await healthFromDb(empty, {}, NOW)).lights.find((l) => l.name === "payments");
  assert.equal(grey.level, "grey");
  assert.equal(grey.detail, "Not connected");
  await healthStep.run({ DB: empty, env: {}, now: NOW, reason: "health", results: {}, budget: { left: () => 50 } });
  assert.equal(await openTodo(empty, "health:payments"), null);
  assert.equal(await todo(empty, "health:payments"), null);
});

test("tick.js imports stripe.js itself, and GET /api/health shows the light in an isolate that loaded nothing else", () => {
  const tick = readFileSync(new URL("../functions/_lib/tick.js", import.meta.url), "utf8");
  assert.match(tick, /^import "\.\/stripe\.js";/m);
  const url = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  const code = `
    import { onRequestGet } from ${url("../functions/api/health.js")};
    import { fakeD1 } from ${url("./helpers/fakeD1.mjs")};
    const body = await (await onRequestGet({ env: { DB: fakeD1() } })).json();
    console.log(JSON.stringify(body.lights.filter((l) => l.name === "payments")));`;
  const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { encoding: "utf8" });
  const lights = JSON.parse(out.trim().split("\n").pop());
  assert.deepEqual(lights, [{ name: "payments", level: "grey", detail: "Not connected", fix: "Paste your Stripe key on Setup and press Connect Stripe" }]);
});

test("light: Cloudflare's key counts as a key; amber without a current webhook; red on a failed beat under 24 h", async () => {
  const cf = fakeD1();
  const amber = (await healthFromDb(cf, { STRIPE_SECRET_KEY: KEY }, NOW)).lights.find((l) => l.name === "payments");
  assert.deepEqual(amber, { name: "payments", level: "amber", detail: "Stripe can't send us payment messages yet", fix: "Press Connect Stripe on Setup" });

  const DB = fakeD1();
  await connected(DB);
  await DB.prepare("INSERT INTO heartbeats (name, last_at, ok, detail) VALUES ('stripe', ?, 0, ?)").bind("2026-10-28T02:00:00Z", "Stripe message invoice.paid failed: boom").run();
  const red = await paymentsLight(DB, {}, NOW);
  assert.equal(red.level, "red");
  assert.equal(red.detail, "Stripe message invoice.paid failed: boom");
  assert.equal(red.fix, "Open Setup → Payments (Stripe). If it says connected, press Connect Stripe again");
  assert.equal((await paymentsLight(DB, {}, new Date("2026-10-29T03:00:00Z"))).level, "green", "older than 24 h");
});

test("light makes 1 query", async () => {
  await import("../functions/_lib/tick.js");
  const DB = fakeD1();
  await connected(DB);
  const alone = countingDB(DB);
  await paymentsLight(alone.DB, {}, NOW);
  assert.equal(alone.used(), 1);
  // It never reads stripe_events (that table only grows; the health check runs every 5 minutes).
  const sqls = [];
  await paymentsLight({ prepare: (sql) => { sqls.push(sql); return DB.prepare(sql); } }, {}, NOW);
  assert.equal(sqls.length, 1);
  assert.doesNotMatch(sqls[0], /stripe_events/);

  // healthFromDb with the light registered once more costs exactly 1 more statement than without that copy.
  const before = countingDB(DB);
  await healthFromDb(before.DB, {}, NOW);
  const off = registerLight(paymentsLight);
  try {
    const after = countingDB(DB);
    const { lights } = await healthFromDb(after.DB, {}, NOW);
    assert.equal(lights.filter((l) => l.name === "payments").length, 2);
    assert.equal(after.used() - before.used(), 1);
  } finally {
    off();
  }
});

// ---------------------------------------------------------------- the Setup card (public/js/setup.js, no browser)

async function setupPage() {
  const stub = () => ({
    innerHTML: "", textContent: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], append() {}, prepend() {}, before() {}, remove() {},
  });
  globalThis.document ??= { getElementById: stub, createElement: stub, querySelector: () => null, querySelectorAll: () => [], body: stub() };
  globalThis.window ??= globalThis;
  globalThis.addEventListener ??= () => {};
  return import("../public/js/setup.js");
}
const textOf = (html) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

test("Setup card: rows, field, button, help and checklist (Part A's exact text)", async () => {
  const { stripeHtml } = await setupPage();
  const ok = stripeHtml({ key: true, key_source: "setup", mode: "test", webhook: true, webhook_current: true,
    last_event: { type: "invoice.paid", at: "2026-10-28T10:00:00Z", result: "recorded £249" }, last_error: null }, NOW);
  const t = textOf(ok);
  assert.ok(t.includes("Payments (Stripe)"));
  assert.ok(t.includes("Secret key: saved ✓ · Test mode (no real money)"), t);
  assert.ok(t.includes("Stripe messages (webhook): connected ✓"), t);
  assert.ok(t.includes("Last message from Stripe: 2 hours ago (invoice.paid)"), t);
  assert.ok(t.includes("Stripe secret key"));
  assert.match(ok, /<input id="stripe-key" name="key" type="password"[^>]*placeholder="sk_test_… or rk_test_…"/);
  assert.doesNotMatch(ok, /<input[^>]*\bvalue=/, "write-only: the field never has a value");
  assert.match(ok, /<button class="btn" type="submit">Connect Stripe<\/button>/);
  for (const line of [
    "Test mode first: pay with card 4242 4242 4242 4242, any future date, any 3 digits. When Stripe approves your account, paste the live key and press Connect Stripe again.",
    "To refund: Stripe → Payments → the payment → Refund. It shows on the Money page by itself.",
    "To stop someone's monthly: Money → their row → Stopped paying. This cancels it in Stripe too.",
    "Settings → Public details: business name Aetos Websites, statement descriptor AETOS WEBSITES, support email, your name and service address (trading-name rule).",
    "Settings → Customer emails: Successful payments and Refunds on. Billing → Invoices: email finalised invoices to customers on.",
    "Billing → Revenue recovery → Retries: Smart Retries on; if all retries fail: cancel the subscription.",
    "Payment links (old system) → archive all three.",
  ]) assert.ok(t.includes(line), `missing: ${line}`);

  const live = textOf(stripeHtml({ key: true, key_source: "setup", mode: "live", webhook: true, webhook_current: false, last_event: null, last_error: null }, NOW));
  assert.ok(live.includes("Secret key: saved ✓ · Live (real payments)"), live);
  assert.ok(live.includes("Stripe messages (webhook): needs updating: press Connect Stripe again"), live);
  assert.ok(live.includes("Last message from Stripe: none yet"), live);

  const none = textOf(stripeHtml({ key: false, key_source: null, mode: null, webhook: false, webhook_current: false, last_event: null, last_error: null }, NOW));
  assert.ok(none.includes("Secret key: not added"), none);
  assert.ok(none.includes("Stripe messages (webhook): not connected: press Connect Stripe"), none);

  assert.ok(textOf(stripeHtml({ error: "Request failed (500)" }, NOW)).includes("Couldn't check Stripe: Request failed (500)"));
});

test("Setup card: Stripe's and Claude's text can't inject markup", async () => {
  const { stripeHtml } = await setupPage();
  const XSS = `"><img src=x onerror=alert(1)><script>alert(1)</script>`;
  const html = stripeHtml({ key: true, key_source: "cloudflare", mode: `test${XSS}`, webhook: true, webhook_current: true,
    last_event: { type: `invoice.paid${XSS}`, at: "2026-10-28T10:00:00Z", result: `recorded from ${XSS}` }, last_error: `failed: ${XSS}` },
  NOW, { stripe: { ok: false, text: XSS } });
  assert.doesNotMatch(html, /<img|<script/i);
});
