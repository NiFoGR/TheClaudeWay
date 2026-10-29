// The Stripe webhook (handleWebhook / handleEvent in stripe-events.js): signature first, every event id stored once in
// stripe_events so Stripe's repeats change nothing, invoice.paid records build fees and retainers once, and the
// `stripe` heartbeat feeds the Payments light. Run: node --test control-room/tests/stripe-events.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { loadMoney } from "../functions/_lib/money.js";
import { setSecret } from "../functions/_lib/settings.js";
import { thanksPage } from "../functions/_lib/checkout.js";
import { handleEvent, handleWebhook } from "../functions/_lib/stripe-events.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { fakeStripe } from "./helpers/fakeStripe.mjs";

const NOW = new Date("2026-10-19T10:01:00Z"); // Mon 11:01 UK (BST)
const SECONDS = Math.floor(NOW.getTime() / 1000);
const CREATED = Date.parse("2026-10-19T10:00:00Z") / 1000;
const SECRET = "whsec_x";
const env = {};

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

const all = async (DB, sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results;
const one = async (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const count = async (DB, sql, ...args) => (await one(DB, sql, ...args)).n;

// The test's own Stripe-Signature header: t=<seconds>,v1=<HMAC-SHA256 of "t.body">.
async function sign(body, secret = SECRET, t = SECONDS) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`));
  return `t=${t},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const event = (id, type, object) => ({ id, object: "event", type, created: SECONDS, data: { object } });

async function deliver(DB, evt, { fetchImpl = fakeStripe({}).fetchImpl, now = NOW, secret = SECRET } = {}) {
  const body = JSON.stringify(evt);
  return handleWebhook(DB, env, { body, signature: await sign(body, secret, Math.floor(now.getTime() / 1000)), now, fetchImpl });
}

function session(extra = {}) {
  return {
    id: "cs_1", object: "checkout.session", mode: "subscription", payment_status: "paid", customer: "cus_1",
    subscription: "sub_1", amount_total: 195000, created: CREATED, client_reference_id: "p1",
    customer_details: { email: "mark@smithroofing.co.uk", phone: "+447700900000" },
    metadata: { place_id: "p1", package: "full", weekend: "0", slug: "smith-roofing", origin: "https://x.test" },
    ...extra,
  };
}

async function seed() {
  const DB = fakeD1();
  await insert(DB, "leads", {
    place_id: "p1", name: "Smith Roofing", trade: "roofer", search_town: "Leeds",
    first_seen_at: "2026-09-01T09:00:00Z", updated_at: "2026-09-01T09:00:00Z",
  });
  await insert(DB, "demos", {
    slug: "smith-roofing", place_id: "p1", created_at: "2026-10-01T09:00:00Z", expires_at: "2027-04-01T09:00:00Z",
  });
  await insert(DB, "prospects", {
    place_id: "p1", stage: "viewed", stage_at: "2026-10-10T09:00:00Z", email: "mark@smithroofing.co.uk",
    greet_name: "Mark", created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-10T09:00:00Z",
  });
  await insert(DB, "mailboxes", {
    id: "mb_sys", address: "hello@aetoswebsites.com", display_name: "Nik", role: "system", started_on: "2026-01-01",
    status: "active", created_at: "2026-01-01T09:00:00Z",
  });
  await setSecret(DB, "stripe_webhook", SECRET);
  await setSecret(DB, "stripe_key", "sk_test_x");
  return DB;
}

const heartbeat = (DB) => one(DB, "SELECT * FROM heartbeats WHERE name = 'stripe'");

test("bad signature", async () => {
  const DB = await seed();
  const body = JSON.stringify(event("evt_bad", "checkout.session.completed", session()));
  for (const signature of [await sign(body, "whsec_wrong"), await sign(body + " "), "", null, await sign(body, SECRET, SECONDS - 1000)]) {
    const res = await handleWebhook(DB, env, { body, signature, now: NOW, fetchImpl: fakeStripe({}).fetchImpl });
    assert.deepEqual(res, { status: 400, json: { error: "Bad signature" } });
  }
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM stripe_events"), 0);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 0);
  assert.equal(await heartbeat(DB), null);

  // junk never touches a heartbeat that is already there (red or green), nor a correctly signed non-event
  await DB.prepare("INSERT INTO heartbeats (name, last_at, ok, detail) VALUES ('stripe', '2026-10-18T09:00:00Z', 0, 'earlier failure')").run();
  const before = { ...(await heartbeat(DB)) };
  assert.deepEqual(await handleWebhook(DB, env, { body, signature: await sign(body, "whsec_wrong"), now: NOW }),
    { status: 400, json: { error: "Bad signature" } });
  for (const junk of ["not json", JSON.stringify({ id: "nope", type: "invoice.paid" }), "[]"]) {
    const res = await handleWebhook(DB, env, { body: junk, signature: await sign(junk), now: NOW });
    assert.deepEqual(res, { status: 400, json: { error: "That isn't a Stripe event" } });
  }
  assert.deepEqual({ ...(await heartbeat(DB)) }, before);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM stripe_events"), 0);

  // no webhook secret saved at all: nothing can be trusted
  const none = fakeD1();
  const res = await handleWebhook(none, env, { body, signature: await sign(body), now: NOW, fetchImpl: fakeStripe({}).fetchImpl });
  assert.deepEqual(res, { status: 400, json: { error: "Bad signature" } });
  assert.equal(await heartbeat(none), null);
});

test("replay", async () => {
  const DB = await seed();
  const evt = event("evt_1", "checkout.session.completed", session());
  const first = await deliver(DB, evt);
  assert.equal(first.status, 200);
  assert.equal(first.json.received, true);
  assert.equal(first.json.duplicate, undefined);
  assert.equal(first.json.result, "client added: cl_cs_1");

  const counts = async () => Promise.all(["clients", "payments", "onboarding", "todos", "stripe_events", "demo_events"]
    .map((t) => count(DB, `SELECT COUNT(*) AS n FROM ${t}`)).concat(count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'")));
  const before = await counts();

  const second = await deliver(DB, evt, { now: new Date(NOW.getTime() + 60_000) }); // Stripe's resend, a minute later
  assert.equal(second.status, 200);
  assert.deepEqual(second.json, { received: true, duplicate: true });
  assert.deepEqual(await counts(), before);

  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 1);
  const rows = await all(DB, "SELECT * FROM stripe_events");
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { id: "evt_1", type: "checkout.session.completed", result: "client added: cl_cs_1", at: "2026-10-19T10:01:00Z" });
  const beat = await heartbeat(DB);
  assert.equal(beat.ok, 1);
  assert.equal(beat.detail, "checkout.session.completed");
  assert.equal(beat.last_at, "2026-10-19T10:01:00Z");
});

// Exactly Part B's payload (no subscription, no created: paid_on falls back to the time it arrived, a UK date). It is
// the subscription's first invoice (billing_reason subscription_create): the build line is the checkout's build fee.
const firstInvoice = {
  id: "in_1", customer: "cus_1", amount_paid: 195000, charge: "ch_1", billing_reason: "subscription_create",
  lines: { data: [{ type: "invoiceitem", amount: 195000 }, { type: "subscription", amount: 0 }] },
};

test("one checkout event stays well inside D1's 50 queries per invocation", async () => {
  const DB = await seed();
  const c = countingDB(DB);
  const res = await deliver(c.DB, event("evt_q", "checkout.session.completed", session()));
  assert.equal(res.json.result, "client added: cl_cs_1");
  assert.ok(c.used() <= 40, `used ${c.used()} D1 statements`); // + db()'s version read, with room to spare
  const repeat = countingDB(DB);
  await deliver(repeat.DB, event("evt_q", "checkout.session.completed", session()));
  assert.ok(repeat.used() <= 3, `a duplicate used ${repeat.used()}`);
});

test("invoice first", async () => {
  const DB = await seed();
  const stripe = fakeStripe({ "GET charges/ch_1?expand[]=balance_transaction": { id: "ch_1", balance_transaction: { fee: 2950 } } });
  const paid = await deliver(DB, event("evt_inv", "invoice.paid", firstInvoice), { fetchImpl: stripe.fetchImpl });
  assert.equal(paid.status, 200);
  assert.equal(stripe.calls.length, 1);
  assert.equal(stripe.calls[0].method, "GET");
  assert.equal(stripe.calls[0].path, "charges/ch_1?expand[]=balance_transaction");
  assert.equal(stripe.calls[0].headers.authorization, "Bearer sk_test_x");

  const done = await deliver(DB, event("evt_cs", "checkout.session.completed", session()), { fetchImpl: stripe.fetchImpl });
  assert.equal(done.status, 200);
  const payments = await all(DB, "SELECT * FROM payments");
  assert.equal(payments.length, 1);
  assert.equal(payments[0].id, "build:cus_1");
  assert.equal(payments[0].category, "Website builds");
  assert.equal(payments[0].amount_pence, 195000);
  assert.equal(payments[0].fee_pence, 2950);
  assert.equal(payments[0].name, "Smith Roofing");
  assert.equal(payments[0].stripe_customer, "cus_1");
  assert.equal(payments[0].paid_on, "2026-10-19");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 1);

  // the other order: checkout first, then the invoice adds Stripe's fee to the same row (and nothing else)
  const B = await seed();
  await deliver(B, event("evt_cs", "checkout.session.completed", session()), { fetchImpl: stripe.fetchImpl });
  await deliver(B, event("evt_inv", "invoice.paid", firstInvoice), { fetchImpl: stripe.fetchImpl });
  const rows = await all(B, "SELECT * FROM payments");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].amount_pence, rows[0].fee_pence, rows[0].name], ["build:cus_1", 195000, 2950, "Smith Roofing"]);
});

const DEC_18 = Date.parse("2026-12-18T10:00:00Z") / 1000;
const monthlyInvoice = {
  id: "in_2", object: "invoice", parent: { subscription_details: { subscription: "sub_1" } }, amount_paid: 24900,
  created: DEC_18, status_transitions: { paid_at: DEC_18 },
  lines: { data: [{ type: "subscription", amount: 24900 }] },
};

test("monthly", async () => {
  const DB = await seed();
  await deliver(DB, event("evt_cs", "checkout.session.completed", session()));
  await DB.prepare("UPDATE client_links SET failed_on = '2026-12-18' WHERE client_id = 'cl_cs_1'").run();

  const res = await deliver(DB, event("evt_m", "invoice.paid", monthlyInvoice), { now: new Date("2026-12-18T10:05:00Z") });
  assert.equal(res.status, 200);
  const row = await one(DB, "SELECT * FROM payments WHERE id = 'in_2:monthly'");
  assert.ok(row, "monthly row recorded");
  assert.equal(row.category, "Monthly retainers");
  assert.equal(row.amount_pence, 24900);
  assert.equal(row.fee_pence, 0);
  assert.equal(row.stripe_customer, "cus_1"); // found through the subscription: the Money page joins on it
  assert.equal(row.name, "Smith Roofing");
  assert.equal(row.paid_on, "2026-12-18");
  assert.equal((await one(DB, "SELECT failed_on FROM client_links WHERE client_id = 'cl_cs_1'")).failed_on, null);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM payments"), 2);

  // the older shape (invoice.subscription) reaches the same client
  await DB.prepare("UPDATE client_links SET failed_on = '2027-01-18' WHERE client_id = 'cl_cs_1'").run();
  const jan = Date.parse("2027-01-18T10:00:00Z") / 1000;
  await deliver(DB, event("evt_m2", "invoice.paid", {
    id: "in_4", object: "invoice", subscription: "sub_1", amount_paid: 24900, created: jan, status_transitions: { paid_at: jan },
    lines: { data: [{ type: "subscription", amount: 24900 }] },
  }));
  const jan18 = await one(DB, "SELECT * FROM payments WHERE id = 'in_4:monthly'");
  assert.deepEqual([jan18.stripe_customer, jan18.name, jan18.paid_on], ["cus_1", "Smith Roofing", "2027-01-18"]);
  assert.equal((await one(DB, "SELECT failed_on FROM client_links")).failed_on, null);

  // the same invoice under a new event id (Stripe can send one twice): still one £249, not two
  const again = await deliver(DB, event("evt_m_again", "invoice.paid", monthlyInvoice), { now: new Date("2026-12-18T10:09:00Z") });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, undefined);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM payments WHERE id = 'in_2:monthly'"), 1);
  assert.equal((await one(DB, "SELECT amount_pence FROM payments WHERE id = 'in_2:monthly'")).amount_pence, 24900);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM payments"), 3);
});

test("fee missing", async () => {
  const DB = await seed();
  const { charge, ...noCharge } = firstInvoice;
  const stripe = fakeStripe({});
  const res = await deliver(DB, event("evt_nf", "invoice.paid", noCharge), { fetchImpl: stripe.fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(stripe.calls.length, 0);
  const row = await one(DB, "SELECT * FROM payments WHERE id = 'build:cus_1'");
  assert.equal(row.amount_pence, 195000);
  assert.equal(row.fee_pence, 0);

  // a charge Stripe can't find (or Stripe down, or no key): the payment still counts, the fee is 0
  const B = await seed();
  const missing = fakeStripe({ "GET charges/ch_1?expand[]=balance_transaction": { status: 404, error: "No such charge: 'ch_1'" } });
  assert.equal((await deliver(B, event("evt_nf", "invoice.paid", firstInvoice), { fetchImpl: missing.fetchImpl })).status, 200);
  assert.equal((await one(B, "SELECT fee_pence FROM payments WHERE id = 'build:cus_1'")).fee_pence, 0);
  const C = fakeD1();
  await setSecret(C, "stripe_webhook", SECRET);
  assert.equal((await deliver(C, event("evt_nf", "invoice.paid", firstInvoice))).status, 200);
  assert.equal((await one(C, "SELECT fee_pence FROM payments WHERE id = 'build:cus_1'")).fee_pence, 0);
});

test("fee split pro rata, amounts add up to what was paid", async () => {
  const DB = await seed();
  const stripe = fakeStripe({ "GET charges/ch_5?expand[]=balance_transaction": { balance_transaction: { fee: 1001 } } });
  await deliver(DB, event("evt_split", "invoice.paid", {
    id: "in_5", customer: "cus_1", amount_paid: 3, charge: "ch_5", created: CREATED, billing_reason: "subscription_create",
    lines: { data: [{ type: "invoiceitem", amount: 1 }, { type: "subscription", amount: 2 }] },
  }), { fetchImpl: stripe.fetchImpl });
  const rows = await all(DB, "SELECT id, amount_pence, fee_pence FROM payments ORDER BY id");
  assert.deepEqual(rows.map((r) => r.id), ["build:cus_1", "in_5:monthly"]);
  assert.equal(rows.reduce((s, r) => s + r.amount_pence, 0), 3);
  assert.equal(rows.reduce((s, r) => s + r.fee_pence, 0), 1001);
});

// Review fix: only the checkout's own build invoice is the build row. Any other one-off money from the same customer
// (an invoice Nik raises in Stripe for extra work, an invoice item added to a monthly invoice, proration) is its own
// `<invoice id>:oneoff` row under Other income, so it is counted and never overwrites the build fee's Stripe fee.
const feeStripe = () => fakeStripe({
  "GET charges/ch_1?expand[]=balance_transaction": { balance_transaction: { fee: 2950 } },
  "GET charges/ch_2?expand[]=balance_transaction": { balance_transaction: { fee: 170 } },
  "GET charges/ch_3?expand[]=balance_transaction": { balance_transaction: { fee: 1000 } },
});
const JAN_20 = Date.parse("2027-01-20T10:00:00Z") / 1000;
const extraInvoice = {
  id: "in_2", customer: "cus_1", amount_paid: 12000, charge: "ch_2", billing_reason: "manual", created: JAN_20,
  status_transitions: { paid_at: JAN_20 }, lines: { data: [{ type: "invoiceitem", amount: 12000 }] },
};

test("a second one-off invoice for the same customer is its own payment; the build row keeps its fee", async () => {
  const DB = await seed();
  const stripe = feeStripe();
  await deliver(DB, event("evt_cs", "checkout.session.completed", session()), { fetchImpl: stripe.fetchImpl });
  await deliver(DB, event("evt_in1", "invoice.paid", firstInvoice), { fetchImpl: stripe.fetchImpl });
  const res = await deliver(DB, event("evt_in2", "invoice.paid", extraInvoice), { fetchImpl: stripe.fetchImpl });
  assert.equal(res.json.result, "recorded £120 from Smith Roofing");
  const rows = await all(DB, "SELECT id, stripe_customer, name, category, amount_pence, fee_pence, paid_on FROM payments ORDER BY id");
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { id: "build:cus_1", stripe_customer: "cus_1", name: "Smith Roofing", category: "Website builds", amount_pence: 195000, fee_pence: 2950, paid_on: "2026-10-19" },
    { id: "in_2:oneoff", stripe_customer: "cus_1", name: "Smith Roofing", category: "Other income", amount_pence: 12000, fee_pence: 170, paid_on: "2027-01-20" },
  ]);

  // the same invoices again under new event ids (Stripe can send one twice): still one build row and one £120
  await deliver(DB, event("evt_in1_again", "invoice.paid", firstInvoice), { fetchImpl: stripe.fetchImpl });
  await deliver(DB, event("evt_in2_again", "invoice.paid", extraInvoice), { fetchImpl: stripe.fetchImpl });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM payments"), 2);
  const build = await one(DB, "SELECT amount_pence, fee_pence FROM payments WHERE id = 'build:cus_1'");
  assert.deepEqual({ ...build }, { amount_pence: 195000, fee_pence: 2950 });
  assert.equal((await one(DB, "SELECT amount_pence FROM payments WHERE id = 'in_2:oneoff'")).amount_pence, 12000);
});

test("a monthly invoice carrying an extra invoice item: a monthly row and a one-off row, the fee split pro rata", async () => {
  const DB = await seed();
  const stripe = feeStripe();
  await deliver(DB, event("evt_cs", "checkout.session.completed", session()), { fetchImpl: stripe.fetchImpl });
  await deliver(DB, event("evt_in1", "invoice.paid", firstInvoice), { fetchImpl: stripe.fetchImpl });
  await deliver(DB, event("evt_in3", "invoice.paid", {
    id: "in_3", parent: { subscription_details: { subscription: "sub_1" } }, billing_reason: "subscription_cycle",
    amount_paid: 29900, charge: "ch_3", created: DEC_18, status_transitions: { paid_at: DEC_18 },
    lines: { data: [{ type: "subscription", amount: 24900 }, { type: "invoiceitem", amount: 5000 }] },
  }), { fetchImpl: stripe.fetchImpl });
  const rows = await all(DB, "SELECT id, category, amount_pence, fee_pence FROM payments ORDER BY id");
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { id: "build:cus_1", category: "Website builds", amount_pence: 195000, fee_pence: 2950 },
    { id: "in_3:monthly", category: "Monthly retainers", amount_pence: 24900, fee_pence: 833 },
    { id: "in_3:oneoff", category: "Other income", amount_pence: 5000, fee_pence: 167 },
  ]);
});

test("Website Only: its tagged build invoice is the build row, whichever of it and the checkout comes first", async () => {
  const website = session({
    mode: "payment", subscription: null, amount_total: 175000, metadata: { ...session().metadata, package: "website" },
  });
  const buildInvoice = {
    id: "in_w", customer: "cus_1", amount_paid: 175000, charge: "ch_1", billing_reason: "manual",
    metadata: { aetos_build: "1" }, lines: { data: [{ type: "invoiceitem", amount: 175000 }] },
  };
  for (const order of [["inv", "cs"], ["cs", "inv"]]) {
    const DB = await seed();
    const stripe = feeStripe();
    for (const which of order) {
      const evt = which === "cs" ? event("evt_cs", "checkout.session.completed", website) : event("evt_inv", "invoice.paid", buildInvoice);
      assert.equal((await deliver(DB, evt, { fetchImpl: stripe.fetchImpl })).status, 200);
    }
    const rows = await all(DB, "SELECT id, category, amount_pence, fee_pence, name FROM payments");
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { id: "build:cus_1", category: "Website builds", amount_pence: 175000, fee_pence: 2950, name: "Smith Roofing" },
    ], order.join(" then "));
  }
});

test("a one-off invoice with no Stripe customer isn't a build fee: it is recorded against its invoice", async () => {
  const DB = await seed();
  const res = await deliver(DB, event("evt_nc", "invoice.paid", {
    id: "in_7", amount_paid: 5000, billing_reason: "manual", customer_email: "someone@else.co.uk",
    lines: { data: [{ type: "invoiceitem", amount: 5000 }] },
  }));
  assert.equal(res.json.result, "recorded £50 from someone@else.co.uk");
  const row = await one(DB, "SELECT id, stripe_customer, category, amount_pence FROM payments");
  assert.deepEqual({ ...row }, { id: "in_7:oneoff", stripe_customer: null, category: "Other income", amount_pence: 5000 });
  // the checkout's own build invoice still needs a customer (its row id is build:<customer>)
  const B = await seed();
  const { customer, ...noCustomer } = firstInvoice;
  assert.equal((await deliver(B, event("evt_nc2", "invoice.paid", noCustomer))).json.result,
    "ignored: a build payment with no Stripe customer");
});

test("trial invoice", async () => {
  const DB = await seed();
  const res = await deliver(DB, event("evt_t", "invoice.paid", { ...firstInvoice, amount_paid: 0, charge: null }));
  assert.equal(res.status, 200);
  assert.equal(res.json.result, "nothing paid (free trial invoice)");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM payments"), 0);
  assert.equal(await handleEvent(DB, env, event("evt_t2", "invoice.paid", { id: "in_9", amount_paid: 0 }), { now: NOW }),
    "nothing paid (free trial invoice)");
});

test("handler error", async () => {
  const DB = await seed();
  const failing = /INSERT OR IGNORE INTO clients/;
  const broken = {
    ...DB,
    prepare: (sql) => DB.prepare(sql),
    batch: async (stmts) => {
      if (stmts.some((s) => failing.test(s.statement))) throw new Error("D1_ERROR: database is locked: SQLITE_BUSY");
      return DB.batch(stmts);
    },
  };
  const res = await deliver(broken, event("evt_err", "checkout.session.completed", session()));
  assert.equal(res.status, 500);
  assert.match(res.json.error, /database is locked/);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM stripe_events"), 0);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 0);
  const beat = await heartbeat(DB);
  assert.equal(beat.ok, 0);
  assert.match(beat.detail, /D1_ERROR: database is locked: SQLITE_BUSY/);
  assert.match(beat.detail, /checkout\.session\.completed/);

  // Stripe retries once it works: the event is processed and stored, and the light goes green again
  const retry = await deliver(DB, event("evt_err", "checkout.session.completed", session()));
  assert.equal(retry.status, 200);
  assert.equal(retry.json.duplicate, undefined);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM stripe_events"), 1);
  assert.equal((await heartbeat(DB)).ok, 1);
});

test("unhandled event types are stored and answered 200", async () => {
  const DB = await seed();
  const res = await deliver(DB, event("evt_x", "customer.created", { id: "cus_9" }));
  assert.equal(res.status, 200);
  assert.equal(res.json.result, "ignored");
  assert.equal((await one(DB, "SELECT result FROM stripe_events WHERE id = 'evt_x'")).result, "ignored");
});

test("payments from other Stripe products are ignored, and say so", async () => {
  const DB = await seed();
  const res = await deliver(DB, event("evt_other", "checkout.session.completed", { id: "cs_3", payment_status: "paid", customer: "c", metadata: {} }));
  assert.equal(res.status, 200);
  assert.equal(res.json.result, "ignored: not an Aetos order");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 0);
  assert.equal((await one(DB, "SELECT result FROM stripe_events WHERE id = 'evt_other'")).result, "ignored: not an Aetos order");
});

test("money page", async () => {
  const DB = await seed();
  await deliver(DB, event("evt_cs", "checkout.session.completed", session()));
  await deliver(DB, event("evt_m", "invoice.paid", monthlyInvoice), { now: new Date("2026-12-18T10:05:00Z") });
  const { summary } = await loadMoney(DB, "2026-12-20");
  assert.equal(summary.clients.length, 1);
  assert.equal(summary.clients[0].key, "paying");
  assert.equal(summary.thisMonth.in, 24900);
  assert.equal(summary.months.find((m) => m.current).breakdown.in["Monthly retainers"], 24900);

  // that £249 is the payment, not the schedule: without the payment row this month has nothing in
  await DB.prepare("DELETE FROM payments WHERE id = 'in_2:monthly'").run();
  assert.equal((await loadMoney(DB, "2026-12-20")).summary.thisMonth.in, 0);
});

test("the webhook route answers with handleWebhook's status and body", async () => {
  const { onRequestPost } = await import("../functions/api/stripe/webhook.js");
  const DB = await seed();
  const nowSeconds = Math.floor(Date.now() / 1000); // the route checks the signature against the real clock
  const body = JSON.stringify(event("evt_route", "customer.created", { id: "cus_9" }));
  const post = async (signature) => onRequestPost({
    request: new Request("https://x.test/api/stripe/webhook", { method: "POST", body, headers: signature ? { "stripe-signature": signature } : {} }),
    env: { DB },
  });

  const bad = await post(await sign(body, "whsec_wrong", nowSeconds));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "Bad signature" });
  const missing = await post(null);
  assert.equal(missing.status, 400);

  const ok = await post(await sign(body, SECRET, nowSeconds));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "application/json");
  assert.deepEqual(await ok.json(), { received: true, result: "ignored" });
  const again = await post(await sign(body, SECRET, nowSeconds));
  assert.deepEqual(await again.json(), { received: true, duplicate: true });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM stripe_events"), 1);
});

// ---------------------------------------------------------------- Task 9: failed cards, cancellations, refunds, abandoned checkouts

const at = (isoText) => Date.parse(isoText) / 1000;
const failedInvoice = (extra = {}) => ({
  id: "in_3", object: "invoice", customer: "cus_1", amount_due: 24900, hosted_invoice_url: "https://invoice.stripe.com/i/x",
  created: at("2026-12-18T10:00:00Z"), attempt_count: 1, ...extra,
});
const DEC_18_NOW = new Date("2026-12-18T10:05:00Z");

async function fulfilled() {
  const DB = await seed();
  const res = await deliver(DB, event("evt_cs", "checkout.session.completed", session()));
  assert.equal(res.json.result, "client added: cl_cs_1");
  return DB;
}

test("card failed", async () => {
  const DB = await fulfilled();
  const systemBefore = await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'");
  const res = await deliver(DB, event("evt_f1", "invoice.payment_failed", failedInvoice()), { now: DEC_18_NOW });
  assert.equal(res.status, 200);
  assert.equal((await one(DB, "SELECT failed_on FROM client_links WHERE client_id = 'cl_cs_1'")).failed_on, "2026-12-18");
  const todo = await one(DB, "SELECT * FROM todos WHERE dedupe = 'payment:failed:in_3'");
  assert.ok(todo, "payment todo added");
  assert.equal(todo.kind, "payment");
  assert.equal(todo.title, "Card failed: Smith Roofing (£249). They've been emailed a link to pay; Stripe will retry.");
  assert.equal(todo.link, "/#/money");
  assert.equal(todo.client_id, "cl_cs_1");
  const msgs = await all(DB, "SELECT * FROM messages WHERE kind = 'system' ORDER BY created_at, id");
  assert.equal(msgs.length, systemBefore + 1);
  const mail = msgs.find((m) => m.subject === "Your Aetos Websites payment didn't go through");
  assert.ok(mail, "payment-failed email queued");
  assert.ok(mail.body.includes("https://invoice.stripe.com/i/x"));
  assert.ok(mail.body.startsWith("Hi Mark,"));
  assert.ok(mail.body.includes("Your monthly payment of £249 for Smith Roofing didn't go through."));
  assert.equal(mail.to_addr, "mark@smithroofing.co.uk");
  assert.equal(mail.author, "system");
  assert.equal(mail.client_id, "cl_cs_1");

  // Stripe retries the card: the same invoice under a new event id never emails them twice
  const again = await deliver(DB, event("evt_f2", "invoice.payment_failed", failedInvoice({ attempt_count: 2 })),
    { now: new Date("2026-12-21T10:05:00Z") });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, undefined);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), systemBefore + 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'payment:failed:%'"), 1);
  assert.equal((await one(DB, "SELECT failed_on FROM client_links WHERE client_id = 'cl_cs_1'")).failed_on, "2026-12-18");
});

test("card failed, delivered after the invoice was paid: no failure, no email", async () => {
  const DB = await fulfilled();
  const messagesBefore = await count(DB, "SELECT COUNT(*) AS n FROM messages");
  const todosBefore = await count(DB, "SELECT COUNT(*) AS n FROM todos");
  await deliver(DB, event("evt_p3", "invoice.paid", {
    id: "in_3", object: "invoice", customer: "cus_1", subscription: "sub_1", amount_paid: 24900,
    created: at("2026-12-18T10:00:00Z"), lines: { data: [{ type: "subscription", amount: 24900 }] },
  }), { now: new Date("2026-12-21T10:05:00Z") });
  // Stripe's earlier failure event arrives late (its first delivery failed and was retried)
  const late = await deliver(DB, event("evt_f1", "invoice.payment_failed", failedInvoice()), { now: new Date("2026-12-21T11:00:00Z") });
  assert.equal(late.status, 200);
  assert.equal(late.json.result, "card failed earlier, but that invoice is paid now");
  assert.equal((await one(DB, "SELECT failed_on FROM client_links WHERE client_id = 'cl_cs_1'")).failed_on, null);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos"), todosBefore);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages"), messagesBefore);
});

test("card failed, no mailbox", async () => {
  const DB = await fulfilled();
  await DB.prepare("DELETE FROM mailboxes").run();
  const welcomeBefore = await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'setup:welcome:%'");
  const messagesBefore = await count(DB, "SELECT COUNT(*) AS n FROM messages");
  const res = await deliver(DB, event("evt_f1", "invoice.payment_failed", failedInvoice()), { now: DEC_18_NOW });
  assert.equal(res.status, 200);
  const todo = await one(DB, "SELECT * FROM todos WHERE dedupe = 'setup:client-mail:cl_cs_1:payment-failed:in_3'");
  assert.ok(todo, "no-mailbox todo added");
  assert.equal(todo.kind, "setup");
  assert.equal(todo.title, "Send Smith Roofing this email yourself (no mailbox yet)");
  assert.ok(todo.draft.includes("https://invoice.stripe.com/i/x"));
  assert.ok(todo.detail.includes("https://invoice.stripe.com/i/x"), todo.detail); // the board shows a setup todo's detail
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'setup:welcome:%'"), welcomeBefore);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages"), messagesBefore);
  const payment = await one(DB, "SELECT * FROM todos WHERE dedupe = 'payment:failed:in_3'");
  assert.ok(payment);
  // nobody has emailed them: neither the todo nor Setup's "Last message from Stripe" may say so
  assert.ok(!payment.title.includes("emailed a link"), payment.title);
  assert.equal(payment.title,
    'Card failed: Smith Roofing (£249). No mailbox yet, so nobody has emailed them: send the email in the "Send Smith Roofing this email yourself" todo; Stripe will retry.');
  assert.ok(payment.detail.includes("https://invoice.stripe.com/i/x"), payment.detail);
  assert.ok(!res.json.result.includes("client emailed"), res.json.result);
  assert.equal(res.json.result, "marked payment failed (no mailbox: Nik sends the email)");
});

test("card failed, no email address: the todo says nobody emailed them", async () => {
  const DB = await fulfilled();
  await DB.prepare("UPDATE client_links SET email = NULL").run();
  const messagesBefore = await count(DB, "SELECT COUNT(*) AS n FROM messages");
  const res = await deliver(DB, event("evt_f1", "invoice.payment_failed", failedInvoice()), { now: DEC_18_NOW });
  assert.equal(res.status, 200);
  assert.equal(res.json.result, "marked payment failed (no email address)");
  const payment = await one(DB, "SELECT * FROM todos WHERE dedupe = 'payment:failed:in_3'");
  assert.equal(payment.title,
    "Card failed: Smith Roofing (£249). We have no email address for them: send them the pay link yourself; Stripe will retry.");
  assert.ok(payment.detail.includes("https://invoice.stripe.com/i/x"), payment.detail);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages"), messagesBefore);
});

test("unknown customer", async () => {
  const DB = await fulfilled();
  const todosBefore = await count(DB, "SELECT COUNT(*) AS n FROM todos");
  const messagesBefore = await count(DB, "SELECT COUNT(*) AS n FROM messages");
  const res = await deliver(DB, event("evt_fz", "invoice.payment_failed", failedInvoice({ customer: "cus_zz" })), { now: DEC_18_NOW });
  assert.equal(res.status, 200);
  assert.equal(res.json.result, "unknown customer");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos"), todosBefore);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages"), messagesBefore);
  assert.equal((await one(DB, "SELECT failed_on FROM client_links")).failed_on, null);
});

test("stopped", async () => {
  const DB = await fulfilled();
  const res = await deliver(DB, event("evt_d1", "customer.subscription.deleted",
    { id: "sub_1", object: "subscription", customer: "cus_1", ended_at: at("2027-01-15T10:00:00Z") }),
  { now: new Date("2027-01-15T10:05:00Z") });
  assert.equal(res.status, 200);
  assert.equal((await one(DB, "SELECT cancelled_on FROM clients WHERE id = 'cl_cs_1'")).cancelled_on, "2027-01-15");
  const todo = await one(DB, "SELECT * FROM todos WHERE dedupe = 'payment:stopped:cl_cs_1'");
  assert.ok(todo, "stopped todo added");
  assert.equal(todo.kind, "payment");
  assert.equal(todo.title, "Smith Roofing stopped the monthly plan: switch off the extras (their site stays up)");
  assert.equal(todo.link, "/#/money");

  // a second delete event (a later date) changes nothing
  const again = await deliver(DB, event("evt_d2", "customer.subscription.deleted",
    { id: "sub_1", object: "subscription", customer: "cus_1", ended_at: at("2027-02-20T10:00:00Z") }),
  { now: new Date("2027-02-20T10:05:00Z") });
  assert.equal(again.status, 200);
  assert.equal((await one(DB, "SELECT cancelled_on FROM clients WHERE id = 'cl_cs_1'")).cancelled_on, "2027-01-15");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'payment:stopped:%'"), 1);

  // the UK date, not the UTC one: 00:30 BST on 1 June is still 31 May in UTC
  const B = await fulfilled();
  await deliver(B, event("evt_d3", "customer.subscription.deleted", { id: "sub_1", ended_at: at("2027-05-31T23:30:00Z") }));
  assert.equal((await one(B, "SELECT cancelled_on FROM clients")).cancelled_on, "2027-06-01");
});

test("refund", async () => {
  const DB = await fulfilled();
  const today = "2026-10-19";
  const before = (await loadMoney(DB, today)).summary.thisMonth.in;
  const first = await deliver(DB, event("evt_r1", "charge.refunded", { id: "ch_9", object: "charge", customer: "cus_1", amount_refunded: 10000 }));
  assert.equal(first.status, 200);
  const second = await deliver(DB, event("evt_r2", "charge.refunded", { id: "ch_9", object: "charge", customer: "cus_1", amount_refunded: 24900 }));
  assert.equal(second.status, 200);
  const rows = await all(DB, "SELECT * FROM payments WHERE category = 'Refunds'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "refund:ch_9");
  assert.equal(rows[0].category, "Refunds");
  assert.equal(rows[0].amount_pence, -24900);
  assert.equal(rows[0].paid_on, "2026-10-19"); // ukDate(event.created)
  assert.equal(rows[0].stripe_customer, "cus_1");
  const after = (await loadMoney(DB, today)).summary;
  assert.equal(after.thisMonth.in, before - 24900);
  assert.equal(after.months.find((m) => m.current).breakdown.in.Refunds, -24900);

  // Stripe doesn't promise order: the older (smaller) total arriving late doesn't shrink the refund
  const late = await deliver(DB, event("evt_r0", "charge.refunded", { id: "ch_9", object: "charge", customer: "cus_1", amount_refunded: 10000 }));
  assert.equal(late.status, 200);
  assert.equal((await one(DB, "SELECT amount_pence FROM payments WHERE id = 'refund:ch_9'")).amount_pence, -24900);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM payments WHERE category = 'Refunds'"), 1);
});

test("abandoned", async () => {
  const DB = await fulfilled();
  await insert(DB, "leads", {
    place_id: "p2", name: "Green Leaf", trade: "landscaper", search_town: "Leeds",
    first_seen_at: "2026-09-01T09:00:00Z", updated_at: "2026-09-01T09:00:00Z",
  });
  const res = await deliver(DB, event("evt_x2", "checkout.session.expired",
    { id: "cs_2", object: "checkout.session", status: "expired", metadata: { place_id: "p2" } }));
  assert.equal(res.status, 200);
  const todo = await one(DB, "SELECT * FROM todos WHERE dedupe = 'checkout:p2'");
  assert.ok(todo, "hot todo added");
  assert.equal(todo.kind, "hot");
  assert.equal(todo.title, "Call Green Leaf: they opened the payment page but didn't pay");
  assert.equal(todo.link, "/#/lead/p2");
  assert.equal(todo.place_id, "p2");

  // p1 is already a client: no todo
  const todosBefore = await count(DB, "SELECT COUNT(*) AS n FROM todos");
  const p1 = await deliver(DB, event("evt_x1", "checkout.session.expired",
    { id: "cs_3", object: "checkout.session", status: "expired", metadata: { place_id: "p1" } }));
  assert.equal(p1.status, 200);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'checkout:p1'"), 0);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos"), todosBefore);
});

test("card failed: an email that fails to queue is sent on Stripe's retry", async () => {
  const DB = await fulfilled();
  const broken = {
    ...DB,
    prepare: (sql) => {
      if (/INSERT INTO messages/i.test(sql)) throw new Error("D1_ERROR: database is locked");
      return DB.prepare(sql);
    },
    batch: (stmts) => DB.batch(stmts),
  };
  const res = await deliver(broken, event("evt_f1", "invoice.payment_failed", failedInvoice()), { now: DEC_18_NOW });
  assert.equal(res.status, 500);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'payment:failed:in_3'"), 0);
  const retry = await deliver(DB, event("evt_f1", "invoice.payment_failed", failedInvoice()), { now: DEC_18_NOW });
  assert.equal(retry.status, 200);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'payment:failed:in_3'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE subject = 'Your Aetos Websites payment didn''t go through'"), 1);
});

// ---------------------------------------------------------------- review fixes: a welcome email that fails is never lost

// DB whose first `INSERT INTO messages` fails (a passing D1 error); everything else is the real fake D1.
function failFirstMessage(DB) {
  let failed = false;
  return new Proxy(DB, {
    get(target, prop) {
      if (prop !== "prepare") return Reflect.get(target, prop);
      return (sql) => {
        if (!failed && /INSERT INTO messages/.test(sql)) {
          failed = true;
          throw new Error("D1_ERROR: Network connection lost.");
        }
        return target.prepare(sql);
      };
    },
  });
}

test("checkout: a welcome email that fails to queue goes on Stripe's retry, once", async () => {
  const DB = await seed();
  const flaky = failFirstMessage(DB);
  const first = await deliver(flaky, event("evt_cs", "checkout.session.completed", session()));
  assert.equal(first.status, 500);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 0);
  const retry = await deliver(flaky, event("evt_cs", "checkout.session.completed", session()));
  assert.equal(retry.status, 200);
  assert.equal(retry.json.result, "client added: cl_cs_1");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM demo_events WHERE kind = 'ordered'"), 1);
  // a late redelivery under a new event id: nothing more
  const late = await deliver(flaky, event("evt_cs2", "checkout.session.completed", session()));
  assert.equal(late.json.result, "already recorded");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM demo_events WHERE kind = 'ordered'"), 1);
});

test("checkout: the thanks page fails while sending, the webhook that follows queues the welcome email", async () => {
  const DB = await seed();
  const flaky = failFirstMessage(DB);
  const { fetchImpl } = fakeStripe({ "GET checkout/sessions/cs_1": session() });
  const page = await thanksPage(flaky, env, { slug: "smith-roofing", sessionId: "cs_1", origin: "https://x.test", now: NOW, fetchImpl });
  assert.equal(page.status, 200);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 0);
  const token = (await one(DB, "SELECT token FROM onboarding")).token;
  const res = await deliver(flaky, event("evt_cs", "checkout.session.completed", session()));
  assert.equal(res.status, 200);
  assert.equal(res.json.result, "client added: cl_cs_1");
  const system = await all(DB, "SELECT * FROM messages WHERE kind = 'system'");
  assert.equal(system.length, 1);
  assert.ok(system[0].body.includes(`https://x.test/onboard/${token}`), system[0].body);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM demo_events WHERE kind = 'ordered'"), 1);
});

// ---------------------------------------------------------------- Task 9 review: one email per invoice, whatever fails

// DB whose first statement matching `re` fails (a passing D1 error); everything else is the real fake D1.
function failFirst(DB, re) {
  let failed = false;
  return new Proxy(DB, {
    get(target, prop) {
      if (prop !== "prepare") return Reflect.get(target, prop);
      return (sql) => {
        if (!failed && re.test(sql)) {
          failed = true;
          throw new Error("D1_ERROR: Network connection lost.");
        }
        return target.prepare(sql);
      };
    },
  });
}

test("card failed: an error after the email was queued doesn't email them twice on Stripe's retry", async () => {
  const DB = await fulfilled();
  // the email is queued, then closing the system-mailbox todo fails: the event answers 500 and Stripe retries it
  const flaky = failFirst(DB, /UPDATE todos SET status = 'done'/);
  const res = await deliver(flaky, event("evt_f1", "invoice.payment_failed", failedInvoice()), { now: DEC_18_NOW });
  assert.equal(res.status, 500);
  const retry = await deliver(flaky, event("evt_f1", "invoice.payment_failed", failedInvoice()), { now: DEC_18_NOW });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.result, "marked payment failed, client emailed");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE subject = 'Your Aetos Websites payment didn''t go through'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'payment:failed:in_3'"), 1);
});

test("card failed, no mailbox: an error before the title is fixed is put right on Stripe's retry", async () => {
  const DB = await fulfilled();
  await DB.prepare("DELETE FROM mailboxes").run();
  const flaky = failFirst(DB, /UPDATE todos SET title/);
  const res = await deliver(flaky, event("evt_f1", "invoice.payment_failed", failedInvoice()), { now: DEC_18_NOW });
  assert.equal(res.status, 500);
  const retry = await deliver(flaky, event("evt_f1", "invoice.payment_failed", failedInvoice()), { now: DEC_18_NOW });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.result, "marked payment failed (no mailbox: Nik sends the email)");
  const payment = await one(DB, "SELECT * FROM todos WHERE dedupe = 'payment:failed:in_3'");
  assert.ok(!payment.title.includes("emailed a link"), payment.title); // never says they were emailed
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'setup:client-mail:cl_cs_1:payment-failed:in_3'"), 1);
});

test("card failed again: what Setup shows as the last Stripe message never claims an email that didn't go", async () => {
  const DB = await fulfilled();
  await DB.prepare("UPDATE client_links SET email = NULL").run();
  await deliver(DB, event("evt_f1", "invoice.payment_failed", failedInvoice()), { now: DEC_18_NOW });
  const again = await deliver(DB, event("evt_f2", "invoice.payment_failed", failedInvoice({ attempt_count: 2 })),
    { now: new Date("2026-12-21T10:05:00Z") });
  assert.equal(again.status, 200);
  assert.ok(!/emailed/.test(again.json.result), again.json.result);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system' AND subject LIKE 'Your Aetos%'"), 0);
});

test("card failed, cancellation, refund and abandoned checkout each stay well inside D1's 50 queries", async () => {
  const DB = await fulfilled();
  await insert(DB, "leads", {
    place_id: "p2", name: "Green Leaf", trade: "landscaper", search_town: "Leeds",
    first_seen_at: "2026-09-01T09:00:00Z", updated_at: "2026-09-01T09:00:00Z",
  });
  const events = [
    event("evt_q1", "invoice.payment_failed", failedInvoice()),
    event("evt_q2", "customer.subscription.deleted", { id: "sub_1", ended_at: at("2027-01-15T10:00:00Z") }),
    event("evt_q3", "charge.refunded", { id: "ch_9", customer: "cus_1", amount_refunded: 24900 }),
    event("evt_q4", "checkout.session.expired", { id: "cs_2", metadata: { place_id: "p2" } }),
  ];
  for (const evt of events) {
    const c = countingDB(DB);
    const res = await deliver(c.DB, evt, { now: DEC_18_NOW });
    assert.equal(res.status, 200, evt.type);
    assert.ok(c.used() <= 25, `${evt.type}: used ${c.used()} D1 statements`);
  }
});

// Review fix: the free days are counted from when they paid, as Stripe counts them (the subscription is made when
// the checkout completes), not from when the payment page was opened (session.created, up to 24 hours earlier).
test("checkout webhook: the first charge is Stripe's trial_end; paid_on is when they paid, not when the page opened", async () => {
  const opened = Date.parse("2026-11-01T23:50:00Z") / 1000; // Sun 23:50 GMT: the weekend page, the session made
  const paidAt = new Date("2026-11-02T00:20:00Z"); // Mon 00:20: paid inside the 30-minute grace
  const weekend = session({ created: opened, amount_total: 175000, metadata: { ...session().metadata, weekend: "1" } });
  const paidEvent = (id) => ({ ...event(id, "checkout.session.completed", weekend), created: Math.floor(paidAt / 1000) });

  // Stripe answers: its own trial_end is used, whatever the arithmetic says
  const DB = await seed();
  const trialEnd = Date.parse("2027-01-31T00:20:05Z") / 1000;
  const stripe = fakeStripe({ "GET subscriptions/sub_1": { id: "sub_1", object: "subscription", trial_end: trialEnd } });
  const res = await deliver(DB, paidEvent("evt_wk"), { fetchImpl: stripe.fetchImpl, now: paidAt });
  assert.equal(res.json.result, "client added: cl_cs_1");
  assert.deepEqual(stripe.calls.map((c) => `${c.method} ${c.path}`), ["GET subscriptions/sub_1"]);
  assert.equal((await one(DB, "SELECT paid_on FROM clients")).paid_on, "2026-11-02");
  assert.equal((await one(DB, "SELECT paid_on FROM payments WHERE id = 'build:cus_1'")).paid_on, "2026-11-02");
  const body = (await one(DB, "SELECT body FROM messages WHERE kind = 'system'")).body;
  assert.ok(body.includes("The first £249 is taken on Sunday 31 January 2027"), body);

  // Stripe can't be asked (down, or no such route): the event's own time + 90 days, the same day Stripe charges
  const B = await seed();
  await deliver(B, paidEvent("evt_wk"), { now: new Date(paidAt.getTime() + 3 * 3600_000) });
  assert.equal((await one(B, "SELECT paid_on FROM clients")).paid_on, "2026-11-02");
  const fallback = (await one(B, "SELECT body FROM messages WHERE kind = 'system'")).body;
  assert.ok(fallback.includes("The first £249 is taken on Sunday 31 January 2027"), fallback);
});
