// The daily automatic search, pure part (02-find Task 9): which town to search next, whether to search today, and
// the one line the Lead Scraper page shows about it. No database here: _lib/find.js reads the numbers and the tick
// step daily_find acts on the decision.
//
// The setting `territory` is JSON {on, trade, towns, next, max}, read by Python too (aetos_leads/autopilot.py).
// The defaults below must stay the same as autopilot.py's: lead-manager/tests/test_territory_sync.py reads this file
// as text, so keep DEFAULT_TERRITORY a literal object with a literal towns list.
import { addUkDays, ukDate, ukParts, ukToUtc } from "./ukTime.js";

// Same defaults as autopilot.py: around Warrington first (where Nik has been testing), then outwards.
export const DEFAULT_TERRITORY = Object.freeze({
  on: true,
  trade: "landscaper",
  towns: ["Warrington", "Widnes", "Runcorn", "St Helens", "Wigan", "Leigh", "Northwich", "Altrincham", "Sale",
    "Stockport", "Chester", "Crewe", "Bolton", "Bury", "Salford", "Knutsford", "Macclesfield", "Ellesmere Port"],
  next: 0,
  max: 60,
});
Object.freeze(DEFAULT_TERRITORY.towns);

export const RECENT_DAYS = 30; // a town searched for this trade in the last 30 UK days (failed runs aside) is skipped
export const GOOD_WAITING_MIN = 30; // graded A+/A/B leads not emailed yet: this many is about a month of first emails
export const RESEARCH_QUEUE_MAX = 40; // leads queued for Claude's research: this many is 2–3 days of research
export const MIN_RESEARCH_SCORE = 35; // a lead scoring this or more goes to research (Python's research.MIN_SCORE)
export const FIND_FROM = "06:00"; // UK time from which the day's decision is made

const MAX_TOWNS = 200;
const MAX_LEADS = [10, 300];
const TRADE_LENGTH = [2, 60];

// A town or trade as stored (spaces tidied) and a trade as compared (and without case).
const tidy = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
const same = (s) => tidy(s).toLowerCase();
// A town as compared, step for step Python's audit.town_key (the same spellings are tested on both sides): lower case,
// accents dropped (Môn = Mon), apostrophes removed (King's = Kings), "&" = "and", every other run of non-letters and
// non-digits (dots, commas, hyphens, dashes, "|", "_", spaces) one space, then the word "saint" → "st". So
// "St. Helens", "St.Helens", "Saint Helens" and "st helens" are one town, as are "Newton-le-Willows" and
// "Newton le Willows": a hand search spelt another way still makes the list town recent. leadRow (util.js) compares
// a lead's town with its Map Rank scan's town with it too.
export const townKey = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")
  .replace(/['‘’`]/g, "").replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  .split(" ").map((word) => (word === "saint" ? "st" : word)).join(" ");

const townsOf = (territory) => (Array.isArray(territory?.towns) ? territory.towns : []).map(tidy).filter(Boolean);
const isLeads = (n) => Number.isInteger(n) && n >= MAX_LEADS[0] && n <= MAX_LEADS[1];

// Where `next` points in a list of `length` towns. It wraps past the end; negative counts back from the end, as
// Python's % does; anything that isn't a number is the top of the list.
function pointer(next, length) {
  const n = Math.trunc(Number(next));
  return Number.isFinite(n) ? ((n % length) + length) % length : 0;
}

// Towns (as townKey) searched for `trade` in the RECENT_DAYS UK days before `ukToday`: a job is recent when
// ukDate(created_at) > addUkDays(ukToday, -RECENT_DAYS), i.e. it was created at or after 00:00 UK on the day after
// that. That instant is worked out once (UK midnight is never skipped or repeated), so each job is a plain number
// comparison instead of a UK-time lookup: the free plan allows 10 ms of CPU a request. A failed run, a run for
// another trade or a run with no readable time doesn't count.
function recentTowns(trade, recentJobs, ukToday) {
  const from = ukToUtc(addUkDays(ukToday, 1 - RECENT_DAYS), "00:00").getTime();
  const recent = new Set();
  for (const job of Array.isArray(recentJobs) ? recentJobs : []) {
    if (!job || same(job.trade) !== same(trade) || job.status === "failed") continue;
    const at = Date.parse(job.created_at ?? "");
    if (at >= from) recent.add(townKey(job.town)); // NaN (unreadable) is never >=
  }
  return recent;
}

// JSON text (or an object already parsed) → a plain object, or null when it isn't one.
function objectOf(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * The territory saved as `raw` (the settings value: JSON text, or an object already parsed) over the defaults.
 * Missing, unreadable or non-object JSON gives the defaults; so does a stored niche, town list or size that can't be
 * searched (they go straight to the GitHub run, which would fail every morning). Always a fresh copy: changing it
 * never changes the defaults.
 */
export function parseTerritory(raw) {
  const t = { ...DEFAULT_TERRITORY, ...(objectOf(raw) ?? {}) };
  const trade = typeof t.trade === "string" ? t.trade.trim() : "";
  const max = typeof t.max === "string" && t.max.trim() ? Number(t.max) : t.max;
  return {
    ...t,
    trade: trade || DEFAULT_TERRITORY.trade,
    towns: [...(Array.isArray(t.towns) ? t.towns : DEFAULT_TERRITORY.towns)],
    max: isLeads(max) ? max : DEFAULT_TERRITORY.max,
  };
}

/**
 * The Lead Scraper page's edit ({on, trade, towns, max}; towns as text, one per line or comma-separated, or a list)
 * checked and cleaned → {territory} or {error}. Towns are trimmed, de-duplicated as one town however they're written
 * (case, "St."/"Saint", hyphens; the first spelling is kept) and capped at 200. The place in the list (`next`) is
 * kept, wrapped to the new length, only when the trade and the list are the same as in `old` (case and spelling
 * aside); a new trade or list starts from the top.
 */
export function cleanTerritory(body, old) {
  const b = body && typeof body === "object" ? body : {};
  const trade = String(b.trade ?? "").trim();
  const raw = Array.isArray(b.towns) ? b.towns : typeof b.towns === "string" ? b.towns.split(/[\n,]/) : [];
  const towns = [];
  const seen = new Set();
  for (const name of raw.map(tidy)) {
    const key = townKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    towns.push(name);
    if (towns.length === MAX_TOWNS) break;
  }
  const max = b.max === undefined || b.max === null || b.max === "" ? DEFAULT_TERRITORY.max : Number(b.max);
  if (trade.length < TRADE_LENGTH[0] || trade.length > TRADE_LENGTH[1]) return { error: "Type the niche to search, e.g. landscaper" };
  if (!towns.length) return { error: "Add at least one town (one per line)" };
  if (!isLeads(max)) return { error: "Leads per search must be between 10 and 300" };

  const before = old && typeof old === "object" ? old : DEFAULT_TERRITORY;
  const oldTowns = townsOf(before);
  const unchanged = same(before.trade) === same(trade)
    && oldTowns.length === towns.length && oldTowns.every((town, i) => townKey(town) === townKey(towns[i]));
  return { territory: { on: !!b.on, trade, towns, next: unchanged ? pointer(before.next, towns.length) : 0, max } };
}

/**
 * The next town on the list, from `next` round to the one before it, not searched for this trade in the last 30 UK
 * days (`recentJobs`: [{trade, town, status, created_at}]), and the pointer after it → {town, next}; null when every
 * town is recent or the list is empty.
 */
export function chooseTown(territory, recentJobs, ukToday) {
  const towns = townsOf(territory);
  if (!towns.length) return null;
  const recent = recentTowns(territory.trade, recentJobs, ukToday);
  const start = pointer(territory.next, towns.length);
  for (let step = 0; step < towns.length; step++) {
    const i = (start + step) % towns.length;
    if (!recent.has(townKey(towns[i]))) return { town: towns[i], next: (i + 1) % towns.length };
  }
  return null;
}

/**
 * Today's decision, in Part A's order: switched off; a search (any, Nik's too) already queued or running; enough good
 * leads waiting; enough research queued; no town left → {search: false, reason, n?}. Otherwise
 * {search: true, town, next}. `n` is the count that stopped it (good and research only).
 */
export function decideFind({ territory, goodWaiting, researchQueued, activeJobs, recentJobs, ukToday }) {
  if (!territory?.on) return { search: false, reason: "off" };
  if (Number(activeJobs) > 0) return { search: false, reason: "running" };
  if (Number(goodWaiting) >= GOOD_WAITING_MIN) return { search: false, reason: "good", n: Number(goodWaiting) };
  if (Number(researchQueued) >= RESEARCH_QUEUE_MAX) return { search: false, reason: "research", n: Number(researchQueued) };
  const pick = chooseTown(territory, recentJobs, ukToday);
  return pick ? { search: true, ...pick } : { search: false, reason: "towns" };
}

// "HH:MM" UK time of an ISO time, or "" when it can't be read.
function ukClock(iso) {
  const at = new Date(iso ?? "");
  if (Number.isNaN(at.getTime())) return "";
  const { hh, mm } = ukParts(at);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// The count that stopped today's search, or "enough" if it wasn't saved (never "undefined" on Nik's page).
const count = (n) => (n !== null && n !== "" && Number.isFinite(Number(n)) ? Number(n) : "enough");

const SKIPPED = {
  off: () => "Off. Nothing is searched automatically",
  good: (n) => `Skipped: ${count(n)} good leads waiting`,
  research: (n) => `Skipped: Claude has ${count(n)} leads to research first`,
  running: () => "Skipped: a search was already running",
  towns: () => "Skipped: every town on your list was searched in the last 30 days. Add more towns",
};

/**
 * The Lead Scraper page's "Today:" line (Part A's table) for the saved decision `find:today`
 * ({day, at, search, town?, job_id?, reason?, n?, error?}, parsed or as the saved JSON text) and its jobs row (or
 * null). A decision from an earlier UK day, or none, is "Decided after 6am". Plain text: the page escapes it (the
 * error can be GitHub's own words).
 */
export function todayLine(saved, job, now = new Date()) {
  const decision = objectOf(saved);
  if (!decision || decision.day !== ukDate(now)) return "Decided after 6am";
  const town = tidy(decision.town);
  if (decision.error) {
    return town ? `Couldn't start the search for ${town}: ${decision.error}` : `Couldn't start today's search: ${decision.error}`;
  }
  if (decision.search) {
    const at = ukClock(decision.at) || ukClock(job?.created_at);
    if (job?.status === "done") return `Searched ${town}${at && ` at ${at}`} — ${Number(job.found) || 0} found`;
    if (job?.status === "failed") return `Searched ${town}${at && ` at ${at}`} — it failed: ${job.error || "no reason was recorded"}`;
    return `Searching ${town}${at && ` (started ${at})`}`;
  }
  const line = SKIPPED[decision.reason];
  return line ? line(decision.n) : "Skipped today";
}
