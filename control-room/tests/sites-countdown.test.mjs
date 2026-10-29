// The 7-day guarantee clock and its countdown labels (stage 10, Task 8).
// Run: node --test control-room/tests/sites-countdown.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countdown, dueFrom, ukShortDay } from "../functions/_lib/sites/countdown.js";

const due = "2026-10-31T22:30:00Z";
const now = new Date("2026-11-03T12:00:00Z");

test("due date is submitted + 168 h exactly, across the clocks going back on 25 Oct", () => {
  assert.equal(dueFrom("2026-10-24T22:30:00Z"), "2026-10-31T22:30:00Z");
});

test("ukShortDay prints the UK day", () => {
  assert.equal(ukShortDay("2026-10-31T22:30:00Z"), "Sat 31 Oct");
});

test("before live: days left, red under 48 h, late after the due time", () => {
  assert.deepEqual(countdown("2026-10-31T22:30:00Z", null, new Date("2026-10-25T10:00:00Z")),
    {label: "Due live Sat 31 Oct · 6 days left", level: "grey", hoursLeft: 156.5});
  assert.equal(countdown(due, null, new Date("2026-10-29T23:00:00Z")).level, "red");      // 47.5 h
  assert.equal(countdown(due, null, new Date("2026-10-31T10:00:00Z")).label, "Due live Sat 31 Oct · less than a day left");
  assert.equal(countdown(due, null, new Date("2026-11-02T23:00:00Z")).label, "2 days late");
});

test("after live: on time is green, late is amber", () => {
  assert.deepEqual(countdown(due, "2026-10-30T09:00:00Z", now).label, "Live Fri 30 Oct · on time");
  assert.equal(countdown(due, "2026-11-01T09:00:00Z", now).level, "amber");                // "Live Sun 1 Nov · 1 day late"
  assert.deepEqual(countdown(due, "2026-10-30T09:00:00Z", now).level, "green");
  assert.equal(countdown(due, "2026-11-01T09:00:00Z", now).label, "Live Sun 1 Nov · 1 day late");
});

test("edges: exactly 48 h is not red, 1 day left is singular, past due is red", () => {
  assert.equal(countdown(due, null, new Date("2026-10-29T22:30:00Z")).level, "grey");
  assert.equal(countdown(due, null, new Date("2026-10-30T12:00:00Z")).label, "Due live Sat 31 Oct · 1 day left");
  const late = countdown(due, null, new Date("2026-10-31T23:00:00Z"));
  assert.deepEqual(late, {label: "1 day late", level: "red", hoursLeft: -0.5});
});

test("a bad date says what's wrong", () => {
  assert.throws(() => dueFrom("not a date"), /submitted date/);
});

test("UK days and the absolute clock in summer time", () => {
  // 23:30 UTC in BST is 00:30 the next UK day.
  assert.equal(ukShortDay("2026-07-04T23:30:00Z"), "Sun 5 Jul");
  // Across the clocks going forward (29 Mar 2026): still exactly 168 h, milliseconds kept.
  assert.equal(dueFrom("2026-03-28T12:00:00Z"), "2026-04-04T12:00:00Z");
  assert.equal(dueFrom("2026-10-24T22:30:00.123Z"), "2026-10-31T22:30:00.123Z");
  // A due time just after UK midnight in BST is labelled with the UK day, not the UTC one.
  assert.equal(countdown("2026-07-04T23:30:00Z", null, new Date("2026-07-01T23:30:00Z")).label,
    "Due live Sun 5 Jul · 3 days left");
});

test("live exactly at the due moment is on time; a past-due site's hoursLeft is negative", () => {
  assert.deepEqual(countdown(due, due, now), {label: "Live Sat 31 Oct · on time", level: "green", hoursLeft: 0});
  assert.equal(countdown(due, "2026-11-01T09:00:00Z", now).hoursLeft, -10.5);
  assert.equal(countdown(due, null, new Date("2026-11-02T23:00:00Z")).level, "red");
  assert.equal(countdown(due, null, "2026-10-25T10:00:00Z").hoursLeft, 156.5);
});

test("a timestamp without a zone is read as UTC, whatever the machine's time zone", () => {
  assert.equal(dueFrom("2026-10-24 22:30:00"), "2026-10-31T22:30:00Z");
  assert.equal(dueFrom("2026-10-24T22:30:00"), "2026-10-31T22:30:00Z");
  assert.equal(countdown("2026-10-31 22:30:00", null, new Date("2026-10-25T10:00:00Z")).hoursLeft, 156.5);
  assert.throws(() => countdown("", null, new Date()), /due date/);
});
