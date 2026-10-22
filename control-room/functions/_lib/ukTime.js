// UK time helpers (pure). Everything is stored in UTC; every rule about days and hours uses Europe/London.
// Dates are JS Date; strings are UK local "YYYY-MM-DD" (dates) and "HH:MM" (times). Weekday 0 = Sunday.

const ZONE = "Europe/London";
const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

const FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

const pad = (n, width = 2) => String(n).padStart(width, "0");

function checkDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`UK time needs a valid date, got ${String(date)}`);
  }
}

// Minutes the UK clock is ahead of UTC during UTC hour number `hour` (0 in GMT, 60 in BST). UK clocks only change
// on the UTC hour, so one Intl call per hour is enough. The cache matters: an Intl call costs several microseconds,
// later stages call these helpers in loops, and the free Workers plan allows 10 ms of CPU per request.
const offsetCache = new Map();
function offsetAtHour(hour) {
  let off = offsetCache.get(hour);
  if (off === undefined) {
    const p = {};
    for (const { type, value } of FORMAT.formatToParts(new Date(hour * HOUR_MS))) p[type] = Number(value);
    // `% 24`: some ICU builds have printed midnight as "24"; it is hour 0 of the same day.
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
    off = Math.round((asUtc - hour * HOUR_MS) / MINUTE_MS);
    if (offsetCache.size >= 4096) offsetCache.clear();
    offsetCache.set(hour, off);
  }
  return off;
}

const offsetMinutes = (ms) => offsetAtHour(Math.floor(ms / HOUR_MS));

// The UK wall clock at `date`: the UTC fields of `date` shifted by the UK offset.
function wall(date) {
  checkDate(date);
  const t = new Date(date.getTime() + offsetMinutes(date.getTime()) * MINUTE_MS);
  return {
    y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(),
    hh: t.getUTCHours(), mm: t.getUTCMinutes(), weekday: t.getUTCDay(),
  };
}

function parseUkDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str));
  const y = m && Number(m[1]), mo = m && Number(m[2]), d = m && Number(m[3]);
  const back = m && new Date(Date.UTC(y, mo - 1, d));
  if (!m || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new Error(`UK date must look like YYYY-MM-DD, got ${JSON.stringify(str)}`);
  }
  return { y, m: mo, d };
}

function parseHhMm(str, { allowMidnightEnd = false } = {}) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str));
  const hh = m && Number(m[1]), mm = m && Number(m[2]);
  const ok = m && mm < 60 && (hh < 24 || (allowMidnightEnd && hh === 24 && mm === 0));
  if (!ok) throw new Error(`UK time must look like HH:MM (00:00 to 23:59), got ${JSON.stringify(str)}`);
  return hh * 60 + mm;
}

// The UTC instants (ms, earliest first) when the UK clock reads `minutes` past midnight on UK day y-m-d: one
// normally, two in the hour the clocks go back, none in the hour they go forward. `guess` is that wall time read as
// UTC; `before` is the offset in force a day earlier.
function instantsAt(y, m, d, minutes) {
  const guess = Date.UTC(y, m - 1, d) + minutes * MINUTE_MS;
  // UK clocks change months apart, so the offsets a day either side are the only ones that can apply here.
  const before = offsetMinutes(guess - DAY_MS);
  const after = offsetMinutes(guess + DAY_MS);
  // Subtract each offset, then re-check the offset at the result: it fits when the two agree.
  const fits = [...new Set([before, after])]
    .filter((off) => offsetMinutes(guess - off * MINUTE_MS) === off)
    .map((off) => guess - off * MINUTE_MS)
    .sort((a, b) => a - b);
  return { guess, before, fits };
}

// The first instant after `fromMs` (up to `toMs`) at which the UK offset changes, or null. UK clocks change months
// apart and on the UTC hour, so a week holds at most one change and it starts a UTC hour.
function clockChange(fromMs, toMs) {
  let lo = Math.floor(fromMs / HOUR_MS);
  let hi = Math.floor(toMs / HOUR_MS);
  const first = offsetAtHour(lo);
  if (offsetAtHour(hi) === first) return null;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAtHour(mid) === first) lo = mid;
    else hi = mid;
  }
  return hi * HOUR_MS;
}

/** The UK wall clock at `date`: {y, m, d, hh, mm, weekday}, weekday 0 = Sunday. */
export function ukParts(date) {
  const { y, m, d, hh, mm, weekday } = wall(date);
  return { y, m, d, hh, mm, weekday };
}

/** The UK calendar day of `date`, "YYYY-MM-DD". */
export function ukDate(date) {
  const { y, m, d } = wall(date);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/**
 * The UTC instant of UK wall time `hhmm` on UK day `ukDateStr`.
 * A time that happens twice (01:30 on the October change) gives the first one; a time that doesn't exist
 * (01:30 on the March change) is read with the offset from before the change, i.e. the later wall time (02:30 BST).
 */
export function ukToUtc(ukDateStr, hhmm) {
  const { y, m, d } = parseUkDate(ukDateStr);
  const { guess, before, fits } = instantsAt(y, m, d, parseHhMm(hhmm));
  return new Date(fits.length ? fits[0] : guess - before * MINUTE_MS);
}

/** Saturday or Sunday in UK time. */
export function isWeekendUK(date) {
  const { weekday } = wall(date);
  return weekday === 0 || weekday === 6;
}

/** Inside `window` ({start: "HH:MM", end: "HH:MM", days: [0..6]}) in UK time: start inclusive, end exclusive. */
export function inUkWindow(date, window) {
  const { hh, mm, weekday } = wall(date);
  const now = hh * 60 + mm;
  return window.days.includes(weekday)
    && now >= parseHhMm(window.start)
    && now < parseHhMm(window.end, { allowMidnightEnd: true });
}

/** `date` itself when it's inside `window`, else the UTC instant the window next opens (looks 8 UK days ahead). */
export function nextUkWindowStart(date, window) {
  if (inUkWindow(date, window)) return date;
  const start = parseHhMm(window.start);
  const today = ukDate(date);
  // A window opens when the UK clock reaches `start` on a listed day, or when the clocks change: in March a start
  // inside the skipped hour opens at the jump, and in October a window can reopen in the repeated hour.
  const candidates = [];
  for (let i = 0; i < 8; i++) {
    const { y, m, d } = parseUkDate(addUkDays(today, i));
    if (window.days.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay())) {
      candidates.push(...instantsAt(y, m, d, start).fits);
    }
  }
  const end = parseUkDate(addUkDays(today, 8));
  const change = clockChange(date.getTime(), Date.UTC(end.y, end.m - 1, end.d));
  if (change !== null) candidates.push(change);
  for (const ms of candidates.sort((a, b) => a - b)) {
    if (ms > date.getTime() && inUkWindow(new Date(ms), window)) return new Date(ms);
  }
  throw new Error(`The time window has no open hours in the next week: check its days and start/end times (${JSON.stringify(window)})`);
}

/** The UK day `n` days after `ukDateStr` (n may be negative). */
export function addUkDays(ukDateStr, n) {
  const { y, m, d } = parseUkDate(ukDateStr);
  if (!Number.isInteger(n)) throw new Error(`addUkDays needs a whole number of days, got ${String(n)}`);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** The UTC instant of 00:00 UK on the UK day of `date`. */
export function ukDayStartUtc(date) {
  return ukToUtc(ukDate(date), "00:00");
}
