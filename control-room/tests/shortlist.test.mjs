// Shortlist rules (pure): filter parsing, LIKE escaping, today's room for first emails, the capacity banner, the
// warm-up date, which grades are in Ready, the morning pick title and the one hot rule.
// Run: node --test control-room/tests/shortlist.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  capacityBanner, firstEmailRoom, isHot, likePattern, parseLeadFilters, pickTitle, readyGrades, warmupFrom,
  GRADES, GRADE_TOKENS, PAGE_SIZE, STAGE_LABELS, STAGE_TOKENS,
} from "../functions/_lib/shortlist.js";

const P = (s) => parseLeadFilters(new URLSearchParams(s));
test("filters parse safely", () => {
  assert.equal(P("").view, "ready");
  assert.deepEqual(P("view=all&grade=ap,a,none,zz").grades, ["A+", "A", "none"]);
  assert.equal(P("grade=A+").grades, null);                   // raw + is a space: dropped, not "A"
  assert.deepEqual(P("stage=ready,none,hot").stages, ["ready", "none"]);
  assert.equal(P("q=" + "x".repeat(500)).q.length, 100);
  assert.deepEqual([P("email=1").email, P("email=0").email, P("email=x").email], [true, false, null]);
  assert.deepEqual([P("page=0").page, P("page=abc").page, P("page=3").page], [1, 1, 3]);
});
test("like patterns are literal", () => {
  assert.equal(likePattern("100%_a\\b"), "%100\\%\\_a\\\\b%");
});
test("room and banner", () => {
  const c = { mailboxes: 1, paused: [], cap: 10, sent: 0, followupsDue: 7, firstQueued: 0, warmupFrom: null };
  c.room = firstEmailRoom(c);
  assert.equal(c.room, 3);
  assert.deepEqual(capacityBanner(c), { tone: "ok", text: "You can send 3 first emails today (10 a day, 7 follow-ups already due).", link: null });
  const full = { ...c, sent: 2, firstQueued: 1 }; full.room = firstEmailRoom(full);   // 10 − 2 − 7 − 1 = 0
  assert.equal(capacityBanner(full).text,
    "No room for more first emails today (10 a day, 7 follow-ups already due, 2 already sent, 1 first email waiting to go). The next ones can go tomorrow.");
  assert.equal(firstEmailRoom({ cap: 5, sent: 0, followupsDue: 9, firstQueued: 0 }), 0);
  assert.equal(capacityBanner({ ...c, cap: 10, sent: 3, followupsDue: 7, room: 0 }).text,
    "No room for more first emails today (10 a day, 7 follow-ups already due, 3 already sent). The next ones can go tomorrow.");
  assert.deepEqual(capacityBanner({ mailboxes: 0, paused: [], cap: 0, sent: 0, followupsDue: 0, firstQueued: 0, room: 0, warmupFrom: null }),
    { tone: "warn", text: "Add your mailbox on Setup to start emailing.", link: { href: "#/setup", label: "Open Setup" } });
  assert.equal(capacityBanner({ ...c, paused: [{ address: "nik@aetoswebsites.com", reason: "2 hard bounces in 7 days" }], cap: 0, room: 0 }).text,
    "Sending is paused: 2 hard bounces in 7 days. Fix it on Setup.");
  assert.equal(capacityBanner({ ...c, cap: 0, room: 0, warmupFrom: "2026-11-03" }).text,
    "Your mailbox is warming up. First emails can go from Tue 3 Nov.");
  assert.equal(capacityBanner({ ...c, cap: 10, followupsDue: 0, sent: 0, firstQueued: 1, room: 9 }).text,
    "You can send 9 first emails today (10 a day, 1 first email waiting to go).");
});
test("warm-up date", () => {
  assert.equal(warmupFrom([{ role: "cold", status: "active", started_on: "2026-10-20", cap_override: null }], "2026-10-21"), "2026-11-03");
  assert.equal(warmupFrom([], "2026-10-21"), null);
});
test("B joins only with spare room", () => {
  assert.deepEqual(readyGrades(3, 8), ["A+", "A"]);
  assert.deepEqual(readyGrades(3, 3), ["A+", "A"]);
  assert.deepEqual(readyGrades(4, 3), ["A+", "A", "B"]);
});
test("pick title", () => {
  assert.equal(pickTitle({ top: 8, b: 5, room: 3, bIncluded: false }), "8 A-grade leads ready: you can send 3 first emails today");
  assert.equal(pickTitle({ top: 1, b: 0, room: 1, bIncluded: false }), "1 A-grade lead ready: you can send 1 first email today");
  assert.equal(pickTitle({ top: 0, b: 4, room: 3, bIncluded: true }), "4 B-grade leads ready: you can send 3 first emails today");
  assert.equal(pickTitle({ top: 0, b: 4, room: 0, bIncluded: false }), null);
  assert.equal(pickTitle({ top: 0, b: 0, room: 5, bIncluded: true }), null);
});
test("hot flag", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  assert.equal(isHot({ stage: "viewed", views: 2, last_view_at: "2026-10-10T00:00:00Z" }, now), true);
  assert.equal(isHot({ stage: "viewed", views: 1, last_view_at: "2026-10-21T02:00:00Z" }, now), true);
  assert.equal(isHot({ stage: "viewed", views: 1, last_view_at: "2026-10-19T02:00:00Z" }, now), false);
  assert.equal(isHot({ stage: "replied", views: 5, last_view_at: "2026-10-21T02:00:00Z", last_inbound_at: "2026-10-21T03:00:00Z" }, now), false);
  assert.equal(isHot({ stage: "won", views: 5, last_view_at: "2026-10-21T02:00:00Z" }, now), false);
  assert.equal(isHot({ stage: "emailed", views: 2, last_view_at: "2026-10-10T00:00:00Z" }, now), true);
  assert.equal(isHot({ stage: "call_booked", views: 5, last_view_at: "2026-10-21T02:00:00Z" }, now), false);
  assert.equal(isHot({ stage: "needs_nik", views: 5, last_view_at: "2026-10-21T02:00:00Z" }, now), false);
});

// Beyond Step 1: Part A edge cases and the exact constants other stages import.
test("constants are the contract", () => {
  assert.deepEqual(GRADES, ["A+", "A", "B", "C", "D"]);
  assert.deepEqual(GRADE_TOKENS, { ap: "A+", a: "A", b: "B", c: "C", d: "D", none: null });
  assert.deepEqual(STAGE_TOKENS, ["ready", "emailed", "viewed", "replied", "needs_nik", "call_booked", "won", "lost", "none"]);
  assert.deepEqual(STAGE_LABELS, { ready: "Ready to email", emailed: "Emailed", viewed: "Opened demo", replied: "Replied",
    needs_nik: "Needs you", call_booked: "Call booked", won: "Won", lost: "Lost", none: "Not contacted" });
  assert.equal(PAGE_SIZE, 50);
});
test("filters: defaults, exact tokens, repeats and reserved names", () => {
  assert.deepEqual(P(""), { view: "ready", grades: null, trade: null, town: null, email: null, stages: null,
    researched: null, q: "", excluded: false, job: null, page: 1 });
  assert.equal(P("grade=A").grades, null);                            // tokens are lower-case, never folded
  assert.equal(P("grade=__proto__,constructor,toString").grades, null);
  assert.equal(P("stage=constructor,Ready").stages, null);
  assert.deepEqual(P("grade=b&grade=ap,b").grades, ["B", "A+"]);    // repeated params merge, no repeats
  assert.deepEqual(P("grade=ap%2Ca").grades, ["A+", "A"]);
  assert.equal(P("q=" + "😀".repeat(150)).q, "😀".repeat(100));     // 100 characters, never half an emoji
  assert.equal(P("q=%20%20").q, "");
  assert.deepEqual([P("page=-2").page, P("page=2.5").page], [1, 1]);
  assert.deepEqual([P("researched=1").researched, P("researched=0").researched, P("excluded=true").excluded], [true, false, false]);
});
test("warm-up date counts only active cold mailboxes", () => {
  const m = (o) => ({ role: "cold", status: "active", started_on: "2026-10-20", cap_override: null, ...o });
  assert.equal(warmupFrom([m({ status: "paused" })], "2026-10-21"), null);
  assert.equal(warmupFrom([m({ role: "system", started_on: "2026-08-01" })], "2026-10-21"), null);
  assert.equal(warmupFrom([m({ cap_override: 0 })], "2026-10-21"), null);
  assert.equal(warmupFrom([m({ cap_override: 4, started_on: "2026-11-10" })], "2026-10-21"), "2026-11-10");
  assert.equal(warmupFrom([m({ started_on: "2026-08-01" })], "2026-10-21"), "2026-10-21");
  assert.equal(warmupFrom([m({ started_on: "2026-10-12" })], "2026-10-24"), "2026-10-26"); // across the clock change
  assert.equal(warmupFrom([m({ started_on: "2026-12-20" })], "2026-10-21"), null);         // beyond 60 days
});
test("banner: paused only when every cold mailbox is, singulars, room as given", () => {
  const c = { mailboxes: 2, paused: [{ address: "a@aetoswebsites.com", reason: "you paused it on Setup." }], cap: 3,
    sent: 0, followupsDue: 1, firstQueued: 0, room: 2, warmupFrom: null };
  assert.equal(capacityBanner(c).text, "You can send 2 first emails today (3 a day, 1 follow-up already due).");
  const both = { ...c, paused: [...c.paused, { address: "b@aetoswebsites.com", reason: "x" }], cap: 0, room: 0 };
  assert.deepEqual(capacityBanner(both), { tone: "warn", text: "Sending is paused: you paused it on Setup. Fix it on Setup.",
    link: { href: "#/setup", label: "Open Setup" } });
  assert.equal(capacityBanner({ ...c, paused: [], cap: 1, followupsDue: 0, room: 1 }).text, "You can send 1 first email today (1 a day).");
  assert.deepEqual(capacityBanner({ ...c, paused: [], cap: 0, room: 0, warmupFrom: "2026-10-26" }),
    { tone: "info", text: "Your mailbox is warming up. First emails can go from Mon 26 Oct.", link: null });
  // Stage 6 caps room below the formula inside capacityNow: the banner uses it as given.
  assert.equal(capacityBanner({ ...c, paused: [], cap: 10, followupsDue: 0, room: 0 }).text,
    "No room for more first emails today (10 a day). The next ones can go tomorrow.");
  // cap 0 with no warm-up date is not "warming up": it sends Nik to Setup.
  const stuck = capacityBanner({ ...c, paused: [], cap: 0, room: 0, warmupFrom: null });
  assert.equal(stuck.tone, "warn");
  assert.deepEqual(stuck.link, { href: "#/setup", label: "Open Setup" });
  assert.doesNotMatch(stuck.text, /warming up/);
});
// Cold email only goes Mon–Sat 07:00–19:00 UK (stage 0's COLD_WINDOW): capacityNow adds today, sendDay (the UK day of
// the next send) and nextDay (the first send day after today), and the banner never says "today" when nothing can go.
test("banner outside the send window: written now, sent from the next send day's 07:00", () => {
  const c = { mailboxes: 1, paused: [], cap: 10, sent: 0, followupsDue: 7, firstQueued: 0, room: 3, warmupFrom: null };
  // Sun 25 Oct (or Sat after 19:00): nothing goes until Mon 26 Oct 07:00.
  assert.deepEqual(capacityBanner({ ...c, today: "2026-10-25", sendDay: "2026-10-26", nextDay: "2026-10-26" }), {
    tone: "ok", text: "You can write 3 first emails now. They go out Mon 26 Oct from 07:00 (10 a day, 7 follow-ups already due).", link: null,
  });
  assert.equal(capacityBanner({ ...c, room: 1, today: "2026-10-24", sendDay: "2026-10-26", nextDay: "2026-10-26" }).text,
    "You can write 1 first email now. They go out Mon 26 Oct from 07:00 (10 a day, 7 follow-ups already due).");
  // Inside the window the spec's text stands.
  assert.equal(capacityBanner({ ...c, today: "2026-10-24", sendDay: "2026-10-24", nextDay: "2026-10-26" }).text,
    "You can send 3 first emails today (10 a day, 7 follow-ups already due).");
});
test("banner with no room on a Saturday: the next ones go on Monday, not tomorrow", () => {
  const c = { mailboxes: 1, paused: [], cap: 10, sent: 3, followupsDue: 7, firstQueued: 0, room: 0, warmupFrom: null };
  assert.deepEqual(capacityBanner({ ...c, today: "2026-10-24", sendDay: "2026-10-24", nextDay: "2026-10-26" }), {
    tone: "info",
    text: "No room for more first emails today (10 a day, 7 follow-ups already due, 3 already sent). The next ones can go on Mon 26 Oct.",
    link: null,
  });
  // After 19:00 on Saturday too.
  assert.equal(capacityBanner({ ...c, today: "2026-10-24", sendDay: "2026-10-26", nextDay: "2026-10-26" }).text,
    "No room for more first emails today (10 a day, 7 follow-ups already due, 3 already sent). The next ones can go on Mon 26 Oct.");
  // Friday (Saturday is a send day) and Sunday (Monday is): tomorrow.
  for (const [today, sendDay, nextDay] of [["2026-10-23", "2026-10-23", "2026-10-24"], ["2026-10-25", "2026-10-26", "2026-10-26"]]) {
    assert.equal(capacityBanner({ ...c, today, sendDay, nextDay }).text,
      "No room for more first emails today (10 a day, 7 follow-ups already due, 3 already sent). The next ones can go tomorrow.");
  }
});
test("warm-up date is a send day, never a Sunday", () => {
  const m = (o) => ({ role: "cold", status: "active", started_on: "2026-10-25", cap_override: null, ...o });
  // Started Sun 25 Oct: the ramp reaches 3 a day on Sun 8 Nov, when no cold email goes; Mon 9 Nov is the first day.
  assert.equal(warmupFrom([m()], "2026-10-25"), "2026-11-09");
  assert.equal(warmupFrom([m()], "2026-10-26"), "2026-11-09");
  // A mailbox already sending, asked on a Sunday: Monday.
  assert.equal(warmupFrom([m({ started_on: "2026-08-01" })], "2026-10-25"), "2026-10-26");
});
test("hot flag: stage 5's 24-hour edge", () => {
  const NOW = new Date("2026-10-21T13:05:00Z");
  assert.equal(isHot({ stage: "viewed", views: 1, last_view_at: "2026-10-20T14:00:00Z", last_inbound_at: null }, NOW), true);
  assert.equal(isHot({ stage: "viewed", views: 1, last_view_at: "2026-10-20T12:00:00Z", last_inbound_at: null }, NOW), false);
  assert.equal(isHot({ stage: "emailed", views: 3, last_view_at: "2026-10-21T13:00:00Z", last_inbound_at: "2026-10-21T13:01:00Z" }, NOW), false);
  assert.equal(isHot({ stage: "emailed", views: 0, last_view_at: null }, NOW), false);
  assert.equal(isHot({ stage: "ready", views: 3, last_view_at: "2026-10-21T13:00:00Z" }, NOW), false);
});
