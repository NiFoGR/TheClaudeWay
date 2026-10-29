// Weekly KPIs (D1): the rows computeWeek reads, the KPIs page's payload, the weekly snapshot and Claude's review
// (stage 11 Task 6, docs/rebuild/11-todo-kpis.md). The numbers are always computed in code (_lib/kpis.js); Claude only
// writes the review. A review becomes one `kpi` todo per week (dedupe kpi:<week>, due Monday 08:00 UK).
// Used by GET /api/kpis, GET /api/agent/kpis and POST /api/agent/kpis/:week. Tested in tests/kpis-api.test.mjs.
import {
  ANALYSIS_MAX, MAX_SUGGESTIONS, SAMPLE_BODY_MAX, computeWeek, countSuggestions, isoWeekOf, lastWeeks, suggestionLines, trendRow,
  weekLabel, weekStartOf,
} from "./kpis.js";
import { addTodo } from "./todo.js";
import { addUkDays, ukDate, ukToUtc } from "./ukTime.js";
import { iso } from "./util.js";

export { kpiSamples } from "./kpis.js";

export const BAD_WEEK = "Week should look like 2026-W43.";
export const FUTURE_WEEK = "That week hasn't started yet.";
const EMPTY = "The analysis is empty.";
const NOT_TEXT = "analysis must be text: the review in markdown.";
const DETAIL_MAX = 300;
const TREND_WEEKS = 4;
const PREVIOUS_MAX = 4;

const WEEK_RE = /^\d{4}-W\d{2}$/;
// Test and drill leads (stage 7) never count, in any table.
const REAL = (col) => `${col} NOT LIKE 'drill:%' AND ${col} NOT LIKE 'test:%'`;
// The samples quote only Nik's first emails, Claude's replies and the human mail before them, each cut to
// SAMPLE_BODY_MAX after anonymising: so only those bodies are read, and only their start (twice the cut, room for
// addresses that shrink to "[email]"; kpis.js' uncut drops a phone number the cut may have split). A year of follow-up
// bodies would otherwise be parsed on every Sunday run, on the free plan's 10 ms of CPU. ?3 and ?4 bound them to the
// reviewed week (see bodiesFrom).
const SAMPLE_BODY_SQL = `CASE WHEN ((kind = 'first' AND author = 'nik') OR (kind = 'reply' AND author = 'claude')
      OR (direction = 'in' AND class = 'human'))
    AND (CASE WHEN direction = 'in' THEN received_at >= ?4 ELSE sent_at >= ?3 END)
    THEN substr(body, 1, ${2 * SAMPLE_BODY_MAX}) ELSE '' END AS body`;
// Grade calibration is the only number counted over all time ("up to now"), so SQL does it instead of loading every
// message: one row per graded lead with a sent first email, with when that first went (UTC ms, read by julianday so
// "2026-10-19 08:00:00" and ISO times compare alike) and whether the lead ever opened the demo, sent a human reply or
// ordered. computeWeek keeps the leads first emailed before each week's end. Uses messages_place and demo_events_place.
const CALIBRATION_SQL = `SELECT r.grade, f.first_ms,
    EXISTS(SELECT 1 FROM demo_events v WHERE v.place_id = f.place_id AND v.kind = 'view') AS viewed,
    EXISTS(SELECT 1 FROM messages i WHERE i.place_id = f.place_id AND i.direction = 'in' AND i.class = 'human'
      AND i.received_at IS NOT NULL) AS replied,
    EXISTS(SELECT 1 FROM clients c WHERE c.place_id = f.place_id) AS won
  FROM (SELECT place_id, CAST(ROUND((MIN(julianday(sent_at)) - 2440587.5) * 86400000) AS INTEGER) AS first_ms
        FROM messages
        WHERE kind = 'first' AND direction = 'out' AND status = 'sent' AND place_id IS NOT NULL AND ${REAL("place_id")}
        GROUP BY place_id) f
  JOIN research r ON r.place_id = f.place_id
  WHERE f.first_ms IS NOT NULL AND r.grade IN ('A+', 'A', 'B', 'C', 'D')`;
// Every stored time starts "YYYY-MM-DD", ISO or not, so comparing with a bare date the UK day before is safe whatever
// the format (and a UK day never starts before the UTC day before it).
const ALL_TIME = "0000-00-00";
const fmtCount = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const asDate = (now) => (now instanceof Date ? now : new Date(now ?? Date.now()));

/** The current UK week, "YYYY-Www". */
export const currentWeek = (now) => isoWeekOf(ukDate(asDate(now)));

/** {week, start} for a week that exists and has started by `now`, else {error} in plain words (a 400). */
export function checkWeek(week, now) {
  const w = typeof week === "string" ? week.trim() : "";
  let start;
  try {
    start = WEEK_RE.test(w) ? weekStartOf(w) : null;
  } catch {
    start = null;
  }
  if (!start) return { error: BAD_WEEK };
  if (start > ukDate(asDate(now))) return { error: FUTURE_WEEK };
  return { week: w, start };
}

/** The UK Monday "YYYY-MM-DD" the KPIs for `week` read from: the start of the oldest of its TREND_WEEKS trend weeks. */
export const kpiFrom = (week) => weekStartOf(lastWeeks(week, TREND_WEEKS)[0]);

/**
 * Everything computeWeek reads, from D1 in one batch: lead-linked messages (sent outbound and every inbound), demo
 * views, calls, clients with a place_id as orders, research rows, the escalation todos Claude made (not stage 0's
 * escalation:unknown: or escalation:client: ones) and `calibration` (CALIBRATION_SQL). Test and drill leads are
 * skipped in every table.
 *
 * `from` (a UK Monday "YYYY-MM-DD", kpiFrom(week)) reads only what the weeks from then on need, so the cost follows the
 * weeks shown, not the whole history (the free plan's 10 ms of CPU): sent mail, views, calls, orders and escalations
 * from the UK day before it; inbound from 8 days before (reply speed looks back to the human mail before a Claude
 * reply); research rows researched from then, or with a "[Nik …]" line. An inbound or view whose latest earlier email
 * went before `from` was credited to an email outside those weeks anyway. Without `from`, everything (tests).
 * `bodies: false` leaves message subjects and bodies out (the page doesn't need them; the Routine's samples do). With
 * bodies, only the ones the samples quote are read, and only their first 2 × SAMPLE_BODY_MAX characters; `bodiesFrom`
 * (the reviewed week's UK Monday) limits them to that week's sent mail and the inbound from 8 days before it.
 */
export async function loadKpiRows(DB, { bodies = true, from = null, bodiesFrom = null } = {}) {
  const since = from ? addUkDays(from, -1) : ALL_TIME;
  const inSince = from ? addUkDays(from, -8) : ALL_TIME;
  const text = bodies ? `subject, ${SAMPLE_BODY_SQL}` : "NULL AS subject, '' AS body";
  const bodyOut = bodiesFrom ? addUkDays(bodiesFrom, -1) : ALL_TIME;
  const bodyIn = bodiesFrom ? addUkDays(bodiesFrom, -8) : ALL_TIME;
  const [messages, views, calls, orders, research, escalations, calibration] = await DB.batch([
    DB.prepare(`SELECT id, place_id, direction, kind, step, author, status, class, intent, sent_at, received_at, ${text}
      FROM messages
      WHERE place_id IS NOT NULL AND ${REAL("place_id")}
        AND ((direction = 'out' AND status = 'sent' AND sent_at >= ?1) OR (direction = 'in' AND received_at >= ?2))`)
      .bind(...(bodies ? [since, inSince, bodyOut, bodyIn] : [since, inSince])),
    DB.prepare(`SELECT place_id, at FROM demo_events WHERE kind = 'view' AND at >= ? AND ${REAL("place_id")}`).bind(since),
    DB.prepare(`SELECT place_id, status, created_at FROM calls WHERE created_at >= ? AND ${REAL("place_id")}`).bind(since),
    DB.prepare(`SELECT place_id, paid_on, build_fee_pence FROM clients
      WHERE place_id IS NOT NULL AND paid_on >= ? AND ${REAL("place_id")}`).bind(since),
    DB.prepare(`SELECT place_id, status, best_email, too_big, researched_at, notes FROM research
      WHERE (researched_at >= ? OR notes LIKE '%[Nik %') AND ${REAL("place_id")}`).bind(since),
    DB.prepare(`SELECT place_id, dedupe, created_at FROM todos
      WHERE kind = 'escalation' AND substr(dedupe, 1, 11) = 'escalation:'
        AND substr(dedupe, 1, 19) <> 'escalation:unknown:' AND substr(dedupe, 1, 18) <> 'escalation:client:'
        AND created_at >= ? AND (place_id IS NULL OR (${REAL("place_id")}))`).bind(since),
    DB.prepare(CALIBRATION_SQL),
  ]);
  return {
    messages: messages.results ?? [],
    views: views.results ?? [],
    calls: calls.results ?? [],
    orders: orders.results ?? [],
    research: research.results ?? [],
    escalations: escalations.results ?? [],
    calibration: calibration.results ?? [],
  };
}

/**
 * The KPIs page's payload for `week` (checked by the caller with checkWeek): {week, label, start, prev, next,
 * still_counting, numbers, trend, analysis: {text, created_at}|null}. next is null on the current UK week; trend is
 * the last 4 weeks, oldest first. `rows` (loadKpiRows' from kpiFrom(week) or earlier) may be passed to save loading
 * them twice.
 */
export async function kpiPayload(DB, week, now, rows = null) {
  const at = asDate(now);
  const start = weekStartOf(week);
  const data = rows ?? (await loadKpiRows(DB, { bodies: false, from: kpiFrom(week) }));
  const weeks = lastWeeks(week, TREND_WEEKS).map((w) => computeWeek(data, weekStartOf(w)));
  const numbers = weeks.at(-1);
  const report = await DB.prepare("SELECT analysis, created_at FROM kpi_reports WHERE week = ?").bind(week).first();
  return {
    week,
    label: weekLabel(week),
    start,
    prev: isoWeekOf(addUkDays(start, -7)),
    next: week >= currentWeek(at) ? null : isoWeekOf(addUkDays(start, 7)),
    // Emails from the last 7 days of the week can still collect views and replies until the Monday 8 days after it.
    still_counting: at.getTime() < ukToUtc(addUkDays(start, 14), "00:00").getTime(),
    numbers,
    trend: weeks.map(trendRow),
    analysis: report && String(report.analysis ?? "").trim() ? { text: report.analysis, created_at: report.created_at } : null,
  };
}

/** Save (or refresh) the week's numbers snapshot; a saved review is kept. */
export async function saveSnapshot(DB, week, numbers, now) {
  await DB.prepare(`INSERT INTO kpi_reports (week, numbers, analysis, created_at) VALUES (?, ?, '', ?)
    ON CONFLICT(week) DO UPDATE SET numbers = excluded.numbers`)
    .bind(week, JSON.stringify(numbers), iso(asDate(now)))
    .run();
}

/** What's wrong with Claude's review, in plain words, or null when it can be saved. */
export function analysisProblem(analysis) {
  if (typeof analysis !== "string") return analysis == null ? EMPTY : NOT_TEXT;
  const text = analysis.trim();
  if (!text) return EMPTY;
  if (text.length > ANALYSIS_MAX) {
    return `The analysis is too long: ${fmtCount(text.length)} characters (${fmtCount(ANALYSIS_MAX)} max).`;
  }
  const n = countSuggestions(text);
  if (n > MAX_SUGGESTIONS) return `At most ${MAX_SUGGESTIONS} suggestions, found ${n}.`;
  return null;
}

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** The kpi todo's title: "Claude's email review for 19–25 Oct: 2 suggestions" (or "…: nothing to change"). */
export function reviewTitle(week, suggestions) {
  const what = suggestions === 0 ? "nothing to change" : `${suggestions} ${suggestions === 1 ? "suggestion" : "suggestions"}`;
  return `Claude's email review for ${weekLabel(week)}: ${what}`;
}

/**
 * Save Claude's review of `week` (checked with analysisProblem first; throws on one that isn't) → {suggestions}.
 * The week's snapshot is computed first when it has none. "Written" on the page is this time. The review becomes
 * one `kpi` todo (dedupe kpi:<week>, link /#/kpis?week=<week>, due Monday 08:00 UK after the week); a later review of
 * the same week updates that todo while it's open, and leaves it alone once Nik has ticked or dismissed it.
 */
export async function saveAnalysis(DB, week, analysis, now) {
  const problem = analysisProblem(analysis);
  if (problem) throw new Error(problem);
  const text = analysis.trim();
  const at = iso(asDate(now));
  const start = weekStartOf(week);
  const saved = await DB.prepare("SELECT 1 AS ok FROM kpi_reports WHERE week = ?").bind(week).first();
  if (!saved) await saveSnapshot(DB, week, computeWeek(await loadKpiRows(DB, { bodies: false, from: kpiFrom(week) }), start), now);
  await DB.prepare("UPDATE kpi_reports SET analysis = ?, created_at = ? WHERE week = ?").bind(text, at, week).run();

  const suggestions = countSuggestions(text);
  const title = reviewTitle(week, suggestions);
  const detail = clip(suggestionLines(text).filter(Boolean).join(" · "), DETAIL_MAX);
  const dedupe = `kpi:${week}`;
  const added = await addTodo(DB, {
    kind: "kpi", title, detail, link: `/#/kpis?week=${week}`,
    due_at: iso(ukToUtc(addUkDays(start, 7), "08:00")), dedupe,
  });
  if (!added) {
    await DB.prepare("UPDATE todos SET title = ?, detail = ? WHERE dedupe = ? AND status = 'open'").bind(title, detail, dedupe).run();
  }
  return { suggestions };
}

/** Nik's default week: the latest with a saved review (not after now's week), else the current UK week. */
export async function defaultWeek(DB, now) {
  const current = currentWeek(now);
  const latest = await DB.prepare("SELECT week FROM kpi_reports WHERE analysis <> '' AND week <= ? ORDER BY week DESC LIMIT 1")
    .bind(current).first("week");
  return latest || current;
}

/** The Routine's extras: approved follow-up wording, and up to 4 reviews of earlier weeks (newest first). */
export async function agentExtras(DB, week) {
  const [templates, previous] = await DB.batch([
    DB.prepare("SELECT step, day_offset, body FROM followup_templates WHERE status = 'approved' ORDER BY step"),
    DB.prepare(`SELECT week, analysis FROM kpi_reports WHERE week < ? AND analysis <> '' ORDER BY week DESC LIMIT ${PREVIOUS_MAX}`).bind(week),
  ]);
  return { followup_templates: templates.results ?? [], previous: previous.results ?? [] };
}
