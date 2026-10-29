// The tick's purge step (file 11, Task 12): non-customers' data deleted 12 months after our last contact, once a month.
// Run: node --test control-room/tests/purge.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { enqueueResearch, runDailyFind } from "../functions/_lib/find.js";
import { PURGE_BATCH, purgeCutoff, purgeOld, purgeStep } from "../functions/_lib/purge.js";
import { getSetting, setSetting } from "../functions/_lib/settings.js";
import { STEPS } from "../functions/_lib/tick.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const NOW = new Date("2026-10-22T12:00:00Z"); // cutoff 2025-10-21T23:00:00Z (UK midnight, BST)
const T = "2025-01-01T09:00:00Z";

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}
const lead = (DB, place_id) => insert(DB, "leads", {
  place_id, name: `Lead ${place_id}`, trade: "roofer", search_town: "Leeds", quality_score: 60, first_seen_at: T, updated_at: T,
});
const prospect = (DB, place_id, stage, at) => insert(DB, "prospects", {
  place_id, stage, stage_at: at, email: `${place_id}@them.co.uk`, created_at: at, updated_at: at,
});
const message = (DB, id, place_id, kind, at) => insert(DB, "messages", {
  id, place_id, direction: "out", kind, author: "nik", to_addr: `${place_id}@them.co.uk`, subject: "Your website",
  body: "Hi Mark, ...", status: "sent", sent_at: at, created_at: at,
});
const researched = (DB, place_id, at) => insert(DB, "research", {
  place_id, status: "done", grade: "A", points: '{"need":4,"means":4,"reach":4,"fit":4}', grade_reason: "Good fit.",
  angle: '[{"fact":"x","source_url":"https://x.co.uk"}]', opener: "Saw your reviews.",
  owner: '{"first":"Mark","full":"Mark Old","source_url":"https://x.co.uk","confident":true}',
  best_email: `${place_id}@them.co.uk`, best_email_why: "On their contact page.",
  emails: `[{"email":"${place_id}@them.co.uk","source_url":"https://x.co.uk","where":"contact"}]`,
  copy: '{"headline":"x"}', site_review: '{"verdict":"ok"}', too_big: 1, notes: "Mark Old, 07700 900111", searched: '["fb"]',
  queued_at: at, researched_at: at,
});
const call = (DB, id, place_id, at, extra = {}) => insert(DB, "calls", {
  id, place_id, slot_at: at, status: "done", phone: "07700 900111", note: "", created_at: at, updated_at: at, ...extra,
});
const todo = (DB, dedupe, kind, place_id, at, extra = {}) => insert(DB, "todos", {
  id: `t-${dedupe}`, kind, place_id, title: `Todo ${dedupe}`, dedupe, created_at: at, ...extra,
});

async function seedAll() {
  const DB = fakeD1();
  // old1: last contact 2025-10-20 (a day and a half before the cutoff)
  await lead(DB, "old1");
  await prospect(DB, "old1", "lost", "2025-10-20T09:00:00Z");
  await message(DB, "old1-first", "old1", "first", "2025-08-01T09:00:00Z");
  await message(DB, "old1-f9", "old1", "followup", "2025-10-20T09:00:00Z");
  await researched(DB, "old1", "2025-07-30T07:00:00Z");
  await insert(DB, "suppression", { value: "old1@them.co.uk", kind: "email", reason: "opt_out", created_at: "2025-10-20T09:00:00Z" });
  await insert(DB, "style_examples", {
    id: "sent:old1-first", kind: "example", situation: "first email", body: "Hi Mark, ...", source: "nik_sent", created_at: "2025-08-01T09:00:00Z",
  });
  await call(DB, "call-old1", "old1", "2025-03-03T10:00:00Z", { note: "wants a quote in spring" });
  await todo(DB, "escalation:old1-first", "escalation", "old1", "2025-03-03T10:00:00Z", {
    detail: "They wrote: how much is it?", draft: "Hi Mark, it's around £2,000.",
  });
  // old2: research only, 2025-09-01
  await lead(DB, "old2");
  await researched(DB, "old2", "2025-09-01T07:00:00Z");
  // recent: last contact 2025-11-01 (11 months ago)
  await prospect(DB, "recent", "emailed", "2025-09-01T09:00:00Z");
  await message(DB, "recent-1", "recent", "first", "2025-11-01T09:00:00Z");
  await researched(DB, "recent", "2025-09-01T07:00:00Z");
  await call(DB, "call-recent", "recent", "2025-03-03T10:00:00Z");
  await todo(DB, "escalation:recent-1", "escalation", "recent", "2025-03-03T10:00:00Z");
  // client1: a client, last contact 2025-01-10
  await prospect(DB, "client1", "won", "2025-01-10T09:00:00Z");
  await message(DB, "client1-1", "client1", "first", "2025-01-10T09:00:00Z");
  await insert(DB, "clients", {
    id: "c1", name: "Client One", place_id: "client1", package: "full", build_fee_pence: 195000, monthly_pence: 24900,
    free_days: 60, paid_on: "2025-01-10", created_at: "2025-01-10T10:00:00Z",
  });
  await call(DB, "call-client1", "client1", "2025-01-10T10:00:00Z");
  await todo(DB, "escalation:client1-1", "escalation", "client1", "2025-01-10T10:00:00Z");
  // nodate: research with no dates at all
  await insert(DB, "research", { place_id: "nodate", status: "queued" });
  // Nik's own Voice example, tied to no lead
  await insert(DB, "style_examples", {
    id: "nik-1", kind: "example", situation: "they ask the price", body: "It's around £2,000.", source: "nik_written", created_at: T,
  });
  // Todos with no lead
  await todo(DB, "setup:mailbox", "setup", null, "2025-01-01T09:00:00Z");
  await todo(DB, "calls-day:2025-03-03", "call", null, "2025-03-03T06:00:00Z", { title: "Today's calls: 11:00 Mark (Old One Roofing)" });
  await todo(DB, "calls-day:2026-10-20", "call", null, "2026-10-20T06:00:00Z");
  return DB;
}

test("deletes only non-clients last contacted over 12 months ago", async () => {
  const DB = await seedAll();
  assert.equal(purgeCutoff(NOW), "2025-10-21T23:00:00Z");
  const r = await purgeOld(DB, NOW, { maxRounds: 5 });
  assert.deepEqual(r, { purged: 2, done: true });
  const left = async (t) => (await DB.prepare(`SELECT DISTINCT place_id FROM ${t} ORDER BY place_id`).all()).results.map((x) => x.place_id);
  assert.deepEqual(await left("prospects"), ["client1", "recent"]);
  assert.deepEqual(await left("messages"), ["client1", "recent"]);
  assert.deepEqual(await left("research"), ["nodate", "old1", "old2", "recent"]);
  for (const r of (await DB.prepare("SELECT * FROM research WHERE place_id IN ('old1','old2')").all()).results) {
    assert.equal(r.status, "skipped");
    assert.equal(r.notes, "Skipped: details deleted 12 months after last contact.");
    assert.equal(r.too_big, 0); assert.equal(r.queued_at, null); assert.equal(r.researched_at, null);
    for (const col of ["grade", "points", "grade_reason", "angle", "opener", "owner", "best_email", "best_email_why",
      "emails", "copy", "site_review", "searched"]) assert.equal(r[col], null, col);
  }
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM suppression").first()).n, 1);
  // Also seeded: a Voice page example `nik-1` (source nik_written, no lead). Old1's first email as a style example
  // goes with its messages; Nik's own examples stay.
  assert.deepEqual((await DB.prepare("SELECT id FROM style_examples ORDER BY id").all()).results.map((x) => x.id), ["nik-1"]);
  // Stage 8's calls (their phone, Nik's note) and stage 7's Todos (their words, Claude's draft) go with the lead;
  // a recent lead's and a client's stay. Todos without a lead stay, except a day list older than the cutoff.
  assert.deepEqual((await DB.prepare("SELECT id FROM calls ORDER BY id").all()).results.map((x) => x.id), ["call-client1", "call-recent"]);
  assert.deepEqual((await DB.prepare("SELECT dedupe FROM todos ORDER BY dedupe").all()).results.map((x) => x.dedupe),
    ["calls-day:2026-10-20", "escalation:client1-1", "escalation:recent-1", "setup:mailbox"]);
  assert.deepEqual(await purgeOld(DB, NOW, { maxRounds: 5 }), { purged: 0, done: true });   // never selected again
  // The scraped listings are kept (the scraper owns them), and so is the client.
  assert.deepEqual(await left("leads"), ["old1", "old2"]);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM clients").first()).n, 1);
});

test("a purged lead isn't queued for research again", async () => {
  // a fresh fakeD1: old2 alone (its `leads` row, score 60, and its research row researched 2025-09-01T07:00Z)
  const DB = fakeD1();
  await lead(DB, "old2");
  await researched(DB, "old2", "2025-09-01T07:00:00Z");
  assert.deepEqual(await purgeOld(DB, NOW, { maxRounds: 5 }), { purged: 1, done: true });
  await setSetting(DB, "research:enqueued_at", "2026-10-22T05:05:00Z");   // the previous day's enqueue
  const fired = [];
  const fire = async (db, name, text) => { fired.push(text); return { ok: true, status: 200 }; };
  const out = await runDailyFind(DB, {}, new Date("2026-10-23T05:05:00Z"), { start: async () => "", fire });   // 06:05 UK, next morning
  assert.match(out, /^queued 0(;|$)/);
  assert.deepEqual(fired, []);
  assert.equal((await DB.prepare("SELECT status FROM research WHERE place_id = 'old2'").first()).status, "skipped");
});

test("big backlogs go in rounds and stop at the budget", async () => {
  // seed 95 research-only leads researched 2025-01-01
  const DB = fakeD1();
  for (let i = 0; i < 95; i++) {
    await insert(DB, "research", { place_id: `bulk-${String(i).padStart(3, "0")}`, status: "done", researched_at: "2025-01-01T09:00:00Z" });
  }
  assert.equal(PURGE_BATCH, 90);
  const counter = countingDB(DB);
  assert.deepEqual(await purgeOld(counter.DB, NOW, { maxRounds: 1 }), { purged: 90, done: false });
  assert.equal(counter.used(), 7, "a round is 1 select + a batch of 6");
  assert.deepEqual(await purgeOld(DB, NOW, { maxRounds: 1 }), { purged: 5, done: true });
});

test("runs once a month", async () => {
  const DB = fakeD1();
  const ctx = { DB, env: {}, now: NOW, budget: { left: () => 30 } };
  assert.equal(await purgeStep.run(ctx), "nothing to purge");
  assert.equal(await getSetting(DB, "purge:month"), "2026-10");
  assert.equal(await purgeStep.run({ ...ctx, now: new Date("2026-10-30T12:00:00Z") }), "done this month");
  assert.equal(await purgeStep.run({ ...ctx, budget: { left: () => 3 } }), "done this month");
  await setSetting(DB, "purge:month", "2026-09");
  assert.equal(await purgeStep.run({ ...ctx, budget: { left: () => 8 } }), "deferred");   // floor((8 - 2) / 7) = 0 rounds
});

// Part A also deletes processed inbound_raw rows older than the cutoff (their headers hold From and Subject), always
// keeping the newest row (Setup's "Last email received" reads it by rowid). It's done once, when the month is finished.
test("old processed inbound mail goes too, but never the newest row", async () => {
  const DB = fakeD1();
  const raw = (id, received_at, processed_at) => insert(DB, "inbound_raw", {
    id, received_at, headers: '{"from":"Mark <old1@them.co.uk>","subject":"Re: Your website"}', raw: "", processed_at, outcome: processed_at ? "human" : null,
  });
  await raw("old-done", "2025-06-01T09:00:00Z", "2025-06-01T09:05:00Z");
  await raw("old-waiting", "2025-06-02T09:00:00Z", null);
  await raw("recent-done", "2026-10-01T09:00:00Z", "2026-10-01T09:05:00Z");
  await raw("newest-old", "2025-07-01T09:00:00Z", "2025-07-01T09:05:00Z"); // the last row saved, though old
  await prospect(DB, "old9", "lost", "2025-06-01T09:00:00Z");
  await prospect(DB, "fresh", "emailed", "2026-10-01T09:00:00Z");
  const counter = countingDB(DB);
  const ctx = { DB: counter.DB, env: {}, now: NOW, budget: { left: () => 30 - counter.used() } };
  assert.equal(await purgeStep.run(ctx), "purged 1 leads");
  assert.ok(counter.used() <= 30, `used ${counter.used()}`);
  assert.deepEqual((await DB.prepare("SELECT id FROM inbound_raw ORDER BY id").all()).results.map((x) => x.id),
    ["newest-old", "old-waiting", "recent-done"]);
  assert.equal(await getSetting(DB, "purge:month"), "2026-10");
  assert.deepEqual((await DB.prepare("SELECT place_id FROM prospects").all()).results.map((x) => x.place_id), ["fresh"]);
});

// Stage 10: every client site's privacy page says "Enquiries are kept for 12 months." (09-build.md section 8), so the
// month's finishing batch also deletes site_leads received before the cutoff and the enquiry emails about them. The
// client itself, its other mail and recent enquiries stay.
test("client-site enquiries older than 12 months go, with their enquiry emails; recent ones and other client mail stay", async () => {
  const DB = fakeD1();
  await lead(DB, "pc");
  await insert(DB, "clients", {
    id: "c1", name: "Smith Roofing", place_id: "pc", package: "full", build_fee_pence: 195000, monthly_pence: 24900,
    free_days: 60, paid_on: "2025-01-01", created_at: T,
  });
  const enquiry = (id, at, message_id) => insert(DB, "site_leads", {
    id, client_id: "c1", source: "form", name: "Dave", phone: "07700 900123", message: "Leaking roof", page: "/contact",
    notified_at: message_id ? at : null, message_id, created_at: at, updated_at: at,
  });
  await enquiry("old1", "2025-06-01T09:00:00Z", "enquiry:old1");
  await enquiry("old2", "2025-10-21T22:59:59Z", null); // a second before the cutoff, never emailed
  await enquiry("new1", "2025-10-21T23:00:00Z", "enquiry:new1"); // exactly at the cutoff: kept
  await message(DB, "enquiry:old1", "pc", "system", "2025-06-01T09:00:00Z");
  await message(DB, "enquiry:new1", "pc", "system", "2025-10-21T23:00:00Z");
  await message(DB, "welcome:c1", "pc", "system", "2025-01-01T09:00:00Z"); // the client's own old mail stays
  const counter = countingDB(DB);
  assert.equal(await purgeStep.run({ DB: counter.DB, env: {}, now: NOW, budget: { left: () => 30 - counter.used() } }), "nothing to purge");
  assert.deepEqual((await DB.prepare("SELECT id FROM site_leads ORDER BY id").all()).results.map((x) => x.id), ["new1"]);
  assert.deepEqual((await DB.prepare("SELECT id FROM messages ORDER BY id").all()).results.map((x) => x.id), ["enquiry:new1", "welcome:c1"]);
  assert.ok(await DB.prepare("SELECT id FROM clients WHERE id = 'c1'").first(), "the client stays");
  assert.equal(await getSetting(DB, "purge:month"), "2026-10");
});

test("a backlog bigger than the budget says more next tick and finishes later", async () => {
  const DB = fakeD1();
  for (let i = 0; i < 95; i++) {
    await insert(DB, "research", { place_id: `bulk-${String(i).padStart(3, "0")}`, status: "done", researched_at: "2025-01-01T09:00:00Z" });
  }
  const counter = countingDB(DB);
  const budget = { left: () => 12 - counter.used() }; // floor((12 - 2) / 7) = 1 round
  assert.equal(await purgeStep.run({ DB: counter.DB, env: {}, now: NOW, budget }), "purged 90 leads, more next tick");
  assert.ok(counter.used() <= 12, `used ${counter.used()}`);
  assert.equal(await getSetting(DB, "purge:month"), null);
  assert.equal(await purgeStep.run({ DB, env: {}, now: NOW, budget: { left: () => 30 } }), "purged 5 leads");
  assert.equal(await getSetting(DB, "purge:month"), "2026-10");
});

test("purgeCutoff: the same UK date a year earlier, 29 Feb → 28 Feb, GMT and BST midnights", () => {
  assert.equal(purgeCutoff(new Date("2028-02-29T12:00:00Z")), "2027-02-28T00:00:00Z");
  assert.equal(purgeCutoff(new Date("2026-01-15T00:30:00Z")), "2025-01-15T00:00:00Z");
  assert.equal(purgeCutoff(new Date("2026-06-30T23:30:00Z")), "2025-06-30T23:00:00Z"); // 00:30 UK on 1 July
});

test("the step is registered after calls and before health, hourly", () => {
  const names = STEPS.map((s) => s.name);
  assert.equal(names.indexOf("purge"), names.indexOf("health") - 1);
  assert.ok(names.indexOf("calls") < names.indexOf("purge"));
  assert.equal(purgeStep.name, "purge");
  assert.equal(purgeStep.everyMinutes, 60);
  assert.ok(STEPS.includes(purgeStep));
});

// A lead with a prospect and messages but no research row (Nik's "Start outreach" works on any lead with an email,
// and only leads scoring 35 or more are queued) gets the data-free skipped row too: stage 1's queue takes any lead with
// no research row, so without it the lead would be researched and emailed again once its score reached 35.
test("a purged lead that was never researched gets the skipped row, so it's never queued", async () => {
  const DB = fakeD1();
  await lead(DB, "old3"); // score 60
  await prospect(DB, "old3", "lost", "2025-06-01T09:00:00Z");
  await message(DB, "old3-first", "old3", "first", "2025-06-01T09:00:00Z");
  assert.deepEqual(await purgeOld(DB, NOW, { maxRounds: 5 }), { purged: 1, done: true });
  const row = await DB.prepare("SELECT * FROM research WHERE place_id = 'old3'").first();
  assert.equal(row.status, "skipped");
  assert.equal(row.notes, "Skipped: details deleted 12 months after last contact.");
  assert.equal(row.too_big, 0); assert.equal(row.queued_at, null); assert.equal(row.researched_at, null);
  for (const col of ["grade", "points", "grade_reason", "angle", "opener", "owner", "best_email", "best_email_why",
    "emails", "copy", "site_review", "searched"]) assert.equal(row[col], null, col);
  assert.equal(await enqueueResearch(DB, new Date("2026-10-23T05:05:00Z")), 0);
  assert.deepEqual(await purgeOld(DB, NOW, { maxRounds: 5 }), { purged: 0, done: true });
});

// The runner always makes the tick beat after the last step, so finishing the month (a batch of 5 statements) waits for a tick
// with room for the beat too; it never spends the beat's query.
test("finishing the month always leaves the tick's beat its query", async () => {
  const DB = fakeD1();
  for (let i = 0; i < 5; i++) {
    await insert(DB, "research", { place_id: `bulk-${i}`, status: "done", researched_at: "2025-01-01T09:00:00Z" });
  }
  const counter = countingDB(DB);
  const budget = { left: () => 10 - counter.used() }; // the least a step is started with: floor((9 - 2) / 7) = 1 round
  assert.equal(await purgeStep.run({ DB: counter.DB, env: {}, now: NOW, budget }), "purged 5 leads, more next tick");
  assert.ok(budget.left() >= 1, `left ${budget.left()}`);
  assert.equal(await getSetting(DB, "purge:month"), null);
  assert.equal(await purgeStep.run({ DB, env: {}, now: NOW, budget: { left: () => 10 } }), "nothing to purge");
  assert.equal(await getSetting(DB, "purge:month"), "2026-10");
});

// A round runs only when some lead is due, so the month's finishing batch deletes old day lists too: a lead on a day list
// can be purged in a month when the list isn't yet older than the cutoff (their last email came before the call day),
// and in a later month with nobody to purge the list must still go. Other Todos without a lead stay.
test("old day lists go even in a month with nobody to purge", async () => {
  const DB = fakeD1();
  await todo(DB, "setup:mailbox", "setup", null, "2025-01-01T09:00:00Z");
  await todo(DB, "calls-day:2025-03-03", "call", null, "2025-03-03T06:00:00Z", { title: "Today's calls: 11:00 Mark (Old One Roofing)" });
  await todo(DB, "calls-day:2026-10-20", "call", null, "2026-10-20T06:00:00Z");
  await prospect(DB, "fresh", "emailed", "2026-10-01T09:00:00Z");
  const counter = countingDB(DB);
  assert.equal(await purgeStep.run({ DB: counter.DB, env: {}, now: NOW, budget: { left: () => 30 - counter.used() } }), "nothing to purge");
  assert.deepEqual((await DB.prepare("SELECT dedupe FROM todos ORDER BY dedupe").all()).results.map((x) => x.dedupe),
    ["calls-day:2026-10-20", "setup:mailbox"]);
  assert.equal(counter.used(), 1 + 1 + 5, "the month check, one select, and the finishing batch of 5");
  assert.equal(await getSetting(DB, "purge:month"), "2026-10");
});
