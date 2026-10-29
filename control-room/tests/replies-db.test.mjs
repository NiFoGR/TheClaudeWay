// Stage 7 replies (db): the human inbound hook (onHumanInbound) and the stage events it fires.
// Run: node --test control-room/tests/replies-db.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { processInbound } from "../functions/_lib/mail/inbound-db.js";
import { applyStageEvent } from "../functions/_lib/prospects.js";
import { REOPEN_REASONS, escalateMessage, onHumanInbound, recordReply } from "../functions/_lib/replies-db.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const NOW = new Date("2026-10-21T10:00:00Z");
const EARLIER = "2026-10-19T07:01:03Z";

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}
const one = (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const all = async (DB, sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results;

// An inbound human message waiting for a reply, stored the way stage 0's processInbound stores it.
const inboundRow = (id, received_at, extra = {}) => ({
  id, place_id: "p1", client_id: null, mailbox_id: "mb1", direction: "in", kind: "inbound", author: "them",
  to_addr: "nik@aetoswebsites.com", from_addr: "mark@greenleaf.co.uk", subject: "Re: Your new website",
  body: `Hi Nik, message ${id}`, message_id: `<${id}@mail.greenleaf.co.uk>`, in_reply_to: "<orig@aetoswebsites.com>",
  refs: "<orig@aetoswebsites.com>", status: "received", received_at, class: "human", needs_reply: 1,
  created_at: received_at, ...extra,
});

const m1 = inboundRow("m1", "2026-10-21T08:14:23Z");
const m2 = inboundRow("m2", "2026-10-21T08:20:00Z");
const m3 = inboundRow("m3", "2026-10-21T08:30:00Z");
const m4 = inboundRow("m4", "2026-10-21T08:40:00Z");
const m5 = inboundRow("m5", "2026-10-21T08:50:00Z", { place_id: null });
const m6 = inboundRow("m6", "2026-10-21T09:00:00Z");

async function seeded() {
  const DB = fakeD1();
  await insert(DB, "leads", {
    place_id: "p1", name: "GREEN LEAF LANDSCAPES LTD", trade: "landscaper", search_town: "Leeds",
    first_seen_at: EARLIER, updated_at: EARLIER,
  });
  await insert(DB, "prospects", {
    place_id: "p1", stage: "emailed", stage_at: EARLIER, email: "mark@greenleaf.co.uk", mailbox_id: "mb1",
    root_message_id: "<orig@aetoswebsites.com>", first_sent_at: EARLIER, next_followup_at: "2026-10-22T08:00:00Z",
    created_at: EARLIER, updated_at: EARLIER,
  });
  await insert(DB, "messages", {
    id: "fu1", place_id: "p1", mailbox_id: "mb1", direction: "out", kind: "followup", author: "system",
    to_addr: "mark@greenleaf.co.uk", body: "Hi Mark, just checking", status: "queued", due_at: "2026-10-22T08:00:00Z",
    created_at: EARLIER,
  });
  for (const m of [m1, m2, m3, m4, m5, m6]) await insert(DB, "messages", m);
  await insert(DB, "clients", {
    id: "c1", name: "Green Leaf Landscapes", place_id: "p1", package: "full", build_fee_pence: 195000,
    monthly_pence: 24900, free_days: 60, paid_on: "2026-10-01", created_at: EARLIER,
  });
  return DB;
}

test("REOPEN_REASONS is the overview's list", () => {
  assert.deepEqual(REOPEN_REASONS, ["not_now", "not_interested", "sequence_done", "call"]);
});

// --- Task 6, Step 1 (as written in the plan) -----------------------------------------------------------------------

test("onHumanInbound: replied, client, opted out, reopened, unmatched", async () => {
  const DB = await seeded();
  const setStage = (placeId, stage, lostReason = null) =>
    DB.prepare("UPDATE prospects SET stage = ?, lost_reason = ? WHERE place_id = ?").bind(stage, lostReason, placeId).run();

  assert.equal(await onHumanInbound(DB, m1, NOW), "replied");
  const p = await one(DB, "SELECT * FROM prospects WHERE place_id='p1'");
  assert.equal(p.stage, "replied"); assert.equal(p.next_followup_at, null); assert.equal(p.last_inbound_at, m1.received_at);
  assert.equal((await one(DB, "SELECT status FROM messages WHERE kind='followup'")).status, "cancelled");
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id='m1'")).needs_reply, 1);
  // a paying client
  await setStage("p1", "won"); assert.equal(await onHumanInbound(DB, m2, NOW), "client");
  assert.equal((await one(DB, "SELECT needs_reply, client_id FROM messages WHERE id='m2'")).needs_reply, 0);
  assert.equal((await one(DB, "SELECT client_id FROM messages WHERE id='m2'")).client_id, "c1");
  assert.equal((await one(DB, "SELECT title FROM todos WHERE dedupe='client-mail:m2'")).title, "Your client Green Leaf Landscapes emailed: read and reply yourself");
  // opted out
  await setStage("p1", "lost", "opt_out"); assert.equal(await onHumanInbound(DB, m3, NOW), "opted_out");
  assert.equal((await one(DB, "SELECT title FROM todos WHERE dedupe='optout-mail:m3'")).title, "Green Leaf Landscapes wrote back after opting out: read and reply yourself");
  // said not now earlier: answered, and back to replied (reopen)
  await setStage("p1", "lost", "not_now"); assert.equal(await onHumanInbound(DB, m4, NOW), "replied");
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "replied");
  // sequence ended with no reply, then they write: reopen too
  await setStage("p1", "lost", "sequence_done"); assert.equal(await onHumanInbound(DB, m6, NOW), "replied");
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "replied");
  // no prospect
  assert.equal(await onHumanInbound(DB, { ...m5, place_id: null }, NOW), "unmatched");
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id='m5'")).needs_reply, 0);
  // stage 0's applyStageEvent sets lost_reason
  assert.equal((await applyStageEvent(DB, "p1", "said_no", NOW, { lost_reason: "not_interested" })).to, "lost");
});

// --- Edges around the plan's test --------------------------------------------------------------------------------

test("client and opt-out todos: escalation kind, due now, linked to the thread, their words as text", async () => {
  const DB = await seeded();
  await DB.prepare("UPDATE prospects SET stage = 'won' WHERE place_id = 'p1'").run();
  await onHumanInbound(DB, m2, NOW);
  const t = await one(DB, "SELECT * FROM todos WHERE dedupe = 'client-mail:m2'");
  assert.equal(t.kind, "escalation");
  assert.equal(t.status, "open");
  assert.equal(t.due_at, "2026-10-21T10:00:00Z");
  assert.equal(t.link, "/#/replies/p1");
  assert.equal(t.place_id, "p1");
  assert.equal(t.client_id, "c1");
  assert.equal(t.draft, null); // no draft: Nik replies himself
  assert.match(t.detail, /Hi Nik, message m2/);
  // a won prospect is left as it is
  const p = await one(DB, "SELECT stage, next_followup_at FROM prospects WHERE place_id = 'p1'");
  assert.equal(p.stage, "won");

  await DB.prepare("UPDATE prospects SET stage = 'lost', lost_reason = 'bounce' WHERE place_id = 'p1'").run();
  assert.equal(await onHumanInbound(DB, m3, NOW), "opted_out");
  const o = await one(DB, "SELECT * FROM todos WHERE dedupe = 'optout-mail:m3'");
  assert.equal(o.kind, "escalation");
  assert.equal(o.link, "/#/replies/p1");
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'm3'")).needs_reply, 0);
  assert.equal((await one(DB, "SELECT stage, lost_reason FROM prospects")).lost_reason, "bounce"); // never reopened
});

test("safe to repeat: a second run for the same message adds no second todo and changes nothing", async () => {
  const DB = await seeded();
  await DB.prepare("UPDATE prospects SET stage = 'won' WHERE place_id = 'p1'").run();
  assert.equal(await onHumanInbound(DB, m2, NOW), "client");
  assert.equal(await onHumanInbound(DB, m2, NOW), "client");
  assert.equal((await all(DB, "SELECT id FROM todos")).length, 1);

  const DB2 = await seeded();
  assert.equal(await onHumanInbound(DB2, m1, NOW), "replied");
  assert.equal(await onHumanInbound(DB2, m1, NOW), "replied");
  const p = await one(DB2, "SELECT stage, last_inbound_at FROM prospects");
  assert.equal(p.stage, "replied");
  assert.equal(p.last_inbound_at, m1.received_at);
});

test("last_inbound_at never moves backwards; a needs_nik thread stays needs_nik", async () => {
  const DB = await seeded();
  await DB.prepare("UPDATE prospects SET stage = 'needs_nik', last_inbound_at = '2026-10-21T09:30:00Z' WHERE place_id = 'p1'").run();
  assert.equal(await onHumanInbound(DB, m1, NOW), "replied");
  const p = await one(DB, "SELECT stage, last_inbound_at, next_followup_at FROM prospects");
  assert.equal(p.stage, "needs_nik");
  assert.equal(p.last_inbound_at, "2026-10-21T09:30:00Z");
  assert.equal(p.next_followup_at, null);
});

test("a lead without a name: the todo names the sender's address instead", async () => {
  const DB = await seeded();
  await DB.prepare("DELETE FROM leads").run();
  await DB.prepare("DELETE FROM clients").run();
  await DB.prepare("UPDATE prospects SET stage = 'lost', lost_reason = 'opt_out' WHERE place_id = 'p1'").run();
  assert.equal(await onHumanInbound(DB, m3, NOW), "opted_out");
  assert.equal((await one(DB, "SELECT title FROM todos WHERE dedupe = 'optout-mail:m3'")).title,
    "mark@greenleaf.co.uk wrote back after opting out: read and reply yourself");
});

// --- Wired into stage 0's inbound step -----------------------------------------------------------------------------

const DIR = new URL("./fixtures/mail/", import.meta.url);
function relayHeaders(raw) {
  const block = raw.split(/\r?\n\r?\n/)[0];
  const h = new Headers();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return JSON.stringify(Object.fromEntries(h));
}
function withFrom(raw, from) {
  return raw.replace(/^From:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/im, `From: ${from}`);
}
async function addRaw(DB, id, raw) {
  await DB.prepare("INSERT INTO inbound_raw (id, received_at, envelope_from, envelope_to, headers, raw) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, "2026-10-21T08:14:23Z", "someone@example.com", "replies@aetos-mail.co.uk", relayHeaders(raw), raw)
    .run();
}

test("processInbound runs the hook for a prospect's human reply: a not_now lead is reopened, follow-ups stop", async () => {
  const DB = await seeded();
  await DB.prepare("DELETE FROM messages WHERE direction = 'in'").run();
  await DB.prepare("UPDATE prospects SET stage = 'lost', lost_reason = 'not_now' WHERE place_id = 'p1'").run();
  const raw = withFrom(readFileSync(new URL("gmail-reply.eml", DIR), "utf8"), "Mark <mark@greenleaf.co.uk>");
  await addRaw(DB, "raw1", raw);
  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });
  const p = await one(DB, "SELECT stage, lost_reason, next_followup_at, last_inbound_at FROM prospects");
  assert.equal(p.stage, "replied");
  assert.equal(p.lost_reason, null);
  assert.equal(p.next_followup_at, null);
  assert.equal(p.last_inbound_at, "2026-10-21T08:14:23Z");
  assert.equal((await one(DB, "SELECT status FROM messages WHERE id = 'fu1'")).status, "cancelled");
  const m = await one(DB, "SELECT needs_reply FROM messages WHERE id = 'raw1'");
  assert.equal(m.needs_reply, 1);
});

test("processInbound: a won prospect's email gets the client-mail todo and needs no reply", async () => {
  const DB = await seeded();
  await DB.prepare("DELETE FROM messages WHERE direction = 'in'").run();
  await DB.prepare("UPDATE prospects SET stage = 'won' WHERE place_id = 'p1'").run();
  const raw = withFrom(readFileSync(new URL("gmail-reply.eml", DIR), "utf8"), "Mark <mark@greenleaf.co.uk>");
  await addRaw(DB, "raw1", raw);
  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });
  const m = await one(DB, "SELECT needs_reply, client_id FROM messages WHERE id = 'raw1'");
  assert.equal(m.needs_reply, 0);
  assert.equal(m.client_id, "c1");
  const todos = await all(DB, "SELECT dedupe FROM todos");
  assert.deepEqual(todos.map((t) => t.dedupe), ["client-mail:raw1"]);
});

// --- Review additions --------------------------------------------------------------------------------------------

test("every REOPEN_REASONS reason reopens; any other stop keeps the lead lost and out of Claude's hands", async () => {
  for (const reason of REOPEN_REASONS) {
    const DB = await seeded();
    await DB.prepare("UPDATE prospects SET stage = 'lost', lost_reason = ? WHERE place_id = 'p1'").bind(reason).run();
    assert.equal(await onHumanInbound(DB, m4, NOW), "replied", reason);
    const p = await one(DB, "SELECT stage, lost_reason FROM prospects");
    assert.deepEqual({ ...p }, { stage: "replied", lost_reason: null }, reason);
    assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'm4'")).needs_reply, 1, reason);
    assert.equal((await all(DB, "SELECT id FROM todos")).length, 0, reason);
  }
});

test("a todo link encodes the place_id, so a drill or test lead's thread opens", async () => {
  const DB = await seeded();
  await DB.prepare("UPDATE prospects SET stage = 'won' WHERE place_id = 'p1'").run();
  await onHumanInbound(DB, m2, NOW);
  assert.equal((await one(DB, "SELECT link FROM todos WHERE dedupe = 'client-mail:m2'")).link, "/#/replies/p1");

  const DB2 = fakeD1();
  await insert(DB2, "prospects", {
    place_id: "test:a/b?c", stage: "lost", lost_reason: "opt_out", stage_at: EARLIER, email: "me@example.com",
    created_at: EARLIER, updated_at: EARLIER,
  });
  const m = inboundRow("mt", "2026-10-21T08:14:23Z", { place_id: "test:a/b?c" });
  await insert(DB2, "messages", m);
  assert.equal(await onHumanInbound(DB2, m, NOW), "opted_out");
  assert.equal((await one(DB2, "SELECT link FROM todos")).link, "/#/replies/test%3Aa%2Fb%3Fc");
});

test("processInbound: a client writing from their billing address (outcome client) gets stage 0's todo only", async () => {
  // place_id is the won prospect's (from clients.place_id), but the hook must not run: no second, client-mail todo.
  const DB = await seeded();
  await DB.prepare("DELETE FROM messages WHERE direction = 'in'").run();
  await DB.prepare("UPDATE prospects SET stage = 'won' WHERE place_id = 'p1'").run();
  await insert(DB, "client_links", { client_id: "c1", stripe_customer: "cus_1", email: "accounts@greenleaf.co.uk" });
  const raw = withFrom(readFileSync(new URL("gmail-reply.eml", DIR), "utf8"), "Accounts <accounts@greenleaf.co.uk>");
  await addRaw(DB, "raw1", raw);
  assert.deepEqual(await processInbound(DB, NOW), { client: 1 });
  assert.deepEqual((await all(DB, "SELECT dedupe FROM todos")).map((t) => t.dedupe), ["escalation:client:raw1"]);
  const m = await one(DB, "SELECT place_id, needs_reply FROM messages WHERE id = 'raw1'");
  assert.deepEqual({ ...m }, { place_id: "p1", needs_reply: 0 });
});

test("processInbound: a paying client's \"no thanks\" is read as human mail for Nik, never an opt-out", async () => {
  const DB = await seeded();
  await DB.prepare("DELETE FROM messages WHERE direction = 'in'").run();
  await DB.prepare("UPDATE prospects SET stage = 'won' WHERE place_id = 'p1'").run();
  const raw = withFrom(readFileSync(new URL("no-thanks.eml", DIR), "utf8"), "Mark <mark@greenleaf.co.uk>");
  await addRaw(DB, "raw1", raw);
  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "won");
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM suppression")).n, 0);
  const m = await one(DB, "SELECT class, needs_reply, client_id FROM messages WHERE id = 'raw1'");
  assert.deepEqual({ ...m }, { class: "human", needs_reply: 0, client_id: "c1" });
  assert.deepEqual((await all(DB, "SELECT dedupe FROM todos")).map((t) => t.dedupe), ["client-mail:raw1"]);
});

test("processInbound: an opted-out lead writes back: Nik's todo, nothing waits for Claude, nothing reopened", async () => {
  const DB = await seeded();
  await DB.prepare("DELETE FROM messages WHERE direction = 'in'").run();
  await DB.prepare("UPDATE prospects SET stage = 'lost', lost_reason = 'opt_out' WHERE place_id = 'p1'").run();
  const raw = withFrom(readFileSync(new URL("gmail-reply.eml", DIR), "utf8"), "Mark <mark@greenleaf.co.uk>");
  await addRaw(DB, "raw1", raw);
  assert.deepEqual(await processInbound(DB, NOW), { human: 1 });
  assert.deepEqual({ ...(await one(DB, "SELECT stage, lost_reason FROM prospects")) }, { stage: "lost", lost_reason: "opt_out" });
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'raw1'")).needs_reply, 0);
  assert.equal((await one(DB, "SELECT title FROM todos WHERE dedupe = 'optout-mail:raw1'")).title,
    "Green Leaf Landscapes wrote back after opting out: read and reply yourself");
});

// --- Second review: a second try after the email was answered ----------------------------------------------------

test("an email already handled (a second try after Claude answered it) fires no stage event and files no todo", async () => {
  const DB = await seeded();
  // Claude answered m4 "not now": the lead is lost (not_now) and m4 handled. Stage 0 runs the hook for m4 again.
  await DB.prepare("UPDATE prospects SET stage = 'lost', lost_reason = 'not_now', next_followup_at = NULL WHERE place_id = 'p1'").run();
  await DB.prepare("UPDATE messages SET needs_reply = 0, handled_at = '2026-10-21T08:45:00Z', intent = 'not_now' WHERE id = 'm4'").run();
  assert.equal(await onHumanInbound(DB, m4, NOW), "replied");
  assert.deepEqual({ ...(await one(DB, "SELECT stage, lost_reason, last_inbound_at FROM prospects")) },
    { stage: "lost", lost_reason: "not_now", last_inbound_at: m4.received_at });
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'm4'")).needs_reply, 0);
  assert.equal((await one(DB, "SELECT status FROM messages WHERE id = 'fu1'")).status, "cancelled"); // still stopped

  // Claude answered m1, then they opted out by a later email: no read-it-yourself todo for the answered one.
  await DB.prepare("UPDATE prospects SET lost_reason = 'opt_out' WHERE place_id = 'p1'").run();
  await DB.prepare("UPDATE messages SET needs_reply = 0, handled_at = '2026-10-21T08:20:00Z' WHERE id = 'm1'").run();
  assert.equal(await onHumanInbound(DB, m1, NOW), "opted_out");
  assert.equal((await all(DB, "SELECT id FROM todos")).length, 0);
});

test("processInbound: a row cut off after it was stored, answered by Claude (a call booked), then retried: the call stands", async () => {
  const DB = await seeded();
  await DB.prepare("DELETE FROM messages WHERE direction = 'in'").run();
  const raw = withFrom(readFileSync(new URL("gmail-reply.eml", DIR), "utf8"), "Mark <mark@greenleaf.co.uk>");
  await addRaw(DB, "raw1", raw);
  // D1 fails on the hook's first query: the row is stored and left for a second try.
  const flaky = {
    ...DB,
    prepare: (sql) => (/handled_at FROM messages WHERE id = \?2/.test(sql)
      ? { bind: () => ({ first: async () => { throw new Error("D1 hiccup"); } }) }
      : DB.prepare(sql)),
  };
  assert.deepEqual(await processInbound(flaky, NOW), { retry: 1 });
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'raw1'")).needs_reply, 1);
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "emailed");
  // Before the next tick Claude answers it and books a call.
  await DB.prepare("UPDATE messages SET needs_reply = 0, handled_at = '2026-10-21T10:02:00Z', intent = 'confirms_slot' WHERE id = 'raw1'").run();
  await DB.prepare("UPDATE prospects SET stage = 'call_booked' WHERE place_id = 'p1'").run();
  assert.deepEqual(await processInbound(DB, new Date("2026-10-21T10:05:00Z")), { human: 1 });
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "call_booked");
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'raw1'")).needs_reply, 0);
  assert.equal((await one(DB, "SELECT status FROM messages WHERE id = 'fu1'")).status, "cancelled");
});

// --- Fixer: a cut-off row answered before the retry still moves the lead on --------------------------------------

// The "call stands" set-up without the client (Claude may answer the thread) and with the thread's mailbox: raw1 is
// stored, the hook's first query fails, so the row waits for a second try; the stage is whatever `stage` says.
async function cutOff(stage = "emailed", lostReason = null) {
  const DB = await seeded();
  await DB.prepare("DELETE FROM messages WHERE direction = 'in'").run();
  await DB.prepare("DELETE FROM clients").run();
  await DB.prepare("UPDATE prospects SET stage = ?, lost_reason = ? WHERE place_id = 'p1'").bind(stage, lostReason).run();
  await insert(DB, "mailboxes", { id: "mb1", address: "nik@aetoswebsites.com", display_name: "Nik", role: "cold", started_on: "2026-09-01", created_at: EARLIER });
  const raw = withFrom(readFileSync(new URL("gmail-reply.eml", DIR), "utf8"), "Mark <mark@greenleaf.co.uk>");
  await addRaw(DB, "raw1", raw);
  const flaky = {
    ...DB,
    prepare: (sql) => (/handled_at FROM messages WHERE id = \?2/.test(sql)
      ? { bind: () => ({ first: async () => { throw new Error("D1 hiccup"); } }) }
      : DB.prepare(sql)),
  };
  assert.deepEqual(await processInbound(flaky, NOW), { retry: 1 });
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'raw1'")).needs_reply, 1);
  return DB;
}
const INTERESTED = "Thanks Mark, glad you like it. Press Order on the page when you're ready.";
const RETRY_AT = new Date("2026-10-21T10:05:00Z");

test("processInbound: a cut-off row Claude answered 'interested' before the retry: the lead becomes replied", async () => {
  const DB = await cutOff("emailed");
  const r = await recordReply(DB, { message_id: "raw1", intent: "interested", body: INTERESTED, now: new Date("2026-10-21T10:02:00Z") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "emailed"); // the hook never ran
  assert.deepEqual(await processInbound(DB, RETRY_AT), { human: 1 });
  const p = await one(DB, "SELECT stage, lost_reason, last_inbound_at FROM prospects");
  assert.equal(p.stage, "replied");
  assert.equal(p.lost_reason, null);
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'raw1'")).needs_reply, 0);
  assert.equal((await one(DB, "SELECT status FROM messages WHERE id = 'fu1'")).status, "cancelled");
  // viewed (they looked at the demo first) the same
  const DB2 = await cutOff("viewed");
  assert.equal((await recordReply(DB2, { message_id: "raw1", intent: "question", body: "Hi Mark,\n\nYes, you keep the website.", now: new Date("2026-10-21T10:02:00Z") })).status, 200);
  assert.deepEqual(await processInbound(DB2, RETRY_AT), { human: 1 });
  assert.equal((await one(DB2, "SELECT stage FROM prospects")).stage, "replied");
});

test("processInbound: said 'not now' earlier, writes back interested, cut off, Claude answers before the retry: reopened", async () => {
  const DB = await cutOff("lost", "not_now");
  const r = await recordReply(DB, { message_id: "raw1", intent: "interested", body: INTERESTED, now: new Date("2026-10-21T10:02:00Z") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await processInbound(DB, RETRY_AT), { human: 1 });
  assert.deepEqual({ ...(await one(DB, "SELECT stage, lost_reason FROM prospects")) }, { stage: "replied", lost_reason: null });
});

test("processInbound: lost earlier, cut off, Claude answers this email 'not now' again before the retry: it stays lost", async () => {
  const DB = await cutOff("lost", "not_interested");
  const r = await recordReply(DB, { message_id: "raw1", intent: "not_now", body: "Hi Mark,\n\nNo problem. Would it be OK if I checked back in with you in 3 months?", now: new Date("2026-10-21T10:02:00Z") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await processInbound(DB, RETRY_AT), { human: 1 });
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "lost");
});

test("processInbound: lost earlier, cut off, Claude escalates this email before the retry: reopened and with Nik", async () => {
  const DB = await cutOff("lost", "not_now");
  const r = await escalateMessage(DB, { message_id: "raw1", intent: "angry", reason: "They're upset about the emails.", draft: "Hi Mark,\n\nSorry about that.", now: new Date("2026-10-21T10:02:00Z") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await processInbound(DB, RETRY_AT), { human: 1 });
  assert.deepEqual({ ...(await one(DB, "SELECT stage, lost_reason FROM prospects")) }, { stage: "needs_nik", lost_reason: null });
});

test("processInbound: cut off, Claude escalates before the retry (emailed): it stays with Nik", async () => {
  const DB = await cutOff("emailed");
  const r = await escalateMessage(DB, { message_id: "raw1", intent: "unclear", reason: "Not sure what they mean.", draft: "Hi Mark,\n\nCould you say a bit more?", now: new Date("2026-10-21T10:02:00Z") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "needs_nik");
  assert.deepEqual(await processInbound(DB, RETRY_AT), { human: 1 });
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "needs_nik");
});

test("processInbound: lost earlier, cut off, Claude books their free time before the retry: reopened and call_booked", async () => {
  const DB = await cutOff("lost", "not_now");
  const r = await recordReply(DB, { message_id: "raw1", intent: "proposes_time", body: "Hi Mark,\n\nFriday 23 October at 11am works. I'll ring you then.", call: { action: "confirm", slot_at: "2026-10-23T10:00:00Z", phone: "07700 900123" }, now: new Date("2026-10-21T10:02:00Z") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await one(DB, "SELECT status FROM calls")).status, "confirmed");
  assert.deepEqual(await processInbound(DB, RETRY_AT), { human: 1 });
  assert.deepEqual({ ...(await one(DB, "SELECT stage, lost_reason FROM prospects")) }, { stage: "call_booked", lost_reason: null });
});

test("processInbound: cut off, Claude offers a call (emailed) before the retry: replied, the offer kept", async () => {
  const DB = await cutOff("emailed");
  const r = await recordReply(DB, { message_id: "raw1", intent: "call_request", body: "Hi Mark,\n\nSoonest I can ring is Friday 23 October at 11am.", call: { action: "offer", slot_at: "2026-10-23T10:00:00Z" }, now: new Date("2026-10-21T10:02:00Z") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await processInbound(DB, RETRY_AT), { human: 1 });
  assert.equal((await one(DB, "SELECT stage FROM prospects")).stage, "replied");
  assert.equal((await one(DB, "SELECT status FROM calls")).status, "offered");
});
