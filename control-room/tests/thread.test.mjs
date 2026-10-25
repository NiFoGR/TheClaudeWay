// Thread, cancel and retry (stage 5–6, docs/rebuild/06-email-followups.md Part A §A8, Part B Task 11): threadSummary
// (the drawer's summary line, pure), loadThread (the summary and every message of a lead, oldest first), cancelMessage
// (a queued outgoing email: a first email leaves the lead ready, a follow-up skips that step) and retryFirst (a failed
// first email queued again as a copy with a new Message-ID), and their routes GET /api/thread/:place_id,
// POST /api/messages/:id/cancel and POST /api/messages/:id/retry.
// Run: node --test control-room/tests/thread.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { TEMPLATES } from "../functions/_lib/demo/render.js";
import { composeContext, sendFirst } from "../functions/_lib/first-email.js";
import { closeTime, followupsStep, nextDue, retryFailed } from "../functions/_lib/followups.js";
import { dispatchDue } from "../functions/_lib/mail/outbox.js";
import { setSecret, setSetting } from "../functions/_lib/settings.js";
import { THREAD_ERRORS, cancelMessage, loadThread, retryFirst, threadSummary } from "../functions/_lib/thread.js";
import { iso } from "../functions/_lib/util.js";
import { onRequestPost as cancelPost } from "../functions/api/messages/[id]/cancel.js";
import { onRequestPost as retryPost } from "../functions/api/messages/[id]/retry.js";
import { onRequestGet as threadGet } from "../functions/api/thread/[id].js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { seedDemo, seedLead, seedMailbox, seedMessage, seedProspect, seedResearch } from "./helpers/shortlistSeed.mjs";

const NOW = new Date("2026-10-22T08:15:00Z"); // Thu 09:15 BST: inside the cold window
const FIRST = "2026-10-22T08:15:00Z"; // the worked example's first email (Part A §A4)
const ROOT = "<root@aetoswebsites.com>";
const MARK = { first: "Mark", full: "Mark Green", source_url: "https://greenleaf.co.uk/about", confident: true };
const EMAILS = [
  { email: "mark@greenleaf.co.uk", source_url: "https://greenleaf.co.uk/contact", where: "Contact page" },
  { email: "info@greenleaf.co.uk", source_url: "https://greenleaf.co.uk/", where: "Footer" },
];
const input = { to: "mark@greenleaf.co.uk", subject: "Your website", body: "I made you a site: {demo_link}" };

const getProspect = (DB, id) => DB.prepare("SELECT * FROM prospects WHERE place_id = ?").bind(id).first();
const getMessage = (DB, id) => DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
const countOf = async (DB, sql) => Number((await DB.prepare(sql).first()).n);
const approveAll = (DB) => DB.prepare(
  `INSERT INTO followup_templates (step, day_offset, body, status, approved_at)
   SELECT value, value, '{greeting}', 'approved', '2026-10-01T09:00:00Z' FROM json_each('[1,2,3,4,5,6,7,8,9]')`,
).run();

/**
 * Lead p1 "Green Leaf Landscapes" ready to email (as first-email.test.mjs's readyLead): research done (grade A, owner
 * Mark confident, his addresses), demo green-leaf live with the landscaper look approved, prospect `ready`, cold mailbox
 * m1 (nik@aetoswebsites.com, cap 10) and business:sender_name "Nik".
 */
async function readyLead() {
  const DB = fakeD1();
  await seedMailbox(DB, { id: "m1", address: "nik@aetoswebsites.com", display_name: "Nik Example", started_on: "2026-01-01", cap_override: 10 });
  await setSetting(DB, "business:sender_name", "Nik");
  await setSetting(DB, "demo:template:landscaper:approved",
    JSON.stringify({ version: TEMPLATES.landscaper.TEMPLATE.version, at: "2026-10-01T09:00:00Z" }));
  await seedLead(DB, { place_id: "p1", name: "Green Leaf Landscapes", trade: "landscaper", company_number: "01234567" });
  await seedResearch(DB, { place_id: "p1", grade: "A", owner: MARK, emails: EMAILS, best_email: "mark@greenleaf.co.uk" });
  await seedDemo(DB, { place_id: "p1", slug: "green-leaf" });
  await seedProspect(DB, { place_id: "p1", stage: "ready", email: "mark@greenleaf.co.uk", greet_name: "Mark" });
  return DB;
}

/** readyLead(), its first email queued by Send at NOW, then failed in the outbox ("Mailbox password rejected"). */
async function failedFirst() {
  const DB = await readyLead();
  const sent = await sendFirst(DB, "p1", input, NOW);
  assert.equal(sent.ok, true);
  await setSecret(DB, "mailbox:m1", "pw");
  const tally = await dispatchDue(DB, {}, NOW, { send: async () => ({ ok: false, error: "Mailbox password rejected" }) });
  assert.equal(tally.failed, 1);
  return { DB, id: sent.id };
}

/**
 * p1 emailed at FIRST from m1 (subject "Your website", root ROOT), `step` follow-ups done, next_followup_at `next`, and
 * its first email as a sent messages row "first". `stage` changes the prospect's.
 */
async function emailedLead({ step = 2, next = null, stage = "emailed", lost_reason = null } = {}) {
  const DB = fakeD1();
  await seedMailbox(DB, { id: "m1", address: "nik@aetoswebsites.com", started_on: "2026-01-01", cap_override: 10 });
  await setSetting(DB, "business:sender_name", "Nik");
  await seedLead(DB, { place_id: "p1", name: "Green Leaf Landscapes" });
  await seedProspect(DB, { place_id: "p1", stage, lost_reason, email: "mark@greenleaf.co.uk", greet_name: "Mark", mailbox_id: "m1",
    subject: "Your website", root_message_id: ROOT, first_sent_at: FIRST, followup_step: step, next_followup_at: next });
  await seedMessage(DB, { id: "first", place_id: "p1", kind: "first", status: "sent", to_addr: "mark@greenleaf.co.uk",
    from_addr: "nik@aetoswebsites.com", subject: "Your website", message_id: ROOT, due_at: FIRST, sent_at: FIRST, created_at: FIRST });
  return DB;
}

/** A follow-up row for p1: step `step`, `status`, due `due_at` (sent ones went then). */
const followup = (DB, id, step, status, due_at, extra = {}) => seedMessage(DB, {
  id, place_id: "p1", kind: "followup", step, status, to_addr: "mark@greenleaf.co.uk", from_addr: "nik@aetoswebsites.com",
  subject: "Re: Your website", body: `Follow-up ${step}`, due_at, sent_at: status === "sent" ? due_at : null,
  in_reply_to: ROOT, refs: ROOT, created_at: due_at, ...extra,
});

/** An inbound message from them on p1. */
const inbound = (DB, id, cls, received_at) => seedMessage(DB, {
  id, place_id: "p1", kind: "inbound", class: cls, subject: "Re: Your website", body: "Thanks", received_at,
  from_addr: "mark@greenleaf.co.uk", to_addr: "nik@aetoswebsites.com", created_at: received_at,
});

// ---------------------------------------------------------------- the plan's tests (Part B, Task 11, Step 1)

test("summary lines", () => {
  assert.equal(threadSummary({ stage: "emailed", followup_step: 2, next_followup_at: "2026-10-26T09:15:00Z" }, { approved: true }), "Follow-up 3 of 9: Mon 26 Oct 09:15");
  assert.equal(threadSummary({ stage: "replied" }, { approved: true }), "Follow-ups stopped: they replied");
  assert.equal(threadSummary({ stage: "lost", lost_reason: "opt_out" }, { approved: true }), "Follow-ups stopped: they opted out");
  assert.equal(threadSummary({ stage: "emailed", followup_step: 9, next_followup_at: "2026-12-28T09:15:00Z" }, { approved: true }), "Follow-ups finished: marked lost on Mon 28 Dec if no reply");
  assert.equal(threadSummary({ stage: "emailed", followup_step: 0, next_followup_at: "2026-10-23T08:15:00Z" }, { approved: false }), "Follow-ups paused: approve your follow-up emails on the Voice page");
});

test("cancel a queued follow-up skips that step", async () => {
  /* step 3 queued → cancelled; followup_step 3; next_followup_at = nextDue(first, 4, now) */
  const DB = await emailedLead({ step: 2, next: null });
  await followup(DB, "f3", 3, "queued", "2026-10-26T09:15:00Z");
  const now = new Date("2026-10-26T08:00:00Z"); // Mon 08:00 GMT, before it went
  assert.deepEqual(await cancelMessage(DB, "f3", now), { ok: true });
  assert.equal((await getMessage(DB, "f3")).status, "cancelled");
  const p = await getProspect(DB, "p1");
  assert.equal(p.followup_step, 3);
  assert.equal(p.next_followup_at, iso(nextDue(FIRST, 4, now)));
  assert.equal(p.next_followup_at, "2026-10-29T09:15:00Z");                  // step 4 on its own day, as planned
  assert.equal(p.stage, "emailed");
});

test("cancel refuses a sent message", async () => {
  /* → {ok:false, error:"This email has already gone, so it can't be cancelled."} */
  const DB = await emailedLead();
  const r = await cancelMessage(DB, "first", NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, "This email has already gone, so it can't be cancelled.");
  assert.equal(r.status, 409);
  assert.equal((await getMessage(DB, "first")).status, "sent");
});

test("cancel a queued first email leaves the lead ready", async () => {
  /* status cancelled, stage ready, composeContext.blocking has no queued_already */
  const DB = await readyLead();
  const sent = await sendFirst(DB, "p1", input, NOW);
  assert.equal(sent.ok, true);
  assert.equal((await composeContext(DB, "p1", NOW)).blocking[0]?.code, "queued_already"); // before: it's waiting
  assert.deepEqual(await cancelMessage(DB, sent.id, NOW), { ok: true });
  assert.equal((await getMessage(DB, sent.id)).status, "cancelled");
  assert.equal((await getProspect(DB, "p1")).stage, "ready");
  const ctx = await composeContext(DB, "p1", NOW);
  assert.ok(!ctx.blocking.some((i) => i.code === "queued_already"), JSON.stringify(ctx.blocking));
  assert.deepEqual(ctx.blocking, []);
  assert.equal((await sendFirst(DB, "p1", input, NOW)).ok, true);          // and he can write it again
});

test("retry re-queues a failed first email with a new Message-ID", async () => {
  /* new row queued, different message_id, old row still failed */
  const { DB, id } = await failedFirst();
  const old = await getMessage(DB, id);
  assert.equal(old.status, "failed");
  const later = new Date("2026-10-22T09:00:00Z");
  const r = await retryFirst(DB, id, later);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.notEqual(r.id, id);
  assert.equal(r.due_at, "2026-10-22T09:00:00Z");
  const copy = await getMessage(DB, r.id);
  assert.equal(copy.status, "queued");
  assert.notEqual(copy.message_id, old.message_id);
  assert.match(copy.message_id, /^<[0-9a-f-]+@aetoswebsites\.com>$/);
  const still = await getMessage(DB, id);
  assert.equal(still.status, "failed");
  assert.equal(still.error, "Mailbox password rejected");
  for (const key of ["place_id", "to_addr", "subject", "body", "kind", "author", "direction"]) assert.equal(copy[key], old[key], key);
  assert.equal(copy.mailbox_id, "m1");
  assert.equal(copy.due_at, "2026-10-22T09:00:00Z");
  assert.equal((await getProspect(DB, "p1")).stage, "ready");
  // and the copy goes
  assert.deepEqual(await dispatchDue(DB, {}, later, { send: async () => ({ ok: true }) }), { sent: 1, failed: 0, held: 0 });
  assert.equal((await getMessage(DB, r.id)).status, "sent");
});

// ---------------------------------------------------------------- threadSummary: the other lines

test("threadSummary: stopped, finished and waiting lines", () => {
  const on = { approved: true };
  assert.equal(threadSummary({ stage: "needs_nik" }, on), "Follow-ups stopped: they replied");
  assert.equal(threadSummary({ stage: "call_booked" }, on), "Follow-ups stopped: they booked a call");
  assert.equal(threadSummary({ stage: "won" }, on), "Follow-ups stopped: they paid");
  assert.equal(threadSummary({ stage: "lost", lost_reason: "bounce" }, on), "Follow-ups stopped: the address bounced");
  assert.equal(threadSummary({ stage: "lost", lost_reason: "not_now" }, on), "Follow-ups stopped: they said not now");
  assert.equal(threadSummary({ stage: "lost", lost_reason: "not_interested" }, on), "Follow-ups stopped: they said they're not interested");
  assert.equal(threadSummary({ stage: "lost", lost_reason: "call" }, on), "Follow-ups stopped: they said no on the call");
  assert.equal(threadSummary({ stage: "lost", lost_reason: null }, on), "Follow-ups stopped: marked lost");
  assert.equal(threadSummary({ stage: "lost", lost_reason: "sequence_done", stage_at: "2026-12-28T09:15:00Z" }, on),
    "Follow-ups finished: marked lost on Mon 28 Dec with no reply");
  assert.equal(threadSummary({ stage: "lost", lost_reason: "sequence_done" }, on), "Follow-ups finished: marked lost with no reply");
  // waiting
  const due = { stage: "viewed", followup_step: 4, next_followup_at: "2026-11-02T09:15:00Z" };
  assert.equal(threadSummary(due, on), "Follow-up 5 of 9: Mon 2 Nov 09:15");
  assert.equal(threadSummary(due, { approved: true, held: "demo" }), "Follow-ups on hold: their demo isn't available");
  assert.equal(threadSummary(due, { approved: false, held: "demo" }), "Follow-ups paused: approve your follow-up emails on the Voice page");
  assert.equal(threadSummary(due, { approved: true, held: "templates" }), "Follow-ups paused: approve your follow-up emails on the Voice page");
  // a follow-up already queued goes whatever happens to the wording since
  assert.equal(threadSummary({ ...due, queued: true }, { approved: false, held: "demo" }), "Follow-up 5 of 9: Mon 2 Nov 09:15");
  // BST: the UK clock time, not UTC
  assert.equal(threadSummary({ stage: "emailed", followup_step: 0, next_followup_at: "2026-10-23T08:15:00Z" }, on), "Follow-up 1 of 9: Fri 23 Oct 09:15");
  // stopped while still emailed
  assert.equal(threadSummary({ stage: "emailed", followup_step: 3, next_followup_at: null }, { approved: true, held: "failed" }),
    "Follow-ups stopped: a follow-up didn't send (the reason is below)");
  assert.equal(threadSummary({ stage: "emailed", followup_step: 3, next_followup_at: null }, on), "Follow-ups stopped");
  assert.equal(threadSummary({ stage: "emailed", followup_step: 9, next_followup_at: null }, on), "Follow-ups finished: all 9 have gone");
  // before the first email has gone
  assert.equal(threadSummary({ stage: "ready" }, on), "Follow-ups start the day after your first email goes");
  assert.equal(threadSummary({ stage: "ready" }, { approved: false }), "Follow-ups paused: approve your follow-up emails on the Voice page");
  assert.equal(threadSummary(null, on), "");
  assert.equal(threadSummary({ stage: "emailed", followup_step: 2, next_followup_at: "garbage" }, on), "Follow-ups stopped");
});

test("threadSummary: a reply, opt-out or bounce since the first email stops it before the stage catches up", () => {
  const p = { stage: "emailed", first_sent_at: FIRST, followup_step: 1, next_followup_at: "2026-10-24T08:15:00Z" };
  const on = { approved: true };
  const at = (cls, received_at) => ({ ...p, inbound: [{ class: cls, received_at }] });
  assert.equal(threadSummary(at("human", "2026-10-23T10:00:00Z"), on), "Follow-ups stopped: they replied");
  assert.equal(threadSummary(at("opt_out", "2026-10-23T10:00:00Z"), on), "Follow-ups stopped: they opted out");
  assert.equal(threadSummary(at("bounce", "2026-10-22T08:16:00Z"), on), "Follow-ups stopped: the address bounced");
  assert.equal(threadSummary(at("auto", "2026-10-23T10:00:00Z"), on), "Follow-up 2 of 9: Sat 24 Oct 09:15");   // out-of-office
  assert.equal(threadSummary(at("human", "2026-10-21T10:00:00Z"), on), "Follow-up 2 of 9: Sat 24 Oct 09:15");  // before the first email
  // the stage says more than the inbound once it has moved on
  assert.equal(threadSummary({ ...at("human", "2026-10-23T10:00:00Z"), stage: "won" }, on), "Follow-ups stopped: they paid");
});

// ---------------------------------------------------------------- loadThread

test("loadThread: every message oldest first, with the listed fields, and the summary; 3 D1 statements", async () => {
  const DB = await emailedLead({ step: 1, next: null });
  await approveAll(DB);
  await followup(DB, "f1", 1, "sent", "2026-10-23T08:15:00Z");
  await inbound(DB, "i1", "auto", "2026-10-23T13:02:00Z");
  await followup(DB, "f2", 2, "queued", "2026-10-24T08:15:00Z", { body: "<script>alert(1)</script>" });
  const c = countingDB(DB);
  const t = await loadThread(c.DB, "p1", new Date("2026-10-23T14:00:00Z"));
  assert.equal(c.used(), 3);
  assert.equal(t.summary, "Follow-up 2 of 9: Sat 24 Oct 09:15");
  assert.deepEqual(t.messages.map((m) => m.id), ["first", "f1", "i1", "f2"]);
  const keys = ["id", "direction", "kind", "step", "author", "subject", "body", "status", "due_at", "sent_at", "received_at", "error", "class"];
  for (const m of t.messages) assert.deepEqual(Object.keys(m).sort(), [...keys].sort());
  assert.deepEqual(t.messages[1], {
    id: "f1", direction: "out", kind: "followup", step: 1, author: "system", subject: "Re: Your website", body: "Follow-up 1",
    status: "sent", due_at: "2026-10-23T08:15:00Z", sent_at: "2026-10-23T08:15:00Z", received_at: null, error: null, class: null,
  });
  assert.equal(t.messages[2].author, "them");
  assert.equal(t.messages[2].class, "auto");
  assert.equal(t.messages[3].body, "<script>alert(1)</script>");           // as stored: the drawer escapes it
});

test("loadThread: the summary as the next sync will see it", async () => {
  // a first email sent but not synced yet: follow-up 1 is the next day at the same UK time
  const ready = await readyLead();
  await seedMessage(ready, { id: "x1", place_id: "p1", kind: "first", status: "sent", sent_at: FIRST, created_at: FIRST });
  await approveAll(ready);
  assert.equal((await loadThread(ready, "p1", new Date("2026-10-22T08:20:00Z"))).summary, "Follow-up 1 of 9: Fri 23 Oct 09:15");
  // ...and a reply that came in before the sync stops it at once
  await inbound(ready, "i1", "human", "2026-10-22T08:17:00Z");
  assert.equal((await loadThread(ready, "p1", new Date("2026-10-22T08:20:00Z"))).summary, "Follow-ups stopped: they replied");

  // a follow-up sent but not synced yet: the next one by nextDue
  const DB = await emailedLead({ step: 2, next: null });
  await approveAll(DB);
  await followup(DB, "f3", 3, "sent", "2026-10-26T09:15:00Z");
  assert.equal((await loadThread(DB, "p1", new Date("2026-10-26T09:17:00Z"))).summary, "Follow-up 4 of 9: Thu 29 Oct 09:15");
  // follow-up 9 sent, not synced: the close time
  const nine = await emailedLead({ step: 8, next: null });
  await approveAll(nine);
  await followup(nine, "f9", 9, "sent", "2026-12-21T09:15:00Z");
  assert.equal((await loadThread(nine, "p1", new Date("2026-12-21T09:17:00Z"))).summary, "Follow-ups finished: marked lost on Mon 28 Dec if no reply");
  assert.equal(iso(closeTime("2026-12-21T09:15:00Z")), "2026-12-28T09:15:00Z");
});

test("loadThread: approvals, holds, failures and overdue times", async () => {
  const DB = await emailedLead({ step: 2, next: "2026-10-26T09:15:00Z" });
  const before = new Date("2026-10-25T10:00:00Z");
  assert.equal((await loadThread(DB, "p1", before)).summary, "Follow-ups paused: approve your follow-up emails on the Voice page");
  await approveAll(DB);
  assert.equal((await loadThread(DB, "p1", before)).summary, "Follow-up 3 of 9: Mon 26 Oct 09:15");
  // overdue (not queued yet): it goes at the next chance, inside the window now
  assert.equal((await loadThread(DB, "p1", new Date("2026-10-27T11:40:00Z"))).summary, "Follow-up 3 of 9: Tue 27 Oct 11:40");
  // overdue on a Sunday: Monday 07:00
  const late = await emailedLead({ step: 2, next: "2026-10-24T08:15:00Z" });
  await approveAll(late);
  assert.equal((await loadThread(late, "p1", new Date("2026-10-25T10:00:00Z"))).summary, "Follow-up 3 of 9: Mon 26 Oct 07:00");
  // the demo hold (stage 6's queueDue todo)
  await DB.prepare("INSERT INTO todos (id, kind, title, status, dedupe, created_at) VALUES ('t1', 'health', 'x', 'open', 'health:followup-demo:p1', ?)")
    .bind(FIRST).run();
  assert.equal((await loadThread(DB, "p1", before)).summary, "Follow-ups on hold: their demo isn't available");
  // another lead's todo doesn't count
  const other = await emailedLead({ step: 2, next: "2026-10-26T09:15:00Z" });
  await approveAll(other);
  await other.prepare("INSERT INTO todos (id, kind, title, status, dedupe, created_at) VALUES ('t1', 'health', 'x', 'open', 'health:followup-demo:p10', ?)")
    .bind(FIRST).run();
  assert.equal((await loadThread(other, "p1", before)).summary, "Follow-up 3 of 9: Mon 26 Oct 09:15");
  // stopped after failures
  const failing = await emailedLead({ step: 2, next: null });
  await approveAll(failing);
  await followup(failing, "f3", 3, "failed", "2026-10-26T09:15:00Z", { error: "Mailbox password rejected" });
  await failing.prepare("INSERT INTO todos (id, kind, title, status, dedupe, created_at) VALUES ('t1', 'health', 'x', 'open', 'health:followup-fail:p1', ?)")
    .bind(FIRST).run();
  assert.equal((await loadThread(failing, "p1", before)).summary, "Follow-ups stopped: a follow-up didn't send (the reason is below)");
  await failing.prepare("UPDATE todos SET status = 'dismissed' WHERE id = 't1'").run(); // dismissed: still stopped for it
  assert.equal((await loadThread(failing, "p1", before)).summary, "Follow-ups stopped: a follow-up didn't send (the reason is below)");
  // a dismissed demo todo is never closed again, so it says nothing
  await DB.prepare("UPDATE todos SET status = 'dismissed' WHERE id = 't1'").run();
  assert.equal((await loadThread(DB, "p1", before)).summary, "Follow-up 3 of 9: Mon 26 Oct 09:15");
  // an opt-out the inbound step has saved but not moved the stage for yet
  const optOut = await emailedLead({ step: 2, next: "2026-10-26T09:15:00Z" });
  await approveAll(optOut);
  await inbound(optOut, "i1", "opt_out", "2026-10-24T12:00:00Z");
  assert.equal((await loadThread(optOut, "p1", before)).summary, "Follow-ups stopped: they opted out");
});

test("loadThread: a lead with no prospect or no messages", async () => {
  const DB = fakeD1();
  assert.deepEqual(await loadThread(DB, "nope", NOW), { summary: "", messages: [] });
  assert.deepEqual(await loadThread(DB, "", NOW), { summary: "", messages: [] });
});

// ---------------------------------------------------------------- cancelMessage

test("cancel follow-up 9: the close time is 7 days later", async () => {
  const DB = await emailedLead({ step: 8, next: null });
  await followup(DB, "f9", 9, "queued", "2026-12-21T09:15:00Z");
  const now = new Date("2026-12-21T08:00:00Z");
  assert.deepEqual(await cancelMessage(DB, "f9", now), { ok: true });
  const p = await getProspect(DB, "p1");
  assert.equal(p.followup_step, 9);
  assert.equal(p.next_followup_at, "2026-12-28T08:00:00Z");               // now + 7 days
  assert.equal(p.next_followup_at, iso(closeTime(now)));
});

test("cancel twice: the second does nothing more", async () => {
  const DB = await emailedLead({ step: 2, next: null });
  await followup(DB, "f3", 3, "queued", "2026-10-26T09:15:00Z");
  assert.deepEqual(await cancelMessage(DB, "f3", new Date("2026-10-26T08:00:00Z")), { ok: true });
  const once = await getProspect(DB, "p1");
  assert.deepEqual(await cancelMessage(DB, "f3", new Date("2026-10-27T08:00:00Z")), { ok: true });
  assert.deepEqual(await getProspect(DB, "p1"), once);
});

test("cancel refusals say why", async () => {
  const DB = await emailedLead({ step: 2, next: null });
  await followup(DB, "s3", 3, "sending", "2026-10-26T09:15:00Z");
  await followup(DB, "x3", 3, "failed", "2026-10-26T09:15:00Z", { error: "Mailbox password rejected" });
  await inbound(DB, "i1", "human", "2026-10-26T12:00:00Z");
  assert.deepEqual(await cancelMessage(DB, "s3", NOW), { ok: false, status: 409, error: "This email is being sent right now, so it can't be cancelled." });
  assert.deepEqual(await cancelMessage(DB, "x3", NOW), { ok: false, status: 409, error: "This email didn't send, so there's nothing to cancel." });
  assert.deepEqual(await cancelMessage(DB, "i1", NOW), { ok: false, status: 409, error: "That's an email they sent you, so there's nothing to cancel." });
  assert.deepEqual(await cancelMessage(DB, "nope", NOW), { ok: false, status: 404, error: THREAD_ERRORS.gone });
  assert.deepEqual(await cancelMessage(DB, undefined, NOW), { ok: false, status: 404, error: THREAD_ERRORS.gone });
  assert.equal(THREAD_ERRORS.gone, "That email isn't in the database any more. Refresh the page.");
  assert.equal((await getProspect(DB, "p1")).followup_step, 2);           // nothing moved
});

test("cancel a follow-up on a lead that has replied books nothing", async () => {
  const DB = await emailedLead({ step: 2, next: null, stage: "replied" });
  await followup(DB, "f3", 3, "queued", "2026-10-26T09:15:00Z");
  assert.deepEqual(await cancelMessage(DB, "f3", new Date("2026-10-26T08:00:00Z")), { ok: true });
  const p = await getProspect(DB, "p1");
  assert.equal(p.next_followup_at, null);
  assert.equal((await getMessage(DB, "f3")).status, "cancelled");
});

test("cancel a queued reply or system email: just that row", async () => {
  const DB = await emailedLead({ step: 2, next: "2026-10-26T09:15:00Z" });
  await seedMessage(DB, { id: "r1", place_id: "p1", kind: "reply", status: "queued", due_at: FIRST });
  await seedMessage(DB, { id: "s1", place_id: null, kind: "system", status: "queued", due_at: FIRST });
  const before = await getProspect(DB, "p1");
  assert.deepEqual(await cancelMessage(DB, "r1", NOW), { ok: true });
  assert.deepEqual(await cancelMessage(DB, "s1", NOW), { ok: true });
  assert.equal((await getMessage(DB, "r1")).status, "cancelled");
  assert.equal((await getMessage(DB, "s1")).status, "cancelled");
  assert.deepEqual(await getProspect(DB, "p1"), before);
});

test("cancel loses the race to the outbox: refused, nothing booked", async () => {
  const DB = await emailedLead({ step: 2, next: null });
  await followup(DB, "f3", 3, "queued", "2026-10-26T09:15:00Z");
  // The outbox claims it between cancelMessage's read and its write.
  const racing = {
    prepare: (sql) => DB.prepare(sql),
    async batch(statements) {
      await DB.prepare("UPDATE messages SET status = 'sending', sent_at = ? WHERE id = 'f3'").bind("2026-10-26T09:15:00Z").run();
      return DB.batch(statements);
    },
  };
  assert.deepEqual(await cancelMessage(racing, "f3", new Date("2026-10-26T09:14:00Z")),
    { ok: false, status: 409, error: "This email is being sent right now, so it can't be cancelled." });
  const p = await getProspect(DB, "p1");
  assert.equal(p.followup_step, 2);
  assert.equal(p.next_followup_at, null);
});

// ---------------------------------------------------------------- retryFirst

test("retry refusals: only a failed first email, and every Send check again", async () => {
  const DB = await emailedLead({ step: 2, next: null });
  await followup(DB, "x3", 3, "failed", "2026-10-26T09:15:00Z", { error: "Mailbox password rejected" });
  assert.deepEqual(await retryFirst(DB, "first", NOW), { ok: false, status: 409, error: "This email has already gone, so there's nothing to try again." });
  assert.deepEqual(await retryFirst(DB, "x3", NOW), { ok: false, status: 400, error: "Only a first email that didn't send can be tried again here." });
  assert.deepEqual(await retryFirst(DB, "nope", NOW), { ok: false, status: 404, error: THREAD_ERRORS.gone });

  // the do-not-email list
  const s = await failedFirst();
  await s.DB.prepare("INSERT INTO suppression (value, kind, reason, created_at) VALUES ('mark@greenleaf.co.uk', 'email', 'opt_out', '2026-11-03T10:00:00Z')").run();
  const r = await retryFirst(s.DB, s.id, NOW);
  assert.deepEqual(r, { ok: false, status: 400, error: "mark@greenleaf.co.uk is on your do-not-email list (opted out on 3 Nov). You can't email it." });
  assert.equal(await countOf(s.DB, "SELECT COUNT(*) n FROM messages WHERE status = 'queued'"), 0);

  // no room: the mailbox paused since
  const p = await failedFirst();
  await p.DB.prepare("UPDATE mailboxes SET status = 'paused', paused_reason = 'Too many bounces.' WHERE id = 'm1'").run();
  assert.deepEqual(await retryFirst(p.DB, p.id, NOW),
    { ok: false, status: 400, error: "Sending is paused: Too many bounces. Fix it on Setup → Mailboxes." });

  // a copy already waiting (a second press of Try again)
  const twice = await failedFirst();
  assert.equal((await retryFirst(twice.DB, twice.id, NOW)).ok, true);
  assert.deepEqual(await retryFirst(twice.DB, twice.id, NOW), { ok: false, status: 409,
    error: "A first email to Green Leaf Landscapes is already waiting to go out. Cancel it below to write a new one." });
  assert.equal(await countOf(twice.DB, "SELECT COUNT(*) n FROM messages WHERE kind = 'first' AND status = 'queued'"), 1);

  // a cancelled first email, and a queued one
  const c = await readyLead();
  const sent = await sendFirst(c, "p1", input, NOW);
  assert.deepEqual(await retryFirst(c, sent.id, NOW), { ok: false, status: 409, error: "This email is already waiting to go out." });
  await cancelMessage(c, sent.id, NOW);
  assert.deepEqual(await retryFirst(c, sent.id, NOW), { ok: false, status: 409,
    error: "This email was cancelled, so it can't be tried again. Write a new one instead." });
});

test("retry twice at once queues one copy", async () => {
  const { DB, id } = await failedFirst();
  const [a, b] = await Promise.all([retryFirst(DB, id, NOW), retryFirst(DB, id, NOW)]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  const lost = a.ok ? b : a;
  assert.equal(lost.status, 409);
  assert.equal(lost.error, "A first email to Green Leaf Landscapes is already waiting to go out. Cancel it below to write a new one.");
  assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages WHERE kind = 'first' AND status = 'queued'"), 1);
});

test("retry loses the race to another Send between its checks and its write: refused, nothing queued", async () => {
  const { DB, id } = await failedFirst();
  let raced = false;
  const sqlOf = new WeakMap();
  const tagged = (statement, sql) => {
    sqlOf.set(statement, sql);
    const bind = statement.bind;
    return Object.assign(statement, { bind: (...values) => tagged(bind(...values), sql) });
  };
  const racing = {
    prepare: (sql) => tagged(DB.prepare(sql), sql),
    async batch(statements) {
      // The claim (every check has passed): another tab's Send queues a first email just before it runs.
      if (!raced && statements.some((s) => /INSERT INTO messages/.test(sqlOf.get(s) ?? ""))) {
        raced = true;
        await seedMessage(DB, { id: "other", place_id: "p1", kind: "first", status: "queued", due_at: FIRST, created_at: FIRST });
      }
      return DB.batch(statements);
    },
  };
  const r = await retryFirst(racing, id, NOW);
  assert.equal(raced, true);
  assert.deepEqual(r, { ok: false, status: 409,
    error: "A first email to Green Leaf Landscapes is already waiting to go out. Cancel it below to write a new one." });
  assert.equal(await countOf(DB, "SELECT COUNT(*) n FROM messages WHERE kind = 'first' AND status = 'queued'"), 1);
  assert.equal((await getMessage(DB, id)).status, "failed");
});

test("D1 statements: cancel 2 (a follow-up 3), retry 14", async () => {
  const DB = await emailedLead({ step: 2, next: null });
  await followup(DB, "f3", 3, "queued", "2026-10-26T09:15:00Z");
  await seedMessage(DB, { id: "r1", place_id: "p1", kind: "reply", status: "queued", due_at: FIRST });
  const c = countingDB(DB);
  assert.deepEqual(await cancelMessage(c.DB, "f3", new Date("2026-10-26T08:00:00Z")), { ok: true });
  assert.equal(c.used(), 3);
  assert.deepEqual(await cancelMessage(c.DB, "r1", new Date("2026-10-26T08:00:00Z")), { ok: true });
  assert.equal(c.used(), 5);
  const f = await failedFirst();
  const counted = countingDB(f.DB);
  assert.equal((await retryFirst(counted.DB, f.id, NOW)).ok, true);
  assert.equal(counted.used(), 14);
});

test("retry outside the window waits for the next window start, from the mailbox with room", async () => {
  const { DB, id } = await failedFirst();
  const r = await retryFirst(DB, id, new Date("2026-10-25T10:00:00Z")); // Sunday
  assert.equal(r.ok, true);
  assert.equal(r.due_at, "2026-10-26T07:00:00Z");
  const copy = await getMessage(DB, r.id);
  assert.equal(copy.due_at, "2026-10-26T07:00:00Z");
  assert.equal(copy.from_addr, "nik@aetoswebsites.com");
  assert.equal((await getProspect(DB, "p1")).mailbox_id, "m1");
});

// ---------------------------------------------------------------- review fixes (adversarial review of Task 11)

test("loadThread: a failed follow-up reads as retryFailed will leave it, never 'stopped' while it will go again", async () => {
  const DB = await emailedLead({ step: 2, next: null });
  await approveAll(DB);
  await followup(DB, "x3", 3, "failed", "2026-10-26T09:15:00Z", { error: "Mailbox password rejected" });
  const now = new Date("2026-10-26T09:20:00Z"); // Mon, before the followups step has run
  assert.equal((await loadThread(DB, "p1", now)).summary, "Follow-up 3 of 9: Tue 27 Oct 07:00");
  // ...which is exactly what retryFailed books
  assert.equal(await retryFailed(DB, now), 1);
  assert.equal((await getProspect(DB, "p1")).next_followup_at, "2026-10-27T07:00:00Z");
  assert.equal((await loadThread(DB, "p1", now)).summary, "Follow-up 3 of 9: Tue 27 Oct 07:00");

  // a Saturday failure goes again on Monday
  const sat = await emailedLead({ step: 2, next: null });
  await approveAll(sat);
  await followup(sat, "x3", 3, "failed", "2026-10-31T09:15:00Z", { error: "Mailbox password rejected" });
  assert.equal((await loadThread(sat, "p1", new Date("2026-10-31T09:20:00Z"))).summary, "Follow-up 3 of 9: Mon 2 Nov 07:00");

  // one that may have gone is never sent again: stopped at once
  const maybe = await emailedLead({ step: 2, next: null });
  await approveAll(maybe);
  await followup(maybe, "x3", 3, "failed", "2026-10-26T09:15:00Z",
    { error: "The send was interrupted. It may or may not have gone: check the Sent folder in Namecheap webmail before sending again." });
  assert.equal((await loadThread(maybe, "p1", now)).summary, "Follow-ups stopped: a follow-up didn't send (the reason is below)");

  // the third failure of a step stops it
  const third = await emailedLead({ step: 2, next: null });
  await approveAll(third);
  for (const [id, due] of [["a", "2026-10-26T09:15:00Z"], ["b", "2026-10-27T07:00:00Z"], ["c", "2026-10-28T07:00:00Z"]]) {
    await followup(third, id, 3, "failed", due, { error: "Mailbox password rejected" });
  }
  assert.equal((await loadThread(third, "p1", new Date("2026-10-28T07:05:00Z"))).summary,
    "Follow-ups stopped: a follow-up didn't send (the reason is below)");
  // a failure followed by a send of the same step that is waiting: the waiting one is shown
  const again = await emailedLead({ step: 2, next: null });
  await approveAll(again);
  await followup(again, "x3", 3, "failed", "2026-10-26T09:15:00Z", { error: "Mailbox password rejected" });
  await followup(again, "q3", 3, "queued", "2026-10-27T07:00:00Z");
  assert.equal((await loadThread(again, "p1", new Date("2026-10-26T20:00:00Z"))).summary, "Follow-up 3 of 9: Tue 27 Oct 07:00");
});

test("cancel a stray queued follow-up for a step already done: cancelled, the sequence never moves back", async () => {
  const DB = await emailedLead({ step: 5, next: "2026-11-02T09:15:00Z" });
  await followup(DB, "f3", 3, "queued", "2026-10-26T09:15:00Z");
  const before = await getProspect(DB, "p1");
  assert.deepEqual(await cancelMessage(DB, "f3", new Date("2026-10-30T08:00:00Z")), { ok: true });
  assert.equal((await getMessage(DB, "f3")).status, "cancelled");
  assert.deepEqual(await getProspect(DB, "p1"), before);
});

test("a skipped follow-up: the followups step queues the next one on its own day, in the thread", async () => {
  const DB = await emailedLead({ step: 2, next: null });
  await approveAll(DB);
  await followup(DB, "f1", 1, "sent", "2026-10-23T08:15:00Z", { message_id: "<f1@aetoswebsites.com>" });
  await followup(DB, "f2", 2, "sent", "2026-10-24T08:15:00Z", { message_id: "<f2@aetoswebsites.com>" });
  await followup(DB, "f3", 3, "queued", "2026-10-26T09:15:00Z");
  assert.deepEqual(await cancelMessage(DB, "f3", new Date("2026-10-26T08:00:00Z")), { ok: true });
  const demo = { demoReady: async () => ({ ok: true, url: "https://aetoswebsites.com/d/green-leaf", reason: "" }) };
  const queuedNow = () => DB.prepare("SELECT * FROM messages WHERE kind = 'followup' AND status = 'queued'").all().then((r) => r.results);
  await followupsStep({ DB, env: {}, now: new Date("2026-10-28T09:20:00Z") }, demo); // Wed: nothing due yet
  assert.deepEqual(await queuedNow(), []);
  await followupsStep({ DB, env: {}, now: new Date("2026-10-29T09:16:00Z") }, demo); // Thu: step 4 is due
  const [m] = await queuedNow();
  assert.equal(m.step, 4);
  assert.equal(m.due_at, "2026-10-29T09:15:00Z");
  assert.equal(m.in_reply_to, ROOT);
  assert.equal(m.refs, `${ROOT} <f1@aetoswebsites.com> <f2@aetoswebsites.com>`);
  assert.equal((await getMessage(DB, "f3")).status, "cancelled");
});

test("retry puts the prospect back to this email's address, subject and greeting", async () => {
  // A failed to mark@; then a Send to info@ with another subject, cancelled: the prospect row was info@'s.
  const { DB, id } = await failedFirst();
  const other = await sendFirst(DB, "p1", { to: "info@greenleaf.co.uk", subject: "Quick one", body: "Look: {demo_link}" }, NOW);
  assert.equal(other.ok, true, JSON.stringify(other));
  assert.deepEqual(await cancelMessage(DB, other.id, NOW), { ok: true });
  await DB.prepare("UPDATE prospects SET greet_name = NULL WHERE place_id = 'p1'").run();
  assert.equal((await getProspect(DB, "p1")).email, "info@greenleaf.co.uk");
  const r = await retryFirst(DB, id, NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = await getProspect(DB, "p1");
  assert.equal(p.email, "mark@greenleaf.co.uk");
  assert.equal(p.subject, "Your website");
  assert.equal(p.greet_name, "Mark");                                        // from the email's own "Hi Mark,"
  assert.equal(p.mailbox_id, "m1");
  assert.equal((await getMessage(DB, r.id)).to_addr, "mark@greenleaf.co.uk");
});

test("retry refuses a dead link and an address the lead no longer has", async () => {
  // the demo was replaced since (a new slug): the copy would link to the old one
  const replaced = await failedFirst();
  await seedDemo(replaced.DB, { place_id: "p1", slug: "green-leaf-2", created_at: "2026-10-22T08:30:00Z" });
  assert.deepEqual(await retryFirst(replaced.DB, replaced.id, NOW), { ok: false, status: 400, error: THREAD_ERRORS.oldDemo });
  assert.equal(await countOf(replaced.DB, "SELECT COUNT(*) n FROM messages WHERE status = 'queued'"), 0);

  // research changed since: mark@ isn't one of their addresses any more
  const moved = await failedFirst();
  await moved.DB.prepare("UPDATE research SET emails = ?, best_email = 'info@greenleaf.co.uk' WHERE place_id = 'p1'")
    .bind(JSON.stringify([EMAILS[1]])).run();
  assert.deepEqual(await retryFirst(moved.DB, moved.id, NOW), { ok: false, status: 400,
    error: "mark@greenleaf.co.uk isn't one of their addresses any more, so this email can't be tried again. Write a new one instead." });
  assert.equal(await countOf(moved.DB, "SELECT COUNT(*) n FROM messages WHERE status = 'queued'"), 0);
});

// ---------------------------------------------------------------- routes

const post = (path) => new Request(`https://control.example${path}`, { method: "POST" });

test("GET /api/thread/:place_id", async () => {
  const DB = await emailedLead({ step: 2, next: "2026-10-26T09:15:00Z" });
  await approveAll(DB);
  const res = await threadGet({ env: { DB }, params: { id: "p1" }, request: new Request("https://control.example/api/thread/p1"),
    now: new Date("2026-10-25T10:00:00Z") });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.summary, "Follow-up 3 of 9: Mon 26 Oct 09:15");
  assert.deepEqual(body.messages.map((m) => m.id), ["first"]);
  const none = await threadGet({ env: { DB }, params: { id: "nope" }, request: new Request("https://control.example/api/thread/nope") });
  assert.equal(none.status, 200);
  assert.deepEqual(await none.json(), { summary: "", messages: [] });
});

test("POST /api/messages/:id/cancel", async () => {
  const DB = await emailedLead({ step: 2, next: null });
  await followup(DB, "f3", 3, "queued", "2026-10-26T09:15:00Z");
  const env = { DB };
  const gone = await cancelPost({ env, params: { id: "first" }, request: post("/api/messages/first/cancel"), now: NOW });
  assert.equal(gone.status, 409);
  assert.deepEqual(await gone.json(), { error: "This email has already gone, so it can't be cancelled." });
  const missing = await cancelPost({ env, params: { id: "nope" }, request: post("/api/messages/nope/cancel"), now: NOW });
  assert.equal(missing.status, 404);
  const ok = await cancelPost({ env, params: { id: "f3" }, request: post("/api/messages/f3/cancel"), now: new Date("2026-10-26T08:00:00Z") });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal((await getMessage(DB, "f3")).status, "cancelled");
});

test("POST /api/messages/:id/retry", async () => {
  const { DB, id } = await failedFirst();
  const env = { DB };
  const ok = await retryPost({ env, params: { id }, request: post(`/api/messages/${id}/retry`), now: NOW });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.due_at, "2026-10-22T08:15:00Z");
  assert.equal((await getMessage(DB, body.id)).status, "queued");
  const again = await retryPost({ env, params: { id }, request: post(`/api/messages/${id}/retry`), now: NOW });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /already waiting to go out/);
  const missing = await retryPost({ env, params: { id: "nope" }, request: post("/api/messages/nope/retry"), now: NOW });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: THREAD_ERRORS.gone });
});
