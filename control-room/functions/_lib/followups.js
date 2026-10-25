// Follow-ups: the schedule (pure) and db helpers. Stage 3's followupsDueToday and its test stay as stage 3 wrote them.
//
// Schedule (Part A §A4): follow-up k goes FOLLOWUP_DAYS[k-1] UK days after the first email, at the UK clock time the
// first email went (kept across clock changes: 09:15 BST stays 09:15 GMT), clamped into 07:00–18:59, on a sending day
// of COLD_WINDOW (Sunday moves to Monday; bank holidays are ordinary days), and never on or before the UK day the
// previous one went (nextDue). Never import shortlist-db.js here: it imports this file.
//
// Capacity (Part A §A2): a mailbox's daily cap (mailboxCap) counts every cold email it sends, first emails and
// follow-ups alike. A first email takes a place on its own UK day and on each of the 9 days its follow-ups will go
// (firstEmailDays), so it's only offered when its mailbox has a place free on all 10 (roomFor), against what's booked
// already (loadByDay). Days are chained the way the tick sends them: each follow-up by nextDue from the one before.
//
// Stop rules (Part A §A5): a sequence ends on a human reply, an opt-out or a bounce received after the first email,
// or once the stage is past viewed (STOP_STAGES); a demo view or an auto-reply never ends it (stopReason). Where it
// can't tell when a reply came, the reply counts, so a follow-up never goes after one.
//
// Wording (Part A §A6): the 9 follow-ups are seeded as DRAFTS for Nik to approve on the Voice page. checkFollowup runs
// on them and on every edit he makes (the first line is {greeting}, at most 60 words after it, only {greeting},
// {business} and {demo_link}, no other link, no "SEO", prices or guarantees, one "?" at most, no "!!"), and
// renderFollowup fills one in for a lead. The text rules they share with the first email are in mail/rules.js.
//
// followupsDueToday's number feeds the Shortlist's room for first emails: every follow-up that will go out today takes
// a place in the mailboxes' daily cap before any new first email does. capacityNow takes that number from planFirsts'
// rows (same rule, no extra D1 statements); followupsDueToday itself and its test stay as stage 3 wrote them.
//
// In the database (Part B Task 6): ensureTemplates seeds the 9 drafts and followupsApproved counts the approved ones;
// planningRows reads what's booked (cold sends and open sequences) and roomForFirsts turns it into each cold
// mailbox's room for first emails, the one number the composer's Send and the Leads banner both use. planFirsts is
// that same read with the caller's own mailbox query: stage 3's capacityNow uses it, and takes followupsDueToday's
// number from its rows, so it stays at 4 D1 statements. followupsDueByMailbox: follow-ups due today, per mailbox.
//
// Sent mail and stops (Part B Task 7): a lead stays `ready` until its first email has really gone. syncSent then
// fires first_sent (→ emailed), records first_sent_at, root_message_id and follow-up 1's time (schedule) and saves
// Nik's words as a style example; a sent follow-up books the next one (nextDue), or the close time after step 9
// (closeTime). A reply, opt-out or bounce that came in before the sync is applied at once instead, so no follow-up is
// booked after it (A9). stopFollowups ends a sequence (the inbound step, stage 7 and the sweep call it); sweepStops
// is the safety net that re-checks every lead with a follow-up pending. Stage changes go through applyStageEvent.
//
// The tick step (Part B Task 8): followupsStep runs every 5 minutes, between the inbound and send steps: sweepStops,
// queueDue (the due follow-ups, in the thread, once all 9 templates are approved and the demo is up), syncSent,
// retryFailed (a failed follow-up goes again at 07:00 UK the next sending day, 3 attempts at most; one that may have
// gone, INTERRUPTED_PREFIX, never), closeFinished (lost 7 days after step 9) and flagHeldFirsts (a todo for a first
// email the outbox holds because its lead no longer passes the ready rule). At most 18 D1 queries a run, and always
// one fewer than the tick has left (its closing beat); queueDue goes before the bookkeeping so a busy run can't take
// the queries it needs (follow-ups go before first emails).
//
// The health light (Part B Task 15): followupHealth (pure) and followupHealthFromDb (1 D1 statement), registered with
// stage 0's registerLight when this module loads (tick.js imports it, and api/health.js imports tick.js): red when a
// follow-up is more than 24 h late, amber while leads wait for Nik to approve the templates, green otherwise.
import { countingDB } from "./d1count.js";
import { demoReady } from "./demo-db.js";
import { registerLight } from "./health.js";
import { mailboxCap } from "./mail/capacity.js";
import { coldFooter, makeMessageId } from "./mail/compose.js";
import { COLD_WINDOW, INTERRUPTED_PREFIX, leadReadySql, queueMessage } from "./mail/outbox.js";
import { businessName, findLinks, stripFooter, wordCount } from "./mail/rules.js";
import { applyStageEvent } from "./prospects.js";
import { getSetting } from "./settings.js";
import { nextStage } from "./stages.js";
import { addTodo } from "./todo.js";
import { addUkDays, inUkWindow, nextUkWindowStart, ukDate, ukParts, ukToUtc } from "./ukTime.js";
import { iso } from "./util.js";

// Stage 0's send window (Mon–Sat 07:00–19:00 UK), re-exported rather than declared again, so the send step, the
// Shortlist and this schedule share one object and can never disagree.
export { COLD_WINDOW };

/** Days after the first email on which follow-ups 1 to 9 are due. */
export const FOLLOWUP_DAYS = Object.freeze([1, 2, 4, 7, 10, 17, 24, 30, 60]);

/** A sequence with all 9 follow-ups sent and nothing that stopped it closes as `lost` this many days after step 9. */
export const CLOSE_AFTER_DAYS = 7;

const pad = (n, width = 2) => String(n).padStart(width, "0");
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// The day sums are done on UK days as whole day numbers (days since Thu 1 Jan 1970), "YYYY-MM-DD" in and out:
// capacity planning walks every open thread's follow-ups on each request, and plain sums keep that well inside the
// free Workers plan's 10 ms of CPU. dayNumber only ever gets a day that ukDate made or addUkDays checked.
const DAY_MS = 86400000;
const dayNumber = (ukDay) => Date.parse(`${ukDay}T00:00:00Z`) / DAY_MS;
const weekdayOf = (n) => (((n + 4) % 7) + 7) % 7; // 0 = Sunday

// A few hundred distinct days are booked per plan, so their text is worked out once each (toISOString costs ~1 µs).
const dayTexts = new Map();
function dayText(n) {
  let text = dayTexts.get(n);
  if (text === undefined) {
    text = new Date(n * DAY_MS).toISOString().slice(0, 10);
    if (dayTexts.size >= 4096) dayTexts.clear();
    dayTexts.set(n, text);
  }
  return text;
}

// Stored times are UTC text ending in Z. Text with no zone ("2026-10-22T08:15:00", or SQLite's "2026-10-22 08:15:00")
// is UTC too, so it's read as UTC, as Workers do, never in the time zone of the computer running the tests.
const NO_ZONE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

function shown(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value); // a BigInt or a circular object: never let the error message itself throw
  }
}

function toDate(value, what) {
  const date = value instanceof Date ? value
    : typeof value === "string" ? new Date(value.trim().replace(NO_ZONE, "$1T$2Z"))
      : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(`Follow-ups need ${what} as a date or UTC ISO text, got ${shown(value)}`);
  }
  return date;
}

function checkStep(step) {
  if (!Number.isInteger(step) || step < 1 || step > FOLLOWUP_DAYS.length) {
    throw new Error(`A follow-up step must be a whole number from 1 to ${FOLLOWUP_DAYS.length}, got ${shown(step)}`);
  }
}

// What every follow-up's time is built from, worked out once: the UK day of the first email and its UK clock time
// "HH:MM", clamped into the window (07:00 to 18:59, the last minute before COLD_WINDOW.end, which is itself
// outside). COLD_WINDOW is read inside the call, not at load time.
function firstEmailClock(firstSentAt) {
  const { y, m, d, hh, mm } = ukParts(toDate(firstSentAt, "the first email's send time"));
  const earliest = toMinutes(COLD_WINDOW.start);
  const latest = toMinutes(COLD_WINDOW.end) - 1;
  const minutes = Math.min(Math.max(hh * 60 + mm, earliest), latest);
  return { day: `${pad(y, 4)}-${pad(m)}-${pad(d)}`, time: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}` };
}

// Day number `n` itself when COLD_WINDOW sends that weekday, else the next day it does (Sunday → Monday).
function sendingDay(n) {
  let day = n;
  for (let i = 0; i < 7 && !COLD_WINDOW.days.includes(weekdayOf(day)); i++) day += 1;
  return day;
}

// The day number follow-up `step` goes on, from the first email's day number and that of the day the previous email
// went (or null): FOLLOWUP_DAYS[step-1] days on, moved to a sending day (schedule's day), unless that's on or before
// `lastDay`: then the next sending day after it (nextDue's). Capacity planning chains it directly, so its days are
// nextDue's by construction. The clamped clock time never changes the day.
function dueDay(firstDay, step, lastDay) {
  const due = sendingDay(firstDay + FOLLOWUP_DAYS[step - 1]);
  return lastDay !== null && due <= lastDay ? sendingDay(lastDay + 1) : due;
}

/**
 * When follow-up `step` (1 to 9) is due by the plan alone: the UK day of `firstSentAt` (the first email's actual
 * `sent_at`, a Date or UTC ISO text) plus FOLLOWUP_DAYS[step-1], moved off a Sunday, at the first email's clamped UK
 * clock time. Returns a Date.
 */
export function schedule(firstSentAt, step) {
  const { day, time } = firstEmailClock(firstSentAt);
  checkStep(step);
  return ukToUtc(dayText(dueDay(dayNumber(day), step, null)), time);
}

/**
 * When follow-up `step` is actually due, given when the previous email of the thread went (`lastSentAt`: the first
 * email for step 1, else follow-up step-1; null when there's none to go by). schedule(...), unless that falls on or
 * before the UK day of `lastSentAt` (a Saturday first email's day 1 and day 2 both land on Monday; a step that went
 * late): then the next sending day after `lastSentAt`, at the same clamped time. So no two go on one UK day.
 */
export function nextDue(firstSentAt, step, lastSentAt) {
  const { day, time } = firstEmailClock(firstSentAt);
  checkStep(step);
  const lastDay = lastSentAt === null || lastSentAt === undefined ? null
    : dayNumber(ukDate(toDate(lastSentAt, "the previous send time")));
  return ukToUtc(dayText(dueDay(dayNumber(day), step, lastDay)), time);
}

function stepsDone(value) {
  const n = value === null || value === undefined ? 0
    : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n < 0 || n > FOLLOWUP_DAYS.length) {
    throw new Error(`A sequence's step_done must be a whole number from 0 to ${FOLLOWUP_DAYS.length}, got ${shown(value)}`);
  }
  return n;
}

// The UK days ("YYYY-MM-DD") follow-ups `fromStep` to 9 go on, as the tick sends them, for a thread whose first
// email went on day number `firstDay`: `fromStep` on day number `firstDueDay` (null = by the plan), each later one on
// nextDue's day (dueDay) from the day the one before it goes. A day before `floorDay` (a day number, or null) is
// overdue: it goes on `floorDay`, and the chain goes on from there.
function chainDays(firstDay, fromStep, firstDueDay, floorDay) {
  const days = [];
  let last = null; // the day the previous follow-up went; step 1 goes by the plan, as syncSent books it (schedule)
  for (let step = fromStep; step <= FOLLOWUP_DAYS.length; step++) {
    let day = step === fromStep && firstDueDay !== null ? firstDueDay : dueDay(firstDay, step, last);
    if (floorDay !== null && day < floorDay) day = floorDay;
    days.push(dayText(day));
    last = day;
  }
  return days;
}

function book(load, mailboxId, day) {
  const days = (load[mailboxId] ??= {});
  days[day] = (days[day] ?? 0) + 1;
}

const blank = (value) => value === null || value === undefined || value === "";

// The UK day number of a time (a Date or UTC ISO text). UK clocks are UTC (GMT) or one hour ahead (BST), so before
// 23:00 UTC the UK day is the UTC day, and only a time in the 23:00 UTC hour needs ukDate. A plan reads two times per
// open thread, mostly at different hours, and ukDate's first look at each hour costs ~9 µs (an Intl call): 1,440 of
// them take about 13 ms, over the free Workers plan's 10 ms of CPU, in a fresh isolate.
const LAST_HOUR_MS = 23 * 3600000;
function ukDayOf(value, what) {
  const date = toDate(value, what);
  const ms = date.getTime();
  const utcDay = Math.floor(ms / DAY_MS);
  return ms - utcDay * DAY_MS < LAST_HOUR_MS ? utcDay : dayNumber(ukDate(date));
}

/**
 * The 10 UK days ("YYYY-MM-DD", in order, all different) a first email sent at `firstAt` (a Date or UTC ISO text)
 * takes a place on: its own day, then its 9 follow-ups' days as the tick will send them (each by nextDue from the one
 * before, so a Saturday first email's days 1 and 2 are Monday and Tuesday, never Monday twice).
 */
export function firstEmailDays(firstAt) {
  const firstDay = ukDayOf(firstAt, "the first email's send time");
  return [dayText(firstDay), ...chainDays(firstDay, 1, null, null)];
}

/**
 * Cold sends already booked, per mailbox and UK day: {[mailbox_id]: {["YYYY-MM-DD"]: number}} (a mailbox or a day
 * with none isn't listed). `ukToday` is the day being planned for: the UK day of the next send (today inside the
 * window, else the next window start), as roomForFirsts passes it. Nothing waiting goes out before it, nor on a day
 * COLD_WINDOW doesn't send (a Sunday `ukToday` plans for the Monday).
 * - `cold`: sends fixed to a time ({mailbox_id, at, status?}: sent today, or queued / sending at their due time).
 *   A send already made (status "sent") counts on the UK day it went, never moved: in the evening the plan is for
 *   tomorrow, and today's sends don't use tomorrow's places. Any other counts on the UK day of `at`; an overdue one
 *   (or one with no time) on `ukToday`, since it goes as soon as it can.
 * - `sequences`: follow-ups not queued yet ({mailbox_id, first_at, step_done, next_at}): steps step_done+1 to 9. The
 *   first goes at `next_at` (on `ukToday` when that's earlier), each later one by nextDue from the one before, so the
 *   load matches what the tick will really do. next_at null with step_done 0 is a first email still queued for
 *   `first_at` (its due time): its follow-ups go by the plan from the day it goes, which is `ukToday` when it's
 *   overdue. step_done 9 books nothing (next_at is then the close time, not an email).
 */
export function loadByDay({ cold = [], sequences = [] } = {}, ukToday) {
  // addUkDays throws ukTime's plain-English error unless ukToday is "YYYY-MM-DD".
  const floor = sendingDay(dayNumber(addUkDays(ukToday, 0)));
  const load = {};
  for (const send of cold ?? []) {
    if (send.status === "sent" && !blank(send.at)) {
      book(load, send.mailbox_id, dayText(ukDayOf(send.at, "a cold send's time")));
      continue;
    }
    const day = blank(send.at) ? floor : sendingDay(ukDayOf(send.at, "a cold send's time"));
    book(load, send.mailbox_id, dayText(Math.max(day, floor)));
  }
  for (const seq of sequences ?? []) {
    const done = stepsDone(seq.step_done);
    if (done === FOLLOWUP_DAYS.length) continue; // all 9 sent: next_at is the close time, not an email
    let firstDay = ukDayOf(seq.first_at, "the first email's send time");
    const nextDay = blank(seq.next_at) ? null : sendingDay(ukDayOf(seq.next_at, "the next follow-up's due time"));
    if (done === 0 && nextDay === null) firstDay = Math.max(sendingDay(firstDay), floor); // a queued first email
    for (const day of chainDays(firstDay, done + 1, nextDay, floor)) book(load, seq.mailbox_id, day);
  }
  return load;
}

/**
 * How many more first emails `mailbox` can take at `firstAt` (a Date or UTC ISO text), given `load` (loadByDay's
 * result): the fewest places free (mailboxCap(mailbox, day) minus what's booked that day for this mailbox) over the 10
 * days of firstEmailDays, never below 0. `fullDay` is the first of those days with no place free, else null. A paused
 * mailbox, one not bought yet and one still warming up (cap 0) have no room.
 */
export function roomFor(load, mailbox, firstAt) {
  const days = firstEmailDays(firstAt);
  const booked = (load ?? {})[mailbox?.id] ?? {};
  let room = Infinity;
  for (const day of days) {
    const free = mailboxCap(mailbox, day) - (Number(booked[day]) || 0);
    if (free <= 0) return { room: 0, fullDay: day };
    room = Math.min(room, free);
  }
  return { room, fullDay: null };
}

/** The prospect stages that end a sequence: every stage past viewed (only `emailed` and `viewed` leads get follow-ups). */
export const STOP_STAGES = Object.freeze(["replied", "needs_nik", "call_booked", "won", "lost"]);

// The inbound classes that stop a sequence, strongest first, and the reason each gives. `auto` (out-of-office,
// auto-replies) and anything else never stop it.
const STOP_CLASSES = Object.freeze([["opt_out", "opt_out"], ["bounce", "bounce"], ["human", "replied"]]);

// When an inbound message came, in ms, or NaN when it has no time or one that can't be read.
function receivedMs(value) {
  if (blank(value)) return NaN;
  try {
    return toDate(value, "an inbound message's time").getTime();
  } catch {
    return NaN;
  }
}

/**
 * Why `prospect`'s follow-ups must stop, or null to keep going. `prospect` is {stage, first_sent_at} (first_sent_at =
 * the first email's sent_at, a Date or UTC ISO text); `inbound` is the lead's inbound messages, [{class, received_at}].
 * In order: "opt_out", "bounce" or "replied" (class human) when such a message was received at or after
 * first_sent_at; else "stage:<stage>" when the stage is in STOP_STAGES; else null. A demo view (`viewed`) and class
 * `auto` never stop it, nor does a message received before the first email. A message with no time or one that can't
 * be read counts, and so does every message while first_sent_at isn't set: then a reply is never missed.
 */
export function stopReason(prospect, inbound = []) {
  if (prospect === null || typeof prospect !== "object") {
    throw new TypeError(`stopReason needs the prospect row (its stage and first_sent_at), got ${shown(prospect)}`);
  }
  const messages = inbound ?? [];
  if (!Array.isArray(messages)) {
    throw new TypeError(`stopReason needs the lead's inbound messages as a list, got ${shown(inbound)}`);
  }
  const firstMs = blank(prospect.first_sent_at) ? -Infinity
    : toDate(prospect.first_sent_at, "the first email's send time").getTime();
  const classes = new Set();
  for (const message of messages) {
    if (message === null || typeof message !== "object") {
      throw new TypeError(`Each inbound message needs its class and received_at, got ${shown(message)}`);
    }
    if (!STOP_CLASSES.some(([cls]) => cls === message.class)) continue;
    if (receivedMs(message.received_at) < firstMs) continue; // before the first email went (NaN is never <: it counts)
    classes.add(message.class);
  }
  for (const [cls, reason] of STOP_CLASSES) if (classes.has(cls)) return reason;
  return STOP_STAGES.includes(prospect.stage) ? `stage:${prospect.stage}` : null;
}

/**
 * The 9 follow-up emails as they're seeded (status `draft`) for Nik to approve on the Voice page: Part A §A6 word for
 * word, by step. {greeting} is "Hi Mark," or "Hi,", {business} the cleaned business name, {demo_link} their demo's
 * address; the cold footer is added after the body when one is queued. Step 7 has no link.
 */
export const DRAFTS = Object.freeze({
  1: ["{greeting}", "",
    "In case my last email got buried: I made a new website for {business} and it's ready to look at.", "",
    "{demo_link}", "",
    "It takes a minute on your phone."].join("\n"),
  2: ["{greeting}", "",
    "The site I made for {business} uses your own services, your area and your details, so you can see exactly how it would look for you.", "",
    "{demo_link}", "",
    "If anything on it is wrong, tell me and I'll fix it."].join("\n"),
  3: ["{greeting}", "",
    "Most people find a local business on their phone now, so the site I made for {business} is built for phones first.", "",
    "Have a look on yours:",
    "{demo_link}"].join("\n"),
  4: ["{greeting}", "",
    "I might have the wrong person. If someone else looks after the website for {business}, would you mind passing this on to them?", "",
    "This is the site I made: {demo_link}", "",
    "Thank you."].join("\n"),
  5: ["{greeting}", "",
    "The point of the new site is more calls. When someone near you searches for what you do, the aim is for {business} to show up in the top 3 on Google, with a site that makes it easy to ring you.", "",
    "{demo_link}"].join("\n"),
  6: ["{greeting}", "",
    "If you're busy, this won't take much of your time. You fill in one short form and I do the rest. The site goes live within 7 days of that.", "",
    "This is what it would look like:",
    "{demo_link}"].join("\n"),
  7: ["{greeting}", "",
    "Is a new website something you'd want for {business} this year, or not right now?", "",
    "Either answer is fine. A one-word reply is plenty."].join("\n"),
  8: ["{greeting}", "",
    "The site I made for {business} is still up if you want another look:", "",
    "{demo_link}", "",
    "If you'd change anything on it, like the photos, colours or wording, just tell me what and I'll sort it."].join("\n"),
  9: ["{greeting}", "",
    "I'll leave it here so I'm not filling up your inbox. If the timing is better later on, just reply to this email and I'll pick it up from there.", "",
    "The site for {business} is here whenever you want it:",
    "{demo_link}", "",
    "All the best."].join("\n"),
});

const FOLLOWUP_MAX_WORDS = 60;
const FILLED_IN = Object.freeze(["greeting", "business", "demo_link"]);
const PLACEHOLDER = /\{([^{}\n]*)\}/g; // anything in braces, so "{Business}" and "{ town }" are caught too
// A price, or the free days, which change at weekends (£1,950 + 60 days free; Sat–Sun £1,750 + 90 days free).
const PRICE = /[£€]|\$\s?\d|\bgbp\b|\d\s?(?:pounds?|quid|k)\b|\d\s*(?:a|per|\/)\s*(?:month|year|week)\b|\b\d+\s+(?:days?|weeks?|months?)\s+(?:for\s+)?free\b|\bfree\s+for\s+\d+\s+(?:days?|weeks?|months?)\b/i;
const occurrences = (text, part) => text.split(part).length - 1;

/**
 * What's wrong with a follow-up's wording (a template, before {placeholders} are filled in), in plain English, in a
 * fixed order; [] when it's fine. The rules are Part A §A6's: the first line is exactly {greeting} (trailing spaces
 * aside); at least 1 and at most 60 words after it ({business} and {demo_link} one each; without a {greeting} line
 * every word counts); only {greeting}, {business} and {demo_link}, each brace part of one; {demo_link} at most once,
 * on its own (no "https://" or "www." in front), and no other link (a raw demo address too: it's the same text for
 * every lead); no "SEO", no "£" or prices, no "guarantee"; at most one "?"; no "!!". `body` null or undefined is an
 * empty text.
 */
export function checkFollowup(body) {
  if (body !== null && body !== undefined && typeof body !== "string") {
    throw new TypeError(`checkFollowup needs the follow-up's text, got ${shown(body)}`);
  }
  const text = (body ?? "").replace(/\r\n?/g, "\n");
  const firstBreak = text.indexOf("\n");
  const firstLine = firstBreak === -1 ? text : text.slice(0, firstBreak);
  const greetingFirst = /^\{greeting\}[^\S\n]*$/.test(firstLine); // a space pasted from Word after it is fine too
  const issues = [];
  if (!greetingFirst) issues.push("The first line must be {greeting} on its own.");
  else if (occurrences(text, "{greeting}") > 1) issues.push("Use {greeting} once, on the first line.");
  const words = wordCount(greetingFirst ? text.slice(firstLine.length) : text);
  // A cleared textarea would otherwise pass and send every lead "Hi Mark," and the footer.
  if (words === 0) issues.push("Write the follow-up under {greeting}.");
  if (words > FOLLOWUP_MAX_WORDS) issues.push(`Too long: ${words} words. Keep it to ${FOLLOWUP_MAX_WORDS}.`);
  const unknown = new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((name) => !FILLED_IN.includes(name)));
  for (const name of unknown) issues.push(`{${name}} isn't filled in. Use {greeting}, {business} or {demo_link}.`);
  if (/[{}]/.test(text.replace(PLACEHOLDER, ""))) {
    issues.push('Take out the "{" or "}" on its own: placeholders look like {business}.');
  }
  if (occurrences(text, "{demo_link}") > 1) issues.push("Use the demo link once at most.");
  // {demo_link} is the whole address, so "https://{demo_link}" would send a dead "https://https://…" link.
  if (/(?:https?:\/\/|www\.)\{demo_link\}/i.test(text)) {
    issues.push('{demo_link} is the whole address: take out the "https://" or "www." in front of it.');
  }
  const links = [...new Set(findLinks(text.replace(PLACEHOLDER, " ")))];
  if (links.length) issues.push(`Only the demo link is allowed. Remove: ${links.join(", ")}`);
  if (/\bseo\b/i.test(text)) issues.push('Don\'t say "SEO". Say "front page of Google" instead.');
  if (PRICE.test(text)) issues.push("No prices in follow-ups: they change at weekends.");
  if (/guarant/i.test(text)) issues.push("No guarantees in follow-ups: they're on the order page.");
  if (occurrences(text, "?") > 1) issues.push("One question at most.");
  if (text.includes("!!")) issues.push('Don\'t use "!!". One "!" is enough.');
  return issues;
}

// What fills each placeholder, and how an error names it.
const FILLS = Object.freeze({
  greeting: ["greeting", 'the greeting line, like "Hi Mark,"'],
  business: ["business", "the business name"],
  demo_link: ["demoUrl", "the demo's address"],
});
const FILL = /\{(greeting|business|demo_link)\}/g;
// Scraped values can carry line breaks, control characters and bidi overrides, which would break the email's lines
// or make it read differently from what it says. Written as \u escapes: literal bidi characters hide what code says.
// BIDI: bidi marks and overrides, the zero-width space, the word joiner and the BOM; CONTROL: C0, DEL and C1.
const BIDI = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
const oneLine = (value) => (typeof value === "string"
  ? value.replace(BIDI, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim() : "");

/**
 * A follow-up's text for one lead: every {greeting}, {business} and {demo_link} in `body` replaced, in one pass, by
 * `greeting` ("Hi Mark," / "Hi,"), `business` (the cleaned name) and `demoUrl`. Values go in as text, on one line
 * (line breaks and control characters become spaces), and a value is never filled in again ("{demo_link}" as a name
 * stays as it is). Line endings come out as \n and the end is trimmed, so the cold footer follows one blank line. A
 * placeholder whose value is missing or blank throws, so "undefined" never reaches a prospect. Any other {word} is
 * left as it is: checkFollowup stops such a template being approved.
 */
export function renderFollowup(body, values = {}) {
  if (typeof body !== "string") throw new TypeError(`renderFollowup needs the follow-up's text, got ${shown(body)}`);
  return body.replace(/\r\n?/g, "\n").replace(FILL, (all, name) => {
    const [key, what] = FILLS[name];
    const raw = values?.[key];
    const value = oneLine(raw);
    if (!value) throw new Error(`A follow-up with {${name}} needs ${what} (${key}), got ${shown(raw)}`);
    return value;
  }).trimEnd();
}

/**
 * How many follow-ups go out by the end of UK today and aren't counted in sentToday yet: follow-up messages still
 * `queued` (a `sending` one is already in sentToday), plus prospects whose next follow-up isn't queued yet and is due
 * before UK midnight tonight. A prospect with next_followup_at NULL is stopped or finished and never counts. Nor does
 * one with all 9 follow-ups sent (its next_followup_at is then the close time, when it's marked lost, not an email)
 * or one whose stage stops the sequence (replied and on: only `emailed` and `viewed` leads get follow-ups).
 * `now` is a Date (or UTC ISO text, as sentToday takes). Stored times are UTC ISO text, so the boundary is compared
 * as text in the same format (iso, no milliseconds). 2 D1 queries, in one batch.
 */
export async function followupsDueToday(DB, now) {
  const date = typeof now === "string" ? new Date(now) : now; // ukDate refuses anything that isn't a valid date
  const endOfToday = iso(ukToUtc(addUkDays(ukDate(date), 1), "00:00"));
  const [queued, pending] = await DB.batch([
    DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup' AND status = 'queued'"),
    DB.prepare(
      `SELECT COUNT(*) AS n FROM prospects
       WHERE next_followup_at < ? AND followup_step < 9 AND stage IN ('emailed', 'viewed')`,
    ).bind(endOfToday),
  ]);
  return Number(queued.results[0]?.n ?? 0) + Number(pending.results[0]?.n ?? 0);
}

// ---- Templates and capacity from the database (Part B, Task 6) ----

const LAST_STEP = FOLLOWUP_DAYS.length;
// Only emailed and viewed leads get follow-ups (replied and on stop the sequence: STOP_STAGES).
const SEQUENCE_STAGES = Object.freeze(["emailed", "viewed"]);

/**
 * Seeds the 9 follow-up templates for Nik to approve on the Voice page: DRAFTS, day_offset from FOLLOWUP_DAYS, status
 * `draft`. A step already there is left as it is, so his edits and approvals are never overwritten; a missing one
 * comes back as its draft. 1 D1 statement.
 */
export async function ensureTemplates(DB) {
  const values = [];
  const rows = FOLLOWUP_DAYS.map((days, i) => {
    values.push(i + 1, days, DRAFTS[i + 1]);
    const n = values.length;
    return `(?${n - 2}, ?${n - 1}, ?${n}, 'draft')`;
  });
  await DB.prepare(`INSERT OR IGNORE INTO followup_templates (step, day_offset, body, status) VALUES ${rows.join(", ")}`)
    .bind(...values)
    .run();
}

/**
 * How many of the 9 follow-up templates are approved: {approved, all}; `all` only when every one of the 9 is, which
 * is when follow-ups may be queued. One Nik saved again since is a draft until he approves it again. 1 D1 statement.
 */
export async function followupsApproved(DB) {
  const row = await DB.prepare(
    `SELECT COUNT(*) AS n FROM followup_templates WHERE status = 'approved' AND step BETWEEN 1 AND ${LAST_STEP}`,
  ).first();
  const approved = Number(row?.n ?? 0);
  return { approved, all: approved === LAST_STEP };
}

// Cold sends fixed to a time (planningRows' `cold`): first emails and follow-ups queued or sending, whatever their
// due time, or sent since 00:00 UK today (?1), each with its thread's prospect, so a thread whose next follow-up
// isn't booked on the prospect can be projected. The mailbox is the row's, else its thread's (the outbox's rule).
// No direction test: queueMessage only ever writes these kinds as "out" (and followupsDueToday counts them so too).
// Not a queued first email whose lead no longer passes stage 3's ready rule as of now (?2; leadReadySql, the outbox's
// own test): the outbox holds it until Nik cancels it (Part A, "Set aside after Send"), so it books no place. Should
// the lead pass again and it go, the claim's cap guard still keeps that day within its cap.
const COLD_SENDS_SQL = `SELECT COALESCE(m.mailbox_id, p.mailbox_id) AS mailbox_id, m.place_id, m.kind, m.step, m.status,
    m.due_at, m.sent_at, p.stage AS p_stage, p.first_sent_at AS p_first_sent_at, p.next_followup_at AS p_next_at
  FROM messages m LEFT JOIN prospects p ON p.place_id = m.place_id
  WHERE m.kind IN ('first', 'followup')
    AND (m.status IN ('queued', 'sending') OR (m.status = 'sent' AND m.sent_at >= ?1))
    AND (m.kind <> 'first' OR m.status <> 'queued' OR ${leadReadySql("m.place_id", "?2")})`;

// Open sequences (planningRows' `sequences`): emailed and viewed leads with follow-ups left and the next one booked.
// due_today: it's due before 00:00 UK tonight (?1), the rule followupsDueToday counts by.
const SEQUENCES_SQL = `SELECT mailbox_id, first_sent_at, followup_step, next_followup_at,
    next_followup_at < ?1 AS due_today
  FROM prospects
  WHERE stage IN ('emailed', 'viewed') AND followup_step < ${LAST_STEP} AND next_followup_at IS NOT NULL`;

// The mailboxes roomForFirsts plans for: cold ones only (system mailboxes never send cold email).
const COLD_MAILBOXES_SQL = `SELECT id, address, role, started_on, cap_override, status FROM mailboxes
  WHERE role = 'cold' ORDER BY created_at, id`;

// Follow-ups waiting to go by 00:00 UK tonight (?1), by mailbox: queued ones due by then (the row's mailbox, else its
// thread's), and prospects whose next one isn't queued yet and is due by then (followupsDueToday's pending rule).
const DUE_BY_MAILBOX_SQL = `SELECT mailbox_id, SUM(n) AS n FROM (
    SELECT COALESCE(m.mailbox_id, p.mailbox_id) AS mailbox_id, COUNT(*) AS n
      FROM messages m LEFT JOIN prospects p ON p.place_id = m.place_id
      WHERE m.kind = 'followup' AND m.status = 'queued' AND m.due_at < ?1
      GROUP BY COALESCE(m.mailbox_id, p.mailbox_id)
    UNION ALL
    SELECT mailbox_id, COUNT(*) FROM prospects
      WHERE next_followup_at < ?1 AND followup_step < ${LAST_STEP} AND stage IN ('emailed', 'viewed')
      GROUP BY mailbox_id
  ) GROUP BY mailbox_id`;

// 00:00 UK today and 00:00 UK tonight (the end of today) as stored text, for the UK day of `at`.
function ukDayBounds(at) {
  const today = ukDate(at);
  return { since: iso(ukToUtc(today, "00:00")), endOfToday: iso(ukToUtc(addUkDays(today, 1), "00:00")) };
}

// The two SELECTs behind planningRows, and when the next first email would go: `now` inside COLD_WINDOW, else the
// next window start (a Sunday's or an evening's plan is for the next send day).
function planningReads(DB, now) {
  const at = toDate(now, "now");
  const { since, endOfToday } = ukDayBounds(at);
  return {
    firstAt: nextUkWindowStart(at, COLD_WINDOW),
    reads: [DB.prepare(COLD_SENDS_SQL).bind(since, iso(at)), DB.prepare(SEQUENCES_SQL).bind(endOfToday)],
  };
}

// The later of a stored time (blank = none) and `date`.
function laterOf(value, date) {
  if (blank(value)) return date;
  const time = toDate(value, "a queued email's due time");
  return time > date ? time : date;
}

// planningRows' {cold, sequences} from its two reads' rows. Besides the open sequences, every thread whose next
// follow-ups aren't booked on its prospect is projected as a sequence, so its places never drop out of the plan:
// - a first email queued (one its lead's ready rule holds is never read: COLD_SENDS_SQL) or sending: {first_at:
//   due_at, step_done: 0, next_at: null} (loadByDay plans its follow-ups from the day it goes);
// - a first email sent today whose lead is still `ready` (the next followups step hasn't synced it yet): follow-up 1
//   at schedule(sent_at, 1), as the sync books it;
// - a follow-up queued, sending or sent today to an emailed or viewed lead whose next_followup_at is NULL (it's
//   cleared while one is queued, and set again once it's gone and synced): the steps after the thread's latest one,
//   from nextDue after the day that one goes (its sent_at, else its due time or the next send, whichever is later).
// A sequence without its first email's time can't be planned and is left out (followupsDueToday still counts it).
function planFrom(coldRows, seqRows, firstAt) {
  const cold = [];
  const sequences = [];
  const latest = new Map(); // place_id → the thread's latest follow-up row, when its next one isn't booked
  for (const r of coldRows) {
    const sent = r.status === "sent";
    cold.push({ mailbox_id: r.mailbox_id, kind: r.kind, status: r.status, at: sent ? r.sent_at : r.due_at });
    if (r.kind === "first") {
      if (!sent) {
        sequences.push({ mailbox_id: r.mailbox_id, first_at: blank(r.due_at) ? iso(firstAt) : r.due_at, step_done: 0, next_at: null });
      } else if (r.p_stage === "ready" && blank(r.p_first_sent_at) && !blank(r.sent_at)) {
        sequences.push({ mailbox_id: r.mailbox_id, first_at: r.sent_at, step_done: 0, next_at: iso(schedule(r.sent_at, 1)) });
      }
      continue;
    }
    const step = Number(r.step);
    if (!SEQUENCE_STAGES.includes(r.p_stage) || !blank(r.p_next_at) || blank(r.p_first_sent_at)) continue;
    if (!Number.isInteger(step) || step < 1 || step > LAST_STEP) continue;
    const seen = latest.get(r.place_id);
    if (!seen || step > Number(seen.step)) latest.set(r.place_id, r);
  }
  for (const r of latest.values()) {
    const step = Number(r.step);
    if (step === LAST_STEP) continue; // nothing comes after follow-up 9 (its next_followup_at is the close time)
    const went = r.status === "sent" && !blank(r.sent_at) ? r.sent_at : laterOf(r.due_at, firstAt);
    sequences.push({ mailbox_id: r.mailbox_id, first_at: r.p_first_sent_at, step_done: step,
      next_at: iso(nextDue(r.p_first_sent_at, step + 1, went)) });
  }
  for (const r of seqRows) {
    if (blank(r.first_sent_at)) continue;
    sequences.push({ mailbox_id: r.mailbox_id, first_at: r.first_sent_at, step_done: r.followup_step, next_at: r.next_followup_at });
  }
  return { cold, sequences };
}

/**
 * What capacity planning starts from (loadByDay's input), as of `now` (a Date or UTC ISO text): {cold, sequences}.
 * cold: [{mailbox_id, kind, status, at}], every first email and follow-up queued or sending (at = its due time) or
 * sent since 00:00 UK today (at = sent_at), except a queued first email whose lead no longer passes stage 3's ready
 * rule (the outbox holds it: Part A, "Set aside after Send"). sequences: [{mailbox_id, first_at, step_done, next_at}],
 * every emailed or viewed lead with follow-ups left and next_followup_at set, plus every queued first email read
 * projected as {first_at: due_at, step_done: 0, next_at: null}, and the other threads whose next follow-ups aren't
 * booked on the prospect yet (a first email sending or sent but not synced, a follow-up queued or not synced:
 * planFrom), so the plan never offers a place one of them will take. 2 D1 statements, in one batch.
 */
export async function planningRows(DB, now) {
  const { firstAt, reads } = planningReads(DB, now);
  const [coldRes, seqRes] = await DB.batch(reads);
  return planFrom(coldRes.results, seqRes.results, firstAt);
}

/**
 * roomForFirsts' reads and answer, with the cold mailboxes read by `mailboxQuery` (a prepared statement whose rows
 * are cold mailboxes with mailboxCap's columns; rows with no id are skipped; default: every cold mailbox) in one
 * batch with planningRows' two SELECTs. Stage 3's capacityNow passes its own mailbox read (it counts the queued first
 * emails too) and takes followupsDueToday's number from the same rows, so the Leads banner stays at 4 D1 statements.
 * → {mailboxes (mailboxQuery's rows as read), plan (planningRows'), load (loadByDay's, planned for room.day), room
 * (roomForFirsts'), followupsDue (followupsDueToday's number for `now`)}. 3 D1 statements, in one batch.
 */
export async function planFirsts(DB, now, mailboxQuery = null) {
  const { firstAt, reads } = planningReads(DB, now);
  const [mailboxRes, coldRes, seqRes] = await DB.batch([mailboxQuery ?? DB.prepare(COLD_MAILBOXES_SQL), ...reads]);
  const mailboxes = mailboxRes.results;
  const plan = planFrom(coldRes.results, seqRes.results, firstAt);
  const day = ukDate(firstAt);
  const load = loadByDay(plan, day);
  const rooms = [];
  let total = 0;
  for (const m of mailboxes) {
    if (m?.id === null || m?.id === undefined || m.role !== "cold") continue;
    // Only an active mailbox sends cold email (pickMailbox), so any other status has no room, as a paused one has.
    const r = roomFor(load, m.status === "active" ? m : { ...m, status: "paused" }, firstAt);
    rooms.push([m.id, r]);
    total += r.room;
  }
  const queued = coldRes.results.filter((r) => r.kind === "followup" && r.status === "queued").length;
  const pending = seqRes.results.filter((r) => Number(r.due_today) === 1).length;
  return { mailboxes, plan, load, room: { day, total, byMailbox: Object.fromEntries(rooms) }, followupsDue: queued + pending };
}

/**
 * How many more first emails the cold mailboxes can take, as of `now` (a Date or UTC ISO text):
 * {day, total, byMailbox: {[mailbox_id]: {room, fullDay}}}. day = the UK day of the next send: today inside
 * COLD_WINDOW, else the next window start (Monday on a Sunday or a Saturday evening). Each cold mailbox's room is
 * roomFor's for a first email going then: places free on its own day and on all 9 of its follow-up days, against
 * everything booked (planningRows); fullDay = the first of those days with no place free. A paused mailbox, one not
 * bought yet, one warming up (cap 0) and one that isn't active have room 0. total = the sum, the number the composer
 * and the Leads banner both use. 3 D1 statements, in one batch.
 */
export async function roomForFirsts(DB, now) {
  return (await planFirsts(DB, now)).room;
}

/**
 * Follow-ups waiting to go by the end of UK today, by the mailbox that sends them: {total, byMailbox: {[mailbox_id]:
 * number}}. Follow-ups queued and due before 00:00 UK tonight (a `sending` one is already in sentToday), plus prospects
 * whose next follow-up isn't queued yet and is due by then (emailed or viewed, follow-ups left: followupsDueToday's
 * rule), each by its own mailbox (a queued row's, else its thread's). One with no mailbox at all counts only in
 * total. `now` is a Date or UTC ISO text. Stage 3's followupsDueToday is left as it is. 1 D1 statement.
 */
export async function followupsDueByMailbox(DB, now) {
  const { endOfToday } = ukDayBounds(toDate(now, "now"));
  const { results } = await DB.prepare(DUE_BY_MAILBOX_SQL).bind(endOfToday).all();
  let total = 0;
  const byMailbox = [];
  for (const r of results) {
    const n = Number(r.n) || 0;
    total += n;
    if (r.mailbox_id !== null && r.mailbox_id !== undefined) byMailbox.push([r.mailbox_id, n]);
  }
  return { total, byMailbox: Object.fromEntries(byMailbox) };
}

// ---- Sent mail and stopping sequences (Part B, Task 7) ----

// The stop reasons an inbound message gives (stopReason's), and the stage event each one is: the same events stage 0's
// inbound step fires when it sorts the message.
const STOP_EVENTS = Object.freeze({ replied: "inbound_human", opt_out: "opt_out", bounce: "bounce" });
// prospects.js: becoming won or lost also cancels the lead's cold mail (one more statement in its batch), and an
// opt-out or bounce on a lead lost for another reason re-marks its lost_reason (they outrank every other reason).
const ENDED = Object.freeze(["won", "lost"]);
const NO_CONTACT = Object.freeze(["opt_out", "bounce"]);
const SENDER_NAME = "business:sender_name"; // every sign-off and cold footer uses it, never a mailbox's display_name
const FOLLOWUP_FAIL = "health:followup-fail:"; // + place_id: Task 8's todo when a lead's follow-ups keep failing
const SUB_STEP_LIMIT = 10; // rows a sub-step of the followups tick step handles per run (Part B's constraints)

const STOP_CLASS_SQL = STOP_CLASSES.map(([cls]) => `'${cls}'`).join(", ");
const STOP_STAGE_SQL = STOP_STAGES.map((stage) => `'${stage}'`).join(", ");

// A lead's inbound messages that can stop its sequence, as one JSON list of {class, received_at} (stopReason's
// input), so each read below stays one statement however many leads it returns.
const INBOUND_SQL = `(SELECT json_group_array(json_object('class', i.class, 'received_at', i.received_at))
    FROM messages i WHERE i.place_id = p.place_id AND i.direction = 'in' AND i.class IN (${STOP_CLASS_SQL}))`;

// What syncSent records (?1 = the most rows): first emails sent whose lead has no first_sent_at yet, and follow-ups
// sent past the lead's followup_step while its next one isn't booked; first emails first, then oldest first. It reads
// from the prospects side (CROSS JOIN keeps prospects as SQLite's outer loop, and "+m.status" keeps each lead's
// messages on the messages_place index), so a run every 5 minutes reads the prospects once, never every email ever
// sent (D1's free plan counts rows read). Follow-ups are read only for emailed and viewed leads: a stopped lead's
// follow-up that went anyway would have nothing booked after it.
const SYNC_SQL = `SELECT p.place_id, p.stage, p.lost_reason, p.first_sent_at, p.followup_step,
    m.id, m.kind, m.step, m.message_id, m.sent_at, CASE WHEN m.kind = 'first' THEN m.body END AS body,
    ${INBOUND_SQL} AS inbound
  FROM prospects p CROSS JOIN messages m ON m.place_id = p.place_id
  WHERE (p.first_sent_at IS NULL
      OR (p.stage IN ('emailed', 'viewed') AND p.next_followup_at IS NULL AND p.followup_step < ${LAST_STEP}))
    AND m.direction = 'out' AND +m.status = 'sent' AND COALESCE(m.sent_at, '') <> ''
    AND ((m.kind = 'first' AND p.first_sent_at IS NULL)
      OR (m.kind = 'followup' AND p.first_sent_at IS NOT NULL AND m.step BETWEEN 1 AND ${LAST_STEP}
          AND m.step > p.followup_step))
  ORDER BY m.kind = 'followup', m.sent_at, m.id
  LIMIT ?1`;

// A first email gone: its facts, and follow-up 1's time (?3; NULL once stopped) only while the lead is emailed or
// viewed after the stage events. Only the first run to get there writes it (first_sent_at IS NULL).
const FIRST_SENT_SQL = `UPDATE prospects SET first_sent_at = ?1, root_message_id = ?2, followup_step = 0,
    next_followup_at = CASE WHEN stage IN ('emailed', 'viewed') THEN ?3 END, updated_at = ?4
  WHERE place_id = ?5 AND first_sent_at IS NULL`;
// Nik's first email, footer off, for the reply Routine (stage 7) to write like him: one per message, "sent:<id>".
const STYLE_EXAMPLE_SQL = `INSERT OR IGNORE INTO style_examples (id, kind, situation, body, source, created_at)
  VALUES (?1, 'example', 'first email', ?2, 'nik_sent', ?3)`;
// A follow-up gone: the steps done and the next one's time (or the close time after step 9), as FIRST_SENT_SQL.
const FOLLOWUP_SENT_SQL = `UPDATE prospects SET followup_step = ?1,
    next_followup_at = CASE WHEN stage IN ('emailed', 'viewed') THEN ?2 END, updated_at = ?3
  WHERE place_id = ?4 AND followup_step < ?1`;
// closeTodos' close for one exact dedupe (closeTodos matches a prefix: health:followup-fail:p1 would close p10's
// too): done, the dedupe freed with "@" + done_at. OR IGNORE: should that freed dedupe be taken already, the todo
// stays open rather than the whole batch failing.
const CLOSE_TODO_SQL = `UPDATE OR IGNORE todos SET status = 'done', done_at = ?1, dedupe = dedupe || '@' || ?1
  WHERE status = 'open' AND dedupe = ?2`;
// stopFollowups: the next follow-up unbooked (a row already unbooked isn't touched), the queued ones cancelled. A
// follow-up already `sending` may be going right now and is left to finish; syncSent books nothing after it.
const STOP_SQL = "UPDATE prospects SET next_followup_at = NULL, updated_at = ?1 WHERE place_id = ?2 AND next_followup_at IS NOT NULL";
const CANCEL_FOLLOWUPS_SQL = `UPDATE messages SET status = 'cancelled', error = ?1
  WHERE place_id = ?2 AND direction = 'out' AND kind = 'followup' AND status = 'queued'`;

// The leads sweepStops stops (?1 = the most rows): a follow-up pending (the next one booked, or one queued) and a stop
// rule that applies: a stage past viewed, or a reply, opt-out or bounce received since the first email (one with no
// time counts, as in stopReason). The pending leads come by index (prospects_followup, messages_due), and a stopped
// lead has none pending, so it drops out and the rest get their turn.
const SWEEP_SQL = `WITH pending AS (
    SELECT place_id FROM prospects WHERE next_followup_at > ''
    UNION
    SELECT place_id FROM messages
      WHERE status = 'queued' AND direction = 'out' AND kind = 'followup' AND place_id IS NOT NULL
  )
  SELECT p.place_id, p.stage, p.first_sent_at, ${INBOUND_SQL} AS inbound
  FROM pending o CROSS JOIN prospects p ON p.place_id = o.place_id
  WHERE p.stage IN (${STOP_STAGE_SQL})
     OR EXISTS (SELECT 1 FROM messages i WHERE i.place_id = p.place_id AND i.direction = 'in'
       AND i.class IN (${STOP_CLASS_SQL})
       AND (COALESCE(p.first_sent_at, '') = '' OR COALESCE(i.received_at, '') = '' OR i.received_at >= p.first_sent_at))
  ORDER BY p.place_id
  LIMIT ?1`;

/**
 * When a sequence whose 9th follow-up went at `lastSentAt` (a Date or UTC ISO text) is closed as lost if nothing has
 * stopped it: CLOSE_AFTER_DAYS UK days later, at the same UK clock time (09:15 BST stays 09:15 GMT, as follow-ups
 * do), seconds kept. Returns a Date.
 */
export function closeTime(lastSentAt) {
  const sent = toDate(lastSentAt, "follow-up 9's send time");
  const { hh, mm } = ukParts(sent);
  const day = addUkDays(ukDate(sent), CLOSE_AFTER_DAYS);
  return new Date(ukToUtc(day, `${pad(hh)}:${pad(mm)}`).getTime() + (sent.getTime() % 60000));
}

// A sub-step's options: at most `limit` leads (a whole number, 0 or more) and `maxQueries` D1 queries (the tick's
// share for it; no limit by default). A lead is only started when its queries fit.
function subStepOptions({ limit = SUB_STEP_LIMIT, maxQueries = Infinity } = {}, fn) {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new TypeError(`${fn}: limit must be a whole number of leads (0 or more), got ${shown(limit)}.`);
  }
  if (typeof maxQueries !== "number" || Number.isNaN(maxQueries) || maxQueries < 0) {
    throw new TypeError(`${fn}: maxQueries must be a number of D1 queries (0 or more), got ${shown(maxQueries)}.`);
  }
  return { limit, maxQueries };
}

// The D1 queries applyStageEvent(event) makes on `lead` ({stage, lost_reason}), or 0 when it would change nothing, so
// it isn't called (prospects.js: a read and a write; a move to won or lost cancels the lead's cold mail in
// the same batch; an opt-out or bounce on a lead lost for another reason re-marks its lost_reason). Stages never go
// back to ready, so a lead read past it can't need first_sent later.
function eventCost(lead, event) {
  const to = nextStage(lead.stage, event);
  if (to !== lead.stage) return ENDED.includes(to) ? 3 : 2;
  return to === "lost" && NO_CONTACT.includes(event) && !NO_CONTACT.includes(lead.lost_reason) ? 2 : 0;
}

// The lead as it will be after `event` (stage and lost_reason, as prospects.js writes them).
function afterEvent(lead, event) {
  if (!eventCost(lead, event)) return lead;
  const stage = nextStage(lead.stage, event);
  return { ...lead, stage, lost_reason: stage === "lost" ? event : null };
}

// Fires `event` on the lead unless it would change nothing (eventCost). A race another request won leaves the lead
// as that request made it: the CASE in FIRST_SENT_SQL / FOLLOWUP_SENT_SQL then books nothing unless it's emailed or
// viewed.
async function fireEvent(DB, lead, event, at) {
  if (eventCost(lead, event)) await applyStageEvent(DB, lead.place_id, event, at);
}

// SYNC_SQL's rows, one per lead, in their order: a first email's earliest send; a thread's highest follow-up step.
function leadsToSync(rows) {
  const byPlace = new Map();
  for (const row of rows) {
    const seen = byPlace.get(row.place_id);
    if (!seen || (row.kind === "followup" && Number(row.step) > Number(seen.step))) byPlace.set(row.place_id, row);
  }
  return [...byPlace.values()];
}

/**
 * Records what the send step has sent since the last run, as of `now` (a Date or UTC ISO text). At most `limit`
 * leads (10), first emails first, oldest first; with `maxQueries`, a lead is only started when its D1 queries fit.
 * - A first email gone (status `sent`; queued, sending, failed and cancelled ones are never read): first_sent
 *   (ready → emailed), then first_sent_at = its sent_at, root_message_id = its Message-ID, followup_step 0,
 *   next_followup_at = schedule(sent_at, 1), and a style example (id "sent:<message id>", the text without the cold
 *   footer of business:sender_name).
 * - A follow-up gone: followup_step = its step, next_followup_at = nextDue for the next step, or after step 9 the
 *   close time (closeTime); the lead's health:followup-fail:<place_id> todo is closed.
 * - A reply, opt-out or bounce received since the first email (stopReason; it may have landed while the lead was
 *   still `ready`, so its stage event didn't move it) is applied at once: its stage event (inbound_human, opt_out or
 *   bounce) and nothing booked. A lead already past viewed gets nothing booked either.
 * Each lead's own writes go in one batch. → {firsts, followups, stopped}: leads recorded, and how many of them stopped.
 * D1 queries: 1 read, the setting once, then per lead its stage events (0–5) and a batch of 2 or 3 (a stage event
 * that loses a race to another request reads the row again, the only way past `maxQueries`).
 */
export async function syncSent(DB, now, options = {}) {
  const at = iso(toDate(now, "the time now"));
  const { limit, maxQueries } = subStepOptions(options ?? {}, "syncSent");
  const tally = { firsts: 0, followups: 0, stopped: 0 };
  const counted = countingDB(DB);
  const db = counted.DB;
  if (limit === 0 || maxQueries < 1) return tally;
  const { results } = await db.prepare(SYNC_SQL).bind(limit).all();
  let senderName = null; // read once, before the first first email
  for (const row of leadsToSync(results)) {
    const first = row.kind === "first";
    const lead = { place_id: row.place_id, stage: row.stage, lost_reason: row.lost_reason ?? null };
    const sentAt = toDate(row.sent_at, "the email's send time");
    const firstSentAt = first ? sentAt : row.first_sent_at;
    const synced = first ? afterEvent(lead, "first_sent") : lead;
    const reason = stopReason({ stage: synced.stage, first_sent_at: firstSentAt }, JSON.parse(row.inbound ?? "[]"));
    const stopEvent = STOP_EVENTS[reason] ?? null;
    const cost = (first ? eventCost(lead, "first_sent") + (senderName === null ? 1 : 0) : 0)
      + (stopEvent ? eventCost(synced, stopEvent) : 0) + (reason && !first ? 3 : 2);
    if (counted.used() + cost > maxQueries) break; // the rest wait for the next run

    if (first) {
      if (senderName === null) senderName = await getSetting(db, SENDER_NAME, "");
      await fireEvent(db, lead, "first_sent", at);
    }
    if (stopEvent) await fireEvent(db, synced, stopEvent, at);

    let statements;
    if (first) {
      const next = reason ? null : iso(schedule(sentAt, 1));
      statements = [db.prepare(FIRST_SENT_SQL).bind(iso(sentAt), row.message_id ?? null, next, at, row.place_id)];
      const words = stripFooter(row.body, senderName);
      if (words.trim()) statements.push(db.prepare(STYLE_EXAMPLE_SQL).bind(`sent:${row.id}`, words, at));
    } else {
      const step = Number(row.step);
      const next = reason ? null
        : iso(step === LAST_STEP ? closeTime(sentAt) : nextDue(row.first_sent_at, step + 1, sentAt));
      statements = [
        db.prepare(FOLLOWUP_SENT_SQL).bind(step, next, at, row.place_id),
        db.prepare(CLOSE_TODO_SQL).bind(at, FOLLOWUP_FAIL + row.place_id),
      ];
      // Nothing should be queued after a follow-up that has only just gone; if anything is, it must not go now.
      if (reason) statements.push(db.prepare(CANCEL_FOLLOWUPS_SQL).bind(`Stopped: ${reason}`, row.place_id));
    }
    const [written] = await db.batch(statements);
    if (!written.meta.changes) continue; // another run recorded it first
    tally[first ? "firsts" : "followups"]++;
    if (reason) tally.stopped++;
  }
  return tally;
}

/**
 * Ends a lead's follow-ups, as of `now` (a Date or UTC ISO text): next_followup_at = NULL (and updated_at, when it was
 * set) and the lead's queued follow-ups cancelled, with error "Stopped: <reason>" (`reason`: why, e.g. "replied",
 * "opt_out", "stage:won"). Its other mail (a first email, Claude's replies) is left alone, and so is a follow-up
 * already sending. Follow-ups never start again on their own. Returns how many follow-ups were cancelled. 2 D1
 * queries, in one batch.
 */
export async function stopFollowups(DB, placeId, reason, now) {
  if (typeof placeId !== "string" || !placeId) throw new TypeError("stopFollowups needs the lead's place_id.");
  if (typeof reason !== "string" || !reason.trim()) {
    throw new TypeError('stopFollowups needs why the follow-ups stopped, e.g. "replied" or "opt_out".');
  }
  const at = iso(toDate(now, "the time now"));
  const [, cancelled] = await DB.batch([
    DB.prepare(STOP_SQL).bind(at, placeId),
    DB.prepare(CANCEL_FOLLOWUPS_SQL).bind(`Stopped: ${reason.trim()}`, placeId),
  ]);
  return cancelled.meta.changes;
}

/**
 * The safety net, as of `now` (a Date or UTC ISO text): every lead with a follow-up pending (the next one booked, or
 * one queued) that a stop rule applies to (stopReason: a reply, opt-out or bounce since the first email, or a stage
 * past viewed) gets stopFollowups. A demo view or an auto-reply never stops one. At most `limit` leads (10); with
 * `maxQueries`, a lead is only stopped when its 2 queries fit. Stage changes stay with the inbound step and stage 7.
 * Returns how many leads were stopped. D1 queries: 1 read, then 2 a lead.
 */
export async function sweepStops(DB, now, options = {}) {
  const at = iso(toDate(now, "the time now"));
  const { limit, maxQueries } = subStepOptions(options ?? {}, "sweepStops");
  const counted = countingDB(DB);
  if (limit === 0 || maxQueries < 1) return 0;
  const { results } = await counted.DB.prepare(SWEEP_SQL).bind(limit).all();
  let stopped = 0;
  for (const lead of results) {
    const reason = stopReason(lead, JSON.parse(lead.inbound ?? "[]"));
    if (!reason) continue;
    if (counted.used() + 2 > maxQueries) break; // the rest wait for the next run
    await stopFollowups(counted.DB, lead.place_id, reason, at);
    stopped++;
  }
  return stopped;
}

// ---- The followups tick step (Part B, Task 8) ----

const STEP_MAX = 18; // D1 queries the followups step makes at most per run (Part B's constraints)
const QUEUE_LIMIT = 3; // follow-ups queued per run: one step per lead, so waiting ones never go out in a burst
const MAX_ATTEMPTS = 3; // sends of one step before its sequence stops
const DEMO_HOLD = "health:followup-demo:"; // + place_id: a follow-up waiting for the lead's demo
const FIRST_HELD = "health:first-held:"; // + place_id: a first email the outbox holds, its lead no longer ready
const HELD_AFTER_MS = 3600000; // a first email held this long gets its todo (a short gap, a demo being remade, doesn't)
const SETUP_TODO = Object.freeze({ kind: "setup", title: "Approve your 9 follow-up emails", link: "/#/voice", dedupe: "setup:followups" });
const NAME_MAX = 80; // characters of a business name in a todo title
const ERROR_MAX = 300; // characters of a send error in a todo title
const UNCLAIMED = "Not sent: this lead's follow-ups changed while it was being queued.";
const CANT_WRITE_DETAIL = "Nothing more goes to them automatically, so the other leads' follow-ups aren't held up. "
  + "Open the lead to see the thread, and email them yourself if you want to carry on.";
// queueDue's room per lead queued: demoReady (1 for an emailed lead), the batch of 2, and the cancel when the booking
// changed meanwhile (1), so even that never takes the step past its cap. A lead whose follow-up can't be written
// takes demoReady (1, or 0 when that's found first) and its stop with a todo (3) instead.
const LEAD_QUERIES = 4;

// The 9 templates, wording and status (queueDue reads them once a run, so their approval and wording come in 1 query).
const TEMPLATES_SQL = `SELECT step, body, status FROM followup_templates WHERE step BETWEEN 1 AND ${LAST_STEP} ORDER BY step`;

// No reply, opt-out or bounce since the first email (stopReason's rule, as SWEEP_SQL reads it; one with no time
// counts) for prospect `p`. sweepStops is the step's safety net, but it takes 10 leads a run and only what its share
// of the queries allows, so the due and finished reads check it too: a follow-up is never queued, nor a lead closed
// as sequence_done, after they've written back while the stage doesn't show it yet. sweepStops then stops the lead.
const NO_STOP_INBOUND_SQL = `NOT EXISTS (SELECT 1 FROM messages i WHERE i.place_id = p.place_id AND i.direction = 'in'
      AND i.class IN (${STOP_CLASS_SQL})
      AND (COALESCE(p.first_sent_at, '') = '' OR COALESCE(i.received_at, '') = '' OR i.received_at >= p.first_sent_at))`;

// The follow-ups due (?1 = now, ?2 = the most rows, ?3 = DEMO_HOLD): emailed and viewed leads with follow-ups left
// whose next one is booked for now or earlier (by the prospects_followup index), with what the email needs: the
// lead's name, the thread's mailbox address and the follow-ups already sent (for References), and whether the lead's
// hold todo is there (any status: its dedupe is taken). Not a lead they've replied to, opted out of or bounced
// (NO_STOP_INBOUND_SQL). Oldest first, but leads already on hold go after the rest, so a few demos that stay down can
// never keep the others waiting.
const DUE_SQL = `SELECT p.place_id, p.email, p.greet_name, p.mailbox_id, p.subject, p.root_message_id, p.followup_step,
    p.next_followup_at, l.name AS lead_name, mb.address AS mailbox_address,
    (SELECT json_group_array(json_object('step', f.step, 'message_id', f.message_id, 'sent_at', f.sent_at))
      FROM messages f WHERE f.place_id = p.place_id AND f.direction = 'out' AND f.kind = 'followup'
        AND +f.status = 'sent' AND COALESCE(f.message_id, '') <> '') AS sent_followups,
    EXISTS (SELECT 1 FROM todos t WHERE t.dedupe = ?3 || p.place_id) AS demo_todo
  FROM prospects p
  LEFT JOIN leads l ON l.place_id = p.place_id
  LEFT JOIN mailboxes mb ON mb.id = p.mailbox_id
  WHERE p.next_followup_at > '' AND p.next_followup_at <= ?1 AND p.stage IN ('emailed', 'viewed')
    AND p.followup_step < ${LAST_STEP}
    AND ${NO_STOP_INBOUND_SQL}
  ORDER BY demo_todo, p.next_followup_at, p.place_id
  LIMIT ?2`;
// The booking a follow-up is queued for, cleared (in the batch with its INSERT): only while it's still the booking
// that was read. ?1 = now, ?2 = place_id, ?3 = next_followup_at as read, ?4 = followup_step as read.
const CLAIM_SQL = `UPDATE prospects SET next_followup_at = NULL, updated_at = ?1
  WHERE place_id = ?2 AND next_followup_at = ?3 AND followup_step = ?4 AND stage IN ('emailed', 'viewed')`;
// The follow-up just queued for a booking that changed meanwhile (a reply stopped it, Nik skipped the step): cancelled
// before the send step can see it.
const UNCLAIMED_SQL = "UPDATE messages SET status = 'cancelled', error = ?1 WHERE id = ?2 AND status = 'queued'";

// Failed follow-ups to go again or stop at (?1 = the most rows, ?2 = FOLLOWUP_FAIL): the latest send of an emailed or
// viewed lead's next step (followup_step + 1, nothing booked) when it failed, with how many sends of that step failed.
// Read from the messages side (messages_due: few rows are ever `failed`). A lead whose failing todo's dedupe is taken
// has been stopped already.
const RETRY_SQL = `SELECT p.place_id, p.followup_step, l.name AS lead_name, m.error,
    (SELECT COUNT(*) FROM messages c WHERE c.place_id = p.place_id AND c.direction = 'out' AND c.kind = 'followup'
      AND c.step = m.step AND +c.status = 'failed') AS failures
  FROM messages m
  CROSS JOIN prospects p ON p.place_id = m.place_id
  LEFT JOIN leads l ON l.place_id = p.place_id
  WHERE m.status = 'failed' AND m.direction = 'out' AND m.kind = 'followup'
    AND p.stage IN ('emailed', 'viewed') AND p.next_followup_at IS NULL AND p.followup_step < ${LAST_STEP}
    AND m.step = p.followup_step + 1
    AND m.id = (SELECT f.id FROM messages f WHERE f.place_id = p.place_id AND f.direction = 'out' AND f.kind = 'followup'
      AND f.step = m.step ORDER BY f.due_at DESC, f.created_at DESC, f.id DESC LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM todos t WHERE t.dedupe = ?2 || p.place_id)
  ORDER BY m.due_at, p.place_id
  LIMIT ?1`;
// The failed step booked again. ?1 = when, ?2 = now, ?3 = place_id, ?4 = followup_step as read.
const REBOOK_SQL = `UPDATE prospects SET next_followup_at = ?1, updated_at = ?2
  WHERE place_id = ?3 AND next_followup_at IS NULL AND followup_step = ?4 AND stage IN ('emailed', 'viewed')`;

// Sequences to close (?1 = now, ?2 = the most rows): all 9 sent and the close time come, and no reply, opt-out or
// bounce since the first email (NO_STOP_INBOUND_SQL: one that came in means they didn't go quiet).
const FINISHED_SQL = `SELECT p.place_id FROM prospects p
  WHERE p.next_followup_at > '' AND p.next_followup_at <= ?1 AND p.followup_step = ${LAST_STEP}
    AND p.stage IN ('emailed', 'viewed') AND ${NO_STOP_INBOUND_SQL}
  ORDER BY p.next_followup_at, p.place_id
  LIMIT ?2`;
// The follow-up todos that no longer apply, closed as CLOSE_TODO_SQL closes one (?1 = now, ?2 = FOLLOWUP_FAIL, ?3 =
// DEMO_HOLD, ?4 = FIRST_HELD). Exact: the place_id is the whole rest of the dedupe, so p1's never closes p10's.
// Failing: the lead is won or lost (A10 "or the lead closes"). On hold: it can't be queued any more (nothing booked,
// or past viewed). A held first email: none of the lead's is still queued and held (cancelled, sent, or its lead
// passes the ready rule again, as of now: HELD_FIRSTS_SQL's test).
const CLOSE_STALE_TODOS_SQL = `UPDATE OR IGNORE todos SET status = 'done', done_at = ?1, dedupe = dedupe || '@' || ?1
  WHERE status = 'open' AND (
    (substr(dedupe, 1, length(?2)) = ?2 AND EXISTS (SELECT 1 FROM prospects p
      WHERE p.place_id = substr(todos.dedupe, length(?2) + 1) AND p.stage IN ('won', 'lost')))
    OR (substr(dedupe, 1, length(?3)) = ?3 AND EXISTS (SELECT 1 FROM prospects p
      WHERE p.place_id = substr(todos.dedupe, length(?3) + 1)
        AND (p.stage NOT IN ('emailed', 'viewed') OR p.next_followup_at IS NULL)))
    OR (substr(dedupe, 1, length(?4)) = ?4 AND NOT EXISTS (SELECT 1 FROM messages m
      WHERE m.place_id = substr(todos.dedupe, length(?4) + 1) AND m.status = 'queued' AND m.direction = 'out'
        AND m.kind = 'first' AND NOT ${leadReadySql("m.place_id", "?1")})))`;

// First emails the outbox holds because their lead no longer passes stage 3's ready rule (leadReadySql, the outbox's
// own test, as of now: ?1), queued and due more than an hour ago (?2), whose todo isn't there yet (?3 = FIRST_HELD;
// its dedupe is taken while it's open, dismissed or done), oldest first (?4 = the most rows), with what its title
// says: which part of the rule fails (READY_SQL's order). Read by the messages_due index: few rows are ever queued.
const HELD_FIRSTS_SQL = `SELECT m.place_id, l.name AS lead_name, l.excluded, l.exclude_reason, r.status AS research_status,
    r.too_big, p.stage, p.email,
    EXISTS (SELECT 1 FROM demos d WHERE d.place_id = m.place_id AND d.expires_at > ?1) AS live_demo
  FROM messages m
  LEFT JOIN leads l ON l.place_id = m.place_id
  LEFT JOIN research r ON r.place_id = m.place_id
  LEFT JOIN prospects p ON p.place_id = m.place_id
  WHERE m.status = 'queued' AND m.due_at < ?2 AND m.direction = 'out' AND m.kind = 'first' AND m.place_id IS NOT NULL
    AND NOT ${leadReadySql("m.place_id", "?1")}
    AND NOT EXISTS (SELECT 1 FROM todos t WHERE t.dedupe = ?3 || m.place_id)
  ORDER BY m.due_at, m.place_id
  LIMIT ?4`;

// A lead's business as follow-ups name it ({business}: businessName, on one line), and as a todo title names it (at
// most NAME_MAX characters; the lead's place_id when there's no name).
const businessOf = (leadName) => oneLine(businessName(leadName));
const shortText = (text) => [...text].slice(0, NAME_MAX).join("").trim();
const todoName = (leadName, placeId) => shortText(businessOf(leadName)) || `the lead ${shortText(oneLine(String(placeId)))}`;
const leadLink = (placeId) => `/#/lead/${encodeURIComponent(placeId)}`;
// The greeting line from prospects.greet_name (set at Send by greetingFor): "Hi Mark," or "Hi,".
const greetingLine = (name) => (oneLine(name) ? `Hi ${oneLine(name)},` : "Hi,");
// An error as one line of text: a send error a todo quotes (at most ERROR_MAX characters), or a thrown one.
function errorLine(error, fallback) {
  const line = oneLine(error instanceof Error ? error.message : typeof error === "string" ? error : "") || fallback;
  const chars = [...line];
  return chars.length > ERROR_MAX ? `${chars.slice(0, ERROR_MAX - 1).join("")}…` : line;
}

// How far ahead the last followups run before COLD_WINDOW ends reaches: one 5-minute step interval and a minute's slack.
const LAST_RUN_MS = 6 * 60000;

// The latest booking queueDue reads as due at `date`: `date` itself, except in the last run before COLD_WINDOW ends
// today (`date` inside the window and its end at most LAST_RUN_MS away), which reaches up to the end (minus 1 ms). A4
// clamps a follow-up's time to 18:59 UK, and the tick runs on the 5-minute marks, so one booked for 18:56–18:59 would
// otherwise first be seen by the 19:00 tick, outside the window, and wait for the next sending day (and every later
// step would move on from that late send). Queued now, it goes a few minutes early, on its A4 day.
function dueCutoff(date) {
  if (!inUkWindow(date, COLD_WINDOW)) return date;
  const end = ukToUtc(ukDate(date), COLD_WINDOW.end).getTime();
  return end - date.getTime() <= LAST_RUN_MS ? new Date(end - 1) : date;
}

// When a failed follow-up goes again: COLD_WINDOW's start (07:00 UK) on the next sending day after `date`'s UK day
// (Saturday's goes on Monday).
const retryTime = (date) => ukToUtc(dayText(sendingDay(dayNumber(ukDate(date)) + 1)), COLD_WINDOW.start);

/**
 * Failed follow-ups, as of `now` (a Date or UTC ISO text): each emailed or viewed lead with nothing booked whose latest
 * send of its next step (followup_step + 1) failed. An error starting with INTERRUPTED_PREFIX means it may have gone,
 * so it is never sent again: the sequence stops (stopFollowups) and Nik gets the health todo
 * health:followup-fail:<place_id> "Follow-ups to <business> stopped: <error>". Any other failure is booked again for
 * 07:00 UK the next sending day (queueDue queues it then), up to 3 sends of that step; after the 3rd failure the
 * sequence stops with the same todo, "Follow-ups to <business> keep failing: <error>" ("Check the mailbox on Setup.").
 * A lead whose todo's dedupe is taken has been stopped already and isn't read again. At most `limit` leads (10); with
 * `maxQueries`, a lead is only started when its queries fit. → how many leads were booked again or stopped.
 * D1 queries: 1 read, then 1 per retry (a batch of 1) and 3 per stop.
 */
export async function retryFailed(DB, now, options = {}) {
  const date = toDate(now, "the time now");
  const at = iso(date);
  const { limit, maxQueries } = subStepOptions(options ?? {}, "retryFailed");
  const counted = countingDB(DB);
  const db = counted.DB;
  if (limit === 0 || maxQueries < 1) return 0;
  const { results } = await db.prepare(RETRY_SQL).bind(limit, FOLLOWUP_FAIL).all();
  const again = iso(retryTime(date));
  let handled = 0;
  for (const row of results) {
    if (counted.used() + 1 > maxQueries) break; // the rest wait for the next run
    const interrupted = typeof row.error === "string" && row.error.startsWith(INTERRUPTED_PREFIX);
    if (!interrupted && Number(row.failures) < MAX_ATTEMPTS) {
      const [booked] = await db.batch([db.prepare(REBOOK_SQL).bind(again, at, row.place_id, row.followup_step)]);
      if (booked.meta.changes) handled++;
      continue;
    }
    if (counted.used() + 3 > maxQueries) continue; // a stop doesn't fit; a retry after it may
    const name = todoName(row.lead_name, row.place_id);
    const error = errorLine(row.error, "The send failed and gave no reason.");
    await stopFollowups(db, row.place_id, interrupted ? "the send was interrupted" : `failed ${MAX_ATTEMPTS} times`, at);
    await addTodo(db, {
      kind: "health",
      title: interrupted ? `Follow-ups to ${name} stopped: ${error}` : `Follow-ups to ${name} keep failing: ${error}`,
      // The interrupted error ends by telling Nik to check the Sent folder; the detail says it too, since a long error
      // is cut in the title.
      detail: interrupted
        ? "It may have reached them, so it won't be sent again, and their follow-ups have stopped. Check the Sent folder in Namecheap webmail to see if it went."
        : "Check the mailbox on Setup.",
      link: leadLink(row.place_id),
      place_id: row.place_id,
      dedupe: FOLLOWUP_FAIL + row.place_id,
    });
    handled++;
  }
  return handled;
}

/**
 * Finished sequences, as of `now` (a Date or UTC ISO text): an emailed or viewed lead with all 9 follow-ups sent whose
 * close time (next_followup_at, 7 days after step 9) has come → applyStageEvent "sequence_done" (lost, lost_reason
 * sequence_done; prospects.js clears next_followup_at), unless a reply, opt-out or bounce came in since the first
 * email (then they didn't go quiet: sweepStops stops it instead). It also closes the follow-up todos that no longer apply, each
 * by its exact dedupe (closeTodos' prefix would close p10's with p1's): health:followup-fail:<place_id> once the lead
 * is won or lost, health:followup-demo:<place_id> once nothing is booked for it or it's past viewed, and
 * health:first-held:<place_id> once no first email of the lead is queued and held (flagHeldFirsts). At most `limit`
 * leads (10); with `maxQueries`, a lead is only closed when its 3 queries fit. → how many leads were closed.
 * D1 queries: the todos' close and the read in one batch (2), then 3 per lead.
 */
export async function closeFinished(DB, now, options = {}) {
  const at = iso(toDate(now, "the time now"));
  const { limit, maxQueries } = subStepOptions(options ?? {}, "closeFinished");
  const counted = countingDB(DB);
  const db = counted.DB;
  if (limit === 0 || maxQueries < 2) return 0;
  const [, { results }] = await db.batch([
    db.prepare(CLOSE_STALE_TODOS_SQL).bind(at, FOLLOWUP_FAIL, DEMO_HOLD, FIRST_HELD),
    db.prepare(FINISHED_SQL).bind(at, limit),
  ]);
  let closed = 0;
  for (const { place_id } of results) {
    if (counted.used() + 3 > maxQueries) break; // the rest wait for the next run
    if (await applyStageEvent(db, place_id, "sequence_done", at, { lost_reason: "sequence_done" })) closed++;
  }
  return closed;
}

// Why HELD_FIRSTS_SQL's row fails the ready rule, in plain English, in READY_SQL's order. Suppressed by address or
// domain the outbox cancels it; what's left is the company number on the do-not-email list.
function heldReason(row) {
  if (row.lead_name === null || row.lead_name === undefined) {
    return "the lead isn't in the Control Room any more (Reset leads removed it)";
  }
  if (Number(row.excluded)) return `a later search set it aside (${errorLine(row.exclude_reason, "not a fit").replace(/[.\s]+$/, "")})`;
  if (row.research_status !== "done") return "Claude's research on it isn't finished";
  if (Number(row.too_big)) return "Claude's research says it's too big for us";
  if (row.stage !== "ready") return `it's no longer ready to email (it's marked ${shortText(oneLine(String(row.stage ?? ""))) || "nothing"})`;
  if (!oneLine(row.email)) return "it has no email address";
  if (!Number(row.live_demo)) return "its demo site has expired";
  return "its company is on your do-not-email list";
}

/**
 * First emails the outbox holds for good, as of `now` (a Date or UTC ISO text): a queued first email whose lead no
 * longer passes stage 3's ready rule (a later search set it aside after Send, its research changed, its demo ended:
 * Part A, "Set aside after Send"), due more than an hour ago. Nothing cancels it but Nik, so he gets the health todo
 * health:first-held:<place_id> "Your first email to <business> is on hold: <reason>. Open the lead to cancel it.",
 * once (closeFinished closes it once that email is no longer queued and held). At most `limit` leads (10); with
 * `maxQueries`, a todo is only added when it fits. → how many todos were added. D1 queries: 1 read, then 1 a todo.
 */
export async function flagHeldFirsts(DB, now, options = {}) {
  const date = toDate(now, "the time now");
  const { limit, maxQueries } = subStepOptions(options ?? {}, "flagHeldFirsts");
  const counted = countingDB(DB);
  const db = counted.DB;
  if (limit === 0 || maxQueries < 1) return 0;
  const { results } = await db.prepare(HELD_FIRSTS_SQL)
    .bind(iso(date), iso(new Date(date.getTime() - HELD_AFTER_MS)), FIRST_HELD, limit).all();
  let added = 0;
  for (const row of results) {
    if (counted.used() + 1 > maxQueries) break; // the rest next run
    const who = row.lead_name === null || row.lead_name === undefined
      ? shortText(oneLine(String(row.email ?? ""))) || `the lead ${shortText(oneLine(String(row.place_id)))}`
      : todoName(row.lead_name, row.place_id);
    const id = await addTodo(db, {
      kind: "health",
      title: `Your first email to ${who} is on hold: ${heldReason(row)}. Open the lead to cancel it.`,
      detail: "It won't go while this is so, and nothing cancels it for you. If the lead is ready to email again, it goes as normal.",
      link: leadLink(row.place_id),
      place_id: row.place_id,
      dedupe: FIRST_HELD + row.place_id,
    });
    if (id) added++;
  }
  return added;
}

// queueMessage's own INSERT for `msg` (its checks, defaults and new id), prepared on `db` but not run, so it goes in
// one batch with the prospect's update: the follow-up is queued and its booking cleared together, or neither (a
// booking left behind would queue the same step again). queueMessage makes one prepare().bind().run().
async function queueStatement(db, msg) {
  let statement = null;
  const recorder = {
    prepare: (sql) => ({
      bind: (...values) => {
        if (statement) throw new Error("queueMessage wrote more than one statement, so the follow-up wasn't queued.");
        statement = db.prepare(sql).bind(...values);
        return { run: async () => ({ success: true, meta: { changes: 1 } }) };
      },
    }),
  };
  const id = await queueMessage(recorder, msg);
  if (!statement) throw new Error("queueMessage wrote nothing, so the follow-up wasn't queued.");
  return { id, statement };
}

// Follow-up `step`'s References: the first email's Message-ID, then those of the follow-ups sent before it in step
// order (`sentJson`: DUE_SQL's list of {step, message_id, sent_at}), each once; null when there are none.
function threadRefs(root, sentJson, step) {
  let sent;
  try {
    sent = JSON.parse(sentJson ?? "[]");
  } catch {
    sent = [];
  }
  const earlier = (Array.isArray(sent) ? sent : [])
    .filter((f) => Number(f?.step) < step && typeof f.message_id === "string" && f.message_id.trim())
    .sort((a, b) => Number(a.step) - Number(b.step) || String(a.sent_at ?? "").localeCompare(String(b.sent_at ?? "")))
    .map((f) => f.message_id.trim());
  const chain = [...new Set([typeof root === "string" ? root.trim() : "", ...earlier].filter(Boolean))];
  return chain.length ? chain.join(" ") : null;
}

/**
 * Queues the follow-ups that are due, as of `now` (a Date or UTC ISO text). → {queued, held, approved, waiting,
 * problems}: held is "templates", "demo" (a lead waits for its demo; `waiting` counts them) or null; approved = how
 * many of the 9 templates are.
 * - The templates are seeded when any is missing (ensureTemplates). Until all 9 are approved nothing is queued and
 *   Nik has the setup todo "Approve your 9 follow-up emails" (setup:followups; added once).
 * - Else each emailed or viewed lead with follow-ups left whose next_followup_at has come, oldest first (those already
 *   on hold for their demo last), at most `limit` (3) queued of at most 10 read. "Has come" is up to now, except in
 *   the last run before COLD_WINDOW ends today (within 6 minutes of 19:00 UK), which reaches up to the end
 *   (dueCutoff), so a booking at 18:56–18:59 goes that evening, not the next sending day. A lead whose lead row is gone
 *   (stage 1's Reset leads keeps prospects): it waits, with the same hold todo, health:followup-demo:<place_id>
 *   "Follow-ups to <prospects.email> are on hold: the lead isn't in the Control Room any more (Reset leads removed
 *   it). They start again if the lead is found again." demoReady(DB, place_id, now) not ok:
 *   it waits, with the health todo health:followup-demo:<place_id> "Follow-ups to <business> are on hold: their demo
 *   isn't available (<reason>)." ok: queueMessage, kind followup, step followup_step + 1, author system, from the
 *   thread's mailbox to prospects.email, subject "Re: " + prospects.subject, the step's wording as approved now
 *   (renderFollowup: "Hi <greet_name>," or "Hi,", {business} = businessName(lead name), {demo_link}) + "\n\n" +
 *   coldFooter(business:sender_name), a new Message-ID, In-Reply-To the first email's, References that and the
 *   follow-ups sent since, due at next_followup_at (now, when that's later: the last run before 19:00 reached ahead to
 *   it). In the same batch next_followup_at is cleared (syncSent books the next step once this one has gone) and the
 *   hold todo closed. If the booking changed meanwhile, the row is cancelled.
 * - A lead whose email can't be written (no business name, no subject, no address) is listed in problems
 *   [{place_id, error}] (followupsStep reports them) and stopped (stopFollowups) with the health todo
 *   health:followup-fail:<place_id> "Follow-ups to <business> stopped: the next one couldn't be written (<error>).",
 *   so it never takes one of the 10 due rows again; the others still go.
 * With `maxQueries`, a lead is only started when its queries fit. D1 queries: the templates (1; +1 to seed them), then
 * the setup todo (1), or the due read (1), the sender's name once (1), and per lead demoReady (1 for an emailed lead:
 * stage 4's one select) and a batch of 2 (3 with a hold to close), +1 to cancel the row when its booking changed
 * meanwhile (room for it is kept), or its hold todo (1, 0 once it's there), or the stop and its todo (3). A lead
 * they've replied to, opted out of or bounced since the first email is never read here, whatever its stage says
 * (sweepStops stops it).
 */
export async function queueDue(DB, now, options = {}) {
  const date = toDate(now, "the time now");
  const at = iso(date);
  const opts = options ?? {};
  const { limit, maxQueries } = subStepOptions({ ...opts, limit: opts.limit ?? QUEUE_LIMIT }, "queueDue");
  const isReady = opts.demoReady ?? demoReady;
  if (typeof isReady !== "function") throw new TypeError("queueDue: demoReady must be a function, like stage 4's demoReady.");
  const counted = countingDB(DB);
  const db = counted.DB;
  const fits = (n) => counted.used() + n <= maxQueries;
  const out = { queued: 0, held: null, approved: 0, waiting: 0, problems: [] };
  if (limit === 0 || !fits(1)) return out;

  const { results: templates } = await db.prepare(TEMPLATES_SQL).all();
  if (templates.length < LAST_STEP && fits(1)) await ensureTemplates(db);
  out.approved = templates.filter((t) => t.status === "approved").length;
  if (out.approved < LAST_STEP) {
    out.held = "templates";
    if (fits(1)) await addTodo(db, { ...SETUP_TODO });
    return out;
  }
  if (!fits(1 + 1 + LEAD_QUERIES)) return out; // the due read, the sender's name and one lead, or the read is wasted

  const bodies = new Map(templates.map((t) => [Number(t.step), t.body]));
  const { results: due } = await db.prepare(DUE_SQL).bind(iso(dueCutoff(date)), SUB_STEP_LIMIT, DEMO_HOLD).all();
  let senderName = null; // read once, before the first follow-up is written
  // A lead whose follow-up can never be written (no business name, no subject, no address): reported, and stopped
  // with a todo saying why (3 queries, inside LEAD_QUERIES), so it can't take one of the 10 due rows every run.
  const cantWrite = async (row, err) => {
    const error = errorLine(err, "it couldn't be written");
    out.problems.push({ place_id: row.place_id, error });
    await stopFollowups(db, row.place_id, "the follow-up couldn't be written", at);
    await addTodo(db, {
      kind: "health",
      title: `Follow-ups to ${todoName(row.lead_name, row.place_id)} stopped: the next one couldn't be written (${error.replace(/[.\s]+$/, "")}).`,
      detail: CANT_WRITE_DETAIL,
      link: leadLink(row.place_id),
      place_id: row.place_id,
      dedupe: FOLLOWUP_FAIL + row.place_id,
    });
  };
  for (const row of due) {
    if (out.queued >= limit) break;
    const onHold = Number(row.demo_todo) === 1;
    if (!fits((senderName === null ? 1 : 0) + LEAD_QUERIES + (onHold ? 1 : 0))) break; // the rest wait for the next run
    // The lead row is gone (leads.name is never NULL, so only the LEFT JOIN gives NULL): stage 1's Reset leads deletes
    // leads but keeps prospects and messages. Never a made-up name in a real email: it waits, on hold, and sorts after
    // the leads really due (demo_todo). If a later search finds the same place_id again, demoReady says ok again and
    // it goes, closing the todo.
    if (row.lead_name === null || row.lead_name === undefined) {
      out.waiting++;
      if (!onHold) {
        const who = shortText(oneLine(String(row.email ?? ""))) || `the lead ${shortText(oneLine(String(row.place_id)))}`;
        await addTodo(db, {
          kind: "health",
          title: `Follow-ups to ${who} are on hold: the lead isn't in the Control Room any more (Reset leads removed it). They start again if the lead is found again.`,
          link: leadLink(row.place_id),
          place_id: row.place_id,
          dedupe: DEMO_HOLD + row.place_id,
        });
      }
      continue;
    }
    const step = Number(row.followup_step) + 1;
    const fill = { greeting: greetingLine(row.greet_name), business: businessOf(row.lead_name) };
    try {
      if (!String(row.subject ?? "").trim()) throw new Error("it has no subject to reply under");
      renderFollowup(bodies.get(step), { ...fill, demoUrl: "https://aetoswebsites.com/d/check" }); // before any query
    } catch (err) {
      await cantWrite(row, err);
      continue;
    }

    const demo = await isReady(db, row.place_id, date);
    if (!demo?.ok) {
      out.waiting++;
      if (!onHold) {
        const reason = oneLine(demo?.reason) || "no reason given";
        await addTodo(db, {
          kind: "health",
          title: `Follow-ups to ${todoName(row.lead_name, row.place_id)} are on hold: their demo isn't available (${reason}).`,
          link: leadLink(row.place_id),
          place_id: row.place_id,
          dedupe: DEMO_HOLD + row.place_id,
        });
      }
      continue;
    }

    if (senderName === null) senderName = await getSetting(db, SENDER_NAME, "");
    let queued;
    try {
      queued = await queueStatement(db, {
        place_id: row.place_id,
        mailbox_id: row.mailbox_id ?? null,
        direction: "out",
        kind: "followup",
        step,
        author: "system",
        to_addr: row.email,
        from_addr: row.mailbox_address ?? null,
        subject: `Re: ${row.subject}`,
        body: `${renderFollowup(bodies.get(step), { ...fill, demoUrl: demo.url })}\n\n${coldFooter(senderName)}`,
        // A thread whose mailbox is gone gets one from the send step, which then fails it in plain English.
        message_id: blank(row.mailbox_address) ? null : makeMessageId(row.mailbox_address),
        in_reply_to: blank(row.root_message_id) ? null : row.root_message_id,
        refs: threadRefs(row.root_message_id, row.sent_followups, step),
        status: "queued",
        // Its booking, or now when this last run before 19:00 reached ahead to it (dueCutoff): the send step sends
        // only what's due, so it goes this tick, inside the window. Both are stored text in one format.
        due_at: row.next_followup_at < at ? row.next_followup_at : at,
        created_at: at, // this run's time, as every other time it stores (queueMessage would take the computer's clock)
      });
    } catch (err) {
      await cantWrite(row, err); // demoReady (1), the sender's name if new (1), the stop (3): within what was reserved
      continue;
    }
    const statements = [db.prepare(CLAIM_SQL).bind(at, row.place_id, row.next_followup_at, row.followup_step), queued.statement];
    if (onHold) statements.push(db.prepare(CLOSE_TODO_SQL).bind(at, DEMO_HOLD + row.place_id));
    const [claim] = await db.batch(statements);
    if (!claim.meta.changes) {
      await db.prepare(UNCLAIMED_SQL).bind(UNCLAIMED, queued.id).run(); // never left for the send step
      continue;
    }
    out.queued++;
  }
  if (out.waiting) out.held = "demo";
  return out;
}

// The queries this run may make: Math.min(18, ctx.budget.left() − 1), read once, keeping one for the tick's closing
// beat (it comes after every step; send, daily_find, pick and hot keep it too), so a run after a busy inbound step
// never makes the beat the invocation's 51st D1 query; 18 with no budget (a direct call) or an unlimited one
// (Infinity); 0 when left() isn't a number, so a broken budget can never let the step run unbounded.
const TICK_KEEP = 1;
function stepCap(budget) {
  if (typeof budget?.left !== "function") return STEP_MAX;
  const left = Number(budget.left());
  return Number.isNaN(left) ? 0 : Math.max(0, Math.min(STEP_MAX, Math.floor(left) - TICK_KEEP));
}

/**
 * The tick's `followups` step (every 5 minutes, after inbound and before send). `ctx` is the tick's ({DB, env, now,
 * budget}); `options.demoReady` replaces stage 4's demoReady (tests). In order, while its queries last: sweepStops,
 * queueDue (which seeds the templates when any is missing, as ensureTemplates), syncSent, retryFailed, closeFinished
 * and flagHeldFirsts: the due follow-ups are queued before the bookkeeping, so they always get the queries they need
 * (the summary keeps Part B's order). It makes at most Math.min(18, ctx.budget.left() − 1) D1 queries, keeping one for
 * the tick's beat, counted on its own countingDB: each sub-step starts only when its first query fits and gets what's
 * left, and the rest wait for the next run.
 * → "synced <n>, stopped <n>, retried <n>, closed <n>, queued <n>", with ", on hold <n> (demo not available)",
 * ", first email(s) on hold <n> (lead not ready)" (todos added this run) and "; out of D1 queries, the rest next run"
 * when they apply; while the templates aren't all approved, "waiting: follow-ups <n>/9 approved" (after the counts if
 * anything else was done). A lead whose follow-up can't be written doesn't stop the others: it's stopped with a todo,
 * the step finishes, then throws one plain-English error naming it (that run only).
 */
export async function followupsStep(ctx = {}, options = {}) {
  const { DB, now = new Date(), budget } = ctx ?? {};
  if (!DB || typeof DB.prepare !== "function") throw new TypeError("The followups step needs the database (ctx.DB).");
  const isReady = options?.demoReady ?? demoReady;
  const date = toDate(now, "the time now");
  const cap = stepCap(budget);
  const counted = countingDB(DB);
  const db = counted.DB;
  const done = { synced: 0, stopped: 0, retried: 0, closed: 0, queued: 0 };
  let heldFirsts = 0;
  let queue = null;
  // [the queries a sub-step needs to start, the sub-step given the queries left]. The stops first, then queueDue, so
  // the follow-ups that are due are queued with the queries they need and go before any first email (A4: the send
  // step sends a first email only once no follow-up is queued, and recording 2 sends can take 8 of the 18 queries).
  // Nothing syncSent, retryFailed or closeFinished books is due the same UK day, so none of it is needed first: the
  // next step goes on a later day (schedule, nextDue), a retry the next morning, the close 7 days on. And queueDue
  // never reads a lead that has stopped (its stage, or a reply, opt-out or bounce since the first email).
  const subSteps = [
    [1, async (maxQueries) => { done.stopped += await sweepStops(db, date, { maxQueries }); }],
    [1, async (maxQueries) => {
      queue = await queueDue(db, date, { maxQueries, demoReady: isReady });
      done.queued = queue.queued;
    }],
    [1, async (maxQueries) => {
      const s = await syncSent(db, date, { maxQueries });
      done.synced += s.firsts + s.followups;
      done.stopped += s.stopped;
    }],
    [1, async (maxQueries) => { done.retried += await retryFailed(db, date, { maxQueries }); }],
    [2, async (maxQueries) => { done.closed += await closeFinished(db, date, { maxQueries }); }],
    [1, async (maxQueries) => { heldFirsts = await flagHeldFirsts(db, date, { maxQueries }); }],
  ];
  let cut = false;
  for (const [first, run] of subSteps) {
    const left = cap - counted.used();
    if (left < first) {
      cut = true;
      break;
    }
    await run(left);
  }

  let summary = `synced ${done.synced}, stopped ${done.stopped}, retried ${done.retried}, closed ${done.closed}, queued ${done.queued}`;
  if (queue?.held === "templates") {
    const waiting = `waiting: follow-ups ${queue.approved}/${LAST_STEP} approved`;
    summary = Object.values(done).some(Boolean) ? `${summary}; ${waiting}` : waiting;
  }
  if (queue?.waiting) summary += `, on hold ${queue.waiting} (demo not available)`;
  if (heldFirsts) summary += `, first email${heldFirsts === 1 ? "" : "s"} on hold ${heldFirsts} (lead not ready)`;
  if (cut) summary += "; out of D1 queries, the rest next run";
  const problems = queue?.problems ?? [];
  if (problems.length) {
    const leads = `${problems.length} lead${problems.length === 1 ? "" : "s"}`;
    const which = `${problems.map((p) => p.place_id).join(", ")}: ${problems[0].error}`;
    const they = problems.length === 1 ? "Its follow-ups have stopped and it has" : "Their follow-ups have stopped and each has";
    throw new Error(`The followups step couldn't queue the follow-up for ${leads} (${which}). ${they} a todo. Done: ${summary}`);
  }
  return summary;
}

// ---- The Follow-ups health light (Part B, Task 15) ----

const LATE_MS = 24 * 3600000; // a follow-up this late (queued, or booked with the templates approved) makes it red
const LIGHT = "followups"; // not a prefix of the health:followup-… todos, so the health step's todo never closes them
const LATE_FIX = "Check the mailbox on Setup and the tick light.";
const APPROVE_FIX = "Approve them on the Voice page.";
const NAMED_MAILBOXES = 3; // paused mailboxes a red light names; more are "and N more"

// The light's facts in one statement, as stage 0 allows a registered light 1 D1 query (?1 = now, ?2 = 24 h ago,
// ?3 = DEMO_HOLD): how many of the 9 templates are approved; the follow-ups waiting to be queued (queueDue's due
// leads: booked for now or earlier, follow-ups left, emailed or viewed, no reply, opt-out or bounce since the first
// email); and the late ones, as two JSON lists of {mailbox_address, mailbox_status, n} by mailbox (so the text stays
// small however many are late): follow-ups still queued (the row's mailbox, else its thread's, the outbox's rule) and
// those booked but not queued yet. A lead whose open hold todo says its demo is down isn't counted late: that todo
// says why and what to do, and the light's "check the mailbox" would send Nik the wrong way. Step 9's close time is
// not a follow-up, so it isn't counted either.
// A follow-up is late 24 h after it could first have gone, never for time it waited by design (A4's gates): a booked
// one from its booking or the moment the 9th template was approved (the latest approved_at; none counts as long ago),
// whichever is later; a queued one from its due_at or the moment it was queued (created_at), whichever is later.
// queueDue queues a follow-up with its booking as due_at, so one that waited for Nik's approval or for its demo
// would otherwise be "a day late, check the mailbox" the moment it's queued, while nothing is wrong.
const LIGHT_SQL = `SELECT
    (SELECT COUNT(*) FROM followup_templates WHERE status = 'approved' AND step BETWEEN 1 AND ${LAST_STEP}) AS approved,
    (SELECT COUNT(*) FROM prospects p
      WHERE p.next_followup_at > '' AND p.next_followup_at <= ?1 AND p.stage IN ('emailed', 'viewed')
        AND p.followup_step < ${LAST_STEP} AND ${NO_STOP_INBOUND_SQL}) AS waiting,
    (SELECT json_group_array(json_object('mailbox_address', address, 'mailbox_status', status, 'n', n)) FROM (
      SELECT mb.address, mb.status, COUNT(*) AS n
        FROM messages m LEFT JOIN prospects p ON p.place_id = m.place_id
        LEFT JOIN mailboxes mb ON mb.id = COALESCE(m.mailbox_id, p.mailbox_id)
        WHERE m.status = 'queued' AND m.due_at < ?2 AND COALESCE(m.created_at, '') < ?2
          AND m.direction = 'out' AND m.kind = 'followup'
        GROUP BY mb.address, mb.status)) AS late_queued,
    (SELECT json_group_array(json_object('mailbox_address', address, 'mailbox_status', status, 'n', n)) FROM (
      SELECT mb.address, mb.status, COUNT(*) AS n
        FROM prospects p LEFT JOIN mailboxes mb ON mb.id = p.mailbox_id
        WHERE p.next_followup_at > '' AND p.next_followup_at < ?2 AND p.stage IN ('emailed', 'viewed')
          AND p.followup_step < ${LAST_STEP} AND ${NO_STOP_INBOUND_SQL}
          AND COALESCE((SELECT MAX(g.approved_at) FROM followup_templates g
            WHERE g.status = 'approved' AND g.step BETWEEN 1 AND ${LAST_STEP}), '') < ?2
          AND NOT EXISTS (SELECT 1 FROM todos t WHERE t.dedupe = ?3 || p.place_id AND t.status = 'open')
        GROUP BY mb.address, mb.status)) AS late_pending`;

const count = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
// "a", "a and b", "a, b and c", "a, b, c and 2 more".
function listOf(items) {
  const shownItems = items.slice(0, NAMED_MAILBOXES);
  const more = items.length - shownItems.length;
  if (more) return `${shownItems.join(", ")} and ${more} more`;
  return shownItems.length < 2 ? shownItems.join("") : `${shownItems.slice(0, -1).join(", ")} and ${shownItems.at(-1)}`;
}

/**
 * The Follow-ups health light (pure), A10: red when any follow-up is more than 24 h late (`overdue`, one
 * {mailbox_address, mailbox_status} each: the mailbox it goes from), naming the paused mailboxes among them; amber
 * when the 9 templates aren't all `approved` while follow-ups are `waiting` for them; green otherwise.
 * → {name: "followups", level, detail, fix} (fix empty when green). Missing facts count as none.
 */
export function followupHealth({ overdue = [], approved = false, waiting = 0 } = {}) {
  const late = Array.isArray(overdue) ? overdue : [];
  if (late.length) {
    const what = count(late.length, "follow-up is", "follow-ups are");
    const paused = [...new Set(late.filter((r) => r?.mailbox_status === "paused").map((r) => oneLine(r.mailbox_address)).filter(Boolean))];
    if (!paused.length) return { name: LIGHT, level: "red", detail: `${what} a day late.`, fix: LATE_FIX };
    const one = paused.length === 1;
    return {
      name: LIGHT,
      level: "red",
      detail: `${what} a day late: ${one ? "mailbox" : "mailboxes"} ${listOf(paused)} ${one ? "is" : "are"} paused.`,
      fix: `Open Setup → Mailboxes and fix the paused ${one ? "mailbox" : "mailboxes"}.`,
    };
  }
  const n = Math.max(0, Math.floor(Number(waiting) || 0));
  if (!approved && n) {
    return {
      name: LIGHT,
      level: "amber",
      detail: `${count(n, "follow-up is", "follow-ups are")} waiting for you to approve the wording on the Voice page.`,
      fix: APPROVE_FIX,
    };
  }
  return { name: LIGHT, level: "green", detail: "Follow-ups are on time.", fix: "" };
}

// LIGHT_SQL's JSON list of {mailbox_address, mailbox_status, n}, one group per mailbox, as {mailbox_address,
// mailbox_status, n} with n a whole number ≥ 1 (broken JSON or rows count as none).
function lateGroups(json) {
  let groups;
  try {
    groups = JSON.parse(json ?? "[]");
  } catch {
    groups = [];
  }
  return (Array.isArray(groups) ? groups : [])
    .map((g) => ({ mailbox_address: g?.mailbox_address ?? null, mailbox_status: g?.mailbox_status ?? null, n: Math.max(0, Math.floor(Number(g?.n) || 0)) }))
    .filter((g) => g.n > 0);
}

/**
 * The Follow-ups light as of `now` (a Date or UTC ISO text): followupHealth of the follow-ups still queued more than
 * 24 h after their due_at and after they were queued, plus, once all 9 templates are approved, those whose
 * next_followup_at is more than 24 h past and which were booked more than 24 h after the 9th approval too (not those
 * on hold for their demo, nor step 9's close time); and how many are due now while the templates aren't all
 * approved. Paused mailboxes come first among the late ones, by address. 1 D1 statement.
 */
export async function followupHealthFromDb(DB, now = new Date()) {
  const date = toDate(now, "the time now");
  const row = (await DB.prepare(LIGHT_SQL).bind(iso(date), iso(new Date(date.getTime() - LATE_MS)), DEMO_HOLD).first()) ?? {};
  const approved = Number(row.approved) === LAST_STEP;
  // The groups (one a mailbox) are sorted, then each becomes one entry per late follow-up: the CPU this costs never
  // grows with how many are late beyond one cheap fill.
  const overdue = [...lateGroups(row.late_queued), ...(approved ? lateGroups(row.late_pending) : [])]
    .sort((a, b) => Number(b.mailbox_status === "paused") - Number(a.mailbox_status === "paused")
      || String(a.mailbox_address ?? "").localeCompare(String(b.mailbox_address ?? "")))
    .flatMap(({ mailbox_address, mailbox_status, n }) => Array(n).fill({ mailbox_address, mailbox_status }));
  return followupHealth({ overdue, approved, waiting: Number(row.waiting) || 0 });
}

// Registered once, when this module loads (tick.js imports it for its step, so the separate ?reason=health call,
// which runs only the health step, has it too): 1 D1 statement.
registerLight((DB, env, now) => followupHealthFromDb(DB, now));
