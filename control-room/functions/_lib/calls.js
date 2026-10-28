// Call slots (pure). Run: node --test control-room/tests/calls.test.mjs
//
// Nik takes calls at 11:00 UK on Tue, Wed, Fri, Sat and Sun, one call per UK day: a day with a live offer (still
// held) or a confirmed call has no free slot, including a call Nik booked by hand at another time that day. The
// soonest free slot is at least 3 hours ahead and the search goes 56 UK days ahead; Claude is shown the next 3.
// An offer holds its slot for that prospect for 48 hours, or until the slot time if sooner (offerExpired); a confirm
// needs the slot at least 30 minutes ahead and is allowed for a free slot or the prospect's own offered one, even
// after its hold ran out if nobody else took the day (canHold). A time outside the slots gets a call_time Todo due
// 18:00 UK today, or tomorrow from 17:00 UK (callTimeDue).
//
// Every day and clock rule goes through ukTime.js (Europe/London), so slots stay at 11:00 UK across the clock
// changes (10:00Z in BST, 11:00Z in GMT). Rows are `calls` rows: {place_id, status, created_at, slot_at}, times as
// ISO strings; Date or ISO string is accepted wherever a time is passed in. The db side is calls-db.js.

import { addUkDays, ukDate, ukParts, ukToUtc } from "./ukTime.js";

export const CALL_SLOTS = { days: [2, 3, 5, 6, 0], time: "11:00", minLeadHours: 3, count: 3 };
export const OFFER_HOLD_HOURS = 48;

const HOUR_MS = 3600000;
const MINUTE_MS = 60000;
const HORIZON_DAYS = 56;
const CONFIRM_LEAD_MINUTES = 30;
const CALL_TIME_CUTOFF_HOUR = 17;   // from 17:00 UK a call_time Todo is due tomorrow
const CALL_TIME_DUE = "18:00";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];
const pad = (n) => String(n).padStart(2, "0");

// A Date, or an ISO date-time string ("2026-10-23T10:00:00Z"; no zone or a space instead of "T" is read as UTC,
// SQLite's way). Anything else ("Friday at 11", a bare date) is an Invalid Date: JS's own parser would guess.
const ISO_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?$/;
function toDate(value) {
  if (value instanceof Date) return value;
  const m = ISO_TIME.exec(String(value ?? "").trim());
  return m ? new Date(`${m[1]}T${m[2]}${m[3] || "Z"}`) : new Date(NaN);
}
const isValid = (date) => !Number.isNaN(date.getTime());
// Callers may pass only the fields they change ({count: 1}); the rest are Nik's slots.
const slotOpts = (opts) => ({ ...CALL_SLOTS, ...(opts || {}) });

// The weekday (0 = Sunday) of a UK date string.
function ukWeekday(ukDateStr) {
  const [y, m, d] = ukDateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** True when `date` is exactly one of Nik's slots: the slot time in UK time on a slot weekday. */
export function isSlot(date, opts = CALL_SLOTS) {
  const at = toDate(date);
  if (!isValid(at)) return false;
  opts = slotOpts(opts);
  const day = ukDate(at);
  return opts.days.includes(ukWeekday(day)) && ukToUtc(day, opts.time).getTime() === at.getTime();
}

/**
 * The next `opts.count` free slots (Dates, soonest first): one per UK day, at least `opts.minLeadHours` ahead of
 * `now`, never on a UK day that has any of `takenSlots` (see takenFrom), searched 56 UK days from today.
 */
export function nextFreeSlots(now, takenSlots, opts = CALL_SLOTS) {
  opts = slotOpts(opts);
  const from = toDate(now);
  const taken = new Set((takenSlots || []).map(toDate).filter(isValid).map((t) => ukDate(t)));
  const earliest = from.getTime() + opts.minLeadHours * HOUR_MS;
  const today = ukDate(from);
  const out = [];
  for (let i = 0; i < HORIZON_DAYS && out.length < opts.count; i++) {
    const day = addUkDays(today, i);
    if (!opts.days.includes(ukWeekday(day)) || taken.has(day)) continue;
    const slot = ukToUtc(day, opts.time);
    if (slot.getTime() >= earliest) out.push(slot);
  }
  return out;
}

/** "Tuesday 20 October at 11am", "Thursday 22 October at 3:30pm" (UK time). */
export function slotLabel(date) {
  const { m, d, hh, mm, weekday } = ukParts(toDate(date));
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  const time = `${hour12}${mm ? `:${pad(mm)}` : ""}${hh < 12 ? "am" : "pm"}`;
  return `${WEEKDAYS[weekday]} ${d} ${MONTHS[m - 1]} at ${time}`;
}

/**
 * An offered call's hold has run out: 48 hours after the offer, or the slot time if that's sooner. An offer whose
 * times can't be read counts as run out, so a bad row never blocks a day for good.
 */
export function offerExpired(call, now) {
  if (!call || call.status !== "offered") return false;
  const holdEnds = Math.min(
    toDate(call.created_at).getTime() + OFFER_HOLD_HOURS * HOUR_MS,
    toDate(call.slot_at).getTime(),
  );
  return !Number.isFinite(holdEnds) || toDate(now).getTime() >= holdEnds;
}

// A call that takes its UK day: confirmed, or an offer still held.
const isLive = (call, now) => call.status === "confirmed" || (call.status === "offered" && !offerExpired(call, now));

/**
 * The times (Dates) that take a UK day: every confirmed call, and every offer still held, except the offers of
 * `exceptPlaceId` (their own held slot stays free to them; their confirmed calls still take the day).
 */
export function takenFrom(calls, now, exceptPlaceId) {
  return (calls || [])
    .filter((c) => isLive(c, now))
    .filter((c) => !(c.status === "offered" && exceptPlaceId != null && c.place_id === exceptPlaceId))
    .map((c) => toDate(c.slot_at))
    .filter(isValid);
}

/**
 * Can `placeId` be offered (or, with `confirm`, booked into) `slotAt`? Checks in order: it's one of the slots
 * (`anyTime` skips this, for a time Nik picks himself), the lead time (3 hours for an offer, 30 minutes for a
 * confirm), then the UK day: taken by another prospect's held offer or by any confirmed call (theirs too, so a
 * repeat confirm of their own booked call is refused here; the caller decides if that is a no-op). A time that can't be
 * read is refused first.
 */
export function canHold(slotAt, placeId, calls, now, { confirm = false, anyTime = false } = {}) {
  const at = toDate(slotAt);
  const from = toDate(now);
  if (!isValid(at)) return { ok: false, reason: "That isn't a valid date and time." };
  if (!anyTime && !isSlot(at)) {
    return { ok: false, reason: "That isn't one of Nik's call slots (11am Tue, Wed, Fri, Sat, Sun)." };
  }
  const ahead = at.getTime() - from.getTime();
  if (confirm && ahead < CONFIRM_LEAD_MINUTES * MINUTE_MS) {
    return { ok: false, reason: "That slot has passed or is under 30 minutes away." };
  }
  if (!confirm && ahead < CALL_SLOTS.minLeadHours * HOUR_MS) {
    return { ok: false, reason: "That slot is under 3 hours away: offer the next one." };
  }
  const day = ukDate(at);
  const clash = (calls || []).some((c) => isLive(c, from)
    && !(c.status === "offered" && c.place_id === placeId)
    && isValid(toDate(c.slot_at)) && ukDate(toDate(c.slot_at)) === day);
  if (clash) return { ok: false, reason: "That day already has a call booked or offered." };
  return { ok: true };
}

/** When the call_time Todo is due and what Claude promises: 18:00 UK today before 17:00 UK, else 18:00 UK tomorrow. */
export function callTimeDue(now) {
  const from = toDate(now);
  const tomorrow = ukParts(from).hh >= CALL_TIME_CUTOFF_HOUR;
  const day = tomorrow ? addUkDays(ukDate(from), 1) : ukDate(from);
  return {
    due_at: ukToUtc(day, CALL_TIME_DUE),
    promise: tomorrow ? "by tomorrow evening" : "by the end of the day",
    tomorrow,
  };
}

/** "Call Mark (Diamond Kickboxing) Tue 11:00 · 07969 770905"; no name → the business; no phone → "no number yet". */
export function callTodoTitle({ first, business, slot_at, phone }) {
  const name = String(first || "").trim();
  const firm = String(business || "").trim();
  const who = name && firm ? `${name} (${firm})` : name || firm || "them";
  const { hh, mm, weekday } = ukParts(toDate(slot_at));
  const number = String(phone || "").trim() || "no number yet";
  return `Call ${who} ${WEEKDAYS[weekday].slice(0, 3)} ${pad(hh)}:${pad(mm)} · ${number}`;
}
