// Follow-ups in D1 (stage 6, docs/rebuild/06-email-followups.md Part B Task 6): the 9 follow-up templates seeded as
// drafts (ensureTemplates) and counted once approved (followupsApproved); the cold sends and open sequences behind
// capacity planning (planningRows); how many more first emails each cold mailbox can take on the day of the next send
// and on every day its 9 follow-ups will go (roomForFirsts); follow-ups due by the end of UK today, per mailbox
// (followupsDueByMailbox); and stage 3's capacityNow, whose room never goes over roomForFirsts' total.
// Task 7: a sent first email makes the lead emailed with its schedule and a style example (syncSent), a sent
// follow-up books the next one, and a reply, opt-out or bounce stops the sequence (syncSent, sweepStops, stopFollowups).
// Task 8: the tick's `followups` step (followupsStep): failed follow-ups retried the next day, 3 times at most, and an
// interrupted one never (retryFailed); finished sequences closed as lost (closeFinished); due follow-ups queued in the
// thread once all 9 templates are approved and the demo is up (queueDue); at most 18 D1 queries a run.
// Task 15: the Follow-ups health light (followupHealth, followupHealthFromDb), registered with stage 0's registerLight.
// Run: node --test control-room/tests/followups-db.test.mjs
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { approveTemplate, demoReady } from "../functions/_lib/demo-db.js";
import {
  DRAFTS, closeFinished, closeTime, ensureTemplates, followupHealth, followupHealthFromDb, followupsApproved,
  followupsDueByMailbox, followupsDueToday, followupsStep, nextDue, planFirsts, planningRows, queueDue, retryFailed,
  roomForFirsts, schedule, stopFollowups, sweepStops, syncSent,
} from "../functions/_lib/followups.js";
import { healthFromDb, healthStep } from "../functions/_lib/health.js";
import { coldFooter } from "../functions/_lib/mail/compose.js";
import { INTERRUPTED_PREFIX } from "../functions/_lib/mail/outbox.js";
import { MAYBE_SENT } from "../functions/_lib/mail/smtp.js";
import { applyStageEvent } from "../functions/_lib/prospects.js";
import { setSetting } from "../functions/_lib/settings.js";
import { capacityNow } from "../functions/_lib/shortlist-db.js";
import { STEPS, runTick } from "../functions/_lib/tick.js";
import { addTodo } from "../functions/_lib/todo.js";
import { db as utilDb } from "../functions/_lib/util.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { SEED_AT, seedDemo, seedLead, seedMailbox, seedMessage, seedProspect, seedResearch } from "./helpers/shortlistSeed.mjs";

// The test helpers the plan names, over stage 3's seed helpers: a cold mailbox (m1 unless given, active, started
// 2026-08-01) and a prospect (stage ready unless given).
const insertMailbox = (DB, o = {}) => seedMailbox(DB, o);
const insertProspect = (DB, o = {}) => seedProspect(DB, o);
const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

// ---------------------------------------------------------------- the plan's tests (Part B, Task 6, Step 1)

test("ensureTemplates seeds 9 drafts once", async () => {
  const DB = fakeD1();
  await ensureTemplates(DB); await ensureTemplates(DB);
  const rows = (await DB.prepare("SELECT step, day_offset, status FROM followup_templates ORDER BY step").all()).results;
  assert.deepEqual(rows.map((r) => r.day_offset), [1, 2, 4, 7, 10, 17, 24, 30, 60]);
  assert.ok(rows.every((r) => r.status === "draft"));
  assert.deepEqual(await followupsApproved(DB), { approved: 0, all: false });
});

test("roomForFirsts and followupsDueByMailbox", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 10 });              // test helper in this file
  await insertProspect(DB, { place_id: "p1", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-21T08:00:00Z",
    followup_step: 0, next_followup_at: "2026-10-22T08:00:00Z" });
  const now = new Date("2026-10-22T10:00:00Z");
  assert.deepEqual(await followupsDueByMailbox(DB, now), { total: 1, byMailbox: { m1: 1 } });
  assert.equal(await followupsDueToday(DB, now), 1);                    // stage 3's number is unchanged
  const r = await roomForFirsts(DB, now);
  assert.equal(r.day, "2026-10-22");
  assert.equal(r.byMailbox.m1.room, 9);
  assert.equal(r.total, 9);
});

test("outside the window the day is the next window start", async () => {
  const DB = fakeD1(); await insertMailbox(DB, { id: "m1", cap_override: 10 });
  assert.equal((await roomForFirsts(DB, new Date("2026-10-24T19:30:00Z"))).day, "2026-10-26"); // Sat 20:30 BST → Mon
});

test("capacityNow never offers more than roomForFirsts", async () => {
  const DB = fakeD1(); await insertMailbox(DB, { id: "m1", cap_override: 10 });
  for (let i = 0; i < 10; i++)                                           // Mon firsts, steps 1–2 sent, step 3 due Fri
    await insertProspect(DB, { place_id: `p${i}`, stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-19T08:00:00Z",
      followup_step: 2, next_followup_at: "2026-10-23T08:00:00Z" });
  const now = new Date("2026-10-22T10:00:00Z");                         // Thu: nothing due today, Friday is full
  assert.equal((await roomForFirsts(DB, now)).total, 0);
  assert.equal((await capacityNow(DB, now)).room, 0);                    // stage 3's formula alone would say 10
});

// ---------------------------------------------------------------- templates

test("ensureTemplates seeds the A6 wording and never overwrites Nik's edits or approvals", async () => {
  const DB = fakeD1();
  await ensureTemplates(DB);
  const rows = (await DB.prepare("SELECT step, body, approved_at FROM followup_templates ORDER BY step").all()).results;
  assert.deepEqual(rows.map((r) => r.step), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const r of rows) {
    assert.equal(r.body, DRAFTS[r.step], `step ${r.step}`);
    assert.equal(r.approved_at, null, `step ${r.step}`);
  }

  await DB.prepare("UPDATE followup_templates SET body = ?1, status = 'approved', approved_at = ?2 WHERE step = 3")
    .bind("{greeting}\n\nMy own words for {business}: {demo_link}", "2026-10-19T09:00:00Z").run();
  await DB.prepare("DELETE FROM followup_templates WHERE step = 9").run();
  await ensureTemplates(DB);
  const three = await DB.prepare("SELECT * FROM followup_templates WHERE step = 3").first();
  assert.equal(three.body, "{greeting}\n\nMy own words for {business}: {demo_link}");
  assert.equal(three.status, "approved");
  assert.equal(three.approved_at, "2026-10-19T09:00:00Z");
  const nine = await DB.prepare("SELECT * FROM followup_templates WHERE step = 9").first();
  assert.deepEqual([nine.body, nine.day_offset, nine.status], [DRAFTS[9], 60, "draft"]); // a missing one comes back
});

test("followupsApproved counts the approved steps; all only when all 9 are", async () => {
  const DB = fakeD1();
  assert.deepEqual(await followupsApproved(DB), { approved: 0, all: false }); // nothing seeded yet
  await ensureTemplates(DB);
  const approve = (step) => DB.prepare("UPDATE followup_templates SET status = 'approved', approved_at = ?1 WHERE step = ?2")
    .bind("2026-10-19T09:00:00Z", step).run();
  for (let step = 1; step <= 8; step++) await approve(step);
  assert.deepEqual(await followupsApproved(DB), { approved: 8, all: false });
  await approve(9);
  assert.deepEqual(await followupsApproved(DB), { approved: 9, all: true });
  // Saving an edit makes it a draft again (the Voice page): follow-ups pause.
  await DB.prepare("UPDATE followup_templates SET status = 'draft', approved_at = NULL WHERE step = 4").run();
  assert.deepEqual(await followupsApproved(DB), { approved: 8, all: false });
});

test("ensureTemplates and followupsApproved are one D1 statement each", async () => {
  const DB = fakeD1();
  const seeding = countingDB(DB);
  await ensureTemplates(seeding.DB);
  assert.equal(seeding.used(), 1);
  const counting = countingDB(DB);
  await followupsApproved(counting.DB);
  assert.equal(counting.used(), 1);
});

// ---------------------------------------------------------------- planningRows

test("planningRows: today's sent, queued and sending cold mail, and the open sequences", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 10 });
  await insertMailbox(DB, { id: "m2", cap_override: 10 });
  const now = new Date("2026-10-22T10:00:00Z"); // Thu 11:00 BST
  // Cold sends: sent today (since 00:00 UK = 2026-10-21T23:00Z), queued, sending.
  await seedMessage(DB, { id: "sent-today", kind: "followup", status: "sent", sent_at: "2026-10-22T08:15:00Z" });
  await seedMessage(DB, { id: "sent-just-after-midnight", kind: "first", status: "sent", sent_at: "2026-10-21T23:30:00Z" });
  await seedMessage(DB, { id: "queued-fu", mailbox_id: "m2", kind: "followup", status: "queued", due_at: "2026-10-22T09:00:00Z" });
  await seedMessage(DB, { id: "sending-fu", kind: "followup", status: "sending", due_at: "2026-10-22T09:55:00Z" });
  // Not cold sends or not booked: sent yesterday (UK), failed, cancelled, a reply, a system email.
  await seedMessage(DB, { id: "sent-yesterday", kind: "followup", status: "sent", sent_at: "2026-10-21T22:59:00Z" });
  await seedMessage(DB, { id: "failed", kind: "followup", status: "failed" });
  await seedMessage(DB, { id: "cancelled", kind: "first", status: "cancelled" });
  await seedMessage(DB, { id: "reply", kind: "reply", status: "queued" });
  await seedMessage(DB, { id: "system", kind: "system", status: "sent", sent_at: "2026-10-22T08:00:00Z" });
  // Open sequences: emailed and viewed, follow-ups left, the next one booked.
  await insertProspect(DB, { place_id: "e1", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-21T08:00:00Z",
    followup_step: 0, next_followup_at: "2026-10-22T08:00:00Z" });
  await insertProspect(DB, { place_id: "v1", stage: "viewed", mailbox_id: "m2", first_sent_at: "2026-10-15T09:00:00Z",
    followup_step: 3, next_followup_at: "2026-10-22T09:00:00Z" });
  // Not open: replied, lost, finished (step 9: next_followup_at is the close time), stopped (NULL), ready.
  await insertProspect(DB, { place_id: "r1", stage: "replied", mailbox_id: "m1", first_sent_at: "2026-10-15T09:00:00Z",
    followup_step: 2, next_followup_at: "2026-10-22T09:00:00Z" });
  await insertProspect(DB, { place_id: "l1", stage: "lost", mailbox_id: "m1", first_sent_at: "2026-10-15T09:00:00Z",
    followup_step: 2, next_followup_at: "2026-10-22T09:00:00Z" });
  await insertProspect(DB, { place_id: "done9", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-08-15T09:00:00Z",
    followup_step: 9, next_followup_at: "2026-10-22T09:00:00Z" });
  await insertProspect(DB, { place_id: "stopped", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-15T09:00:00Z",
    followup_step: 2, next_followup_at: null });
  await insertProspect(DB, { place_id: "ready1", stage: "ready" });

  const { cold, sequences } = await planningRows(DB, now);
  const byAt = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  assert.deepEqual([...cold].sort(byAt), [
    { mailbox_id: "m1", kind: "first", status: "sent", at: "2026-10-21T23:30:00Z" },
    { mailbox_id: "m1", kind: "followup", status: "sent", at: "2026-10-22T08:15:00Z" },
    { mailbox_id: "m2", kind: "followup", status: "queued", at: "2026-10-22T09:00:00Z" },
    { mailbox_id: "m1", kind: "followup", status: "sending", at: "2026-10-22T09:55:00Z" },
  ]);
  const byFirst = (a, b) => (a.first_at < b.first_at ? -1 : 1);
  assert.deepEqual([...sequences].sort(byFirst), [
    { mailbox_id: "m2", first_at: "2026-10-15T09:00:00Z", step_done: 3, next_at: "2026-10-22T09:00:00Z" },
    { mailbox_id: "m1", first_at: "2026-10-21T08:00:00Z", step_done: 0, next_at: "2026-10-22T08:00:00Z" },
  ]);
});

// A lead that passes stage 3's ready rule (research done, a live demo): Send only ever queues a first email for one,
// and the outbox holds (and the plan leaves out) a queued one whose lead no longer does.
async function readyLeadRows(DB, place_id) {
  await seedLead(DB, { place_id });
  await seedResearch(DB, { place_id });
  await seedDemo(DB, { place_id });
}

test("planningRows projects every queued first email as a sequence from its due time", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 10 });
  await insertProspect(DB, { place_id: "q1", stage: "ready", mailbox_id: "m1" });
  await readyLeadRows(DB, "q1");
  await seedMessage(DB, { id: "first-q1", place_id: "q1", kind: "first", status: "queued", due_at: "2026-10-26T07:00:00Z" });
  await seedMessage(DB, { id: "first-sending", place_id: null, kind: "first", status: "sending", due_at: "2026-10-22T09:58:00Z" });
  const { cold, sequences } = await planningRows(DB, new Date("2026-10-22T10:00:00Z"));
  assert.equal(cold.length, 2);
  assert.deepEqual(sequences.find((s) => s.first_at === "2026-10-26T07:00:00Z"),
    { mailbox_id: "m1", first_at: "2026-10-26T07:00:00Z", step_done: 0, next_at: null });
  // One that's going right now is booked the same way, so its follow-ups never drop out of the plan while it goes.
  assert.deepEqual(sequences.find((s) => s.first_at === "2026-10-22T09:58:00Z"),
    { mailbox_id: "m1", first_at: "2026-10-22T09:58:00Z", step_done: 0, next_at: null });
  assert.equal(sequences.length, 2);
});

test("planningRows keeps a thread's later follow-ups booked while one is queued or not yet synced", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 10 });
  const now = new Date("2026-10-22T10:00:00Z"); // Thu 11:00 BST, inside the window
  // A follow-up queued (the followups step sets next_followup_at NULL when it queues one).
  await insertProspect(DB, { place_id: "a", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-19T08:00:00Z",
    followup_step: 1, next_followup_at: null });
  await seedMessage(DB, { place_id: "a", kind: "followup", step: 2, status: "queued", due_at: "2026-10-22T08:00:00Z" });
  // A follow-up sent this morning that the next followups step hasn't synced yet.
  await insertProspect(DB, { place_id: "b", stage: "viewed", mailbox_id: "m1", first_sent_at: "2026-10-12T08:00:00Z",
    followup_step: 4, next_followup_at: null });
  await seedMessage(DB, { place_id: "b", kind: "followup", step: 5, status: "sent", due_at: "2026-10-22T08:00:00Z",
    sent_at: "2026-10-22T08:01:00Z" });
  // A first email sent this morning: the prospect stays `ready` until the next followups step syncs it.
  await insertProspect(DB, { place_id: "c", stage: "ready", mailbox_id: "m1" });
  await seedMessage(DB, { place_id: "c", kind: "first", status: "sent", due_at: "2026-10-22T08:15:00Z",
    sent_at: "2026-10-22T08:15:30Z" });
  // Step 9 queued: nothing comes after it. A stopped lead's leftover row (replied) isn't projected either.
  await insertProspect(DB, { place_id: "d", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-08-24T08:00:00Z",
    followup_step: 8, next_followup_at: null });
  await seedMessage(DB, { place_id: "d", kind: "followup", step: 9, status: "queued", due_at: "2026-10-22T08:00:00Z" });
  await insertProspect(DB, { place_id: "e", stage: "replied", mailbox_id: "m1", first_sent_at: "2026-10-19T08:00:00Z",
    followup_step: 1, next_followup_at: null });
  await seedMessage(DB, { place_id: "e", kind: "followup", step: 2, status: "queued", due_at: "2026-10-22T08:00:00Z" });

  const { cold, sequences } = await planningRows(DB, now);
  assert.equal(cold.length, 5); // every one of those messages takes its own place
  const of = (first_at) => sequences.filter((s) => s.first_at === first_at);
  // a: steps 3–9 from the day after step 2 goes (it goes now at the earliest).
  assert.deepEqual(of("2026-10-19T08:00:00Z"), [{ mailbox_id: "m1", first_at: "2026-10-19T08:00:00Z", step_done: 2,
    next_at: iso(nextDue("2026-10-19T08:00:00Z", 3, now)) }]);
  assert.equal(of("2026-10-19T08:00:00Z")[0].next_at, "2026-10-23T08:00:00Z");
  // b: as the sync will book it, from step 5's sent_at.
  assert.deepEqual(of("2026-10-12T08:00:00Z"), [{ mailbox_id: "m1", first_at: "2026-10-12T08:00:00Z", step_done: 5,
    next_at: iso(nextDue("2026-10-12T08:00:00Z", 6, "2026-10-22T08:01:00Z")) }]);
  // c: as the sync will book it, follow-up 1 by the plan from its sent_at.
  assert.deepEqual(of("2026-10-22T08:15:30Z"), [{ mailbox_id: "m1", first_at: "2026-10-22T08:15:30Z", step_done: 0,
    next_at: iso(schedule("2026-10-22T08:15:30Z", 1)) }]);
  assert.equal(sequences.length, 3);
});

// ---------------------------------------------------------------- roomForFirsts

test("roomForFirsts: a queued follow-up's later steps still take their places", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 2 });
  const now = new Date("2026-10-22T10:00:00Z"); // Thu
  // a: step 2 queued (due this morning), so step 3 goes Fri 23.
  await insertProspect(DB, { place_id: "a", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-19T08:00:00Z",
    followup_step: 1, next_followup_at: null });
  await seedMessage(DB, { place_id: "a", kind: "followup", step: 2, status: "queued", due_at: "2026-10-22T08:00:00Z" });
  // b: step 3 booked for Fri 23.
  await insertProspect(DB, { place_id: "b", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-19T08:00:00Z",
    followup_step: 2, next_followup_at: "2026-10-23T08:00:00Z" });
  // Thu has one place left; Fri is full (a's step 3 and b's), so no first email can start today.
  assert.deepEqual(await roomForFirsts(DB, now), { day: "2026-10-22", total: 0, byMailbox: { m1: { room: 0, fullDay: "2026-10-23" } } });
});

test("roomForFirsts: a first email sent but not synced yet keeps its follow-up days", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 1 });
  await insertProspect(DB, { place_id: "c", stage: "ready", mailbox_id: "m1" });
  await seedMessage(DB, { place_id: "c", kind: "first", status: "sent", due_at: "2026-10-22T08:15:00Z",
    sent_at: "2026-10-22T08:15:00Z" });
  // Thu 19:30 BST: the next send is Fri 07:00, and Friday is that first email's follow-up 1.
  assert.deepEqual(await roomForFirsts(DB, new Date("2026-10-22T18:30:00Z")),
    { day: "2026-10-23", total: 0, byMailbox: { m1: { room: 0, fullDay: "2026-10-23" } } });
});

test("roomForFirsts: only cold mailboxes; paused, warming up and full ones have no room; the total adds up", async () => {
  const DB = fakeD1();
  const now = new Date("2026-10-22T10:00:00Z"); // Thu
  assert.deepEqual(await roomForFirsts(DB, now), { day: "2026-10-22", total: 0, byMailbox: {} });
  await insertMailbox(DB, { id: "sys", role: "system", cap_override: 50 }); // never sends cold email
  assert.deepEqual(await roomForFirsts(DB, now), { day: "2026-10-22", total: 0, byMailbox: {} });
  await insertMailbox(DB, { id: "m1", cap_override: 10 });
  await insertMailbox(DB, { id: "m2", cap_override: 4 });
  await insertMailbox(DB, { id: "paused", cap_override: 10, status: "paused", paused_reason: "2 hard bounces in 7 days" });
  await insertMailbox(DB, { id: "warm", started_on: "2026-10-20" }); // cap 0 until 3 Nov
  for (let i = 0; i < 3; i++) await seedMessage(DB, { mailbox_id: "m2", kind: "first", status: "sent", sent_at: "2026-10-22T08:00:00Z" });
  const r = await roomForFirsts(DB, now);
  assert.deepEqual(r, {
    day: "2026-10-22",
    total: 11,
    byMailbox: {
      m1: { room: 10, fullDay: null },
      m2: { room: 1, fullDay: null },
      paused: { room: 0, fullDay: "2026-10-22" },
      warm: { room: 0, fullDay: "2026-10-22" },
    },
  });
});

test("roomForFirsts on a Sunday plans for Monday; mail sent on Saturday doesn't use Monday's places", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 3 });
  for (let i = 0; i < 3; i++) await seedMessage(DB, { kind: "first", status: "sent", sent_at: "2026-10-24T09:00:00Z" });
  // A follow-up booked for Sunday goes Monday: it takes one of Monday's places.
  await insertProspect(DB, { place_id: "p1", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-23T08:00:00Z",
    followup_step: 1, next_followup_at: "2026-10-25T08:00:00Z" });
  const r = await roomForFirsts(DB, new Date("2026-10-25T12:00:00Z")); // Sun 12:00 GMT
  assert.equal(r.day, "2026-10-26");
  assert.deepEqual(r.byMailbox.m1, { room: 2, fullDay: null });
  assert.equal(r.total, 2);
});

test("roomForFirsts is one batch of 3 D1 statements", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 10 });
  await insertProspect(DB, { place_id: "p1", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-21T08:00:00Z",
    followup_step: 0, next_followup_at: "2026-10-22T08:00:00Z" });
  await seedMessage(DB, { place_id: "p1", kind: "first", status: "sent", sent_at: "2026-10-21T08:00:00Z" });
  let batches = 0;
  const counted = countingDB({ prepare: (sql) => DB.prepare(sql), batch: (stmts) => (batches++, DB.batch(stmts)) });
  await roomForFirsts(counted.DB, new Date("2026-10-22T10:00:00Z"));
  assert.equal(counted.used(), 3);
  assert.equal(batches, 1);
  const planning = countingDB(DB);
  await planningRows(planning.DB, new Date("2026-10-22T10:00:00Z"));
  assert.equal(planning.used(), 2);
});

// ---------------------------------------------------------------- followupsDueByMailbox

test("followupsDueByMailbox: queued follow-ups due by the end of UK today and pending ones, per mailbox", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 10 });
  await insertMailbox(DB, { id: "m2", cap_override: 10 });
  const now = new Date("2026-10-21T08:00:00Z"); // Wed 09:00 BST; UK today ends at 2026-10-21T23:00:00Z
  // Queued follow-ups: due this morning (m1), due 23:30 BST tonight (m2), due tomorrow (not counted).
  await seedMessage(DB, { kind: "followup", status: "queued", mailbox_id: "m1", due_at: "2026-10-21T07:00:00Z" });
  await seedMessage(DB, { kind: "followup", status: "queued", mailbox_id: "m2", due_at: "2026-10-21T22:30:00Z" });
  await seedMessage(DB, { kind: "followup", status: "queued", mailbox_id: "m2", due_at: "2026-10-21T23:30:00Z" });
  // Not follow-ups waiting to go: sending (already in sentToday), sent, a queued first email.
  await seedMessage(DB, { kind: "followup", status: "sending", mailbox_id: "m1", due_at: "2026-10-21T07:00:00Z" });
  await seedMessage(DB, { kind: "followup", status: "sent", mailbox_id: "m1", due_at: "2026-10-21T07:00:00Z" });
  await seedMessage(DB, { kind: "first", status: "queued", mailbox_id: "m1", due_at: "2026-10-21T07:00:00Z" });
  // A queued follow-up whose row has no mailbox goes from its thread's (the prospect's) mailbox.
  await insertProspect(DB, { place_id: "t1", stage: "emailed", mailbox_id: "m2", first_sent_at: "2026-10-14T08:00:00Z",
    followup_step: 2, next_followup_at: null });
  await seedMessage(DB, { place_id: "t1", kind: "followup", step: 3, status: "queued", mailbox_id: null, due_at: "2026-10-21T08:00:00Z" });
  // Pending: overdue (m1), tonight (m2); not: tomorrow, step 9's close time, replied, stopped.
  const pending = (place_id, mailbox_id, next_followup_at, o = {}) => insertProspect(DB, {
    place_id, stage: "emailed", mailbox_id, first_sent_at: "2026-10-13T08:00:00Z", followup_step: 1, next_followup_at, ...o,
  });
  await pending("overdue", "m1", "2026-10-20T08:00:00Z", { stage: "viewed" });
  await pending("tonight", "m2", "2026-10-21T22:59:00Z");
  await pending("tomorrow", "m1", "2026-10-21T23:00:00Z");
  await pending("closing", "m1", "2026-10-21T08:00:00Z", { followup_step: 9 });
  await pending("replied", "m1", "2026-10-21T08:00:00Z", { stage: "replied" });
  await pending("stopped", "m1", null);

  const counted = countingDB(DB);
  assert.deepEqual(await followupsDueByMailbox(counted.DB, now), { total: 5, byMailbox: { m1: 2, m2: 3 } });
  assert.equal(counted.used(), 1);
  assert.deepEqual(await followupsDueByMailbox(fakeD1(), now), { total: 0, byMailbox: {} });
});

// ---------------------------------------------------------------- capacityNow (stage 3) with roomForFirsts

test("capacityNow: stage 3's numbers are unchanged, room is the smaller of its formula and roomForFirsts", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 10 });
  const now = new Date("2026-10-21T08:00:00Z"); // Wed 09:00 BST
  // A mix: queued follow-ups (one due tomorrow: stage 3 counts every queued one), pending ones, a finished one,
  // a stopped stage, sent and queued first emails.
  await seedMessage(DB, { kind: "followup", status: "queued", due_at: "2026-10-21T07:00:00Z" });
  await seedMessage(DB, { kind: "followup", status: "queued", due_at: "2026-10-22T07:00:00Z" });
  await seedMessage(DB, { kind: "followup", status: "sending", due_at: "2026-10-21T07:00:00Z" });
  await seedMessage(DB, { kind: "first", status: "sent", sent_at: "2026-10-21T07:30:00Z" });
  await seedMessage(DB, { kind: "first", status: "queued", due_at: "2026-10-21T07:45:00Z" });
  await insertProspect(DB, { place_id: "p1", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-20T08:00:00Z",
    followup_step: 0, next_followup_at: "2026-10-21T08:00:00Z" });
  await insertProspect(DB, { place_id: "p2", stage: "viewed", mailbox_id: "m1", first_sent_at: "2026-10-12T08:00:00Z",
    followup_step: 4, next_followup_at: "2026-10-22T08:00:00Z" });
  await insertProspect(DB, { place_id: "p3", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-08-12T08:00:00Z",
    followup_step: 9, next_followup_at: "2026-10-21T08:00:00Z" });
  await insertProspect(DB, { place_id: "p4", stage: "replied", mailbox_id: "m1", first_sent_at: "2026-10-12T08:00:00Z",
    followup_step: 4, next_followup_at: "2026-10-21T08:00:00Z" });
  // A prospect with no first_sent_at can't be planned by its schedule, but stage 3 still counts it as due.
  await insertProspect(DB, { place_id: "p5", stage: "emailed", mailbox_id: "m1", followup_step: 0,
    next_followup_at: "2026-10-21T09:00:00Z" });

  const c = await capacityNow(DB, now);
  assert.equal(c.followupsDue, await followupsDueToday(DB, now));
  assert.deepEqual([c.cap, c.sent, c.followupsDue, c.firstQueued], [10, 2, 4, 1]); // the sending one is in sent
  const room = await roomForFirsts(DB, now);
  assert.equal(c.room, Math.min(Math.max(0, 10 - 2 - 4 - 1), room.total));
  assert.deepEqual([c.today, c.sendDay, c.nextDay], ["2026-10-21", "2026-10-21", "2026-10-22"]);
});

test("capacityNow: roomForFirsts caps the banner's room, and the banner text is stage 3's", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 3 });
  // Three Monday first emails whose follow-up 1 is booked for Tuesday: Monday itself has every place free.
  for (let i = 0; i < 3; i++)
    await insertProspect(DB, { place_id: `p${i}`, stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-26T09:00:00Z",
      followup_step: 0, next_followup_at: "2026-10-27T09:00:00Z" });
  const c = await capacityNow(DB, new Date("2026-10-26T12:00:00Z")); // Mon 12:00 GMT
  assert.equal(c.followupsDue, 0);
  assert.equal(c.room, 0); // 3 − 0 − 0 − 0 = 3, but Tuesday is full
  assert.equal(c.banner.text, "No room for more first emails today (3 a day). The next ones can go tomorrow.");
});

test("capacityNow stays at 4 D1 statements", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 10 });
  await insertProspect(DB, { place_id: "p1", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-21T08:00:00Z",
    followup_step: 0, next_followup_at: "2026-10-22T08:00:00Z" });
  await seedMessage(DB, { kind: "followup", status: "queued", due_at: "2026-10-22T07:00:00Z" });
  const counted = countingDB(DB);
  await capacityNow(counted.DB, new Date("2026-10-22T10:00:00Z"));
  assert.ok(counted.used() <= 4, `capacityNow ran ${counted.used()} statements`);
});

// ---------------------------------------------------------------- review: UK days, lifecycle, paused mailbox

test("planningRows, followupsDueByMailbox and roomForFirsts use UK days after the clocks go back (GMT)", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 10 });
  const now = new Date("2026-10-27T10:00:00Z"); // Tue 10:00 GMT: UK today runs 00:00Z to 00:00Z (BST would be 23:00Z)
  await seedMessage(DB, { kind: "followup", status: "sent", sent_at: "2026-10-26T23:30:00Z" }); // Mon 23:30 GMT: yesterday
  await seedMessage(DB, { kind: "first", status: "sent", sent_at: "2026-10-27T00:10:00Z" });    // Tue 00:10 GMT: today
  assert.deepEqual((await planningRows(DB, now)).cold.map((c) => c.at), ["2026-10-27T00:10:00Z"]);
  await seedMessage(DB, { kind: "followup", status: "queued", due_at: "2026-10-27T23:30:00Z" }); // Tue 23:30 GMT: today
  await seedMessage(DB, { kind: "followup", status: "queued", due_at: "2026-10-28T00:00:00Z" }); // Wed 00:00 GMT: tomorrow
  await insertProspect(DB, { place_id: "p1", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-20T08:00:00Z",
    followup_step: 2, next_followup_at: "2026-10-27T23:59:00Z" });
  assert.deepEqual(await followupsDueByMailbox(DB, now), { total: 2, byMailbox: { m1: 2 } });
  assert.equal((await roomForFirsts(DB, now)).day, "2026-10-27");
});

test("roomForFirsts books a thread the same at every point of a send: booked, queued, sending, sent, synced", async () => {
  // Between ticks (up to 5 minutes) a send is queued, sending or sent but not synced to the prospect yet. If any of
  // those states dropped the thread's later follow-ups from the plan, Nik could send more first emails than the
  // mailbox's days can take (A11 #4: never more than 10 a day). Every state must give exactly the same load.
  const now = new Date("2026-10-22T10:00:00Z"); // Thu 11:00 BST
  async function base() {
    const DB = fakeD1();
    await insertMailbox(DB, { id: "m1", cap_override: 6 });
    await insertProspect(DB, { place_id: "bg1", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-19T08:00:00Z",
      followup_step: 2, next_followup_at: "2026-10-23T08:00:00Z" });
    await insertProspect(DB, { place_id: "bg2", stage: "viewed", mailbox_id: "m1", first_sent_at: "2026-10-15T09:30:00Z",
      followup_step: 3, next_followup_at: "2026-10-22T08:30:00Z" });
    return DB;
  }
  const loadOf = async (DB) => (await planFirsts(DB, now)).load;

  // A follow-up: thread x's step 2 is due Thu 08:00 (first email Tue 20 Oct).
  const first = "2026-10-20T08:00:00Z";
  const went = "2026-10-22T09:59:00Z";
  const followupStates = {
    booked: async (DB) => insertProspect(DB, { place_id: "x", stage: "emailed", mailbox_id: "m1", first_sent_at: first,
      followup_step: 1, next_followup_at: "2026-10-22T08:00:00Z" }),
    synced: async (DB) => {
      await insertProspect(DB, { place_id: "x", stage: "emailed", mailbox_id: "m1", first_sent_at: first, followup_step: 2,
        next_followup_at: iso(nextDue(first, 3, went)) });
      await seedMessage(DB, { place_id: "x", kind: "followup", step: 2, status: "sent", due_at: "2026-10-22T08:00:00Z", sent_at: went });
    },
  };
  for (const status of ["queued", "sending", "sent"]) {
    followupStates[status] = async (DB) => {
      await insertProspect(DB, { place_id: "x", stage: "emailed", mailbox_id: "m1", first_sent_at: first, followup_step: 1,
        next_followup_at: null });
      await seedMessage(DB, { place_id: "x", kind: "followup", step: 2, status, due_at: "2026-10-22T08:00:00Z",
        sent_at: status === "queued" ? null : went });
    };
  }
  const followupLoads = {};
  for (const [state, seed] of Object.entries(followupStates)) {
    const DB = await base();
    await seed(DB);
    followupLoads[state] = await loadOf(DB);
  }
  for (const state of Object.keys(followupStates)) assert.deepEqual(followupLoads[state], followupLoads.booked, `follow-up ${state}`);

  // A first email: queued for 09:30 (going now), sending, sent but the lead still `ready`, synced (`emailed`).
  const at = "2026-10-22T09:30:00Z";
  const firstLoads = {};
  for (const state of ["queued", "sending", "sent", "synced"]) {
    const DB = await base();
    if (state === "synced") {
      await insertProspect(DB, { place_id: "y", stage: "emailed", mailbox_id: "m1", first_sent_at: at, followup_step: 0,
        next_followup_at: iso(schedule(at, 1)) });
    } else {
      await insertProspect(DB, { place_id: "y", stage: "ready", mailbox_id: "m1" });
      await readyLeadRows(DB, "y");
    }
    const status = state === "synced" ? "sent" : state;
    await seedMessage(DB, { place_id: "y", kind: "first", status, due_at: at, sent_at: status === "queued" ? null : at });
    firstLoads[state] = await loadOf(DB);
  }
  for (const state of ["queued", "sending", "sent"]) assert.deepEqual(firstLoads[state], firstLoads.synced, `first email ${state}`);
  assert.equal(Object.values(firstLoads.synced.m1).reduce((a, b) => a + b, 0), 10 + 7 + 6); // y's 10, bg1's 7, bg2's 6
});

test("roomForFirsts: a paused mailbox's waiting follow-ups stay on it and never take another mailbox's places (A9)", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 10, status: "paused", paused_reason: "2 hard bounces in 7 days" });
  await insertMailbox(DB, { id: "m2", cap_override: 2 });
  // Its step 4 has waited 3 days (queued with no mailbox of its own: it goes from the thread's, m1).
  await insertProspect(DB, { place_id: "t1", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-12T08:00:00Z",
    followup_step: 3, next_followup_at: null });
  await seedMessage(DB, { place_id: "t1", mailbox_id: null, kind: "followup", step: 4, status: "queued", due_at: "2026-10-19T08:00:00Z" });
  const p = await planFirsts(DB, new Date("2026-10-22T10:00:00Z"));
  assert.equal(p.load.m2, undefined);
  assert.equal(p.load.m1["2026-10-22"], 1);                              // overdue: it counts on today, on its own mailbox
  assert.equal(Object.values(p.load.m1).reduce((a, b) => a + b, 0), 6);   // and steps 5–9 after it
  assert.deepEqual(p.room, { day: "2026-10-22", total: 2,
    byMailbox: { m1: { room: 0, fullDay: "2026-10-22" }, m2: { room: 2, fullDay: null } } });
});

test("capacityNow's sendDay is roomForFirsts' day, and its room never goes over that total", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 10 });
  for (let i = 0; i < 4; i++)
    await insertProspect(DB, { place_id: `p${i}`, stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-19T08:00:00Z",
      followup_step: 2, next_followup_at: "2026-10-23T08:00:00Z" });
  // Thu in the window; Sat evening (BST); Sunday (the clocks went back); Monday before 07:00 GMT.
  for (const at of ["2026-10-22T10:00:00Z", "2026-10-24T19:30:00Z", "2026-10-25T12:00:00Z", "2026-10-26T06:30:00Z"]) {
    const now = new Date(at);
    const [c, r] = [await capacityNow(DB, now), await roomForFirsts(DB, now)];
    assert.equal(c.sendDay, r.day, at);
    assert.ok(c.room <= r.total, `${at}: banner ${c.room}, Send ${r.total}`);
  }
});

// ================================================================ Task 7: sync sent messages and stop sequences

// A `ready` prospect (stage 3/4's row) writing from cold mailbox m1, with the setting business:sender_name "Nik".
// The mailbox's display_name is "Nik Example", so a footer stripped with "Nik" proves the setting is what's used.
async function seedReady(DB, place_id, o = {}) {
  if (!(await DB.prepare("SELECT 1 AS x FROM mailboxes WHERE id = 'm1'").first())) {
    await insertMailbox(DB, { id: "m1", cap_override: 10, display_name: "Nik Example" });
    await setSetting(DB, "business:sender_name", "Nik");
  }
  return insertProspect(DB, { place_id, stage: "ready", mailbox_id: "m1", greet_name: "Mark", subject: "Your website", ...o });
}
const insertMessage = (DB, o = {}) => seedMessage(DB, o);
const getProspect = (DB, place_id) => DB.prepare("SELECT * FROM prospects WHERE place_id = ?").bind(place_id).first();
const messageOf = (DB, id) => DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
const countOf = async (DB, sql, ...binds) => Number((await DB.prepare(sql).bind(...binds).first()).n);
const todoOf = (DB, prefix) => DB.prepare("SELECT * FROM todos WHERE substr(dedupe, 1, length(?1)) = ?1").bind(prefix).all()
  .then((r) => r.results);

// The worked example's first email (A4): Thu 22 Oct 2026 09:15 BST.
const FIRST = "2026-10-22T08:15:00Z";
// An emailed lead whose first email went at FIRST from m1, threaded under <root-<id>@aetoswebsites.com>.
const seedEmailed = (DB, place_id, o = {}) => seedReady(DB, place_id, {
  stage: "emailed", first_sent_at: FIRST, root_message_id: `<root-${place_id}@aetoswebsites.com>`, followup_step: 0,
  next_followup_at: null, ...o,
});
const inbound = (DB, place_id, cls, received_at, o = {}) => insertMessage(DB, {
  place_id, direction: "in", kind: "inbound", author: "them", class: cls, status: "received", received_at, ...o,
});

// ---------------------------------------------------------------- the plan's tests (Part B, Task 7, Step 1)

test("first email sent → emailed, schedule, style example", async () => {
  const DB = fakeD1(); await seedReady(DB, "p1");                       // prospect 'ready', mailbox m1, business:sender_name "Nik"
  await insertMessage(DB, { id: "x1", place_id: "p1", kind: "first", author: "nik", status: "sent", message_id: "<a@aetoswebsites.com>",
    sent_at: "2026-10-22T08:15:00Z", body: `Hi,\n\nLook: https://d\n\n${coldFooter("Nik")}` });
  assert.deepEqual(await syncSent(DB, new Date("2026-10-22T08:20:00Z")), { firsts: 1, followups: 0, stopped: 0 });
  const p = await getProspect(DB, "p1");
  assert.equal(p.stage, "emailed");
  assert.equal(p.root_message_id, "<a@aetoswebsites.com>");
  assert.equal(p.next_followup_at, "2026-10-23T08:15:00Z");
  const ex = await DB.prepare("SELECT * FROM style_examples WHERE id = 'sent:x1'").first();
  assert.equal(ex.source, "nik_sent"); assert.equal(ex.body, "Hi,\n\nLook: https://d");
  assert.deepEqual(await syncSent(DB, new Date("2026-10-22T08:25:00Z")), { firsts: 0, followups: 0, stopped: 0 }); // idempotent
});

test("queued first email does not save a style example", async () => {
  const DB = fakeD1(); await seedReady(DB, "p1");
  await insertMessage(DB, { id: "x1", place_id: "p1", kind: "first", author: "nik", status: "queued", message_id: "<a@aetoswebsites.com>",
    due_at: "2026-10-22T08:15:00Z", body: `Hi,\n\nLook: https://d\n\n${coldFooter("Nik")}` });
  const now = new Date("2026-10-22T08:20:00Z");
  // Queued, then going, then failed or cancelled: never a style example, and the lead stays ready (A11 #7).
  for (const status of ["queued", "sending", "failed", "cancelled"]) {
    await DB.prepare("UPDATE messages SET status = ?1, sent_at = CASE WHEN ?1 = 'sending' THEN ?2 END WHERE id = 'x1'")
      .bind(status, "2026-10-22T08:15:00Z").run();
    assert.deepEqual(await syncSent(DB, now), { firsts: 0, followups: 0, stopped: 0 }, status);
    assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM style_examples"), 0, status);
    const p = await getProspect(DB, "p1");
    assert.equal(p.stage, "ready", status);
    assert.deepEqual([p.first_sent_at, p.root_message_id, p.next_followup_at], [null, null, null], status);
  }
  // Only once it has really gone.
  await DB.prepare("UPDATE messages SET status = 'sent', sent_at = '2026-10-22T08:15:00Z' WHERE id = 'x1'").run();
  assert.deepEqual(await syncSent(DB, now), { firsts: 1, followups: 0, stopped: 0 });
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM style_examples"), 1);
  assert.equal((await getProspect(DB, "p1")).stage, "emailed");
});

test("reply that landed before the sync stops at once", async () => {
  const DB = fakeD1(); await seedReady(DB, "p1");
  await insertMessage(DB, { id: "x1", place_id: "p1", kind: "first", status: "sent", sent_at: "2026-10-22T08:15:00Z", message_id: "<a@x>" });
  await insertMessage(DB, { id: "i1", place_id: "p1", direction: "in", kind: "inbound", author: "them", class: "human", status: "received", received_at: "2026-10-22T08:17:00Z" });
  const r = await syncSent(DB, new Date("2026-10-22T08:20:00Z"));
  assert.equal(r.stopped, 1);
  const p = await getProspect(DB, "p1");
  assert.equal(p.stage, "replied"); assert.equal(p.next_followup_at, null); assert.equal(p.first_sent_at, "2026-10-22T08:15:00Z");
});

test("follow-up 9 sent → close time is 7 days later", async () => {
  const DB = fakeD1();
  await seedEmailed(DB, "p1", { followup_step: 8, next_followup_at: null }); // step 9 queued, so nothing is booked
  await insertMessage(DB, { id: "f9", place_id: "p1", kind: "followup", step: 9, status: "sent", message_id: "<f9@aetoswebsites.com>",
    due_at: "2026-12-21T09:15:00Z", sent_at: "2026-12-21T09:15:00Z" });
  assert.deepEqual(await syncSent(DB, new Date("2026-12-21T09:20:00Z")), { firsts: 0, followups: 1, stopped: 0 });
  const p = await getProspect(DB, "p1");
  assert.equal(p.followup_step, 9);
  assert.equal(p.next_followup_at, "2026-12-28T09:15:00Z");
  assert.equal(p.stage, "emailed");                                       // lost only once the close time passes (Task 8)
  assert.deepEqual(await syncSent(DB, new Date("2026-12-21T09:25:00Z")), { firsts: 0, followups: 0, stopped: 0 });
});

test("sweepStops cancels queued follow-ups on opt-out, not on a demo view", async () => {
  const DB = fakeD1();
  // Viewed their demo, follow-ups 1–2 sent, step 3 queued (queueing it cleared next_followup_at).
  await seedEmailed(DB, "p1", { stage: "viewed", views: 1, last_view_at: "2026-10-24T18:00:00Z", followup_step: 2 });
  await insertMessage(DB, { id: "f3", place_id: "p1", kind: "followup", step: 3, status: "queued", due_at: "2026-10-26T09:15:00Z" });
  const now = new Date("2026-10-26T09:00:00Z");
  assert.equal(await sweepStops(DB, now), 0);
  assert.equal((await messageOf(DB, "f3")).status, "queued");
  await inbound(DB, "p1", "opt_out", "2026-10-25T12:00:00Z");
  assert.equal(await sweepStops(DB, now), 1);
  const f3 = await messageOf(DB, "f3");
  assert.equal(f3.status, "cancelled");
  assert.equal(f3.error, "Stopped: opt_out");
  assert.equal((await getProspect(DB, "p1")).next_followup_at, null);
  assert.equal(await sweepStops(DB, now), 0);                             // nothing left to stop
});

// ---------------------------------------------------------------- stopFollowups

test("stopFollowups clears the next follow-up and cancels only this lead's queued follow-ups", async () => {
  const DB = fakeD1();
  await seedEmailed(DB, "p1", { followup_step: 2, next_followup_at: "2026-10-26T09:15:00Z" });
  await seedEmailed(DB, "p10", { followup_step: 2, next_followup_at: "2026-10-26T09:15:00Z" });
  await insertMessage(DB, { id: "q1", place_id: "p1", kind: "followup", step: 3, status: "queued", due_at: "2026-10-26T09:15:00Z" });
  await insertMessage(DB, { id: "s1", place_id: "p1", kind: "followup", step: 2, status: "sending", sent_at: "2026-10-24T08:15:00Z" });
  await insertMessage(DB, { id: "d1", place_id: "p1", kind: "followup", step: 1, status: "sent", sent_at: "2026-10-23T08:15:00Z" });
  await insertMessage(DB, { id: "r1", place_id: "p1", kind: "reply", author: "claude", status: "queued" }); // Claude's answer still goes
  await insertMessage(DB, { id: "q10", place_id: "p10", kind: "followup", step: 3, status: "queued", due_at: "2026-10-26T09:15:00Z" });
  const now = new Date("2026-10-25T10:00:00Z");

  const counted = countingDB(DB);
  assert.equal(await stopFollowups(counted.DB, "p1", "replied", now), 1);
  assert.equal(counted.used(), 2);                                        // one batch of 2
  const p1 = await getProspect(DB, "p1");
  assert.deepEqual([p1.next_followup_at, p1.updated_at, p1.followup_step, p1.stage], [null, "2026-10-25T10:00:00Z", 2, "emailed"]);
  const q1 = await messageOf(DB, "q1");
  assert.deepEqual([q1.status, q1.error], ["cancelled", "Stopped: replied"]);
  assert.equal((await messageOf(DB, "s1")).status, "sending");            // may be going right now: never touched
  assert.equal((await messageOf(DB, "d1")).status, "sent");
  assert.equal((await messageOf(DB, "r1")).status, "queued");
  assert.equal((await messageOf(DB, "q10")).status, "queued");            // another lead's
  assert.equal((await getProspect(DB, "p10")).next_followup_at, "2026-10-26T09:15:00Z");

  // Again: nothing left; a lead with no prospect row: nothing.
  assert.equal(await stopFollowups(DB, "p1", "replied", new Date("2026-10-25T11:00:00Z")), 0);
  assert.equal((await getProspect(DB, "p1")).updated_at, "2026-10-25T10:00:00Z"); // an unchanged row isn't re-stamped
  assert.equal(await stopFollowups(DB, "nobody", "replied", now), 0);
  // Never restarts: a later sync or sweep leaves it stopped.
  await syncSent(DB, now); await sweepStops(DB, now);
  assert.equal((await getProspect(DB, "p1")).next_followup_at, null);
});

test("stopFollowups explains bad input in plain English", async () => {
  const DB = fakeD1();
  const now = new Date("2026-10-25T10:00:00Z");
  await assert.rejects(stopFollowups(DB, "", "replied", now), { name: "TypeError", message: /place_id/ });
  await assert.rejects(stopFollowups(DB, "p1", " ", now), { name: "TypeError", message: /why/ });
  await assert.rejects(stopFollowups(DB, "p1", "replied", "soon"), /time now/);
});

test("stopFollowups never touches a first email, queued or sent", async () => {
  // Stage 7 calls it on every human reply, and a reply can come from a lead still `ready` (a first email queued, or
  // sent but not synced yet). Cancelling Nik's first email is his call on the thread (A8), never a stop rule's.
  const DB = fakeD1(); await seedReady(DB, "p1"); await seedReady(DB, "p2");
  await insertMessage(DB, { id: "q1", place_id: "p1", kind: "first", status: "queued", due_at: "2026-10-26T07:00:00Z" });
  await insertMessage(DB, { id: "s2", place_id: "p2", kind: "first", status: "sent", sent_at: FIRST, message_id: "<s2@x>" });
  const now = new Date("2026-10-22T08:20:00Z");
  assert.equal(await stopFollowups(DB, "p1", "replied", now), 0);
  assert.equal(await stopFollowups(DB, "p2", "replied", now), 0);
  assert.equal((await messageOf(DB, "q1")).status, "queued");
  assert.equal((await messageOf(DB, "s2")).status, "sent");
  assert.equal((await getProspect(DB, "p1")).updated_at, SEED_AT);       // nothing was booked, so nothing changed
  assert.deepEqual(await syncSent(DB, now), { firsts: 1, followups: 0, stopped: 0 }); // p2's still gets recorded
});

// ---------------------------------------------------------------- syncSent: first emails

test("syncSent: a first email's facts, follow-up 1 by schedule, the style example in Nik's words", async () => {
  const DB = fakeD1(); await seedReady(DB, "p1");
  // Saturday 10:00 BST: follow-up 1 (day 1 is a Sunday) goes Monday at 10:00, now GMT.
  const body = `Hi Mark,\n\nI made you a site: https://aetoswebsites.com/d/green-leaf\nHave a look.\n\n${coldFooter("Nik")}`;
  await insertMessage(DB, { id: "x1", place_id: "p1", kind: "first", status: "sent", message_id: "<sat@aetoswebsites.com>",
    due_at: "2026-10-24T09:00:00Z", sent_at: "2026-10-24T09:00:00Z", body });
  const now = new Date("2026-10-24T09:04:00Z");
  assert.deepEqual(await syncSent(DB, now), { firsts: 1, followups: 0, stopped: 0 });
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.stage, p.stage_at, p.first_sent_at, p.root_message_id, p.followup_step, p.next_followup_at, p.updated_at],
    ["emailed", "2026-10-24T09:04:00Z", "2026-10-24T09:00:00Z", "<sat@aetoswebsites.com>", 0, "2026-10-26T10:00:00Z", "2026-10-24T09:04:00Z"]);
  assert.equal(p.next_followup_at, iso(schedule("2026-10-24T09:00:00Z", 1)));
  const ex = await DB.prepare("SELECT * FROM style_examples").all().then((r) => r.results);
  assert.deepEqual(ex, [{ id: "sent:x1", kind: "example", situation: "first email",
    body: "Hi Mark,\n\nI made you a site: https://aetoswebsites.com/d/green-leaf\nHave a look.", source: "nik_sent",
    created_at: "2026-10-24T09:04:00Z" }]);
  // The prospect's email, greeting, mailbox and subject are left as Send set them.
  assert.deepEqual([p.email, p.greet_name, p.mailbox_id, p.subject], ["p1@example.com", "Mark", "m1", "Your website"]);
});

test("syncSent: an auto-reply, or mail from before the first email, doesn't stop it", async () => {
  const DB = fakeD1(); await seedReady(DB, "p1");
  await insertMessage(DB, { id: "x1", place_id: "p1", kind: "first", status: "sent", sent_at: FIRST, message_id: "<a@x>" });
  await inbound(DB, "p1", "auto", "2026-10-22T08:16:00Z");               // out of office
  await inbound(DB, "p1", "human", "2026-10-20T10:00:00Z");              // wrote to them before we did
  assert.deepEqual(await syncSent(DB, new Date("2026-10-22T08:20:00Z")), { firsts: 1, followups: 0, stopped: 0 });
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.stage, p.next_followup_at], ["emailed", "2026-10-23T08:15:00Z"]);
});

test("syncSent: an opt-out or bounce before the sync — the send is recorded, the lead stays lost, nothing is booked", async () => {
  for (const cls of ["opt_out", "bounce"]) {
    const DB = fakeD1(); await seedReady(DB, "p1");
    await insertMessage(DB, { id: "x1", place_id: "p1", kind: "first", status: "sent", sent_at: FIRST, message_id: "<a@x>",
      body: `Hi,\n\nLook: https://d\n\n${coldFooter("Nik")}` });
    await inbound(DB, "p1", cls, "2026-10-22T08:16:00Z");
    await applyStageEvent(DB, "p1", cls, "2026-10-22T08:16:00Z");       // what stage 0's inbound step does: → lost
    const counted = countingDB(DB);
    assert.deepEqual(await syncSent(counted.DB, new Date("2026-10-22T08:20:00Z")), { firsts: 1, followups: 0, stopped: 1 }, cls);
    assert.equal(counted.used(), 4, cls);                                // read, setting, one batch of 2: no stage event is needed
    const p = await getProspect(DB, "p1");
    assert.deepEqual([p.stage, p.lost_reason, p.first_sent_at, p.root_message_id, p.followup_step, p.next_followup_at],
      ["lost", cls, FIRST, "<a@x>", 0, null], cls);
    assert.equal((await DB.prepare("SELECT body FROM style_examples WHERE id = 'sent:x1'").first()).body, "Hi,\n\nLook: https://d", cls);
  }
});

test("syncSent: an opt-out the inbound step hasn't applied yet is applied (lost, opt_out)", async () => {
  const DB = fakeD1(); await seedReady(DB, "p1");
  await insertMessage(DB, { id: "x1", place_id: "p1", kind: "first", status: "sent", sent_at: FIRST, message_id: "<a@x>" });
  await inbound(DB, "p1", "opt_out", "2026-10-22T08:16:00Z");
  assert.deepEqual(await syncSent(DB, new Date("2026-10-22T08:20:00Z")), { firsts: 1, followups: 0, stopped: 1 });
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.stage, p.lost_reason, p.next_followup_at, p.first_sent_at], ["lost", "opt_out", null, FIRST]);
});

test("syncSent: a lead that paid before the sync stays won, with no follow-ups", async () => {
  const DB = fakeD1(); await seedReady(DB, "p1", { stage: "won" });
  await insertMessage(DB, { id: "x1", place_id: "p1", kind: "first", status: "sent", sent_at: FIRST, message_id: "<a@x>" });
  assert.deepEqual(await syncSent(DB, new Date("2026-10-22T08:20:00Z")), { firsts: 1, followups: 0, stopped: 1 });
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.stage, p.first_sent_at, p.next_followup_at], ["won", FIRST, null]);
});

test("syncSent: a lead escalated to Nik before the sync keeps its stage, gets its facts and no follow-ups", async () => {
  // They replied within minutes and stage 7 escalated (ready → needs_nik) before the next followups step ran.
  const DB = fakeD1(); await seedReady(DB, "p1", { stage: "needs_nik" });
  await insertMessage(DB, { id: "x1", place_id: "p1", kind: "first", status: "sent", sent_at: FIRST, message_id: "<a@x>",
    body: `Hi Mark,\n\nLook: https://d\n\n${coldFooter("Nik")}` });
  await inbound(DB, "p1", "human", "2026-10-22T08:17:00Z");
  const counted = countingDB(DB);
  assert.deepEqual(await syncSent(counted.DB, new Date("2026-10-22T08:20:00Z")), { firsts: 1, followups: 0, stopped: 1 });
  assert.equal(counted.used(), 4);                                        // read, setting, batch of 2: no stage event
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.stage, p.first_sent_at, p.root_message_id, p.followup_step, p.next_followup_at],
    ["needs_nik", FIRST, "<a@x>", 0, null]);
  assert.equal((await DB.prepare("SELECT body FROM style_examples WHERE id = 'sent:x1'").first()).body, "Hi Mark,\n\nLook: https://d");
});

// ---------------------------------------------------------------- syncSent: follow-ups

test("syncSent: a sent follow-up books the next by nextDue and closes only that lead's failing todo", async () => {
  const DB = fakeD1();
  await seedEmailed(DB, "p1", { stage: "viewed", followup_step: 1 });
  await seedEmailed(DB, "p10", { followup_step: 1 });
  await addTodo(DB, { kind: "health", title: "Follow-ups to Lead p1 keep failing: timeout", dedupe: "health:followup-fail:p1" });
  await addTodo(DB, { kind: "health", title: "Follow-ups to Lead p10 keep failing: timeout", dedupe: "health:followup-fail:p10" });
  // p1's step 2 was due Sat 24 Oct 08:15Z and went 5 minutes late.
  await insertMessage(DB, { id: "f2", place_id: "p1", kind: "followup", step: 2, status: "sent", message_id: "<f2@aetoswebsites.com>",
    due_at: "2026-10-24T08:15:00Z", sent_at: "2026-10-24T08:20:00Z" });
  const now = new Date("2026-10-24T08:25:00Z");
  assert.deepEqual(await syncSent(DB, now), { firsts: 0, followups: 1, stopped: 0 });
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.stage, p.followup_step, p.updated_at], ["viewed", 2, "2026-10-24T08:25:00Z"]);
  assert.equal(p.next_followup_at, iso(nextDue(FIRST, 3, "2026-10-24T08:20:00Z")));
  assert.equal(p.next_followup_at, "2026-10-26T09:15:00Z");               // Mon, now GMT (A4's worked example)
  const [closed] = await todoOf(DB, "health:followup-fail:p1@");
  assert.equal(closed.status, "done");
  assert.equal(closed.done_at, "2026-10-24T08:25:00Z");
  const [other] = await todoOf(DB, "health:followup-fail:p10");
  assert.deepEqual([other.status, other.dedupe], ["open", "health:followup-fail:p10"]); // closeTodos' prefix would close it
  assert.equal((await getProspect(DB, "p10")).followup_step, 1);
  assert.deepEqual(await syncSent(DB, now), { firsts: 0, followups: 0, stopped: 0 }); // idempotent
  // The same problem can come back later as a new todo (the dedupe was freed).
  assert.ok(await addTodo(DB, { kind: "health", title: "Follow-ups to Lead p1 keep failing: again", dedupe: "health:followup-fail:p1" }));
});

test("syncSent: a reply while a follow-up was going — the step is recorded and nothing more is booked", async () => {
  const DB = fakeD1();
  await seedEmailed(DB, "p1");
  await insertMessage(DB, { id: "f1", place_id: "p1", kind: "followup", step: 1, status: "sent", sent_at: "2026-10-23T08:15:00Z" });
  await inbound(DB, "p1", "human", "2026-10-23T08:15:30Z");               // its stage event hasn't landed yet
  assert.deepEqual(await syncSent(DB, new Date("2026-10-23T08:20:00Z")), { firsts: 0, followups: 1, stopped: 1 });
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.stage, p.followup_step, p.next_followup_at], ["replied", 1, null]);
  assert.deepEqual(await syncSent(DB, new Date("2026-10-23T08:25:00Z")), { firsts: 0, followups: 0, stopped: 0 });
  assert.equal((await getProspect(DB, "p1")).next_followup_at, null);     // never restarts
});

test("syncSent: a stopped lead's follow-up that went anyway never books another", async () => {
  const DB = fakeD1();
  // They replied (stage replied) while step 2 was being sent.
  await seedEmailed(DB, "p1", { stage: "replied", followup_step: 1 });
  await insertMessage(DB, { id: "f2", place_id: "p1", kind: "followup", step: 2, status: "sent", sent_at: "2026-10-24T08:15:00Z" });
  await syncSent(DB, new Date("2026-10-24T08:20:00Z"));
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.stage, p.next_followup_at], ["replied", null]);
});

test("syncSent: Claude's replies, system mail and inbound mail are never follow-ups; an old step never counts again", async () => {
  // Follow-up 2 is queued (so next_followup_at is NULL) while other mail in the thread goes and comes.
  const DB = fakeD1();
  await seedEmailed(DB, "p1", { followup_step: 1 });
  await insertMessage(DB, { place_id: "p1", kind: "first", status: "sent", sent_at: FIRST, message_id: "<root-p1@aetoswebsites.com>" });
  await insertMessage(DB, { place_id: "p1", kind: "followup", step: 1, status: "sent", sent_at: "2026-10-23T08:15:00Z" });
  await insertMessage(DB, { place_id: "p1", kind: "reply", author: "claude", status: "sent", sent_at: "2026-10-23T10:00:00Z" });
  await insertMessage(DB, { place_id: "p1", kind: "system", status: "sent", sent_at: "2026-10-23T10:01:00Z" });
  await inbound(DB, "p1", "auto", "2026-10-23T10:02:00Z");               // an out-of-office to follow-up 1
  await insertMessage(DB, { id: "f2", place_id: "p1", kind: "followup", step: 2, status: "queued", due_at: "2026-10-24T08:15:00Z" });
  const now = new Date("2026-10-23T10:05:00Z");
  assert.deepEqual(await syncSent(DB, now), { firsts: 0, followups: 0, stopped: 0 });
  let p = await getProspect(DB, "p1");
  assert.deepEqual([p.followup_step, p.next_followup_at, p.updated_at], [1, null, SEED_AT]);
  // Once follow-up 2 has gone, it (and only it) books follow-up 3.
  await DB.prepare("UPDATE messages SET status = 'sent', sent_at = '2026-10-24T08:15:00Z' WHERE id = 'f2'").run();
  assert.deepEqual(await syncSent(DB, new Date("2026-10-24T08:20:00Z")), { firsts: 0, followups: 1, stopped: 0 });
  p = await getProspect(DB, "p1");
  assert.deepEqual([p.followup_step, p.next_followup_at], [2, "2026-10-26T09:15:00Z"]);
});

test("syncSent: firsts before follow-ups, oldest first, at most `limit`", async () => {
  const DB = fakeD1();
  for (const [i, at] of ["2026-10-22T08:03:00Z", "2026-10-22T08:01:00Z", "2026-10-22T08:02:00Z"].entries()) {
    await seedReady(DB, `r${i}`);
    await insertMessage(DB, { place_id: `r${i}`, kind: "first", status: "sent", sent_at: at, message_id: `<r${i}@x>` });
  }
  await seedEmailed(DB, "e1");
  await insertMessage(DB, { place_id: "e1", kind: "followup", step: 1, status: "sent", sent_at: "2026-10-22T07:59:00Z" });
  const now = new Date("2026-10-22T08:10:00Z");
  assert.deepEqual(await syncSent(DB, now, { limit: 2 }), { firsts: 2, followups: 0, stopped: 0 });
  const stages = async () => Promise.all(["r0", "r1", "r2", "e1"].map(async (id) => (await getProspect(DB, id)).stage));
  assert.deepEqual(await stages(), ["ready", "emailed", "emailed", "emailed"]);
  assert.equal((await getProspect(DB, "e1")).followup_step, 0);
  assert.deepEqual(await syncSent(DB, now, { limit: 2 }), { firsts: 1, followups: 1, stopped: 0 });
  assert.equal((await getProspect(DB, "e1")).followup_step, 1);
  assert.deepEqual(await syncSent(DB, now, { limit: 0 }), { firsts: 0, followups: 0, stopped: 0 });
  await assert.rejects(syncSent(DB, now, { limit: -1 }), { name: "TypeError", message: /limit/ });
});

test("syncSent: D1 queries counted, and maxQueries is never passed", async () => {
  const seed = async () => {
    const DB = fakeD1(); await seedReady(DB, "p1"); await seedEmailed(DB, "e1");
    await insertMessage(DB, { place_id: "p1", kind: "first", status: "sent", sent_at: FIRST, message_id: "<a@x>" });
    await insertMessage(DB, { place_id: "e1", kind: "followup", step: 1, status: "sent", sent_at: "2026-10-23T08:15:00Z" });
    return DB;
  };
  const now = new Date("2026-10-23T08:20:00Z");
  // The read; the sender's name; first_sent (read + write) and the first's batch of 2; the follow-up's batch of 2.
  let counted = countingDB(await seed());
  assert.deepEqual(await syncSent(counted.DB, now), { firsts: 1, followups: 1, stopped: 0 });
  assert.equal(counted.used(), 8);
  // 7 allowed: the first email (6), and the follow-up waits for the next run.
  const DB = await seed();
  counted = countingDB(DB);
  assert.deepEqual(await syncSent(counted.DB, now, { maxQueries: 7 }), { firsts: 1, followups: 0, stopped: 0 });
  assert.equal(counted.used(), 6);
  counted = countingDB(DB);
  assert.deepEqual(await syncSent(counted.DB, now, { maxQueries: 0 }), { firsts: 0, followups: 0, stopped: 0 });
  assert.equal(counted.used(), 0);
  assert.deepEqual(await syncSent(DB, now, { maxQueries: 3 }), { firsts: 0, followups: 1, stopped: 0 });
});

// ---------------------------------------------------------------- sweepStops

test("sweepStops: every stop rule, and what it leaves alone", async () => {
  const DB = fakeD1();
  const next = "2026-10-26T09:15:00Z";
  await seedEmailed(DB, "a", { stage: "replied", next_followup_at: next });
  await seedEmailed(DB, "b", { stage: "needs_nik", followup_step: 2 });
  await insertMessage(DB, { id: "b3", place_id: "b", kind: "followup", step: 3, status: "queued", due_at: next });
  await seedEmailed(DB, "c", { next_followup_at: next });                 // nothing from them
  await seedEmailed(DB, "d", { stage: "viewed", next_followup_at: next });
  await inbound(DB, "d", "auto", "2026-10-23T08:20:00Z");                 // out of office
  await seedEmailed(DB, "e", { next_followup_at: next });
  await inbound(DB, "e", "human", "2026-10-21T08:00:00Z");                // before the first email
  await seedEmailed(DB, "f", { next_followup_at: next });
  await inbound(DB, "f", "human", "2026-10-23T09:00:00Z");                // a reply
  await seedEmailed(DB, "g", { stage: "replied" });                        // already stopped
  await seedEmailed(DB, "h", { stage: "call_booked", next_followup_at: next });
  await seedEmailed(DB, "i", { next_followup_at: next });
  await inbound(DB, "i", "bounce", null);                                  // no time: counts
  await seedReady(DB, "r");                                                // not emailed yet
  const now = new Date("2026-10-25T10:00:00Z");

  assert.equal(await sweepStops(DB, now), 5);                              // a, b, f, h, i
  for (const id of ["a", "b", "f", "h", "i"]) assert.equal((await getProspect(DB, id)).next_followup_at, null, id);
  for (const id of ["c", "d", "e"]) assert.equal((await getProspect(DB, id)).next_followup_at, next, id);
  const b3 = await messageOf(DB, "b3");
  assert.deepEqual([b3.status, b3.error], ["cancelled", "Stopped: stage:needs_nik"]);
  assert.equal((await getProspect(DB, "g")).updated_at, SEED_AT);         // nothing to stop: not touched
  assert.equal(await sweepStops(DB, now), 0);
});

test("sweepStops: at most `limit` a run; the rest get their turn", async () => {
  const DB = fakeD1();
  for (let i = 0; i < 12; i++) await seedEmailed(DB, `s${String(i).padStart(2, "0")}`, { stage: "replied", next_followup_at: "2026-10-26T09:15:00Z" });
  for (let i = 0; i < 5; i++) await seedEmailed(DB, `k${i}`, { next_followup_at: "2026-10-26T09:15:00Z" }); // still going
  const now = new Date("2026-10-25T10:00:00Z");
  assert.equal(await sweepStops(DB, now), 10);
  assert.equal(await sweepStops(DB, now), 2);
  assert.equal(await sweepStops(DB, now), 0);
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM prospects WHERE next_followup_at IS NOT NULL"), 5);
  assert.equal(await sweepStops(DB, now, { limit: 0 }), 0);
  await assert.rejects(sweepStops(DB, now, { limit: 1.5 }), { name: "TypeError", message: /limit/ });
});

test("sweepStops: one read, then 2 D1 queries a lead, never over maxQueries", async () => {
  const DB = fakeD1();
  for (const id of ["a", "b", "c"]) await seedEmailed(DB, id, { stage: "replied", next_followup_at: "2026-10-26T09:15:00Z" });
  const now = new Date("2026-10-25T10:00:00Z");
  let counted = countingDB(DB);
  assert.equal(await sweepStops(counted.DB, now, { maxQueries: 6 }), 2);
  assert.equal(counted.used(), 5);
  counted = countingDB(DB);
  assert.equal(await sweepStops(counted.DB, now), 1);
  assert.equal(counted.used(), 3);
  counted = countingDB(DB);
  assert.equal(await sweepStops(counted.DB, now), 0);
  assert.equal(counted.used(), 1);
});

// ---------------------------------------------------------------- the close time

test("closeTime is 7 UK days after follow-up 9, at the same UK clock time", () => {
  assert.equal(closeTime("2026-12-21T09:15:00Z").toISOString(), "2026-12-28T09:15:00.000Z");
  assert.equal(closeTime("2026-10-19T08:15:00Z").toISOString(), "2026-10-26T09:15:00.000Z"); // 09:15 BST → 09:15 GMT
  assert.equal(closeTime("2026-12-21T09:15:30Z").toISOString(), "2026-12-28T09:15:30.000Z");
  assert.throws(() => closeTime("later"), /date/);
});

// ================================================================ Task 8: the followups tick step

const ROOT = "<root@aetoswebsites.com>";
const INTERRUPTED = `${INTERRUPTED_PREFIX}. ${MAYBE_SENT}`; // stage 0's error for a row stuck in `sending`
// The landscaper look approved, as Nik does on the Demo page, so stage 4's real demoReady says ok.
const approveLook = (DB) => approveTemplate(DB, "landscaper", 1, SEED_AT);
// A lead emailed at FIRST (Thu 22 Oct 09:15 BST) whose next follow-up (step followup_step + 1) is due at `next`:
// "GREEN LEAF LANDSCAPES LTD - Landscaper in Warrington", owner Mark, writing from cold mailbox m1 (display_name
// "Nik Example"; business:sender_name "Nik"), subject "Your website", its first email sent with Message-ID `root`,
// and a live demo at https://aetoswebsites.com/d/<slug>.
async function seedDue(DB, place_id, next, o = {}) {
  const { root = ROOT, slug = `green-leaf-${place_id}`, name = "GREEN LEAF LANDSCAPES LTD - Landscaper in Warrington", ...p } = o;
  await seedLead(DB, { place_id, name, trade: "landscaper" });
  await seedDemo(DB, { place_id, slug });
  await seedReady(DB, place_id, { stage: "emailed", email: "mark@greenleaf.co.uk", first_sent_at: FIRST, root_message_id: root,
    followup_step: 0, next_followup_at: next, ...p });
  await insertMessage(DB, { place_id, kind: "first", status: "sent", message_id: root, due_at: FIRST, sent_at: FIRST });
}
// The plan's helpers: one due lead (the look approved), and n due leads with next_followup_at a minute apart.
async function dueLead(place_id, next, o = {}) {
  const DB = fakeD1();
  await seedDue(DB, place_id, next, o);
  await approveLook(DB);
  return DB;
}
async function manyDue(n) {
  const DB = fakeD1();
  for (let i = 0; i < n; i++) {
    const id = `d${String(i).padStart(2, "0")}`;
    await seedDue(DB, id, iso(new Date(Date.parse("2026-10-23T07:00:00Z") + i * 60000)), { root: `<root-${id}@aetoswebsites.com>` });
  }
  await approveLook(DB);
  return DB;
}
// Nik approves all 9 follow-up emails on the Voice page.
async function approveAll(DB) {
  await ensureTemplates(DB);
  await DB.prepare("UPDATE followup_templates SET status = 'approved', approved_at = ?1").bind(SEED_AT).run();
}
const okDemo = async (DB, place_id) => ({ ok: true, reason: "", url: `https://aetoswebsites.com/d/stub-${place_id}`, slug: `stub-${place_id}` });
const followupsOf = (DB, place_id) => DB.prepare("SELECT * FROM messages WHERE kind = 'followup' AND place_id = ? ORDER BY step, due_at")
  .bind(place_id).all().then((r) => r.results);
const openTodo = (DB, dedupe) => DB.prepare("SELECT * FROM todos WHERE dedupe = ? AND status = 'open'").bind(dedupe).first();

// ---------------------------------------------------------------- the plan's tests (Part B, Task 8, Step 1)

test("nothing queued until all 9 approved; setup todo added", async () => {
  const DB = await dueLead("p1", "2026-10-23T08:15:00Z");               // emailed, step 0, next_followup_at in the past
  const out = await followupsStep({ DB, env: {}, now: new Date("2026-10-23T08:20:00Z") });
  assert.equal(out, "waiting: follow-ups 0/9 approved");
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM messages WHERE kind='followup'").first()).n, 0);
  assert.ok(await DB.prepare("SELECT 1 FROM todos WHERE dedupe='setup:followups' AND status='open'").first());
});

test("queues a threaded follow-up 1", async () => {
  const DB = await dueLead("p1", "2026-10-23T08:15:00Z"); await approveAll(DB);
  await followupsStep({ DB, env: {}, now: new Date("2026-10-23T08:20:00Z") });
  const m = await DB.prepare("SELECT * FROM messages WHERE kind='followup'").first();
  assert.equal(m.step, 1); assert.equal(m.subject, "Re: Your website"); assert.equal(m.mailbox_id, "m1");
  assert.equal(m.in_reply_to, "<root@aetoswebsites.com>"); assert.equal(m.refs, "<root@aetoswebsites.com>");
  assert.match(m.body, /^Hi Mark,\n\nIn case my last email got buried: I made a new website for Green Leaf Landscapes/);
  assert.ok(m.body.endsWith(coldFooter("Nik")));
  assert.equal((await getProspect(DB, "p1")).next_followup_at, null);
});

test("demo not ready holds the follow-up with a health todo", async () => {
  const DB = await dueLead("p1", "2026-10-23T08:15:00Z"); await approveAll(DB);
  const now = new Date("2026-10-23T08:20:00Z");
  const notReady = async () => ({ ok: false, url: null, slug: null, reason: "template not approved" });
  const out = await followupsStep({ DB, env: {}, now }, { demoReady: notReady });
  assert.equal(out, "synced 0, stopped 0, retried 0, closed 0, queued 0, on hold 1 (demo not available)");
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup'"), 0);
  const todo = await openTodo(DB, "health:followup-demo:p1");
  assert.equal(todo.kind, "health");
  assert.equal(todo.title, "Follow-ups to Green Leaf Landscapes are on hold: their demo isn't available (template not approved).");
  assert.equal(todo.place_id, "p1");
  assert.equal(todo.link, "/#/lead/p1");
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.next_followup_at, p.followup_step], ["2026-10-23T08:15:00Z", 0]); // it waits: never skipped
  // Still on hold next run: the same todo, no new one, and no insert spent on it.
  const counted = countingDB(DB);
  await followupsStep({ DB: counted.DB, env: {}, now: new Date("2026-10-23T08:25:00Z") }, { demoReady: notReady });
  assert.equal(counted.used(), 8);                                        // the 7 reads and the batched cleanup: no todo insert
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM todos WHERE substr(dedupe, 1, 21) = 'health:followup-demo:'"), 1);
  // The demo is back: queued with the step's own due time, and the todo closes (its dedupe freed).
  assert.equal(await followupsStep({ DB, env: {}, now: new Date("2026-10-23T08:30:00Z") }, { demoReady: okDemo }),
    "synced 0, stopped 0, retried 0, closed 0, queued 1");
  const [m] = await followupsOf(DB, "p1");
  assert.deepEqual([m.step, m.due_at, m.status], [1, "2026-10-23T08:15:00Z", "queued"]);
  assert.match(m.body, /https:\/\/aetoswebsites\.com\/d\/stub-p1/);
  assert.equal(await openTodo(DB, "health:followup-demo:p1"), null);
  const [closed] = await todoOf(DB, "health:followup-demo:p1@");
  assert.deepEqual([closed.status, closed.done_at], ["done", "2026-10-23T08:30:00Z"]);
});

test("a failed follow-up is retried next day, stopped after 3", async () => {
  // Step 1 failed on Fri 23 Oct (not a bounce, not interrupted): queueing it had cleared next_followup_at.
  const DB = await dueLead("p1", null); await approveAll(DB);
  const fail = (due_at) => insertMessage(DB, { place_id: "p1", kind: "followup", step: 1, status: "failed", due_at,
    error: "Namecheap refused the email: 550 mailbox unavailable" });
  await fail("2026-10-23T08:15:00Z");
  assert.equal(await retryFailed(DB, new Date("2026-10-23T08:20:00Z")), 1);
  let p = await getProspect(DB, "p1");
  assert.deepEqual([p.next_followup_at, p.followup_step, p.stage], ["2026-10-24T06:00:00Z", 0, "emailed"]); // Sat 07:00 BST
  // The retry is queued for then, and fails too (attempt 2): tried again on Monday (Sunday moves to Monday, now GMT).
  await followupsStep({ DB, env: {}, now: new Date("2026-10-24T06:00:00Z") }, { demoReady: okDemo });
  const queued = (await followupsOf(DB, "p1")).find((m) => m.status === "queued");
  assert.equal(queued.due_at, "2026-10-24T06:00:00Z");
  await DB.prepare("UPDATE messages SET status = 'failed', error = 'Namecheap refused the email: 550 mailbox unavailable' WHERE id = ?")
    .bind(queued.id).run();
  assert.equal(await retryFailed(DB, new Date("2026-10-24T06:05:00Z")), 1);
  assert.equal((await getProspect(DB, "p1")).next_followup_at, "2026-10-26T07:00:00Z");
  // Attempt 3 fails: the sequence stops and Nik gets the todo.
  await fail("2026-10-26T07:00:00Z");
  await DB.prepare("UPDATE prospects SET next_followup_at = NULL WHERE place_id = 'p1'").run();
  assert.equal(await retryFailed(DB, new Date("2026-10-26T07:05:00Z")), 1);
  p = await getProspect(DB, "p1");
  assert.deepEqual([p.next_followup_at, p.followup_step, p.stage], [null, 0, "emailed"]);
  const todo = await openTodo(DB, "health:followup-fail:p1");
  assert.equal(todo.kind, "health");
  assert.equal(todo.title, "Follow-ups to Green Leaf Landscapes keep failing: Namecheap refused the email: 550 mailbox unavailable");
  assert.equal(todo.detail, "Check the mailbox on Setup.");
  assert.equal(todo.place_id, "p1");
  // Stopped for good: later runs leave it alone (one read, nothing written) and nothing more is queued.
  const counted = countingDB(DB);
  assert.equal(await retryFailed(counted.DB, new Date("2026-10-26T07:10:00Z")), 0);
  assert.equal(counted.used(), 1);
  await followupsStep({ DB, env: {}, now: new Date("2026-10-27T07:10:00Z") }, { demoReady: okDemo });
  assert.equal((await followupsOf(DB, "p1")).filter((m) => m.status === "queued").length, 0);
  assert.equal((await getProspect(DB, "p1")).next_followup_at, null);
});

test("an interrupted send is never retried", async () => {
  const DB = await dueLead("p1", null, { followup_step: 1 }); await approveAll(DB);
  await insertMessage(DB, { place_id: "p1", kind: "followup", step: 1, status: "sent", message_id: "<f1@aetoswebsites.com>",
    due_at: "2026-10-23T08:15:00Z", sent_at: "2026-10-23T08:15:00Z" });
  await insertMessage(DB, { id: "f2", place_id: "p1", kind: "followup", step: 2, status: "failed", due_at: "2026-10-24T08:15:00Z",
    error: INTERRUPTED });
  const now = new Date("2026-10-24T08:40:00Z");
  assert.equal(await retryFailed(DB, now), 1);
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.next_followup_at, p.followup_step], [null, 1]);
  assert.deepEqual((await followupsOf(DB, "p1")).map((m) => m.status), ["sent", "failed"]); // no new queued row
  const todo = await openTodo(DB, "health:followup-fail:p1");
  assert.ok(todo.title.includes(INTERRUPTED), todo.title);
  assert.equal(todo.title, `Follow-ups to Green Leaf Landscapes stopped: ${INTERRUPTED}`);
  // A later run neither retries it nor queues it.
  await followupsStep({ DB, env: {}, now: new Date("2026-10-26T08:00:00Z") }, { demoReady: okDemo });
  assert.deepEqual((await followupsOf(DB, "p1")).map((m) => m.status), ["sent", "failed"]);
});

test("step 9 + 7 days → lost/sequence_done", async () => {
  const DB = await dueLead("p1", "2026-12-28T09:15:00Z", { followup_step: 9 }); await approveAll(DB);
  const before = await followupsStep({ DB, env: {}, now: new Date("2026-12-28T09:10:00Z") }, { demoReady: okDemo });
  assert.equal(before, "synced 0, stopped 0, retried 0, closed 0, queued 0");
  assert.equal((await getProspect(DB, "p1")).stage, "emailed");
  const out = await followupsStep({ DB, env: {}, now: new Date("2026-12-28T09:15:00Z") }, { demoReady: okDemo });
  assert.equal(out, "synced 0, stopped 0, retried 0, closed 1, queued 0");
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.stage, p.lost_reason, p.next_followup_at, p.stage_at], ["lost", "sequence_done", null, "2026-12-28T09:15:00Z"]);
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup'"), 0); // a 10th never goes
});

test("bounded work: 40 due leads, ≤ 18 D1 queries, 3 queued", async () => {
  const DB = await manyDue(40); await approveAll(DB);
  const now = new Date("2026-10-23T08:20:00Z");
  const c = countingDB(DB);                                              // stage 0's _lib/d1count.js → {DB, used}
  await followupsStep({ DB: c.DB, env: {}, now });
  assert.ok(c.used() <= 18, `used ${c.used()}`);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM messages WHERE kind='followup'").first()).n, 3);
});

test("a smaller tick budget is respected", async () => {
  const DB = await manyDue(40); await approveAll(DB);
  const c = countingDB(DB);
  await followupsStep({ DB: c.DB, env: {}, now: new Date("2026-10-23T08:20:00Z"), budget: { left: () => 12 } });
  assert.ok(c.used() <= 12, `used ${c.used()}`);
});

// ---------------------------------------------------------------- queueDue

test("queueDue: the whole follow-up, in the thread, from the thread's mailbox, signed with business:sender_name", async () => {
  const DB = await dueLead("p1", "2026-10-23T08:15:00Z"); await approveAll(DB);
  assert.deepEqual(await queueDue(DB, new Date("2026-10-23T08:20:00Z")), { queued: 1, held: null, approved: 9, waiting: 0, problems: [] });
  const [m] = await followupsOf(DB, "p1");
  assert.deepEqual([m.direction, m.kind, m.step, m.author, m.status, m.to_addr, m.from_addr, m.due_at],
    ["out", "followup", 1, "system", "queued", "mark@greenleaf.co.uk", "m1@aetoswebsites.com", "2026-10-23T08:15:00Z"]);
  assert.equal(m.body, [
    "Hi Mark,", "",
    "In case my last email got buried: I made a new website for Green Leaf Landscapes and it's ready to look at.", "",
    "https://aetoswebsites.com/d/green-leaf-p1", "",
    "It takes a minute on your phone.", "",
    coldFooter("Nik"),
  ].join("\n"));
  assert.ok(!m.body.includes("Nik Example"));                            // the mailbox's display_name is only the From line
  assert.match(m.message_id, /^<[0-9a-f-]{36}@aetoswebsites\.com>$/);
  assert.notEqual(m.message_id, ROOT);
  // Nothing else changed on the lead; it isn't queued twice.
  const p = await getProspect(DB, "p1");
  assert.deepEqual([p.stage, p.followup_step, p.next_followup_at, p.updated_at], ["emailed", 0, null, "2026-10-23T08:20:00Z"]);
  assert.deepEqual(await queueDue(DB, new Date("2026-10-23T08:25:00Z")), { queued: 0, held: null, approved: 9, waiting: 0, problems: [] });
});

test("queueDue: References grow with the follow-ups sent; Hi, with no confident name; the wording at the moment it's queued", async () => {
  const DB = await dueLead("p1", "2026-10-26T09:15:00Z", { followup_step: 2, greet_name: null, stage: "viewed" });
  await approveAll(DB);
  await insertMessage(DB, { place_id: "p1", kind: "followup", step: 2, status: "sent", message_id: "<f2@aetoswebsites.com>",
    due_at: "2026-10-24T08:15:00Z", sent_at: "2026-10-24T08:15:00Z" });
  await insertMessage(DB, { place_id: "p1", kind: "followup", step: 1, status: "sent", message_id: "<f1@aetoswebsites.com>",
    due_at: "2026-10-23T08:15:00Z", sent_at: "2026-10-23T08:15:00Z" });
  await insertMessage(DB, { place_id: "p1", kind: "reply", status: "sent", message_id: "<claude@aetoswebsites.com>", sent_at: "2026-10-23T10:00:00Z" });
  await insertMessage(DB, { place_id: "p1", kind: "followup", step: 1, status: "failed", message_id: "<f1-failed@aetoswebsites.com>",
    due_at: "2026-10-22T08:15:00Z" });
  // Nik edited step 3 and approved it again before it was queued.
  await DB.prepare("UPDATE followup_templates SET body = ?1 WHERE step = 3").bind("{greeting}\n\nOne more look for {business}: {demo_link}").run();
  assert.equal((await queueDue(DB, new Date("2026-10-26T09:20:00Z"), { demoReady: okDemo })).queued, 1);
  const m = (await followupsOf(DB, "p1")).find((x) => x.step === 3);
  assert.equal(m.in_reply_to, ROOT);
  assert.equal(m.refs, `${ROOT} <f1@aetoswebsites.com> <f2@aetoswebsites.com>`);
  assert.equal(m.body, `Hi,\n\nOne more look for Green Leaf Landscapes: https://aetoswebsites.com/d/stub-p1\n\n${coldFooter("Nik")}`);
});

test("queueDue: only emailed and viewed leads that are due, with follow-ups left", async () => {
  const DB = fakeD1(); await approveAll(DB);
  const now = new Date("2026-10-23T08:20:00Z");
  await seedDue(DB, "due", "2026-10-23T08:15:00Z");
  await seedDue(DB, "later", "2026-10-23T08:21:00Z");                    // not due yet
  await seedDue(DB, "replied", "2026-10-23T08:15:00Z", { stage: "replied" });
  await seedDue(DB, "lost", "2026-10-23T08:15:00Z", { stage: "lost", lost_reason: "not_now" });
  await seedDue(DB, "ready", "2026-10-23T08:15:00Z", { stage: "ready" });
  await seedDue(DB, "stopped", null);
  await seedDue(DB, "closing", "2026-10-23T08:15:00Z", { followup_step: 9 }); // its next_followup_at is the close time
  assert.equal((await queueDue(DB, now, { demoReady: okDemo })).queued, 1);
  assert.deepEqual((await DB.prepare("SELECT place_id FROM messages WHERE kind = 'followup'").all()).results, [{ place_id: "due" }]);
});

test("queueDue: at most 3 a run, oldest first; leads on hold for their demo go after the rest", async () => {
  const DB = fakeD1(); await approveAll(DB);
  for (const [id, next] of [["h1", "2026-10-23T07:00:00Z"], ["h2", "2026-10-23T07:01:00Z"], ["h3", "2026-10-23T07:02:00Z"],
    ["a", "2026-10-23T08:03:00Z"], ["b", "2026-10-23T08:01:00Z"], ["c", "2026-10-23T08:02:00Z"], ["d", "2026-10-23T08:04:00Z"]]) {
    await seedDue(DB, id, next, { root: `<root-${id}@aetoswebsites.com>` });
  }
  for (const id of ["h1", "h2", "h3"]) {
    await addTodo(DB, { kind: "health", title: `Follow-ups to ${id} are on hold`, place_id: id, dedupe: `health:followup-demo:${id}` });
  }
  const seen = [];
  const demo = async (q, place_id) => (seen.push(place_id), place_id.startsWith("h")
    ? { ok: false, reason: "Their demo has expired: a new one is being made", url: null, slug: null } : okDemo(q, place_id));
  const now = new Date("2026-10-23T08:20:00Z");
  assert.deepEqual(await queueDue(DB, now, { demoReady: demo }), { queued: 3, held: null, approved: 9, waiting: 0, problems: [] });
  assert.deepEqual(seen, ["b", "c", "a"]);
  assert.deepEqual(await queueDue(DB, now, { demoReady: demo }), { queued: 1, held: "demo", approved: 9, waiting: 3, problems: [] });
  assert.deepEqual(seen.slice(3), ["d", "h1", "h2", "h3"]);
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM todos WHERE substr(dedupe, 1, 21) = 'health:followup-demo:'"), 3);
  await assert.rejects(queueDue(DB, now, { limit: -1 }), { name: "TypeError", message: /limit/ });
});

test("queueDue: a lead whose booking changed while it was being queued gets nothing queued", async () => {
  const DB = await dueLead("p1", "2026-10-23T08:15:00Z"); await approveAll(DB);
  // While the demo is being checked, they reply and the inbound step stops the sequence.
  const racing = async (q, place_id) => {
    await stopFollowups(DB, place_id, "replied", "2026-10-23T08:20:00Z");
    return okDemo(q, place_id);
  };
  assert.equal((await queueDue(DB, new Date("2026-10-23T08:20:00Z"), { demoReady: racing })).queued, 0);
  const [m] = await followupsOf(DB, "p1");
  assert.equal(m.status, "cancelled");                                     // never left queued for the send step
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup' AND status = 'queued'"), 0);
});

test("queueDue: a lead whose email can't be written is reported, stopped with a todo, and the others still go", async () => {
  const DB = fakeD1(); await approveAll(DB);
  await seedDue(DB, "a", "2026-10-23T08:10:00Z", { name: " - Landscaper in Warrington", root: "<root-a@aetoswebsites.com>" }); // no business name left
  await seedDue(DB, "b", "2026-10-23T08:11:00Z", { root: "<root-b@aetoswebsites.com>" });
  const out = await queueDue(DB, new Date("2026-10-23T08:20:00Z"), { demoReady: okDemo });
  assert.equal(out.queued, 1);
  assert.deepEqual(out.problems.map((x) => x.place_id), ["a"]);
  assert.match(out.problems[0].error, /business name/);
  // It can never be written, so it stops (as a follow-up that keeps failing does) rather than take a slot every run.
  assert.equal((await getProspect(DB, "a")).next_followup_at, null);
  assert.equal((await followupsOf(DB, "a")).length, 0);
  const todo = await openTodo(DB, "health:followup-fail:a");
  assert.equal(todo.kind, "health");
  assert.equal(todo.place_id, "a");
  assert.equal(todo.link, "/#/lead/a");
  assert.match(todo.title, /^Follow-ups to the lead a stopped: the next one couldn't be written \(.*business name.*\)\.$/);
  assert.match(todo.detail, /email them yourself/);
  // A lead with no subject, found by the tick step: it says so once (the run throws, naming it), never again.
  await seedDue(DB, "c", "2026-10-23T08:12:00Z", { subject: "", root: "<root-c@aetoswebsites.com>" });
  await assert.rejects(followupsStep({ DB, env: {}, now: new Date("2026-10-23T08:25:00Z") }, { demoReady: okDemo }),
    (e) => /couldn't queue the follow-up for 1 lead \(c: it has no subject to reply under\)/.test(e.message)
      && /stopped/.test(e.message) && /Done: synced 0/.test(e.message));
  assert.match((await openTodo(DB, "health:followup-fail:c")).title, /^Follow-ups to Green Leaf Landscapes stopped: the next one couldn't be written \(it has no subject to reply under\)\.$/);
  assert.equal(await followupsStep({ DB, env: {}, now: new Date("2026-10-23T08:30:00Z") }, { demoReady: okDemo }),
    "synced 0, stopped 0, retried 0, closed 0, queued 0");
});

// Found in review: stage 1's "Reset leads" workflow deletes the leads but keeps prospects and messages (02-find.md),
// so an emailed prospect can lose its lead row. Its follow-up can't name the business, and the step threw on every
// run; 10 such leads, always the first 10 due rows read, stopped everyone's follow-ups for good.
test("follow-ups to a lead that Reset leads removed are on hold; they never block the others, and start again if it's found again", async () => {
  const DB = await manyDue(40); await approveAll(DB);
  const gone = Array.from({ length: 10 }, (_, i) => `d${String(i).padStart(2, "0")}`);
  await DB.prepare(`DELETE FROM leads WHERE place_id IN (${gone.map(() => "?").join(", ")})`).bind(...gone).run();
  const start = Date.parse("2026-10-23T08:20:00Z");
  const queuedNow = () => countOf(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup' AND status = 'queued'");
  const counts = [];
  for (let run = 0; run < 5; run++) {
    const before = await queuedNow();
    const out = await followupsStep({ DB, env: {}, now: new Date(start + run * 300000) }); // stage 4's real demoReady
    assert.match(out, /^synced 0, stopped 0, retried 0, closed 0, queued \d/, `run ${run}`);
    counts.push((await queuedNow()) - before);
  }
  assert.deepEqual(counts, [0, 3, 3, 3, 3]); // the first run puts the 10 on hold, then 3 a run from d10 on
  for (const id of gone) {
    const todo = await openTodo(DB, `health:followup-demo:${id}`);
    assert.ok(todo, `${id}: on hold, with a todo`);
    assert.equal(todo.kind, "health");
    assert.equal(todo.title, "Follow-ups to mark@greenleaf.co.uk are on hold: the lead isn't in the Control Room any more "
      + "(Reset leads removed it). They start again if the lead is found again.");
    assert.equal(todo.link, `/#/lead/${id}`);
    assert.equal((await followupsOf(DB, id)).length, 0, id);
    assert.ok((await getProspect(DB, id)).next_followup_at, `${id}: still booked`);
  }
  const queuedIds = (await DB.prepare("SELECT place_id FROM messages WHERE kind = 'followup' ORDER BY place_id").all()).results
    .map((r) => r.place_id);
  assert.deepEqual(queuedIds, Array.from({ length: 12 }, (_, i) => `d${String(i + 10).padStart(2, "0")}`));
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM todos WHERE substr(dedupe, 1, 21) = 'health:followup-demo:'"), 10);
  // A later search finds d00 again (same place_id): once the leads really due have gone (those on hold sort last), its
  // follow-up goes, written for its name, and its hold todo closes; d01–d09 stay on hold.
  await seedLead(DB, { place_id: "d00", name: "GREEN LEAF LANDSCAPES LTD - Landscaper in Warrington", trade: "landscaper" });
  let run = 5;
  while (!(await followupsOf(DB, "d00")).length && run < 15) await followupsStep({ DB, env: {}, now: new Date(start + run++ * 300000) });
  const [m] = await followupsOf(DB, "d00");
  assert.ok(m, "d00's follow-up was queued once it was found again");
  assert.deepEqual([m.step, m.status], [1, "queued"]);
  assert.match(m.body, /a new website for Green Leaf Landscapes/);
  assert.equal(await openTodo(DB, "health:followup-demo:d00"), null);
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup' AND place_id IN ('d01', 'd09')"), 0);
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM todos WHERE status = 'open' AND substr(dedupe, 1, 21) = 'health:followup-demo:'"), 9);
});

// Found in review: a first email still queued whose lead a later search sets aside (Part A, "Set aside after Send") is
// held by the outbox for good, and nothing cancels it. It booked a place on its day and its 9 follow-up days in every
// plan (and "1 first email waiting to go" on the Leads banner), and nothing told Nik. It stays held (Nik cancels it), but
// the plan leaves it out and Nik gets a todo.
async function heldFirst(DB, place_id, due_at, lead = {}) {
  await seedLead(DB, { place_id, name: "GREEN LEAF LANDSCAPES LTD - Landscaper in Warrington", trade: "landscaper", ...lead });
  await seedResearch(DB, { place_id });
  await seedDemo(DB, { place_id });
  await seedProspect(DB, { place_id, stage: "ready", mailbox_id: "m1", email: `${place_id}@greenleaf.co.uk`, subject: "Your website" });
  return insertMessage(DB, { id: `first-${place_id}`, place_id, kind: "first", status: "queued", due_at });
}

test("a queued first email whose lead was set aside takes no place in the plan, and Nik gets a todo until it's gone", async () => {
  const DB = fakeD1(); await approveAll(DB);
  await insertMailbox(DB, { id: "m1", cap_override: 10 });
  const now = new Date("2026-10-22T10:00:00Z"); // Thu 11:00 BST
  await heldFirst(DB, "x1", "2026-10-22T08:00:00Z", { excluded: 1, exclude_reason: "Duplicate listing of Green Leaf Ltd" });
  await heldFirst(DB, "ok1", "2026-10-26T06:00:00Z"); // a ready lead's, queued for Monday 07:00: it still counts
  await setSetting(DB, "business:sender_name", "Nik");

  const room = await roomForFirsts(DB, now);
  assert.equal(room.total, 9);                                           // ok1's Monday (and its follow-ups) only
  await DB.prepare("UPDATE messages SET status = 'cancelled' WHERE id = 'first-ok1'").run();
  assert.equal((await roomForFirsts(DB, now)).total, 10);
  const c = await capacityNow(DB, now);
  assert.equal(c.room, 10);
  assert.equal(c.firstQueued, 0);                                        // the banner's "waiting to go" ignores it too
  const plan = await planningRows(DB, now);
  assert.deepEqual([plan.cold.length, plan.sequences.length], [0, 0]);

  // The tick's followups step: a todo once it has been held for more than an hour, then left as it is.
  await followupsStep({ DB, env: {}, now }, { demoReady: okDemo });
  const todo = await openTodo(DB, "health:first-held:x1");
  assert.ok(todo, "a todo for the held first email");
  assert.equal(todo.kind, "health");
  assert.equal(todo.place_id, "x1");
  assert.equal(todo.link, "/#/lead/x1");
  assert.equal(todo.title, "Your first email to Green Leaf Landscapes is on hold: a later search set it aside "
    + "(Duplicate listing of Green Leaf Ltd). Open the lead to cancel it.");
  await followupsStep({ DB, env: {}, now: new Date("2026-10-22T10:05:00Z") }, { demoReady: okDemo });
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM todos WHERE substr(dedupe, 1, 18) = 'health:first-held:'"), 1);
  assert.equal((await messageOf(DB, "first-x1")).status, "queued");      // never cancelled for him

  // Nik cancels it from the thread: the todo closes on the next run.
  await DB.prepare("UPDATE messages SET status = 'cancelled' WHERE id = 'first-x1'").run();
  await followupsStep({ DB, env: {}, now: new Date("2026-10-22T10:10:00Z") }, { demoReady: okDemo });
  assert.equal(await openTodo(DB, "health:first-held:x1"), null);
  const [closed] = await todoOf(DB, "health:first-held:x1@");
  assert.equal(closed.status, "done");
});

test("a held first email: a short wait raises nothing, each reason is named, and the todo closes once the lead is ready again", async () => {
  const DB = fakeD1(); await approveAll(DB);
  await insertMailbox(DB, { id: "m1", cap_override: 10 });
  await setSetting(DB, "business:sender_name", "Nik");
  const now = new Date("2026-10-22T10:00:00Z");
  await heldFirst(DB, "soon", "2026-10-22T09:30:00Z", { excluded: 1, exclude_reason: "Multiple branches (chain)" }); // 30 min
  await heldFirst(DB, "big", "2026-10-22T08:00:00Z");
  await DB.prepare("UPDATE research SET too_big = 1 WHERE place_id = 'big'").run();
  await heldFirst(DB, "old", "2026-10-22T08:00:00Z");
  await DB.prepare("UPDATE demos SET expires_at = '2026-10-21T00:00:00Z' WHERE place_id = 'old'").run();
  await heldFirst(DB, "gone", "2026-10-22T08:00:00Z");
  await DB.prepare("DELETE FROM leads WHERE place_id = 'gone'").run();     // Reset leads
  await heldFirst(DB, "fine", "2026-10-22T08:00:00Z");                    // waiting on its mailbox, not on its lead
  await followupsStep({ DB, env: {}, now }, { demoReady: okDemo });
  const open = (await DB.prepare("SELECT dedupe, title FROM todos WHERE status = 'open' AND substr(dedupe, 1, 18) = 'health:first-held:' ORDER BY dedupe").all()).results;
  assert.deepEqual(open, [
    { dedupe: "health:first-held:big", title: "Your first email to Green Leaf Landscapes is on hold: Claude's research says it's too big for us. Open the lead to cancel it." },
    { dedupe: "health:first-held:gone", title: "Your first email to gone@greenleaf.co.uk is on hold: the lead isn't in the Control Room any more (Reset leads removed it). Open the lead to cancel it." },
    { dedupe: "health:first-held:old", title: "Your first email to Green Leaf Landscapes is on hold: its demo site has expired. Open the lead to cancel it." },
  ]);
  // The lead is ready again (a new demo): the todo closes and the email goes as normal.
  await seedDemo(DB, { place_id: "old" });
  await followupsStep({ DB, env: {}, now: new Date("2026-10-22T10:05:00Z") }, { demoReady: okDemo });
  assert.equal(await openTodo(DB, "health:first-held:old"), null);
  assert.ok(await openTodo(DB, "health:first-held:big"));
  // An hour on, the short one is held long enough to be named too.
  await followupsStep({ DB, env: {}, now: new Date("2026-10-22T10:35:00Z") }, { demoReady: okDemo });
  assert.equal((await openTodo(DB, "health:first-held:soon")).title,
    "Your first email to Green Leaf Landscapes is on hold: a later search set it aside (Multiple branches (chain)). Open the lead to cancel it.");
});

// Found in review: a booking at 18:56–18:59 UK (A4's clamp) was first seen by the 19:00 tick and waited for the next
// sending day. The last run before the window ends (within 6 minutes of it) reaches up to its end, and queues those
// bookings for now, so the send step sends them before 19:00, a few minutes early, on their own A4 day.
test("queueDue: the last run before 19:00 UK queues the bookings up to the window's end, due at once", async () => {
  // Fri 23 Oct 2026 (BST: the window ends at 18:00Z). Bookings at 18:57 and 18:59 BST.
  const cases = [
    ["2026-10-23T17:50:00Z", null],   // 10 minutes before the end: not yet
    ["2026-10-23T17:53:59Z", null],   // just over 6 minutes: not yet
    ["2026-10-23T17:54:00Z", "now"],  // the last run before 19:00 on the 5-minute marks would be 18:55; this is 18:54
    ["2026-10-23T17:56:00Z", "now"],
    ["2026-10-23T17:59:30Z", "own"],  // both already due: queued as booked
    ["2026-10-23T18:00:00Z", "own"],  // 19:00: outside the window, both overdue, queued as booked (they go Saturday 07:00)
  ];
  for (const [now, due] of cases) {
    const DB = await dueLead("a", "2026-10-23T17:57:00Z"); await approveAll(DB);
    await seedDue(DB, "b", "2026-10-23T17:59:00Z", { root: "<root-b@aetoswebsites.com>" });
    const out = await queueDue(DB, new Date(now), { demoReady: okDemo });
    const rows = (await DB.prepare("SELECT place_id, due_at FROM messages WHERE kind = 'followup' ORDER BY place_id").all()).results;
    if (due === null) {
      assert.equal(out.queued, 0, now);
      assert.equal((await getProspect(DB, "a")).next_followup_at, "2026-10-23T17:57:00Z", now);
      continue;
    }
    assert.equal(out.queued, 2, now);
    assert.deepEqual(rows, due === "now"
      ? [{ place_id: "a", due_at: now }, { place_id: "b", due_at: now }]
      : [{ place_id: "a", due_at: "2026-10-23T17:57:00Z" }, { place_id: "b", due_at: "2026-10-23T17:59:00Z" }], now);
    assert.equal((await getProspect(DB, "b")).next_followup_at, null, now);
  }
  // A morning or a Sunday never reaches ahead: a run at 07:00 doesn't queue an 07:03 booking.
  const DB = await dueLead("m", "2026-10-24T06:03:00Z"); await approveAll(DB);
  assert.equal((await queueDue(DB, new Date("2026-10-24T06:00:00Z"), { demoReady: okDemo })).queued, 0);
});

test("queueDue: templates seeded on first use; waiting ones show how many are approved", async () => {
  const DB = await dueLead("p1", "2026-10-23T08:15:00Z");
  const now = new Date("2026-10-23T08:20:00Z");
  assert.deepEqual(await queueDue(DB, now), { queued: 0, held: "templates", approved: 0, waiting: 0, problems: [] });
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM followup_templates WHERE status = 'draft'"), 9);
  for (let step = 1; step <= 6; step++) await DB.prepare("UPDATE followup_templates SET status = 'approved' WHERE step = ?").bind(step).run();
  assert.equal(await followupsStep({ DB, env: {}, now }), "waiting: follow-ups 6/9 approved");
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'setup:followups'"), 1); // added once
});

// ---------------------------------------------------------------- retryFailed

test("retryFailed: only the latest attempt counts, a step still going isn't touched, and only emailed or viewed leads", async () => {
  const DB = fakeD1(); await approveLook(DB);
  const fail = (place_id, step, due_at, o = {}) => insertMessage(DB, { place_id, kind: "followup", step, status: "failed", due_at,
    error: "Timed out", ...o });
  // a: step 1 failed, then its retry is queued (in flight): nothing to do.
  await seedDue(DB, "a", null);
  await fail("a", 1, "2026-10-23T08:15:00Z");
  await insertMessage(DB, { place_id: "a", kind: "followup", step: 1, status: "queued", due_at: "2026-10-24T06:00:00Z" });
  // b: an old failure of step 1, but step 1 has since been sent and synced (step 2 is booked): nothing to do.
  await seedDue(DB, "b", "2026-10-24T08:15:00Z", { followup_step: 1 });
  await fail("b", 1, "2026-10-23T08:15:00Z");
  // c: replied, d: lost, while their failed step waited: stopped by the sweep's rules, never retried.
  await seedDue(DB, "c", null, { stage: "replied" });
  await fail("c", 1, "2026-10-23T08:15:00Z");
  await seedDue(DB, "d", null, { stage: "lost", lost_reason: "opt_out" });
  await fail("d", 1, "2026-10-23T08:15:00Z");
  // e: viewed, step 3 failed once: retried.
  await seedDue(DB, "e", null, { stage: "viewed", followup_step: 2 });
  await fail("e", 3, "2026-10-26T09:15:00Z");
  const now = new Date("2026-10-26T09:20:00Z"); // Mon
  assert.equal(await retryFailed(DB, now), 1);
  assert.equal((await getProspect(DB, "e")).next_followup_at, "2026-10-27T07:00:00Z");
  for (const id of ["a", "c", "d"]) assert.equal((await getProspect(DB, id)).next_followup_at, null, id);
  assert.equal((await getProspect(DB, "b")).next_followup_at, "2026-10-24T08:15:00Z");
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM todos"), 0);
  assert.equal(await retryFailed(DB, now, { limit: 0 }), 0);
  await assert.rejects(retryFailed(DB, now, { limit: "ten" }), { name: "TypeError", message: /limit/ });
});

test("retryFailed: a Saturday failure is retried Monday 07:00; the queries are 1 read and 1 per retry, 3 per stop", async () => {
  const DB = fakeD1(); await approveLook(DB);
  await seedDue(DB, "p1", null);
  await insertMessage(DB, { place_id: "p1", kind: "followup", step: 1, status: "failed", due_at: "2026-10-24T08:15:00Z", error: "Timed out" });
  await seedDue(DB, "p2", null);
  await insertMessage(DB, { place_id: "p2", kind: "followup", step: 1, status: "failed", due_at: "2026-10-24T08:15:00Z", error: INTERRUPTED });
  const counted = countingDB(DB);
  assert.equal(await retryFailed(counted.DB, new Date("2026-10-24T08:20:00Z")), 2);
  assert.equal(counted.used(), 1 + 1 + 3);
  assert.equal((await getProspect(DB, "p1")).next_followup_at, "2026-10-26T07:00:00Z"); // Sun → Mon, 07:00 GMT
  assert.ok(await openTodo(DB, "health:followup-fail:p2"));
  // maxQueries: a lead is only started when its queries fit.
  const again = fakeD1(); await approveLook(again);
  await seedDue(again, "p2", null);
  await insertMessage(again, { place_id: "p2", kind: "followup", step: 1, status: "failed", due_at: "2026-10-24T08:15:00Z", error: INTERRUPTED });
  const tight = countingDB(again);
  assert.equal(await retryFailed(tight.DB, new Date("2026-10-24T08:20:00Z"), { maxQueries: 3 }), 0);
  assert.equal(tight.used(), 1);
});

// ---------------------------------------------------------------- closeFinished

test("closeFinished: only at the close time; closes the follow-up todos of leads that have closed, exactly (p1, not p10)", async () => {
  const DB = fakeD1(); await approveLook(DB);
  await seedDue(DB, "p1", "2026-12-28T09:15:00Z", { followup_step: 9 });
  await seedDue(DB, "p2", "2026-12-28T09:16:00Z", { followup_step: 9 });   // a minute later
  await seedDue(DB, "p3", "2026-12-28T09:00:00Z", { followup_step: 8 });   // step 9 still to go
  await seedDue(DB, "p10", "2026-12-28T09:30:00Z", { followup_step: 4 });
  await seedDue(DB, "r1", null, { stage: "replied" });
  await seedDue(DB, "v1", null, { stage: "viewed" });
  const todo = (dedupe) => addTodo(DB, { kind: "health", title: dedupe, place_id: dedupe.split(":").pop(), dedupe });
  for (const d of ["health:followup-fail:p1", "health:followup-fail:p10", "health:followup-demo:p1", "health:followup-demo:p10",
    "health:followup-demo:r1", "health:followup-fail:r1", "health:followup-demo:v1", "health:followup-fail:v1"]) await todo(d);
  const now = new Date("2026-12-28T09:15:00Z");
  assert.equal(await closeFinished(DB, now), 1);
  assert.deepEqual(await Promise.all(["p1", "p2", "p3"].map(async (id) => (await getProspect(DB, id)).stage)), ["lost", "emailed", "emailed"]);
  // r1 replied (its demo hold can't be queued any more) and v1 is stopped (nothing booked): their holds closed on that
  // first run. The next run: p1 is lost now, so its todos close too. p10's, and the failing todos of open leads, stay.
  assert.equal(await closeFinished(DB, new Date("2026-12-28T09:16:00Z")), 1);
  const open = (await DB.prepare("SELECT dedupe FROM todos WHERE status = 'open' ORDER BY dedupe").all()).results.map((r) => r.dedupe);
  assert.deepEqual(open, ["health:followup-demo:p10", "health:followup-fail:p10", "health:followup-fail:r1", "health:followup-fail:v1"]);
  assert.equal((await getProspect(DB, "p2")).lost_reason, "sequence_done");
  const counted = countingDB(DB);
  assert.equal(await closeFinished(counted.DB, new Date("2026-12-28T09:20:00Z")), 0);
  assert.equal(counted.used(), 2);                                          // the cleanup and the read, in one batch
});

// ---------------------------------------------------------------- followupsStep and the tick

test("followupsStep: syncs, stops and queues in one run, and says what it did", async () => {
  const DB = await dueLead("p1", "2026-10-23T08:15:00Z"); await approveAll(DB);
  await seedDue(DB, "p2", null, { root: "<root-p2@aetoswebsites.com>" });   // follow-up 1 sent, not synced yet
  await insertMessage(DB, { place_id: "p2", kind: "followup", step: 1, status: "sent", message_id: "<f1-p2@aetoswebsites.com>",
    due_at: "2026-10-23T08:00:00Z", sent_at: "2026-10-23T08:00:00Z" });
  await seedDue(DB, "p3", "2026-10-23T08:10:00Z", { root: "<root-p3@aetoswebsites.com>" }); // replied before it went
  await inbound(DB, "p3", "human", "2026-10-23T07:30:00Z");
  const out = await followupsStep({ DB, env: {}, now: new Date("2026-10-23T08:20:00Z"), budget: { left: () => 40 } });
  assert.equal(out, "synced 1, stopped 1, retried 0, closed 0, queued 1");
  assert.equal((await getProspect(DB, "p2")).followup_step, 1);
  assert.equal((await getProspect(DB, "p3")).next_followup_at, null);
  assert.deepEqual((await DB.prepare("SELECT place_id FROM messages WHERE kind = 'followup' AND status = 'queued'").all()).results,
    [{ place_id: "p1" }]);
});

test("followupsStep: a budget too small for everything leaves the rest for the next run", async () => {
  const DB = await manyDue(5); await approveAll(DB);
  const c = countingDB(DB);
  const out = await followupsStep({ DB: c.DB, env: {}, now: new Date("2026-10-23T08:20:00Z"), budget: { left: () => 4 } });
  assert.equal(out, "synced 0, stopped 0, retried 0, closed 0, queued 0; out of D1 queries, the rest next run");
  assert.ok(c.used() <= 4, `used ${c.used()}`);
  await assert.rejects(followupsStep({ env: {}, now: new Date() }), { name: "TypeError", message: /database/ });
});

// ---------------------------------------------------------------- review additions (Task 8)

test("queueDue and closeFinished never act on a lead who wrote back while its stage doesn't show it yet; the sweep stops it", async () => {
  const DB = fakeD1(); await approveAll(DB); await approveLook(DB);
  const now = new Date("2026-12-28T09:20:00Z");
  await seedDue(DB, "human", "2026-12-28T09:15:00Z", { root: "<root-human@aetoswebsites.com>" });
  await inbound(DB, "human", "human", "2026-10-25T10:00:00Z");
  await seedDue(DB, "blank", "2026-12-28T09:15:00Z", { root: "<root-blank@aetoswebsites.com>" });
  await inbound(DB, "blank", "bounce", null);                                // no time: it counts
  await seedDue(DB, "auto", "2026-12-28T09:15:00Z", { root: "<root-auto@aetoswebsites.com>" });
  await inbound(DB, "auto", "auto", "2026-10-25T10:00:00Z");                 // out-of-office: keeps going
  await seedDue(DB, "early", "2026-12-28T09:15:00Z", { root: "<root-early@aetoswebsites.com>" });
  await inbound(DB, "early", "human", "2026-10-20T10:00:00Z");               // before the first email: keeps going
  await seedDue(DB, "closing", "2026-12-28T09:15:00Z", { followup_step: 9, root: "<root-closing@aetoswebsites.com>" });
  await inbound(DB, "closing", "opt_out", "2026-12-23T10:00:00Z");
  await seedDue(DB, "quiet", "2026-12-28T09:15:00Z", { followup_step: 9, root: "<root-quiet@aetoswebsites.com>" });

  const out = await queueDue(DB, now, { demoReady: okDemo });
  assert.equal(out.queued, 2);
  assert.deepEqual((await DB.prepare("SELECT place_id FROM messages WHERE kind = 'followup' ORDER BY place_id").all()).results
    .map((r) => r.place_id), ["auto", "early"]);
  assert.equal(await closeFinished(DB, now), 1);
  assert.deepEqual([(await getProspect(DB, "closing")).stage, (await getProspect(DB, "quiet")).stage], ["emailed", "lost"]);
  // The safety net then stops the ones that wrote back; nothing is ever queued for them.
  await followupsStep({ DB, env: {}, now: new Date("2026-12-28T09:25:00Z") }, { demoReady: okDemo });
  for (const id of ["human", "blank", "closing"]) {
    assert.equal((await getProspect(DB, id)).next_followup_at, null, id);
    assert.equal((await followupsOf(DB, id)).length, 0, id);
  }
  assert.equal((await getProspect(DB, "closing")).stage, "emailed");             // never closed as sequence_done
});

test("queueDue never goes past maxQueries, even when the booking changes under the lead it's queueing", async () => {
  for (let maxQueries = 0; maxQueries <= 12; maxQueries++) {
    const DB = await dueLead("p1", "2026-10-23T08:15:00Z"); await approveAll(DB);
    const racing = async (q, place_id) => {
      await stopFollowups(DB, place_id, "replied", "2026-10-23T08:20:00Z");  // through the uncounted DB: the inbound step
      return demoReady(q, place_id, new Date("2026-10-23T08:20:00Z"));        // stage 4's own: 1 query, as live
    };
    const c = countingDB(DB);
    const out = await queueDue(c.DB, new Date("2026-10-23T08:20:00Z"), { demoReady: racing, maxQueries });
    assert.ok(c.used() <= maxQueries, `maxQueries ${maxQueries}: used ${c.used()}`);
    assert.equal(out.queued, 0);
    assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup' AND status = 'queued'"), 0);
  }
});

test("40 due leads: at most 3 queued a run within 18 queries, the rest on later runs, each once", async () => {
  const DB = await manyDue(40); await approveAll(DB);
  const start = Date.parse("2026-10-23T08:20:00Z");
  for (let run = 0; run < 14; run++) {
    const before = await countOf(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup'");
    const c = countingDB(DB);
    await followupsStep({ DB: c.DB, env: {}, now: new Date(start + run * 300000) });
    assert.ok(c.used() <= 18, `run ${run}: used ${c.used()}`);
    const after = await countOf(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup'");
    assert.equal(after - before, Math.min(3, 40 - before), `run ${run}`);
  }
  const rows = (await DB.prepare("SELECT place_id, step, status FROM messages WHERE kind = 'followup'").all()).results;
  assert.equal(new Set(rows.map((r) => r.place_id)).size, 40);
  assert.ok(rows.every((r) => r.step === 1 && r.status === "queued"));
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM prospects WHERE next_followup_at IS NOT NULL"), 0);
});

// A D1 that refuses every statement past the 50th of one invocation, as the free plan does ("Too many API requests by
// single worker invocation"), counting each statement of a batch, as stage 0's countingDB does.
function freePlanD1(DB, limit = 50) {
  const counter = countingDB(DB);
  let refused = 0;
  const refuse = () => {
    refused++;
    throw new Error("D1: Too many API requests by single worker invocation");
  };
  const wrap = (stmt) => {
    const guarded = (method) => (...args) => (counter.used() >= limit ? refuse() : stmt[method](...args));
    return {
      get statement() { return stmt.statement; },
      get params() { return stmt.params; },
      bind: (...values) => wrap(stmt.bind(...values)),
      first: guarded("first"), all: guarded("all"), run: guarded("run"), raw: guarded("raw"),
      inner: stmt,
    };
  };
  return {
    DB: {
      prepare: (sql) => wrap(counter.DB.prepare(sql)),
      batch: (stmts) => (counter.used() + stmts.length > limit ? refuse() : counter.DB.batch(stmts.map((s) => s.inner ?? s))),
    },
    used: counter.used,
    refused: () => refused,
  };
}

// Found in review: the step took every query the tick had left (Math.min(18, left)), so after a busy inbound step the
// tick's closing beat became the invocation's 51st D1 query, which D1 refuses: no `tick` heartbeat, no lease release.
test("the followups step keeps one query for the tick's beat, whatever an earlier step left it", async () => {
  await utilDb({ DB: fakeD1() }); // the schema check, once per isolate, so it doesn't count below
  const followups = STEPS.find((s) => s.name === "followups");
  const send = STEPS.find((s) => s.name === "send");
  for (const leftover of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) {
    const DB = await manyDue(40); await approveAll(DB);
    // A busy inbound step (stage 0's takes up to 30 queries) that leaves exactly `leftover` for the steps after it.
    const busy = { name: "inbound", everyMinutes: 0, run: async (ctx) => {
      const spend = ctx.budget.left() - leftover;
      for (let i = 0; i < spend; i++) await ctx.DB.prepare("SELECT 1 AS x").first();
      return `spent ${spend}`;
    } };
    const d1 = freePlanD1(DB);
    const out = await runTick({ DB: d1.DB }, "cron", new Date("2026-10-23T08:20:00Z"), { steps: [busy, followups, send] });
    assert.equal(d1.refused(), 0, `${leftover} left: D1 refused a statement (${JSON.stringify(out.steps)})`);
    assert.ok(d1.used() <= 50, `${leftover} left: ${d1.used()} D1 statements`);
    assert.equal(typeof out.steps.followups, "string", `${leftover} left: ${JSON.stringify(out.steps.followups)}`);
    assert.match(out.steps.followups, /queued [1-3]/, `${leftover} left`);
    const beat = await DB.prepare("SELECT * FROM heartbeats WHERE name = 'tick'").first();
    assert.ok(beat, `${leftover} left: the tick's heartbeat was never written`);
    assert.equal(beat.last_at, "2026-10-23T08:20:00Z");
  }
});

test("followupsStep's cap: Math.min(18, budget.left() − 1), keeping one for the tick's beat; an unlimited budget is 18, one that isn't a number is 0", async () => {
  const DB = await manyDue(40); await approveAll(DB);
  const c = countingDB(DB);
  assert.equal(await followupsStep({ DB: c.DB, env: {}, now: new Date("2026-10-23T08:20:00Z"), budget: { left: () => Infinity } }),
    "synced 0, stopped 0, retried 0, closed 0, queued 3");
  assert.ok(c.used() <= 18, `used ${c.used()}`);
  for (const left of [19, 12, 11]) {                                     // one always kept for the tick's beat
    const f = countingDB(DB);
    await followupsStep({ DB: f.DB, env: {}, now: new Date("2026-10-23T08:22:00Z"), budget: { left: () => left } });
    assert.ok(f.used() <= Math.min(18, left - 1), `left ${left}: used ${f.used()}`);
  }
  const n = countingDB(DB);
  assert.equal(await followupsStep({ DB: n.DB, env: {}, now: new Date("2026-10-23T08:25:00Z"), budget: { left: () => NaN } }),
    "synced 0, stopped 0, retried 0, closed 0, queued 0; out of D1 queries, the rest next run");
  assert.equal(n.used(), 0);
});

// Found by email-e2e.test.mjs (Task 16): with syncSent first, recording a first email and a follow-up that had just
// gone took 8 of the 18 queries, so queueDue (stage 4's demoReady is 1 query a lead) queued none, and the send step
// then sent a waiting first email ahead of follow-ups that were due but not queued yet (A4: follow-ups go first).
// Nothing syncSent, retryFailed or closeFinished books is due on the same UK day, so queueDue can go before them.
test("followupsStep queues what's due before it books what was sent, so a busy run still queues 3", async () => {
  const DB = await manyDue(5); await approveAll(DB);
  await seedLead(DB, { place_id: "first", name: "Oak Tree Landscapes", trade: "landscaper" });
  await seedReady(DB, "first", { email: "jo@oaktree.co.uk" });
  await insertMessage(DB, { place_id: "first", kind: "first", status: "sent", message_id: "<first@aetoswebsites.com>",
    due_at: "2026-10-23T08:10:00Z", sent_at: "2026-10-23T08:10:00Z", body: `Hi,\n\nLook: https://d\n\n${coldFooter("Nik")}` });
  await seedDue(DB, "went", null, { root: "<root-went@aetoswebsites.com>" });
  await insertMessage(DB, { place_id: "went", kind: "followup", step: 1, status: "sent", message_id: "<f1-went@aetoswebsites.com>",
    due_at: "2026-10-23T08:15:00Z", sent_at: "2026-10-23T08:15:00Z" });
  const c = countingDB(DB);
  await followupsStep({ DB: c.DB, env: {}, now: new Date("2026-10-23T08:20:00Z") });
  assert.ok(c.used() <= 18, `used ${c.used()}`);
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup' AND status = 'queued'"), 3);
  // Queued as of the step's own time, not the computer's clock (the light's "a day late" reads created_at).
  assert.deepEqual((await DB.prepare("SELECT DISTINCT created_at FROM messages WHERE kind = 'followup' AND status = 'queued'").all()).results
    .map((r) => r.created_at), ["2026-10-23T08:20:00Z"]);
  // What went is recorded by a later run, still within 18 queries, and the other 2 due ones are queued.
  const n = countingDB(DB);
  assert.match(await followupsStep({ DB: n.DB, env: {}, now: new Date("2026-10-23T08:25:00Z") }),
    /^synced 2, stopped 0, retried 0, closed 0, queued 2(;|$)/);
  assert.ok(n.used() <= 18, `used ${n.used()}`);
  assert.equal(await countOf(DB, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup' AND status = 'queued'"), 5);
  assert.equal((await getProspect(DB, "first")).stage, "emailed");
  assert.equal((await getProspect(DB, "first")).next_followup_at, "2026-10-24T08:10:00Z");
  assert.equal((await getProspect(DB, "went")).followup_step, 1);
  assert.equal((await getProspect(DB, "went")).next_followup_at, "2026-10-24T08:15:00Z");
});

test("an interrupted follow-up's todo tells Nik to check the Sent folder, even when the error is cut", async () => {
  const DB = await dueLead("p1", null); await approveAll(DB);
  const long = `${INTERRUPTED_PREFIX}: the connection to mail.privateemail.com broke while the email was being sent (${"x".repeat(400)}). ${MAYBE_SENT}`;
  await insertMessage(DB, { place_id: "p1", kind: "followup", step: 1, status: "failed", due_at: "2026-10-23T08:15:00Z", error: long });
  assert.equal(await retryFailed(DB, new Date("2026-10-23T08:20:00Z")), 1);
  const todo = await openTodo(DB, "health:followup-fail:p1");
  assert.ok(todo.title.startsWith(`Follow-ups to Green Leaf Landscapes stopped: ${INTERRUPTED_PREFIX}`), todo.title);
  assert.ok(!todo.title.includes("Sent folder"));                                 // cut, so the detail must say it
  assert.match(todo.detail, /Check the Sent folder/);
  assert.equal((await followupsOf(DB, "p1")).length, 1);                           // never sent again
});

test("tick.js runs followups every 5 minutes, after inbound and before send", () => {
  const names = STEPS.map((s) => s.name);
  const at = names.indexOf("followups");
  assert.ok(at > names.indexOf("inbound") && at < names.indexOf("send"), names.join(", "));
  assert.equal(STEPS[at].everyMinutes, 5);
  assert.equal(typeof STEPS[at].run, "function");
});

// ================================================================ Task 15: the Follow-ups health light

// ---------------------------------------------------------------- the plan's tests (Part B, Task 15, Step 1)

test("followupHealth", () => {
  assert.deepEqual(followupHealth({ overdue: [], approved: true, waiting: 0 }), { name: "followups", level: "green", detail: "Follow-ups are on time.", fix: "" });
  assert.deepEqual(followupHealth({ overdue: [], approved: false, waiting: 4 }), { name: "followups", level: "amber",
    detail: "4 follow-ups are waiting for you to approve the wording on the Voice page.", fix: "Approve them on the Voice page." });
  assert.deepEqual(followupHealth({ overdue: Array(3).fill({ mailbox_address: "nik@aetoswebsites.com", mailbox_status: "paused" }), approved: true, waiting: 0 }),
    { name: "followups", level: "red", detail: "3 follow-ups are a day late: mailbox nik@aetoswebsites.com is paused.",
      fix: "Open Setup → Mailboxes and fix the paused mailbox." });
  const one = followupHealth({ overdue: [{ mailbox_address: "a@b", mailbox_status: "active" }], approved: true, waiting: 0 });
  assert.equal(one.detail, "1 follow-up is a day late.");
  assert.equal(one.fix, "Check the mailbox on Setup and the tick light.");
});
test("the light is registered", async () => {
  const DB = fakeD1();
  const { lights } = await healthFromDb(DB, {}, new Date("2026-10-22T10:00:00Z"));
  assert.equal(lights.find((l) => l.name === "followups").level, "green");
  const c = countingDB(DB);
  await followupHealthFromDb(c.DB, new Date("2026-10-22T10:00:00Z"));
  assert.equal(c.used(), 1);                                             // one statement per registered light
});

// ---------------------------------------------------------------- followupHealth (pure)

const LATE_FIX = "Check the mailbox on Setup and the tick light.";
const PAUSED_FIX = "Open Setup → Mailboxes and fix the paused mailbox.";
const APPROVE_FIX = "Approve them on the Voice page.";
const ON_TIME = { name: "followups", level: "green", detail: "Follow-ups are on time.", fix: "" };
const lateFrom = (mailbox_address, mailbox_status = "active") => ({ mailbox_address, mailbox_status });

test("followupHealth: one waiting, nothing waiting, approved with leads due, and late beats waiting", () => {
  assert.deepEqual(followupHealth({ overdue: [], approved: false, waiting: 1 }), { name: "followups", level: "amber",
    detail: "1 follow-up is waiting for you to approve the wording on the Voice page.", fix: APPROVE_FIX });
  assert.deepEqual(followupHealth({ overdue: [], approved: false, waiting: 0 }), ON_TIME); // drafts, but nobody waits yet
  assert.deepEqual(followupHealth({ overdue: [], approved: true, waiting: 5 }), ON_TIME);  // due now: the step queues them
  const late = followupHealth({ overdue: [lateFrom("m1@aetoswebsites.com")], approved: false, waiting: 6 });
  assert.deepEqual(late, { name: "followups", level: "red", detail: "1 follow-up is a day late.", fix: LATE_FIX });
  // Missing or broken facts never throw: nothing is late or waiting.
  assert.deepEqual(followupHealth({}), ON_TIME);
  assert.deepEqual(followupHealth(), ON_TIME);
  assert.deepEqual(followupHealth({ overdue: "lots", approved: false, waiting: "x" }), ON_TIME);
});

test("followupHealth: paused mailboxes are named once each; an active or missing one isn't", () => {
  const mixed = followupHealth({ overdue: [lateFrom("b@x.co.uk", "paused"), lateFrom("a@x.co.uk"), lateFrom("b@x.co.uk", "paused"),
    lateFrom(null, null)], approved: true, waiting: 0 });
  assert.deepEqual(mixed, { name: "followups", level: "red", detail: "4 follow-ups are a day late: mailbox b@x.co.uk is paused.", fix: PAUSED_FIX });
  const two = followupHealth({ overdue: [lateFrom("a@x.co.uk", "paused"), lateFrom("b@x.co.uk", "paused")], approved: true, waiting: 0 });
  assert.equal(two.detail, "2 follow-ups are a day late: mailboxes a@x.co.uk and b@x.co.uk are paused.");
  assert.equal(two.fix, "Open Setup → Mailboxes and fix the paused mailboxes.");
  const five = followupHealth({ overdue: ["a", "b", "c", "d", "e"].map((x) => lateFrom(`${x}@x.co.uk`, "paused")), approved: true, waiting: 0 });
  assert.equal(five.detail, "5 follow-ups are a day late: mailboxes a@x.co.uk, b@x.co.uk, c@x.co.uk and 2 more are paused.");
  // An address is shown on one line, whatever was saved.
  const odd = followupHealth({ overdue: [lateFrom("nik@\naetos‮websites.com", "paused")], approved: true, waiting: 0 });
  assert.equal(odd.detail, "1 follow-up is a day late: mailbox nik@ aetoswebsites.com is paused.");
});

// ---------------------------------------------------------------- followupHealthFromDb

const HEALTH_NOW = new Date("2026-10-22T10:00:00Z");                    // a follow-up due before 21 Oct 10:00Z is a day late
const lightNow = async (DB, now = HEALTH_NOW) => {
  const c = countingDB(DB);
  const light = await followupHealthFromDb(c.DB, now);
  assert.equal(c.used(), 1, "one statement");
  return light;
};

test("followupHealthFromDb: queued follow-ups more than 24 h late, from the row's mailbox or the thread's", async () => {
  const DB = fakeD1();
  await seedEmailed(DB, "p1", { first_sent_at: "2026-10-19T08:15:00Z" });
  await insertMessage(DB, { place_id: "p1", kind: "followup", step: 1, status: "queued", due_at: "2026-10-21T10:00:00Z" });
  assert.deepEqual(await lightNow(DB), ON_TIME);                         // exactly 24 h: not yet
  // None of these is a late follow-up: a first email, and follow-ups cancelled, sent, failed or sending.
  await insertMessage(DB, { place_id: "p1", kind: "first", status: "queued", due_at: "2026-10-19T08:15:00Z" });
  for (const status of ["cancelled", "sent", "failed", "sending"]) {
    await insertMessage(DB, { place_id: "p1", kind: "followup", step: 1, status, due_at: "2026-10-19T08:15:00Z" });
  }
  assert.deepEqual(await lightNow(DB), ON_TIME);
  assert.deepEqual(await lightNow(DB, new Date("2026-10-22T10:00:01Z")),
    { name: "followups", level: "red", detail: "1 follow-up is a day late.", fix: LATE_FIX });
  await DB.prepare("UPDATE mailboxes SET status = 'paused', paused_reason = 'Bounces' WHERE id = 'm1'").run();
  assert.deepEqual(await lightNow(DB, new Date("2026-10-22T10:00:01Z")), { name: "followups", level: "red",
    detail: "1 follow-up is a day late: mailbox m1@aetoswebsites.com is paused.", fix: PAUSED_FIX });
  // A row with no mailbox of its own is the thread's: p2 writes from m2, paused too. Queued ones count with the
  // templates drafts (they were queued while they were approved).
  await seedMailbox(DB, { id: "m2", status: "paused" });
  await seedEmailed(DB, "p2", { mailbox_id: "m2", first_sent_at: "2026-10-19T08:15:00Z" });
  await insertMessage(DB, { place_id: "p2", mailbox_id: null, kind: "followup", step: 2, status: "queued", due_at: "2026-10-20T08:15:00Z" });
  assert.deepEqual(await lightNow(DB, new Date("2026-10-22T10:00:01Z")), { name: "followups", level: "red",
    detail: "2 follow-ups are a day late: mailboxes m1@aetoswebsites.com and m2@aetoswebsites.com are paused.",
    fix: "Open Setup → Mailboxes and fix the paused mailboxes." });
});

test("followupHealthFromDb: booked follow-ups are late only once the templates are approved; till then they're waiting", async () => {
  const DB = fakeD1();
  const sent = "2026-10-19T08:15:00Z";
  const late = "2026-10-21T08:15:00Z";                                    // 25 h 45 min before HEALTH_NOW
  await seedEmailed(DB, "p1", { first_sent_at: sent, next_followup_at: late });
  await seedEmailed(DB, "p2", { stage: "viewed", first_sent_at: sent, next_followup_at: "2026-10-22T09:00:00Z" }); // due, not late
  await seedEmailed(DB, "p3", { first_sent_at: sent, next_followup_at: "2026-10-23T08:15:00Z" });  // tomorrow: not waiting
  await seedEmailed(DB, "p4", { stage: "replied", first_sent_at: sent, next_followup_at: late });   // stopped by its stage
  await seedEmailed(DB, "p5", { first_sent_at: sent, next_followup_at: late });                     // wrote back
  await inbound(DB, "p5", "human", "2026-10-20T12:00:00Z");
  await seedEmailed(DB, "p6", { first_sent_at: "2026-08-01T08:15:00Z", followup_step: 9, next_followup_at: late }); // its close time
  await seedEmailed(DB, "p7", { first_sent_at: sent, next_followup_at: late });                     // on hold for its demo
  await addTodo(DB, { kind: "health", title: "Follow-ups to p7 are on hold", place_id: "p7", dedupe: "health:followup-demo:p7" });
  await seedEmailed(DB, "p8", { stage: "lost", first_sent_at: sent, next_followup_at: late });
  await seedEmailed(DB, "p9", { first_sent_at: sent, next_followup_at: late });                     // an auto-reply never stops it
  await inbound(DB, "p9", "auto", "2026-10-20T12:00:00Z");
  await addTodo(DB, { kind: "health", title: "Follow-ups to p9 were on hold", place_id: "p9", dedupe: "health:followup-demo:p9" });
  await DB.prepare("UPDATE todos SET status = 'dismissed' WHERE dedupe = 'health:followup-demo:p9'").run(); // only an open hold counts

  // No templates yet, then 8 of 9 approved: p1, p2, p7 and p9 are waiting for them; nothing is late.
  const waiting = { name: "followups", level: "amber", detail: "4 follow-ups are waiting for you to approve the wording on the Voice page.", fix: APPROVE_FIX };
  assert.deepEqual(await lightNow(DB), waiting);
  await approveAll(DB);
  await DB.prepare("UPDATE followup_templates SET status = 'draft' WHERE step = 5").run();
  assert.deepEqual(await lightNow(DB), waiting);
  // All 9 approved: p1 and p9 are a day late (p7's hold todo says why it waits; p2 isn't a day late yet).
  await DB.prepare("UPDATE followup_templates SET status = 'approved' WHERE step = 5").run();
  assert.deepEqual(await lightNow(DB), { name: "followups", level: "red", detail: "2 follow-ups are a day late.", fix: LATE_FIX });
  // Once they've gone (nothing booked), it's green.
  await DB.prepare("UPDATE prospects SET next_followup_at = NULL WHERE place_id IN ('p1', 'p9')").run();
  assert.deepEqual(await lightNow(DB), ON_TIME);
});

test("the health step opens health:followups while it's red and closes it once they've gone, leaving follow-up todos alone", async () => {
  const DB = fakeD1();
  await seedEmailed(DB, "p1", { first_sent_at: "2026-10-19T08:15:00Z", next_followup_at: "2026-10-20T08:15:00Z" });
  await approveAll(DB);
  await addTodo(DB, { kind: "health", title: "Follow-ups to p2 are on hold", place_id: "p2", dedupe: "health:followup-demo:p2" });
  await addTodo(DB, { kind: "health", title: "Follow-ups to p3 keep failing", place_id: "p3", dedupe: "health:followup-fail:p3" });

  const { lights } = await healthFromDb(DB, {}, HEALTH_NOW);
  const mine = lights.filter((l) => l.name === "followups");
  assert.deepEqual(mine, [{ name: "followups", level: "red", detail: "1 follow-up is a day late.", fix: LATE_FIX }]);
  assert.ok(lights.indexOf(mine[0]) >= 10, "after stage 0's 10");
  const names = lights.map((l) => l.name);
  for (const a of names) for (const b of names) if (a !== b) assert.ok(!b.startsWith(a), `${a} is a prefix of ${b}`);

  await healthStep.run({ DB, env: {}, now: HEALTH_NOW });
  const open = await openTodo(DB, "health:followups");
  assert.deepEqual([open.kind, open.title, open.detail], ["health", "1 follow-up is a day late.", LATE_FIX]);

  await DB.prepare("UPDATE prospects SET next_followup_at = NULL WHERE place_id = 'p1'").run();
  const later = new Date("2026-10-22T10:05:00Z");
  await healthStep.run({ DB, env: {}, now: later });
  assert.equal(await openTodo(DB, "health:followups"), null);
  assert.equal((await todoOf(DB, "health:followups@"))[0].status, "done");
  assert.ok(await openTodo(DB, "health:followup-demo:p2"), "the hold todo is the followups step's to close");
  assert.ok(await openTodo(DB, "health:followup-fail:p3"), "and so is the failing one");
});

test("followupHealthFromDb: a follow-up that waited for Nik's approval isn't late when he approves; a day after it is", async () => {
  const DB = fakeD1();
  const approvedAt = "2026-10-23T19:59:00Z";                             // the 9th approval, Fri 20:59 BST
  await seedEmailed(DB, "p1", { first_sent_at: "2026-10-19T08:15:00Z", next_followup_at: "2026-10-20T08:15:00Z" });
  await seedEmailed(DB, "p2", { first_sent_at: "2026-10-19T08:15:00Z", next_followup_at: "2026-10-21T08:15:00Z" });
  const at = new Date("2026-10-23T20:00:00Z");
  assert.deepEqual(await lightNow(DB, at), { name: "followups", level: "amber",
    detail: "2 follow-ups are waiting for you to approve the wording on the Voice page.", fix: APPROVE_FIX });
  await approveAll(DB);                                                   // 8 approved long ago, the last just now
  await DB.prepare("UPDATE followup_templates SET approved_at = ?1 WHERE step = 4").bind(approvedAt).run();
  assert.deepEqual(await lightNow(DB, at), ON_TIME);                      // days past their booking, but they waited for him
  // The followups step queues p1 at 20:05 with its booking as due_at; after 19:00 UK it waits for 07:00: still on time.
  await DB.prepare("UPDATE prospects SET next_followup_at = NULL WHERE place_id = 'p1'").run();
  await insertMessage(DB, { place_id: "p1", kind: "followup", step: 1, status: "queued", due_at: "2026-10-20T08:15:00Z",
    created_at: "2026-10-23T20:05:00Z" });
  assert.deepEqual(await lightNow(DB, new Date("2026-10-24T07:00:00Z")), ON_TIME);
  // p2 still booked a day after the approval (the step isn't queueing): late. p1 queued exactly 24 h ago: not yet.
  const late1 = { name: "followups", level: "red", detail: "1 follow-up is a day late.", fix: LATE_FIX };
  assert.deepEqual(await lightNow(DB, new Date("2026-10-24T19:59:00Z")), ON_TIME);
  assert.deepEqual(await lightNow(DB, new Date("2026-10-24T19:59:01Z")), late1);
  assert.deepEqual(await lightNow(DB, new Date("2026-10-24T20:05:00Z")), late1);
  assert.deepEqual(await lightNow(DB, new Date("2026-10-24T20:05:01Z")),
    { name: "followups", level: "red", detail: "2 follow-ups are a day late.", fix: LATE_FIX });
  // An approval with no date saved counts as long ago: p2 is late as soon as it's a day past its booking.
  await DB.prepare("UPDATE followup_templates SET approved_at = NULL").run();
  assert.deepEqual(await lightNow(DB, new Date("2026-10-24T07:00:00Z")), late1);
});

test("followupHealthFromDb: a follow-up queued once its demo came back is late a day after it was queued, not at once", async () => {
  const DB = fakeD1();
  await approveAll(DB);
  await seedEmailed(DB, "p1", { first_sent_at: "2026-10-16T08:15:00Z" });
  await insertMessage(DB, { place_id: "p1", kind: "followup", step: 1, status: "queued", due_at: "2026-10-19T08:15:00Z",
    created_at: "2026-10-22T09:00:00Z" });
  assert.deepEqual(await lightNow(DB), ON_TIME);
  assert.deepEqual(await lightNow(DB, new Date("2026-10-23T09:00:01Z")),
    { name: "followups", level: "red", detail: "1 follow-up is a day late.", fix: LATE_FIX });
  // A row with no created_at counts by its due_at alone.
  await DB.prepare("UPDATE messages SET created_at = '' WHERE place_id = 'p1'").run();
  assert.equal((await lightNow(DB)).level, "red");
});

test("followupHealthFromDb: many late follow-ups from several mailboxes, paused ones named by address, still 1 statement", async () => {
  const DB = fakeD1();
  await approveAll(DB);
  await seedMailbox(DB, { id: "m2", status: "paused" });
  await seedMailbox(DB, { id: "m3", status: "paused" });
  await seedEmailed(DB, "p1", { first_sent_at: "2026-10-16T08:15:00Z" });
  await seedEmailed(DB, "p2", { mailbox_id: "m2", first_sent_at: "2026-10-16T08:15:00Z" });
  await seedEmailed(DB, "p3", { mailbox_id: "m3", first_sent_at: "2026-10-16T08:15:00Z" });
  const rows = [];
  for (const [place_id, n] of [["p3", 40], ["p1", 30], ["p2", 50]]) {
    for (let i = 0; i < n; i++) rows.push({ place_id, mailbox_id: null, kind: "followup", step: 1, status: "queued", due_at: "2026-10-19T08:15:00Z" });
  }
  for (const row of rows) await insertMessage(DB, row);
  assert.deepEqual(await lightNow(DB), { name: "followups", level: "red",
    detail: "120 follow-ups are a day late: mailboxes m2@aetoswebsites.com and m3@aetoswebsites.com are paused.",
    fix: "Open Setup → Mailboxes and fix the paused mailboxes." });
});

test("GET /api/health shows the followups light in an isolate that loaded nothing else (the import chain registers it)", () => {
  // A fresh node process importing only the route, like a /api/health call that is the isolate's first request.
  const url = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  const code = `
    import { onRequestGet } from ${url("../functions/api/health.js")};
    import { fakeD1 } from ${url("./helpers/fakeD1.mjs")};
    import { seedMailbox, seedMessage, seedProspect } from ${url("./helpers/shortlistSeed.mjs")};
    const DB = fakeD1();
    await seedMailbox(DB, { id: "m1", status: "paused", paused_reason: "Bounces" });
    await seedProspect(DB, { place_id: "p1", stage: "emailed", mailbox_id: "m1", first_sent_at: "2000-01-01T08:15:00Z" });
    await seedMessage(DB, { place_id: "p1", kind: "followup", step: 1, status: "queued", due_at: "2000-01-02T08:15:00Z",
      created_at: "2000-01-02T08:15:00Z" });
    const body = await (await onRequestGet({ env: { DB } })).json();
    console.log(JSON.stringify(body.lights.filter((l) => l.name === "followups")));`;
  const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { encoding: "utf8" });
  const lights = JSON.parse(out.trim().split("\n").pop());
  assert.deepEqual(lights, [{ name: "followups", level: "red", detail: "1 follow-up is a day late: mailbox m1@aetoswebsites.com is paused.",
    fix: "Open Setup → Mailboxes and fix the paused mailbox." }]);
});
