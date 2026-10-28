// The order page and the checkout route (docs/rebuild/08-order-pay.md Task 5): loadOrder, orderPage, startCheckout
// with its 5-an-hour limit and plain-English notices, and the two Pages routes that wire requests to them.
// Run: node --test control-room/tests/checkout-route.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { CHECKOUT_LIMIT, loadOrder, orderPage, startCheckout } from "../functions/_lib/checkout.js";
import { ORDER_NOTICES } from "../functions/_lib/order-page.js";
import { setSecret, setSetting } from "../functions/_lib/settings.js";
import { traderLine } from "../functions/_lib/site.js";
import { encode } from "../functions/_lib/stripe.js";
import { onRequestPost as checkoutRoute } from "../functions/d/[slug]/checkout.js";
import { onRequestGet as orderRoute } from "../functions/d/[slug]/order.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { fakeStripe } from "./helpers/fakeStripe.mjs";
import { seedDemo, seedLead, seedMailbox, seedProspect } from "./helpers/shortlistSeed.mjs";

const SLUG = "smith-roofing";
const ORIGIN = "https://x.test";
const MONDAY = new Date("2026-10-19T10:00:00Z");
const SESSION = { id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" };
const MIN = 60_000;

/** Lead p1 "Smith Roofing", its live demo smith-roofing, a prospect writing to Mark, and Stripe connected. */
async function seed({ demo = {}, connected = true } = {}) {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "p1", name: "Smith Roofing", trade: "roofer", town: "Leeds" });
  await seedDemo(DB, { place_id: "p1", slug: SLUG, created_at: "2026-10-01T09:00:00Z", expires_at: "2027-04-01T09:00:00Z", ...demo });
  await seedProspect(DB, { place_id: "p1", stage: "emailed", email: "mark@smithroofing.co.uk", greet_name: "Mark" });
  if (connected) {
    await setSecret(DB, "stripe_key", "sk_test_x");
    await setSecret(DB, "stripe_webhook", "whsec_x");
  }
  return DB;
}

const okStripe = () => fakeStripe({ "POST checkout/sessions": SESSION });

function checkout(DB, stripe, args = {}) {
  return startCheckout(DB, {}, { slug: SLUG, pkg: "full", seen: "weekday", origin: ORIGIN, now: MONDAY, fetchImpl: stripe.fetchImpl, ...args });
}

/** What Stripe received, as the form text with its brackets and spaces readable. */
const sentText = (call) => decodeURIComponent(encode(call.params).toString().replace(/\+/g, " "));
// node:sqlite's rows have a null prototype: copied into plain objects for deepEqual.
const clicks = (DB) => DB.raw.prepare("SELECT slug, place_id, kind, at FROM demo_events WHERE kind = 'order_click' ORDER BY at").all()
  .map((r) => ({ ...r }));
const todo = (DB, dedupe) => {
  const row = DB.raw.prepare("SELECT kind, title, link, place_id, status FROM todos WHERE dedupe = ?").get(dedupe);
  return row ? { ...row } : row;
};
const addClient = (DB, cancelled_on = null) => DB.raw.prepare(
  `INSERT INTO clients (id, name, place_id, package, build_fee_pence, monthly_pence, free_days, paid_on, cancelled_on, created_at)
   VALUES ('c1', 'Smith Roofing', 'p1', 'full', 195000, 24900, 60, '2026-09-01', ?, '2026-09-01T10:00:00Z')`,
).run(cancelled_on);

test("CHECKOUT_LIMIT is 5 per slug per 60 minutes", () => {
  assert.equal(CHECKOUT_LIMIT, 5);
});

test("opens checkout", async () => {
  const DB = await seed();
  const stripe = okStripe();
  const out = await checkout(DB, stripe);
  assert.deepEqual(out, { redirect: "https://checkout.stripe.com/c/cs_1" });
  assert.deepEqual(clicks(DB), [{ slug: SLUG, place_id: "p1", kind: "order_click", at: "2026-10-19T10:00:00Z" }]);
  assert.equal(stripe.calls.length, 1);
  const [call] = stripe.calls;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "checkout/sessions");
  assert.equal(call.headers["stripe-version"], "2024-06-20");
  const sent = sentText(call);
  assert.ok(sent.includes("customer_email=mark@smithroofing.co.uk"), sent);
  assert.ok(sent.includes("unit_amount]=195000"), sent);
  assert.ok(sent.includes("subscription_data[trial_period_days]=60"), sent);
  assert.ok(sent.includes(`success_url=${ORIGIN}/d/${SLUG}/thanks?session_id={CHECKOUT_SESSION_ID}`), sent);
  assert.ok(sent.includes(`cancel_url=${ORIGIN}/d/${SLUG}/order?back=1`), sent);
  assert.ok(sent.includes("metadata[origin]=https://x.test"), sent);
  assert.ok(sent.includes("line_items[1][price_data][product_data][name]=Website build: Smith Roofing"), sent);
  // no todo and no failed heartbeat on success
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM todos").get().n, 0);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM heartbeats WHERE name = 'stripe'").get().n, 0);

  // Website Only: a one-off payment of the Website Only price
  const site = okStripe();
  assert.deepEqual(await checkout(await seed(), site, { pkg: "website" }), { redirect: SESSION.url });
  const s = sentText(site.calls[0]);
  assert.ok(s.includes("mode=payment") && s.includes("unit_amount]=175000"), s);
});

test("weekend grace via seen", async () => {
  const afterMidnight = new Date("2026-10-26T00:10:00Z"); // Monday 00:10 GMT (the clocks went back on the 25th)
  const weekend = okStripe();
  await checkout(await seed(), weekend, { seen: "weekend", now: afterMidnight });
  const w = sentText(weekend.calls[0]);
  assert.ok(w.includes("unit_amount]=175000"), w);
  assert.ok(w.includes("trial_period_days]=90"), w);

  const weekday = okStripe();
  await checkout(await seed(), weekday, { seen: "weekday", now: afterMidnight });
  const d = sentText(weekday.calls[0]);
  assert.ok(d.includes("unit_amount]=195000"), d);
  assert.ok(d.includes("trial_period_days]=60"), d);

  // the grace ends 30 minutes after Sunday midnight
  const late = okStripe();
  await checkout(await seed(), late, { seen: "weekend", now: new Date("2026-10-26T00:31:00Z") });
  assert.ok(sentText(late.calls[0]).includes("unit_amount]=195000"));
});

test("rate limit", async () => {
  const DB = await seed();
  const stripe = okStripe();
  for (let i = 0; i < 5; i++) {
    const out = await checkout(DB, stripe, { now: new Date(MONDAY.getTime() + i * MIN) });
    assert.deepEqual(out, { redirect: SESSION.url }, `checkout ${i + 1}`);
  }
  const sixth = await checkout(DB, stripe, { now: new Date(MONDAY.getTime() + 10 * MIN) });
  assert.equal(sixth.status, 429);
  assert.ok(sixth.html.includes(ORDER_NOTICES.busy), "the busy notice");
  assert.ok(sixth.html.includes('name="package" value="full"'), "busy keeps the buttons");
  assert.equal(stripe.calls.length, 5);
  assert.equal(clicks(DB).length, 5, "the refused one isn't counted");
  // Rolling 60 minutes: once the first click is over an hour old, one more goes through.
  const later = await checkout(DB, stripe, { now: new Date(MONDAY.getTime() + 60 * MIN + 1000) });
  assert.deepEqual(later, { redirect: SESSION.url });
  assert.equal(stripe.calls.length, 6);

  // Failed attempts count too (order_click is recorded before Stripe is called).
  const failDB = await seed();
  const refusing = fakeStripe({ "POST checkout/sessions": { status: 400, error: "Invalid email" } });
  for (let i = 0; i < 5; i++) assert.equal((await checkout(failDB, refusing)).status, 502);
  assert.equal((await checkout(failDB, refusing)).status, 429);
  assert.equal(refusing.calls.length, 5);
});

test("bad package", async () => {
  const DB = await seed();
  const stripe = okStripe();
  for (const pkg of ["enterprise", "", undefined, "weekend", "FULL"]) {
    const out = await checkout(DB, stripe, { pkg });
    assert.equal(out.status, 400, String(pkg));
    assert.ok(out.html.includes(ORDER_NOTICES.failed), "the failed notice");
  }
  assert.equal(stripe.calls.length, 0);
  assert.equal(clicks(DB).length, 0);
});

test("expired demo", async () => {
  const DB = await seed({ demo: { expires_at: "2026-10-01T00:00:00Z" } });
  const stripe = okStripe();
  const out = await checkout(DB, stripe);
  assert.equal(out.status, 410);
  assert.match(out.html, /This preview has ended/);
  assert.equal(stripe.calls.length, 0);
  assert.equal(clicks(DB).length, 0);
  // the order page follows the same rule
  assert.equal((await orderPage(DB, {}, { slug: SLUG, back: false, now: MONDAY })).status, 410);
  // an unknown slug is the 404 page, which never says whose
  const unknown = await checkout(DB, stripe, { slug: "no-such-demo" });
  assert.equal(unknown.status, 404);
  assert.doesNotMatch(unknown.html, /Smith/);
  assert.equal(stripe.calls.length, 0);
});

test("already a client", async () => {
  const DB = await seed();
  addClient(DB);
  const stripe = okStripe();
  const out = await checkout(DB, stripe);
  assert.equal(out.status, 409);
  assert.ok(out.html.includes("is already with us"));
  assert.ok(out.html.includes("Smith Roofing is already with us."));
  assert.doesNotMatch(out.html, /<button/, "no order buttons");
  assert.equal(stripe.calls.length, 0);
  assert.equal(clicks(DB).length, 0);

  const gone = await seed();
  addClient(gone, "2026-10-10");
  const again = okStripe();
  assert.deepEqual(await checkout(gone, again), { redirect: SESSION.url }, "a cancelled client can order again");
});

test("not connected", async () => {
  const DB = await seed({ connected: false });
  const stripe = okStripe();
  const out = await checkout(DB, stripe);
  assert.equal(out.status, 503);
  assert.ok(out.html.includes(ORDER_NOTICES.not_connected));
  assert.doesNotMatch(out.html, /<button/);
  assert.deepEqual(todo(DB, "setup:stripe"), {
    kind: "setup", title: "Connect Stripe: Smith Roofing tried to order", link: "/#/setup", place_id: "p1", status: "open",
  });
  assert.equal(stripe.calls.length, 0);
  assert.equal(clicks(DB).length, 0);
  // a second try doesn't add a second todo
  await checkout(DB, stripe);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM todos").get().n, 1);

  // a key without a webhook is not connected either
  const half = await seed({ connected: false });
  await setSecret(half, "stripe_key", "sk_test_x");
  assert.equal((await checkout(half, stripe)).status, 503);
  // the legacy Cloudflare key counts as a key
  const legacy = await seed({ connected: false });
  await setSecret(legacy, "stripe_webhook", "whsec_x");
  const viaEnv = okStripe();
  const opened = await startCheckout(legacy, { STRIPE_SECRET_KEY: "sk_test_env" },
    { slug: SLUG, pkg: "full", seen: "weekday", origin: ORIGIN, now: MONDAY, fetchImpl: viaEnv.fetchImpl });
  assert.deepEqual(opened, { redirect: SESSION.url });
  assert.equal(viaEnv.calls[0].headers.authorization, "Bearer sk_test_env");
});

test("Stripe refuses", async () => {
  const DB = await seed();
  const stripe = fakeStripe({ "POST checkout/sessions": { status: 400, error: "Invalid email" } });
  const out = await checkout(DB, stripe);
  assert.equal(out.status, 502);
  assert.ok(out.html.includes(ORDER_NOTICES.failed));
  assert.ok(out.html.includes('name="package" value="full"'), "failed keeps the buttons");
  const t = todo(DB, "payment:checkout:p1");
  assert.equal(t.kind, "payment");
  assert.equal(t.link, "/#/setup");
  assert.match(t.title, /^Smith Roofing tried to pay but Stripe refused: .*Invalid email/);
  const beat = DB.raw.prepare("SELECT ok, detail FROM heartbeats WHERE name = 'stripe'").get();
  assert.equal(beat.ok, 0);
  assert.match(beat.detail, /^Checkout refused: .*Invalid email/);
  assert.equal(clicks(DB).length, 1, "the attempt counts");

  // Stripe unreachable, and a session with no URL, are refusals too; the key never shows anywhere
  for (const route of [() => { throw new Error("offline"); }, { id: "cs_2" }]) {
    const db2 = await seed();
    const out2 = await checkout(db2, fakeStripe({ "POST checkout/sessions": route }));
    assert.equal(out2.status, 502);
    const row = db2.raw.prepare("SELECT ok, detail FROM heartbeats WHERE name = 'stripe'").get();
    assert.equal(row.ok, 0);
    for (const text of [out2.html, row.detail, todo(db2, "payment:checkout:p1").title]) {
      assert.doesNotMatch(text, /sk_test_x|whsec_x/);
    }
  }
});

test("order page extras", async () => {
  const DB = await seed();
  const off = await orderPage(DB, {}, { slug: SLUG, back: false, now: MONDAY });
  assert.equal(off.status, 200);
  assert.doesNotMatch(off.html, /chat assistant|Review booster/);
  assert.doesNotMatch(off.html, /No payment was taken\./);
  assert.ok(off.html.includes(`action="/d/${SLUG}/checkout"`));
  assert.doesNotMatch(off.html, /sk_test_x|whsec_x/);

  await setSetting(DB, "offer:chatbot_live", "1");
  const on = await orderPage(DB, {}, { slug: SLUG, back: false, now: MONDAY });
  assert.ok(on.html.includes("chat assistant"));
  assert.doesNotMatch(on.html, /Review booster/);
  await setSetting(DB, "offer:review_booster_live", "1");
  assert.ok((await orderPage(DB, {}, { slug: SLUG, back: false, now: MONDAY })).html.includes("Review booster"));

  const back = await orderPage(DB, {}, { slug: SLUG, back: true, now: MONDAY });
  assert.equal(back.status, 200);
  assert.ok(back.html.includes("No payment was taken."));

  assert.equal((await orderPage(DB, {}, { slug: "no-such-demo", back: false, now: MONDAY })).status, 404);
  assert.equal((await orderPage(DB, {}, { slug: "Bad Slug!", back: false, now: MONDAY })).status, 404);

  await setSetting(DB, "business:legal_name", "Nikiforos P");
  await setSetting(DB, "business:address", "1 High Street, Leeds LS1 1AA");
  const line = traderLine({ legal_name: "Nikiforos P", address: "1 High Street, Leeds LS1 1AA" });
  assert.ok(line, "traderLine gives a line for these settings");
  assert.ok((await orderPage(DB, {}, { slug: SLUG, back: false, now: MONDAY })).html.includes(line));

  // the weekend page: banner, and the form says it was seen on the weekend
  const sat = await orderPage(DB, {}, { slug: SLUG, back: false, now: new Date("2026-10-24T12:00:00Z") });
  assert.ok(sat.html.includes("Weekend price — ends Sunday midnight"));
  assert.ok(sat.html.includes('name="seen" value="weekend"'));
});

test("order page notices: already a client and not connected hide the buttons", async () => {
  const DB = await seed();
  addClient(DB);
  const client = await orderPage(DB, {}, { slug: SLUG, back: true, now: MONDAY });
  assert.equal(client.status, 200);
  assert.ok(client.html.includes("Smith Roofing is already with us."));
  assert.doesNotMatch(client.html, /<button/);

  const off = await seed({ connected: false });
  const page = await orderPage(off, {}, { slug: SLUG, back: false, now: MONDAY });
  assert.ok(page.html.includes(ORDER_NOTICES.not_connected));
  assert.doesNotMatch(page.html, /<button/);
  assert.equal(off.raw.prepare("SELECT COUNT(*) AS n FROM todos").get().n, 0, "only an order attempt files the todo");
});

test("loadOrder: what the page needs, never the key", async () => {
  const DB = await seed();
  await setSetting(DB, "offer:review_booster_live", "1");
  const o = await loadOrder(DB, {}, SLUG, MONDAY);
  assert.equal(o.lead.place_id, "p1");
  assert.equal(o.demo.slug, SLUG);
  assert.equal(o.expired, false);
  assert.deepEqual(o.prospect, { email: "mark@smithroofing.co.uk", greet_name: "Mark" });
  assert.equal(o.alreadyClient, false);
  assert.equal(o.connected, true);
  assert.deepEqual(o.extras, { chatbot: false, reviews: true });
  assert.equal(o.trader, "");
  assert.doesNotMatch(JSON.stringify(o), /sk_test_x|whsec_x/);
  assert.equal(await loadOrder(DB, {}, "no-such-demo", MONDAY), null);

  // no prospect row (a demo Nik sent by hand): prospect null, checkout opens with no customer_email
  const bare = fakeD1();
  await seedLead(bare, { place_id: "p1", name: "Smith Roofing" });
  await seedDemo(bare, { place_id: "p1", slug: SLUG, expires_at: "2027-04-01T09:00:00Z" });
  await setSecret(bare, "stripe_key", "sk_test_x");
  await setSecret(bare, "stripe_webhook", "whsec_x");
  assert.equal((await loadOrder(bare, {}, SLUG, MONDAY)).prospect, null);
  const stripe = okStripe();
  assert.deepEqual(await checkout(bare, stripe), { redirect: SESSION.url });
  assert.ok(!("customer_email" in stripe.calls[0].params));
});

// ---------------------------------------------------------------- the Pages routes

const at = (t, now) => t.mock.timers.enable({ apis: ["Date"], now });

test("GET /d/:slug/order: the page, ?back=1, 404 and 410", async (t) => {
  at(t, MONDAY);
  const DB = await seed();
  const get = (slug, query = "") => orderRoute({ env: { DB }, params: { slug }, request: new Request(`${ORIGIN}/d/${slug}/order${query}`) });
  const res = await get(SLUG);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const html = await res.text();
  assert.ok(html.includes("<title>Order your website · Smith Roofing</title>"));
  assert.doesNotMatch(html, /No payment was taken/);
  assert.ok((await (await get(SLUG, "?back=1")).text()).includes("No payment was taken."));
  assert.equal((await get("no-such-demo")).status, 404);
  const ended = await seed({ demo: { expires_at: "2026-10-01T00:00:00Z" } });
  const gone = await orderRoute({ env: { DB: ended }, params: { slug: SLUG }, request: new Request(`${ORIGIN}/d/${SLUG}/order`) });
  assert.equal(gone.status, 410);
});

test("POST /d/:slug/checkout: form or JSON, 303 to Stripe, origin from the request", async (t) => {
  at(t, MONDAY);
  const stripe = okStripe();
  const realFetch = globalThis.fetch;
  globalThis.fetch = stripe.fetchImpl;
  t.after(() => { globalThis.fetch = realFetch; });
  const DB = await seed();
  const post = (body, type) => checkoutRoute({
    env: { DB }, params: { slug: SLUG },
    request: new Request(`https://aetoswebsites.com/d/${SLUG}/checkout`, { method: "POST", headers: { "content-type": type }, body }),
  });

  const form = await post("package=full&seen=weekday", "application/x-www-form-urlencoded");
  assert.equal(form.status, 303);
  assert.equal(form.headers.get("location"), SESSION.url);
  assert.ok(sentText(stripe.calls[0]).includes("success_url=https://aetoswebsites.com/d/smith-roofing/thanks"), "origin is the host they used");

  const json = await post(JSON.stringify({ package: "website", seen: "weekday" }), "application/json");
  assert.equal(json.status, 303);
  assert.ok(sentText(stripe.calls[1]).includes("mode=payment"));

  const bad = await post("package=enterprise", "application/x-www-form-urlencoded");
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("content-type"), "text/html; charset=utf-8");
  assert.ok((await bad.text()).includes(ORDER_NOTICES.failed));
  const junk = await post("{not json", "application/json");
  assert.equal(junk.status, 400);
  assert.equal(stripe.calls.length, 2);
});

test("a won prospect whose client stopped can order again, and the limit still holds on its old demo", async () => {
  // demoBySlug never ends a won prospect's demo, but recordEvent stores nothing once expires_at has passed: the
  // order_click must still be written, or the 5-an-hour limit would never bite.
  const DB = await seed({ demo: { expires_at: "2026-10-01T00:00:00Z" } });
  DB.raw.prepare("UPDATE prospects SET stage = 'won' WHERE place_id = 'p1'").run();
  addClient(DB, "2026-10-10");
  const stripe = okStripe();
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await checkout(DB, stripe, { now: new Date(MONDAY.getTime() + i * MIN) }), { redirect: SESSION.url });
  }
  assert.equal(clicks(DB).length, 5);
  assert.equal((await checkout(DB, stripe, { now: new Date(MONDAY.getTime() + 10 * MIN) })).status, 429);
  assert.equal(stripe.calls.length, 5);
});

test("the ended page names who it was for and their thread's mailbox, as the demo page's does", async () => {
  const DB = await seed({ demo: { expires_at: "2026-10-01T00:00:00Z" } });
  await seedMailbox(DB, { id: "m1" });
  DB.raw.prepare("UPDATE prospects SET mailbox_id = 'm1' WHERE place_id = 'p1'").run();
  for (const out of [await orderPage(DB, {}, { slug: SLUG, back: false, now: MONDAY }), await checkout(DB, okStripe())]) {
    assert.equal(out.status, 410);
    assert.match(out.html, /This preview has ended/);
    assert.ok(out.html.includes("Smith"));
    assert.ok(out.html.includes("mailto:m1@aetoswebsites.com"));
  }
});

test("POST /d/:slug/checkout: a body over 2000 bytes is a bad package, never read whole", async (t) => {
  at(t, MONDAY);
  const stripe = okStripe();
  const realFetch = globalThis.fetch;
  globalThis.fetch = stripe.fetchImpl;
  t.after(() => { globalThis.fetch = realFetch; });
  const DB = await seed();
  const res = await checkoutRoute({
    env: { DB }, params: { slug: SLUG },
    request: new Request(`${ORIGIN}/d/${SLUG}/checkout`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `package=full&seen=weekday&pad=${"x".repeat(5000)}`,
    }),
  });
  assert.equal(res.status, 400);
  assert.equal(stripe.calls.length, 0);
  assert.equal(clicks(DB).length, 0);
});
