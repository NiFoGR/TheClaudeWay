// Stage 7–8 regressions: mail that was waiting for Claude when Claude stopped being allowed to answer it (their
// "no thanks" or a bounce came in, they paid, or an opt-out landed between Claude's inbox read and its post). It is
// handed to Nik (needs_reply 0 and the read-it-yourself Todo onHumanInbound files), never left waiting for a reply
// nobody may send, which kept the Replies light red and woke the reply Routine every 10 minutes all day. An opt-out
// stage 0 classifies also cancels a booked call, so Nik is never told to ring someone who asked not to be contacted.
// Run: node --test control-room/tests/reply-handoff.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { confirmCall, holdSlot, liveCalls, runCallsStep } from "../functions/_lib/calls-db.js";
import { healthFromDb } from "../functions/_lib/health.js";
import { processInbound } from "../functions/_lib/mail/inbound-db.js";
import { applyStageEvent } from "../functions/_lib/prospects.js";
import {
  buildInbox, dismissTodo, escalateMessage, handOffWaiting, recordReply, runReplyFire, waitingStats,
} from "../functions/_lib/replies-db.js";
import { setSecret, setSetting } from "../functions/_lib/settings.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const D = (s) => new Date(s);
const EARLIER = "2026-10-19T07:01:03Z";
const GARY = "garypike.locksmith@icloud.com";
const DIR = new URL("./fixtures/mail/", import.meta.url);
const fixture = (name) => readFileSync(new URL(name, DIR), "utf8");
const one = (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const all = async (DB, sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results;

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

// The relay's stored headers (inbound-db.test.mjs's helper) and a header replaced in the top-level block.
function relayHeaders(raw) {
  const block = raw.split(/\r?\n\r?\n/)[0];
  const h = new Headers();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return JSON.stringify(Object.fromEntries(h));
}
function setHeader(raw, name, value) {
  const end = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, end);
  const re = new RegExp(`^${name}:[^\\r\\n]*(?:\\r\\n[ \\t][^\\r\\n]*)*(?:\\r\\n)?`, "im");
  assert.match(head + "\r\n", re, `${name} header`);
  return (head + "\r\n").replace(re, `${name}: ${value}\r\n`).slice(0, -2) + raw.slice(end);
}
async function addRaw(DB, id, raw, received_at) {
  await insert(DB, "inbound_raw", {
    id, received_at, envelope_from: "someone@example.com", envelope_to: "replies@aetos-mail.co.uk", headers: relayHeaders(raw), raw,
  });
}

// Gary (Gary Pike Locksmith, p0) replied to Nik's first email <orig0@…> and his "Who is this?" (w1, 08:50 UK on Wed
// 21 Oct) waits for Claude. The reply Routine is connected, so a fire would be counted in `fires`.
async function seeded({ email = GARY, rootId = "<orig0@aetoswebsites.com>" } = {}) {
  const DB = fakeD1();
  await setSetting(DB, "business:sender_name", "Nik");
  await setSecret(DB, "routine:reply:url", "https://api.anthropic.com/v1/claude_code/routines/trig_01AbC9xyz/fire");
  await setSecret(DB, "routine:reply:token", "sk-ant-oat01-test-token-for-reply-fire");
  await insert(DB, "mailboxes", {
    id: "m1", address: "nik@aetoswebsites.com", display_name: "Nik", role: "cold", started_on: "2026-01-01", status: "active", created_at: EARLIER,
  });
  await insert(DB, "leads", { place_id: "p0", name: "Gary Pike Locksmith", trade: "locksmith", search_town: "Leeds", phone: "0113 496 0001", first_seen_at: EARLIER, updated_at: EARLIER });
  await insert(DB, "prospects", {
    place_id: "p0", stage: "replied", stage_at: EARLIER, email, greet_name: "Gary", mailbox_id: "m1", subject: "Your new website, Gary",
    root_message_id: rootId, first_sent_at: EARLIER, created_at: EARLIER, updated_at: EARLIER,
  });
  await insert(DB, "messages", {
    id: "out0", place_id: "p0", mailbox_id: "m1", direction: "out", kind: "first", author: "nik", to_addr: email,
    from_addr: "nik@aetoswebsites.com", subject: "Your new website, Gary", body: "Hi", message_id: rootId, status: "sent",
    due_at: EARLIER, sent_at: EARLIER, created_at: EARLIER,
  });
  await insert(DB, "messages", {
    id: "w1", place_id: "p0", mailbox_id: "m1", direction: "in", kind: "inbound", author: "them", to_addr: "nik@aetoswebsites.com",
    from_addr: email, subject: "Re: Your new website, Gary", body: "Who is this?", message_id: "<w1@icloud.com>",
    in_reply_to: rootId, refs: rootId, status: "received", received_at: "2026-10-21T07:50:00Z", class: "human", needs_reply: 1,
    created_at: "2026-10-21T07:50:00Z",
  });
  const fired = { n: 0 };
  const fetchImpl = async () => {
    fired.n += 1;
    return { status: 200, json: async () => ({ type: "routine_fire", claude_code_session_id: "session_01abc" }) };
  };
  return { DB, fired, fetchImpl };
}

const repliesLight = async (DB, at) => (await healthFromDb(DB, {}, D(at))).lights.find((l) => l.name === "replies");

// Nothing waits for Claude any more, the message is Nik's, and the reply Routine is never woken for it.
async function assertHandedOver(DB, fired, fetchImpl, dedupe, title) {
  assert.equal(await runReplyFire({ DB, now: D("2026-10-21T08:30:00Z"), fetchImpl }), "skipped: nothing waiting");
  for (let t = Date.parse("2026-10-21T08:35:00Z"); t < Date.parse("2026-10-21T21:00:00Z"); t += 5 * 60000) {
    await runReplyFire({ DB, now: D(t), fetchImpl });
  }
  assert.equal(fired.n, 0);
  assert.equal((await waitingStats(DB)).waiting, 0);
  assert.equal((await repliesLight(DB, "2026-10-21T12:00:00Z")).level, "green");
  assert.equal((await repliesLight(DB, "2026-10-21T23:00:00Z")).level, "grey"); // 00:00 UK: outside reply hours
  const w1 = await one(DB, "SELECT needs_reply, handled_at FROM messages WHERE id = 'w1'");
  assert.equal(w1.needs_reply, 0);
  assert.ok(w1.handled_at);
  const todo = await one(DB, "SELECT * FROM todos WHERE dedupe = ?", dedupe);
  assert.ok(todo, `a ${dedupe} Todo`);
  assert.equal(todo.status, "open");
  assert.equal(todo.kind, "escalation");
  assert.equal(todo.title, title);
  assert.equal(todo.link, "/#/replies/p0");
  assert.match(todo.detail, /They wrote:\nWho is this\?/);
  assert.equal((await buildInbox(DB, D("2026-10-21T12:00:00Z"))).conversations.length, 0);
  return todo;
}

test("their \"no thanks\" (stage 0 classes it opt_out) after a waiting message: handed to Nik, no fires, the light green", async () => {
  const { DB, fired, fetchImpl } = await seeded();
  await addRaw(DB, "raw1", setHeader(fixture("no-thanks.eml"), "In-Reply-To", "<orig0@aetoswebsites.com>"), "2026-10-21T08:00:00Z");
  assert.deepEqual(await processInbound(DB, D("2026-10-21T08:01:00Z")), { opt_out: 1 });
  assert.deepEqual({ ...(await one(DB, "SELECT stage, lost_reason FROM prospects WHERE place_id = 'p0'")) }, { stage: "lost", lost_reason: "opt_out" });
  const todo = await assertHandedOver(DB, fired, fetchImpl, "optout-mail:w1",
    "Gary Pike Locksmith wrote back after opting out: read and reply yourself");
  // Nik reads it and dismisses it: closed for good, nothing sent
  assert.deepEqual(await dismissTodo(DB, { todo_id: todo.id, now: D("2026-10-21T12:00:00Z") }), { status: 200, body: { ok: true } });
  assert.equal((await one(DB, "SELECT status FROM todos WHERE id = ?", todo.id)).status, "dismissed");
  assert.equal((await all(DB, "SELECT id FROM messages WHERE direction = 'out' AND kind = 'reply'")).length, 0);
});

test("a bounce after a waiting message: handed to Nik the same way", async () => {
  const { DB, fired, fetchImpl } = await seeded({ email: "nobody@x.com", rootId: "<orig@aetoswebsites.com>" });
  await addRaw(DB, "raw1", fixture("dsn-gmail.eml"), "2026-10-21T08:00:00Z");
  assert.deepEqual(await processInbound(DB, D("2026-10-21T08:01:00Z")), { bounce: 1 });
  assert.deepEqual({ ...(await one(DB, "SELECT stage, lost_reason FROM prospects WHERE place_id = 'p0'")) }, { stage: "lost", lost_reason: "bounce" });
  await assertHandedOver(DB, fired, fetchImpl, "optout-mail:w1",
    "Gary Pike Locksmith wrote back after opting out: read and reply yourself");
});

test("they paid (stage 9's paid event) while a message waited: a client-mail Todo with the client, once", async () => {
  const { DB, fired, fetchImpl } = await seeded();
  await insert(DB, "clients", {
    id: "c1", name: "Gary Pike Locksmith", place_id: "p0", package: "full", build_fee_pence: 195000, monthly_pence: 24900,
    free_days: 60, paid_on: "2026-10-21", created_at: "2026-10-21T08:00:00Z",
  });
  await applyStageEvent(DB, "p0", "paid", "2026-10-21T08:00:00Z");
  assert.equal(await handOffWaiting(DB, "p0", D("2026-10-21T08:00:00Z")), 1);
  assert.equal(await handOffWaiting(DB, "p0", D("2026-10-21T08:05:00Z")), 0); // a repeat changes nothing
  const todo = await assertHandedOver(DB, fired, fetchImpl, "client-mail:w1", "Your client Gary Pike Locksmith emailed: read and reply yourself");
  assert.equal(todo.client_id, "c1");
  assert.equal((await one(DB, "SELECT client_id FROM messages WHERE id = 'w1'")).client_id, "c1");
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM todos")).n, 1);
});

test("a thread Claude may still answer is left alone by handOffWaiting", async () => {
  const { DB } = await seeded();
  assert.equal(await handOffWaiting(DB, "p0", D("2026-10-21T08:00:00Z")), 0);
  assert.equal(await handOffWaiting(DB, "nope", D("2026-10-21T08:00:00Z")), 0);
  assert.equal(await handOffWaiting(DB, null, D("2026-10-21T08:00:00Z")), 0);
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'w1'")).needs_reply, 1);
  assert.equal((await waitingStats(DB)).waiting, 1);
});

test("the race: an opt-out lands between Claude's inbox read and its post → 409, and nothing is left waiting", async () => {
  const { DB } = await seeded();
  assert.equal((await buildInbox(DB, D("2026-10-21T08:00:00Z"))).conversations.length, 1);
  await applyStageEvent(DB, "p0", "opt_out", "2026-10-21T08:01:00Z");
  const res = await recordReply(DB, { message_id: "w1", intent: "question", body: "Hi Gary,\n\nIt's Nik from Aetos Websites.", now: D("2026-10-21T08:02:00Z") });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "They opted out (or their address bounced): nothing is sent to them. Move on.");
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'w1'")).needs_reply, 0);
  assert.equal((await waitingStats(DB)).waiting, 0);
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe = 'optout-mail:w1'")).status, "open");
});

test("the race for an escalation, and for a client: 409, handed to Nik", async () => {
  const { DB } = await seeded();
  await applyStageEvent(DB, "p0", "paid", "2026-10-21T08:01:00Z");
  const res = await escalateMessage(DB, { message_id: "w1", intent: "unclear", reason: "Not sure what they mean.", draft: "Hi Gary,", now: D("2026-10-21T08:02:00Z") });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "They're a paying client: Nik answers them himself. Move on.");
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'w1'")).needs_reply, 0);
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe = 'client-mail:w1'")).status, "open");
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'escalation:w1'")).n, 0);
});

test("mail stuck from before (a won prospect's, still needs_reply 1) is handed to Nik when the inbox is read", async () => {
  const { DB } = await seeded();
  // the stage moved without the hand-off (as live rows from before this fix may be)
  await DB.prepare("UPDATE prospects SET stage = 'won' WHERE place_id = 'p0'").run();
  assert.equal((await waitingStats(DB)).waiting, 0); // never counted as waiting for Claude
  const inbox = await buildInbox(DB, D("2026-10-21T08:30:00Z"));
  assert.equal(inbox.conversations.length, 0);
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'w1'")).needs_reply, 0);
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe = 'client-mail:w1'")).status, "open");
});

test("an opt-out stage 0 classifies cancels their booked call: no Today's calls, no How did it go, the day free again", async () => {
  const { DB } = await seeded();
  const FRI = "2026-10-23T10:00:00Z"; // Fri 23 Oct, 11:00 UK
  const booked = await confirmCall(DB, { place_id: "p0", slot_at: FRI, phone: "07700 900111", now: D("2026-10-20T09:00:00Z") });
  assert.equal(booked.ok, true);
  const callTodo = `call:${booked.call.id}`;
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe = ?", callTodo)).status, "open");

  await addRaw(DB, "raw1", setHeader(fixture("no-thanks.eml"), "In-Reply-To", "<orig0@aetoswebsites.com>"), "2026-10-21T08:00:00Z");
  assert.deepEqual(await processInbound(DB, D("2026-10-21T08:01:00Z")), { opt_out: 1 });
  assert.deepEqual({ ...(await one(DB, "SELECT stage, lost_reason FROM prospects WHERE place_id = 'p0'")) }, { stage: "lost", lost_reason: "opt_out" });
  const call = await one(DB, "SELECT status, note FROM calls WHERE id = ?", booked.call.id);
  assert.equal(call.status, "cancelled");
  assert.equal(call.note, "Cancelled by their email: they asked not to be emailed again.");
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM todos WHERE kind = 'call' AND status = 'open'")).n, 0);
  assert.notEqual((await one(DB, "SELECT status FROM todos WHERE dedupe = ?", callTodo)).status, "open");

  assert.match(await runCallsStep({ DB, now: D("2026-10-23T06:05:00Z") }), /today 0/);  // Fri 07:05 UK
  assert.match(await runCallsStep({ DB, now: D("2026-10-23T10:35:00Z") }), /outcome 0/); // Fri 11:35 UK
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM todos WHERE title LIKE 'Today''s calls%'")).n, 0);
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM todos WHERE title LIKE 'How did the call%'")).n, 0);
  // the slot is free again for someone else
  assert.equal((await liveCalls(DB, D("2026-10-21T09:00:00Z"))).length, 0);
  assert.equal((await holdSlot(DB, { place_id: "other", slot_at: FRI, now: D("2026-10-21T09:00:00Z") })).ok, true);
});

test("the calls step never lists a confirmed call whose prospect opted out (rows from before the cancel existed)", async () => {
  const { DB } = await seeded();
  const FRI = "2026-10-23T10:00:00Z";
  const booked = await confirmCall(DB, { place_id: "p0", slot_at: FRI, phone: "07700 900111", now: D("2026-10-20T09:00:00Z") });
  // opted out without the cancel (stage moved directly, the call left confirmed)
  await DB.prepare("UPDATE prospects SET stage = 'lost', lost_reason = 'opt_out' WHERE place_id = 'p0'").run();
  assert.equal((await one(DB, "SELECT status FROM calls WHERE id = ?", booked.call.id)).status, "confirmed");
  assert.match(await runCallsStep({ DB, now: D("2026-10-23T06:05:00Z") }), /today 0/);
  assert.match(await runCallsStep({ DB, now: D("2026-10-23T10:35:00Z") }), /outcome 0/);
});

test("buildInbox still counts as one read for a normal thread (the sweep finds nothing to hand over)", async () => {
  const { DB } = await seeded();
  const inbox = await buildInbox(DB, D("2026-10-21T08:30:00Z"));
  assert.equal(inbox.conversations.length, 1);
  assert.equal((await one(DB, "SELECT needs_reply FROM messages WHERE id = 'w1'")).needs_reply, 1);
  assert.equal((await one(DB, "SELECT COUNT(*) AS n FROM todos")).n, 0);
});

// A prospect lost for not_now (Claude answers again when they write) isn't handed over: Claude still may answer.
test("lost for not_now: not handed over, still waiting for Claude", async () => {
  const { DB } = await seeded();
  await applyStageEvent(DB, "p0", "said_no", "2026-10-21T08:00:00Z", { lost_reason: "not_now" });
  assert.equal(await handOffWaiting(DB, "p0", D("2026-10-21T08:01:00Z")), 0);
  assert.equal((await waitingStats(DB)).waiting, 1);
});
