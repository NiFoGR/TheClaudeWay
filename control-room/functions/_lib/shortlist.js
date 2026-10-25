// Shortlist rules (pure, no D1): the Leads page's filters as they arrive in the URL, literal LIKE patterns, today's
// room for first emails and the banner that explains it, the warm-up date, which grades are in Ready, the morning
// pick todo's title, and the one hot rule. Rules are docs/rebuild/04-shortlist.md Part A.
//
// Owned by stage 3. Other stages import from here and never copy: isHot (stage 4's hot step, the Todo board),
// STAGE_LABELS (the Todo board) and capacityBanner (stage 6's composer, through capacityNow).

import { mailboxCap } from "./mail/capacity.js";
import { COLD_WINDOW } from "./mail/outbox.js";
import { addUkDays } from "./ukTime.js";

const DAY_MS = 86400000;
const Q_MAX = 100; // search text, in characters
const WARMUP_SCAN_DAYS = 60;

export const GRADES = Object.freeze(["A+", "A", "B", "C", "D"]);
// URL tokens: a raw "+" in a query string reads as a space, so "A+" is never a token. none = not graded.
export const GRADE_TOKENS = Object.freeze({ ap: "A+", a: "A", b: "B", c: "C", d: "D", none: null });
export const STAGE_TOKENS = Object.freeze(["ready", "emailed", "viewed", "replied", "needs_nik", "call_booked", "won", "lost", "none"]);
export const STAGE_LABELS = Object.freeze({
  ready: "Ready to email", emailed: "Emailed", viewed: "Opened demo", replied: "Replied", needs_nik: "Needs you",
  call_booked: "Call booked", won: "Won", lost: "Lost", none: "Not contacted",
});
export const PAGE_SIZE = 50;

const HOT_STAGES = new Set(["emailed", "viewed"]);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// A count from the caller (D1 numbers, sums) as a whole number ≥ 0; anything unreadable is 0.
function count(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const params = (sp) => (sp && typeof sp.get === "function" && typeof sp.getAll === "function" ? sp : new URLSearchParams(sp ?? ""));

// Comma-separated tokens of every `key` param, each matched exactly (no trimming, no case folding), in the order
// given, without repeats. `valueOf(token)` gives the value or undefined to drop it. None left → null (no filter).
function tokens(sp, key, valueOf) {
  const out = [];
  for (const raw of sp.getAll(key)) {
    for (const token of raw.split(",")) {
      const value = valueOf(token);
      if (value !== undefined && !out.includes(value)) out.push(value);
    }
  }
  return out.length ? out : null;
}

const gradeOf = (token) => {
  if (!Object.hasOwn(GRADE_TOKENS, token)) return undefined;
  return token === "none" ? "none" : GRADE_TOKENS[token];
};
const stageOf = (token) => (STAGE_TOKENS.includes(token) ? token : undefined);

const flag = (value) => (value === "1" ? true : value === "0" ? false : null);
const text = (value) => (value ? value : null);

// Search text: trimmed, at most Q_MAX characters (code points, so an emoji is never cut in half). The first Q_MAX
// code points fit in 2 × Q_MAX UTF-16 units, so a very long URL is cut before it is split (CPU on the free plan).
function searchText(raw) {
  return Array.from(String(raw ?? "").trim().slice(0, Q_MAX * 2)).slice(0, Q_MAX).join("").trim();
}

/**
 * `GET /api/leads` query → filters. Unknown values fall back to the defaults: view "ready", no grade/stage/email/
 * researched filter (null), q "" (trimmed, at most 100 characters), excluded false, page 1. Grades hold grade values
 * ("A+" … "D") and "none" for not graded; stages hold stage tokens ("none" = no prospect row).
 */
export function parseLeadFilters(searchParams) {
  const sp = params(searchParams);
  const page = sp.get("page") ?? "";
  return {
    view: sp.get("view") === "all" ? "all" : "ready",
    grades: tokens(sp, "grade", gradeOf),
    trade: text(sp.get("trade")),
    town: text(sp.get("town")),
    email: flag(sp.get("email")),
    stages: tokens(sp, "stage", stageOf),
    researched: flag(sp.get("researched")),
    q: searchText(sp.get("q")),
    excluded: sp.get("excluded") === "1",
    job: text(sp.get("job")),
    page: /^[0-9]{1,9}$/.test(page) ? Math.max(1, Number(page)) : 1,
  };
}

/**
 * A LIKE pattern matching `q` literally anywhere: `%…%` with \ % _ escaped (use with ESCAPE '\'). Only for short text:
 * D1 refuses LIKE patterns over 50 bytes, so the Leads search (shortlist-db.js searchSql) uses instr instead.
 */
export function likePattern(q) {
  return `%${String(q ?? "").replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** First emails that can still go today: max(0, cap − sent − followupsDue − firstQueued). */
export function firstEmailRoom({ cap, sent, followupsDue, firstQueued } = {}) {
  return Math.max(0, count(cap) - count(sent) - count(followupsDue) - count(firstQueued));
}

// The weekday (0 = Sunday) of a UK day "YYYY-MM-DD" (noon UTC, so the day never shifts).
const weekdayOf = (ukDay) => new Date(`${ukDay}T12:00:00Z`).getUTCDay();

/**
 * The first UK day ("YYYY-MM-DD"), from `ukToday` up to 60 days ahead, on which any active cold mailbox may send
 * cold email: a send day of stage 0's COLD_WINDOW (Mon–Sat, so never a Sunday) with mailboxCap > 0. null when none can
 * in that time.
 */
export function warmupFrom(mailboxes, ukToday) {
  const cold = (Array.isArray(mailboxes) ? mailboxes : []).filter((m) => m && m.role === "cold" && m.status === "active");
  if (!cold.length) return null;
  for (let i = 0; i <= WARMUP_SCAN_DAYS; i++) {
    const day = addUkDays(ukToday, i);
    if (!COLD_WINDOW.days.includes(weekdayOf(day))) continue;
    if (cold.some((m) => mailboxCap(m, day) > 0)) return day;
  }
  return null;
}

/** Grades in Ready: A+ and A always; B only when today's room is larger than the ready A+/A leads (`top`). */
export function readyGrades(room, top) {
  return Number(room) > Number(top) ? ["A+", "A", "B"] : ["A+", "A"];
}

// "Tue 3 Nov" for a UK day "YYYY-MM-DD" (noon UTC, so the day never shifts), or null when it isn't a date.
function shortDay(ukDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ukDay ?? ""))) return null;
  const d = new Date(`${ukDay}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Older ICU data writes "Tue, 3 Nov"; the banner's wording has no comma.
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
}

// The UK day after `ukDay`, or null when it isn't a date (addUkDays throws on one).
function dayAfter(ukDay) {
  try {
    return addUkDays(String(ukDay ?? ""), 1);
  } catch {
    return null;
  }
}

// A paused mailbox's reason as part of a sentence (the stored reasons end with a full stop).
function pausedReason(p) {
  const reason = String(p?.reason ?? p?.paused_reason ?? "").trim().replace(/\.+$/, "").trim();
  return reason || "no reason was saved";
}

const setupLink = () => ({ href: "#/setup", label: "Open Setup" });

/**
 * The Leads page's capacity banner, first matching row wins: no cold mailbox, every cold mailbox paused, warming up
 * (cap 0), no room left, else how many first emails can go. `c = {mailboxes (count of cold mailboxes),
 * paused: [{address, reason}], cap, sent, followupsDue, firstQueued, room, warmupFrom}`; `room` is used as given
 * (stage 6 caps it further), falling back to firstEmailRoom(c).
 * capacityNow also passes `today` (the UK day), `sendDay` (the UK day cold email next goes: today inside stage 0's
 * COLD_WINDOW, Mon–Sat 07:00–19:00 UK, else the next window's) and `nextDay` (the first send day after today). Only
 * when they're there: outside the window the ok text says they're written now and go out on `sendDay` from 07:00,
 * and with no room "tomorrow" becomes "on {nextDay}" when tomorrow isn't a send day (a Saturday).
 */
export function capacityBanner(c = {}) {
  const mailboxes = Array.isArray(c.mailboxes) ? c.mailboxes.length : count(c.mailboxes);
  const paused = Array.isArray(c.paused) ? c.paused.filter(Boolean) : [];
  const cap = count(c.cap);
  const room = c.room === undefined || c.room === null ? firstEmailRoom(c) : count(c.room);

  if (mailboxes === 0) return { tone: "warn", text: "Add your mailbox on Setup to start emailing.", link: setupLink() };
  if (paused.length && paused.length >= mailboxes) {
    return { tone: "warn", text: `Sending is paused: ${pausedReason(paused[0])}. Fix it on Setup.`, link: setupLink() };
  }
  if (cap === 0) {
    const from = shortDay(c.warmupFrom);
    if (from) return { tone: "info", text: `Your mailbox is warming up. First emails can go from ${from}.`, link: null };
    // Not warming up: no active cold mailbox reaches a daily limit above 0 in the next 60 days.
    return {
      tone: "warn",
      text: "No first emails can go in the next 60 days: check your mailbox's start date and daily limit on Setup.",
      link: setupLink(),
    };
  }

  const followupsDue = count(c.followupsDue), sent = count(c.sent), firstQueued = count(c.firstQueued);
  const details = [`${cap} a day`];
  if (followupsDue) details.push(`${plural(followupsDue, "follow-up", "follow-ups")} already due`);
  if (sent) details.push(`${sent} already sent`);
  if (firstQueued) details.push(`${plural(firstQueued, "first email", "first emails")} waiting to go`);
  const said = details.join(", ");

  if (room === 0) {
    const tomorrow = dayAfter(c.today);
    const next = tomorrow && c.nextDay && c.nextDay !== tomorrow ? shortDay(c.nextDay) : null;
    const when = next ? `on ${next}` : "tomorrow";
    return { tone: "info", text: `No room for more first emails today (${said}). The next ones can go ${when}.`, link: null };
  }
  const later = c.today && c.sendDay && c.sendDay !== c.today ? shortDay(c.sendDay) : null;
  if (later) {
    return {
      tone: "ok",
      text: `You can write ${plural(room, "first email", "first emails")} now. They go out ${later} from ${COLD_WINDOW.start} (${said}).`,
      link: null,
    };
  }
  return { tone: "ok", text: `You can send ${plural(room, "first email", "first emails")} today (${said}).`, link: null };
}

/**
 * The morning pick todo's title, or null when there's nothing to pick (no room, or nothing ready). A+/A leads are
 * counted when there are any; otherwise B leads, only when B is in Ready today (`bIncluded`).
 */
export function pickTitle({ top, b, room, bIncluded } = {}) {
  const r = count(room), t = count(top), nb = count(b);
  if (r === 0) return null;
  const tail = `ready: you can send ${plural(r, "first email", "first emails")} today`;
  if (t > 0) return `${plural(t, "A-grade lead", "A-grade leads")} ${tail}`;
  if (bIncluded && nb > 0) return `${plural(nb, "B-grade lead", "B-grade leads")} ${tail}`;
  return null;
}

/**
 * The one hot rule for the whole app: stage `emailed` or `viewed`, no reply yet (`last_inbound_at` empty), and the
 * demo opened at least twice or within the last 24 hours. `prospect` is a prospects row (or the same fields).
 */
export function isHot(prospect, now) {
  if (!prospect || !HOT_STAGES.has(prospect.stage)) return false;
  if (String(prospect.last_inbound_at ?? "").trim()) return false;
  if (count(prospect.views) >= 2) return true;
  const viewedAt = Date.parse(prospect.last_view_at ?? "");
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(viewedAt) && Number.isFinite(nowMs) && nowMs - viewedAt <= DAY_MS;
}
