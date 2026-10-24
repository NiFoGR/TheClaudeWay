// Claude's research in D1 (stage 2, 03-research-grade.md). The rules are pure, in research.js (validation, notes, the
// parsed row, the health light); this file reads and writes the `research` table and the claims in `settings`.
//
// The queue (Task 4, tests/research-queue.test.mjs): the research Routine takes up to 8 queued leads a call, with
// everything the scraper already knows. Each one handed out is claimed for CLAIM_HOURS (settings key
// research:claim:<place_id> = the claim time, iso text), so two runs at once (the 06:47 schedule and an after-search
// fire) never research the same lead, and a run that dies hands its leads back after 3 hours.
//
// It also registers the research health light (Task 7, at the bottom), so tick.js imports it; it never imports tick.js.
import { leadSuppressed } from "./find.js";
import { registerLight } from "./health.js";
import { latestNikNote, mergeNotes, parseResearch, researchLight } from "./research.js";
import { fireRoutine } from "./routines.js";
import { ukDate, ukParts } from "./ukTime.js";
import { iso, leadRow, mapsFromAnotherTown, parseJson } from "./util.js";

/** Hours a lead handed to a run stays claimed. */
export const CLAIM_HOURS = 3;
/** Leads per queue call: at most, and the default. */
export const QUEUE_LIMIT = 8;
const CLAIM_PREFIX = "research:claim:";
/** The settings key holding the claim on one lead (the post deletes it; "Research is wrong" clears it). */
export const claimKey = (placeId) => `${CLAIM_PREFIX}${placeId}`;

const HOUR_MS = 3_600_000;
const REVIEWS_MAX = 3;
const REVIEW_CHARS = 400;
const AUTHOR_CHARS = 100;
const REASON_CHARS = 200;

// The note line a queued row gets when it's skipped (Part A). Each row keeps its notes (Nik's lines included); the
// line goes below them.
const SKIP_MISSING = "Skipped: the lead no longer exists.";
const SKIP_SUPPRESSED = "Skipped: this business is on the do-not-contact list (opted out, bounced or blocked).";
// The scraper's exclude_reason on one line (notes are read line by line), without a full stop of its own before ours.
const excludeWhy = (reason) => String(reason ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_CHARS).replace(/[.\s]+$/, "");
function skipExcluded(reason) {
  const why = excludeWhy(reason);
  return why ? `Skipped: the scraper excluded this lead (${why}).` : "Skipped: the scraper excluded this lead.";
}

// A research row and its lead's state; lead_id NULL = the lead was deleted (a re-scrape) since it was queued.
const LEAD_STATE = `SELECT r.place_id, l.place_id AS lead_id, l.excluded, l.exclude_reason, l.email, l.website, l.company_number
  FROM research r LEFT JOIN leads l ON l.place_id = r.place_id`;
// Every queued row (the queue), or one row ("Research is wrong").
const LOOK_SQL = `${LEAD_STATE}
  WHERE r.status = 'queued'`;
const STATE_SQL = `${LEAD_STATE}
  WHERE r.place_id = ?`;
const SUPPRESSION_SQL = "SELECT value, kind FROM suppression";
// ?1 = JSON {place_id: note line}. Only rows still queued: one posted, skipped or purged since the look is left alone.
// The line goes below the notes, unless their last line is already exactly it (a lead Nik brought back that is
// skipped again for the same reason): then the notes stay as they are. Compared as text (no LIKE: a scraped reason
// may hold % or _), on the notes without their trailing blank lines.
const BLANK = "char(32, 9, 13, 10)";
const SKIP_LINE = "(SELECT j.value FROM json_each(?1) AS j WHERE j.key = research.place_id)";
const KEPT_NOTES = `RTRIM(COALESCE(notes, ''), ${BLANK})`;
const SKIP_SQL = `UPDATE research SET status = 'skipped',
    notes = CASE
      WHEN ${KEPT_NOTES} = ${SKIP_LINE}
        OR substr(${KEPT_NOTES}, -(length(${SKIP_LINE}) + 1)) = char(10) || ${SKIP_LINE} THEN notes
      WHEN TRIM(COALESCE(notes, ''), ${BLANK}) = '' THEN ${SKIP_LINE}
      ELSE RTRIM(notes, ${BLANK}) || char(10) || ${SKIP_LINE} END
  WHERE status = 'queued' AND place_id IN (SELECT j.key FROM json_each(?1) AS j)`;

// The research columns, read as r_<name> (leads has its own status, emails and notes).
const RESEARCH_COLUMNS = ["status", "grade", "points", "grade_reason", "angle", "opener", "owner", "best_email",
  "best_email_why", "emails", "copy", "site_review", "too_big", "notes", "searched", "queued_at", "researched_at"];
// json_extract throws on text that isn't JSON, so one bad audit can't stop the queue.
const AUDIT = "CASE WHEN json_valid(l.audit) THEN l.audit END";
// A re-check: researched before, or put back by Nik ("Research is wrong" writes a "[Nik …]" line on top, and only Nik
// writes those). The second covers a row he brings back that Claude never researched, or whose research the 12-month
// purge blanked (researched_at NULL): the card calls both "Being re-checked after your note" and his toast says Claude
// was asked now, so they go first and carry his note too. Lines as research.js latestNikNote reads them.
const NIK_LINE = `(substr(COALESCE(r.notes, ''), 1, 5) = '[Nik ' OR instr(COALESCE(r.notes, ''), char(10) || '[Nik ') > 0)`;
// The leads to hand out, best first. ?1 = the claim cutoff (claims at or after it still hold), ?2 = how many. Order
// (Part A): re-checks (above), then a real email from the scraper (not guessed), then the best score, then the longest
// waiting; place_id last, so the order is total and two reads of it in one transaction pick the same rows.
const PICKABLE = `FROM research r
  JOIN leads l ON l.place_id = r.place_id
  LEFT JOIN lead_map_rank m ON m.place_id = r.place_id
  LEFT JOIN settings c ON c.key = '${CLAIM_PREFIX}' || r.place_id
  WHERE r.status = 'queued' AND l.excluded = 0 AND (c.value IS NULL OR c.value < ?1)
  ORDER BY (r.researched_at IS NOT NULL OR ${NIK_LINE}) DESC,
    (TRIM(COALESCE(l.email, '')) != '' AND COALESCE(json_extract(${AUDIT}, '$.email_source'), '') != 'guessed') DESC,
    l.quality_score DESC, r.queued_at ASC, r.place_id ASC
  LIMIT ?2`;
const PICK_SQL = `SELECT l.*, ${RESEARCH_COLUMNS.map((c) => `r.${c} AS r_${c}`).join(", ")},
    m.scan_id AS m_scan_id, m.keyword AS m_keyword, m.town AS m_town, m.avg_rank AS m_avg_rank,
    m.top3_pct AS m_top3_pct, m.found_pct AS m_found_pct
  ${PICKABLE}`;
// Claims exactly the rows PICK_SQL read (?1, ?2 as there; ?3 = the claim time). It runs right after the pick in the same
// batch, which D1 runs as one transaction with nothing in between: a second call at the same moment (the 06:47
// schedule and an after-search fire) already sees these claims and gets the next leads.
const CLAIM_SQL = `INSERT OR REPLACE INTO settings (key, value)
  SELECT '${CLAIM_PREFIX}' || p.place_id, ?3 FROM (SELECT r.place_id ${PICKABLE}) AS p`;
const COUNT_SQL = "SELECT COUNT(*) AS n FROM research WHERE status = 'queued'";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// Text the scraper found, or null (it saves "" for nothing found).
const found = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** limit as a whole number from 1 to QUEUE_LIMIT; missing, 0 or unreadable → QUEUE_LIMIT. */
export function queueLimit(value) {
  return Math.min(QUEUE_LIMIT, Math.max(1, Math.trunc(Number(value)) || QUEUE_LIMIT));
}

// Text cut to at most `max` UTF-16 units (as .length counts), at a word where one is near, with "…".
function clip(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "");
  const space = cut.lastIndexOf(" ");
  if (space > max * 0.6) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

// The best Google reviews the scraper kept (audit.reviews, brand.top_reviews: {author, text, rating}), 3 at most.
function topReviews(reviews) {
  const out = [];
  for (const r of Array.isArray(reviews) ? reviews : []) {
    if (out.length === REVIEWS_MAX) break;
    const text = isObj(r) && typeof r.text === "string" ? clip(r.text.replace(/\s+/g, " ").trim(), REVIEW_CHARS) : "";
    if (!text) continue;
    out.push({ author: clip(typeof r.author === "string" ? r.author.trim() : "", AUTHOR_CHARS), rating: num(r.rating), text });
  }
  return out;
}

const leadGone = (row) => row.lead_id === null || row.lead_id === undefined;
// Why Claude may not research a lead now, from its LEAD_STATE row and the suppression rows: "missing" (deleted by a
// re-scrape), "excluded" (by the scraper), "suppressed" (the do-not-contact list), or null when it may. The suppression
// rows are only needed for a lead that is neither.
function unresearchable(row, suppression) {
  if (leadGone(row)) return "missing";
  if (Number(row.excluded)) return "excluded";
  if (leadSuppressed({ email: row.email, website: row.website, company_number: row.company_number }, suppression)) {
    return "suppressed";
  }
  return null;
}

// Why a queued row can't be handed out (its note line), or null when it can.
function skipLine(row, suppression) {
  const why = unresearchable(row, suppression);
  if (why === "missing") return SKIP_MISSING;
  if (why === "excluded") return skipExcluded(row.exclude_reason);
  return why === "suppressed" ? SKIP_SUPPRESSED : null;
}

// One picked row → the Part A queue item.
function queueLead(row, origin) {
  // leadRow reads audit.findings, so an audit that isn't a JSON object goes in as none.
  const l = leadRow({ ...row, audit: isObj(parseJson(row.audit, null)) ? row.audit : null });
  const audit = l.audit;
  const town = l.town || l.search_town;
  // No false Maps lines: another town's scan says nothing about this lead (leadRow has already dropped its maps_* and
  // reviews_behind findings). Its lead_map_rank row must be of its own town too.
  const ownMaps = !mapsFromAnotherTown(audit.map_rank, l) && !mapsFromAnotherTown({ scan_town: row.m_town }, l);
  const map_rank = row.m_scan_id !== null && row.m_scan_id !== undefined && ownMaps ? {
    keyword: row.m_keyword, town: row.m_town, top3_pct: row.m_top3_pct, found_pct: row.m_found_pct, avg_rank: row.m_avg_rank,
    source_url: `${origin}/#/maprank?scan=${encodeURIComponent(row.m_scan_id)}&biz=${encodeURIComponent(l.place_id)}`,
  } : null;
  const { total: _total, ...parts } = isObj(l.score_parts) ? l.score_parts : {};
  // previous only when there is earlier research to show; Nik's newest note whenever he put the lead back (NIK_LINE).
  const researched = row.r_researched_at !== null && row.r_researched_at !== undefined;
  const research = researched
    ? Object.fromEntries([["place_id", l.place_id], ...RESEARCH_COLUMNS.map((c) => [c, row[`r_${c}`]])])
    : null;
  return {
    place_id: l.place_id,
    name: l.name,
    trade: l.trade,
    town: found(town),
    address: found(l.address),
    phone: found(l.phone),
    website: found(l.website),
    google_maps: found(l.maps_url),
    rating: num(l.rating),
    reviews: num(l.review_count),
    company_number: found(l.company_number),
    scraper: {
      email: found(l.email),
      email_source: found(audit.email_source),
      emails: Array.isArray(l.emails) ? l.emails.filter((e) => typeof e === "string" && e.trim()) : [],
      owner: {
        first: found(l.director_first_name),
        full: found(l.director_name),
        source: found(audit.owner_source),
        confident: !!audit.owner_confident,
      },
      socials: isObj(l.socials) ? l.socials : {},
    },
    findings: Array.isArray(l.findings) ? l.findings.filter((f) => typeof f === "string") : [],
    score: { total: l.quality_score, ...parts },
    map_rank,
    top_reviews: topReviews(audit.reviews),
    previous: researched ? parseResearch(research) : null,
    nik_note: latestNikNote(row.r_notes),
  };
}

/**
 * Hand the research Routine up to `limit` (1–8, default 8) queued leads and claim each for CLAIM_HOURS.
 * First, queued rows whose lead was excluded by the scraper, deleted, or is on the do-not-contact list (find.js
 * leadSuppressed against the suppression table) become `skipped`, with the reason as a note line. Only rows with status
 * 'queued' are ever touched. Then the order: re-checks, a real (not guessed) scraper email, quality_score descending,
 * queued_at ascending; leads claimed in the last 3 hours are left out. `origin` (the Control Room's own address) makes
 * each map_rank.source_url.
 * → {leads: the Part A items, remaining: queued rows not handed out in this call}.
 * 1 D1 statement for an empty queue, at most 6 otherwise (look, suppression, one batch of skip + pick + claims + count),
 * however many leads: the skip list is bound as one JSON value. The claims go in with the pick, in one transaction, so
 * two calls at once never hand out the same lead.
 */
export async function claimQueue(DB, { limit = QUEUE_LIMIT, now = new Date(), origin = "" } = {}) {
  const when = new Date(now);
  const { results: queued } = await DB.prepare(LOOK_SQL).all();
  if (!queued.length) return { leads: [], remaining: 0 };

  const live = queued.some((r) => !leadGone(r) && !Number(r.excluded));
  const suppression = live ? (await DB.prepare(SUPPRESSION_SQL).all()).results : [];
  const skips = {};
  for (const row of queued) {
    const line = typeof row.place_id === "string" ? skipLine(row, suppression) : null;
    if (line) skips[row.place_id] = line;
  }

  const cutoff = iso(when.getTime() - CLAIM_HOURS * HOUR_MS);
  const n = queueLimit(limit);
  const skip = Object.keys(skips).length ? [DB.prepare(SKIP_SQL).bind(JSON.stringify(skips))] : [];
  // Skip first (so the pick and the count see it), then the pick and its claims, then the count.
  const results = await DB.batch([
    ...skip,
    DB.prepare(PICK_SQL).bind(cutoff, n),
    DB.prepare(CLAIM_SQL).bind(cutoff, n, iso(when)),
    DB.prepare(COUNT_SQL),
  ]);
  const [picked, , count] = results.slice(skip.length);

  const leads = picked.results.map((row) => queueLead(row, String(origin ?? "")));
  const waiting = Number(count.results[0]?.n) || 0;
  return { leads, remaining: Math.max(0, waiting - leads.length) };
}

// ---------------------------------------------------------------- the post (Task 5, tests/research-post.test.mjs)

/** Times saveResearch reads and writes again when the row's notes or status changed in between (then it throws). */
export const SAVE_TRIES = 3;
const SAVE_READ_SQL = "SELECT status, notes FROM research WHERE place_id = ?";
// The columns a post writes, bound in this order as ?2… (?1 = place_id). queued_at is kept (NULL for a lead that was
// never queued).
const SAVE_COLUMNS = ["grade", "points", "grade_reason", "angle", "opener", "owner", "best_email", "best_email_why",
  "emails", "copy", "site_review", "too_big", "notes", "searched", "researched_at"];
const NOTES_READ = `?${SAVE_COLUMNS.length + 2}`;
// Latest post wins, with two guards on an existing row:
// - status: a row that is 'skipped' (Nik's "Not a fit", the scraper excluding the lead, the do-not-contact list, the
//   12-month purge's blanked row) is never written: a post never puts back a lead that was taken off the list, never
//   drops the "Skipped: …" line the card shows as the reason, and never refills a row the purge emptied.
// - notes: the update only goes ahead if the notes are still the ones read (NOTES_READ), so a note Nik writes in
//   between ("Research is wrong", "Not a fit") is never overwritten; otherwise nothing changes and saveResearch reads
//   again. A row made in between by stage 1's queue insert fails the same check (NULL never matches its notes).
const SAVE_SQL = `INSERT INTO research (place_id, status, ${SAVE_COLUMNS.join(", ")})
  VALUES (?1, 'done', ${SAVE_COLUMNS.map((_, i) => `?${i + 2}`).join(", ")})
  ON CONFLICT(place_id) DO UPDATE SET
    status = 'done',
    ${SAVE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ")}
  WHERE research.notes IS ${NOTES_READ} AND research.status != 'skipped'`;
const UNCLAIM_SQL = "DELETE FROM settings WHERE key = ?";
const SAVE_BUSY = "Couldn't save the research: the lead's notes kept changing while saving (Nik or another run was " +
  "editing it). Post it again.";

const jsonOrNull = (v) => (v === null || v === undefined ? null : JSON.stringify(v));

/**
 * Store Claude's checked research for one lead (POST /api/agent/research/:place_id). `clean` and `warnings` come from
 * research.js validateResearch, `graded` = grade.js gradeFrom(clean.points, clean.too_big) → {grade, total, capped}.
 * Upserts the row: status 'done', every data column from `clean`, points stored as
 * {need, means, reach, fit, total, capped, reasons}, too_big 0/1, researched_at = iso(now), notes = Nik's lines kept on
 * top + Claude's notes + the warnings (research.js mergeNotes). A row that is 'skipped' by then is left exactly as it
 * is (the research isn't saved). Deletes the lead's claim either way. Never writes `leads`.
 * One read and one batch (upsert + claim delete) = 3 D1 statements (2 for a skipped row); read again (SAVE_TRIES at
 * most) only when the notes or the status changed in between.
 */
export async function saveResearch(DB, placeId, clean, graded, warnings = [], now = new Date()) {
  const { grade, total, capped } = graded;
  const fixed = {
    grade,
    points: JSON.stringify({ ...clean.points, total, capped, reasons: clean.reasons }),
    grade_reason: clean.grade_reason,
    angle: JSON.stringify(clean.angle ?? []),
    opener: clean.opener ?? "",
    owner: jsonOrNull(clean.owner),
    best_email: clean.best_email ?? null,
    best_email_why: clean.best_email_why ?? null,
    emails: JSON.stringify(clean.emails ?? []),
    copy: jsonOrNull(clean.copy),
    site_review: jsonOrNull(clean.site_review),
    too_big: clean.too_big ? 1 : 0,
    searched: JSON.stringify(clean.searched ?? []),
    researched_at: iso(now),
  };
  for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
    const old = await DB.prepare(SAVE_READ_SQL).bind(placeId).first();
    if (old?.status === "skipped") {
      await DB.prepare(UNCLAIM_SQL).bind(claimKey(placeId)).run();
      return;
    }
    const oldNotes = old ? old.notes : null;
    const values = { ...fixed, notes: mergeNotes(oldNotes, clean.notes, warnings) };
    const [saved] = await DB.batch([
      DB.prepare(SAVE_SQL).bind(placeId, ...SAVE_COLUMNS.map((c) => values[c]), oldNotes),
      DB.prepare(UNCLAIM_SQL).bind(claimKey(placeId)),
    ]);
    if (saved?.meta?.changes) return;
  }
  throw new Error(SAVE_BUSY);
}

// ---------------------------------------------------------------- Nik's routes (Task 6, tests/research-owner.test.mjs)
// GET /api/research/:place_id reads one lead's research for the drawer's card. POST /api/research/:place_id/wrong is
// "Research is wrong": Nik's note goes on top of the notes, the lead goes back in the queue (the queue hands re-checks
// out first, with his newest note as nik_note), and the research Routine is woken, at most once every 30 minutes.

/** Minutes after a research fire in which "Research is wrong" doesn't fire the Routine again. */
export const RECHECK_FIRE_MINUTES = 30;
const NOTE_MIN = 5;
const NOTE_MAX = 500;
/**
 * What the "Research is wrong" route refuses with (Part A): a 400 for the note, a 404 when the lead has no row or no
 * longer exists, a 409 when Claude may not research it now (the queue would only skip it again). Nothing changes on a
 * refusal. excluded(reason) takes the lead's exclude_reason.
 */
export const RECHECK_ERRORS = {
  note: "Say what's wrong in a few words (5 to 500 characters).",
  none: "This lead hasn't been researched yet, so there's nothing to re-check.",
  missing: "This lead no longer exists, so there's nothing to re-check.",
  excluded: (reason) => {
    const why = excludeWhy(reason);
    return `The scraper excluded this lead${why ? ` (${why})` : ""}, so Claude won't research it. Nothing was changed.`;
  },
  suppressed: "This business is on the do-not-contact list (opted out, bounced or blocked), so Claude won't research it. " +
    "Nothing was changed.",
};
const RECHECK_FIRE_TEXT = "research queued: 1 lead (Nik asked)";
const RECHECK_FIRED = "Queued. Claude has been asked to research it now. Check back in 15 minutes.";
const RECHECK_RECENT = "Queued. Claude will pick it up on its current or next run.";
const MORNING_RUN = 6 * 60 + 47; // the Routine's own schedule: every day at 06:47 UK
const MINUTE_MS = 60_000;
const FIRE_ERROR_CHARS = 300;

const GET_SQL = "SELECT * FROM research WHERE place_id = ?";
// The same press again (a retry after a lost answer, a double-click): the row is still queued and its top line is
// already this one (?2). Then nothing changes, so stage 11's count of [Nik …] lines counts one press.
const SAME_PRESS = `(status = 'queued' AND (notes = ?2 OR substr(notes, 1, length(?2) + 1) = ?2 || char(10)))`;
// ?1 = place_id, ?2 = Nik's line, ?3 = now. Nik's line goes on top; everything below it stays as it was (his older
// lines, Claude's notes, a "Skipped: …" reason), and so do the old grade and findings until Claude posts again. The
// row is still a re-check (researched_at is kept), so the queue hands it out first. (SET reads the old row.)
const REQUEUE_SQL = `UPDATE research SET status = 'queued',
    queued_at = CASE WHEN ${SAME_PRESS} THEN queued_at ELSE ?3 END,
    notes = CASE WHEN ${SAME_PRESS} THEN notes
      ELSE ?2 || CASE WHEN TRIM(COALESCE(notes, ''), ${BLANK}) = '' THEN '' ELSE char(10) || TRIM(notes, ${BLANK}) END END
  WHERE place_id = ?1`;
// Takes the right to fire (meta.changes 1), or not (0) when a research fire was logged in the last
// RECHECK_FIRE_MINUTES (?2 = the cutoff), accepted or not: Claude is running or about to run, or was just tried.
// Setup's Test fire doesn't count: that run only posts its heartbeat (the preamble's "Test from the Control Room"), it
// never researches. fireRoutine logs its row only once Claude answers (up to 15 s), so the right is also written here,
// as RECHECK_FIRE_KEY = the time (?3), in the same transaction as the check: a second press in those seconds (a
// double-click, another drawer) finds it and doesn't start a second session. Only for a lead that has a row (?1).
const RECHECK_FIRE_KEY = "research:recheck_fire_at";
const FIRE_RIGHT_SQL = `INSERT INTO settings (key, value)
  SELECT '${RECHECK_FIRE_KEY}', ?3
  WHERE EXISTS (SELECT 1 FROM research WHERE place_id = ?1)
    AND NOT EXISTS (SELECT 1 FROM routine_fires
      WHERE routine = 'research' AND at > ?2 AND reason NOT LIKE 'Test from the Control Room%')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value <= ?2`;

/**
 * Nik's note as it's stored: one line (line breaks, control characters and runs of spaces become one space, so
 * mergeNotes keeps the whole of it as his), trimmed, 5 to 500 characters; null when it isn't text of that length.
 */
export function recheckNote(note) {
  if (typeof note !== "string") return null;
  const line = note.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  const n = [...line].length;
  return n >= NOTE_MIN && n <= NOTE_MAX ? line : null;
}

/** One lead's research for the drawer → {research: research.js parseResearch(row) | null (no row), waiting: queued rows}. 2 D1 statements. */
export async function getResearch(DB, placeId) {
  const [row, count] = await DB.batch([
    DB.prepare(GET_SQL).bind(typeof placeId === "string" ? placeId : ""),
    DB.prepare(COUNT_SQL),
  ]);
  return { research: parseResearch(row.results[0] ?? null), waiting: Number(count.results[0]?.n) || 0 };
}

// The toast when Claude couldn't be started: fireRoutine's own error (its sentences end in a full stop, which the
// brackets don't need), else the HTTP status, cut to one short line. The next scheduled run is today's when it's
// still before 06:47 UK.
function fireFailed(result, when) {
  const raw = typeof result?.error === "string" && result.error.trim() ? result.error
    : Number.isInteger(result?.status) ? `HTTP ${result.status}` : "no answer from Claude";
  const error = clip(raw.replace(/\s+/g, " ").replace(/sk-ant-[A-Za-z0-9_-]+/g, "[hidden]").trim()
    .replace(/[.\s]+$/, ""), FIRE_ERROR_CHARS);
  const { hh, mm } = ukParts(when);
  const day = hh * 60 + mm < MORNING_RUN ? "today" : "tomorrow";
  return `Queued, but Claude couldn't be started (${error}). It will be researched at 06:47 ${day}.`;
}

/**
 * "Research is wrong": put the lead back in the queue with Nik's note, then wake the research Routine unless a research
 * fire was logged in the last RECHECK_FIRE_MINUTES. One DB.batch: the row gets `[Nik <UK date>] <note>` as its first
 * notes line, status 'queued' and queued_at = iso(now) (its old grade and data stay; the same press again while it's
 * still queued changes nothing), its claim is deleted, and routine_fires is checked, taking the right to fire in the
 * same transaction (FIRE_RIGHT_SQL), so two presses at once fire once. Then fire(DB, "research",
 * "research queued: 1 lead (Nik asked)"), which logs the attempt itself. → {fired, message} (message = the toast,
 * exactly as Part A), or null when the lead has no research row (nothing changed, nothing fired). A fire that fails or
 * throws still leaves the lead queued for the next run.
 * First the lead is checked as the queue checks it (unresearchable): one Claude may not research now (deleted by a
 * re-scrape, excluded by the scraper, or on the do-not-contact list) → {refused: "missing" | "excluded" | "suppressed",
 * error: RECHECK_ERRORS' text}, and nothing is written or fired (the queue would skip it again at once, so the toast
 * would be untrue and a Routine session would start for nothing). Only the lead's state now counts, never the row's
 * status or an old "Skipped: …" line: a lead the scraper keeps again is re-queued like any other.
 * `note` must pass recheckNote (else a TypeError: the route checks it first). 5 D1 statements (the lead's state, the
 * suppression rows, one batch of 3), plus the fire's; 1 for no row, a deleted or excluded lead, 2 for a suppressed one.
 */
export async function requeueResearch(DB, placeId, note, now = new Date(), { fire = fireRoutine } = {}) {
  const line = recheckNote(note);
  if (line === null) throw new TypeError(RECHECK_ERRORS.note);
  if (typeof placeId !== "string" || !placeId) return null;
  const state = await DB.prepare(STATE_SQL).bind(placeId).first();
  if (!state) return null;
  const live = !leadGone(state) && !Number(state.excluded);
  const why = unresearchable(state, live ? (await DB.prepare(SUPPRESSION_SQL).all()).results : []);
  if (why) return { refused: why, error: why === "excluded" ? RECHECK_ERRORS.excluded(state.exclude_reason) : RECHECK_ERRORS[why] };

  const when = new Date(now);
  const [requeued, , right] = await DB.batch([
    DB.prepare(REQUEUE_SQL).bind(placeId, `[Nik ${ukDate(when)}] ${line}`, iso(when)),
    DB.prepare(UNCLAIM_SQL).bind(claimKey(placeId)),
    DB.prepare(FIRE_RIGHT_SQL).bind(placeId, iso(when.getTime() - RECHECK_FIRE_MINUTES * MINUTE_MS), iso(when)),
  ]);
  if (!requeued?.meta?.changes) return null;
  if (!right?.meta?.changes) return { fired: false, message: RECHECK_RECENT };

  let result;
  try {
    result = await fire(DB, "research", RECHECK_FIRE_TEXT);
  } catch (err) {
    result = { ok: false, error: String(err?.message ?? err) };
  }
  return result?.ok ? { fired: true, message: RECHECK_FIRED } : { fired: false, message: fireFailed(result, when) };
}

// ---------------------------------------------------------------- the health light (Task 7, tests/research-health.test.mjs)
// research.js researchLight works the light out from these facts (red: leads waiting and no post for 26 h; amber: the
// email hit rate). It's registered with stage 0's registerLight below, so healthFromDb (Setup's lights, /api/health and
// the health step's health:research todo) shows it after stage 0's 10.

const RECENT_ROWS = 20;
// One statement, as stage 0 allows a registered light 1 D1 query (countingDB counts each statement of a batch): the
// rows waiting, the newest post on any row (a re-queued or skipped row keeps the time Claude posted it), the oldest
// queued_at of the rows waiting, and the last 20 done rows as one JSON list. json_group_array doesn't promise an
// order, so each row carries its researched_at and place_id and the list is sorted below.
const FACTS_SQL = `SELECT
    (SELECT COUNT(*) FROM research WHERE status = 'queued') AS queued,
    (SELECT MAX(researched_at) FROM research) AS last_post_at,
    (SELECT MIN(queued_at) FROM research WHERE status = 'queued') AS oldest_queued_at,
    (SELECT json_group_array(json_object('best_email', best_email, 'too_big', too_big, 'at', researched_at, 'id', place_id))
      FROM (SELECT best_email, too_big, researched_at, place_id FROM research WHERE status = 'done'
        ORDER BY researched_at DESC, place_id LIMIT ${RECENT_ROWS})) AS recent`;

const textOrNull = (v) => (typeof v === "string" && v ? v : null);
// Text order with null first (as SQLite sorts NULL), for newest-first by researched_at, then place_id.
const order = (x, y) => (x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1);
const newestFirst = (a, b) => order(textOrNull(b.at), textOrNull(a.at)) || order(textOrNull(a.id), textOrNull(b.id));

/**
 * The research light's facts → {queued: rows waiting, lastPostAt: the newest researched_at (iso text) or null,
 * oldestQueuedAt: the oldest queued_at of the rows waiting or null, recent: the last 20 done rows by researched_at,
 * newest first, as [{best_email, too_big}] (too_big 0/1 as stored, so emailHitRate can leave them out)}.
 * 1 D1 statement.
 */
export async function researchFacts(DB) {
  const row = (await DB.prepare(FACTS_SQL).first()) ?? {};
  const rows = parseJson(row.recent, []);
  const recent = (Array.isArray(rows) ? rows : [])
    .filter(isObj)
    .sort(newestFirst)
    .slice(0, RECENT_ROWS)
    .map((r) => ({ best_email: r.best_email ?? null, too_big: r.too_big }));
  return {
    queued: Number(row.queued) || 0,
    lastPostAt: textOrNull(row.last_post_at),
    oldestQueuedAt: textOrNull(row.oldest_queued_at),
    recent,
  };
}

// Registered once, when this module loads (tick.js imports it, and api/health.js imports tick.js): 1 D1 statement.
registerLight(async (DB, env, now) => researchLight(await researchFacts(DB), now));
