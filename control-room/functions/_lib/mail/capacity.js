// Mailbox capacity (pure): the warm-up ramp, each mailbox's daily cap on cold email (first + followup), and which
// mailbox sends the next cold email. Dates are UK local "YYYY-MM-DD" strings (ukDate(now) for today).

const DAY_MS = 86400000;

// Cold sends a day by days since started_on: [from day, cap]. Before day 0 (a future start) the cap is 0.
const RAMP = [[35, 10], [28, 8], [21, 5], [14, 3], [0, 0]];

// UTC midnight of a "YYYY-MM-DD" string, or null when it isn't a real date.
function dayMs(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str ?? ""));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

// UTC midnight of the caller's UK today. It always comes from ukDate()/addUkDays(), so anything else (a Date, an ISO
// timestamp) is a bug in the caller: throw, as ukTime.js does, instead of quietly giving every mailbox a cap of 0.
function todayMs(ukToday) {
  const ms = dayMs(ukToday);
  if (ms === null) throw new Error(`UK date must look like YYYY-MM-DD, got ${JSON.stringify(ukToday)}`);
  return ms;
}

// Days from started_on to ukToday (UTC-midnight difference of the two date strings), or null when started_on (stored
// data) is unreadable. An unreadable ukToday throws.
function daysSince(startedOn, ukToday) {
  const today = todayMs(ukToday), start = dayMs(startedOn);
  return start === null ? null : Math.round((today - start) / DAY_MS);
}

// cap_override as a whole number ≥ 0, or null when it isn't set. Blank, unreadable or non-numeric means "not set",
// so the warm-up ramp applies (never a silent 0 or 1 from "" or a boolean, never Infinity).
function overrideOf(value) {
  if (typeof value === "string" ? value.trim() === "" : typeof value !== "number") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

/**
 * Warm-up cap: 0 for days 0–13, then 3 / 5 / 8 / 10 from days 14 / 21 / 28 / 35. An unreadable started_on gives 0
 * (never over-sends); an unreadable ukToday throws.
 */
export function rampCap(startedOn, ukToday) {
  const days = daysSince(startedOn, ukToday);
  if (days === null || days < 0) return 0;
  for (const [from, cap] of RAMP) if (days >= from) return cap;
  return 0;
}

/**
 * A mailbox's cold cap for a UK day: 0 when paused or when started_on is after that day (not bought yet), else
 * cap_override when set, else the warm-up ramp.
 */
export function mailboxCap(mailbox, ukToday) {
  todayMs(ukToday);
  if (!mailbox || mailbox.status === "paused") return 0;
  const days = daysSince(mailbox.started_on, ukToday);
  if (days !== null && days < 0) return 0;
  const override = overrideOf(mailbox.cap_override);
  return override !== null ? override : rampCap(mailbox.started_on, ukToday);
}

/**
 * The active cold mailbox with the most room left on a UK day (its cap minus what it has sent), ties broken by id
 * ascending. null when no cold mailbox has any room. System mailboxes never send cold email.
 */
export function pickMailbox(mailboxes, sentTodayById, ukToday) {
  todayMs(ukToday);
  const sent = sentTodayById || {};
  let best = null, bestRoom = 0;
  for (const m of mailboxes || []) {
    if (!m || m.role !== "cold" || m.status !== "active") continue;
    const room = mailboxCap(m, ukToday) - (Number(sent[m.id]) || 0);
    if (room <= 0) continue;
    if (room > bestRoom || (room === bestRoom && String(m.id) < String(best.id))) {
      best = m;
      bestRoom = room;
    }
  }
  return best;
}
