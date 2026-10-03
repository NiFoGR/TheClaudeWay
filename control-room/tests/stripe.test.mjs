// Stripe webhooks → database. Run: node --test control-room/tests/stripe.test.mjs
// Uses an in-memory SQLite database with the real schema, behind a tiny D1-shaped wrapper.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SCHEMA } from "../functions/_lib/schema.js";
import { summarise } from "../functions/_lib/money.js";
import { encode, verifySignature } from "../functions/_lib/stripe.js";
import { handleEvent } from "../functions/_lib/stripe-events.js";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    _run: () => db.prepare(sql).run(...args),
  });
  const D1 = { prepare: (sql) => stmt(sql), batch: async (list) => list.map((s) => s._run()), raw: db };
  SCHEMA.forEach((s) => db.exec(s));
  return D1;
}

const env = {}; // no key: fetching Stripe fees is skipped gracefully
const ts = (iso) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / 1000);

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

test("a Full Package checkout becomes a client, marks the lead won, and invoices become real income", async () => {
  const DB = fakeD1();
  DB.raw.exec(`INSERT INTO leads (place_id, name, trade, search_town, first_seen_at, updated_at) VALUES ('p1', 'Smith Roofing', 'roofer', 'Leeds', 'x', 'x')`);
  const session = { id: "cs_1", mode: "subscription", customer: "cus_1", subscription: "sub_1", created: ts("2026-10-01"), amount_total: 195000,
    metadata: { aetos_package: "full" }, custom_fields: [{ key: "business", text: { value: "smith roofing" } }],
    customer_details: { name: "John Smith", email: "john@smith.co.uk", phone: "+447700900000" } };
  // the first invoice can arrive before the checkout event
  const firstInvoice = { id: "in_1", customer: "cus_1", amount_paid: 195000, created: ts("2026-10-01"), status_transitions: { paid_at: ts("2026-10-01") },
    lines: { data: [{ type: "invoiceitem", amount: 195000 }, { type: "subscription", amount: 0 }] } };
  await handleEvent(DB, env, { type: "invoice.paid", data: { object: firstInvoice } });
  assert.match(await handleEvent(DB, env, { type: "checkout.session.completed", data: { object: session } }), /client added/);
  assert.equal(await handleEvent(DB, env, { type: "checkout.session.completed", data: { object: session } }), "already recorded");

  const client = DB.raw.prepare("SELECT * FROM clients").get();
  assert.equal(client.name, "smith roofing");
  assert.equal(client.place_id, "p1");
  assert.equal(client.free_days, 60);
  assert.equal(DB.raw.prepare("SELECT status FROM leads").get().status, "won");

  // a monthly payment, a failure, then cancellation
  await handleEvent(DB, env, { type: "invoice.payment_failed", data: { object: { customer: "cus_1", created: ts("2026-11-30") } } });
  assert.equal(DB.raw.prepare("SELECT failed_on FROM client_links").get().failed_on, "2026-11-30");
  const monthly = { id: "in_2", customer: "cus_1", amount_paid: 24900, created: ts("2026-12-01"), status_transitions: { paid_at: ts("2026-12-01") },
    lines: { data: [{ type: "subscription", amount: 24900 }] } };
  await handleEvent(DB, env, { type: "invoice.paid", data: { object: monthly } });
  await handleEvent(DB, env, { type: "invoice.paid", data: { object: monthly } }); // Stripe retries: no double count
  assert.equal(DB.raw.prepare("SELECT failed_on FROM client_links").get().failed_on, null);
  await handleEvent(DB, env, { type: "customer.subscription.deleted", data: { object: { id: "sub_1", ended_at: ts("2027-01-15") } } });
  assert.equal(DB.raw.prepare("SELECT cancelled_on FROM clients").get().cancelled_on, "2027-01-15");

  const payments = DB.raw.prepare("SELECT * FROM payments ORDER BY paid_on").all();
  assert.deepEqual(payments.map((p) => [p.category, p.amount_pence, p.name]), [["Website builds", 195000, "Stripe payment"], ["Monthly retainers", 24900, "smith roofing"]]);

  // the Money page counts what Stripe received, not the schedule, for card clients
  const clients = DB.raw.prepare("SELECT clients.*, l.stripe_customer, l.failed_on FROM clients JOIN client_links l ON l.client_id = clients.id").all();
  const s = summarise({ clients, payments, today: "2026-12-10" });
  assert.equal(s.allTime.in, 195000 + 24900);
  assert.equal(s.upcoming[0].date, "2026-12-30"); // next month still forecast (trial ended 30 Nov)…
  const after = summarise({ clients, payments, today: "2027-02-01" });
  assert.equal(after.allTime.in, 195000 + 24900); // …and nothing after they cancelled
});

test("Website Only pays once with no invoice: recorded from the checkout", async () => {
  const DB = fakeD1();
  await handleEvent(DB, env, { type: "checkout.session.completed", data: { object: {
    id: "cs_2", mode: "payment", customer: "cus_2", created: ts("2026-10-02"), amount_total: 175000,
    metadata: { aetos_package: "website" }, custom_fields: [], customer_details: { name: "Ann's Removals" } } } });
  assert.equal(DB.raw.prepare("SELECT monthly_pence FROM clients").get().monthly_pence, 0);
  assert.equal(DB.raw.prepare("SELECT amount_pence FROM payments").get().amount_pence, 175000);
});

test("payments from other Stripe products are ignored", async () => {
  const DB = fakeD1();
  assert.match(await handleEvent(DB, env, { type: "checkout.session.completed", data: { object: { id: "cs_3", customer: "c", metadata: {} } } }), /ignored/);
});
