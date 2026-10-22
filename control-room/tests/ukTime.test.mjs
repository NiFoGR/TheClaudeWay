// UK time helpers (Europe/London, BST/GMT). Run: node --test control-room/tests/ukTime.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  addUkDays, inUkWindow, isWeekendUK, nextUkWindowStart, ukDate, ukDayStartUtc, ukParts, ukToUtc,
} from "../functions/_lib/ukTime.js";

const W = {start: "07:00", end: "19:00", days: [1,2,3,4,5,6]};

test("ukParts and ukDate read the UK wall clock (Friday 23:30 UTC in BST is Saturday)", () => {
  assert.deepEqual(ukParts(new Date("2026-10-23T23:30:00Z")), {y:2026,m:10,d:24,hh:0,mm:30,weekday:6});
  assert.equal(ukDate(new Date("2026-10-23T23:30:00Z")), "2026-10-24");
});

test("ukToUtc handles BST, GMT, the doubled hour and the missing hour", () => {
  assert.equal(ukToUtc("2026-07-01","11:00").toISOString(), "2026-07-01T10:00:00.000Z");
  assert.equal(ukToUtc("2026-12-01","11:00").toISOString(), "2026-12-01T11:00:00.000Z");
  assert.equal(ukToUtc("2026-10-25","01:30").toISOString(), "2026-10-25T00:30:00.000Z"); // first of the two
  assert.equal(ukToUtc("2026-03-29","01:30").toISOString(), "2026-03-29T01:30:00.000Z"); // gap
});

test("isWeekendUK uses the UK day", () => {
  assert.equal(isWeekendUK(new Date("2026-10-23T23:30:00Z")), true);   // Sat 00:30 BST
  assert.equal(isWeekendUK(new Date("2026-11-01T23:30:00Z")), true);   // Sun 23:30 GMT
  assert.equal(isWeekendUK(new Date("2026-11-02T00:00:00Z")), false);  // Mon 00:00
});

test("inUkWindow: start inclusive, end exclusive, listed days only", () => {
  assert.equal(inUkWindow(ukToUtc("2026-10-24","18:59"), W), true);
  assert.equal(inUkWindow(ukToUtc("2026-10-24","19:00"), W), false);
  assert.equal(inUkWindow(ukToUtc("2026-10-25","10:00"), W), false);    // Sunday
});

test("nextUkWindowStart skips to the next open day, or returns the date itself when inside", () => {
  assert.equal(nextUkWindowStart(ukToUtc("2026-10-24","19:30"), W).toISOString(), ukToUtc("2026-10-26","07:00").toISOString());
  assert.equal(nextUkWindowStart(ukToUtc("2026-10-26","06:59"), W).toISOString(), ukToUtc("2026-10-26","07:00").toISOString());
  const inside = ukToUtc("2026-10-26","08:00"); assert.equal(nextUkWindowStart(inside, W), inside);
});

test("addUkDays and ukDayStartUtc", () => {
  assert.equal(addUkDays("2026-10-24", 1), "2026-10-25"); assert.equal(addUkDays("2026-03-01", -1), "2026-02-28");
  assert.equal(ukDayStartUtc(new Date("2026-07-01T12:00:00Z")).toISOString(), "2026-06-30T23:00:00.000Z");
});

// Extra edges (Review Focus 3).

test("the clock changes, read back as UTC instants", () => {
  // Saturday 19:00 BST is 18:00Z; Monday 07:00 after the change back is 07:00Z.
  assert.equal(ukToUtc("2026-10-24","19:00").toISOString(), "2026-10-24T18:00:00.000Z");
  assert.equal(nextUkWindowStart(new Date("2026-10-24T18:30:00Z"), W).toISOString(), "2026-10-26T07:00:00.000Z");
  // Monday 06:59 in BST, the day after the spring change, waits one minute.
  assert.equal(nextUkWindowStart(ukToUtc("2026-03-30","06:59"), W).toISOString(), "2026-03-30T06:00:00.000Z");
  // Both 01:30s on 25 Oct read back as 01:30 UK.
  assert.deepEqual(ukParts(new Date("2026-10-25T00:30:00Z")), {y:2026,m:10,d:25,hh:1,mm:30,weekday:0});
  assert.deepEqual(ukParts(new Date("2026-10-25T01:30:00Z")), {y:2026,m:10,d:25,hh:1,mm:30,weekday:0});
  // The missing 01:30 on 29 Mar lands at 02:30 BST.
  assert.deepEqual(ukParts(ukToUtc("2026-03-29","01:30")), {y:2026,m:3,d:29,hh:2,mm:30,weekday:0});
  // Midnight UK on both change days, and the first GMT day.
  assert.equal(ukDayStartUtc(new Date("2026-10-25T12:00:00Z")).toISOString(), "2026-10-24T23:00:00.000Z");
  assert.equal(ukDayStartUtc(new Date("2026-03-29T12:00:00Z")).toISOString(), "2026-03-29T00:00:00.000Z");
  assert.equal(ukDayStartUtc(new Date("2026-10-26T00:00:00Z")).toISOString(), "2026-10-26T00:00:00.000Z");
});

test("the exact clock-change instants, and 2027's changes from the zone data", () => {
  // 29 Mar 2026: 00:59 GMT is followed by 02:00 BST.
  assert.deepEqual(ukParts(new Date("2026-03-29T00:59:59Z")), {y:2026,m:3,d:29,hh:0,mm:59,weekday:0});
  assert.deepEqual(ukParts(new Date("2026-03-29T01:00:00Z")), {y:2026,m:3,d:29,hh:2,mm:0,weekday:0});
  // 25 Oct 2026: 01:59 BST is followed by 01:00 GMT.
  assert.deepEqual(ukParts(new Date("2026-10-25T00:59:59Z")), {y:2026,m:10,d:25,hh:1,mm:59,weekday:0});
  assert.deepEqual(ukParts(new Date("2026-10-25T01:00:00Z")), {y:2026,m:10,d:25,hh:1,mm:0,weekday:0});
  // Either side of the missing hour and the doubled hour.
  assert.equal(ukToUtc("2026-03-29","00:59").toISOString(), "2026-03-29T00:59:00.000Z");
  assert.equal(ukToUtc("2026-03-29","02:00").toISOString(), "2026-03-29T01:00:00.000Z");
  assert.equal(ukToUtc("2026-10-25","00:59").toISOString(), "2026-10-24T23:59:00.000Z");
  assert.equal(ukToUtc("2026-10-25","01:00").toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(ukToUtc("2026-10-25","02:00").toISOString(), "2026-10-25T02:00:00.000Z");
  // 2027 changes on 28 Mar and 31 Oct: nothing is tied to 2026's dates.
  assert.equal(ukToUtc("2027-03-28","01:30").toISOString(), "2027-03-28T01:30:00.000Z"); // gap
  assert.equal(ukToUtc("2027-10-31","01:30").toISOString(), "2027-10-31T00:30:00.000Z"); // first of the two
  assert.equal(ukToUtc("2027-03-27","12:00").toISOString(), "2027-03-27T12:00:00.000Z");
  assert.equal(ukToUtc("2027-03-29","12:00").toISOString(), "2027-03-29T11:00:00.000Z");
  assert.equal(isWeekendUK(new Date("2027-10-29T23:30:00Z")), true);  // Fri 23:30 UTC = Sat 00:30 BST
});

test("seconds don't move the window edges", () => {
  assert.equal(inUkWindow(new Date("2026-10-24T17:59:59.999Z"), W), true);   // Sat 18:59:59 BST
  assert.equal(inUkWindow(new Date("2026-10-24T18:00:00Z"), W), false);      // Sat 19:00 BST
  assert.equal(nextUkWindowStart(new Date("2026-10-26T06:59:59.500Z"), W).toISOString(), "2026-10-26T07:00:00.000Z");
  assert.equal(ukDayStartUtc(new Date("2026-10-24T23:00:00.000Z")).toISOString(), "2026-10-24T23:00:00.000Z");
});

test("window edges: exactly 07:00 Monday is inside; Saturday 19:00 goes to Monday", () => {
  const mon7 = ukToUtc("2026-10-26","07:00");
  assert.equal(inUkWindow(mon7, W), true);
  assert.equal(inUkWindow(ukToUtc("2026-10-26","06:59"), W), false);
  assert.equal(nextUkWindowStart(mon7, W), mon7);
  assert.equal(nextUkWindowStart(ukToUtc("2026-10-24","19:00"), W).toISOString(), mon7.toISOString());
  // Sunday morning, before the window would have opened on a weekday.
  assert.equal(nextUkWindowStart(ukToUtc("2026-10-25","06:00"), W).toISOString(), mon7.toISOString());
});

test("a one-day window scans up to a week ahead", () => {
  const sundays = {start: "10:00", end: "12:00", days: [0]};
  assert.equal(nextUkWindowStart(ukToUtc("2026-11-01","12:00"), sundays).toISOString(), "2026-11-08T10:00:00.000Z");
  assert.throws(() => nextUkWindowStart(new Date("2026-11-01T12:00:00Z"), {start: "10:00", end: "12:00", days: []}), /no open hours/);
});

test("midnight reads as hour 0 of the new UK day, in BST and in GMT", () => {
  assert.deepEqual(ukParts(new Date("2026-12-01T00:00:00Z")), {y:2026,m:12,d:1,hh:0,mm:0,weekday:2});
  assert.deepEqual(ukParts(new Date("2026-07-01T23:00:00Z")), {y:2026,m:7,d:2,hh:0,mm:0,weekday:4});
  assert.equal(ukDate(new Date("2026-07-01T22:59:59Z")), "2026-07-01");
  assert.equal(ukDate(new Date("2026-11-01T23:59:59Z")), "2026-11-01");
  assert.equal(ukDate(new Date("2026-11-02T00:00:00Z")), "2026-11-02");
});

test("the weekend starts and ends at UK midnight (the weekend price ends Sunday midnight)", () => {
  assert.equal(isWeekendUK(new Date("2026-10-23T22:59:59Z")), false);  // Fri 23:59:59 BST
  assert.equal(isWeekendUK(new Date("2026-10-23T23:00:00Z")), true);   // Sat 00:00 BST
  assert.equal(isWeekendUK(new Date("2026-10-18T22:59:59Z")), true);   // Sun 23:59:59 BST
  assert.equal(isWeekendUK(new Date("2026-10-18T23:00:00Z")), false);  // Mon 00:00 BST
  assert.equal(isWeekendUK(new Date("2026-11-01T23:59:59Z")), true);   // Sun 23:59:59 GMT
  assert.equal(isWeekendUK(new Date("2026-10-30T23:30:00Z")), false);  // Fri 23:30 GMT
});

test("reply hours (every day, 07:00 to 23:30) across both clock changes", () => {
  const R = {start: "07:00", end: "23:30", days: [0,1,2,3,4,5,6]};
  assert.equal(inUkWindow(new Date("2026-10-24T06:30:00Z"), R), true);   // 07:30 BST
  assert.equal(inUkWindow(new Date("2026-10-25T06:30:00Z"), R), false);  // 06:30 GMT
  assert.equal(inUkWindow(new Date("2026-10-24T22:29:00Z"), R), true);   // 23:29 BST
  assert.equal(inUkWindow(new Date("2026-10-24T22:30:00Z"), R), false);  // 23:30 BST
  assert.equal(nextUkWindowStart(new Date("2026-10-24T22:45:00Z"), R).toISOString(), "2026-10-25T07:00:00.000Z");
  assert.equal(nextUkWindowStart(new Date("2026-03-28T23:45:00Z"), R).toISOString(), "2026-03-29T06:00:00.000Z");
});

test("windows touching the clock-change hour agree with inUkWindow", () => {
  // 29 Mar: 01:00 GMT jumps to 02:00 BST, so a window from 01:30 is open from the jump (01:00Z), not 01:30Z.
  const gap = {start: "01:30", end: "03:00", days: [0]};
  assert.equal(inUkWindow(new Date("2026-03-29T01:00:00Z"), gap), true);
  assert.equal(nextUkWindowStart(new Date("2026-03-29T00:30:00Z"), gap).toISOString(), "2026-03-29T01:00:00.000Z");
  // 25 Oct: 01:15 happens twice, so the window opens again at the second 01:15 (01:15Z).
  const twice = {start: "01:15", end: "02:45", days: [0]};
  assert.equal(inUkWindow(new Date("2026-10-25T01:05:00Z"), twice), false);  // 01:05 GMT
  assert.equal(nextUkWindowStart(new Date("2026-10-25T01:05:00Z"), twice).toISOString(), "2026-10-25T01:15:00.000Z");
  // A window that closed at 01:30 BST reopens when the clocks go back to 01:00 GMT.
  const early = {start: "00:30", end: "01:30", days: [0]};
  assert.equal(nextUkWindowStart(new Date("2026-10-25T00:45:00Z"), early).toISOString(), "2026-10-25T01:00:00.000Z");
});

test("results don't depend on the host's time zone", () => {
  const was = process.env.TZ;
  try {
    for (const tz of ["Pacific/Kiritimati", "America/Los_Angeles", "UTC"]) {
      process.env.TZ = tz;
      assert.equal(ukToUtc("2026-10-25","01:30").toISOString(), "2026-10-25T00:30:00.000Z", tz);
      assert.equal(ukToUtc("2026-03-29","01:30").toISOString(), "2026-03-29T01:30:00.000Z", tz);
      assert.equal(ukDate(new Date("2026-10-23T23:30:00Z")), "2026-10-24", tz);
      assert.equal(ukDayStartUtc(new Date("2026-07-01T12:00:00Z")).toISOString(), "2026-06-30T23:00:00.000Z", tz);
      assert.equal(addUkDays("2026-03-29", 1), "2026-03-30", tz);
      assert.equal(nextUkWindowStart(ukToUtc("2026-10-24","19:30"), W).toISOString(), "2026-10-26T07:00:00.000Z", tz);
    }
  } finally {
    if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  }
});

test("addUkDays crosses months, years and leap days", () => {
  assert.equal(addUkDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addUkDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addUkDays("2026-10-24", 0), "2026-10-24");
  assert.equal(addUkDays("2026-01-15", 60), "2026-03-16");
});

test("bad input is refused, not turned into an Invalid Date", () => {
  assert.throws(() => ukToUtc("24/10/2026", "07:00"), /YYYY-MM-DD/);
  assert.throws(() => ukToUtc("2026-10-24", "7am"), /HH:MM/);
  assert.throws(() => ukToUtc("2026-10-24", "25:00"), /HH:MM/);
  assert.throws(() => addUkDays("2026-10-24", 1.5), /whole number/);
  assert.throws(() => ukDate(new Date("nope")), /valid date/);
});
