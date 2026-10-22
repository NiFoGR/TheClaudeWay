// Mailbox capacity: the warm-up ramp, each mailbox's daily cold cap, and which mailbox sends next.
// Run: node --test control-room/tests/capacity.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mailboxCap, pickMailbox, rampCap } from "../functions/_lib/mail/capacity.js";
import { ukDate } from "../functions/_lib/ukTime.js";

const s = "2026-10-01";

test("rampCap follows the warm-up table (0 before the start and for days 0-13, then 3/5/8/10)", () => {
  for (const [d, n] of [["2026-09-30",0],["2026-10-01",0],["2026-10-14",0],["2026-10-15",3],["2026-10-21",3],["2026-10-22",5],
    ["2026-10-28",5],["2026-10-29",8],["2026-11-04",8],["2026-11-05",10],["2027-01-01",10]]) assert.equal(rampCap(s, d), n, d);
});

test("rampCap counts whole UK days across the clock change", () => {
  // 25 Oct 2026 is the BST -> GMT change; day counting is by date string, never by hours.
  assert.equal(rampCap("2026-10-11", "2026-10-25"), 3); // day 14
  assert.equal(rampCap("2026-10-12", "2026-10-25"), 0); // day 13
});

test("rampCap counts calendar days across month, year, leap-day and March clock-change boundaries", () => {
  assert.equal(rampCap("2027-12-20", "2028-01-02"), 0); // day 13
  assert.equal(rampCap("2027-12-20", "2028-01-03"), 3); // day 14, over the new year
  assert.equal(rampCap("2028-02-15", "2028-02-29"), 3); // 29 Feb 2028 is a real date, day 14
  assert.equal(rampCap("2027-03-14", "2027-03-28"), 3); // 28 Mar 2027 is the GMT -> BST change, day 14
  assert.equal(rampCap("2027-03-15", "2027-03-28"), 0); // day 13
});

test("rampCap is 0 for a started_on it can't read (never over-sends)", () => {
  assert.equal(rampCap(null, "2026-10-21"), 0);
  assert.equal(rampCap("not a date", "2026-10-21"), 0);
  assert.equal(rampCap("2026-02-30", "2026-10-21"), 0);
  assert.equal(mailboxCap({started_on:"2026-02-30", cap_override:null, status:"active"}, "2026-10-21"), 0);
});

test("an unreadable UK today is the caller's bug: it throws, never a silent cap of 0", () => {
  const ramp = {id:"a",role:"cold",status:"active",started_on:s,cap_override:null};
  for (const bad of ["2026-10-22T09:00:00Z", new Date("2026-10-22T09:00:00Z"), undefined, null, "2026-02-30"]) {
    assert.throws(() => rampCap(s, bad), /UK date must look like YYYY-MM-DD/, String(bad));
    assert.throws(() => mailboxCap({...ramp, cap_override:20}, bad), /UK date must look like YYYY-MM-DD/, String(bad));
    assert.throws(() => mailboxCap({...ramp, status:"paused"}, bad), /UK date must look like YYYY-MM-DD/, String(bad));
    assert.throws(() => pickMailbox([ramp], {}, bad), /UK date must look like YYYY-MM-DD/, String(bad));
    assert.throws(() => pickMailbox([], {}, bad), /UK date must look like YYYY-MM-DD/, String(bad));
  }
});

test("the warm-up day turns at UK midnight, not UTC midnight (ukDate feeds ukToday)", () => {
  const m = {id:"a",role:"cold",status:"active",started_on:s,cap_override:null};
  // 23:30 UTC on 14 Oct is 00:30 BST on 15 Oct: day 14 in the UK, so 3 cold sends are allowed.
  assert.equal(mailboxCap(m, ukDate(new Date("2026-10-14T23:30:00Z"))), 3);
  assert.equal(mailboxCap(m, ukDate(new Date("2026-10-14T22:30:00Z"))), 0); // 23:30 BST on 14 Oct: day 13
  // After the 25 Oct change the UK is on GMT: 23:30 UTC on 4 Nov is still 4 Nov (day 34 → 8), 00:00 UTC is 5 Nov (→ 10).
  assert.equal(mailboxCap(m, ukDate(new Date("2026-11-04T23:30:00Z"))), 8);
  assert.equal(mailboxCap(m, ukDate(new Date("2026-11-05T00:00:00Z"))), 10);
});

test("mailboxCap: cap_override when set, the ramp otherwise, 0 when paused", () => {
  assert.equal(mailboxCap({started_on:s, cap_override:20, status:"active"}, "2026-10-02"), 20);
  assert.equal(mailboxCap({started_on:s, cap_override:20, status:"paused"}, "2026-11-30"), 0);
  assert.equal(mailboxCap({started_on:s, cap_override:null, status:"active"}, "2026-10-22"), 5);
  assert.equal(mailboxCap({started_on:s, cap_override:null, status:"paused"}, "2026-11-30"), 0);
  assert.equal(mailboxCap({started_on:s, cap_override:0, status:"active"}, "2026-11-30"), 0); // 0 is a real override
  assert.equal(mailboxCap({started_on:"2026-12-01", cap_override:null, status:"active"}, "2026-11-30"), 0); // future start
});

test("mailboxCap: a start date after today is 0 even with cap_override (the mailbox isn't bought yet)", () => {
  assert.equal(mailboxCap({started_on:"2026-12-01", cap_override:20, status:"active"}, "2026-11-30"), 0);
  assert.equal(mailboxCap({started_on:"2026-12-01", cap_override:20, status:"active"}, "2026-12-01"), 20); // day 0
});

test("mailboxCap: an override read from a form or the database", () => {
  assert.equal(mailboxCap({started_on:s, cap_override:"20", status:"active"}, "2026-10-02"), 20);
  assert.equal(mailboxCap({started_on:s, cap_override:7.9, status:"active"}, "2026-10-02"), 7);
  assert.equal(mailboxCap({started_on:s, cap_override:-4, status:"active"}, "2026-10-02"), 0);
  // Blank or unreadable means "not set": the warm-up ramp applies (day 21 → 5), never a silent 0 or a big number.
  for (const v of [undefined, "", "  ", "abc", true, false, Infinity, NaN]) {
    assert.equal(mailboxCap({started_on:s, cap_override:v, status:"active"}, "2026-10-22"), 5, String(v));
  }
  assert.equal(mailboxCap({started_on:s, status:"active"}, "2026-10-22"), 5); // no cap_override field at all
  assert.equal(mailboxCap({started_on:s, cap_override:null}, "2026-10-22"), 5); // no status field: not paused
  assert.equal(mailboxCap(null, "2026-10-22"), 0);
});

test("pickMailbox ranks by room left (cap minus sent), not by fewest sent", () => {
  const ramp = {id:"a",role:"cold",status:"active",started_on:"2026-01-01",cap_override:null}; // cap 10
  const small = {...ramp, id:"b", cap_override:3};
  // a: 10 - 5 = 5 left; b: 3 - 0 = 3 left. Fewest-sent would wrongly pick b.
  assert.equal(pickMailbox([small, ramp], {a:5}, "2026-10-19").id, "a");
  const big = {...ramp, id:"c", cap_override:20};
  assert.equal(pickMailbox([ramp, big], {a:4, c:12}, "2026-10-19").id, "c"); // 6 left vs 8 left
  assert.equal(pickMailbox([ramp, {...big, started_on:"2026-10-20"}], {a:10}, "2026-10-19"), null); // future start
});

test("pickMailbox: the active cold mailbox with the most room, ties by id, null when none has room", () => {
  const a = {id:"a",role:"cold",status:"active",started_on:"2026-01-01",cap_override:null};
  const b = {...a, id:"b"}; const sys = {...a, id:"c", role:"system"};
  assert.equal(pickMailbox([a,b,sys], {a:4,b:2}, "2026-10-19").id, "b");
  assert.equal(pickMailbox([a,b], {a:10,b:10}, "2026-10-19"), null);
  assert.equal(pickMailbox([a,b], {}, "2026-10-19").id, "a");
});

test("pickMailbox ignores system and paused mailboxes and breaks ties by id ascending in any order", () => {
  const a = {id:"a",role:"cold",status:"active",started_on:"2026-01-01",cap_override:null};
  const b = {...a, id:"b"};
  assert.equal(pickMailbox([b, a], {}, "2026-10-19").id, "a");
  assert.equal(pickMailbox([{...a, role:"system"}], {}, "2026-10-19"), null);
  assert.equal(pickMailbox([{...a, status:"paused"}, b], {b:9}, "2026-10-19").id, "b");
  assert.equal(pickMailbox([{...a, status:"paused"}], {}, "2026-10-19"), null);
  assert.equal(pickMailbox([{...a, started_on:"2026-10-10"}], {}, "2026-10-19"), null); // still warming up
  assert.equal(pickMailbox([a], {a:11}, "2026-10-19"), null); // over the cap is no room, not negative room
  assert.equal(pickMailbox([], {}, "2026-10-19"), null);
  assert.equal(pickMailbox([a], undefined, "2026-10-19").id, "a");
});
