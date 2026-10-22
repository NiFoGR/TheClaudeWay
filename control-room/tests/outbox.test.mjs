// Outbox: queueing email, and sending what's due (caps, the cold send window, suppression, one claim per send).
// Run: node --test control-room/tests/outbox.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { COLD_WINDOW, INTERRUPTED_PREFIX, dispatchDue, queueMessage, sendStep, sentToday } from "../functions/_lib/mail/outbox.js";
import { OPT_OUT_LINE, coldFooter } from "../functions/_lib/mail/compose.js";
import { INTERRUPTED_PREFIX as SMTP_INTERRUPTED_PREFIX, sendViaSmtp } from "../functions/_lib/mail/smtp.js";
import { isSuppressed, suppress, suppressionReasons } from "../functions/_lib/prospects.js";
import { setSecret } from "../functions/_lib/settings.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const SUNDAY = new Date("2026-10-25T10:00:00Z"); // Sun 10:00 UK (GMT since 01:00Z that morning)
const SAT_1900 = new Date("2026-10-24T18:00:00Z"); // Sat 19:00 UK (BST)
const MON_0700 = new Date("2026-10-26T07:00:00Z"); // Mon 07:00 UK (GMT)
const TUE = new Date("2026-10-20T09:00:00Z"); // Tue 10:00 UK (BST), inside the cold window
const STUCK_TEXT =
  "The send was interrupted. It may or may not have gone: check the Sent folder in Namecheap webmail before sending again.";
const COLD_BODY = `Hi Bob,\n\nI made you a new website: https://aetoswebsites.com/d/bob\n\n${coldFooter("Nik")}`;
const WARM_BODY = "Thanks Bob, Tuesday at 11 works.\n\nNik\nAetos Websites";
const AUTHOR = { first: "nik", followup: "system", reply: "claude", system: "system" };

const MAILBOX = {
  id: "m1", address: "nik@aetoswebsites.com", display_name: "Nik", role: "cold", started_on: "2026-01-01",
  cap_override: null, status: "active", paused_reason: null, created_at: "2026-01-01T09:00:00Z",
};

const message = (DB, id) => DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
const prospect = (DB, id) => DB.prepare("SELECT * FROM prospects WHERE place_id = ?").bind(id).first();

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

// A database with mailbox m1 (cold, started 2026-01-01, active) and its password saved.
async function setup({ mailbox = {}, password = "pw" } = {}) {
  const DB = fakeD1();
  await insert(DB, "mailboxes", { ...MAILBOX, ...mailbox });
  if (password) await setSecret(DB, "mailbox:m1", password);
  return DB;
}

const addMailbox = (DB, row) => insert(DB, "mailboxes", { ...MAILBOX, ...row });

const seedProspect = (DB, place_id, extra = {}) =>
  insert(DB, "prospects", {
    place_id, stage: "ready", stage_at: "2026-10-19T08:00:00Z", email: "bob@x.com", mailbox_id: null,
    created_at: "2026-10-19T08:00:00Z", updated_at: "2026-10-19T08:00:00Z", ...extra,
  });

// An outgoing message for queueMessage: cold kinds carry the footer, from mailbox m1, to bob@x.com.
const out = (kind, extra = {}) => ({
  direction: "out", kind, author: AUTHOR[kind], to_addr: "bob@x.com", subject: "Your new website",
  body: kind === "first" || kind === "followup" ? COLD_BODY : WARM_BODY, mailbox_id: "m1", ...extra,
});

// A fake `send` recording every call. `result` is the reply, or a function of the call number giving it.
function recorder(result = { ok: true, ms: 5 }) {
  const calls = [];
  const send = async (mailbox, password, msg) => {
    calls.push({ mailbox, password, message: msg });
    return typeof result === "function" ? result(calls.length) : result;
  };
  return { send, calls };
}

// Counts the D1 statements made (each prepared statement is run once).
function counting(DB) {
  const c = { n: 0 };
  c.DB = { ...DB, prepare: (sql) => (c.n++, DB.prepare(sql)) };
  return c;
}

// ---------------------------------------------------------------- the plan's cases

test("sends a due reply on Sunday", async () => {
  const DB = await setup();
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("reply", { due_at: "2026-10-25T09:00:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, SUNDAY, { send }), { sent: 1, failed: 0, held: 0 });
  assert.equal(calls.length, 1);
  const row = await message(DB, id);
  assert.equal(row.status, "sent");
  assert.equal(row.sent_at, "2026-10-25T10:00:00Z");
  assert.equal(row.error, null);
  assert.match(row.message_id, /@aetoswebsites\.com>$/);
  assert.match(row.message_id, /^<[0-9a-f-]{36}@aetoswebsites\.com>$/);
  // what reached the sender
  const [call] = calls;
  assert.equal(call.mailbox.id, "m1");
  assert.equal(call.password, "pw");
  assert.deepEqual(call.message.from, { name: "Nik", address: "nik@aetoswebsites.com" });
  assert.equal(call.message.to, "bob@x.com");
  assert.equal(call.message.subject, "Your new website");
  assert.equal(call.message.text, WARM_BODY);
  assert.equal(call.message.headers["Message-ID"], row.message_id);
  assert.equal(call.message.headers.From, "Nik <nik@aetoswebsites.com>");
  assert.equal(call.message.headers.Date, SUNDAY.toUTCString());
  assert.equal(row.from_addr, "nik@aetoswebsites.com");
});

test("holds a cold email outside the window: Sat 19:00 UK stays queued, then goes Mon 07:00 UK", async () => {
  const DB = await setup();
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("first", { due_at: SAT_1900 }));
  assert.deepEqual(await dispatchDue(DB, {}, SAT_1900, { send }), { sent: 0, failed: 0, held: 1 });
  assert.equal((await message(DB, id)).status, "queued");
  assert.equal(calls.length, 0);
  assert.deepEqual(await dispatchDue(DB, {}, MON_0700, { send }), { sent: 1, failed: 0, held: 0 });
  const row = await message(DB, id);
  assert.equal(row.status, "sent");
  assert.equal(row.sent_at, "2026-10-26T07:00:00Z");
});

test("cap: with cap_override 1 and one first already sent today, a second first is held", async () => {
  const DB = await setup({ mailbox: { cap_override: 1 } });
  await insert(DB, "messages", {
    id: "earlier", mailbox_id: "m1", direction: "out", kind: "first", author: "nik", to_addr: "amy@y.com",
    body: COLD_BODY, status: "sent", due_at: "2026-10-20T07:55:00Z", sent_at: "2026-10-20T08:00:00Z",
    created_at: "2026-10-20T07:55:00Z",
  });
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("first", { due_at: "2026-10-20T08:30:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 0, failed: 0, held: 1 });
  assert.equal((await message(DB, id)).status, "queued");
  assert.equal(calls.length, 0);
});

test("limit: 5 due replies with limit 2 means exactly 2 sends", async () => {
  const DB = await setup();
  const { send, calls } = recorder();
  for (let i = 0; i < 5; i++) await queueMessage(DB, out("reply", { to_addr: `r${i}@y.com`, due_at: `2026-10-25T09:0${i}:00Z` }));
  assert.deepEqual(await dispatchDue(DB, {}, SUNDAY, { limit: 2, send }), { sent: 2, failed: 0, held: 0 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.message.to), ["r0@y.com", "r1@y.com"], "oldest first");
  const { n } = await DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'queued'").first();
  assert.equal(n, 3);
});

test("suppressed: a reply to Bob@x.com after bob@x.com opted out is cancelled, never sent", async () => {
  const DB = await setup();
  await suppress(DB, "bob@x.com", "email", "opt_out", SUNDAY);
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("reply", { to_addr: "Bob@x.com", due_at: "2026-10-25T09:00:00Z" }));
  await dispatchDue(DB, {}, SUNDAY, { send });
  const row = await message(DB, id);
  assert.equal(row.status, "cancelled");
  assert.ok(row.error.startsWith("Suppressed:"), row.error);
  assert.equal(row.error, "Suppressed: opt_out");
  assert.equal(calls.length, 0);
  assert.equal(row.sent_at, null);
});

test("system mail ignores suppression (a paying client's mail always goes)", async () => {
  const DB = await setup();
  await suppress(DB, "bob@x.com", "email", "opt_out", SUNDAY);
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("system", { due_at: "2026-10-25T09:00:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, SUNDAY, { send }), { sent: 1, failed: 0, held: 0 });
  assert.equal((await message(DB, id)).status, "sent");
  assert.equal(calls.length, 1);
});

test('missing footer: a first without the "no thanks" line fails and is never sent', async () => {
  const DB = await setup();
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("first", { body: "Hi Bob,\n\nHave a look.\n\nNik", due_at: "2026-10-20T08:30:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 0, failed: 1, held: 0 });
  const row = await message(DB, id);
  assert.equal(row.status, "failed");
  assert.equal(row.error, 'Missing the "no thanks" line');
  assert.equal(calls.length, 0);
});

test("paused mailbox holds a first, sends a reply", async () => {
  const DB = await setup({ mailbox: { status: "paused", paused_reason: "2 emails bounced in 7 days (last: a@b.com)." } });
  const { send, calls } = recorder();
  const first = await queueMessage(DB, out("first", { due_at: "2026-10-20T08:30:00Z" }));
  const reply = await queueMessage(DB, out("reply", { to_addr: "sam@y.com", due_at: "2026-10-20T08:40:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 1, failed: 0, held: 1 });
  assert.equal((await message(DB, first)).status, "queued");
  assert.equal((await message(DB, reply)).status, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message.to, "sam@y.com");
});

test("kinds: only the listed kinds are sent; the others aren't counted as held", async () => {
  const DB = await setup();
  const { send, calls } = recorder();
  const first = await queueMessage(DB, out("first", { due_at: "2026-10-20T08:30:00Z" }));
  const reply = await queueMessage(DB, out("reply", { to_addr: "sam@y.com", due_at: "2026-10-20T08:40:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { kinds: ["reply"], send }), { sent: 1, failed: 0, held: 0 });
  assert.equal((await message(DB, reply)).status, "sent");
  assert.equal((await message(DB, first)).status, "queued");
  assert.equal(calls.length, 1);
});

test("follow-ups first: at limit 1, a follow-up due 08:05 goes before a first email due 08:00", async () => {
  const DB = await setup();
  const { send, calls } = recorder();
  const first = await queueMessage(DB, out("first", { due_at: "2026-10-26T08:00:00Z" })); // Mon 08:00 UK (GMT)
  const followup = await queueMessage(DB, out("followup", { to_addr: "amy@y.com", due_at: "2026-10-26T08:05:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, new Date("2026-10-26T08:10:00Z"), { limit: 1, send }), { sent: 1, failed: 0, held: 0 });
  assert.equal((await message(DB, followup)).status, "sent");
  assert.equal((await message(DB, first)).status, "queued");
  assert.equal(calls[0].message.to, "amy@y.com");
});

test("first emails go before replies and system mail, oldest first within a kind", async () => {
  const DB = await setup();
  const { send, calls } = recorder();
  await queueMessage(DB, out("system", { to_addr: "s@y.com", due_at: "2026-10-20T07:00:00Z" }));
  await queueMessage(DB, out("reply", { to_addr: "r@y.com", due_at: "2026-10-20T07:30:00Z" }));
  await queueMessage(DB, out("first", { to_addr: "f2@y.com", due_at: "2026-10-20T08:20:00Z" }));
  await queueMessage(DB, out("first", { to_addr: "f1@y.com", due_at: "2026-10-20T08:10:00Z" }));
  await queueMessage(DB, out("followup", { to_addr: "u@y.com", due_at: "2026-10-20T08:50:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { limit: 5, send }), { sent: 5, failed: 0, held: 0 });
  assert.deepEqual(calls.map((c) => c.message.to), ["u@y.com", "f1@y.com", "f2@y.com", "s@y.com", "r@y.com"]);
});

test("keeps the row's headers: its Message-ID, In-Reply-To and References go out exactly as stored", async () => {
  const DB = await setup();
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("reply", {
    message_id: "<x@aetoswebsites.com>", in_reply_to: "<r@y>", refs: "<q@y> <r@y>", due_at: "2026-10-25T09:00:00Z",
  }));
  await dispatchDue(DB, {}, SUNDAY, { send });
  const { headers } = calls[0].message;
  assert.equal(headers["Message-ID"], "<x@aetoswebsites.com>");
  assert.equal(headers["In-Reply-To"], "<r@y>");
  assert.equal(headers.References, "<q@y> <r@y>");
  const row = await message(DB, id);
  assert.equal(row.message_id, "<x@aetoswebsites.com>");
  assert.equal(row.in_reply_to, "<r@y>");
  assert.equal(row.refs, "<q@y> <r@y>");
});

test("failure is recorded, and the row is never tried again", async () => {
  const DB = await setup();
  const failing = recorder({ ok: false, error: "x" });
  const id = await queueMessage(DB, out("reply", { due_at: "2026-10-25T09:00:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, SUNDAY, { send: failing.send }), { sent: 0, failed: 1, held: 0 });
  let row = await message(DB, id);
  assert.equal(row.status, "failed");
  assert.equal(row.error, "x");
  assert.equal(row.sent_at, null);
  const next = recorder();
  assert.deepEqual(await dispatchDue(DB, {}, new Date("2026-10-25T10:05:00Z"), { send: next.send }), { sent: 0, failed: 0, held: 0 });
  assert.equal(failing.calls.length, 1);
  assert.equal(next.calls.length, 0);
  row = await message(DB, id);
  assert.equal(row.status, "failed");
  assert.equal(row.error, "x");
});

test("stuck sending: a row left in 'sending' for over 10 minutes becomes failed with the Sent-folder text", async () => {
  const DB = await setup();
  const base = {
    mailbox_id: "m1", direction: "out", kind: "reply", author: "claude", to_addr: "bob@x.com", body: WARM_BODY,
    status: "sending", due_at: "2026-10-25T08:00:00Z",
  };
  await insert(DB, "messages", { ...base, id: "stuck", created_at: "2026-10-25T09:49:00Z" }); // 11 min ago
  await insert(DB, "messages", { ...base, id: "young", created_at: "2026-10-25T09:51:00Z" }); // 9 min ago
  // queued two hours ago but only claimed a minute ago: its claim time counts, not when it was queued
  await insert(DB, "messages", { ...base, id: "claimed", created_at: "2026-10-25T08:00:00Z", sent_at: "2026-10-25T09:59:00Z" });
  const { send, calls } = recorder();
  assert.deepEqual(await dispatchDue(DB, {}, SUNDAY, { send }), { sent: 0, failed: 0, held: 0 });
  const stuck = await message(DB, "stuck");
  assert.equal(stuck.status, "failed");
  assert.equal(stuck.error, STUCK_TEXT);
  assert.equal(stuck.sent_at, null);
  assert.equal((await message(DB, "young")).status, "sending");
  assert.equal((await message(DB, "claimed")).status, "sending");
  assert.equal(calls.length, 0, "nothing is resent on its own");
  // and it stays failed
  await dispatchDue(DB, {}, new Date("2026-10-25T11:00:00Z"), { send });
  assert.equal((await message(DB, "stuck")).status, "failed");
  assert.equal(calls.length, 0);
});

test("claimed once: two dispatchDue calls at the same time send one due reply once", async () => {
  const DB = await setup();
  const slow = async (mailbox, password, msg) => {
    slow.calls.push(msg);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, ms: 5 };
  };
  slow.calls = [];
  const id = await queueMessage(DB, out("reply", { due_at: "2026-10-25T09:00:00Z" }));
  const [a, b] = await Promise.all([dispatchDue(DB, {}, SUNDAY, { send: slow }), dispatchDue(DB, {}, SUNDAY, { send: slow })]);
  assert.equal(slow.calls.length, 1);
  assert.equal(a.sent + b.sent, 1);
  assert.equal(a.failed + b.failed, 0);
  assert.equal((await message(DB, id)).status, "sent");
});

test("claimed once: a row another dispatcher claims between the read and the claim isn't sent or counted", async () => {
  const DB = await setup();
  const id = await queueMessage(DB, out("reply", { due_at: "2026-10-25T09:00:00Z" }));
  // Just before our claim runs, another request claims the row.
  const racing = {
    ...DB,
    prepare: (sql) => {
      if (/^\s*UPDATE messages SET status = 'sending'/.test(sql)) {
        DB.raw.prepare("UPDATE messages SET status = 'sending', sent_at = '2026-10-25T10:00:00Z' WHERE id = ?").run(id);
      }
      return DB.prepare(sql);
    },
  };
  const { send, calls } = recorder();
  assert.deepEqual(await dispatchDue(racing, {}, SUNDAY, { send }), { sent: 0, failed: 0, held: 0 });
  assert.equal(calls.length, 0);
  assert.equal((await message(DB, id)).status, "sending");
});

test("claimed once at the cap: two dispatchers at the same time never take a mailbox past its cap", async () => {
  const DB = await setup({ mailbox: { cap_override: 1 } });
  const a = await queueMessage(DB, out("first", { to_addr: "a@y.com", due_at: "2026-10-20T08:00:00Z" }));
  const b = await queueMessage(DB, out("first", { to_addr: "b@y.com", due_at: "2026-10-20T08:01:00Z" }));
  const sends = [];
  const slow = async (mailbox, password, msg) => {
    sends.push(msg.to);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, ms: 5 };
  };
  // Both read today's count (0 of 1) before either claims: only the claim itself can stop the second send.
  const [x, y] = await Promise.all([dispatchDue(DB, {}, TUE, { send: slow }), dispatchDue(DB, {}, TUE, { send: slow })]);
  assert.deepEqual(sends, ["a@y.com"]);
  assert.equal(x.sent + y.sent, 1);
  assert.equal((await message(DB, a)).status, "sent");
  assert.equal((await message(DB, b)).status, "queued");
  assert.deepEqual(await sentToday(DB, TUE), { m1: 1 });
});

test("no mailbox for a first: pickMailbox assigns m1, and prospects.mailbox_id is set when null", async () => {
  const DB = await setup();
  await seedProspect(DB, "p1");
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("first", { place_id: "p1", mailbox_id: null, due_at: "2026-10-20T08:30:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 1, failed: 0, held: 0 });
  assert.equal(calls[0].mailbox.id, "m1");
  const row = await message(DB, id);
  assert.equal(row.mailbox_id, "m1");
  assert.equal(row.status, "sent");
  assert.equal((await prospect(DB, "p1")).mailbox_id, "m1");
});

// ---------------------------------------------------------------- more edges

test("COLD_WINDOW is Monday to Saturday, 07:00 to 19:00 UK", () => {
  assert.deepEqual(COLD_WINDOW, { start: "07:00", end: "19:00", days: [1, 2, 3, 4, 5, 6] });
  assert.ok(Object.isFrozen(COLD_WINDOW));
});

test("the cold window in UK time: 19:00 Saturday, 06:59 Monday, Friday 23:30 UTC and both clock changes", async () => {
  for (const [at, open, what] of [
    ["2026-10-24T17:59:00Z", true, "Sat 18:59 BST"],
    ["2026-10-24T18:00:00Z", false, "Sat 19:00 BST"],
    ["2026-10-23T23:30:00Z", false, "Fri 23:30 UTC is Sat 00:30 BST"],
    ["2026-10-23T17:59:00Z", true, "Fri 18:59 BST"],
    ["2026-10-25T12:00:00Z", false, "Sunday (the clocks went back that morning)"],
    ["2026-10-26T06:59:00Z", false, "Mon 06:59 GMT"],
    ["2026-10-26T07:00:00Z", true, "Mon 07:00 GMT"],
    ["2026-10-26T18:59:00Z", true, "Mon 18:59 GMT"],
    ["2026-10-26T19:00:00Z", false, "Mon 19:00 GMT"],
    ["2026-03-30T05:59:00Z", false, "Mon 06:59 BST, the day after the clocks went forward"],
    ["2026-03-30T06:00:00Z", true, "Mon 07:00 BST"],
  ]) {
    const DB = await setup();
    const { send } = recorder();
    await queueMessage(DB, out("followup", { due_at: "2026-01-05T08:00:00Z" }));
    const expected = open ? { sent: 1, failed: 0, held: 0 } : { sent: 0, failed: 0, held: 1 };
    assert.deepEqual(await dispatchDue(DB, {}, new Date(at), { send }), expected, what);
  }
});

test("replies and system mail go any time, even at 3am on a Sunday", async () => {
  const DB = await setup();
  const { send } = recorder();
  await queueMessage(DB, out("reply", { due_at: "2026-10-25T02:00:00Z" }));
  await queueMessage(DB, out("system", { to_addr: "client@y.com", due_at: "2026-10-25T02:00:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, new Date("2026-10-25T03:00:00Z"), { send }), { sent: 2, failed: 0, held: 0 });
});

test("a message isn't sent before its due_at", async () => {
  const DB = await setup();
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("reply", { due_at: "2026-10-25T10:00:01Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, SUNDAY, { send }), { sent: 0, failed: 0, held: 0 });
  assert.equal(calls.length, 0);
  assert.equal((await message(DB, id)).status, "queued");
  await dispatchDue(DB, {}, new Date("2026-10-25T10:00:01Z"), { send });
  assert.equal((await message(DB, id)).status, "sent");
});

test("the cap counts what this call sends; replies and system mail never use the cap", async () => {
  const DB = await setup({ mailbox: { cap_override: 1 } });
  const { send, calls } = recorder();
  const a = await queueMessage(DB, out("first", { to_addr: "a@y.com", due_at: "2026-10-20T08:00:00Z" }));
  const b = await queueMessage(DB, out("first", { to_addr: "b@y.com", due_at: "2026-10-20T08:10:00Z" }));
  await queueMessage(DB, out("reply", { to_addr: "r@y.com", due_at: "2026-10-20T08:20:00Z" }));
  await queueMessage(DB, out("system", { to_addr: "s@y.com", due_at: "2026-10-20T08:30:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { limit: 5, send }), { sent: 3, failed: 0, held: 1 });
  assert.equal((await message(DB, a)).status, "sent");
  assert.equal((await message(DB, b)).status, "queued");
  assert.deepEqual(calls.map((c) => c.message.to), ["a@y.com", "r@y.com", "s@y.com"]);
});

test("a warming-up mailbox (days 0-13) sends no cold email, but still sends replies", async () => {
  const DB = await setup({ mailbox: { started_on: "2026-10-19" } });
  const { send, calls } = recorder();
  await queueMessage(DB, out("first", { due_at: "2026-10-20T08:00:00Z" }));
  await queueMessage(DB, out("reply", { to_addr: "r@y.com", due_at: "2026-10-20T08:00:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 1, failed: 0, held: 1 });
  assert.equal(calls[0].message.to, "r@y.com");
});

test("a mailbox whose started_on is in the future sends no cold email (its cap is 0), but still sends replies", async () => {
  const DB = await setup({ mailbox: { started_on: "2026-10-21", cap_override: 5 } }); // TUE is 2026-10-20 in the UK
  const { send, calls } = recorder();
  const first = await queueMessage(DB, out("first", { due_at: "2026-10-20T08:00:00Z" }));
  await queueMessage(DB, out("reply", { to_addr: "r@y.com", due_at: "2026-10-20T08:00:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 1, failed: 0, held: 1 });
  assert.equal((await message(DB, first)).status, "queued");
  assert.deepEqual(calls.map((c) => c.message.to), ["r@y.com"]);
});

test("a cold email with no mailbox goes from the cold mailbox with the most room left", async () => {
  const DB = await setup();
  await addMailbox(DB, { id: "m2", address: "sam@aetoswebsites.com", display_name: "Sam" });
  await setSecret(DB, "mailbox:m2", "pw2");
  await addMailbox(DB, { id: "s1", address: "team@aetoswebsites.com", display_name: "Aetos Team", role: "system" });
  await setSecret(DB, "mailbox:s1", "pw3");
  for (let i = 0; i < 4; i++) {
    await insert(DB, "messages", {
      id: `sent${i}`, mailbox_id: "m1", direction: "out", kind: "followup", author: "system", to_addr: `x${i}@y.com`,
      body: COLD_BODY, status: "sent", due_at: "2026-10-20T07:00:00Z", sent_at: "2026-10-20T07:30:00Z",
      created_at: "2026-10-20T07:00:00Z",
    });
  }
  await seedProspect(DB, "p1");
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("first", { place_id: "p1", mailbox_id: null, due_at: "2026-10-20T08:30:00Z" }));
  await dispatchDue(DB, {}, TUE, { send });
  assert.equal(calls[0].mailbox.id, "m2");
  assert.equal(calls[0].password, "pw2");
  assert.deepEqual(calls[0].message.from, { name: "Sam", address: "sam@aetoswebsites.com" });
  assert.equal((await message(DB, id)).mailbox_id, "m2");
  assert.equal((await prospect(DB, "p1")).mailbox_id, "m2");
});

test("a cold email with no mailbox waits while no cold mailbox has room", async () => {
  const DB = await setup({ mailbox: { cap_override: 0 } });
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("first", { mailbox_id: null, due_at: "2026-10-20T08:30:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 0, failed: 0, held: 1 });
  const row = await message(DB, id);
  assert.equal(row.status, "queued");
  assert.equal(row.mailbox_id, null);
  assert.equal(calls.length, 0);
});

test("a follow-up with no mailbox_id goes from its thread's mailbox (prospects.mailbox_id)", async () => {
  const DB = await setup();
  await addMailbox(DB, { id: "m2", address: "sam@aetoswebsites.com", display_name: "Sam" });
  await setSecret(DB, "mailbox:m2", "pw2");
  await seedProspect(DB, "p2", { stage: "emailed", mailbox_id: "m2" });
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("followup", { place_id: "p2", mailbox_id: null, due_at: "2026-10-20T08:30:00Z" }));
  await dispatchDue(DB, {}, TUE, { send });
  assert.equal(calls[0].mailbox.id, "m2");
  assert.equal((await message(DB, id)).mailbox_id, "m2");
  assert.equal((await prospect(DB, "p2")).mailbox_id, "m2");
});

test("a prospect's mailbox, once set, is never changed by a send", async () => {
  const DB = await setup();
  await addMailbox(DB, { id: "m2", address: "sam@aetoswebsites.com", display_name: "Sam" });
  await setSecret(DB, "mailbox:m2", "pw2");
  await seedProspect(DB, "p3", { mailbox_id: "m2" });
  const { send } = recorder();
  await queueMessage(DB, out("first", { place_id: "p3", mailbox_id: "m1", due_at: "2026-10-20T08:30:00Z" }));
  await dispatchDue(DB, {}, TUE, { send });
  assert.equal((await prospect(DB, "p3")).mailbox_id, "m2");
});

test("system mail with no mailbox goes from a System mailbox first; with no mailbox at all it waits", async () => {
  const DB = await setup();
  await addMailbox(DB, { id: "s1", address: "team@aetoswebsites.com", display_name: "Aetos Team", role: "system" });
  await setSecret(DB, "mailbox:s1", "pw3");
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("system", { mailbox_id: null, to_addr: "client@y.com", due_at: "2026-10-25T09:00:00Z" }));
  await dispatchDue(DB, {}, SUNDAY, { send });
  assert.equal(calls[0].mailbox.id, "s1");
  assert.equal((await message(DB, id)).mailbox_id, "s1");

  const empty = fakeD1();
  const none = recorder();
  const waiting = await queueMessage(empty, out("system", { mailbox_id: null, due_at: "2026-10-25T09:00:00Z" }));
  assert.deepEqual(await dispatchDue(empty, {}, SUNDAY, { send: none.send }), { sent: 0, failed: 0, held: 1 });
  assert.equal((await message(empty, waiting)).status, "queued");
  assert.equal(none.calls.length, 0);
});

test("a reply with no mailbox anywhere goes from a mailbox whose password is saved", async () => {
  const DB = await setup({ password: null }); // m1 (first by id) has no password
  await addMailbox(DB, { id: "m2", address: "sam@aetoswebsites.com", display_name: "Sam" });
  await setSecret(DB, "mailbox:m2", "pw2");
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("reply", { mailbox_id: null, due_at: "2026-10-25T09:00:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, SUNDAY, { send }), { sent: 1, failed: 0, held: 0 });
  assert.equal(calls[0].mailbox.id, "m2");
  assert.equal((await message(DB, id)).mailbox_id, "m2");
});

test("a suppressed first outside the window (Sat 19:00 UK) is cancelled at once, never held or sent", async () => {
  const DB = await setup();
  await suppress(DB, "bob@x.com", "email", "opt_out", SAT_1900);
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("first", { due_at: SAT_1900 }));
  assert.deepEqual(await dispatchDue(DB, {}, SAT_1900, { send }), { sent: 0, failed: 0, held: 0 });
  const row = await message(DB, id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.error, "Suppressed: opt_out");
  assert.deepEqual(await dispatchDue(DB, {}, MON_0700, { send }), { sent: 0, failed: 0, held: 0 });
  assert.equal(calls.length, 0);
});

test("a missing password holds the row until it's saved", async () => {
  const DB = await setup({ password: null });
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("reply", { due_at: "2026-10-25T09:00:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, SUNDAY, { send }), { sent: 0, failed: 0, held: 1 });
  assert.equal((await message(DB, id)).status, "queued");
  assert.equal(calls.length, 0);
  await setSecret(DB, "mailbox:m1", "pw");
  assert.deepEqual(await dispatchDue(DB, {}, new Date("2026-10-25T10:05:00Z"), { send }), { sent: 1, failed: 0, held: 0 });
});

for (const [what, saved] of [["never saved", null], ["saved empty", ""]]) test(`rows held for a missing password (${what}) don't use up the limit`, async () => {
  const DB = await setup();
  await addMailbox(DB, { id: "m2", address: "sam@aetoswebsites.com", display_name: "Sam" });
  if (saved !== null) await setSecret(DB, "mailbox:m2", saved);
  const { send, calls } = recorder();
  const held = [];
  for (let i = 0; i < 3; i++) {
    held.push(await queueMessage(DB, out("reply", { mailbox_id: "m2", to_addr: `w${i}@y.com`, due_at: `2026-10-25T09:0${i}:00Z` })));
  }
  const ready = await queueMessage(DB, out("reply", { to_addr: "r@y.com", due_at: "2026-10-25T09:30:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, SUNDAY, { limit: 1, send }), { sent: 1, failed: 0, held: 3 });
  assert.equal((await message(DB, ready)).status, "sent");
  for (const id of held) assert.equal((await message(DB, id)).status, "queued");
  assert.deepEqual(calls.map((c) => c.message.to), ["r@y.com"]);
  // the sender gets the mailbox row itself, nothing added to it
  assert.deepEqual(calls[0].mailbox, { ...MAILBOX, smtp_host: "mail.privateemail.com", smtp_port: 465 });
});

test("a line break in the subject (scraped business name) fails the row; nothing is sent", async () => {
  const DB = await setup();
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("first", { subject: "Hi\r\nBcc: x@y.com", due_at: "2026-10-20T08:30:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 0, failed: 1, held: 0 });
  const row = await message(DB, id);
  assert.equal(row.status, "failed");
  assert.equal(row.error, "Header values can't contain line breaks");
  assert.equal(calls.length, 0);
});

test("a non-ASCII subject and sender name are RFC 2047 encoded on the way out", async () => {
  const DB = await setup({ mailbox: { display_name: "Café Nik" } });
  const { send, calls } = recorder();
  await queueMessage(DB, out("reply", { subject: "Re: Café Plumbing Ltd", due_at: "2026-10-25T09:00:00Z" }));
  await dispatchDue(DB, {}, SUNDAY, { send });
  assert.equal(calls[0].message.headers.From, "=?UTF-8?B?Q2Fmw6kgTmlr?= <nik@aetoswebsites.com>");
  assert.match(calls[0].message.headers.Subject, /^=\?UTF-8\?B\?/);
});

test("the footer check: the opt-out line must be the last line (trailing blank lines are fine)", async () => {
  const DB = await setup();
  const { send } = recorder();
  const ok = await queueMessage(DB, out("followup", { body: `${COLD_BODY}\n\n`, due_at: "2026-10-20T08:00:00Z" }));
  const crlf = await queueMessage(DB, out("followup", { body: COLD_BODY.replace(/\n/g, "\r\n"), due_at: "2026-10-20T08:01:00Z" }));
  const moved = await queueMessage(DB, out("followup", { body: `${OPT_OUT_LINE}\n\nNik`, due_at: "2026-10-20T08:02:00Z" }));
  await dispatchDue(DB, {}, TUE, { limit: 5, send });
  assert.equal((await message(DB, ok)).status, "sent");
  assert.equal((await message(DB, crlf)).status, "sent");
  assert.equal((await message(DB, moved)).status, "failed");
  assert.equal((await message(DB, moved)).error, 'Missing the "no thanks" line');
});

test("suppression: a suppressed domain cancels a first email; reasons match isSuppressed", async () => {
  const DB = await setup();
  await suppress(DB, "x.com", "domain", "manual", TUE);
  await suppress(DB, "amy@y.com", "email", "bounce", TUE);
  const { send, calls } = recorder();
  const cases = [["bob@x.com", true], ["Amy@Y.com", true], ["sam@mail.x.com", false], ["zed@y.com", false]];
  const ids = [];
  for (const [i, [to]] of cases.entries()) {
    ids.push(await queueMessage(DB, out("first", { to_addr: to, due_at: `2026-10-20T08:0${i}:00Z` })));
  }
  await dispatchDue(DB, {}, TUE, { limit: 10, send });
  for (const [i, [to, blocked]] of cases.entries()) {
    const row = await message(DB, ids[i]);
    const reason = await isSuppressed(DB, to);
    assert.equal(row.status, blocked ? "cancelled" : "sent", to);
    assert.equal(row.error, reason ? `Suppressed: ${reason}` : null, to);
  }
  assert.deepEqual(calls.map((c) => c.message.to).sort(), ["sam@mail.x.com", "zed@y.com"]);
});

test("a send that throws is recorded as failed, saying it may or may not have gone", async () => {
  const DB = await setup();
  const id = await queueMessage(DB, out("reply", { due_at: "2026-10-25T09:00:00Z" }));
  const send = async () => {
    throw new Error("socket closed (password pw)");
  };
  assert.deepEqual(await dispatchDue(DB, {}, SUNDAY, { send }), { sent: 0, failed: 1, held: 0 });
  const row = await message(DB, id);
  assert.equal(row.status, "failed");
  assert.match(row.error, /socket closed/);
  assert.match(row.error, /may or may not have gone: check the Sent folder in Namecheap webmail/);
});

test("an error never carries the mailbox password", async () => {
  const DB = await setup({ password: "s3cret-pass" });
  const id = await queueMessage(DB, out("reply", { due_at: "2026-10-25T09:00:00Z" }));
  const send = async () => ({ ok: false, error: "535 rejected s3cret-pass" });
  await dispatchDue(DB, {}, SUNDAY, { send });
  const row = await message(DB, id);
  assert.equal(row.status, "failed");
  assert.doesNotMatch(row.error, /s3cret-pass/);
  assert.match(row.error, /\[hidden\]/);
});

test("a message whose mailbox was removed fails with a plain reason", async () => {
  const DB = await setup();
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("reply", { mailbox_id: "gone", due_at: "2026-10-25T09:00:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, SUNDAY, { send }), { sent: 0, failed: 1, held: 0 });
  const row = await message(DB, id);
  assert.equal(row.status, "failed");
  assert.match(row.error, /isn't on Setup → Mailboxes any more/);
  assert.equal(calls.length, 0);
});

test("a System mailbox never sends cold email", async () => {
  const DB = await setup({ mailbox: { role: "system" } });
  const { send, calls } = recorder();
  const first = await queueMessage(DB, out("first", { due_at: "2026-10-20T08:30:00Z" }));
  const reply = await queueMessage(DB, out("reply", { to_addr: "r@y.com", due_at: "2026-10-20T08:30:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 1, failed: 1, held: 0 });
  const row = await message(DB, first);
  assert.equal(row.status, "failed");
  assert.match(row.error, /nik@aetoswebsites\.com is a System mailbox/);
  assert.equal((await message(DB, reply)).status, "sent");
  assert.deepEqual(calls.map((c) => c.message.to), ["r@y.com"]);
});

test("held follow-ups from a paused mailbox never block other mailboxes' mail or replies", async () => {
  const DB = await setup();
  await addMailbox(DB, { id: "m2", address: "sam@aetoswebsites.com", display_name: "Sam", status: "paused", paused_reason: "2 emails bounced" });
  await setSecret(DB, "mailbox:m2", "pw2");
  for (let i = 0; i < 30; i++) {
    await queueMessage(DB, out("followup", { mailbox_id: "m2", to_addr: `p${i}@y.com`, due_at: `2026-10-19T08:${String(i).padStart(2, "0")}:00Z` }));
  }
  const followup = await queueMessage(DB, out("followup", { to_addr: "m1@y.com", due_at: "2026-10-20T08:30:00Z" }));
  const reply = await queueMessage(DB, out("reply", { to_addr: "r@y.com", due_at: "2026-10-20T08:40:00Z" }));
  const { send, calls } = recorder();
  // m2's held rows are looked at only up to limit × 10, so the scan stays small
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 2, failed: 0, held: 20 });
  assert.equal((await message(DB, followup)).status, "sent");
  assert.equal((await message(DB, reply)).status, "sent");
  assert.deepEqual(calls.map((c) => c.message.to), ["m1@y.com", "r@y.com"]);
});

test("bad options are refused with a plain message", async () => {
  const DB = await setup();
  await assert.rejects(dispatchDue(DB, {}, "not a time"), /now must be a time/);
  await assert.rejects(dispatchDue(DB, {}, SUNDAY, { limit: -1 }), /limit/);
  await assert.rejects(dispatchDue(DB, {}, SUNDAY, { kinds: ["inbound"] }), /kinds/);
  await assert.rejects(dispatchDue(DB, {}, SUNDAY, { kinds: "reply" }), /kinds/);
});

test("dispatchDue with nothing due makes 2 D1 queries (the stuck sweep and the due rows)", async () => {
  const DB = await setup();
  const c = counting(DB);
  assert.deepEqual(await dispatchDue(c.DB, {}, SUNDAY, { send: recorder().send }), { sent: 0, failed: 0, held: 0 });
  assert.equal(c.n, 2);
});

// ---------------------------------------------------------------- queueMessage

const FULL = { direction: "out", kind: "reply", author: "claude", to_addr: "bob@x.com", body: "Hi Bob" };

test("queueMessage: defaults to status queued, due now, a UUID id", async () => {
  const DB = fakeD1();
  const before = Date.now();
  const id = await queueMessage(DB, { ...FULL, kind: "system", author: "system", to_addr: " amy@y.com " });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const row = await message(DB, id);
  assert.equal(row.status, "queued");
  assert.equal(row.direction, "out");
  assert.equal(row.kind, "system");
  assert.equal(row.to_addr, "amy@y.com");
  assert.match(row.due_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Math.abs(Date.parse(row.due_at) - before) < 5000, row.due_at);
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(row.message_id, null);
  assert.equal(row.needs_reply, 0);
});

test("queueMessage: each required field missing (or blank) throws 'queueMessage: <field> is required'", async () => {
  const DB = fakeD1();
  for (const field of ["direction", "kind", "author", "to_addr", "body"]) {
    const msg = { ...FULL };
    delete msg[field];
    await assert.rejects(queueMessage(DB, msg), { name: "Error", message: `queueMessage: ${field} is required` });
    await assert.rejects(queueMessage(DB, { ...FULL, [field]: null }), { message: `queueMessage: ${field} is required` });
    await assert.rejects(queueMessage(DB, { ...FULL, [field]: " " }), { message: `queueMessage: ${field} is required` });
  }
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM messages").first("n"), 0);
});

test("queueMessage: refuses inbound mail, unknown kinds and fields that aren't columns", async () => {
  const DB = fakeD1();
  await assert.rejects(queueMessage(DB, { ...FULL, direction: "in" }), /direction must be "out"/);
  await assert.rejects(queueMessage(DB, { ...FULL, kind: "inbound" }), /kind must be first, followup, reply or system/);
  await assert.rejects(queueMessage(DB, { ...FULL, inReplyTo: "<a@b>" }), /inReplyTo isn't a column of messages/);
  await assert.rejects(queueMessage(DB, { ...FULL, status: "received" }), /status/);
  await assert.rejects(queueMessage(DB, { ...FULL, due_at: "soon" }), /due_at must be a time/);
  await assert.rejects(queueMessage(DB, { ...FULL, subject: { text: "x" } }), /subject must be text/);
  await assert.rejects(queueMessage(DB, null), /queueMessage needs/);
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM messages").first("n"), 0);
});

test("queueMessage: keeps what it's given; Date and ISO times are stored as UTC ISO text", async () => {
  const DB = fakeD1();
  const id = await queueMessage(DB, {
    ...FULL, id: "msg-1", kind: "followup", author: "system", step: 3, place_id: "p1", client_id: null, mailbox_id: "m1",
    from_addr: "nik@aetoswebsites.com", subject: "Re: Your new website", message_id: "<f@aetoswebsites.com>",
    in_reply_to: "<root@aetoswebsites.com>", refs: "<root@aetoswebsites.com> <f1@aetoswebsites.com>",
    due_at: new Date("2026-10-23T08:15:00.250Z"), created_at: new Date("2026-10-22T08:15:00Z"),
  });
  assert.equal(id, "msg-1");
  const row = await message(DB, id);
  assert.equal(row.step, 3);
  assert.equal(row.place_id, "p1");
  assert.equal(row.mailbox_id, "m1");
  assert.equal(row.message_id, "<f@aetoswebsites.com>");
  assert.equal(row.in_reply_to, "<root@aetoswebsites.com>");
  assert.equal(row.refs, "<root@aetoswebsites.com> <f1@aetoswebsites.com>");
  assert.equal(row.due_at, "2026-10-23T08:15:00Z");
  assert.equal(row.created_at, "2026-10-22T08:15:00Z");
  const iso = await queueMessage(DB, { ...FULL, due_at: "2026-10-23T08:15:00.000Z" });
  assert.equal((await message(DB, iso)).due_at, "2026-10-23T08:15:00Z");
  const two = await queueMessage(DB, FULL);
  assert.notEqual(two, iso, "each message gets its own id");
});

// ---------------------------------------------------------------- sentToday

test("sentToday counts first + followup sent since UK midnight, plus any sending, per mailbox", async () => {
  const DB = await setup();
  const now = new Date("2026-10-20T12:00:00Z"); // UK midnight was 2026-10-19T23:00:00Z (BST)
  const rows = [
    ["a", "m1", "first", "sent", "2026-10-19T23:30:00Z"], // after UK midnight: counts
    ["b", "m1", "followup", "sent", "2026-10-19T22:30:00Z"], // before UK midnight (yesterday in the UK)
    ["c", "m1", "first", "sending", null], // counts
    ["d", "m1", "reply", "sent", "2026-10-20T09:00:00Z"], // not cold
    ["e", "m1", "system", "sent", "2026-10-20T09:00:00Z"], // not cold
    ["f", "m1", "first", "failed", null],
    ["g", "m1", "first", "queued", null],
    ["h", "m1", "first", "cancelled", null],
    ["i", "m2", "followup", "sent", "2026-10-20T11:00:00Z"], // counts for m2
  ];
  for (const [id, mailbox_id, kind, status, sent_at] of rows) {
    await insert(DB, "messages", {
      id, mailbox_id, direction: "out", kind, author: AUTHOR[kind], to_addr: "x@y.com", body: COLD_BODY, status,
      sent_at, due_at: "2026-10-19T20:00:00Z", created_at: "2026-10-19T20:00:00Z",
    });
  }
  assert.deepEqual(await sentToday(DB, now), { m1: 2, m2: 1 });
  assert.deepEqual(await sentToday(fakeD1(), now), {});
});

test("sentToday counts by the UK day across the October clock change", async () => {
  const DB = await setup();
  // Mon 26 Oct is GMT: UK midnight is 00:00Z. 23:30Z on the 25th was Sunday in the UK.
  for (const [id, sent_at] of [["a", "2026-10-25T23:30:00Z"], ["b", "2026-10-26T00:00:00Z"]]) {
    await insert(DB, "messages", {
      id, mailbox_id: "m1", direction: "out", kind: "first", author: "nik", to_addr: "x@y.com", body: COLD_BODY,
      status: "sent", sent_at, due_at: "2026-10-25T20:00:00Z", created_at: "2026-10-25T20:00:00Z",
    });
  }
  assert.deepEqual(await sentToday(DB, new Date("2026-10-26T09:00:00Z")), { m1: 1 });
});

// ---------------------------------------------------------------- the tick step

test("sendStep: the 'send' step, every tick, summing up dispatchDue", async () => {
  assert.equal(sendStep.name, "send");
  assert.equal(sendStep.everyMinutes, 0);
  assert.equal(typeof sendStep.run, "function");
  const DB = await setup();
  await queueMessage(DB, out("first", { due_at: "2026-10-24T17:00:00Z" })); // held: Saturday 19:00
  await queueMessage(DB, out("followup", { body: "no footer", due_at: "2026-10-24T17:00:00Z" })); // failed
  const ctx = { DB, env: {}, now: SAT_1900, reason: "cron", results: {}, budget: { left: () => 40 } };
  assert.equal(await sendStep.run(ctx), "sent 0, failed 1, held 1");
});

test("sendStep sends through sendViaSmtp by default, which never throws (in Node it can't load the library)", async () => {
  const DB = await setup();
  const id = await queueMessage(DB, out("reply", { due_at: "2026-10-25T09:00:00Z" }));
  const ctx = { DB, env: {}, now: SUNDAY, reason: "cron", results: {}, budget: { left: () => 40 } };
  assert.equal(await sendStep.run(ctx), "sent 0, failed 1, held 0");
  const row = await message(DB, id);
  assert.equal(row.status, "failed");
  assert.ok(row.error.length > 0);
});

test("sendStep stays inside the tick's D1 budget (50 a tick; it may be started with only 10 left), leaving one for the tick's beat", async () => {
  // m2 has no password, so the first emails are given m1 (pickMailbox only gets mailboxes that can send)
  // m3's held follow-ups are looked at only up to limit × 10
  // The runner always ends a tick by beating `tick` (its last query), so the step leaves one query unused.
  for (const [left, attempts] of [[10, 1], [13, 1], [14, 2], [15, 2], [50, 2]]) {
    const DB = await setup();
    await addMailbox(DB, { id: "m2", address: "sam@aetoswebsites.com", display_name: "Sam" }); // no password
    await addMailbox(DB, { id: "m3", address: "kim@aetoswebsites.com", display_name: "Kim", status: "paused" });
    await setSecret(DB, "mailbox:m3", "pw3");
    for (let i = 0; i < 25; i++) {
      await queueMessage(DB, out("followup", { mailbox_id: "m3", to_addr: `h${i}@y.com`, due_at: "2026-10-20T07:00:00Z" }));
      await queueMessage(DB, out("reply", { mailbox_id: "m2", to_addr: `w${i}@y.com`, due_at: "2026-10-20T07:00:00Z" }));
    }
    for (let i = 0; i < 5; i++) {
      await seedProspect(DB, `p${i}`, { email: `f${i}@y.com` });
      await queueMessage(DB, out("first", { place_id: `p${i}`, mailbox_id: null, to_addr: `f${i}@y.com`, due_at: `2026-10-20T08:0${i}:00Z` }));
    }
    const c = counting(DB);
    // real sendViaSmtp: in Node every send fails fast, which costs the same queries as a success
    const summary = await sendStep.run({ DB: c.DB, env: {}, now: TUE, reason: "cron", results: {}, budget: { left: () => left } });
    assert.ok(c.n <= left - 1, `left ${left}: made ${c.n} queries (${summary}), leaving none for the tick's beat`);
    assert.equal(summary, `sent 0, failed ${attempts}, held ${attempts * 10}`, `left ${left}`);
  }
});

// ---------------------------------------------------------------- review 3: suppression before any hold

// Part A: "Suppressed means cancelled", checked right after the footer (Task 13's order: footer, suppression,
// mailbox, paused, window, cap, password), so a suppressed row is never left waiting (and counted as held).
test("suppression comes before every hold: a suppressed first from a paused mailbox is cancelled, not held", async () => {
  const DB = await setup({ mailbox: { status: "paused", paused_reason: "2 emails bounced in 7 days (last: a@b.com)." } });
  await suppress(DB, "bob@x.com", "email", "opt_out", TUE);
  const { send, calls } = recorder();
  const id = await queueMessage(DB, out("first", { due_at: "2026-10-20T08:30:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 0, failed: 0, held: 0 });
  const row = await message(DB, id);
  assert.equal(row.status, "cancelled");
  assert.ok(row.error.startsWith("Suppressed:"), row.error);
  assert.equal(row.error, "Suppressed: opt_out");
  assert.equal(calls.length, 0);
});

test("a suppressed first over the cap, or with no mailbox that has room, is cancelled, not held", async () => {
  for (const [what, mailbox, extra] of [
    ["over the cap", { cap_override: 0 }, {}],
    ["no mailbox with room", { cap_override: 0 }, { mailbox_id: null }],
    ["a warming-up mailbox", { started_on: "2026-10-19" }, {}],
  ]) {
    const DB = await setup({ mailbox });
    await suppress(DB, "x.com", "domain", "manual", TUE);
    const { send, calls } = recorder();
    const id = await queueMessage(DB, out("followup", { due_at: "2026-10-20T08:30:00Z", ...extra }));
    assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 0, failed: 0, held: 0 }, what);
    const row = await message(DB, id);
    assert.equal(row.status, "cancelled", what);
    assert.equal(row.error, "Suppressed: manual", what);
    assert.equal(calls.length, 0, what);
  }
});

test("a suppressed reply whose mailbox has no password is cancelled, not held; system mail to them still goes", async () => {
  const DB = await setup({ password: null });
  await addMailbox(DB, { id: "s1", address: "team@aetoswebsites.com", display_name: "Aetos Team", role: "system", status: "paused" });
  await setSecret(DB, "mailbox:s1", "pw3");
  await suppress(DB, "Bob@X.com", "email", "bounce", SUNDAY);
  const { send, calls } = recorder();
  const reply = await queueMessage(DB, out("reply", { due_at: "2026-10-25T09:00:00Z" }));
  const system = await queueMessage(DB, out("system", { mailbox_id: "s1", due_at: "2026-10-25T09:00:00Z" }));
  assert.deepEqual(await dispatchDue(DB, {}, SUNDAY, { send }), { sent: 1, failed: 0, held: 0 });
  const r = await message(DB, reply);
  assert.equal(r.status, "cancelled");
  assert.equal(r.error, "Suppressed: bounce");
  assert.equal((await message(DB, system)).status, "sent"); // a paying client's mail always goes, paused mailbox or not
  assert.deepEqual(calls.map((c) => c.message.to), ["bob@x.com"]);
  assert.equal(calls[0].mailbox.id, "s1");
});

test("suppression is read once per call, whatever the number of rows, and not at all for system mail only", async () => {
  const reads = (DB) => {
    const c = { n: 0 };
    c.DB = { ...DB, prepare: (sql) => (/^\s*SELECT\b[\s\S]*\bFROM suppression\b/.test(sql) && c.n++, DB.prepare(sql)) };
    return c;
  };
  const DB = await setup({ mailbox: { status: "paused" } });
  await suppress(DB, "r3@y.com", "email", "opt_out", TUE);
  for (let i = 0; i < 6; i++) await queueMessage(DB, out(i % 2 ? "reply" : "followup", { to_addr: `r${i}@y.com`, due_at: "2026-10-20T08:00:00Z" }));
  const c = reads(DB);
  const { send, calls } = recorder();
  assert.deepEqual(await dispatchDue(c.DB, {}, TUE, { limit: 5, send }), { sent: 2, failed: 0, held: 3 });
  assert.equal(c.n, 1, "one batched read for six rows"); // r1 and r5 sent, r3 cancelled, the follow-ups held
  assert.deepEqual(calls.map((x) => x.message.to).sort(), ["r1@y.com", "r5@y.com"]);

  const sys = await setup();
  await queueMessage(sys, out("system", { to_addr: "client@y.com", due_at: "2026-10-20T08:00:00Z" }));
  const s = reads(sys);
  assert.deepEqual(await dispatchDue(s.DB, {}, TUE, { send: recorder().send }), { sent: 1, failed: 0, held: 0 });
  assert.equal(s.n, 0);
});

test("an opt-out that lands between the suppression read and the claim: the row isn't sent, and is cancelled next call", async () => {
  const DB = await setup();
  const id = await queueMessage(DB, out("first", { due_at: "2026-10-20T08:30:00Z" }));
  const racing = {
    ...DB,
    prepare: (sql) => {
      if (/^\s*UPDATE messages SET status = 'sending'/.test(sql)) {
        DB.raw.prepare("INSERT OR IGNORE INTO suppression (value, kind, reason, created_at) VALUES ('bob@x.com', 'email', 'opt_out', '2026-10-20T09:00:00Z')").run();
      }
      return DB.prepare(sql);
    },
  };
  const { send, calls } = recorder();
  assert.deepEqual(await dispatchDue(racing, {}, TUE, { send }), { sent: 0, failed: 0, held: 0 });
  assert.equal(calls.length, 0);
  assert.equal((await message(DB, id)).status, "queued");
  assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 0, failed: 0, held: 0 });
  const row = await message(DB, id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.error, "Suppressed: opt_out");
  assert.equal(calls.length, 0);
});

test("suppressionReasons: one query for many addresses, keyed as given; the address's own reason beats its domain's", async () => {
  const DB = fakeD1();
  await suppress(DB, "x.com", "domain", "manual", TUE);
  await suppress(DB, "bob@x.com", "email", "opt_out", TUE);
  await suppress(DB, "amy@y.com", "email", "bounce", TUE);
  // A company row never matches an address, even one stored under the same text.
  DB.raw.prepare("INSERT INTO suppression (value, kind, reason, created_at) VALUES ('zed@y.com', 'company', 'manual', '2026-10-20T09:00:00Z')").run();
  const given = ["Bob <Bob@X.com>", "sam@x.com", "AMY@y.com", "zed@y.com", "sam@mail.x.com", "", "y.com"];
  const c = counting(DB);
  const reasons = await suppressionReasons(c.DB, given);
  assert.equal(c.n, 1);
  assert.deepEqual(Object.fromEntries(reasons), { "Bob <Bob@X.com>": "opt_out", "sam@x.com": "manual", "AMY@y.com": "bounce" });
  for (const email of given) assert.equal(reasons.get(email) ?? null, await isSuppressed(DB, email), email);
  const none = counting(DB);
  assert.deepEqual([...(await suppressionReasons(none.DB, []))], []);
  assert.equal(none.n, 0);
});

// ---------------------------------------------------------------- review 3: "may or may not have gone" errors

// smtp.js's sendViaSmtp with a stand-in for worker-mailer.
const smtpWith = ({ connectError, sendError } = {}) => (mailbox, password, msg) => sendViaSmtp(mailbox, password, msg, {
  mailer: {
    connect: async () => {
      if (connectError) throw connectError;
      return { send: async () => { if (sendError) throw sendError; }, close: async () => {} };
    },
  },
});

// Stage 6 never retries a failed follow-up whose error starts with INTERRUPTED_PREFIX (it may have gone) and retries
// any other failure the next morning, so every error that means "it may have gone" has to start with it.
test("every stored error that means \"it may have gone\" starts with INTERRUPTED_PREFIX; a definite failure doesn't", async () => {
  assert.equal(INTERRUPTED_PREFIX, "The send was interrupted");
  assert.equal(INTERRUPTED_PREFIX, SMTP_INTERRUPTED_PREFIX); // one marker, in smtp.js; stage 6 imports it from here
  for (const [what, send, maybe] of [
    ["send() throws", async () => { throw new Error("socket closed"); }, true],
    ["no answer while sending", smtpWith({ sendError: new Error("Timeout while waiting for smtp server response") }), true],
    ["the line broke while sending", smtpWith({ sendError: new Error("Network connection lost.") }), true],
    ["refused (5xx)", smtpWith({ sendError: new Error("Failed send email body: 554 5.7.1 Rejected") }), false],
    ["not now (4xx)", smtpWith({ sendError: new Error("Invalid MAIL FROM: <nik@aetoswebsites.com> 451 4.7.1 Slow down") }), false],
    ["RCPT refused", smtpWith({ sendError: new Error("Invalid RCPT TO: <bob@x.com> 550 5.1.1 User unknown") }), false],
    ["couldn't connect", smtpWith({ connectError: new Error("Socket timeout!") }), false],
    ["wrong password", smtpWith({ connectError: new Error("535 5.7.8 Authentication failed") }), false],
  ]) {
    const DB = await setup();
    const id = await queueMessage(DB, out("followup", { due_at: "2026-10-20T08:30:00Z" }));
    assert.deepEqual(await dispatchDue(DB, {}, TUE, { send }), { sent: 0, failed: 1, held: 0 }, what);
    const { status, error } = await message(DB, id);
    assert.equal(status, "failed", what);
    assert.equal(error.startsWith(`${INTERRUPTED_PREFIX}: `), maybe, `${what}: ${error}`);
    assert.equal(error.includes("It may or may not have gone"), maybe, `${what}: ${error}`);
  }

  // The stuck sweep: the spec's exact text, which starts with it too.
  const DB = await setup();
  await insert(DB, "messages", {
    id: "stuck", mailbox_id: "m1", direction: "out", kind: "followup", author: "system", to_addr: "bob@x.com",
    body: COLD_BODY, status: "sending", due_at: "2026-10-20T08:00:00Z", created_at: "2026-10-20T08:00:00Z",
  });
  await dispatchDue(DB, {}, TUE, { send: recorder().send });
  const stuck = await message(DB, "stuck");
  assert.equal(stuck.error, STUCK_TEXT);
  assert.ok(stuck.error.startsWith(INTERRUPTED_PREFIX));

  // The 1,000-character cap cuts only the end, so the prefix always survives.
  const long = await queueMessage(DB, out("reply", { due_at: "2026-10-20T08:30:00Z" }));
  await dispatchDue(DB, {}, TUE, { send: async () => { throw new Error("x".repeat(5000)); } });
  const { error } = await message(DB, long);
  assert.equal(error.length, 1000);
  assert.ok(error.startsWith(`${INTERRUPTED_PREFIX}: the send stopped with an error (xxx`), error.slice(0, 80));
});
