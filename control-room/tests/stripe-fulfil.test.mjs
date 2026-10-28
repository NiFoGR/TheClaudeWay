// A paid checkout (fulfilCheckout): the client, their Stripe links, the build payment, the onboarding row and the
// welcome email, made once however often the webhook and the thanks page run it. Plus closeLeadTodos.
// Run: node --test control-room/tests/stripe-fulfil.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { isSuppressed, suppress } from "../functions/_lib/prospects.js";
import { fulfilCheckout } from "../functions/_lib/stripe-events.js";
import { addTodo, closeLeadTodos, closeTodos } from "../functions/_lib/todo.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const NOW = new Date("2026-10-19T10:01:00Z"); // Mon 11:01 UK (BST)
const CREATED = Date.parse("2026-10-19T10:00:00Z") / 1000;

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

const all = async (DB, sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results;
const one = async (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const count = async (DB, sql, ...args) => (await one(DB, sql, ...args)).n;

function session(extra = {}) {
  return {
    id: "cs_1", mode: "subscription", payment_status: "paid", customer: "cus_1", subscription: "sub_1",
    amount_total: 195000, created: CREATED, client_reference_id: "p1",
    customer_details: { email: "mark@smithroofing.co.uk", phone: "+447700900000" },
    metadata: { place_id: "p1", package: "full", weekend: "0", slug: "smith-roofing", origin: "https://x.test" },
    ...extra,
  };
}

async function seed({ mailbox = true } = {}) {
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
    greet_name: "Mark", next_followup_at: "2026-10-20T09:00:00Z",
    created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-10T09:00:00Z",
  });
  await insert(DB, "messages", {
    id: "f1", place_id: "p1", direction: "out", kind: "followup", step: 3, author: "system",
    to_addr: "mark@smithroofing.co.uk", subject: "Re: Your site", body: "Just checking in", status: "queued",
    due_at: "2026-10-20T09:00:00Z", created_at: "2026-10-12T09:00:00Z",
  });
  await addTodo(DB, { kind: "hot", title: "Call now: Smith Roofing opened their site 3 times", place_id: "p1", dedupe: "hot:p1:views" });
  if (mailbox) {
    await insert(DB, "mailboxes", {
      id: "mb_sys", address: "hello@aetoswebsites.com", display_name: "Nik", role: "system", started_on: "2026-01-01",
      status: "active", created_at: "2026-01-01T09:00:00Z",
    });
  }
  return DB;
}

test("full package", async () => {
  const DB = await seed();
  const res = await fulfilCheckout(DB, session(), { now: NOW });
  assert.equal(res.status, "ok");
  assert.equal(res.client_id, "cl_cs_1");
  assert.equal(res.created, true);
  assert.equal(res.firstChargeOn, "2026-12-18");
  assert.equal(res.place_id, "p1");
  assert.equal(res.amountPaid, 195000);
  assert.equal(res.terms.key, "full");

  const client = await one(DB, "SELECT * FROM clients");
  assert.equal(client.id, "cl_cs_1");
  assert.equal(client.name, "Smith Roofing");
  assert.equal(client.place_id, "p1");
  assert.equal(client.package, "full");
  assert.equal(client.build_fee_pence, 195000);
  assert.equal(client.monthly_pence, 24900);
  assert.equal(client.free_days, 60);
  assert.equal(client.paid_on, "2026-10-19");
  assert.equal(client.notes, "mark@smithroofing.co.uk · +447700900000");

  const link = await one(DB, "SELECT * FROM client_links");
  assert.equal(link.client_id, "cl_cs_1");
  assert.equal(link.stripe_customer, "cus_1");
  assert.equal(link.stripe_subscription, "sub_1");
  assert.equal(link.email, "mark@smithroofing.co.uk");

  const payments = await all(DB, "SELECT * FROM payments");
  assert.equal(payments.length, 1);
  assert.equal(payments[0].id, "build:cus_1");
  assert.equal(payments[0].amount_pence, 195000);
  assert.equal(payments[0].category, "Website builds");
  assert.equal(payments[0].paid_on, "2026-10-19");

  const onboarding = await one(DB, "SELECT * FROM onboarding");
  assert.equal(onboarding.client_id, "cl_cs_1");
  assert.equal(onboarding.status, "sent");
  assert.match(onboarding.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(res.token, onboarding.token);

  const system = await all(DB, "SELECT * FROM messages WHERE kind = 'system'");
  assert.equal(system.length, 1);
  assert.ok(system[0].body.includes(`https://x.test/onboard/${onboarding.token}`), system[0].body);
  assert.ok(system[0].body.startsWith("Hi Mark,"), system[0].body);
  assert.equal(system[0].to_addr, "mark@smithroofing.co.uk");
  assert.equal(system[0].client_id, "cl_cs_1");
  assert.equal(system[0].author, "system");

  const prospect = await one(DB, "SELECT * FROM prospects WHERE place_id = 'p1'");
  assert.equal(prospect.stage, "won");
  assert.equal(prospect.next_followup_at, null);
  assert.equal((await one(DB, "SELECT status FROM messages WHERE id = 'f1'")).status, "cancelled");
  assert.equal((await one(DB, "SELECT status FROM todos WHERE kind = 'hot'")).status, "done");

  const build = await one(DB, "SELECT * FROM todos WHERE dedupe = 'build:new:cl_cs_1'");
  assert.equal(build.status, "open");
  assert.equal(build.title, "New client: Smith Roofing — onboarding form sent");
  assert.equal(build.link, "/#/money");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM demo_events WHERE kind = 'ordered'"), 1);
  const ordered = await one(DB, "SELECT * FROM demo_events WHERE kind = 'ordered'");
  assert.equal(ordered.slug, "smith-roofing");
  assert.equal(ordered.place_id, "p1");

  // leads is never written
  assert.equal((await one(DB, "SELECT status, updated_at FROM leads")).status, "new");
});

test("fulfil twice", async () => {
  const DB = await seed();
  const first = await fulfilCheckout(DB, session(), { now: NOW });
  const second = await fulfilCheckout(DB, session(), { now: NOW });
  assert.equal(second.status, "ok");
  assert.equal(second.created, false);
  assert.equal(second.token, first.token);
  assert.equal(second.client_id, "cl_cs_1");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM payments"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM demo_events WHERE kind = 'ordered'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM onboarding"), 1);
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe = 'build:new:cl_cs_1'")).status, "open");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE kind = 'build'"), 1);
});

test("weekend metadata", async () => {
  const DB = await seed();
  const res = await fulfilCheckout(DB, session({
    amount_total: 175000, metadata: { ...session().metadata, weekend: "1" },
  }), { now: NOW });
  const client = await one(DB, "SELECT * FROM clients");
  assert.equal(client.package, "weekend");
  assert.equal(client.free_days, 90);
  assert.equal(client.build_fee_pence, 175000);
  assert.equal(client.monthly_pence, 24900);
  assert.equal(res.firstChargeOn, "2027-01-17");
});

test("website package", async () => {
  const DB = await seed();
  const res = await fulfilCheckout(DB, session({
    mode: "payment", subscription: null, amount_total: 175000, metadata: { ...session().metadata, package: "website" },
  }), { now: NOW });
  const client = await one(DB, "SELECT * FROM clients");
  assert.equal(client.package, "website");
  assert.equal(client.monthly_pence, 0);
  assert.equal(client.free_days, 0);
  assert.equal(client.build_fee_pence, 175000);
  assert.equal((await one(DB, "SELECT stripe_subscription FROM client_links")).stripe_subscription, null);
  assert.equal(res.firstChargeOn, null);
  const body = (await one(DB, "SELECT body FROM messages WHERE kind = 'system'")).body;
  assert.ok(!body.includes("monthly plan"), body);
});

test("unpaid ignored", async () => {
  const DB = await seed();
  const res = await fulfilCheckout(DB, session({ payment_status: "unpaid" }), { now: NOW });
  assert.equal(res.status, "ignored");
  for (const table of ["clients", "client_links", "payments", "onboarding", "demo_events"]) {
    assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM ${table}`), 0, table);
  }
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 0);
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "viewed");
  // and not ours (another Stripe product): ignored too
  const other = await fulfilCheckout(DB, session({ metadata: {} }), { now: NOW });
  assert.equal(other.status, "ignored");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 0);
});

test("legacy link", async () => {
  const DB = await seed();
  const res = await fulfilCheckout(DB, session({ metadata: { aetos_package: "weekend" }, client_reference_id: "p1" }), { now: NOW });
  assert.equal(res.status, "ok");
  const client = await one(DB, "SELECT * FROM clients");
  assert.equal(client.package, "weekend");
  assert.equal(client.place_id, "p1");
  assert.equal(client.free_days, 90);
  // no origin in a legacy link's metadata: the onboarding link uses the public site
  const body = (await one(DB, "SELECT body FROM messages WHERE kind = 'system'")).body;
  assert.ok(body.includes(`https://aetoswebsites.com/onboard/${res.token}`), body);
});

test("no prospect row", async () => {
  const DB = await seed();
  await DB.prepare("DELETE FROM prospects").run();
  await fulfilCheckout(DB, session(), { now: NOW });
  const prospect = await one(DB, "SELECT * FROM prospects WHERE place_id = 'p1'");
  assert.equal(prospect.stage, "won");
  assert.equal(prospect.email, "mark@smithroofing.co.uk");
  assert.equal(prospect.greet_name, null);
  // no greet name: "Hi,"
  const body = (await one(DB, "SELECT body FROM messages WHERE kind = 'system'")).body;
  assert.ok(body.startsWith("Hi,\n"), body);
});

test("lost then paid", async () => {
  const DB = await seed();
  await DB.prepare("UPDATE prospects SET stage = 'lost', lost_reason = 'not_interested' WHERE place_id = 'p1'").run();
  await fulfilCheckout(DB, session(), { now: NOW });
  const prospect = await one(DB, "SELECT * FROM prospects WHERE place_id = 'p1'");
  assert.equal(prospect.stage, "won");
  assert.equal(prospect.lost_reason, null);
});

test("opt-out lifted on payment", async () => {
  const DB = await seed();
  await suppress(DB, "mark@smithroofing.co.uk", "email", "opt_out", NOW);
  assert.equal(await isSuppressed(DB, "mark@smithroofing.co.uk"), "opt_out");
  await fulfilCheckout(DB, session({ customer_details: { email: "Mark@SmithRoofing.co.uk", phone: null } }), { now: NOW });
  assert.equal(await isSuppressed(DB, "mark@smithroofing.co.uk"), null);
  const welcome = await one(DB, "SELECT status FROM messages WHERE kind = 'system'");
  assert.equal(welcome.status, "queued");
});

test("waiting mail handed to Nik", async () => {
  const DB = await seed();
  await insert(DB, "messages", {
    id: "m1", place_id: "p1", direction: "in", kind: "inbound", author: "them", from_addr: "mark@smithroofing.co.uk",
    subject: "Re: Your site", body: "How much is it?", status: "received", received_at: "2026-10-19T09:00:00Z",
    class: "human", needs_reply: 1, created_at: "2026-10-19T09:00:00Z",
  });
  await fulfilCheckout(DB, session(), { now: NOW });
  const m1 = await one(DB, "SELECT * FROM messages WHERE id = 'm1'");
  assert.equal(m1.needs_reply, 0);
  assert.equal(m1.client_id, "cl_cs_1");
  const todo = await one(DB, "SELECT * FROM todos WHERE dedupe = 'client-mail:m1'");
  assert.ok(todo, "client-mail todo");
  assert.equal(todo.status, "open");
});

test("paid twice", async () => {
  const DB = await seed();
  await insert(DB, "clients", {
    id: "cl_other", name: "Smith Roofing", place_id: "p1", package: "full", build_fee_pence: 195000,
    monthly_pence: 24900, free_days: 60, paid_on: "2026-10-19", created_at: "2026-10-19T09:30:00Z",
  });
  await fulfilCheckout(DB, session(), { now: NOW });
  const todo = await one(DB, "SELECT * FROM todos WHERE dedupe = 'payment:double:p1:cs_1'");
  assert.ok(todo, "paid twice todo");
  assert.equal(todo.kind, "payment");
  assert.equal(todo.title, "Smith Roofing paid twice: refund one in Stripe");
  assert.equal(todo.link, "/#/money");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 2); // both recorded: the money was taken
});

test("paid once: no paid-twice todo; a cancelled earlier client doesn't count", async () => {
  const DB = await seed();
  await insert(DB, "clients", {
    id: "cl_old", name: "Smith Roofing", place_id: "p1", package: "full", build_fee_pence: 195000,
    monthly_pence: 24900, free_days: 60, paid_on: "2025-10-19", cancelled_on: "2026-01-01", created_at: "2025-10-19T09:30:00Z",
  });
  await fulfilCheckout(DB, session(), { now: NOW });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE kind = 'payment'"), 0);
});

test("paid twice: only the later session files the todo, however often either runs again", async () => {
  const DB = await seed();
  await fulfilCheckout(DB, session(), { now: NOW });
  const later = new Date(NOW.getTime() + 60_000);
  await fulfilCheckout(DB, session({ id: "cs_2", customer: "cus_2", subscription: "sub_2" }), { now: later });
  // the thanks page or a late webhook runs the first session again
  await fulfilCheckout(DB, session(), { now: new Date(NOW.getTime() + 120_000) });
  await fulfilCheckout(DB, session({ id: "cs_2", customer: "cus_2", subscription: "sub_2" }), { now: later });
  const doubles = await all(DB, "SELECT dedupe FROM todos WHERE kind = 'payment'");
  assert.deepEqual(doubles.map((t) => t.dedupe), ["payment:double:p1:cs_2"]);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM payments"), 2); // both recorded: the money was taken
});

test("a run that fails before the welcome email still sends it on the retry", async () => {
  const DB = await seed();
  let failed = false;
  const flaky = new Proxy(DB, {
    get(target, prop) {
      if (prop !== "prepare") return Reflect.get(target, prop);
      return (sql) => {
        if (!failed && sql.includes("SET needs_reply = 0, handled_at")) {
          failed = true;
          throw new Error("D1_ERROR: Network connection lost.");
        }
        return target.prepare(sql);
      };
    },
  });
  await assert.rejects(() => fulfilCheckout(flaky, session(), { now: NOW }), /Network connection lost/);
  const res = await fulfilCheckout(flaky, session(), { now: NOW }); // Stripe resends after the 500
  assert.equal(res.created, true);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM onboarding"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM clients"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM payments"), 1);
});

test("nothing to pay now (no_payment_required): no payment row, the email doesn't say £0", async () => {
  const DB = await seed();
  const res = await fulfilCheckout(DB, session({ payment_status: "no_payment_required", amount_total: 0 }), { now: NOW });
  assert.equal(res.status, "ok");
  assert.equal(res.amountPaid, 0);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM payments"), 0);
  assert.equal((await one(DB, "SELECT build_fee_pence FROM clients")).build_fee_pence, 0);
  const body = (await one(DB, "SELECT body FROM messages WHERE kind = 'system'")).body;
  assert.ok(body.includes("Thanks for ordering. Your payment has gone through."), body);
  assert.ok(!body.includes("£0"), body);
});

test("no mailbox", async () => {
  const DB = await seed({ mailbox: false });
  const res = await fulfilCheckout(DB, session(), { now: NOW });
  assert.equal(res.created, true);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 0);
  const todo = await one(DB, "SELECT * FROM todos WHERE dedupe = 'setup:welcome:cl_cs_1'");
  assert.ok(todo, "welcome todo");
  assert.equal(todo.status, "open");
  assert.equal(todo.kind, "setup");
  assert.ok(todo.draft.includes(`https://x.test/onboard/${res.token}`), todo.draft);
  // the whole email is in the detail too, so the Todo board (which shows a setup todo's detail) shows the link
  assert.ok(todo.detail.includes(`https://x.test/onboard/${res.token}`), todo.detail);
});

test("closeLeadTodos closes the lead's open todos except the kinds given", async () => {
  const DB = fakeD1();
  await addTodo(DB, { kind: "hot", title: "Call", place_id: "p1", dedupe: "hot:p1:a" });
  await addTodo(DB, { kind: "pick", title: "Check back", place_id: "p1" });
  await addTodo(DB, { kind: "payment", title: "Card failed", place_id: "p1", dedupe: "payment:failed:in_1" });
  await addTodo(DB, { kind: "hot", title: "Other lead", place_id: "p2", dedupe: "hot:p2:a" });
  // about the client, not the lead (e.g. their email handed to Nik): kept
  await addTodo(DB, { kind: "escalation", title: "Client mail", place_id: "p1", client_id: "cl_1", dedupe: "client-mail:m1" });
  const dismissed = await addTodo(DB, { kind: "hot", title: "Dismissed", place_id: "p1", dedupe: "hot:p1:b" });
  await DB.prepare("UPDATE todos SET status = 'dismissed' WHERE id = ?").bind(dismissed).run();

  assert.equal(await closeLeadTodos(DB, "p1", { exceptKinds: ["build", "payment"] }), 2);
  const rows = await all(DB, "SELECT title, status, dedupe, done_at FROM todos ORDER BY title");
  const by = Object.fromEntries(rows.map((r) => [r.title, r]));
  assert.equal(by.Call.status, "done");
  assert.ok(by.Call.done_at);
  assert.ok(by.Call.dedupe.startsWith("hot:p1:a@"), by.Call.dedupe); // the dedupe is freed, as closeTodos does
  assert.equal(by["Check back"].status, "done");
  assert.equal(by["Check back"].dedupe, null);
  assert.equal(by["Card failed"].status, "open");
  assert.equal(by["Other lead"].status, "open");
  assert.equal(by.Dismissed.status, "dismissed");
  assert.equal(by["Client mail"].status, "open");
  // the same problem can come back as a new todo
  assert.ok(await addTodo(DB, { kind: "hot", title: "Call again", place_id: "p1", dedupe: "hot:p1:a" }));
  // nothing open left to close (bar the new one and the kept kind)
  assert.equal(await closeLeadTodos(DB, "p1", { exceptKinds: ["hot", "payment"] }), 0);
  assert.equal(await closeLeadTodos(DB, "p1"), 2);
  await assert.rejects(() => closeLeadTodos(DB, ""), /place_id/);
});

// ---------------------------------------------------------------- review fixes: the welcome email is never lost, re-runs

// A D1 whose `prepare` runs `hook(sql)` first: it may throw (a passing D1 error) or return a stand-in statement.
function hooked(DB, hook) {
  return new Proxy(DB, {
    get(target, prop) {
      if (prop !== "prepare") return Reflect.get(target, prop);
      return (sql) => hook(sql) ?? target.prepare(sql);
    },
  });
}

test("a welcome email that fails to queue is sent on the retry, once, with one ordered event", async () => {
  const DB = await seed();
  let failed = false;
  const flaky = hooked(DB, (sql) => {
    if (!failed && /INSERT INTO messages/.test(sql)) {
      failed = true;
      throw new Error("D1_ERROR: Network connection lost.");
    }
  });
  await assert.rejects(() => fulfilCheckout(flaky, session(), { now: NOW }), /Network connection lost/);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM onboarding"), 1); // the row was made before the send failed
  const token = (await one(DB, "SELECT token FROM onboarding")).token;

  const retry = await fulfilCheckout(flaky, session(), { now: NOW }); // Stripe resends after the 500
  assert.equal(retry.created, true);
  assert.equal(retry.token, token); // the link already shown (thanks page) stays valid
  const system = await all(DB, "SELECT * FROM messages WHERE kind = 'system'");
  assert.equal(system.length, 1);
  assert.equal(system[0].id, "welcome:cl_cs_1");
  assert.ok(system[0].body.includes(`https://x.test/onboard/${token}`), system[0].body);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM demo_events WHERE kind = 'ordered'"), 1);

  const third = await fulfilCheckout(flaky, session(), { now: NOW });
  assert.equal(third.created, false);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM demo_events WHERE kind = 'ordered'"), 1);
});

test("an ordered event that fails to store is stored on the retry, once", async () => {
  const DB = await seed();
  let failed = false;
  const flaky = hooked(DB, (sql) => {
    if (!failed && /INSERT INTO demo_events/.test(sql)) {
      failed = true;
      throw new Error("D1_ERROR: Network connection lost.");
    }
  });
  await assert.rejects(() => fulfilCheckout(flaky, session(), { now: NOW }), /Network connection lost/);
  await fulfilCheckout(flaky, session(), { now: NOW });
  await fulfilCheckout(flaky, session(), { now: NOW });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM demo_events WHERE kind = 'ordered'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 1);
});

test("two runners racing: the second's welcome insert is 'already queued', not an error", async () => {
  const DB = await seed();
  await fulfilCheckout(DB, session(), { now: NOW });
  // the other runner checked before this one's email was queued: it still thinks the welcome is needed
  const racing = hooked(DB, (sql) => (sql.includes("FROM messages WHERE id = ?1")
    ? { bind: () => ({ first: async () => ({ done: 0 }) }) }
    : null));
  const res = await fulfilCheckout(racing, session(), { now: NOW });
  assert.equal(res.status, "ok");
  assert.equal(res.created, false);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM demo_events WHERE kind = 'ordered'"), 1);
});

test("no mailbox: a re-run files no second welcome todo", async () => {
  const DB = await seed({ mailbox: false });
  await fulfilCheckout(DB, session(), { now: NOW });
  const again = await fulfilCheckout(DB, session(), { now: NOW });
  assert.equal(again.created, false);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'setup:welcome:%'"), 1);
  // a mailbox added since: the welcome already went to Nik as a todo, so nothing is queued now
  await insert(DB, "mailboxes", {
    id: "mb_sys", address: "hello@aetoswebsites.com", display_name: "Nik", role: "system", started_on: "2026-01-01",
    status: "active", created_at: "2026-01-01T09:00:00Z",
  });
  await fulfilCheckout(DB, session(), { now: NOW });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"), 0);
});

test("a re-run after the form is submitted files no new 'form sent' todo and closes no newer lead todo", async () => {
  const DB = await seed();
  await fulfilCheckout(DB, session(), { now: NOW });
  await addTodo(DB, { kind: "hot", title: "Call them about the logo", place_id: "p1", dedupe: "hot:p1:after" });
  // stage 10: the form comes in
  await DB.prepare("UPDATE onboarding SET status = 'submitted' WHERE client_id = 'cl_cs_1'").run();
  await closeTodos(DB, "build:new:cl_cs_1");
  // the thanks page is reloaded, or Stripe redelivers under a new event id
  await fulfilCheckout(DB, session(), { now: NOW });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'build:new:cl_cs_1' AND status = 'open'"), 0);
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe = 'hot:p1:after'")).status, "open");
});

test("paying keeps Nik's open conversations and calls; sales todos close", async () => {
  const DB = await seed();
  await addTodo(DB, { kind: "escalation", title: "Mark asked a question", place_id: "p1", dedupe: "escalation:m1" });
  await addTodo(DB, { kind: "call_time", title: "Confirm a time with Mark", place_id: "p1", dedupe: "call_time:m2" });
  await addTodo(DB, { kind: "call", title: "Call Mark at 2pm", place_id: "p1", dedupe: "call:c1" });
  await addTodo(DB, { kind: "escalation", title: "Mark wrote back after opting out", place_id: "p1", dedupe: "optout-mail:m3" });
  await fulfilCheckout(DB, session(), { now: NOW });
  for (const dedupe of ["escalation:m1", "call_time:m2", "call:c1", "optout-mail:m3"]) {
    const t = await one(DB, "SELECT status FROM todos WHERE dedupe = ?", dedupe);
    assert.ok(t, `${dedupe} keeps its dedupe`);
    assert.equal(t.status, "open", dedupe);
  }
  assert.equal((await one(DB, "SELECT status FROM todos WHERE kind = 'hot'")).status, "done");
});
