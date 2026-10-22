// The inbound tick step (db): link, store, apply bounces and opt-outs, pause on 2 bounces. Also countingDB.
// Run: node --test control-room/tests/inbound-db.test.mjs
// The mail is Task 14's fixtures (tests/fixtures/mail/*.eml) with the From (and where needed the Message-ID) changed,
// saved the way the relay saves it: the lower-cased top-level headers as JSON, and the raw MIME.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { BOUNCE_PAUSE, inboundStep, processInbound } from "../functions/_lib/mail/inbound-db.js";
import { setSetting } from "../functions/_lib/settings.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const NOW = new Date("2026-10-21T10:00:00Z");
const EARLIER = "2026-10-19T07:01:03Z";
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const at = (minutes) => iso(new Date(NOW.getTime() + minutes * 60000));

const DIR = new URL("./fixtures/mail/", import.meta.url);
const fixture = (name) => readFileSync(new URL(name, DIR), "utf8");

// The headers the relay stores: the top-level header block through a Headers object (keys lower-cased, a repeated
// header joined with ", "), as JSON. The same as inbound.test.mjs.
function relayHeaders(raw) {
  const block = raw.split(/\r?\n\r?\n/)[0];
  const h = new Headers();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return JSON.stringify(Object.fromEntries(h));
}

// Replace (or, with value null, remove) a header of the top-level block, folded lines included (any case).
function setHeader(raw, name, value) {
  const end = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, end);
  const re = new RegExp(`^${name}:[^\\r\\n]*(?:\\r\\n[ \\t][^\\r\\n]*)*(?:\\r\\n)?`, "im");
  assert.match(head + "\r\n", re, `${name} header`);
  const next = (head + "\r\n").replace(re, value === null ? "" : `${name}: ${value}\r\n`);
  return next.slice(0, -2) + raw.slice(end);
}

// A fixture as it arrives from someone else: a new From, and a new Message-ID when asked.
function mail(name, { from, messageId, dropThread = false } = {}) {
  let raw = fixture(name);
  if (from) raw = setHeader(raw, "From", from);
  if (messageId) raw = setHeader(raw, "Message-ID", messageId); // also matches Message-Id
  if (dropThread) raw = setHeader(setHeader(raw, "In-Reply-To", null), "References", null);
  return raw;
}

let rawSeq = 0;
async function addRaw(DB, raw, { received_at = at(-60), headers = relayHeaders(raw), envelope_from = "someone@example.com" } = {}) {
  const id = `raw${String(++rawSeq).padStart(4, "0")}`;
  await DB.prepare("INSERT INTO inbound_raw (id, received_at, envelope_from, envelope_to, headers, raw) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, received_at, envelope_from, "replies@aetos-mail.co.uk", headers, raw)
    .run();
  return id;
}

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

// The step's select of the waiting rows (and nothing else it runs).
const WAITING_SELECT = /^SELECT [\w, ()]+ FROM inbound_raw WHERE processed_at IS NULL/;

const one = (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const all = async (DB, sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results;
const rawRow = (DB, id) => one(DB, "SELECT * FROM inbound_raw WHERE id = ?", id);
const prospect = (DB, id) => one(DB, "SELECT * FROM prospects WHERE place_id = ?", id);
const inbound = (DB) => all(DB, "SELECT * FROM messages WHERE direction = 'in' ORDER BY received_at, created_at");
const suppressions = (DB) => all(DB, "SELECT value, kind, reason FROM suppression ORDER BY value");
const mailbox = (DB, id) => one(DB, "SELECT * FROM mailboxes WHERE id = ?", id);

// p1: emailed, bob@x.com, mailbox m1, follow-ups running; our first email to it is <orig@aetoswebsites.com>.
async function seeded() {
  const DB = fakeD1();
  await insert(DB, "mailboxes", {
    id: "m1", address: "nik@aetoswebsites.com", display_name: "Nik", role: "cold", started_on: "2026-01-01",
    status: "active", created_at: EARLIER,
  });
  await insert(DB, "prospects", {
    place_id: "p1", stage: "emailed", stage_at: EARLIER, email: "bob@x.com", mailbox_id: "m1",
    root_message_id: "<orig@aetoswebsites.com>", first_sent_at: EARLIER, next_followup_at: "2026-10-22T08:00:00Z",
    created_at: EARLIER, updated_at: EARLIER,
  });
  await insert(DB, "messages", {
    id: "out1", place_id: "p1", mailbox_id: "m1", direction: "out", kind: "first", author: "nik", to_addr: "bob@x.com",
    from_addr: "nik@aetoswebsites.com", subject: "Your new website, Bob", body: "Hi Bob", message_id: "<orig@aetoswebsites.com>",
    status: "sent", due_at: EARLIER, sent_at: EARLIER, created_at: EARLIER,
  });
  return DB;
}

const seedWon = (DB) => insert(DB, "prospects", {
  place_id: "p2", stage: "won", stage_at: EARLIER, email: "carol@x.com", mailbox_id: "m1", created_at: EARLIER, updated_at: EARLIER,
});

// Client c1 (no lead behind it), reachable at dave@client.com.
async function seedClient(DB) {
  await insert(DB, "clients", {
    id: "c1", name: "Dave's Vans", place_id: null, package: "full", build_fee_pence: 195000, monthly_pence: 24900,
    free_days: 60, paid_on: "2026-10-01", created_at: EARLIER,
  });
  await insert(DB, "client_links", { client_id: "c1", stripe_customer: "cus_1", email: "Dave@Client.com" });
}

const GMAIL_FROM_BOB = mail("gmail-reply.eml", { from: "Bob Harris <bob@x.com>" });

// --- Task 15, Step 1 -----------------------------------------------------------------------------------------------

test("Gmail reply from bob: stored as a human reply on p1, the prospect replied, the raw row done", async () => {
  const DB = await seeded();
  const raw = await addRaw(DB, GMAIL_FROM_BOB, { received_at: "2026-10-21T08:14:23Z" });
  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });

  const [m] = await inbound(DB);
  assert.equal(m.direction, "in");
  assert.equal(m.kind, "inbound");
  assert.equal(m.author, "them");
  assert.equal(m.status, "received");
  assert.equal(m.class, "human");
  assert.equal(m.needs_reply, 1);
  assert.equal(m.place_id, "p1");
  assert.equal(m.mailbox_id, "m1");
  assert.equal(m.client_id, null);
  assert.equal(m.from_addr, "bob@x.com");
  assert.equal(m.to_addr, "nik@aetoswebsites.com");
  assert.equal(m.subject, "Re: Your new website, Bob");
  assert.equal(m.message_id, "<CAJx7Lk2bPq0vN=Ze4tX1+R8mGHu3sYw-Fd5kLzQ9aE2oWcVb7g@mail.gmail.com>");
  assert.equal(m.in_reply_to, "<orig@aetoswebsites.com>");
  assert.equal(m.refs, "<orig@aetoswebsites.com>");
  assert.match(m.body, /^Hi Nik,\n\nHad a look at the site/);
  assert.doesNotMatch(m.body, /wrote:|^>/m);
  assert.equal(m.received_at, "2026-10-21T08:14:23Z");
  assert.equal(m.created_at, iso(NOW));

  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "replied");
  assert.equal(p.last_inbound_at, "2026-10-21T08:14:23Z");

  const r = await rawRow(DB, raw);
  assert.equal(r.outcome, "human");
  assert.equal(r.processed_at, iso(NOW));
  assert.deepEqual(await all(DB, "SELECT id FROM todos"), []); // a linked reply is Claude's, not a todo
});

test("the same Message-ID a second time is a duplicate and nothing more is stored", async () => {
  const DB = await seeded();
  await addRaw(DB, GMAIL_FROM_BOB, { received_at: at(-30) });
  await processInbound(DB, NOW);
  const again = await addRaw(DB, GMAIL_FROM_BOB, { received_at: at(-20) }); // forwarded and direct: the same email
  assert.deepEqual(await processInbound(DB, NOW), { duplicate: 1 });
  assert.equal((await rawRow(DB, again)).outcome, "duplicate");
  assert.equal((await rawRow(DB, again)).processed_at, iso(NOW));
  assert.equal((await inbound(DB)).length, 1);
});

test("no-thanks from bob: suppressed as opt_out, p1 lost (opt_out) with follow-ups stopped", async () => {
  const DB = await seeded();
  await insert(DB, "messages", {
    id: "fu1", place_id: "p1", mailbox_id: "m1", direction: "out", kind: "followup", author: "system", to_addr: "bob@x.com",
    body: "Hi Bob, just checking", status: "queued", due_at: "2026-10-22T08:00:00Z", created_at: EARLIER,
  });
  const raw = await addRaw(DB, mail("no-thanks.eml", { from: "Bob <Bob@X.com>" }));
  assert.deepEqual(await processInbound(DB, NOW), { opt_out: 1 });

  assert.deepEqual(await suppressions(DB), [{ value: "bob@x.com", kind: "email", reason: "opt_out" }]);
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "lost");
  assert.equal(p.lost_reason, "opt_out");
  assert.equal(p.next_followup_at, null);
  assert.equal((await one(DB, "SELECT status FROM messages WHERE id = 'fu1'")).status, "cancelled");
  const [m] = await inbound(DB);
  assert.equal(m.class, "opt_out");
  assert.equal(m.needs_reply, 0);
  assert.equal(m.place_id, "p1");
  assert.equal((await rawRow(DB, raw)).outcome, "opt_out");
});

test("no-thanks from a won prospect (carol): handled as human, no suppression, p2 stays won", async () => {
  const DB = await seeded();
  await seedWon(DB);
  const raw = await addRaw(DB, mail("no-thanks.eml", { from: "Carol <carol@x.com>" }));
  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });
  assert.equal((await rawRow(DB, raw)).outcome, "human");
  assert.deepEqual(await suppressions(DB), []);
  const p2 = await prospect(DB, "p2");
  assert.equal(p2.stage, "won");
  assert.equal(p2.lost_reason, null);
  const [m] = await inbound(DB);
  assert.equal(m.class, "human"); // stage 7's hook reads class = 'human'
  assert.equal(m.place_id, "p2");
});

test("a human email from a client's address only: outcome client, client_id set, a client todo; their no thanks too", async () => {
  const DB = await seeded();
  await seedClient(DB);
  const raw = await addRaw(DB, mail("outlook-qp.eml", { from: "Dave <dave@client.com>" }), { received_at: at(-30) });
  assert.deepEqual(await processInbound(DB, NOW), { client: 1 });
  assert.equal((await rawRow(DB, raw)).outcome, "client");
  const [m] = await inbound(DB);
  assert.equal(m.client_id, "c1");
  assert.equal(m.needs_reply, 0);
  assert.equal(m.place_id, null);
  assert.equal(m.class, "human");
  const todo = await one(DB, "SELECT * FROM todos WHERE dedupe = ?", `escalation:client:${m.id}`);
  assert.ok(todo, "the client todo");
  assert.equal(todo.status, "open");
  assert.equal(todo.kind, "escalation");
  assert.equal(todo.title, "Email from your client: dave@client.com");
  assert.equal(todo.client_id, "c1");
  assert.ok(todo.detail.startsWith("Subject: RE: Your new website, Steve\n\nHi Nik,"), todo.detail);

  const noThanks = await addRaw(DB, mail("no-thanks.eml", { from: "dave@client.com" }), { received_at: at(-20) });
  assert.deepEqual(await processInbound(DB, NOW), { client: 1 });
  assert.equal((await rawRow(DB, noThanks)).outcome, "client");
  assert.deepEqual(await suppressions(DB), []);
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'escalation:client:%'")).n, 2);
});

test("the DSN for <orig@aetoswebsites.com>: nobody@x.com suppressed as a bounce, the row a bounce on m1", async () => {
  const DB = await seeded();
  const raw = await addRaw(DB, fixture("dsn-gmail.eml"));
  assert.deepEqual(await processInbound(DB, NOW), { bounce: 1 });
  assert.equal((await rawRow(DB, raw)).outcome, "bounce");
  assert.deepEqual(await suppressions(DB), [{ value: "nobody@x.com", kind: "email", reason: "bounce" }]);
  const [m] = await inbound(DB);
  assert.equal(m.class, "bounce");
  assert.equal(m.mailbox_id, "m1");
  assert.equal(m.place_id, "p1");
  assert.equal(m.needs_reply, 0);
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "lost");
  assert.equal(p.lost_reason, "bounce");
  assert.equal(p.next_followup_at, null);
  assert.equal((await mailbox(DB, "m1")).status, "active"); // one bounce doesn't pause
});

test("a second hard bounce within 7 days pauses m1; after a Resume one more bounce doesn't pause it again", async () => {
  const DB = await seeded();
  await addRaw(DB, fixture("dsn-gmail.eml"), { received_at: at(-3 * 24 * 60) });
  await processInbound(DB, new Date(at(-3 * 24 * 60)));
  assert.equal((await mailbox(DB, "m1")).status, "active");

  await addRaw(DB, mail("dsn-gmail.eml", { messageId: "<second-dsn@mx.google.com>" }), { received_at: at(-60) });
  assert.deepEqual(await processInbound(DB, new Date(at(-60))), { bounce: 1 });
  const paused = await mailbox(DB, "m1");
  assert.equal(paused.status, "paused");
  assert.ok(paused.paused_reason.startsWith("2 emails bounced in 7 days"), paused.paused_reason);
  assert.equal(paused.paused_reason,
    "2 emails bounced in 7 days (last: nobody@x.com). Check your addresses are real, then press Resume.");

  // Nik presses Resume (Setup → Mailboxes): active again, resumed_at = now.
  await DB.prepare("UPDATE mailboxes SET status = 'active', paused_reason = NULL WHERE id = 'm1'").run();
  await setSetting(DB, "mailbox:m1:resumed_at", iso(NOW));
  await addRaw(DB, mail("dsn-gmail.eml", { messageId: "<third-dsn@mx.google.com>" }), { received_at: iso(NOW) });
  assert.deepEqual(await processInbound(DB, NOW), { bounce: 1 });
  const m1 = await mailbox(DB, "m1");
  assert.equal(m1.status, "active");
  assert.equal(m1.paused_reason, null);
});

test("a human email from stranger@y.com: unknown_sender, needs_reply 0, an open escalation todo", async () => {
  const DB = await seeded();
  const raw = await addRaw(DB, mail("iphone-b64.eml", { from: "Someone <Stranger@Y.com>" }));
  assert.deepEqual(await processInbound(DB, NOW), { unknown_sender: 1 });
  assert.equal((await rawRow(DB, raw)).outcome, "unknown_sender");
  const [m] = await inbound(DB);
  assert.equal(m.needs_reply, 0);
  assert.equal(m.class, "human");
  assert.equal(m.place_id, null);
  assert.equal(m.from_addr, "stranger@y.com");
  const todo = await one(DB, "SELECT * FROM todos WHERE status = 'open'");
  assert.equal(todo.kind, "escalation");
  assert.equal(todo.title, "Email from unknown sender: stranger@y.com");
  assert.equal(todo.dedupe, `escalation:unknown:${m.id}`);
  assert.equal(todo.detail, "Subject: Re: Your new website, Dan\n\n" + m.body.slice(0, 300));
  assert.equal(await prospect(DB, "p1").then((p) => p.stage), "emailed"); // nobody else touched
});

test("a garbage raw gets an error: outcome and processed_at, and the next email is still handled", async () => {
  const DB = await seeded();
  const bad = await addRaw(DB, "\u0000", { headers: "\u0000", received_at: at(-30) });
  const good = await addRaw(DB, GMAIL_FROM_BOB, { received_at: at(-20) });
  assert.deepEqual(await processInbound(DB, NOW), { error: 1, human: 1 });
  const r = await rawRow(DB, bad);
  assert.match(r.outcome, /^error: \S/);
  assert.equal(r.processed_at, iso(NOW));
  assert.equal((await rawRow(DB, good)).outcome, "human");
  assert.equal((await inbound(DB)).length, 1);
});

test("with 12 rows waiting, only 10 are processed (oldest first); the rest wait for the next call", async () => {
  const DB = await seeded();
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const raw = mail("ooo.eml", { messageId: `<ooo-${i}@mail.gmail.com>` });
    ids.push(await addRaw(DB, raw, { received_at: at(-100 + i) }));
  }
  assert.deepEqual(await processInbound(DB, NOW, { maxQueries: 1000 }), { auto: 10 }); // the row limit alone
  for (const [i, id] of ids.entries()) {
    assert.equal((await rawRow(DB, id)).processed_at === null, i >= 10, `row ${i}`);
  }
  assert.deepEqual(await processInbound(DB, NOW), { auto: 2 });
});

test("{limit:50, maxQueries:30} with 20 rows: stops before 20, at most 30 queries plus one row's worth", async () => {
  const stranger = (i) => mail("iphone-b64.eml", { from: `Someone <s${i}@y.com>`, messageId: `<s${i}@btinternet.com>` });
  // One row's worth: the same kind of email, alone.
  const solo = await seeded();
  await addRaw(solo, stranger(99));
  const c1 = countingDB(solo);
  await processInbound(c1.DB, NOW, { limit: 50, maxQueries: 30 });
  const rowWorth = c1.used() - 1; // less the one query that reads the waiting rows
  assert.ok(rowWorth >= 2, `a row took ${rowWorth} queries`);

  const DB = await seeded();
  for (let i = 0; i < 20; i++) await addRaw(DB, stranger(i), { received_at: at(-100 + i) });
  const c = countingDB(DB);
  const counts = await processInbound(c.DB, NOW, { limit: 50, maxQueries: 30 });
  const done = counts.unknown_sender;
  assert.ok(done < 20, `processed ${done}`);
  assert.ok(c.used() >= 30, `stopped early at ${c.used()} queries`); // it only stops once it has made 30
  assert.ok(c.used() <= 30 + rowWorth, `made ${c.used()} queries (one row is ${rowWorth})`);
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM inbound_raw WHERE processed_at IS NULL")).n, 20 - done);
  assert.equal((await inbound(DB)).length, done);
});

test("countingDB: two first() calls and a batch of 3 statements give used() === 5", async () => {
  const DB = fakeD1();
  const c = countingDB(DB);
  assert.equal(c.used(), 0);
  await c.DB.prepare("SELECT 1 AS x").first();
  await c.DB.prepare("SELECT ? AS x").bind(2).first("x");
  const ins = c.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  await c.DB.batch([ins.bind("a", "1"), ins.bind("b", "2"), ins.bind("c", "3")]);
  assert.equal(c.used(), 5);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM settings").first("n")), 3); // the batch really ran
});

// --- countingDB ----------------------------------------------------------------------------------------------------

test("countingDB: run() and all() count, a statement can be bound again, results pass through", async () => {
  const DB = fakeD1();
  const c = countingDB(DB);
  const stmt = c.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  const res = await stmt.bind("k1", "v1").run();
  assert.equal(res.meta.changes, 1);
  await stmt.bind("k2", "v2").run();
  const { results } = await c.DB.prepare("SELECT key FROM settings ORDER BY key").all();
  assert.deepEqual(results.map((r) => r.key), ["k1", "k2"]);
  assert.equal(await c.DB.prepare("SELECT value FROM settings WHERE key = ?").bind("k2").first("value"), "v2");
  assert.equal(c.used(), 4);
  // A wrapped statement still shows D1's statement/params, so code that reads them works.
  const bound = c.DB.prepare("SELECT ? AS a").bind(7);
  assert.equal(bound.statement, "SELECT ? AS a");
  assert.deepEqual(bound.params, [7]);
  assert.equal(c.used(), 4); // preparing and binding make no query
});

test("countingDB: a statement that fails still counts, a failed batch counts every statement, nesting counts both", async () => {
  const DB = fakeD1();
  const outer = countingDB(DB);
  const inner = countingDB(outer.DB);
  await assert.rejects(inner.DB.prepare("SELECT * FROM no_such_table").all(), /no such table/);
  const ok = inner.DB.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')");
  const bad = inner.DB.prepare("INSERT INTO settings (key, value) VALUES ('a', '2')"); // the key is taken
  await assert.rejects(inner.DB.batch([ok, bad]));
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM settings").first("n"), 0); // all or nothing, as on D1
  assert.equal(inner.used(), 3);
  assert.equal(outer.used(), 3);
  // batch() hands D1 the real statements: a batch through two wrappers runs.
  await inner.DB.batch([inner.DB.prepare("INSERT INTO settings (key, value) VALUES ('b', '1')")]);
  assert.equal(await DB.prepare("SELECT value FROM settings WHERE key = 'b'").first("value"), "1");
  assert.equal(outer.used(), 4);
});

// --- More of Part A ------------------------------------------------------------------------------------------------

test("BOUNCE_PAUSE and inboundStep's shape", () => {
  assert.deepEqual(BOUNCE_PAUSE, { count: 2, days: 7 });
  assert.equal(inboundStep.name, "inbound");
  assert.equal(inboundStep.everyMinutes, 0);
  assert.equal(typeof inboundStep.run, "function");
});

test("inboundStep.run: a summary like \"3 processed: 1 human, 1 auto, 1 bounce\", using ctx.DB", async () => {
  const DB = await seeded();
  await addRaw(DB, GMAIL_FROM_BOB, { received_at: at(-30) });
  await addRaw(DB, fixture("ooo.eml"), { received_at: at(-20) });
  await addRaw(DB, fixture("dsn-gmail.eml"), { received_at: at(-10) });
  const c = countingDB(DB);
  const summary = await inboundStep.run({ DB: c.DB, env: {}, now: NOW, reason: "cron", results: {}, budget: { left: () => 47 } });
  assert.equal(summary, "3 processed: 1 human, 1 auto, 1 bounce");
  assert.ok(c.used() > 3);
  assert.equal(await inboundStep.run({ DB, env: {}, now: NOW, reason: "cron", results: {}, budget: { left: () => 47 } }),
    "0 processed");
});

test("inboundStep.run: maxQueries is min(30, budget.left()); what's left waits for the next tick", async () => {
  const DB = await seeded();
  for (let i = 0; i < 10; i++) await addRaw(DB, mail("ooo.eml", { messageId: `<o${i}@mail.gmail.com>` }), { received_at: at(-50 + i) });
  const c = countingDB(DB);
  const summary = await inboundStep.run({ DB: c.DB, env: {}, now: NOW, reason: "cron", results: {}, budget: { left: () => 10 } });
  const done = Number(/^(\d+) processed/.exec(summary)[1]);
  assert.ok(done >= 1 && done < 10, summary);
  assert.equal(summary, `${done} processed: ${done} auto; ${10 - done} wait for the next tick`);
  assert.ok(c.used() >= 10 && c.used() < 20, `${c.used()} queries`);

  // With a big budget the cap is still 30.
  const big = countingDB(DB);
  await inboundStep.run({ DB: big.DB, env: {}, now: NOW, reason: "cron", results: {}, budget: { left: () => 500 } });
  const rest = await one(DB, "SELECT COUNT(*) AS n FROM inbound_raw WHERE processed_at IS NULL");
  assert.equal(rest.n, 0);
  assert.ok(big.used() < 40);
});

test("an auto reply (out of office) is stored only, linked when it can be", async () => {
  const DB = await seeded();
  const raw = await addRaw(DB, mail("ooo.eml", { from: "Bob <bob@x.com>" }));
  assert.deepEqual(await processInbound(DB, NOW), { auto: 1 });
  assert.equal((await rawRow(DB, raw)).outcome, "auto");
  const [m] = await inbound(DB);
  assert.equal(m.class, "auto");
  assert.equal(m.needs_reply, 0);
  assert.equal(m.place_id, "p1");
  assert.equal((await prospect(DB, "p1")).stage, "emailed");
  assert.equal((await prospect(DB, "p1")).last_inbound_at, null);
  assert.deepEqual(await suppressions(DB), []);
  assert.deepEqual(await all(DB, "SELECT id FROM todos"), []);
});

test("a delay notice (Action: delayed) is auto: nothing suppressed, nobody lost", async () => {
  const DB = await seeded();
  await insert(DB, "messages", {
    id: "out2", place_id: "p1", mailbox_id: "m1", direction: "out", kind: "followup", author: "system",
    to_addr: "bob@x.com", body: "Hi", message_id: "<9e2c4a1b-3d5f-4e7a-8b6c-0f1e2d3c4b5a@aetoswebsites.com>", status: "sent",
    created_at: EARLIER,
  });
  await addRaw(DB, fixture("dsn-delay.eml"));
  assert.deepEqual(await processInbound(DB, NOW), { auto: 1 });
  assert.deepEqual(await suppressions(DB), []);
  assert.equal((await prospect(DB, "p1")).stage, "emailed");
  assert.equal((await inbound(DB))[0].place_id, "p1"); // linked by the Message-ID inside the report
});

test("a bounce for a message we can't find: Final-Recipient still suppressed, outcome bounce, no mailbox paused", async () => {
  const DB = await seeded();
  const raw = await addRaw(DB, fixture("dsn-namecheap.eml"), { received_at: at(-30) });
  const raw2 = await addRaw(DB, mail("dsn-namecheap.eml", { messageId: "<4XHs2D0kTnz2Sd3E@mta-09.privateemail.com>" }), { received_at: at(-20) });
  assert.deepEqual(await processInbound(DB, NOW), { bounce: 2 });
  assert.equal((await rawRow(DB, raw)).outcome, "bounce");
  assert.equal((await rawRow(DB, raw2)).outcome, "bounce");
  assert.deepEqual(await suppressions(DB), [{ value: "info@oldsite-plumbing.co.uk", kind: "email", reason: "bounce" }]);
  const [m] = await inbound(DB);
  assert.equal(m.place_id, null);
  assert.equal(m.mailbox_id, null); // backscatter for mail we never sent can't pause a mailbox
  assert.equal((await mailbox(DB, "m1")).status, "active");
  assert.equal((await prospect(DB, "p1")).stage, "emailed");
});

test("a bounce links by Final-Recipient when the report has no Message-ID of ours", async () => {
  const DB = await seeded();
  await insert(DB, "prospects", {
    place_id: "p3", stage: "emailed", stage_at: EARLIER, email: "info@oldsite-plumbing.co.uk", mailbox_id: "m1",
    created_at: EARLIER, updated_at: EARLIER,
  });
  await addRaw(DB, fixture("dsn-namecheap.eml"));
  assert.deepEqual(await processInbound(DB, NOW), { bounce: 1 });
  const [m] = await inbound(DB);
  assert.equal(m.place_id, "p3");
  assert.equal(m.mailbox_id, "m1");
  assert.equal((await prospect(DB, "p3")).lost_reason, "bounce");
  assert.equal((await prospect(DB, "p1")).stage, "emailed");
});

test("a bounce older than 7 days doesn't count towards a pause", async () => {
  const DB = await seeded();
  await addRaw(DB, fixture("dsn-gmail.eml"), { received_at: at(-8 * 24 * 60) });
  await processInbound(DB, new Date(at(-8 * 24 * 60)));
  await addRaw(DB, mail("dsn-gmail.eml", { messageId: "<late@mx.google.com>" }), { received_at: iso(NOW) });
  await processInbound(DB, NOW);
  assert.equal((await mailbox(DB, "m1")).status, "active");
});

test("a paused mailbox keeps its first reason when more bounces arrive", async () => {
  const DB = await seeded();
  await DB.prepare("UPDATE mailboxes SET status = 'paused', paused_reason = 'Paused by Nik' WHERE id = 'm1'").run();
  await addRaw(DB, fixture("dsn-gmail.eml"), { received_at: at(-20) });
  await addRaw(DB, mail("dsn-gmail.eml", { messageId: "<b2@mx.google.com>" }), { received_at: at(-10) });
  assert.deepEqual(await processInbound(DB, NOW), { bounce: 2 });
  assert.equal((await mailbox(DB, "m1")).paused_reason, "Paused by Nik");
});

test("an opt-out from someone we never wrote to is still suppressed", async () => {
  const DB = await seeded();
  const raw = await addRaw(DB, mail("no-thanks.eml", { from: "Who <Who@Elsewhere.co.uk>" }));
  assert.deepEqual(await processInbound(DB, NOW), { opt_out: 1 });
  assert.equal((await rawRow(DB, raw)).outcome, "opt_out");
  assert.deepEqual(await suppressions(DB), [{ value: "who@elsewhere.co.uk", kind: "email", reason: "opt_out" }]);
  assert.deepEqual(await all(DB, "SELECT id FROM todos"), []);
});

test("an opt-out from a prospect already lost (not_now) records opt_out, so it's never reopened", async () => {
  const DB = await seeded();
  await DB.prepare("UPDATE prospects SET stage = 'lost', lost_reason = 'not_now' WHERE place_id = 'p1'").run();
  await addRaw(DB, mail("no-thanks.eml", { from: "bob@x.com" }));
  assert.deepEqual(await processInbound(DB, NOW), { opt_out: 1 });
  assert.equal((await prospect(DB, "p1")).lost_reason, "opt_out");
});

test("linking: In-Reply-To first, then each References id; From = prospects.email ignoring case otherwise", async () => {
  const DB = await seeded();
  await insert(DB, "prospects", {
    place_id: "p4", stage: "viewed", stage_at: EARLIER, email: "Mixed@Case.co.uk", mailbox_id: "m2",
    created_at: EARLIER, updated_at: EARLIER,
  });
  // A reply whose In-Reply-To is unknown but whose References hold our first email: linked to p1, from any address.
  const viaRefs = setHeader(setHeader(mail("gmail-reply.eml", { from: "other@z.com" }), "In-Reply-To", "<unknown@y.com>"),
    "References", "<older@y.com> <orig@aetoswebsites.com>");
  await addRaw(DB, viaRefs, { received_at: at(-30) });
  // No thread headers at all: linked by From to p4 (stored as Mixed@Case.co.uk).
  await addRaw(DB, mail("with-attachment.eml", { from: "MIXED@case.CO.UK", dropThread: true }), { received_at: at(-20) });
  assert.deepEqual(await processInbound(DB, NOW), { human: 2 });
  const [a, b] = await inbound(DB);
  assert.equal(a.place_id, "p1");
  assert.equal(a.mailbox_id, "m1");
  assert.equal(b.place_id, "p4");
  assert.equal(b.mailbox_id, "m2"); // the prospect's mailbox owns the thread
  assert.equal(b.body, "See attached");
  assert.equal((await prospect(DB, "p4")).stage, "replied");
  assert.equal((await prospect(DB, "p1")).stage, "replied");
});

test("linking: In-Reply-To wins over References, and an earlier References id over a later one", async () => {
  const DB = await seeded();
  for (const [place, msgId] of [["p5", "<p5@aetoswebsites.com>"], ["p6", "<p6@aetoswebsites.com>"]]) {
    await insert(DB, "prospects", {
      place_id: place, stage: "emailed", stage_at: EARLIER, email: `${place}@x.com`, mailbox_id: "m1",
      created_at: EARLIER, updated_at: EARLIER,
    });
    await insert(DB, "messages", {
      id: `out-${place}`, place_id: place, mailbox_id: "m1", direction: "out", kind: "first", author: "nik",
      to_addr: `${place}@x.com`, body: "Hi", message_id: msgId, status: "sent", created_at: EARLIER,
    });
  }
  const threaded = (inReplyTo, refs, id) => setHeader(setHeader(mail("gmail-reply.eml", { from: "bob@x.com", messageId: id }),
    "In-Reply-To", inReplyTo), "References", refs);
  await addRaw(DB, threaded("<p6@aetoswebsites.com>", "<orig@aetoswebsites.com> <p5@aetoswebsites.com>", "<a@g.com>"), { received_at: at(-30) });
  await addRaw(DB, threaded("<nobody@g.com>", "<p5@aetoswebsites.com> <orig@aetoswebsites.com>", "<b@g.com>"), { received_at: at(-20) });
  assert.deepEqual(await processInbound(DB, NOW), { human: 2 });
  const [a, b] = await inbound(DB);
  assert.equal(a.place_id, "p6"); // In-Reply-To, though From is p1's address and References hold p1's email first
  assert.equal(b.place_id, "p5");
});

test("a reply to mail we sent a client (system mail with client_id) is client mail", async () => {
  const DB = await seeded();
  await seedClient(DB);
  await insert(DB, "messages", {
    id: "sys1", client_id: "c1", mailbox_id: "m1", direction: "out", kind: "system", author: "system",
    to_addr: "accounts@davesvans.co.uk", body: "Welcome", message_id: "<welcome@aetoswebsites.com>", status: "sent",
    created_at: EARLIER,
  });
  const reply = setHeader(setHeader(mail("gmail-reply.eml", { from: "accounts@davesvans.co.uk" }), "In-Reply-To",
    "<welcome@aetoswebsites.com>"), "References", "<welcome@aetoswebsites.com>");
  await addRaw(DB, reply);
  assert.deepEqual(await processInbound(DB, NOW), { client: 1 });
  const [m] = await inbound(DB);
  assert.equal(m.client_id, "c1");
  assert.equal(m.mailbox_id, "m1");
  assert.equal(m.needs_reply, 0);
  assert.equal((await prospect(DB, "p1")).stage, "emailed");
});

test("a client whose clients row has a place_id fills messages.place_id", async () => {
  const DB = await seeded();
  await seedClient(DB);
  await DB.prepare("UPDATE clients SET place_id = 'p9' WHERE id = 'c1'").run();
  await addRaw(DB, mail("outlook-qp.eml", { from: "dave@client.com" }));
  assert.deepEqual(await processInbound(DB, NOW), { client: 1 });
  const [m] = await inbound(DB);
  assert.equal(m.place_id, "p9");
  assert.equal(m.client_id, "c1");
  assert.equal((await one(DB, "SELECT place_id FROM todos")).place_id, "p9");
});

test("a won prospect's email that also matches client_links is linked to both the prospect and the client", async () => {
  const DB = await seeded();
  await seedWon(DB);
  // The client row a won prospect has (stage 7 sets messages.client_id = clients.id for that place_id).
  await insert(DB, "clients", {
    id: "c2", name: "Carol's", place_id: "p2", package: "full", build_fee_pence: 195000, monthly_pence: 24900,
    free_days: 60, paid_on: "2026-10-01", created_at: EARLIER,
  });
  await insert(DB, "client_links", { client_id: "c2", stripe_customer: "cus_2", email: "carol@x.com" });
  await addRaw(DB, mail("outlook-qp.eml", { from: "carol@x.com" }));
  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });
  const [m] = await inbound(DB);
  assert.equal(m.place_id, "p2");
  assert.equal(m.client_id, "c2");
  // needs_reply is stage 7's: its onHumanInbound sets 0 for a won prospect (it goes to Nik, never a sales reply).
  assert.equal((await prospect(DB, "p2")).stage, "won");
});

test("an email with no From address can't be linked or answered: an error outcome, nothing stored", async () => {
  const DB = await seeded();
  const raw = await addRaw(DB, setHeader(fixture("iphone-b64.eml"), "From", null));
  assert.deepEqual(await processInbound(DB, NOW), { error: 1 });
  assert.match((await rawRow(DB, raw)).outcome, /^error: .*From address/);
  assert.deepEqual(await inbound(DB), []);
});

// A DB whose statements matching `pattern` fail, as if D1 had a hiccup mid-row.
const failing = (DB, pattern, message = "D1 hiccup") => ({
  ...DB,
  prepare: (sql) => (pattern.test(sql)
    ? { bind: () => ({ run: async () => { throw new Error(message); }, first: async () => { throw new Error(message); } }) }
    : DB.prepare(sql)),
});

test("a D1 error after the email is stored: left for the next tick, which applies it without storing it twice", async () => {
  const DB = await seeded();
  const first = await addRaw(DB, GMAIL_FROM_BOB, { received_at: at(-30) });
  const second = await addRaw(DB, mail("ooo.eml"), { received_at: at(-20) });
  assert.deepEqual(await processInbound(failing(DB, /UPDATE prospects SET last_inbound_at/), NOW), { retry: 1, auto: 1 });
  const waiting = await rawRow(DB, first);
  assert.equal(waiting.processed_at, null, "not marked: a D1 hiccup mustn't lose the reply's effects");
  assert.equal(waiting.outcome, "reading");
  assert.equal((await rawRow(DB, second)).outcome, "auto"); // the queue moved on
  assert.equal((await prospect(DB, "p1")).stage, "emailed");

  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });
  const r = await rawRow(DB, first);
  assert.equal(r.outcome, "human");
  assert.equal(r.processed_at, iso(NOW));
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "replied");
  assert.equal(p.last_inbound_at, "2026-10-21T09:30:00Z");
  assert.deepEqual((await inbound(DB)).map((m) => m.class), ["human", "auto"]); // stored once
});

test("a D1 error on both tries: the error is its outcome, the email stays stored, and the queue moves on", async () => {
  const DB = await seeded();
  const first = await addRaw(DB, GMAIL_FROM_BOB, { received_at: at(-30) });
  const flaky = failing(DB, /UPDATE prospects SET last_inbound_at/);
  assert.deepEqual(await processInbound(flaky, NOW), { retry: 1 });
  const second = await addRaw(DB, mail("ooo.eml"), { received_at: at(-20) });
  assert.deepEqual(await processInbound(flaky, NOW), { error: 1, auto: 1 });
  const r = await rawRow(DB, first);
  assert.equal(r.outcome, "error: D1 hiccup");
  assert.equal(r.processed_at, iso(NOW));
  assert.equal((await rawRow(DB, second)).outcome, "auto");
  assert.equal((await inbound(DB)).length, 2);
});

test("a D1 error before the email is stored (its lookup) doesn't lose it: the next tick stores it", async () => {
  const DB = await seeded();
  const id = await addRaw(DB, GMAIL_FROM_BOB);
  assert.deepEqual(await processInbound(failing(DB, /json_each/), NOW), { retry: 1 });
  assert.equal((await rawRow(DB, id)).processed_at, null);
  assert.deepEqual(await inbound(DB), []);
  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });
  assert.equal((await rawRow(DB, id)).outcome, "human");
  assert.equal((await inbound(DB)).length, 1);
  assert.equal((await prospect(DB, "p1")).stage, "replied");
});

test("an opt-out cut off after it was stored but before its suppression (Error 1102) is suppressed on the next tick", async () => {
  const DB = await seeded();
  const id = await addRaw(DB, mail("no-thanks.eml", { from: "bob@x.com" }));
  await new Promise((reached) => {
    const dying = {
      ...DB,
      prepare: (sql) => (/INTO suppression/.test(sql) ? { bind: () => ({ run: () => (reached(), new Promise(() => {})) }) } : DB.prepare(sql)),
    };
    processInbound(dying, NOW);
  });
  assert.equal((await inbound(DB)).length, 1, "stored before it was cut off");
  assert.equal((await rawRow(DB, id)).processed_at, null);
  assert.deepEqual(await suppressions(DB), []);

  assert.deepEqual(await processInbound(DB, NOW), { opt_out: 1 });
  assert.deepEqual(await suppressions(DB), [{ value: "bob@x.com", kind: "email", reason: "opt_out" }]);
  assert.equal((await prospect(DB, "p1")).lost_reason, "opt_out");
  assert.equal((await rawRow(DB, id)).outcome, "opt_out");
  assert.equal((await inbound(DB)).length, 1, "not stored twice");
});

test("now may be an ISO string; processed rows aren't read again", async () => {
  const DB = await seeded();
  await addRaw(DB, GMAIL_FROM_BOB);
  assert.deepEqual(await processInbound(DB, iso(NOW)), { human: 1 });
  assert.deepEqual(await processInbound(DB, iso(NOW)), {});
  await assert.rejects(processInbound(DB, "not a time"), TypeError);
});

test("the escalation detail is the subject then the first 300 characters of the body", async () => {
  const DB = await seeded();
  const long = "word ".repeat(200).trim();
  const raw = "From: stranger@y.com\r\nTo: nik@aetoswebsites.com\r\nSubject: =?utf-8?Q?Caf=C3=A9_question?=\r\n" +
    "Message-ID: <long@y.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" + long + "\r\n";
  await addRaw(DB, raw);
  await processInbound(DB, NOW);
  const todo = await one(DB, "SELECT detail FROM todos");
  assert.equal(todo.detail, "Subject: Café question\n\n" + long.slice(0, 300));
});

// --- Review: overlapping runs, odd bounces and senders --------------------------------------------------------------

test("two overlapping runs (a tick that outlived its lease) store a reply once and keep its outcome", async () => {
  const DB = await seeded();
  const raw = await addRaw(DB, GMAIL_FROM_BOB, { received_at: at(-30) });
  await Promise.all([processInbound(DB, NOW), processInbound(DB, NOW)]); // both read the row before either marks it
  const rows = await inbound(DB);
  assert.equal(rows.length, 1, "stored once");
  assert.equal(rows.filter((m) => m.needs_reply === 1).length, 1, "one message waiting for an answer, not two");
  assert.equal((await rawRow(DB, raw)).outcome, "human"); // not overwritten with duplicate by the other run
  assert.equal((await prospect(DB, "p1")).stage, "replied");
});

test("the same email arriving twice (forwarded and direct) and read by two overlapping runs is stored once", async () => {
  const DB = await seeded();
  const a = await addRaw(DB, mail("iphone-b64.eml", { from: "stranger@y.com" }), { received_at: at(-30) });
  const b = await addRaw(DB, mail("iphone-b64.eml", { from: "stranger@y.com" }), { received_at: at(-29) });
  await Promise.all([processInbound(DB, NOW), processInbound(DB, NOW)]);
  assert.equal((await inbound(DB)).length, 1);
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM todos")).n, 1, "one escalation todo");
  // Whichever run stored it, one row is the email and the other its duplicate.
  assert.deepEqual([(await rawRow(DB, a)).outcome, (await rawRow(DB, b)).outcome].sort(), ["duplicate", "unknown_sender"]);
});

// A run Cloudflare stops (Error 1102) while it reads an email: its lookup never comes back, like a killed invocation.
// Resolves once the run has got that far; the run itself never finishes.
function stoppedRun(DB) {
  return new Promise((reached) => {
    const dying = {
      ...DB,
      prepare: (sql) => (/json_each/.test(sql)
        ? { bind: () => ({ first: () => (reached(), new Promise(() => {})) }) }
        : DB.prepare(sql)),
    };
    processInbound(dying, NOW);
  });
}

test("a tick Cloudflare stops part-way through an email (Error 1102): the next tick reads it again first, so it isn't lost", async () => {
  const DB = await seeded();
  const cut = await addRaw(DB, GMAIL_FROM_BOB, { received_at: at(-30) });
  const next = await addRaw(DB, mail("ooo.eml"), { received_at: at(-20) });
  await stoppedRun(DB);
  const waiting = await rawRow(DB, cut);
  assert.equal(waiting.processed_at, null, "still waiting");
  assert.equal(waiting.outcome, "reading"); // marked as being read, so the next tick knows it was cut off once
  assert.deepEqual(await processInbound(DB, NOW), { human: 1, auto: 1 });
  const r = await rawRow(DB, cut);
  assert.equal(r.outcome, "human");
  assert.equal(r.processed_at, iso(NOW));
  assert.equal((await rawRow(DB, next)).outcome, "auto");
  assert.deepEqual((await inbound(DB)).map((m) => m.class), ["human", "auto"]);
  assert.equal((await prospect(DB, "p1")).stage, "replied");
});

test("an email that stops two ticks part-way is marked as an error on the third, and the queue moves on", async () => {
  const DB = await seeded();
  const huge = await addRaw(DB, GMAIL_FROM_BOB, { received_at: at(-30) });
  const next = await addRaw(DB, mail("ooo.eml"), { received_at: at(-20) });
  await stoppedRun(DB);
  await stoppedRun(DB); // read again first, and stopped again
  assert.equal((await rawRow(DB, huge)).outcome, "reading again");
  assert.equal((await rawRow(DB, next)).processed_at, null, "nothing behind it has been read yet");
  const c = countingDB(DB);
  assert.deepEqual(await processInbound(c.DB, NOW), { error: 1, auto: 1 }); // the third tick isn't stuck on it
  assert.equal(c.used(), 1 + 1 + 4, "the select, giving up on it (no third read), then the auto reply");
  const r = await rawRow(DB, huge);
  assert.equal(r.outcome, "error: Reading this email was cut off part-way twice (most likely it's too big for " +
    "Cloudflare's time limit), so it was skipped. Look for it in your mailbox.");
  assert.equal(r.processed_at, iso(NOW));
  assert.equal((await rawRow(DB, next)).outcome, "auto");
  assert.deepEqual((await inbound(DB)).map((m) => m.class), ["auto"]);
  assert.equal((await prospect(DB, "p1")).stage, "emailed");
});

// A DB whose statements matching `pattern` wait at run() until release() is called (D1 being slow). `reached`
// resolves when the first one is sent; `before` runs just before it goes on.
function slowAt(DB, pattern, before = async () => {}) {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let arrived;
  const reached = new Promise((resolve) => (arrived = resolve));
  const db = {
    ...DB,
    prepare: (sql) => {
      if (!pattern.test(sql)) return DB.prepare(sql);
      return { bind: (...v) => ({ run: async () => (arrived(), await gate, await before(), DB.prepare(sql).bind(...v).run()) }) };
    },
  };
  return { db, reached, release };
}

test("a run that outlived its lease and a later run reading the same email again: stored once, its outcome kept", async () => {
  const DB = await seeded();
  const id = await addRaw(DB, GMAIL_FROM_BOB);
  // The slow run gets as far as storing the email, then waits (D1 is slow) until the later run has finished.
  const slow = slowAt(DB, /INSERT INTO messages/);
  const slowRun = processInbound(slow.db, NOW);
  await slow.reached;
  // The later run sees the email marked as being read by a run it takes for stopped, and reads it again.
  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });
  slow.release();
  assert.deepEqual(await slowRun, { duplicate: 1 }); // nothing stored or applied a second time
  assert.equal((await rawRow(DB, id)).outcome, "human"); // not overwritten with duplicate
  assert.equal((await inbound(DB)).length, 1);
  assert.equal((await prospect(DB, "p1")).stage, "replied");
});

test("an email with no Message-ID read by an overlapping run as well is still stored once, with one todo", async () => {
  const DB = await seeded();
  const id = await addRaw(DB, setHeader(mail("iphone-b64.eml", { from: "stranger@y.com" }), "Message-ID", null));
  const slow = slowAt(DB, /INSERT INTO messages/);
  const slowRun = processInbound(slow.db, NOW);
  await slow.reached;
  assert.deepEqual(await processInbound(DB, NOW), { unknown_sender: 1 });
  slow.release();
  assert.deepEqual(await slowRun, { duplicate: 1 });
  assert.equal((await inbound(DB)).length, 1);
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM todos")).n, 1);
  assert.equal((await rawRow(DB, id)).outcome, "unknown_sender");
});

test("a late run's error never overwrites the outcome another run already gave the row", async () => {
  const DB = await seeded();
  const id = await addRaw(DB, GMAIL_FROM_BOB);
  await DB.prepare("UPDATE inbound_raw SET outcome = 'reading' WHERE id = ?").bind(id).run(); // cut off once
  // This run (its last try) is slow at its lookup; meanwhile another run finishes the row; then the lookup fails.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let arrived;
  const reached = new Promise((resolve) => (arrived = resolve));
  const late = {
    ...DB,
    prepare: (sql) => (/json_each/.test(sql)
      ? { bind: () => ({ first: async () => { arrived(); await gate; throw new Error("D1 hiccup"); } }) }
      : DB.prepare(sql)),
  };
  const lateRun = processInbound(late, NOW);
  await reached;
  await DB.prepare("UPDATE inbound_raw SET processed_at = ?, outcome = 'human' WHERE id = ?").bind(at(1), id).run();
  release();
  assert.deepEqual(await lateRun, { error: 1 });
  const r = await rawRow(DB, id);
  assert.equal(r.outcome, "human");
  assert.equal(r.processed_at, at(1));
});

test("a row put back in the queue by hand (processed_at cleared, an old outcome left) is read as a first try", async () => {
  const DB = await seeded();
  const id = await addRaw(DB, GMAIL_FROM_BOB);
  await DB.prepare("UPDATE inbound_raw SET outcome = 'error: D1 hiccup' WHERE id = ?").bind(id).run();
  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });
  assert.equal((await rawRow(DB, id)).outcome, "human");
});

test("a copy stored by an overlapping run between this run's lookup and its store makes this row a duplicate", async () => {
  const DB = await seeded();
  const id = await addRaw(DB, GMAIL_FROM_BOB);
  // The other run stores the same email (its own row, same Message-ID) just before this run's store.
  const racing = slowAt(DB, /INSERT INTO messages/, () => insert(DB, "messages", {
    id: "theirs", place_id: "p1", direction: "in", kind: "inbound", author: "them", body: "Hi Nik", status: "received",
    class: "human", needs_reply: 1, created_at: EARLIER,
    message_id: "<CAJx7Lk2bPq0vN=Ze4tX1+R8mGHu3sYw-Fd5kLzQ9aE2oWcVb7g@mail.gmail.com>",
  }));
  racing.release();
  assert.deepEqual(await processInbound(racing.db, NOW), { duplicate: 1 });
  assert.equal((await rawRow(DB, id)).outcome, "duplicate");
  assert.deepEqual((await inbound(DB)).map((m) => m.id), ["theirs"]); // not stored a second time
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "emailed"); // and nothing applied twice: the other run applies it
  assert.equal(p.last_inbound_at, null);
});

test("each row is claimed before it's read: a row another run has claimed is left to it", async () => {
  const DB = await seeded();
  const id = await addRaw(DB, GMAIL_FROM_BOB);
  // Another run claims it between this run's select and its claim.
  const racing = {
    ...DB,
    prepare: (sql) => {
      const stmt = DB.prepare(sql);
      if (!WAITING_SELECT.test(sql)) return stmt;
      return { bind: (...v) => ({ all: async () => {
        const res = await stmt.bind(...v).all();
        await DB.prepare("UPDATE inbound_raw SET processed_at = ?, outcome = 'human' WHERE id = ?").bind(iso(NOW), id).run();
        return res;
      } }) };
    },
  };
  assert.deepEqual(await processInbound(racing, NOW), {});
  assert.equal((await rawRow(DB, id)).outcome, "human");
  assert.deepEqual(await inbound(DB), []); // nothing stored by this run
});

test("a plain-text bounce that names no recipient suppresses the address our email went to", async () => {
  const DB = await seeded();
  // qmail-style: no delivery-status part and no Final-Recipient, only a copy of our email (with its Message-ID).
  const raw = "From: MAILER-DAEMON@mail.example.net\r\nTo: nik@aetoswebsites.com\r\nSubject: failure notice\r\n" +
    "Message-ID: <qmail1@mail.example.net>\r\n\r\nHi. This is the qmail-send program at mail.example.net.\r\n" +
    "I'm afraid I wasn't able to deliver your message to the following addresses.\r\n\r\n<bob@x.com>:\r\n" +
    "Sorry, no mailbox here by that name. (#5.1.1)\r\n\r\n--- Below this line is a copy of the message.\r\n\r\n" +
    "From: Nik <nik@aetoswebsites.com>\r\nTo: bob@x.com\r\nSubject: Your new website, Bob\r\n" +
    "Message-ID: <orig@aetoswebsites.com>\r\n\r\nHi Bob\r\n";
  const id = await addRaw(DB, raw);
  assert.deepEqual(await processInbound(DB, NOW), { bounce: 1 });
  assert.equal((await rawRow(DB, id)).outcome, "bounce");
  assert.deepEqual(await suppressions(DB), [{ value: "bob@x.com", kind: "email", reason: "bounce" }]);
  assert.equal((await prospect(DB, "p1")).lost_reason, "bounce");
  assert.equal((await inbound(DB))[0].mailbox_id, "m1");
});

test("a bounce of mail to a won client: the address is suppressed, the client stays won", async () => {
  const DB = await seeded();
  await seedWon(DB);
  await insert(DB, "messages", {
    id: "care1", place_id: "p2", mailbox_id: "m1", direction: "out", kind: "system", author: "system",
    to_addr: "carol@x.com", body: "Your monthly report", message_id: "<care1@aetoswebsites.com>", status: "sent",
    created_at: EARLIER,
  });
  const dsn = fixture("dsn-gmail.eml").replaceAll("<orig@aetoswebsites.com>", "<care1@aetoswebsites.com>")
    .replaceAll("nobody@x.com", "carol@x.com");
  await addRaw(DB, dsn);
  assert.deepEqual(await processInbound(DB, NOW), { bounce: 1 });
  assert.deepEqual(await suppressions(DB), [{ value: "carol@x.com", kind: "email", reason: "bounce" }]);
  const p2 = await prospect(DB, "p2");
  assert.equal(p2.stage, "won");
  assert.equal(p2.lost_reason, null);
  assert.equal((await inbound(DB))[0].place_id, "p2");
});

test("an opt-out whose From isn't an address still stops the prospect it replies to", async () => {
  const DB = await seeded();
  // A broken mail client: "From: Bob" (no address), but threaded to our first email.
  const raw = "From: Bob\r\nTo: nik@aetoswebsites.com\r\nSubject: Re: Your new website, Bob\r\n" +
    "Message-ID: <nofrom@x.com>\r\nIn-Reply-To: <orig@aetoswebsites.com>\r\n\r\nNo thanks.\r\n";
  const id = await addRaw(DB, raw);
  assert.deepEqual(await processInbound(DB, NOW), { opt_out: 1 });
  assert.equal((await rawRow(DB, id)).outcome, "opt_out");
  // "Bob" can't be suppressed; the address our email went to is.
  assert.deepEqual(await suppressions(DB), [{ value: "bob@x.com", kind: "email", reason: "opt_out" }]);
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "lost");
  assert.equal(p.lost_reason, "opt_out");
  assert.equal(p.next_followup_at, null);
});

test("garbage with the headers the relay would store for it ({}) is an error too", async () => {
  const DB = await seeded();
  const id = await addRaw(DB, "\u0000"); // relayHeaders("\u0000") is "{}"
  assert.deepEqual(await processInbound(DB, NOW), { error: 1 });
  const r = await rawRow(DB, id);
  assert.match(r.outcome, /^error: \S/);
  assert.equal(r.processed_at, iso(NOW));
  assert.deepEqual(await inbound(DB), []);
});

test("a Namecheap-forwarded reply is linked by its header From, never the rewritten envelope sender", async () => {
  const DB = await seeded();
  await insert(DB, "prospects", {
    place_id: "p7", stage: "viewed", stage_at: EARLIER, email: "dave.wilkins@yahoo.co.uk", mailbox_id: "m1",
    created_at: EARLIER, updated_at: EARLIER,
  });
  await addRaw(DB, fixture("namecheap-forwarded.eml"), {
    envelope_from: "SRS0=Qk3v=RA=yahoo.co.uk=dave.wilkins@aetoswebsites.com",
  });
  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });
  const [m] = await inbound(DB);
  assert.equal(m.from_addr, "dave.wilkins@yahoo.co.uk");
  assert.equal(m.place_id, "p7");
  assert.equal(m.needs_reply, 1);
  assert.match(m.body, /^Go on then, what do I need to do next\?/);
  assert.equal((await prospect(DB, "p7")).stage, "replied");
});

// --- Review 2: text loaded only when claimed, retries, opt-outs from another address -----------------------------------

test("the waiting rows are selected without their text; a row's headers and raw MIME are loaded only by its claim", async () => {
  const DB = await seeded();
  for (let i = 0; i < 3; i++) await addRaw(DB, mail("ooo.eml", { messageId: `<sel-${i}@mail.gmail.com>` }), { received_at: at(-50 + i) });
  let selected = null;
  let claims = 0;
  const spy = {
    ...DB,
    prepare: (sql) => {
      const stmt = DB.prepare(sql);
      if (/RETURNING headers, raw/.test(sql)) claims++;
      if (!WAITING_SELECT.test(sql)) return stmt;
      return { bind: (...v) => ({ all: async () => {
        const res = await stmt.bind(...v).all();
        selected = res.results;
        return res;
      } }) };
    },
  };
  // Room for one row: the select, then the first row's claim, lookup, store and mark.
  assert.deepEqual(await processInbound(spy, NOW, { maxQueries: 5 }), { auto: 1 });
  assert.equal(selected.length, 3);
  // The raw MIME's length (worked out by D1) but never the text itself.
  for (const row of selected) assert.deepEqual(Object.keys(row).sort(), ["id", "outcome", "received_at", "size"]);
  for (const row of selected) assert.equal(typeof row.size, "number");
  assert.equal(claims, 1, "the two rows left for the next tick were never loaded");
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM inbound_raw WHERE processed_at IS NULL")).n, 2);
});

test("a tick stopped while loading an email (just after its claim) reads it again first on the next tick", async () => {
  const DB = await seeded();
  const id = await addRaw(DB, GMAIL_FROM_BOB);
  await new Promise((reached) => {
    const dying = {
      ...DB,
      prepare: (sql) => (/RETURNING headers, raw/.test(sql)
        ? { bind: (...v) => ({ first: async () => { await DB.prepare(sql).bind(...v).first(); reached(); return new Promise(() => {}); } }) }
        : DB.prepare(sql)),
    };
    processInbound(dying, NOW);
  });
  assert.equal((await rawRow(DB, id)).outcome, "reading"); // the claim landed before the tick was stopped
  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });
  assert.equal((await rawRow(DB, id)).outcome, "human");
  assert.equal((await inbound(DB)).length, 1);
});

test("a no thanks from another address in our thread suppresses that address and the one we wrote to", async () => {
  const DB = await seeded();
  const reply = setHeader(mail("no-thanks.eml", { from: "Bob <bob.harris@gmail.com>" }), "In-Reply-To", "<orig@aetoswebsites.com>");
  const id = await addRaw(DB, reply);
  assert.deepEqual(await processInbound(DB, NOW), { opt_out: 1 });
  assert.equal((await rawRow(DB, id)).outcome, "opt_out");
  assert.deepEqual(await suppressions(DB), [
    { value: "bob.harris@gmail.com", kind: "email", reason: "opt_out" },
    { value: "bob@x.com", kind: "email", reason: "opt_out" },
  ]);
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "lost");
  assert.equal(p.lost_reason, "opt_out");
  assert.equal((await inbound(DB))[0].place_id, "p1");
});

test("the stored message's id is its inbound_raw row's id, so a second try can find it", async () => {
  const DB = await seeded();
  const id = await addRaw(DB, GMAIL_FROM_BOB);
  await processInbound(DB, NOW);
  assert.deepEqual((await inbound(DB)).map((m) => m.id), [id]);
});

test("inboundStep.run counts a row left for a second try as a retry", async () => {
  const DB = await seeded();
  await addRaw(DB, GMAIL_FROM_BOB, { received_at: at(-30) });
  await addRaw(DB, fixture("ooo.eml"), { received_at: at(-20) });
  const ctx = { DB: failing(DB, /UPDATE prospects SET last_inbound_at/), env: {}, now: NOW, reason: "cron", results: {}, budget: { left: () => 47 } };
  assert.equal(await inboundStep.run(ctx), "2 processed: 1 retry, 1 auto");
  assert.equal(await inboundStep.run({ ...ctx, DB }), "1 processed: 1 human");
});

// --- Review 3: list mail, expired DSNs, raw kept only for errors, a size budget, one todo per client email -----------

// A newsletter, as Namecheap forwards everything in Nik's inbox (D-1 option A).
const newsletter = (from = "Trade News <news@tradenews.example.com>", id = "<nl-1@tradenews.example.com>") =>
  `From: ${from}\r\nTo: nik@aetoswebsites.com\r\nSubject: Five ways to get more reviews\r\nMessage-ID: ${id}\r\n` +
  "List-Id: Trade News <news.tradenews.example.com>\r\n" +
  "List-Unsubscribe: <https://tradenews.example.com/u/123>, <mailto:unsub@tradenews.example.com>\r\n" +
  "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" +
  "This week: five ways to get more reviews.\r\n\r\nUnsubscribe\r\n";

test("a newsletter from a stranger is auto (stored, no todo); a stranger's own email still gets its todo", async () => {
  const DB = await seeded();
  const nl = await addRaw(DB, newsletter(), { received_at: at(-30) });
  const plain = await addRaw(DB, mail("iphone-b64.eml", { from: "Someone <stranger@y.com>" }), { received_at: at(-20) });
  assert.deepEqual(await processInbound(DB, NOW), { auto: 1, unknown_sender: 1 });
  assert.equal((await rawRow(DB, nl)).outcome, "auto");
  assert.equal((await rawRow(DB, plain)).outcome, "unknown_sender");
  const [news, them] = await inbound(DB);
  assert.equal(news.class, "auto");
  assert.equal(news.needs_reply, 0);
  assert.equal(news.from_addr, "news@tradenews.example.com");
  assert.equal(them.class, "human");
  assert.deepEqual((await all(DB, "SELECT title FROM todos")).map((t) => t.title), ["Email from unknown sender: stranger@y.com"]);
  assert.deepEqual(await suppressions(DB), []); // its "Unsubscribe" line is never read as an opt-out
});

test("a newsletter from a prospect's own address is auto: no inbound_human, last_inbound_at unchanged", async () => {
  const DB = await seeded();
  const id = await addRaw(DB, newsletter("Bob Harris Roofing <Bob@X.com>", "<nl-bob@x.com>"));
  assert.deepEqual(await processInbound(DB, NOW), { auto: 1 });
  assert.equal((await rawRow(DB, id)).outcome, "auto");
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "emailed");
  assert.equal(p.last_inbound_at, null);
  assert.equal(p.updated_at, EARLIER);
  assert.equal(p.next_followup_at, "2026-10-22T08:00:00Z");
  const [m] = await inbound(DB);
  assert.equal(m.class, "auto");
  assert.equal(m.place_id, "p1");
  assert.equal(m.needs_reply, 0);
  assert.deepEqual(await all(DB, "SELECT id FROM todos"), []);
  assert.deepEqual(await suppressions(DB), []);
});

test("an expired DSN (Action: failed, Status: 4.4.7) is a bounce: suppressed, the prospect lost, it counts towards a pause", async () => {
  const DB = await seeded();
  await insert(DB, "prospects", {
    place_id: "p8", stage: "emailed", stage_at: EARLIER, email: "sales@slowserver-scaffolding.co.uk", mailbox_id: "m1",
    created_at: EARLIER, updated_at: EARLIER,
  });
  await insert(DB, "messages", {
    id: "out8", place_id: "p8", mailbox_id: "m1", direction: "out", kind: "first", author: "nik",
    to_addr: "sales@slowserver-scaffolding.co.uk", body: "Hi Sam",
    message_id: "<9e2c4a1b-3d5f-4e7a-8b6c-0f1e2d3c4b5a@aetoswebsites.com>", status: "sent", created_at: EARLIER,
  });
  // Postfix warns first (a delay: auto), then gives up days later (Action: failed with the last 4.x.x status).
  const delay = await addRaw(DB, fixture("dsn-delay.eml"), { received_at: at(-120) });
  const expired = await addRaw(DB, fixture("dsn-expired.eml"), { received_at: at(-60) });
  assert.deepEqual(await processInbound(DB, NOW), { auto: 1, bounce: 1 });
  assert.equal((await rawRow(DB, delay)).outcome, "auto");
  assert.equal((await rawRow(DB, expired)).outcome, "bounce");
  assert.deepEqual(await suppressions(DB), [{ value: "sales@slowserver-scaffolding.co.uk", kind: "email", reason: "bounce" }]);
  const p8 = await prospect(DB, "p8");
  assert.equal(p8.stage, "lost");
  assert.equal(p8.lost_reason, "bounce");
  assert.equal((await mailbox(DB, "m1")).status, "active"); // one bounce so far
  await addRaw(DB, fixture("dsn-gmail.eml"), { received_at: at(-30) });
  assert.deepEqual(await processInbound(DB, NOW), { bounce: 1 });
  const m1 = await mailbox(DB, "m1");
  assert.equal(m1.status, "paused");
  assert.equal(m1.paused_reason, "2 emails bounced in 7 days (last: nobody@x.com). Check your addresses are real, then press Resume.");
});

const rawLength = async (DB, id) => (await one(DB, "SELECT length(raw) AS n FROM inbound_raw WHERE id = ?", id)).n;

test("a row's raw MIME is cleared with its outcome (D1's 500 MB); error rows keep it for a regression test", async () => {
  const DB = await seeded();
  const bulk = await addRaw(DB, "Precedence: bulk\r\n" + mail("iphone-b64.eml", { from: "news@n.example.com", messageId: "<bulk@n.example.com>" }),
    { received_at: at(-50) });
  const bounce = await addRaw(DB, fixture("dsn-namecheap.eml"), { received_at: at(-45) });
  const human = await addRaw(DB, GMAIL_FROM_BOB, { received_at: at(-40) });
  const dup = await addRaw(DB, GMAIL_FROM_BOB, { received_at: at(-35) });
  const stranger = await addRaw(DB, mail("iphone-b64.eml", { from: "stranger@y.com" }), { received_at: at(-30) });
  const optOut = await addRaw(DB, mail("no-thanks.eml", { from: "who@elsewhere.co.uk" }), { received_at: at(-28) });
  const noFrom = await addRaw(DB, setHeader(fixture("with-attachment.eml"), "From", null), { received_at: at(-25) });
  const cut = await addRaw(DB, mail("outlook-qp.eml", { from: "dave@z.com" }), { received_at: at(-20) });
  await DB.prepare("UPDATE inbound_raw SET outcome = 'reading again' WHERE id = ?").bind(cut).run(); // cut off twice
  const kept = { [noFrom]: await rawLength(DB, noFrom), [cut]: await rawLength(DB, cut) };
  assert.ok(kept[noFrom] > 1000 && kept[cut] > 1000);

  assert.deepEqual(await processInbound(DB, NOW, { maxQueries: 1000 }),
    { auto: 1, bounce: 1, human: 1, duplicate: 1, unknown_sender: 1, opt_out: 1, error: 2 });
  for (const id of [bulk, bounce, human, dup, stranger, optOut]) {
    assert.equal(await rawLength(DB, id), 0, `${(await rawRow(DB, id)).outcome} row ${id}`);
  }
  assert.match((await rawRow(DB, noFrom)).outcome, /^error: .*From address/);
  assert.equal(await rawLength(DB, noFrom), kept[noFrom]);
  assert.match((await rawRow(DB, cut)).outcome, /^error: Reading this email was cut off part-way twice/);
  assert.equal(await rawLength(DB, cut), kept[cut]);
  // Everything later stages read is in messages: each stored email still has its body.
  const stored = await inbound(DB);
  assert.deepEqual(stored.map((m) => m.id).sort(), [bulk, bounce, human, stranger, optOut].sort());
  for (const m of stored) assert.ok(m.body.length > 0, `${m.class} ${m.id}`);
});

// An email of exactly `chars` characters of raw MIME: a bulk newsletter (auto, so it's cheap to apply).
function sized(i, chars) {
  const head = `From: news@n.example.com\r\nTo: nik@aetoswebsites.com\r\nSubject: Issue ${i}\r\n` +
    `Message-ID: <issue-${i}@n.example.com>\r\nPrecedence: bulk\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`;
  return head + "word ".repeat(Math.ceil(chars / 5)).slice(0, chars - head.length);
}

test("a tick reads at most ~100 KB of raw MIME: three 200 KB emails go one per call, the rest left unclaimed", async () => {
  const DB = await seeded();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await addRaw(DB, sized(i, 200000), { received_at: at(-50 + i) }));
  assert.equal(await rawLength(DB, ids[0]), 200000);
  for (let call = 1; call <= 3; call++) {
    assert.deepEqual(await processInbound(DB, NOW), { auto: 1 }, `call ${call}`);
    for (const [i, id] of ids.entries()) {
      const r = await rawRow(DB, id);
      assert.equal(r.processed_at === null, i >= call, `call ${call}, row ${i}`);
      // Never claimed, so it isn't marked as being read and no second try is used up.
      if (i >= call) assert.equal(r.outcome, null, `call ${call}, row ${i}`);
    }
  }
});

test("small emails still batch: ten 2 KB emails go in one call; a 200 KB one after a small one waits a tick", async () => {
  const DB = await seeded();
  for (let i = 0; i < 10; i++) await addRaw(DB, sized(i, 2000), { received_at: at(-50 + i) });
  // The query cap is lifted, so only the size budget could stop it.
  assert.deepEqual(await processInbound(DB, NOW, { maxQueries: 1000 }), { auto: 10 });

  const small = await addRaw(DB, sized(20, 2000), { received_at: at(-20) });
  const big = await addRaw(DB, sized(21, 200000), { received_at: at(-10) });
  const ctx = { DB, env: {}, now: NOW, reason: "cron", results: {}, budget: { left: () => 47 } };
  assert.equal(await inboundStep.run(ctx), "1 processed: 1 auto; 1 wait for the next tick");
  assert.equal((await rawRow(DB, small)).outcome, "auto");
  assert.equal((await rawRow(DB, big)).outcome, null);
  assert.equal(await inboundStep.run(ctx), "1 processed: 1 auto"); // first in the queue, so it always starts
  assert.equal((await rawRow(DB, big)).outcome, "auto");
});

test("a paying client writing from their Stripe address (not the prospect's) is client mail with exactly one todo", async () => {
  const DB = await seeded();
  await seedWon(DB); // p2, won, carol@x.com (the scraped address)
  await insert(DB, "clients", {
    id: "c2", name: "Carol's", place_id: "p2", package: "full", build_fee_pence: 195000, monthly_pence: 24900,
    free_days: 60, paid_on: "2026-10-01", created_at: EARLIER,
  });
  await insert(DB, "client_links", { client_id: "c2", stripe_customer: "cus_2", email: "Accounts@Carols.co.uk" });
  // A new email, not a reply: nothing links it to the prospect but the client's place_id.
  const id = await addRaw(DB, mail("outlook-qp.eml", { from: "Carol <accounts@carols.co.uk>", dropThread: true }));
  assert.deepEqual(await processInbound(DB, NOW), { client: 1 });
  assert.equal((await rawRow(DB, id)).outcome, "client");
  const [m] = await inbound(DB);
  assert.equal(m.class, "human");
  assert.equal(m.client_id, "c2");
  // The won prospect's place: stage 7's onHumanInbound would file a second, client-mail todo for it, which is why
  // stage 7 is called only for outcome "human" (mail linked to a prospect).
  assert.equal(m.place_id, "p2");
  assert.equal(m.needs_reply, 0);
  assert.deepEqual(await all(DB, "SELECT kind, dedupe, title, client_id, place_id FROM todos"), [{
    kind: "escalation", dedupe: `escalation:client:${m.id}`, title: "Email from your client: accounts@carols.co.uk",
    client_id: "c2", place_id: "p2",
  }]);
  const p2 = await prospect(DB, "p2");
  assert.equal(p2.stage, "won");
  assert.equal(p2.last_inbound_at, null);
});
