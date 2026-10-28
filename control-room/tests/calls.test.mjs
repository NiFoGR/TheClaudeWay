// Call slots (pure): Nik's 11am slots, holds, confirm rules, call-time Todos. Run: node --test control-room/tests/calls.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  CALL_SLOTS, OFFER_HOLD_HOURS, callTimeDue, callTodoTitle, canHold, isSlot, nextFreeSlots, offerExpired, slotLabel,
  takenFrom,
} from "../functions/_lib/calls.js";

const D = (s) => new Date(s), iso = (ds) => ds.map((d) => d.toISOString().replace(".000", ""));

test("the slot rules are the spec's values", () => {
  assert.deepEqual(CALL_SLOTS, { days: [2, 3, 5, 6, 0], time: "11:00", minLeadHours: 3, count: 3 });
  assert.equal(OFFER_HOLD_HOURS, 48);
});

test("soonest slots, BST", () => {
  assert.deepEqual(iso(nextFreeSlots(D("2026-10-19T19:00:00Z"), [])), ["2026-10-20T10:00:00Z", "2026-10-21T10:00:00Z", "2026-10-23T10:00:00Z"]);
  assert.deepEqual(iso(nextFreeSlots(D("2026-10-19T19:00:00Z"), [D("2026-10-20T10:00:00Z")])), ["2026-10-21T10:00:00Z", "2026-10-23T10:00:00Z", "2026-10-24T10:00:00Z"]);
});
test("a custom-time call blocks that day", () => {
  assert.equal(iso(nextFreeSlots(D("2026-10-19T19:00:00Z"), [D("2026-10-20T14:00:00Z")]))[0], "2026-10-21T10:00:00Z");
});
test("BST → GMT (25 Oct 2026) and GMT → BST (29 Mar 2026)", () => {
  assert.deepEqual(iso(nextFreeSlots(D("2026-10-23T12:00:00Z"), [])), ["2026-10-24T10:00:00Z", "2026-10-25T11:00:00Z", "2026-10-27T11:00:00Z"]);
  assert.deepEqual(iso(nextFreeSlots(D("2026-03-27T12:00:00Z"), [])), ["2026-03-28T11:00:00Z", "2026-03-29T10:00:00Z", "2026-03-31T10:00:00Z"]);
});
test("3-hour minimum lead", () => {
  assert.equal(iso(nextFreeSlots(D("2026-10-20T07:00:00Z"), []))[0], "2026-10-20T10:00:00Z");
  assert.equal(iso(nextFreeSlots(D("2026-10-20T07:01:00Z"), []))[0], "2026-10-21T10:00:00Z");
});
test("fully booked weeks", () => {
  const now = D("2026-10-19T19:00:00Z");
  const allSlots = (days) => { const out = []; for (let i = 0; i < days; i++) out.push(new Date(now.getTime() + i * 864e5 + 15 * 36e5)); return out; };
  assert.deepEqual(nextFreeSlots(now, allSlots(57)), []);
  assert.equal(iso(nextFreeSlots(now, allSlots(14)))[0], "2026-11-03T11:00:00Z");
});
test("labels, holds, confirm rules", () => {
  assert.equal(slotLabel(D("2026-10-20T10:00:00Z")), "Tuesday 20 October at 11am");
  assert.equal(slotLabel(D("2026-10-22T14:30:00Z")), "Thursday 22 October at 3:30pm");
  assert.equal(isSlot(D("2026-10-22T10:00:00Z")), false);           // Thursday
  const offer = { place_id: "a", status: "offered", created_at: "2026-10-19T19:00:00Z", slot_at: "2026-10-23T10:00:00Z" };
  assert.equal(offerExpired(offer, D("2026-10-21T18:59:00Z")), false);
  assert.equal(offerExpired(offer, D("2026-10-21T19:00:00Z")), true);
  assert.equal(offerExpired({ ...offer, slot_at: "2026-10-20T10:00:00Z" }, D("2026-10-20T10:00:00Z")), true);
  const now = D("2026-10-20T08:00:00Z");
  assert.deepEqual(canHold(D("2026-10-23T10:00:00Z"), "b", [offer], now), { ok: false, reason: "That day already has a call booked or offered." });
  assert.deepEqual(canHold(D("2026-10-23T10:00:00Z"), "a", [offer], now, { confirm: true }), { ok: true });
  assert.deepEqual(canHold(D("2026-10-23T10:00:00Z"), "b", [offer], D("2026-10-21T19:00:00Z"), { confirm: true }), { ok: true });
  assert.equal(canHold(D("2026-10-22T10:00:00Z"), "b", [], now).reason, "That isn't one of Nik's call slots (11am Tue, Wed, Fri, Sat, Sun).");
  assert.equal(canHold(D("2026-10-20T10:00:00Z"), "b", [], D("2026-10-20T09:31:00Z"), { confirm: true }).reason, "That slot has passed or is under 30 minutes away.");
  assert.equal(canHold(D("2026-10-20T10:00:00Z"), "b", [], D("2026-10-20T07:30:00Z")).reason, "That slot is under 3 hours away: offer the next one.");
});
test("call-time due and todo title", () => {
  assert.deepEqual(callTimeDue(D("2026-10-20T15:59:00Z")), { due_at: D("2026-10-20T17:00:00Z"), promise: "by the end of the day", tomorrow: false });
  assert.deepEqual(callTimeDue(D("2026-10-20T16:00:00Z")), { due_at: D("2026-10-21T17:00:00Z"), promise: "by tomorrow evening", tomorrow: true });
  assert.equal(callTimeDue(D("2026-11-03T10:00:00Z")).due_at.toISOString(), "2026-11-03T18:00:00.000Z");
  assert.equal(callTodoTitle({ first: "Mark", business: "Diamond Kickboxing", slot_at: D("2026-10-20T10:00:00Z"), phone: "07969 770905" }), "Call Mark (Diamond Kickboxing) Tue 11:00 · 07969 770905");
  assert.equal(callTodoTitle({ first: null, business: "Diamond Kickboxing", slot_at: D("2026-10-20T10:00:00Z"), phone: null }), "Call Diamond Kickboxing Tue 11:00 · no number yet");
});

// Beyond the plan's listed assertions: the rules the db layer and routes lean on.
test("isSlot: 11:00 UK on Tue, Wed, Fri, Sat, Sun only, in both GMT and BST", () => {
  assert.equal(isSlot(D("2026-10-20T10:00:00Z")), true);            // Tue 11:00 BST
  assert.equal(isSlot(D("2026-10-25T11:00:00Z")), true);            // Sun 11:00 GMT (clocks went back that night)
  assert.equal(isSlot(D("2026-10-25T10:00:00Z")), false);           // Sun 10:00 GMT
  assert.equal(isSlot(D("2026-03-29T10:00:00Z")), true);            // Sun 11:00 BST (clocks went forward that night)
  assert.equal(isSlot(D("2026-10-19T10:00:00Z")), false);           // Monday
  assert.equal(isSlot(D("2026-10-20T10:00:30Z")), false);           // not on the minute
});

test("slotLabel: noon, midnight and GMT", () => {
  assert.equal(slotLabel(D("2026-10-25T11:00:00Z")), "Sunday 25 October at 11am");
  assert.equal(slotLabel(D("2026-12-01T12:00:00Z")), "Tuesday 1 December at 12pm");
  assert.equal(slotLabel(D("2026-12-01T00:05:00Z")), "Tuesday 1 December at 12:05am");
});

test("offerExpired only applies to offers", () => {
  const call = { place_id: "a", status: "confirmed", created_at: "2026-10-01T09:00:00Z", slot_at: "2026-10-23T10:00:00Z" };
  assert.equal(offerExpired(call, D("2026-10-22T10:00:00Z")), false);
  assert.equal(offerExpired({ ...call, status: "cancelled" }, D("2026-10-22T10:00:00Z")), false);
});

test("takenFrom: live offers and confirmed calls, minus this prospect's own offers", () => {
  const now = D("2026-10-20T08:00:00Z");
  const rows = [
    { place_id: "a", status: "offered", created_at: "2026-10-19T19:00:00Z", slot_at: "2026-10-23T10:00:00Z" },  // live
    { place_id: "b", status: "offered", created_at: "2026-10-17T07:00:00Z", slot_at: "2026-10-24T10:00:00Z" },  // expired
    { place_id: "c", status: "confirmed", created_at: "2026-10-18T07:00:00Z", slot_at: "2026-10-22T14:00:00Z" },
    { place_id: "a", status: "confirmed", created_at: "2026-10-18T07:00:00Z", slot_at: "2026-10-25T11:00:00Z" },
    { place_id: "d", status: "cancelled", created_at: "2026-10-18T07:00:00Z", slot_at: "2026-10-27T11:00:00Z" },
    { place_id: "e", status: "no_show", created_at: "2026-10-18T07:00:00Z", slot_at: "2026-10-28T11:00:00Z" },
  ];
  assert.deepEqual(iso(takenFrom(rows, now)).sort(), ["2026-10-22T14:00:00Z", "2026-10-23T10:00:00Z", "2026-10-25T11:00:00Z"]);
  assert.deepEqual(iso(takenFrom(rows, now, "a")).sort(), ["2026-10-22T14:00:00Z", "2026-10-25T11:00:00Z"]);
  // their own held slot shows as free to them, never to anyone else
  assert.equal(iso(nextFreeSlots(now, takenFrom(rows, now, "a"))).includes("2026-10-23T10:00:00Z"), true);
  assert.equal(iso(nextFreeSlots(now, takenFrom(rows, now, "b"))).includes("2026-10-23T10:00:00Z"), false);
});

test("canHold: a confirmed call (or Nik's custom time) blocks the day for everyone, a released offer frees it", () => {
  const now = D("2026-10-20T08:00:00Z");
  const custom = { place_id: "c", status: "confirmed", created_at: "2026-10-18T07:00:00Z", slot_at: "2026-10-23T14:00:00Z" };
  assert.equal(canHold(D("2026-10-23T10:00:00Z"), "a", [custom], now, { confirm: true }).reason, "That day already has a call booked or offered.");
  assert.equal(canHold(D("2026-10-23T10:00:00Z"), "c", [custom], now).ok, false);
  const released = { place_id: "a", status: "cancelled", created_at: "2026-10-19T19:00:00Z", slot_at: "2026-10-23T10:00:00Z" };
  assert.deepEqual(canHold(D("2026-10-23T10:00:00Z"), "b", [released], now), { ok: true });
  // the 3-hour lead counts from the offer; a confirm only needs 30 minutes
  assert.deepEqual(canHold(D("2026-10-20T10:00:00Z"), "b", [], D("2026-10-20T07:00:00Z")), { ok: true });
  assert.deepEqual(canHold(D("2026-10-20T10:00:00Z"), "b", [], D("2026-10-20T09:30:00Z"), { confirm: true }), { ok: true });
});

test("callTimeDue across the clock change: 17:00 BST on Sat 24 Oct is due 18:00 GMT on Sunday, 17:00 is GMT on Sunday", () => {
  assert.deepEqual(callTimeDue(D("2026-10-24T16:00:00Z")), { due_at: D("2026-10-25T18:00:00Z"), promise: "by tomorrow evening", tomorrow: true });
  assert.deepEqual(callTimeDue(D("2026-10-25T16:59:00Z")), { due_at: D("2026-10-25T18:00:00Z"), promise: "by the end of the day", tomorrow: false }); // 16:59 GMT
  assert.deepEqual(callTimeDue(D("2026-10-25T17:00:00Z")), { due_at: D("2026-10-26T18:00:00Z"), promise: "by tomorrow evening", tomorrow: true });
});

test("callTodoTitle reads the slot in UK time and takes ISO strings", () => {
  assert.equal(callTodoTitle({ first: "Mark", business: "Diamond Kickboxing", slot_at: "2026-10-25T11:00:00Z", phone: "07700 900123" }), "Call Mark (Diamond Kickboxing) Sun 11:00 · 07700 900123");
  assert.equal(callTodoTitle({ first: "", business: "Diamond Kickboxing", slot_at: "2026-10-22T14:30:00Z", phone: "" }), "Call Diamond Kickboxing Thu 15:30 · no number yet");
});

test("bad input never throws: an unreadable time is refused, a bad row never blocks a day", () => {
  const now = D("2026-10-20T08:00:00Z");
  assert.equal(isSlot("not a date"), false);
  assert.deepEqual(canHold("Friday at 11", "b", [], now), { ok: false, reason: "That isn't a valid date and time." });
  assert.deepEqual(canHold("", "b", [], now, { confirm: true, anyTime: true }), { ok: false, reason: "That isn't a valid date and time." });
  const bad = { place_id: "a", status: "offered", created_at: "garbage", slot_at: "2026-10-23T10:00:00Z" };
  assert.equal(offerExpired(bad, now), true);
  assert.deepEqual(canHold(D("2026-10-23T10:00:00Z"), "b", [bad], now), { ok: true });
  const noSlot = { place_id: "c", status: "confirmed", created_at: "2026-10-18T07:00:00Z", slot_at: "?" };
  assert.deepEqual(takenFrom([noSlot], now), []);
  assert.deepEqual(canHold(D("2026-10-23T10:00:00Z"), "b", [noSlot], now), { ok: true });
  assert.deepEqual(iso(nextFreeSlots(D("2026-10-19T19:00:00Z"), [D("bad")])), ["2026-10-20T10:00:00Z", "2026-10-21T10:00:00Z", "2026-10-23T10:00:00Z"]);
});

test("opts may give only the fields they change", () => {
  assert.deepEqual(iso(nextFreeSlots(D("2026-10-19T19:00:00Z"), [], { count: 1 })), ["2026-10-20T10:00:00Z"]);
  assert.equal(isSlot(D("2026-10-22T10:00:00Z"), { days: [4] }), true);   // Thursday allowed, time from CALL_SLOTS
});

test("callTodoTitle with a name but no business", () => {
  assert.equal(callTodoTitle({ first: "Mark", business: "", slot_at: "2026-10-20T10:00:00Z", phone: "07700 900123" }), "Call Mark Tue 11:00 · 07700 900123");
});

test("times are read as ISO only: no guessing from loose text, no local-time reading", () => {
  assert.equal(isSlot("2026-10-23T10:00:00Z"), true);
  assert.equal(isSlot("2026-10-23T10:00:00.000Z"), true);
  assert.equal(isSlot("2026-10-23T11:00:00+01:00"), true);
  assert.equal(isSlot("2026-10-23 10:00:00"), true);                 // SQLite style, UTC
  assert.equal(isSlot("2026-10-23"), false);
  assert.equal(canHold("2026-10-23", "b", [], D("2026-10-20T08:00:00Z")).reason, "That isn't a valid date and time.");
});
