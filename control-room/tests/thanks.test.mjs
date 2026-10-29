// The thanks page after Stripe Checkout (docs/rebuild/08-order-pay.md Task 10): thanksPage fetches the session from
// Stripe, checks it is paid and belongs to this demo's lead, fulfils it (so the page works before the webhook) and
// shows the onboarding form link. Plus the GET /d/:slug/thanks route.
// Run: node --test control-room/tests/thanks.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { thanksPage } from "../functions/_lib/checkout.js";
import { countingDB } from "../functions/_lib/d1count.js";
import { setSecret } from "../functions/_lib/settings.js";
import { handleWebhook } from "../functions/_lib/stripe-events.js";
import { onRequestGet as thanksRoute } from "../functions/d/[slug]/thanks.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { fakeStripe } from "./helpers/fakeStripe.mjs";

const NOW = new Date("2026-10-19T10:01:00Z"); // Mon 11:01 UK (BST)
const SECONDS = Math.floor(NOW.getTime() / 1000);
const CREATED = Date.parse("2026-10-19T10:00:00Z") / 1000;
const SECRET = "whsec_x";
const SLUG = "smith-roofing";
const ORIGIN = "https://x.test";

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

const one = async (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const count = async (DB, sql, ...args) => (await one(DB, sql, ...args)).n;

// The paid session from Task 7 (stripe-fulfil.test.mjs), as GET checkout/sessions/cs_1 returns it.
function session(extra = {}) {
  return {
    id: "cs_1", object: "checkout.session", mode: "subscription", payment_status: "paid", customer: "cus_1",
    subscription: "sub_1", amount_total: 195000, created: CREATED, client_reference_id: "p1",
    customer_details: { email: "mark@smithroofing.co.uk", phone: "+447700900000" },
    metadata: { place_id: "p1", package: "full", weekend: "0", slug: SLUG, origin: ORIGIN },
    ...extra,
  };
}

async function seed({ demo = {} } = {}) {
  const DB = fakeD1();
  await insert(DB, "leads", {
    place_id: "p1", name: "Smith Roofing", trade: "roofer", search_town: "Leeds",
    first_seen_at: "2026-09-01T09:00:00Z", updated_at: "2026-09-01T09:00:00Z",
  });
  await insert(DB, "demos", {
    slug: SLUG, place_id: "p1", created_at: "2026-10-01T09:00:00Z", expires_at: "2027-04-01T09:00:00Z", ...demo,
  });
  await insert(DB, "prospects", {
    place_id: "p1", stage: "viewed", stage_at: "2026-10-10T09:00:00Z", email: "mark@smithroofing.co.uk",
    greet_name: "Mark", created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-10T09:00:00Z",
  });
  await insert(DB, "mailboxes", {
    id: "mb_sys", address: "hello@aetoswebsites.com", display_name: "Nik", role: "system", started_on: "2026-01-01",
    status: "active", created_at: "2026-01-01T09:00:00Z",
  });
  await setSecret(DB, "stripe_key", "sk_test_x");
  await setSecret(DB, "stripe_webhook", SECRET);
  return DB;
}

const stripeWith = (answer) => fakeStripe({ "GET checkout/sessions/cs_1": answer });

function thanks(DB, stripe, args = {}) {
  return thanksPage(DB, {}, { slug: SLUG, sessionId: "cs_1", origin: ORIGIN, now: NOW, fetchImpl: stripe.fetchImpl, ...args });
}

// The test's own Stripe-Signature header: t=<seconds>,v1=<HMAC-SHA256 of "t.body">.
async function sign(body, secret = SECRET, t = SECONDS) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`));
  return `t=${t},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

test("fulfils before the webhook", async () => {
  const DB = await seed();
  const stripe = stripeWith(session());
  const out = await thanks(DB, stripe);
  assert.equal(out.status, 200);
  assert.ok(out.html.includes("Thank you, you're all set"), out.html);
  const { token } = await one(DB, "SELECT token FROM onboarding");
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(out.html.includes(`https://x.test/onboard/${token}`), out.html);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 1);

  // the exact lines for a weekday Full Package
  assert.ok(out.html.includes("Your payment of £1,950 has gone through."));
  assert.ok(out.html.includes("Fill in your onboarding form →"));
  assert.ok(out.html.includes("Your 7 days start when the form is complete. Your website will be live within 7 days of that. GUARANTEED."));
  assert.ok(out.html.includes("Your first 60 days of the monthly plan are free. The first £249 is taken on Friday 18 December 2026. Cancel any time before then by replying to our email."));
  assert.ok(out.html.includes("We're also emailing you this link. Questions? Reply to any of our emails."));

  // one GET of that session, Stripe-Version pinned
  assert.equal(stripe.calls.length, 1);
  assert.equal(stripe.calls[0].method, "GET");
  // with its subscription expanded: the first charge date is Stripe's own trial_end
  assert.equal(stripe.calls[0].path, "checkout/sessions/cs_1?expand[]=subscription");
  assert.equal(stripe.calls[0].headers["stripe-version"], "2024-06-20");
  // the key never reaches the page
  assert.doesNotMatch(out.html, /sk_test_x|whsec_x/);
});

test("then the webhook is a no-op", async () => {
  const DB = await seed();
  await thanks(DB, stripeWith(session()));
  const before = await one(DB, "SELECT token FROM onboarding");
  const body = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", created: SECONDS, data: { object: session() } });
  const res = await handleWebhook(DB, {}, { body, signature: await sign(body), now: NOW, fetchImpl: fakeStripe({}).fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(res.json.result, "already recorded");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM onboarding"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM payments"), 1);
  assert.equal((await one(DB, "SELECT token FROM onboarding")).token, before.token);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM stripe_events WHERE id = 'evt_1'"), 1);

  // and the thanks page again (a refresh) shows the same link and makes nothing new
  const again = await thanks(DB, stripeWith(session()));
  assert.equal(again.status, 200);
  assert.ok(again.html.includes(`https://x.test/onboard/${before.token}`));
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 1);
});

test("other slug", async () => {
  const DB = await seed();
  const out = await thanks(DB, stripeWith(session({ client_reference_id: "p9", metadata: { ...session().metadata, place_id: "p9" } })));
  assert.equal(out.status, 404);
  assert.ok(out.html.includes("We couldn't find that payment"), out.html);
  assert.ok(out.html.includes("If you've just paid, your onboarding form will arrive by email in the next few minutes. If you haven't paid yet, you can "), out.html);
  assert.ok(out.html.includes(`href="/d/${SLUG}/order"`), out.html);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 0);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM onboarding"), 0);
});

test("other slug: a session naming this lead in metadata but another in client_reference_id is refused", async () => {
  const DB = await seed();
  const out = await thanks(DB, stripeWith(session({ client_reference_id: "p9" })));
  assert.equal(out.status, 404);
  assert.ok(out.html.includes("We couldn't find that payment"));
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 0);
});

test("unpaid", async () => {
  const DB = await seed();
  const out = await thanks(DB, stripeWith(session({ payment_status: "unpaid" })));
  assert.equal(out.status, 404);
  assert.ok(out.html.includes("We couldn't find that payment"));
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 0);
});

test("bad id", async () => {
  const DB = await seed();
  for (const sessionId of ["x<y", "", null, undefined, "cs_", "cs_1/../x", "pi_123", `cs_${"a".repeat(300)}`]) {
    const stripe = stripeWith(session());
    const out = await thanks(DB, stripe, { sessionId });
    assert.equal(out.status, 404, String(sessionId));
    assert.ok(out.html.includes("We couldn't find that payment"));
    assert.equal(stripe.calls.length, 0, `no Stripe call for ${sessionId}`);
  }
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 0);
});

test("unknown slug: 404, no Stripe call", async () => {
  const DB = await seed();
  for (const slug of ["no-such-demo", "<script>"]) {
    const stripe = stripeWith(session());
    const out = await thanks(DB, stripe, { slug });
    assert.equal(out.status, 404);
    assert.equal(stripe.calls.length, 0);
    assert.doesNotMatch(out.html, /<script>/);
    assert.doesNotMatch(out.html, /Smith Roofing/);
  }
});

test("Stripe down", async () => {
  const DB = await seed();
  const out = await thanks(DB, stripeWith({ status: 500, error: "Something went wrong" }));
  assert.equal(out.status, 200);
  assert.ok(out.html.includes("Thank you"));
  assert.ok(out.html.includes("Your payment is being confirmed."), out.html);
  assert.ok(out.html.includes("Your onboarding form will arrive by email in the next few minutes."));
  assert.doesNotMatch(out.html, /you're all set/);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 0);

  // unreachable (the fetch itself fails) and no key saved: the same pending page
  const offline = await thanks(DB, stripeWith(() => { throw new Error("network down"); }));
  assert.equal(offline.status, 200);
  assert.ok(offline.html.includes("Your payment is being confirmed."));
  const noKey = fakeD1();
  await insert(noKey, "leads", { place_id: "p1", name: "Smith Roofing", trade: "roofer", search_town: "Leeds", first_seen_at: "2026-09-01T09:00:00Z", updated_at: "2026-09-01T09:00:00Z" });
  await insert(noKey, "demos", { slug: SLUG, place_id: "p1", created_at: "2026-10-01T09:00:00Z", expires_at: "2027-04-01T09:00:00Z" });
  const pending = await thanks(noKey, stripeWith(session()));
  assert.equal(pending.status, 200);
  assert.ok(pending.html.includes("Your payment is being confirmed."));
});

test("a session Stripe doesn't know: 404", async () => {
  const DB = await seed();
  const out = await thanks(DB, stripeWith({ status: 404, error: { type: "invalid_request_error", code: "resource_missing", message: "No such checkout.session: 'cs_1'" } }));
  assert.equal(out.status, 404);
  assert.ok(out.html.includes("We couldn't find that payment"));
  assert.doesNotMatch(out.html, /No such checkout/);
});

test("expired demo still thanks", async () => {
  const DB = await seed({ demo: { expires_at: "2026-10-01T00:00:00Z" } });
  const out = await thanks(DB, stripeWith(session()));
  assert.equal(out.status, 200);
  const { token } = await one(DB, "SELECT token FROM onboarding");
  assert.ok(out.html.includes(`https://x.test/onboard/${token}`), out.html);
  assert.ok(out.html.includes("Thank you, you're all set"));
});

test("website only: no monthly line", async () => {
  const DB = await seed();
  const out = await thanks(DB, stripeWith(session({
    mode: "payment", subscription: null, amount_total: 175000, metadata: { ...session().metadata, package: "website" },
  })));
  assert.equal(out.status, 200);
  assert.ok(out.html.includes("Your payment of £1,750 has gone through."));
  assert.doesNotMatch(out.html, /monthly plan/);
});

test("weekend deal: £1,750 paid and 90 free days", async () => {
  const DB = await seed();
  const out = await thanks(DB, stripeWith(session({ amount_total: 175000, metadata: { ...session().metadata, weekend: "1" } })));
  assert.equal(out.status, 200);
  assert.ok(out.html.includes("Your payment of £1,750 has gone through."), out.html);
  // paid Mon 19 Oct 2026 (UK) + 90 days = Sun 17 Jan 2027
  assert.ok(out.html.includes("Your first 90 days of the monthly plan are free. The first £249 is taken on Sunday 17 January 2027."), out.html);
  assert.equal((await one(DB, "SELECT package FROM clients")).package, "weekend");
});

test("D1 budget: a first visit and a refresh each stay well under 50 statements", async () => {
  const DB = await seed();
  for (const visit of ["first", "refresh"]) {
    const c = countingDB(DB);
    const out = await thanks(c.DB, stripeWith(session()));
    assert.equal(out.status, 200);
    assert.ok(c.used() <= 35, `${visit}: used ${c.used()}`);
  }
});

test("a business name with <script> is escaped", async () => {
  const DB = await seed();
  await DB.prepare("UPDATE leads SET name = ? WHERE place_id = 'p1'").bind("<script>alert(1)</script> Roofing").run();
  const out = await thanks(DB, stripeWith(session()));
  assert.equal(out.status, 200);
  assert.doesNotMatch(out.html, /<script>alert/);
});

test("GET /d/:slug/thanks?session_id=…: the page, no-store, origin from the request", async (t) => {
  const stripe = stripeWith(session());
  const realFetch = globalThis.fetch;
  globalThis.fetch = stripe.fetchImpl;
  t.after(() => { globalThis.fetch = realFetch; });
  const DB = await seed();
  const get = (query) => thanksRoute({
    env: { DB }, params: { slug: SLUG }, request: new Request(`https://aetoswebsites.com/d/${SLUG}/thanks${query}`),
  });
  const res = await get("?session_id=cs_1");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  const { token } = await one(DB, "SELECT token FROM onboarding");
  assert.ok((await res.text()).includes(`https://aetoswebsites.com/onboard/${token}`), "origin is the host they used");
  const missing = await get("");
  assert.equal(missing.status, 404);
  assert.equal(stripe.calls.length, 1);
});

test("other slug: a session naming this lead in client_reference_id but another in metadata is refused", async () => {
  // fulfilCheckout reads metadata.place_id first, so this would make a client for p9 if the page let it through
  const DB = await seed();
  const out = await thanks(DB, stripeWith(session({ metadata: { ...session().metadata, place_id: "p9" } })));
  assert.equal(out.status, 404);
  assert.ok(out.html.includes("We couldn't find that payment"));
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 0);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM onboarding"), 0);
});

test("GET /d/:slug/thanks: the database failing still gives someone who paid the 'being confirmed' page", async (t) => {
  const stripe = stripeWith(session());
  const realFetch = globalThis.fetch;
  globalThis.fetch = stripe.fetchImpl;
  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  t.after(() => { globalThis.fetch = realFetch; console.error = realError; });
  const broken = { prepare() { throw new Error("D1_ERROR: network connection lost"); }, batch() { throw new Error("D1_ERROR: network connection lost"); } };
  const get = (env, query) => thanksRoute({
    env, params: { slug: SLUG }, request: new Request(`https://aetoswebsites.com/d/${SLUG}/thanks${query}`),
  });
  for (const env of [{}, { DB: broken }]) {
    const res = await get(env, "?session_id=cs_1");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    assert.ok(html.includes("Your payment is being confirmed."), html);
    assert.doesNotMatch(html, /D1_ERROR|Bindings/);
    // a made-up id gets no promise of a payment
    const bogus = await get(env, "?session_id=x%3Cy");
    assert.equal(bogus.status, 404);
    assert.doesNotMatch(await bogus.text(), /being confirmed/);
  }
  assert.equal(stripe.calls.length, 0);
  assert.ok(logged.length >= 1);
});

// Review fix: the date shown is the day Stripe really charges: its trial_end (the trial starts when they pay, not when
// the payment page was opened), not session.created + the free days.
test("the first charge date is Stripe's trial_end, from the expanded subscription; paid_on is when they paid", async () => {
  const DB = await seed();
  const trialEnd = Date.parse("2027-01-31T00:20:00Z") / 1000; // paid Mon 2 Nov 2026 00:20 + 90 days
  const stripe = stripeWith(session({
    created: Date.parse("2026-11-01T23:50:00Z") / 1000, amount_total: 175000,
    metadata: { ...session().metadata, weekend: "1" },
    subscription: { id: "sub_1", object: "subscription", trial_end: trialEnd, start_date: Date.parse("2026-11-02T00:20:00Z") / 1000 },
  }));
  const out = await thanks(DB, stripe, { now: new Date("2026-11-02T00:21:00Z") });
  assert.equal(out.status, 200);
  assert.ok(out.html.includes("The first £249 is taken on Sunday 31 January 2027."), out.html);
  assert.equal((await one(DB, "SELECT paid_on FROM clients")).paid_on, "2026-11-02");
  assert.equal((await one(DB, "SELECT stripe_subscription FROM client_links")).stripe_subscription, "sub_1");
});
