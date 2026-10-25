// Follow-ups (pure): the schedule in UK time (days 1-60 after the first email, same clock time, Sunday to Monday,
// never two on one UK day), capacity planning (a first email needs room on all 10 of its days) and the stop rules
// (a reply, an opt-out, a bounce or a later stage ends the sequence; a demo view or an auto-reply doesn't).
// Run: node --test control-room/tests/followups.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOSE_AFTER_DAYS, COLD_WINDOW, DRAFTS, FOLLOWUP_DAYS, STOP_STAGES, checkFollowup, firstEmailDays, loadByDay, nextDue,
  renderFollowup, roomFor, schedule, stopReason,
} from "../functions/_lib/followups.js";
import { mailboxCap } from "../functions/_lib/mail/capacity.js";
import { COLD_WINDOW as OUTBOX_COLD_WINDOW } from "../functions/_lib/mail/outbox.js";
import { businessName, findLinks, wordCount } from "../functions/_lib/mail/rules.js";
import { cleanBusiness } from "../functions/_lib/outreach.js";
import { STAGES } from "../functions/_lib/stages.js";
import { addUkDays, ukDate, ukParts, ukToUtc } from "../functions/_lib/ukTime.js";

test("schedule keeps UK time across BST→GMT and moves Sunday to Monday", () => {
  const first = "2026-10-22T08:15:00Z"; // Thu 09:15 BST
  const want = ["2026-10-23T08:15:00Z","2026-10-24T08:15:00Z","2026-10-26T09:15:00Z","2026-10-29T09:15:00Z",
    "2026-11-02T09:15:00Z","2026-11-09T09:15:00Z","2026-11-16T09:15:00Z","2026-11-21T09:15:00Z","2026-12-21T09:15:00Z"];
  want.forEach((iso, i) => assert.equal(schedule(first, i + 1).toISOString(), iso.replace("Z", ".000Z")));
});
test("GMT→BST", () => assert.equal(schedule("2027-03-25T09:00:00Z", 3).toISOString(), "2027-03-29T08:00:00.000Z"));
test("clamps time of day into 07:00–18:59", () => {
  assert.equal(schedule("2026-10-22T05:30:00Z", 1).toISOString(), "2026-10-23T06:00:00.000Z"); // 06:30 BST → 07:00
  assert.equal(schedule("2026-10-22T18:30:00Z", 1).toISOString(), "2026-10-23T17:59:00.000Z"); // 19:30 BST → 18:59
});
test("nextDue never puts two follow-ups on one UK day", () => {
  const sat = "2026-10-24T09:00:00Z"; // Sat 10:00 BST
  assert.equal(nextDue(sat, 1, sat).toISOString(), "2026-10-26T10:00:00.000Z");
  assert.equal(nextDue(sat, 2, "2026-10-26T10:00:00Z").toISOString(), "2026-10-27T10:00:00.000Z");
  assert.equal(nextDue(sat, 3, "2026-10-27T10:00:00Z").toISOString(), "2026-10-28T10:00:00.000Z");
});
test("nextDue moves past a slipped previous step", () =>
  assert.equal(nextDue("2026-10-22T08:15:00Z", 2, "2026-10-24T08:20:00Z").toISOString(), "2026-10-26T09:15:00.000Z"));

// Beyond the plan's tests: the constants, the one shared COLD_WINDOW, Date input, no previous send, and bad input.
test("the days, the close delay and the cold window", () => {
  assert.deepEqual(FOLLOWUP_DAYS, [1, 2, 4, 7, 10, 17, 24, 30, 60]);
  assert.ok(Object.isFrozen(FOLLOWUP_DAYS));
  assert.equal(CLOSE_AFTER_DAYS, 7);
  assert.deepEqual(COLD_WINDOW, { start: "07:00", end: "19:00", days: [1, 2, 3, 4, 5, 6] });
  assert.equal(COLD_WINDOW, OUTBOX_COLD_WINDOW); // one object: the send step and the schedule can never disagree
});

test("schedule and nextDue take a Date as well as UTC ISO text", () => {
  const first = new Date("2026-10-22T08:15:00Z");
  assert.equal(schedule(first, 3).toISOString(), "2026-10-26T09:15:00.000Z");
  assert.equal(nextDue(first, 2, new Date("2026-10-24T08:20:00Z")).toISOString(), "2026-10-26T09:15:00.000Z");
});

test("nextDue with no previous send, or one on an earlier day, is the schedule", () => {
  const first = "2026-10-22T08:15:00Z";
  for (let step = 1; step <= 9; step++) {
    assert.equal(nextDue(first, step, null).toISOString(), schedule(first, step).toISOString());
  }
  assert.equal(nextDue(first, 3, "2026-10-24T08:15:00Z").toISOString(), "2026-10-26T09:15:00.000Z"); // Sat sent, Mon due
});

test("a Saturday first email's whole chain: one a day at most, never on a Sunday, same UK clock time", () => {
  const first = "2026-10-24T09:00:00Z"; // Sat 10:00 BST; the clocks go back the next day
  let last = first;
  const days = [ukDate(new Date(first))];
  for (let step = 1; step <= 9; step++) {
    const due = nextDue(first, step, last);
    const { hh, mm, weekday } = ukParts(due);
    assert.notEqual(weekday, 0, `step ${step} on a Sunday`);
    assert.deepEqual([hh, mm], [10, 0], `step ${step} at ${due.toISOString()}`);
    assert.ok(ukDate(due) > days[days.length - 1], `step ${step} on or before the previous one's day`);
    days.push(ukDate(due));
    last = due;
  }
  assert.deepEqual(days, ["2026-10-24", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-31", "2026-11-03",
    "2026-11-10", "2026-11-17", "2026-11-23", "2026-12-23"]);
});

test("bad input says what's wrong", () => {
  assert.throws(() => schedule("2026-10-22T08:15:00Z", 0), /step must be a whole number from 1 to 9, got 0/);
  assert.throws(() => schedule("2026-10-22T08:15:00Z", 10), /from 1 to 9, got 10/);
  assert.throws(() => schedule("2026-10-22T08:15:00Z", "2"), /from 1 to 9, got "2"/);
  assert.throws(() => schedule("not a date", 1), /first email's send time.*"not a date"/);
  assert.throws(() => schedule(null, 1), /first email's send time/);
  assert.throws(() => nextDue("2026-10-22T08:15:00Z", 2, "yesterday"), /previous send time.*"yesterday"/);
});

// Reviewer's additions: Part A §A4 rules the plan's tests don't pin down, and input that would differ by computer.
test("bank holidays are ordinary sending days", () => {
  const first = "2026-12-24T10:00:00Z"; // Thu 24 Dec 10:00 GMT
  assert.equal(schedule(first, 1).toISOString(), "2026-12-25T10:00:00.000Z"); // Christmas Day, Fri
  assert.equal(schedule(first, 2).toISOString(), "2026-12-26T10:00:00.000Z"); // Boxing Day, Sat
  assert.equal(schedule(first, 3).toISOString(), "2026-12-28T10:00:00.000Z"); // Mon 28 (bank holiday), not Tue 29
});

test("the clamped time is kept in UK time across the clock change, and a moved step keeps it too", () => {
  const early = "2026-10-22T05:30:00Z"; // Thu 06:30 BST → 07:00 UK
  assert.equal(schedule(early, 2).toISOString(), "2026-10-24T06:00:00.000Z"); // Sat 07:00 BST
  assert.equal(schedule(early, 3).toISOString(), "2026-10-26T07:00:00.000Z"); // Mon 07:00 GMT
  assert.equal(nextDue(early, 2, "2026-10-24T17:58:00Z").toISOString(), "2026-10-26T07:00:00.000Z"); // Sat 18:58 BST
  const late = "2027-03-26T19:30:00Z"; // Fri 19:30 GMT → 18:59 UK; the clocks go forward on Sun 28 Mar
  assert.equal(schedule(late, 1).toISOString(), "2027-03-27T18:59:00.000Z"); // Sat 18:59 GMT
  assert.equal(schedule(late, 2).toISOString(), "2027-03-29T17:59:00.000Z"); // Sun → Mon 18:59 BST
});

test("day 60 runs into the next year", () =>
  assert.equal(schedule("2026-11-20T10:00:00Z", 9).toISOString(), "2027-01-19T10:00:00.000Z"));

test("time text without a zone is UTC, whatever the computer's time zone", () => {
  for (const text of ["2026-10-22T08:15:00", "2026-10-22 08:15:00", "2026-10-22T08:15:00.000Z", " 2026-10-22T08:15:00Z "]) {
    assert.equal(schedule(text, 1).toISOString(), "2026-10-23T08:15:00.000Z", text);
  }
  assert.equal(nextDue("2026-10-24T09:00:00Z", 1, "2026-10-24 09:00:00").toISOString(), "2026-10-26T10:00:00.000Z");
});

test("an error message never throws on input it can't print", () => {
  assert.throws(() => schedule("2026-10-22T08:15:00Z", 2n), /step must be a whole number from 1 to 9, got 2/);
  const loop = {}; loop.self = loop;
  assert.throws(() => schedule(loop, 1), /first email's send time as a date or UTC ISO text, got \[object Object\]/);
});

// Task 2: capacity planning. A first email needs a place in its mailbox's daily cap on its own day and on each of the
// 9 days its follow-ups will go, so Send (and the Leads banner) only offer what the mailboxes can carry.
const mb = { id: "m1", role: "cold", status: "active", cap_override: 10, started_on: "2026-01-01" };
test("firstEmailDays for a Thursday first email", () => assert.deepEqual(firstEmailDays("2026-10-22T08:15:00Z"),
  ["2026-10-22","2026-10-23","2026-10-24","2026-10-26","2026-10-29","2026-11-02","2026-11-09","2026-11-16","2026-11-21","2026-12-21"]));
test("ten firsts on one day fill every follow-up day", () => {
  const seqs = Array.from({ length: 10 }, () => ({ mailbox_id: "m1", first_at: "2026-10-22T08:15:00Z", step_done: 0, next_at: "2026-10-23T08:15:00Z" }));
  const cold = seqs.map(() => ({ mailbox_id: "m1", at: "2026-10-22T08:15:00Z" }));
  const load = loadByDay({ cold, sequences: seqs }, "2026-10-22");
  assert.equal(load.m1["2026-10-23"], 10);
  assert.equal(load.m1["2026-12-21"], 10);
  assert.deepEqual(roomFor(load, mb, "2026-10-22T09:00:00Z"), { room: 0, fullDay: "2026-10-22" });
  assert.deepEqual(roomFor(load, mb, "2026-10-27T09:00:00Z"), { room: 0, fullDay: "2026-10-29" }); // its day-2 follow-up hits Thu 29
});
test("overdue follow-ups count on today", () =>
  assert.equal(loadByDay({ cold: [], sequences: [{ mailbox_id: "m1", first_at: "2026-10-20T08:00:00Z", step_done: 0, next_at: "2026-10-21T08:00:00Z" }] }, "2026-10-22").m1["2026-10-22"], 1));
test("warm-up cap 0 means no room", () =>
  assert.equal(roomFor({}, { ...mb, cap_override: null, started_on: "2026-10-20" }, "2026-10-22T09:00:00Z").room, 0));

// Beyond the plan's tests: the days chain the way the tick sends them (nextDue from the step before), every way a
// send or a sequence is booked, the floor at 0, the mailbox's own cap, and bad input.
test("firstEmailDays chains like the tick: a Saturday first email never needs two places on one day", () => {
  const want = ["2026-10-24", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-31", "2026-11-03", "2026-11-10",
    "2026-11-17", "2026-11-23", "2026-12-23"]; // schedule alone would put days 1 and 2 both on Mon 26
  assert.deepEqual(firstEmailDays("2026-10-24T09:00:00Z"), want);
  assert.deepEqual(firstEmailDays(new Date("2026-10-24T09:00:00Z")), want);
  const first = "2026-10-24T09:00:00Z"; // what the tick does: each step from the one sent before it
  let last = first;
  const tick = [ukDate(new Date(first))];
  for (let step = 1; step <= 9; step++) tick.push(ukDate((last = nextDue(first, step, last))));
  assert.deepEqual(tick, want);
});

test("an overdue step counts on today and moves the rest of its chain with it", () => {
  const load = loadByDay({ sequences: [{ mailbox_id: "m1", first_at: "2026-10-20T08:00:00Z", step_done: 0, next_at: "2026-10-21T08:00:00Z" }] }, "2026-10-22");
  // Step 1 (due Wed 21) goes today, Thu 22, so step 2 (planned for Thu 22) goes the next sending day, Fri 23.
  assert.deepEqual(load, { m1: { "2026-10-22": 1, "2026-10-23": 1, "2026-10-24": 1, "2026-10-27": 1, "2026-10-30": 1,
    "2026-11-06": 1, "2026-11-13": 1, "2026-11-19": 1, "2026-12-19": 1 } });
});

test("a sequence part-way through books only the steps still to come; a finished one books nothing", () => {
  const first = "2026-10-22T08:15:00Z";
  assert.deepEqual(loadByDay({ sequences: [{ mailbox_id: "m1", first_at: first, step_done: 3, next_at: "2026-10-29T09:15:00Z" }] }, "2026-10-27"),
    { m1: { "2026-10-29": 1, "2026-11-02": 1, "2026-11-09": 1, "2026-11-16": 1, "2026-11-21": 1, "2026-12-21": 1 } });
  // A step that slipped: step 4 now due Fri 30 (not Thu 29), so step 5 still goes Mon 2 Nov and the rest keep the plan.
  assert.deepEqual(Object.keys(loadByDay({ sequences: [{ mailbox_id: "m1", first_at: first, step_done: 3, next_at: "2026-10-30T09:15:00Z" }] }, "2026-10-27").m1),
    ["2026-10-30", "2026-11-02", "2026-11-09", "2026-11-16", "2026-11-21", "2026-12-21"]);
  // All 9 sent: next_at is the close time (marked lost then), not an email.
  assert.deepEqual(loadByDay({ sequences: [{ mailbox_id: "m1", first_at: first, step_done: 9, next_at: "2026-12-28T09:15:00Z" }] }, "2026-12-22"), {});
});

test("a queued first email (no next_at yet) books its 9 follow-ups from its due time", () => {
  const due = "2026-10-26T07:00:00Z"; // Mon 07:00 GMT, queued on Saturday evening
  const load = loadByDay({ cold: [{ mailbox_id: "m1", at: due }], sequences: [{ mailbox_id: "m1", first_at: due, step_done: 0, next_at: null }] }, "2026-10-26");
  assert.deepEqual(Object.keys(load.m1), firstEmailDays(due));
  assert.ok(Object.values(load.m1).every((n) => n === 1));
});

test("cold sends count on their own UK day, an overdue one on today, each mailbox apart", () => {
  const cold = [
    { mailbox_id: "m1", at: "2026-10-21T10:00:00Z" },  // yesterday, still queued: goes today
    { mailbox_id: "m1", at: "2026-10-22T06:30:00Z" },  // today 07:30 BST
    { mailbox_id: "m1", at: "2026-10-22T23:30:00Z" },  // Fri 00:30 BST: tomorrow in the UK, though still the 22nd in UTC
    { mailbox_id: "m2", at: new Date("2026-10-26T07:00:00Z") },
  ];
  assert.deepEqual(loadByDay({ cold, sequences: [] }, "2026-10-22"),
    { m1: { "2026-10-22": 2, "2026-10-23": 1 }, m2: { "2026-10-26": 1 } });
  assert.deepEqual(loadByDay({}, "2026-10-22"), {});
});

test("roomFor is the free places on its fullest day, floored at 0, and only its own mailbox's load counts", () => {
  const thu = "2026-10-22T08:15:00Z";
  assert.deepEqual(roomFor({}, mb, thu), { room: 10, fullDay: null });
  assert.deepEqual(roomFor(undefined, mb, thu), { room: 10, fullDay: null });
  assert.deepEqual(roomFor({ m1: { "2026-10-26": 3 } }, mb, thu), { room: 7, fullDay: null });
  assert.deepEqual(roomFor({ m1: { "2026-10-26": 12 } }, mb, thu), { room: 0, fullDay: "2026-10-26" }); // cap cut after booking
  assert.deepEqual(roomFor({ m2: { "2026-10-22": 10 } }, mb, thu), { room: 10, fullDay: null });
  assert.deepEqual(roomFor({ m1: { "2026-11-09": 9, "2026-11-16": 10 } }, mb, thu), { room: 0, fullDay: "2026-11-16" });
});

test("roomFor uses the mailbox's cap on each day: paused, not bought yet, warming up", () => {
  const thu = "2026-10-22T08:15:00Z";
  assert.deepEqual(roomFor({}, { ...mb, status: "paused" }, thu), { room: 0, fullDay: "2026-10-22" });
  assert.deepEqual(roomFor({}, { ...mb, started_on: "2026-11-01" }, thu), { room: 0, fullDay: "2026-10-22" });
  assert.deepEqual(roomFor({}, { ...mb, cap_override: null, started_on: "2026-10-20" }, thu), { room: 0, fullDay: "2026-10-22" });
  const warming = { ...mb, cap_override: null, started_on: "2026-10-08" }; // day 14 on Thu 22: 3 a day, 10 by December
  assert.deepEqual(roomFor({}, warming, thu), { room: 3, fullDay: null });
  assert.deepEqual(roomFor({ m1: { "2026-12-21": 9 } }, warming, thu), { room: 1, fullDay: null });
});

test("capacity planning: bad input says what's wrong", () => {
  const seq = { mailbox_id: "m1", first_at: "2026-10-22T08:15:00Z", step_done: 0, next_at: "2026-10-23T08:15:00Z" };
  assert.throws(() => loadByDay({ sequences: [seq] }, "22/10/2026"), /UK date must look like YYYY-MM-DD, got "22\/10\/2026"/);
  assert.throws(() => loadByDay({ sequences: [{ ...seq, first_at: "soon" }] }, "2026-10-22"), /first email's send time.*"soon"/);
  assert.throws(() => loadByDay({ sequences: [{ ...seq, next_at: "soon" }] }, "2026-10-22"), /next follow-up's due time.*"soon"/);
  assert.throws(() => loadByDay({ sequences: [{ ...seq, step_done: 10 }] }, "2026-10-22"), /step_done must be a whole number from 0 to 9, got 10/);
  assert.throws(() => loadByDay({ sequences: [{ ...seq, step_done: "x" }] }, "2026-10-22"), /from 0 to 9, got "x"/);
  assert.throws(() => loadByDay({ cold: [{ mailbox_id: "m1", at: "soon" }] }, "2026-10-22"), /cold send's time.*"soon"/);
  assert.throws(() => roomFor({}, mb, "soon"), /first email's send time.*"soon"/);
  assert.throws(() => firstEmailDays(undefined), /first email's send time/);
});

// Reviewer's additions (Task 2): the day being planned for is the UK day of the next send, so in the evening and at
// the weekend it's later than the day of the sends already made, and an overdue email goes on it, never on a Sunday.
test("a send already made counts on its own day, never moved to the day being planned for", () => {
  // Tue 27 Oct 20:00 GMT: 10 went today, the window has shut, so the next send (and the plan) is Wed 28.
  const sent = Array.from({ length: 10 }, () => ({ mailbox_id: "m1", at: "2026-10-27T10:00:00Z", status: "sent" }));
  const held = { mailbox_id: "m1", at: "2026-10-27T11:00:00Z", status: "queued" }; // didn't fit today: goes Wednesday
  const load = loadByDay({ cold: [...sent, held] }, "2026-10-28");
  assert.deepEqual(load, { m1: { "2026-10-27": 10, "2026-10-28": 1 } });
  assert.deepEqual(roomFor(load, mb, "2026-10-28T07:00:00Z"), { room: 9, fullDay: null }); // not 0: today's sends are done
});

test("planned on a Sunday, overdue sends count on Monday and the rest of the chain follows from Monday", () => {
  const first = "2026-10-22T08:15:00Z"; // Thu; step 2 was due Sat 24 and hasn't gone (mailbox paused)
  const load = loadByDay({ cold: [{ mailbox_id: "m1", at: "2026-10-24T09:00:00Z", status: "queued" }],
    sequences: [{ mailbox_id: "m1", first_at: first, step_done: 1, next_at: "2026-10-24T08:15:00Z" }] }, "2026-10-25");
  assert.deepEqual(load, { m1: { "2026-10-26": 2, "2026-10-27": 1, "2026-10-29": 1, "2026-11-02": 1, "2026-11-09": 1,
    "2026-11-16": 1, "2026-11-21": 1, "2026-12-21": 1 } });
  // A next follow-up time (or a queued email's due time) set to a Sunday by hand, as the live check does, goes Monday.
  assert.deepEqual(Object.keys(loadByDay({ sequences: [{ mailbox_id: "m1", first_at: first, step_done: 4, next_at: "2026-11-01T10:00:00Z" }] }, "2026-10-29").m1),
    ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-21", "2026-12-21"]);
  assert.deepEqual(loadByDay({ cold: [{ mailbox_id: "m1", at: "2026-11-01T10:00:00Z", status: "queued" }] }, "2026-10-29"),
    { m1: { "2026-11-02": 1 } });
});

test("each time counts on its UK day, every 15 minutes across both clock changes and UK midnight", () => {
  for (const [from, to] of [["2026-03-27", "2026-03-31"], ["2026-10-23", "2026-10-27"], ["2027-03-26", "2027-03-30"]]) {
    for (let ms = Date.parse(`${from}T00:00:00Z`); ms < Date.parse(`${to}T00:00:00Z`); ms += 15 * 60000) {
      const at = new Date(ms);
      const want = { m1: { [ukDate(at)]: 1 } };
      assert.deepEqual(loadByDay({ cold: [{ mailbox_id: "m1", at, status: "sent" }] }, "2026-01-01"), want, at.toISOString());
      const waiting = ukParts(at).weekday === 0 ? addUkDays(ukDate(at), 1) : ukDate(at); // not sent yet: Sunday → Monday
      assert.deepEqual(loadByDay({ cold: [{ mailbox_id: "m1", at: at.toISOString() }] }, "2026-01-01"), { m1: { [waiting]: 1 } },
        `queued ${at.toISOString()}`);
    }
  }
  assert.equal(firstEmailDays("2026-10-22T23:30:00Z")[0], "2026-10-23"); // Fri 00:30 BST
  assert.equal(firstEmailDays("2026-12-22T23:30:00Z")[0], "2026-12-22"); // Tue 23:30 GMT
});

test("a queued first email that's overdue goes on the day planned for, and its follow-ups count from that day", () => {
  const due = "2026-10-21T08:00:00Z"; // Wed 09:00 BST, held (mailbox paused) and still queued on Thu 22
  const load = loadByDay({ cold: [{ mailbox_id: "m1", at: due, status: "queued" }],
    sequences: [{ mailbox_id: "m1", first_at: due, step_done: 0, next_at: null }] }, "2026-10-22");
  assert.deepEqual(Object.keys(load.m1), firstEmailDays("2026-10-22T08:00:00Z"));
  assert.ok(Object.values(load.m1).every((n) => n === 1), JSON.stringify(load.m1)); // never two on Thu 22
  const sunday = "2026-11-01T10:00:00Z"; // a due time set to a Sunday by hand: it goes Monday, its follow-ups after
  const later = loadByDay({ cold: [{ mailbox_id: "m1", at: sunday, status: "queued" }],
    sequences: [{ mailbox_id: "m1", first_at: sunday, step_done: 0, next_at: null }] }, "2026-10-29");
  assert.deepEqual(Object.keys(later.m1), firstEmailDays("2026-11-02T10:00:00Z"));
  assert.ok(Object.values(later.m1).every((n) => n === 1), JSON.stringify(later.m1));
});

// A pure stand-in for the tick (Tasks 7 and 8 do this with the database): on a sending day every follow-up due by
// then goes (an overdue one at 07:00), and the next step is booked by nextDue from the time it went, as syncSent does.
const isSendingDay = (day) => COLD_WINDOW.days.includes(ukParts(ukToUtc(day, "12:00")).weekday);
function tickDay(seqs, day) {
  let sent = 0;
  for (const s of seqs) {
    if (s.step_done >= 9 || ukDate(new Date(s.next_at)) > day) continue;
    const at = ukDate(new Date(s.next_at)) < day ? ukToUtc(day, "07:00") : new Date(s.next_at);
    s.step_done += 1;
    s.next_at = s.step_done < 9 ? nextDue(s.first_at, s.step_done + 1, at).toISOString() : null;
    sent += 1;
  }
  return sent;
}

test("the planned load is exactly what the tick then sends, day by day (Saturdays, slipped steps, clock change)", () => {
  for (const today of ["2026-10-22", "2026-10-25"]) { // a Thursday, and a Sunday (the plan is then for Monday)
    const seqs = [];
    const times = ["07:05", "12:45", "18:50"];
    for (let d = 0; d < 28; d++) { // Thu 24 Sep to Wed 21 Oct: first emails on every sending day, Saturdays too
      const day = addUkDays("2026-09-24", d);
      if (!isSendingDay(day)) continue;
      for (const id of ["m1", "m2"]) {
        if (id === "m2" && day >= "2026-10-19") continue; // m2 paused from Mon 19: its follow-ups are overdue by Thu 22
        tickDay(seqs.filter((s) => s.mailbox_id === id), day);
        const at = ukToUtc(day, times[d % 3]);
        seqs.push({ mailbox_id: id, first_at: at.toISOString(), step_done: 0, next_at: nextDue(at, 1, at).toISOString() });
      }
    }
    const open = seqs.map((s) => ({ ...s }));
    assert.ok(open.some((s) => s.mailbox_id === "m2" && ukDate(new Date(s.next_at)) < today), "an overdue step to plan for");
    const load = loadByDay({ cold: [], sequences: open }, today);
    const sent = {};
    for (let d = 0; d < 80; d++) { // the clocks go back on Sun 25 Oct
      const day = addUkDays(today, d);
      if (!isSendingDay(day)) continue;
      for (const id of ["m1", "m2"]) {
        const n = tickDay(seqs.filter((s) => s.mailbox_id === id), day);
        if (n) (sent[id] ??= {})[day] = n;
      }
    }
    assert.ok(seqs.every((s) => s.step_done === 9));
    assert.deepEqual(sent, load, `planned on ${today}`);
  }
});

test("sending whenever roomFor says there's room never books a mailbox over its cap, warming up or not", () => {
  for (const mailbox of [mb, { ...mb, cap_override: null, started_on: "2026-10-19" }]) {
    const seqs = [], sends = {};
    let firsts = 0;
    for (let d = 0; d < 140; d++) { // first emails for 70 days, then their follow-ups run out
      const day = addUkDays("2026-11-02", d);
      if (!isSendingDay(day)) continue;
      sends[day] = tickDay(seqs, day); // follow-ups go before first emails
      const at = ukToUtc(day, "09:00");
      while (d < 70) {
        const cold = Array.from({ length: sends[day] }, () => ({ mailbox_id: "m1", at }));
        const room = roomFor(loadByDay({ cold, sequences: seqs.filter((s) => s.step_done < 9) }, day), mailbox, at);
        if (room.room < 1) break;
        sends[day] += 1;
        firsts += 1;
        seqs.push({ mailbox_id: "m1", first_at: at.toISOString(), step_done: 0, next_at: nextDue(at, 1, at).toISOString() });
      }
      assert.ok(sends[day] <= mailboxCap(mailbox, day), `${sends[day]} sent on ${day}, cap ${mailboxCap(mailbox, day)}`);
    }
    assert.ok(firsts >= 20, `only ${firsts} first emails`);
    assert.ok(seqs.every((s) => s.step_done === 9), "a follow-up was skipped");
    assert.equal(Object.values(sends).reduce((a, b) => a + b, 0), firsts * 10);
  }
});

// Task 3: stop rules. The sequence ends on a human reply, an opt-out or a bounce received after the first email, or
// once the stage is past viewed; opt_out beats bounce beats a reply beats the stage.
const p = { stage: "emailed", first_sent_at: "2026-10-22T08:15:00Z" };
test("stop rules", () => {
  assert.equal(stopReason(p, []), null);
  assert.equal(stopReason({ ...p, stage: "viewed" }, []), null);
  assert.equal(stopReason(p, [{ class: "auto", received_at: "2026-10-23T09:00:00Z" }]), null);
  assert.equal(stopReason(p, [{ class: "human", received_at: "2026-10-21T09:00:00Z" }]), null);
  assert.equal(stopReason(p, [{ class: "human", received_at: "2026-10-25T09:00:00Z" }]), "replied");
  assert.equal(stopReason(p, [{ class: "human", received_at: "2026-10-25T09:00:00Z" }, { class: "opt_out", received_at: "2026-10-26T09:00:00Z" }]), "opt_out");
  assert.equal(stopReason(p, [{ class: "bounce", received_at: "2026-10-22T08:16:00Z" }]), "bounce");
  for (const s of STOP_STAGES) assert.equal(stopReason({ ...p, stage: s }, []), `stage:${s}`);
});

// Beyond the plan's tests: the stages that stop and those that don't, the whole order of precedence, the time bound,
// what's never a stop, and bad input.
test("the stop stages are every real stage past viewed, so only emailed and viewed leads get follow-ups", () => {
  assert.deepEqual(STOP_STAGES, ["replied", "needs_nik", "call_booked", "won", "lost"]);
  assert.ok(Object.isFrozen(STOP_STAGES));
  for (const s of STOP_STAGES) assert.ok(STAGES.includes(s), `${s} isn't a stage`);
  assert.deepEqual(STAGES.filter((s) => !STOP_STAGES.includes(s)), ["ready", "emailed", "viewed"]);
  for (const stage of ["ready", "emailed", "viewed"]) assert.equal(stopReason({ ...p, stage }, []), null, stage);
});

test("opt_out beats bounce beats a reply beats the stage, whatever order the messages come in", () => {
  const at = (h) => `2026-10-2${h}T09:00:00Z`;
  const human = { class: "human", received_at: at(3) };
  const optOut = { class: "opt_out", received_at: at(4) };
  const bounce = { class: "bounce", received_at: at(5) };
  const auto = { class: "auto", received_at: at(6) };
  for (const inbound of [[human, optOut, bounce, auto], [auto, bounce, optOut, human], [optOut, human], [bounce, optOut]]) {
    assert.equal(stopReason(p, inbound), "opt_out", JSON.stringify(inbound));
    assert.equal(stopReason({ ...p, stage: "lost" }, inbound), "opt_out"); // the stage never outranks a message
  }
  for (const inbound of [[human, bounce], [bounce, human, auto], [bounce]]) {
    assert.equal(stopReason({ ...p, stage: "replied" }, inbound), "bounce", JSON.stringify(inbound));
  }
  assert.equal(stopReason({ ...p, stage: "call_booked" }, [auto, human]), "replied");
  assert.equal(stopReason({ ...p, stage: "won" }, [auto]), "stage:won"); // an auto-reply never decides
  assert.equal(stopReason({ ...p, stage: "viewed" }, [human]), "replied");
});

test("only messages received after the first email went count; one in the same second counts", () => {
  const before = (cls) => ({ class: cls, received_at: "2026-10-22T08:14:59Z" });
  assert.equal(stopReason(p, [before("human"), before("opt_out"), before("bounce")]), null);
  assert.equal(stopReason({ ...p, stage: "lost" }, [before("opt_out")]), "stage:lost");
  assert.equal(stopReason(p, [before("opt_out"), { class: "human", received_at: "2026-10-22T08:15:00Z" }]), "replied");
  // Dates, and times with no zone (SQLite's form), are read as UTC, so the bound is the same on every computer.
  assert.equal(stopReason({ ...p, first_sent_at: new Date(p.first_sent_at) }, [{ class: "bounce", received_at: new Date("2026-10-22T08:16:00Z") }]), "bounce");
  assert.equal(stopReason(p, [{ class: "human", received_at: "2026-10-22 08:14:00" }]), null);
  assert.equal(stopReason({ ...p, first_sent_at: "2026-10-22 08:15:00" }, [{ class: "human", received_at: "2026-10-22T08:16:00.000Z" }]), "replied");
});

test("a demo view, an auto-reply or a message that isn't a reply never stops the sequence", () => {
  const later = "2026-10-23T09:00:00Z";
  const inbound = ["auto", null, undefined, "", "Human", "opt-out", "complaint", "viewed"].map((cls) => ({ class: cls, received_at: later }));
  assert.equal(stopReason(p, inbound), null);
  assert.equal(stopReason({ ...p, stage: "viewed" }, inbound), null);
  assert.equal(stopReason(p, null), null);
  assert.equal(stopReason(p, undefined), null);
  assert.equal(stopReason({ ...p, stage: "needs_nik" }), "stage:needs_nik");
});

test("when it can't tell when a reply came, the reply counts: follow-ups never go after one", () => {
  // No first email time yet (the sent-sync hasn't written it): every reply, opt-out and bounce counts.
  for (const first_sent_at of [null, undefined, ""]) {
    assert.equal(stopReason({ stage: "emailed", first_sent_at }, [{ class: "human", received_at: "2026-10-21T09:00:00Z" }]), "replied");
  }
  assert.equal(stopReason({ stage: "ready" }, []), null);
  // A message with no time, or one that can't be read, counts as after the first email.
  assert.equal(stopReason(p, [{ class: "human", received_at: null }]), "replied");
  assert.equal(stopReason(p, [{ class: "opt_out" }]), "opt_out");
  assert.equal(stopReason(p, [{ class: "bounce", received_at: "last Tuesday" }]), "bounce");
  assert.equal(stopReason(p, [{ class: "auto", received_at: null }]), null);
});

test("stop rules: bad input says what's wrong", () => {
  assert.throws(() => stopReason(null, []), /stopReason needs the prospect row \(its stage and first_sent_at\), got null/);
  assert.throws(() => stopReason("emailed", []), /stopReason needs the prospect row.*got "emailed"/);
  assert.throws(() => stopReason({ ...p, first_sent_at: "soon" }, []), /first email's send time as a date or UTC ISO text, got "soon"/);
  assert.throws(() => stopReason(p, { class: "human" }), /stopReason needs the lead's inbound messages as a list, got \{"class":"human"\}/);
  assert.throws(() => stopReason(p, [null]), /Each inbound message needs its class and received_at, got null/);
});

// Task 4: follow-up wording, checks and rendering. The 9 drafts are Part A §A6 word for word; checkFollowup is run on
// them and on every edit Nik makes on the Voice page, and renderFollowup fills one in for a lead.
test("all 9 drafts pass the checks", () => {
  for (let s = 1; s <= 9; s++) assert.deepEqual(checkFollowup(DRAFTS[s]), [], `step ${s}`);
  assert.equal(DRAFTS[7].includes("{demo_link}"), false);
  assert.match(DRAFTS[9], /^\{greeting\}\n\nI'll leave it here/);
});
test("checkFollowup messages", () => {
  assert.deepEqual(checkFollowup("Hi,\n\nHello"), ['The first line must be {greeting} on its own.']);
  assert.ok(checkFollowup(`{greeting}\n\n${"word ".repeat(61)}`).includes("Too long: 61 words. Keep it to 60."));
  assert.ok(checkFollowup("{greeting}\n\nGreat SEO {demo_link}").includes('Don\'t say "SEO". Say "front page of Google" instead.'));
  assert.ok(checkFollowup("{greeting}\n\n{demo_link} and {demo_link}").includes("Use the demo link once at most."));
  assert.ok(checkFollowup("{greeting}\n\nSee www.example.com").includes("Only the demo link is allowed. Remove: www.example.com"));
  assert.ok(checkFollowup("{greeting}\n\nHi {town}").includes("{town} isn't filled in. Use {greeting}, {business} or {demo_link}."));
  assert.ok(checkFollowup("{greeting}\n\nOnly £249").includes("No prices in follow-ups: they change at weekends."));
  assert.ok(checkFollowup("{greeting}\n\nIt's guaranteed").includes("No guarantees in follow-ups: they're on the order page."));
  assert.ok(checkFollowup("{greeting}\n\nA? B?").includes("One question at most."));
});
test("renderFollowup", () => assert.equal(
  renderFollowup("{greeting}\n\nFor {business}: {demo_link}", { greeting: "Hi,", business: "Smith Roofing", demoUrl: "https://aetoswebsites.com/d/smith" }),
  "Hi,\n\nFor Smith Roofing: https://aetoswebsites.com/d/smith"));
test("findLinks", () => assert.deepEqual(findLinks("see greenleaf.co.uk or www.x.com, mail me@x.org, https://a.io/b ok. e.g. fine"),
  ["greenleaf.co.uk", "www.x.com", "me@x.org", "https://a.io/b"]));
test("businessName", () => assert.equal(businessName("SMITH ROOFING LTD - Roofer in Leeds"), "Smith Roofing"));

// Beyond the plan's tests: the drafts are A6 word for word, every rule of A6 at its edge, links as people paste them,
// and the business name as stage 7 will use it.
test("the drafts are Part A §A6 word for word, and can't be changed at run time", () => {
  const a6 = {
    1: `{greeting}

In case my last email got buried: I made a new website for {business} and it's ready to look at.

{demo_link}

It takes a minute on your phone.`,
    2: `{greeting}

The site I made for {business} uses your own services, your area and your details, so you can see exactly how it would look for you.

{demo_link}

If anything on it is wrong, tell me and I'll fix it.`,
    3: `{greeting}

Most people find a local business on their phone now, so the site I made for {business} is built for phones first.

Have a look on yours:
{demo_link}`,
    4: `{greeting}

I might have the wrong person. If someone else looks after the website for {business}, would you mind passing this on to them?

This is the site I made: {demo_link}

Thank you.`,
    5: `{greeting}

The point of the new site is more calls. When someone near you searches for what you do, the aim is for {business} to show up in the top 3 on Google, with a site that makes it easy to ring you.

{demo_link}`,
    6: `{greeting}

If you're busy, this won't take much of your time. You fill in one short form and I do the rest. The site goes live within 7 days of that.

This is what it would look like:
{demo_link}`,
    7: `{greeting}

Is a new website something you'd want for {business} this year, or not right now?

Either answer is fine. A one-word reply is plenty.`,
    8: `{greeting}

The site I made for {business} is still up if you want another look:

{demo_link}

If you'd change anything on it, like the photos, colours or wording, just tell me what and I'll sort it.`,
    9: `{greeting}

I'll leave it here so I'm not filling up your inbox. If the timing is better later on, just reply to this email and I'll pick it up from there.

The site for {business} is here whenever you want it:
{demo_link}

All the best.`,
  };
  assert.deepEqual(Object.keys(DRAFTS), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  for (let s = 1; s <= 9; s++) assert.equal(DRAFTS[s], a6[s], `step ${s}`);
  assert.ok(Object.isFrozen(DRAFTS));
  // The Voice page shows "28 / 60 words" for step 1 (stage 5–6 Task 14): the words after the {greeting} line.
  assert.equal(wordCount(DRAFTS[1].split("\n").slice(1).join("\n")), 28);
  for (let s = 1; s <= 9; s++) {
    assert.equal(DRAFTS[s].split("{demo_link}").length - 1, s === 7 ? 0 : 1, `step ${s} has the demo link once`);
    assert.equal(DRAFTS[s].includes("{business}"), s !== 6, `step ${s} and {business}`);
  }
});

test("wordCount: whitespace-separated, each placeholder one word", () => {
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount("   \n\t "), 0);
  assert.equal(wordCount(null), 0);
  assert.equal(wordCount(undefined), 0);
  assert.equal(wordCount("one"), 1);
  assert.equal(wordCount("  In case\nmy  last\t\temail  "), 5);
  assert.equal(wordCount("For {business}: {demo_link}"), 3);
  assert.equal(wordCount("{demo_link}"), 1);
  assert.equal(wordCount("it's a one-word reply."), 4);
  assert.equal(wordCount("pasted\u00a0from\u00a0Word"), 3); // non-breaking spaces separate words too
});

test("checkFollowup: the first line is {greeting} and nothing else", () => {
  const ok = "{greeting}\n\nHave a look: {demo_link}";
  assert.deepEqual(checkFollowup(ok), []);
  assert.deepEqual(checkFollowup(ok.replace(/\n/g, "\r\n")), []); // a textarea's line endings
  assert.deepEqual(checkFollowup("{greeting}  \n\nHave a look: {demo_link}"), []); // invisible trailing spaces are fine
  assert.deepEqual(checkFollowup("{greeting}\u00a0\n\nHave a look: {demo_link}"), []); // or one pasted from Word
  for (const bad of ["", "\n{greeting}\n\nHi", "{greeting} Mark\n\nHi", "Hi {greeting}\n\nHi", "{Greeting}\n\nHi", "Hello there"]) {
    assert.ok(checkFollowup(bad).includes("The first line must be {greeting} on its own."), JSON.stringify(bad));
  }
  assert.deepEqual(checkFollowup(null), ["The first line must be {greeting} on its own.", "Write the follow-up under {greeting}."]);
  assert.ok(checkFollowup("{greeting}\n\nThanks {greeting}").includes("Use {greeting} once, on the first line."));
  assert.throws(() => checkFollowup(42), /checkFollowup needs the follow-up's text, got 42/);
  assert.throws(() => checkFollowup({ body: "x" }), /checkFollowup needs the follow-up's text, got \{"body":"x"\}/);
});

test("checkFollowup: at most 60 words after {greeting}, {business} and {demo_link} one each", () => {
  const words = (n) => Array.from({ length: n }, () => "word").join(" ");
  assert.deepEqual(checkFollowup(`{greeting}\n\n${words(60)}`), []);
  assert.deepEqual(checkFollowup(`{greeting}\n\n{business} ${words(58)}\n\n{demo_link}`), []);
  assert.deepEqual(checkFollowup(`{greeting}\n\n{business} ${words(59)}\n\n{demo_link}`), ["Too long: 61 words. Keep it to 60."]);
  assert.deepEqual(checkFollowup(`{greeting}\n\n${words(30)}\n\n${words(30)}\n${"word"}`), ["Too long: 61 words. Keep it to 60."]);
  // With no {greeting} line, every word counts, so the length is known before the greeting is fixed.
  assert.deepEqual(checkFollowup(words(61)), ["The first line must be {greeting} on its own.", "Too long: 61 words. Keep it to 60."]);
  // A cleared textarea can't be approved: it would send every lead just "Hi Mark," and the footer.
  for (const empty of ["{greeting}", "{greeting}\n\n", "{greeting}\r\n\r\n \t\r\n"]) {
    assert.deepEqual(checkFollowup(empty), ["Write the follow-up under {greeting}."], JSON.stringify(empty));
  }
  assert.deepEqual(checkFollowup("{greeting}\n\n{demo_link}"), []); // one word is enough
});

test("checkFollowup: only {greeting}, {business} and {demo_link}, each unknown one named once", () => {
  assert.deepEqual(checkFollowup("{greeting}\n\n{business} in {town}, {town}. Hi {first_name} at {Business}"), [
    "{town} isn't filled in. Use {greeting}, {business} or {demo_link}.",
    "{first_name} isn't filled in. Use {greeting}, {business} or {demo_link}.",
    "{Business} isn't filled in. Use {greeting}, {business} or {demo_link}.",
  ]);
  assert.deepEqual(checkFollowup("{greeting}\n\nAt { business }"), ["{ business } isn't filled in. Use {greeting}, {business} or {demo_link}."]);
  for (const stray of ["{greeting}\n\nLook: {demo_link", "{greeting}\n\nLook: demo_link}", "{greeting}\n\n{{business}}"]) {
    assert.ok(checkFollowup(stray).includes('Take out the "{" or "}" on its own: placeholders look like {business}.'), stray);
  }
});

test("checkFollowup: the demo link once at most and no other link, as people paste them", () => {
  assert.deepEqual(checkFollowup("{greeting}\n\nNo link this time."), []); // a follow-up doesn't need the link (step 7)
  assert.deepEqual(checkFollowup("{greeting}\n\n{demo_link}\n{demo_link}\n{demo_link}"), ["Use the demo link once at most."]);
  assert.deepEqual(checkFollowup("{greeting}\n\nSee https://aetoswebsites.com/d/smith-roofing-7k2p9q"),
    ["Only the demo link is allowed. Remove: https://aetoswebsites.com/d/smith-roofing-7k2p9q"]); // the same for every lead: {demo_link}
  assert.deepEqual(checkFollowup("{greeting}\n\n{demo_link}\n--\nNik | www.aetoswebsites.com, nik@aetoswebsites.com or greenleaf.co.uk. Or www.aetoswebsites.com"),
    ["Only the demo link is allowed. Remove: www.aetoswebsites.com, nik@aetoswebsites.com, greenleaf.co.uk"]);
  assert.deepEqual(checkFollowup("{greeting}\n\nLook:{demo_link}, it's “yours”. I’ve made it e.g. for phones, i.e. fast, etc."), []);
  // {demo_link} is filled in with the whole address: "https://{demo_link}" would send a dead "https://https://…" link.
  const glued = '{demo_link} is the whole address: take out the "https://" or "www." in front of it.';
  for (const t of ["https://{demo_link}", "Look: http://{demo_link}", "HTTPS://{demo_link}", "www.{demo_link}"]) {
    assert.deepEqual(checkFollowup(`{greeting}\n\n${t}`), [glued], t);
  }
});

test("checkFollowup: no SEO, prices, guarantees, more than one question or \"!!\"", () => {
  const issues = (text) => checkFollowup(`{greeting}\n\n${text}`);
  const seo = 'Don\'t say "SEO". Say "front page of Google" instead.';
  for (const t of ["seo", "Seo help", "SEO-friendly", "(SEO)"]) assert.deepEqual(issues(t), [seo], t);
  assert.deepEqual(issues("We were in Seoul for SEOs"), []);
  const price = "No prices in follow-ups: they change at weekends.";
  for (const t of ["£1,950", "only £ 249", "1750 pounds", "around 2k", "249 a month", "€200", "$300", "GBP 249", "60 days free", "free for 90 days"]) {
    assert.deepEqual(issues(t), [price], t);
  }
  assert.deepEqual(issues("top 3 on Google, live within 7 days, free to look at"), []);
  const guarantee = "No guarantees in follow-ups: they're on the order page.";
  for (const t of ["guarantee", "GUARANTEED.", "Our guarantees"]) assert.deepEqual(issues(t), [guarantee], t);
  assert.deepEqual(issues("Is it? Yes."), []);
  assert.deepEqual(issues("Is it? Really?"), ["One question at most."]);
  assert.deepEqual(issues("Great! Have a look!"), []);
  assert.deepEqual(issues("Great!! Have a look"), ['Don\'t use "!!". One "!" is enough.']);
  assert.deepEqual(issues("Wow!!!"), ['Don\'t use "!!". One "!" is enough.']);
  // Every rule at once, in a fixed order (the Voice page lists them as they come).
  assert.deepEqual(checkFollowup(`Hi,\n${"x ".repeat(60)}{town} {demo_link} {demo_link} www.a.com SEO £1 guarantee? ?!!`), [
    "The first line must be {greeting} on its own.",
    "Too long: 69 words. Keep it to 60.", // no {greeting} line, so "Hi," counts too
    "{town} isn't filled in. Use {greeting}, {business} or {demo_link}.",
    "Use the demo link once at most.",
    "Only the demo link is allowed. Remove: www.a.com",
    'Don\'t say "SEO". Say "front page of Google" instead.',
    "No prices in follow-ups: they change at weekends.",
    "No guarantees in follow-ups: they're on the order page.",
    "One question at most.",
    'Don\'t use "!!". One "!" is enough.',
  ]);
});

test("renderFollowup fills every placeholder once, in one pass, and never prints undefined", () => {
  const v = { greeting: "Hi Mark,", business: "Green Leaf Landscapes", demoUrl: "https://aetoswebsites.com/d/green-leaf-landscapes" };
  assert.equal(renderFollowup(DRAFTS[1], v), "Hi Mark,\n\nIn case my last email got buried: I made a new website for Green Leaf Landscapes and it's ready to look at.\n\nhttps://aetoswebsites.com/d/green-leaf-landscapes\n\nIt takes a minute on your phone.");
  assert.equal(renderFollowup("{business}, {business}", v), "Green Leaf Landscapes, Green Leaf Landscapes");
  // A scraped name is text, never a pattern or a placeholder: "$&" stays as it is, "{demo_link}" isn't filled again.
  assert.equal(renderFollowup("For {business}.", { ...v, business: "A$&B $1 Roofing" }), "For A$&B $1 Roofing.");
  assert.equal(renderFollowup("For {business}: {demo_link}", { ...v, business: "{demo_link}" }), `For {demo_link}: ${v.demoUrl}`);
  // Line breaks, control and bidi characters in a value can't break the email's lines or hide what it says.
  assert.equal(renderFollowup("For {business}.", { ...v, business: " Smith\r\nRoofing\u0007 \u202Eltd " }), "For Smith Roofing ltd.");
  assert.equal(renderFollowup("For {business}.", { ...v, business: "\ufeffSmith\u200b\u200f Roofing\u0085Leeds\u061c\u2060" }), "For Smith Roofing Leeds.");
  // A textarea's line endings come out as plain \n, and a trailing blank line never gaps the footer.
  assert.equal(renderFollowup("{greeting}\r\n\r\nLook: {demo_link}\r\n\r\n", v), `Hi Mark,\n\nLook: ${v.demoUrl}`);
  // Step 7 has no link: no demo address is needed.
  assert.ok(renderFollowup(DRAFTS[7], { greeting: "Hi,", business: "Smith Roofing" }).startsWith("Hi,\n\nIs a new website something you'd want for Smith Roofing"));
  assert.throws(() => renderFollowup(DRAFTS[1], { ...v, demoUrl: undefined }), /\{demo_link\} needs the demo's address \(demoUrl\), got undefined/);
  assert.throws(() => renderFollowup(DRAFTS[1], { ...v, business: "  " }), /\{business\} needs the business name \(business\), got "  "/);
  assert.throws(() => renderFollowup(DRAFTS[1], { ...v, greeting: null }), /\{greeting\} needs the greeting line, like "Hi Mark," \(greeting\), got null/);
  assert.throws(() => renderFollowup(DRAFTS[1]), /\{greeting\} needs the greeting line/);
  assert.throws(() => renderFollowup(undefined, v), /renderFollowup needs the follow-up's text, got undefined/);
  assert.equal(renderFollowup("{greeting} {town}", v), "Hi Mark, {town}"); // unknown ones are left (checkFollowup blocks them)
});

test("findLinks finds every kind of link, in text order, without the punctuation after it", () => {
  assert.deepEqual(findLinks(""), []);
  assert.deepEqual(findLinks(null), []);
  assert.deepEqual(findLinks("Visit https://greenleaf.co.uk/about?x=1#top. Or http://x.com!"), ["https://greenleaf.co.uk/about?x=1#top", "http://x.com"]);
  assert.deepEqual(findLinks("HTTPS://X.COM and WWW.Y.CO.UK and Z.NET"), ["HTTPS://X.COM", "WWW.Y.CO.UK", "Z.NET"]);
  assert.deepEqual(findLinks("(www.x.com) [y.org] “greenleaf.co.uk”, ‘a.io’; b.biz: c.info? d.uk"),
    ["www.x.com", "y.org", "greenleaf.co.uk", "a.io", "b.biz", "c.info", "d.uk"]);
  assert.deepEqual(findLinks("shop.green-leaf.co.uk, greenleaf.org.uk/contact, smith-roofing.com/"),
    ["shop.green-leaf.co.uk", "greenleaf.org.uk/contact", "smith-roofing.com/"]);
  assert.deepEqual(findLinks("Email nik.smith+web@aetos-websites.co.uk or INFO@X.COM."), ["nik.smith+web@aetos-websites.co.uk", "INFO@X.COM"]);
  assert.deepEqual(findLinks("www.me@x.org"), ["www.me@x.org"]); // one address, not a host and an address
  assert.deepEqual(findLinks("(see https://a.io/b)"), ["https://a.io/b"]);
  assert.deepEqual(findLinks("https://en.wikipedia.org/wiki/Roof_(building)"), ["https://en.wikipedia.org/wiki/Roof_(building)"]);
  assert.deepEqual(findLinks("café.co.uk"), ["café.co.uk"]);
  assert.deepEqual(findLinks("x.com and x.com"), ["x.com", "x.com"]); // every one, so a count is right
  assert.deepEqual(findLinks("Look:https://a.io/b{demo_link}"), ["https://a.io/b{demo_link}"]); // the caller takes placeholders out first
  assert.deepEqual(findLinks("this...greenleaf.co.uk, Nik -x.com, Nik--y.net, foo_bar.com, a.b.c.uk"),
    ["greenleaf.co.uk", "x.com", "Nik--y.net", "bar.com", "a.b.c.uk"]); // "--" inside is a real host name (xn--…)
});

test("findLinks takes time in line with the text's length, however it's written", () => {
  // Trying every letter of a long run as a start took 1-2 s for 20,000 characters (Workers allow 10 ms of CPU).
  for (const text of ["a".repeat(20000), "a.".repeat(10000), "a-".repeat(10000), "a-.".repeat(7000), "ab.cd_ef+gh".repeat(2000),
    "ab-cd-ef.".repeat(2000), "-".repeat(20000), `https://x.com${")".repeat(20000)}`, "{a".repeat(10000)]) {
    const started = performance.now();
    findLinks(text);
    checkFollowup(text);
    const ms = performance.now() - started;
    assert.ok(ms < 300, `${ms.toFixed(0)} ms for ${JSON.stringify(text.slice(0, 12))}…`);
  }
  assert.deepEqual(findLinks(`https://x.com${")".repeat(20000)}`), ["https://x.com"]);
});

test("findLinks raises no false alarms on ordinary writing", () => {
  const prose = "e.g. i.e. etc. ok. a.m. p.m. No.1 £1,950.00 9.30am U.K. Mr. Smith & Co. fix.comment St.Albans " +
    "the site.Have a look awww.so 3.5 v2.0 it's “yours” I’ve {demo_link} {business}. @smith #roofing node.js done.";
  assert.deepEqual(findLinks(prose), []);
  assert.deepEqual(findLinks("I’ve made you a site “for you”: {demo_link}"), []);
});

test("businessName is the port of cleanBusiness: how people say the business's name", () => {
  const names = [
    ["SMITH ROOFING LTD - Roofer in Leeds", "Smith Roofing"],
    ["GREEN LEAF LANDSCAPES LIMITED", "Green Leaf Landscapes"],
    ["Smith & Sons Roofing Ltd.", "Smith & Sons Roofing"],
    ["J. Bloggs Plumbing, Ltd", "J. Bloggs Plumbing"],
    ["SMITH AND SONS | Leeds", "Smith and Sons"],
    ["Green Leaf Landscapes – Gardeners in Leeds", "Green Leaf Landscapes"],
    ["A-PLUS PLUMBING LLP", "A-Plus Plumbing"],
    ["McDonald Roofing", "McDonald Roofing"],
    ["BT", "BT"],
    ["  Bright Sparks Electrical  ", "Bright Sparks Electrical"],
    ["Keys-R-Us Locksmiths", "Keys-R-Us Locksmiths"],
    ["", ""],
  ];
  for (const [raw, want] of names) {
    assert.equal(businessName(raw), want, raw);
    assert.equal(businessName(raw), cleanBusiness(raw), `${raw}: the same as outreach.js's copy`);
  }
  assert.equal(businessName(null), "");
  assert.equal(businessName(undefined), "");
});
