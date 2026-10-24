// Shortlist in D1 (stage 3, docs/rebuild/04-shortlist.md): the Leads page's list with its filters and sort, the
// "Ready to email" rule (READY_SQL), today's room for first emails (capacityNow) and the ready counts behind Ready's
// grades, the banner and the morning pick todo. The rules themselves are pure, in shortlist.js.
//
// D1 budget (Part B: GET /api/leads makes at most 12 statements): capacityNow 4 (cold mailboxes with the queued first
// emails, sentToday, followupsDueToday's 2), readyCounts 1, then one batch of the page's rows and, on page 1 only,
// the grade counts and the facets (with the All leads count): 8 on page 1, 6 on a later page (7 past the last one,
// whose total is counted on its own), so stage 6's roomForFirsts fits inside the 12. Never l.* or audit: no raw HTML
// or audit blob leaves the API.
//
// Stage 6 (Task 6) caps `room` inside capacityNow with roomForFirsts, so the banner and the composer always agree.
//
// The lead panel (leadDetail, GET /api/leads/:id) makes at most 4: the lead row, then one batch of its live demo,
// messages and calls. Its "Not a fit" (markNotFit, POST /api/leads/:id/not-a-fit) makes 4.
//
// The tick's `pick` step (pickStep) makes at most 9: capacityNow 4, readyCounts 1, then up to 4 for its todo. Outside
// stage 0's send window for cold email (all Sunday, and from 19:00 UK) it reads nothing and makes at most 3.
import { followupsDueToday } from "./followups.js";
import { mailboxCap } from "./mail/capacity.js";
import { COLD_WINDOW, sentToday } from "./mail/outbox.js";
import { GUARANTEE, offerFor } from "./offer.js";
import { parseResearch } from "./research.js";
import { getSetting, setSetting } from "./settings.js";
import {
  GRADES, PAGE_SIZE, STAGE_LABELS, capacityBanner, firstEmailRoom, isHot, likePattern, parseLeadFilters, pickTitle,
  readyGrades, warmupFrom,
} from "./shortlist.js";
import { addTodo, closeTodos } from "./todo.js";
import { addUkDays, inUkWindow, nextUkWindowStart, ukDate, ukParts, ukToUtc } from "./ukTime.js";
import { MAPS_FINDING, iso, mapsFromAnotherTown, parseJson } from "./util.js";

/**
 * The ready rule (aliases l = leads, r = research, p = prospects), binding now (iso text) as ?1. Without the grade
 * clause: Ready adds `AND r.grade IN (<readyGrades(room, top)>)`. Stage 6 reuses it.
 */
export const READY_SQL = `l.excluded = 0 AND r.status = 'done' AND r.too_big = 0
AND p.stage = 'ready' AND COALESCE(p.email, '') <> ''
AND EXISTS (SELECT 1 FROM demos d WHERE d.place_id = l.place_id AND d.expires_at > ?1)
AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.value IN
    (lower(p.email), lower(substr(p.email, instr(p.email, '@') + 1)), COALESCE(l.company_number, '')))`;

// Every view's sort: grade A+ → D → not graded, then score, then rating, then place_id (stable paging).
const ORDER_SQL = `ORDER BY CASE r.grade WHEN 'A+' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 5 END,
         l.quality_score DESC, l.rating DESC, l.place_id`;

const FROM_SQL = `FROM leads l
  LEFT JOIN research r ON r.place_id = l.place_id
  LEFT JOIN prospects p ON p.place_id = l.place_id`;

// The address we'd write to: the prospect's, else Claude's best email, else the scraper's (Part A, "Has email").
const EMAIL_SQL = "COALESCE(NULLIF(p.email, ''), NULLIF(r.best_email, ''), NULLIF(l.email, ''))";
// On the do-not-contact list: that address (lower-cased), its domain or the company number (READY_SQL's test, on the
// address above, so a lead without a prospect is tagged too). suppression.value is stored lower-case.
const SUPPRESSED_SQL = `EXISTS (SELECT 1 FROM suppression s WHERE s.value IN
    (lower(${EMAIL_SQL}), lower(substr(${EMAIL_SQL}, instr(${EMAIL_SQL}, '@') + 1)), COALESCE(l.company_number, '')))`;
const LIVE_DEMO_SQL = "EXISTS (SELECT 1 FROM demos d WHERE d.place_id = l.place_id AND d.expires_at > ?1)";
// "Waiting for their demo site": graded A+/A, researched, an email to write to, not on the do-not-contact list, not
// emailed yet (no prospect, or still `ready`), and not in Ready (no live demo, or no ready prospect yet). ?1 = now.
const WAITING_DEMO_SQL = `l.excluded = 0 AND r.status = 'done' AND r.too_big = 0 AND r.grade IN ('A+', 'A')
  AND ${EMAIL_SQL} IS NOT NULL
  AND (p.place_id IS NULL OR p.stage = 'ready')
  AND NOT (COALESCE(p.stage, '') = 'ready' AND COALESCE(p.email, '') <> '' AND ${LIVE_DEMO_SQL})
  AND NOT ${SUPPRESSED_SQL}`;

// json_extract and json_each throw on text that isn't JSON, so one bad row can't break the page.
const ISSUES_JSON = "CASE WHEN json_valid(l.issues) THEN l.issues END";
const OWNER_JSON = "CASE WHEN json_valid(r.owner) THEN r.owner END";
const LEAD_EMAILS_JSON = "CASE WHEN json_valid(l.emails) THEN l.emails ELSE '[]' END";
const RESEARCH_EMAILS_JSON = "CASE WHEN json_valid(r.emails) THEN r.emails ELSE '[]' END";

// The row's columns (the API's row shape, plus last_inbound_at for the hot flag and the window total).
const ROW_SQL = `SELECT l.place_id, l.name, l.trade, l.town, l.phone, l.website, l.rating, l.review_count,
    l.quality_score, l.excluded, r.grade, r.grade_reason, r.status AS research_status,
    ${EMAIL_SQL} AS email,
    ${SUPPRESSED_SQL} AS suppressed,
    p.stage, p.views, p.last_view_at, p.last_inbound_at,
    (SELECT d.slug FROM demos d WHERE d.place_id = l.place_id AND d.expires_at > ?1
      ORDER BY d.created_at DESC, d.slug DESC LIMIT 1) AS demo_slug,
    json_extract(${ISSUES_JSON}, '$[0]') AS top_issue,
    CASE WHEN json_type(${OWNER_JSON}, '$.confident') = 'true' THEN json_extract(${OWNER_JSON}, '$.first') END AS owner_first,
    COUNT(*) OVER () AS total
  ${FROM_SQL}`;

// Cold mailboxes, with the first emails still queued ('sending' ones are already in sentToday) on every row; one row
// of NULL mailbox columns when there's no cold mailbox, so the count always arrives.
const MAILBOXES_SQL = `SELECT q.n AS first_queued, m.id, m.address, m.role, m.started_on, m.cap_override, m.status,
    m.paused_reason
  FROM (SELECT COUNT(*) AS n FROM messages WHERE kind = 'first' AND status = 'queued') AS q
  LEFT JOIN mailboxes m ON m.role = 'cold'
  ORDER BY m.created_at, m.id`;

// The grade chips Ready shows (Part A); C and D never appear in Ready.
const READY_CHIPS = ["A+", "A", "B"];

const asDate = (now) => (now instanceof Date ? now : new Date(now));
const num = (value) => Number(value) || 0;
const textOrNull = (value) => (typeof value === "string" && value.trim() ? value : null);

// Numbered parameters for one statement. ?1 is always now (READY_SQL's); add(value) gives the next number. A bare ?
// would be numbered after the highest so far, so this file never writes one.
function params(nowIso) {
  const values = [nowIso];
  return {
    values,
    add(value) {
      values.push(value);
      return `?${values.length}`;
    },
  };
}

// D1 wants exactly as many values as the statement has parameters (its highest ?N), so ?1 is bound only when used.
function prepare(DB, sql, values) {
  let highest = 0;
  for (const m of sql.matchAll(/\?(\d+)/g)) highest = Math.max(highest, Number(m[1]));
  const stmt = DB.prepare(sql);
  return highest ? stmt.bind(...values.slice(0, highest)) : stmt;
}

const whereSql = (conds) => (conds.length ? `WHERE ${conds.join("\n    AND ")}` : "");

/**
 * Today's room for first emails, the numbers behind it and the banner (Part A, "Today's room"):
 * {mailboxes (cold ones), paused: [{address, reason}], cap, sent, followupsDue, firstQueued, room, warmupFrom, today,
 * sendDay, nextDay, banner}. today = the UK day; sendDay = the UK day cold email next goes out (today inside stage 0's
 * COLD_WINDOW, Mon–Sat 07:00–19:00 UK, else the next window's: Monday on a Sunday or a Saturday evening); nextDay =
 * the first send day after today. The banner uses them so it never says "today" when nothing can go today.
 * `now` is a Date (or UTC ISO text). 4 D1 statements, run together.
 */
export async function capacityNow(DB, now) {
  const at = asDate(now);
  const today = ukDate(at);
  const [{ results }, sentBy, followupsDue] = await Promise.all([
    DB.prepare(MAILBOXES_SQL).all(),
    sentToday(DB, at),
    followupsDueToday(DB, at),
  ]);
  const firstQueued = num(results[0]?.first_queued);
  const cold = results.filter((m) => m.id !== null && m.id !== undefined);
  const cap = cold.reduce((sum, m) => sum + mailboxCap(m, today), 0);
  const sent = Object.values(sentBy).reduce((sum, n) => sum + num(n), 0);
  const paused = cold
    .filter((m) => m.status === "paused")
    .map((m) => ({ address: m.address, reason: m.paused_reason ?? "" }));
  const room = firstEmailRoom({ cap, sent, followupsDue, firstQueued });
  const sendDay = ukDate(nextUkWindowStart(at, COLD_WINDOW));
  const nextDay = ukDate(nextUkWindowStart(ukToUtc(addUkDays(today, 1), "00:00"), COLD_WINDOW));
  const c = {
    mailboxes: cold.length, paused, cap, sent, followupsDue, firstQueued, room, warmupFrom: warmupFrom(cold, today),
    today, sendDay, nextDay,
  };
  return { ...c, banner: capacityBanner(c) };
}

/**
 * Ready leads by grade, for today's `room`: {top (A+ and A), b, b_included, grades (readyGrades(room, top)),
 * waiting_demo (A+/A leads with an email that aren't in Ready yet, waiting for their demo site), graded_top (every
 * lead Claude graded A+ or A, whatever happened to it since: emailed, hidden, re-checked; so the Leads page says "No
 * A-grade leads yet" only when that's true)}. 1 D1 statement.
 */
export async function readyCounts(DB, now, room) {
  const sql = `SELECT 'grade' AS kind, r.grade AS grade, COUNT(*) AS n ${FROM_SQL}
  WHERE ${READY_SQL}
  GROUP BY r.grade
  UNION ALL
  SELECT 'waiting_demo', NULL, COUNT(*) ${FROM_SQL}
  WHERE ${WAITING_DEMO_SQL}
  UNION ALL
  SELECT 'graded_top', NULL, COUNT(*) FROM research r JOIN leads l ON l.place_id = r.place_id
  WHERE r.grade IN ('A+', 'A')`;
  const { results } = await prepare(DB, sql, [iso(asDate(now))]).all();
  let top = 0, b = 0, waiting = 0, gradedTop = 0;
  for (const row of results) {
    if (row.kind === "waiting_demo") waiting = num(row.n);
    else if (row.kind === "graded_top") gradedTop = num(row.n);
    else if (row.grade === "A+" || row.grade === "A") top += num(row.n);
    else if (row.grade === "B") b = num(row.n);
  }
  const grades = readyGrades(room, top);
  return { top, b, b_included: grades.includes("B"), grades, waiting_demo: waiting, graded_top: gradedTop };
}

// ---- The morning pick todo (Part A, "Morning pick todo"; Part B, Task 6) ----

const PICK_FROM_HOUR = 7; // acts from 07:00 UK
const PICK_LAST = "pick:last"; // the UK day of the last run from 07:00
// This stage's todos are pick:YYYY-MM-DD. Stage 7's todos of kind pick use checkback:<place_id>, which this never touches.
const PICK_PREFIX = "pick:";
const PICK_DETAIL = "Open Leads → Ready to email, and write each first email from the lead's panel.";
const PICK_LINK = "/#/leads?view=ready";
// The most pickStep makes after its reads: the pick:last read, then either a new day's close, save and one todo write,
// or a later run's retitle, made-today check and one todo write. In the tick one more is kept for its closing beat.
// Outside the send window it's at most 3: the pick:last read, then a new day's close and save, or today's close.
const PICK_WRITES = 4;
// Later runs that day keep the open todo's numbers true. A todo Nik dismissed, or one closed when room or ready leads
// ran out, isn't open (and a closed one's dedupe has moved on), so it's never reopened or retitled that day.
const PICK_RETITLE_SQL = "UPDATE todos SET title = ?1 WHERE dedupe = ?2 AND status = 'open'";
// Whether today's todo was ever made: still held (open, dismissed, or done by Nik) or freed by closeTodos to
// "<dedupe>@<done_at>" (the range '@' to 'A' is exactly that, and keeps to the dedupe index). ?1 = pick:<UK date>.
const PICK_MADE_SQL = "SELECT 1 AS made FROM todos WHERE dedupe = ?1 OR (dedupe > ?1 || '@' AND dedupe < ?1 || 'A') LIMIT 1";

/**
 * The tick's `pick` step (every 30 minutes; overview §8 slot 6, after hot and before daily_find), from 07:00 UK: the
 * day's todo "{top} A-grade lead(s) ready: you can send {room} first email(s) today" (B-grade when only B leads are in
 * Ready), linking to Ready to email, due 07:00 UK, dedupe pick:<UK date>. The first run of a UK day closes every older
 * pick: todo; later runs update the open one's title, and close it once there's no room or nothing is ready.
 * A later run also adds today's todo when none was made yet (the first run from 07:00 found no room or nothing ready,
 * e.g. Claude's 06:47 research made the demos after it): Part A's "from 07:00, when room > 0 and ready leads exist",
 * which Part B's algorithm only did on the first run. One Nik dismissed or done, or one closed, is never made again.
 * Only while first emails can go out (stage 0's COLD_WINDOW, Mon–Sat 07:00–19:00 UK), so its "today" is true: a Sunday
 * run closes older days' todos and makes none (Monday 07:00 makes the next), and from 19:00 on a send day today's is
 * closed and none is made or retitled (no "today" title is left open overnight).
 * `ctx` is the tick's ({DB, now, budget}; env isn't used). → "before 07:00" | "no first emails go out today (Sunday)" |
 * "sending has stopped for today" | "nothing to pick" | the title | a wait when the tick's budget has no room left for
 * the writes (they're made on its next run).
 * At most 9 D1 statements (3 outside the send window).
 */
export async function pickStep({ DB, now = new Date(), budget } = {}) {
  const at = asDate(now);
  const { hh, weekday } = ukParts(at);
  if (hh < PICK_FROM_HOUR) return "before 07:00";
  const today = ukDate(at);
  const sendsToday = COLD_WINDOW.days.includes(weekday);
  const open = sendsToday && inUkWindow(at, COLD_WINDOW);
  // Outside the window nothing is picked, so today's room and the ready leads aren't read.
  let title = null;
  if (open) {
    const cap = await capacityNow(DB, at);
    const counts = await readyCounts(DB, at, cap.room);
    title = pickTitle({ top: counts.top, b: counts.b, room: cap.room, bIncluded: counts.b_included });
  }
  // Measured after the reads, so it still holds when stage 6 makes capacityNow cost more.
  if (typeof budget?.left === "function" && Number(budget.left()) - 1 < PICK_WRITES) {
    return "waiting for D1 room: it tries again on its next run";
  }

  const dedupe = PICK_PREFIX + today;
  let fresh = false;
  if ((await getSetting(DB, PICK_LAST)) !== today) {
    await closeTodos(DB, PICK_PREFIX);
    await setSetting(DB, PICK_LAST, today);
    fresh = true;
  }
  if (!sendsToday) return "no first emails go out today (Sunday)";
  if (!open) {
    // A new day's first run has just closed every pick: todo, today's included.
    if (!fresh) await closeTodos(DB, dedupe);
    return "sending has stopped for today";
  }
  if (!title) {
    await closeTodos(DB, dedupe);
    return "nothing to pick";
  }
  const add = () => addTodo(DB, {
    kind: "pick", title, detail: PICK_DETAIL, link: PICK_LINK, due_at: iso(ukToUtc(today, "07:00")), dedupe,
  });
  if (fresh) {
    await add();
  } else {
    const { meta } = await DB.prepare(PICK_RETITLE_SQL).bind(title, dedupe).run();
    if (!(meta?.changes > 0) && !(await DB.prepare(PICK_MADE_SQL).bind(dedupe).first())) await add();
  }
  return title;
}

// r.grade in `grades` (grade values, "none" = not graded); an empty list matches nothing.
function gradeSql(grades, P) {
  const real = grades.filter((g) => g !== "none");
  const parts = [];
  if (real.length) parts.push(`r.grade IN (SELECT value FROM json_each(${P.add(JSON.stringify(real))}))`);
  if (grades.includes("none")) parts.push("r.grade IS NULL");
  if (!parts.length) return "0";
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

// p.stage in `stages` (stage tokens, "none" = no prospect row).
function stageSql(stages, P) {
  const real = stages.filter((s) => s !== "none");
  const parts = [];
  if (real.length) parts.push(`p.stage IN (SELECT value FROM json_each(${P.add(JSON.stringify(real))}))`);
  if (stages.includes("none")) parts.push("p.place_id IS NULL");
  if (!parts.length) return "0";
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

// Search (Part A): name, trade, town, town searched, phone, any email (the prospect's, Claude's best and every one it
// found, the scraper's and every one it found) or the owner's full name; a case-insensitive substring, matched
// literally (likePattern escapes \ % _).
function searchSql(q, P) {
  const k = P.add(likePattern(q));
  const like = (expr) => `${expr} LIKE ${k} ESCAPE '\\'`;
  const researchEmail = "CASE e.type WHEN 'object' THEN json_extract(e.value, '$.email') WHEN 'text' THEN e.value END";
  return `(${[
    like("l.name"), like("l.trade"), like("l.town"), like("l.search_town"), like("l.phone"),
    like("p.email"), like("r.best_email"), like("l.email"),
    `EXISTS (SELECT 1 FROM json_each(${LEAD_EMAILS_JSON}) AS e WHERE ${like("e.value")})`,
    `EXISTS (SELECT 1 FROM json_each(${RESEARCH_EMAILS_JSON}) AS e WHERE ${like(researchEmail)})`,
    like(`json_extract(${OWNER_JSON}, '$.full')`),
  ].join("\n      OR ")})`;
}

// Filters that narrow both views: trade, town searched, search text and scrape run.
function narrowSql(f, P) {
  const conds = [];
  if (f.trade) conds.push(`l.trade = ${P.add(f.trade)}`);
  if (f.town) conds.push(`l.search_town = ${P.add(f.town)}`);
  if (f.q) conds.push(searchSql(f.q, P));
  if (f.job) conds.push(`l.last_job_id = ${P.add(f.job)}`);
  return conds;
}

/**
 * The WHERE conditions of a view. Ready: READY_SQL, grades in `grades` (null = no grade clause), then trade, town,
 * search and run (its stage, email, researched and excluded filters only show in All leads, so they're ignored).
 * All: Show excluded, grades (null = any), has email, stage, researched, then the same four.
 */
function viewConds(f, P, grades) {
  const conds = [];
  if (f.view === "ready") {
    conds.push(READY_SQL);
    if (grades) conds.push(gradeSql(grades, P));
  } else {
    if (!f.excluded) conds.push("l.excluded = 0");
    if (grades) conds.push(gradeSql(grades, P));
    if (f.email !== null && f.email !== undefined) conds.push(`${EMAIL_SQL} ${f.email ? "IS NOT NULL" : "IS NULL"}`);
    if (f.stages) conds.push(stageSql(f.stages, P));
    if (f.researched === true) conds.push("r.status IN ('done', 'skipped')");
    if (f.researched === false) conds.push("(r.status IS NULL OR r.status NOT IN ('done', 'skipped'))");
  }
  return [...conds, ...narrowSql(f, P)];
}

// One API row: the row shape of Part B, Task 3.
function rowOut(r, now) {
  const stage = r.stage ?? null;
  const prospect = stage === null ? null : { stage, views: r.views, last_view_at: r.last_view_at, last_inbound_at: r.last_inbound_at };
  const labelKey = stage ?? "none";
  return {
    place_id: r.place_id,
    name: r.name,
    trade: r.trade,
    town: r.town ?? null,
    phone: r.phone ?? null,
    website: r.website ?? null,
    rating: r.rating ?? null,
    review_count: r.review_count ?? null,
    quality_score: num(r.quality_score),
    excluded: !!num(r.excluded),
    grade: r.grade ?? null,
    grade_reason: r.grade_reason ?? null,
    research_status: r.research_status ?? null,
    email: r.email ?? null,
    suppressed: !!num(r.suppressed),
    stage,
    stage_label: Object.hasOwn(STAGE_LABELS, labelKey) ? STAGE_LABELS[labelKey] : String(stage),
    views: num(r.views),
    last_view_at: r.last_view_at ?? null,
    hot: prospect ? isHot(prospect, now) : false,
    demo_slug: r.demo_slug ?? null,
    top_issue: textOrNull(r.top_issue),
    owner_first: textOrNull(r.owner_first),
  };
}

// [{value, n}] of one facet, by value (empty values left out: they can't be picked).
const facetList = (rows, facet) =>
  rows
    .filter((r) => r.facet === facet && textOrNull(r.value))
    .map((r) => ({ value: r.value, n: num(r.n) }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));

/**
 * The Leads page (GET /api/leads): `filters` from parseLeadFilters, `now` a Date. Returns {rows (50 a page), total,
 * page, pages, grade_counts, view_counts: {ready, all}, facets: {trades, towns}, capacity (capacityNow), ready
 * (readyCounts)}; grade_counts (every filter but grade, so the chips add up to the total), view_counts and facets
 * (of the view's leads before its filters) only on page 1, else null. At most 8 D1 statements.
 */
export async function listLeads(DB, filters, now) {
  const f = { ...parseLeadFilters(""), ...(filters ?? {}) };
  f.view = f.view === "all" ? "all" : "ready";
  // An empty set of chips means no filter (Part A), as parseLeadFilters gives it.
  if (!Array.isArray(f.grades) || !f.grades.length) f.grades = null;
  if (!Array.isArray(f.stages) || !f.stages.length) f.stages = null;
  const page = Number.isSafeInteger(f.page) && f.page >= 1 ? f.page : 1;
  const at = asDate(now);
  const nowIso = iso(at);

  // Order is forced: Ready's grades need today's room, and the room needs the capacity.
  const capacity = await capacityNow(DB, at);
  const ready = await readyCounts(DB, at, capacity.room);

  // Ready: today's ready grades, narrowed by its grade chips when any are ticked. Ready shows only the A+, A and B
  // chips, so a C, D or Not graded chip ticked in All leads is ignored here, like All's other filters; B ticked while
  // it isn't in Ready today matches nothing.
  const readyChips = f.grades ? f.grades.filter((g) => READY_CHIPS.includes(g)) : [];
  const rowGrades = f.view === "ready"
    ? (readyChips.length ? ready.grades.filter((g) => readyChips.includes(g)) : ready.grades)
    : f.grades;

  const R = params(nowIso);
  const rowWhere = whereSql(viewConds(f, R, rowGrades));
  const rowSql = `${ROW_SQL}
  ${rowWhere}
  ${ORDER_SQL}
  LIMIT ${R.add(PAGE_SIZE)} OFFSET ${R.add((page - 1) * PAGE_SIZE)}`;
  const stmts = [prepare(DB, rowSql, R.values)];

  if (page === 1) {
    const G = params(nowIso);
    stmts.push(prepare(DB, `SELECT COALESCE(r.grade, 'none') AS grade, COUNT(*) AS n ${FROM_SQL}
  ${whereSql(viewConds(f, G, null))}
  GROUP BY COALESCE(r.grade, 'none')`, G.values));
    // Facets of the view's leads before its filters (Ready: the ready rule and today's grades; All: Show excluded),
    // and the All leads count for its tab (Ready's is ready.top, plus ready.b when B is in).
    const V = params(nowIso);
    const base = f.view === "ready" ? [READY_SQL, gradeSql(ready.grades, V)] : f.excluded ? [] : ["l.excluded = 0"];
    stmts.push(prepare(DB, `WITH base AS (SELECT l.trade, l.search_town ${FROM_SQL} ${whereSql(base)})
  SELECT 'trade' AS facet, trade AS value, COUNT(*) AS n FROM base GROUP BY trade
  UNION ALL SELECT 'town', search_town, COUNT(*) FROM base GROUP BY search_town
  UNION ALL SELECT 'all', NULL, COUNT(*) FROM leads l ${f.excluded ? "" : "WHERE l.excluded = 0"}`, V.values));
  }

  const [rowRes, gradeRes, facetRes] = await DB.batch(stmts);
  const rows = rowRes.results;
  let total = rows.length ? num(rows[0].total) : 0;
  if (!rows.length && page > 1) {
    // Past the last page: the window total needs a row, so count on its own.
    const C = params(nowIso);
    const sql = `SELECT COUNT(*) AS n ${FROM_SQL} ${whereSql(viewConds(f, C, rowGrades))}`;
    total = num(await prepare(DB, sql, C.values).first("n"));
  }

  let grade_counts = null, view_counts = null, facets = null;
  if (page === 1) {
    grade_counts = Object.fromEntries([...GRADES, "none"].map((g) => [g, 0]));
    for (const r of gradeRes.results) if (Object.hasOwn(grade_counts, r.grade)) grade_counts[r.grade] = num(r.n);
    const all = facetRes.results.find((r) => r.facet === "all");
    view_counts = { ready: ready.top + (ready.b_included ? ready.b : 0), all: num(all?.n) };
    facets = { trades: facetList(facetRes.results, "trade"), towns: facetList(facetRes.results, "town") };
  }

  return {
    rows: rows.map((r) => rowOut(r, at)),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    grade_counts,
    view_counts,
    facets,
    capacity,
    ready,
  };
}

// ---- The lead panel (Part A, "The lead panel"; Part B, Task 4) ----

const BODY_MAX = 5000; // characters of a message body, then "…"
const REVIEW_MAX = 600; // characters of a review's text, then "…"
const REVIEWS_MAX = 3;
const MESSAGES_MAX = 100;
const CALLS_MAX = 5;

// The research row's columns, read as r_<name> (leads has its own status and notes); parseResearch gets them back under
// their own names, as GET /api/research/<place_id> hands them to the research card.
const DETAIL_RESEARCH = ["place_id", "status", "grade", "points", "grade_reason", "angle", "opener", "owner", "best_email",
  "best_email_why", "emails", "copy", "site_review", "too_big", "notes", "searched", "queued_at", "researched_at"];
// The prospect's columns the panel shows, read as p_<name>.
const DETAIL_PROSPECT = ["place_id", "stage", "stage_at", "email", "greet_name", "first_sent_at", "followup_step",
  "next_followup_at", "views", "last_view_at", "last_inbound_at", "lost_reason"];

// One part of the audit JSON, only when it has the right JSON type (json_extract throws on text that isn't JSON). The
// audit itself is never selected: it holds raw HTML.
const AUDIT_JSON = "CASE WHEN json_valid(l.audit) THEN l.audit END";
const auditPart = (path, type) =>
  `CASE WHEN json_type(${AUDIT_JSON}, '${path}') = '${type}' THEN json_extract(${AUDIT_JSON}, '${path}') END`;

// The lead with its research, prospect and Map Rank row, the do-not-contact test and email as the list has them, and
// the research card's "N leads waiting". ?1 = place_id.
const DETAIL_SQL = `SELECT l.place_id, l.name, l.trade, l.town, l.search_town, l.address, l.postcode, l.phone, l.website,
    l.maps_url, l.rating, l.review_count, l.quality_score, l.company_number, l.excluded, l.exclude_reason, l.issues,
    l.socials, l.notes, l.first_seen_at,
    ${EMAIL_SQL} AS email,
    ${SUPPRESSED_SQL} AS suppressed,
    ${auditPart("$.findings", "array")} AS audit_findings,
    ${auditPart("$.reviews", "array")} AS audit_reviews,
    ${auditPart("$.map_rank", "object")} AS audit_map_rank,
    ${DETAIL_RESEARCH.map((c) => `r.${c} AS r_${c}`).join(", ")},
    ${DETAIL_PROSPECT.map((c) => `p.${c} AS p_${c}`).join(", ")},
    m.scan_id AS m_scan_id, m.keyword AS m_keyword, m.town AS m_town, m.avg_rank AS m_avg_rank,
    m.top3_pct AS m_top3_pct, m.found_pct AS m_found_pct, m.updated_at AS m_updated_at,
    (SELECT COUNT(*) FROM research WHERE status = 'queued') AS research_waiting
  ${FROM_SQL}
  LEFT JOIN lead_map_rank m ON m.place_id = l.place_id
  WHERE l.place_id = ?1`;

// The live demo: the newest with expires_at > now, as the list's demo_slug. ?1 = place_id, ?2 = now.
const DEMO_SQL = `SELECT d.slug, d.expires_at FROM demos d WHERE d.place_id = ?1 AND d.expires_at > ?2
  ORDER BY d.created_at DESC, d.slug DESC LIMIT 1`;
// Every message, oldest first (rowid keeps the order of ones saved in the same second). The body is cut in SQL, so a
// long one never leaves D1 whole; SQLite counts characters, so the cut never splits one. But its text functions
// (substr, length) stop at a NUL character, which a broken inbound part can carry, and would show only what comes
// before it with no "…": such a body comes as the hex of its first BODY_BYTES bytes instead (a character is at most 4,
// so they hold the 5,000 shown), decoded by nulBody. ?1 = place_id.
const BODY_BYTES = 4 * BODY_MAX;
const HAS_NUL = "instr(body, char(0)) > 0";
const MESSAGES_SQL = `SELECT id, direction, kind, step, author, from_addr, to_addr, subject,
    CASE WHEN ${HAS_NUL} THEN NULL ELSE substr(body, 1, ${BODY_MAX}) END AS body,
    CASE WHEN ${HAS_NUL} THEN length(CAST(body AS BLOB)) > ${BODY_BYTES} ELSE length(body) > ${BODY_MAX} END AS body_cut,
    CASE WHEN ${HAS_NUL} THEN hex(substr(CAST(body AS BLOB), 1, ${BODY_BYTES})) END AS body_hex,
    status, sent_at, received_at, created_at, class
  FROM messages WHERE place_id = ?1
  ORDER BY created_at, rowid LIMIT ${MESSAGES_MAX}`;
// The latest calls first. ?1 = place_id.
const CALLS_SQL = `SELECT slot_at, status FROM calls WHERE place_id = ?1 ORDER BY slot_at DESC LIMIT ${CALLS_MAX}`;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (list) => (Array.isArray(list) ? list.filter((v) => typeof v === "string") : []);
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Text cut to `max` characters (never half of one), then "…".
function cut(text, max) {
  if (text.length <= max) return text;
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

// The scraper's best Google reviews (audit.reviews, already best first): up to 3 with text, {author, rating, text}.
function topReviews(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (out.length === REVIEWS_MAX) break;
    if (!isObj(r) || typeof r.text !== "string" || !r.text.trim()) continue;
    out.push({ author: typeof r.author === "string" ? r.author : "", rating: finite(r.rating), text: cut(r.text, REVIEW_MAX) });
  }
  return out;
}

// Stage 4's template for the lead's trade (templateIdFor in _lib/demo/data.js), or null before stage 4 ships, which
// hides the panel's Preview. The specifier is a literal, so the Pages build bundles the module once it exists and
// leaves the import alone until then; the missing module then rejects here, at run time.
async function templateFor(trade) {
  const id = await import("./demo/data.js").then((m) => m.templateIdFor(trade)).catch(() => null);
  return typeof id === "string" && id ? id : null;
}

function prospectOut(row, at) {
  const p = Object.fromEntries(DETAIL_PROSPECT.map((c) => [c, row[`p_${c}`] ?? null]));
  const stage = p.stage;
  return {
    stage,
    stage_label: Object.hasOwn(STAGE_LABELS, stage) ? STAGE_LABELS[stage] : String(stage),
    stage_at: p.stage_at,
    email: p.email,
    greet_name: p.greet_name,
    first_sent_at: p.first_sent_at,
    followup_step: num(p.followup_step),
    next_followup_at: p.next_followup_at,
    views: num(p.views),
    last_view_at: p.last_view_at,
    last_inbound_at: p.last_inbound_at,
    lost_reason: p.lost_reason,
    hot: isHot(p, at),
  };
}

// A body that held a NUL character, from SQLite's hex() (upper case) of its first BODY_BYTES bytes (`more`: it had more
// bytes than that): NULs dropped, then cut to 5,000 characters like the others. The byte cut can end inside a
// character, which decodes as U+FFFD, so that one is dropped.
const hexDigit = (c) => (c <= 57 ? c - 48 : c - 55);
function nulBody(hex, more) {
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0, j = 0; i < bytes.length; i++, j += 2) {
    bytes[i] = (hexDigit(hex.charCodeAt(j)) << 4) | hexDigit(hex.charCodeAt(j + 1));
  }
  let text = new TextDecoder().decode(bytes).replaceAll("\u0000", "");
  if (more && text.endsWith("\uFFFD")) text = text.slice(0, -1);
  let end = 0; // after the first BODY_MAX characters (a character above U+FFFF is two units)
  for (let n = 0; n < BODY_MAX && end < text.length; n++) end += text.codePointAt(end) > 0xffff ? 2 : 1;
  return end < text.length || more ? `${text.slice(0, end)}…` : text;
}

const messageOut = (m) => ({
  id: m.id,
  direction: m.direction,
  kind: m.kind,
  step: m.step ?? null,
  author: m.author,
  from_addr: m.from_addr ?? null,
  to_addr: m.to_addr ?? null,
  subject: m.subject ?? null,
  body: typeof m.body_hex === "string" ? nulBody(m.body_hex, !!num(m.body_cut)) : `${m.body ?? ""}${num(m.body_cut) ? "…" : ""}`,
  status: m.status,
  sent_at: m.sent_at ?? null,
  received_at: m.received_at ?? null,
  created_at: m.created_at,
  class: m.class ?? null,
});

/**
 * Everything the lead panel shows, in one request (GET /api/leads/:id): {lead, research (parseResearch of the row, null
 * when there's none), research_waiting (leads queued for research), prospect (null when not contacted), demo (the live
 * one, null when none: url relative, template stage 4's), map_rank, messages (oldest first, at most 100, bodies cut to
 * 5,000 characters), calls (the latest 5), suppressed, offer (offerFor(now)), guarantee (GUARANTEE)}, or null when the
 * lead isn't in the database. Never the audit or raw HTML, and no Maps lines from another town's scan: when the audit's
 * Map Rank part is another town's, findings leave out the maps_ and reviews_behind codes and map_rank is null (as leadRow
 * does for every other reader); a lead_map_rank row of another town is never shown either (as stage 2's queue).
 * At most 4 D1 statements: the lead row, then one batch of the live demo, messages and calls.
 */
export async function leadDetail(DB, placeId, now = new Date()) {
  if (typeof placeId !== "string" || !placeId) return null;
  const at = asDate(now);
  const row = await DB.prepare(DETAIL_SQL).bind(placeId).first();
  if (!row) return null;
  const [demoRes, messageRes, callRes] = await DB.batch([
    DB.prepare(DEMO_SQL).bind(placeId, iso(at)),
    DB.prepare(MESSAGES_SQL).bind(placeId),
    DB.prepare(CALLS_SQL).bind(placeId),
  ]);

  const home = { town: row.town, search_town: row.search_town };
  const auditMaps = parseJson(row.audit_map_rank, null);
  const otherTown = mapsFromAnotherTown(isObj(auditMaps) ? auditMaps : {}, home);
  const allFindings = strings(parseJson(row.audit_findings, []));
  const hasMapRow = row.m_scan_id !== null && row.m_scan_id !== undefined;
  const ownMapRow = hasMapRow && !otherTown && !mapsFromAnotherTown({ scan_town: row.m_town }, home);
  const socials = parseJson(row.socials, {});
  const live = demoRes.results[0];

  return {
    lead: {
      place_id: row.place_id,
      name: row.name,
      trade: row.trade,
      town: row.town ?? null,
      search_town: row.search_town ?? null,
      address: row.address ?? null,
      postcode: row.postcode ?? null,
      phone: row.phone ?? null,
      website: row.website ?? null,
      maps_url: row.maps_url ?? null,
      rating: row.rating ?? null,
      review_count: row.review_count ?? null,
      quality_score: num(row.quality_score),
      company_number: row.company_number ?? null,
      excluded: !!num(row.excluded),
      exclude_reason: row.exclude_reason ?? null,
      issues: strings(parseJson(row.issues, [])),
      findings: otherTown ? allFindings.filter((f) => !MAPS_FINDING.test(f)) : allFindings,
      socials: isObj(socials) ? socials : {},
      reviews: topReviews(parseJson(row.audit_reviews, [])),
      notes: typeof row.notes === "string" ? row.notes : "",
      first_seen_at: row.first_seen_at ?? null,
      // The address we'd write to (the prospect's, else Claude's best, else the scraper's), as the list's email.
      email: row.email ?? null,
    },
    research: row.r_place_id === null || row.r_place_id === undefined
      ? null
      : parseResearch(Object.fromEntries(DETAIL_RESEARCH.map((c) => [c, row[`r_${c}`]]))),
    research_waiting: num(row.research_waiting),
    prospect: row.p_place_id === null || row.p_place_id === undefined ? null : prospectOut(row, at),
    demo: live
      ? { slug: live.slug, url: `/d/${encodeURIComponent(live.slug)}`, expires_at: live.expires_at, template: await templateFor(row.trade) }
      : null,
    map_rank: ownMapRow
      ? {
        scan_id: row.m_scan_id, keyword: row.m_keyword, avg_rank: row.m_avg_rank, top3_pct: row.m_top3_pct,
        found_pct: row.m_found_pct, updated_at: row.m_updated_at,
      }
      : null,
    messages: messageRes.results.map(messageOut),
    calls: callRes.results.map((c) => ({ slot_at: c.slot_at, status: c.status })),
    suppressed: !!num(row.suppressed),
    offer: offerFor(at),
    guarantee: GUARANTEE,
  };
}

// ---- Not a fit (Part A, "The lead panel"; Part B, Task 5) ----

/** The panel's text when the lead was deleted after the list loaded (GET and PATCH /api/leads/:id, Not a fit). */
export const LEAD_GONE = "That lead isn't in the database any more. Close this panel and refresh.";
/** What Not a fit refuses with (Part A, exactly). */
export const NOT_A_FIT_ERRORS = Object.freeze({
  reason: "Say why in a few words (3 to 200 characters).",
  emailed: "Already emailed. Stop the follow-ups from the conversation instead.",
  gone: LEAD_GONE,
});
const REASON_MIN = 3;
const REASON_MAX = 200; // characters (code points), after trimming

// The lead, its prospect's stage (NULL when not contacted) and whether its first email has gone or is going: stage 6
// keeps the prospect `ready` until a sent first email is synced by its next followups step, so the stage alone can
// say `ready` for a lead that was emailed minutes ago. ?1 = place_id.
const NOT_FIT_STATE_SQL = `SELECT l.place_id, p.stage, p.first_sent_at,
    EXISTS (SELECT 1 FROM messages m WHERE m.place_id = l.place_id AND m.kind = 'first'
      AND m.status IN ('sending', 'sent')) AS first_out
  FROM leads l LEFT JOIN prospects p ON p.place_id = l.place_id
  WHERE l.place_id = ?1`;
// Not a fit may go ahead (checked again inside the batch, on every statement): the lead exists, it has no prospect or
// a `ready` one never emailed, and no first email to it is sending or sent. ?1 = place_id.
const NOT_FIT_OK = `EXISTS (SELECT 1 FROM leads WHERE place_id = ?1)
    AND NOT EXISTS (SELECT 1 FROM prospects WHERE place_id = ?1 AND (stage <> 'ready' OR first_sent_at IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM messages WHERE place_id = ?1 AND kind = 'first' AND status IN ('sending', 'sent'))`;
// Blank characters trimmed off the old notes, as stage 2's "Research is wrong" trims them.
const NOTE_BLANK = "char(32, 9, 13, 10)";
// The same press again (a retry after a lost answer, a double-click): already skipped with this line on top. Then the
// notes stay as they are, so a repeated press adds no second [Nik …] line. ?2 = Nik's line.
const SAME_NOT_FIT = `(research.status = 'skipped'
      AND (research.notes = ?2 OR substr(research.notes, 1, length(?2) + 1) = ?2 || char(10)))`;
// ?1 = place_id, ?2 = Nik's line "[Nik YYYY-MM-DD] Not a fit: <reason>", which goes on top of the notes (stage 2's
// mergeNotes keeps it there on every later post, and its research card reads the reason back). status 'skipped' takes
// the lead out of Ready and out of Claude's queue for good (saveResearch never writes a skipped row; stage 1's queue
// insert is OR IGNORE). The rest of the row (grade, findings) stays for the card. A lead never researched gets a row
// of its own. Written only while the lead exists and hasn't been emailed (NOT_FIT_OK), checked again here inside the
// batch, so a first email sent after markNotFit's read is never followed by a skip.
const NOT_FIT_SQL = `INSERT INTO research (place_id, status, notes)
  SELECT ?1, 'skipped', ?2
  WHERE ${NOT_FIT_OK}
  ON CONFLICT(place_id) DO UPDATE SET
    status = 'skipped',
    notes = CASE WHEN ${SAME_NOT_FIT} THEN research.notes
      ELSE ?2 || CASE WHEN TRIM(COALESCE(research.notes, ''), ${NOTE_BLANK}) = '' THEN ''
        ELSE char(10) || TRIM(research.notes, ${NOTE_BLANK}) END END`;
// A first email Nik queued (stage 6) and that hasn't started going is cancelled, so a lead he rejected is never
// emailed; the row stays in the conversation with why. The outbox only claims a `queued` row, so it can't go after
// this. ?1 = place_id, ?2 = the reason stored on the message.
const CANCEL_FIRST_SQL = `UPDATE messages SET status = 'cancelled', error = ?2
  WHERE place_id = ?1 AND kind = 'first' AND status = 'queued' AND ${NOT_FIT_OK}`;
const CANCELLED_WHY = "Cancelled: you marked the lead not a fit.";
// Only a `ready` prospect (made when its demo was ready, never emailed) is removed; the demo row stays. ?1 = place_id.
const DROP_READY_SQL = `DELETE FROM prospects WHERE place_id = ?1 AND stage = 'ready' AND ${NOT_FIT_OK}`;

// The reason on one line (line breaks and control characters become spaces, so it can never start a line that passes
// for another of Nik's), trimmed, 3 to 200 characters; else null.
function notFitReason(reason) {
  if (typeof reason !== "string") return null;
  const line = reason.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  if (line.length > REASON_MAX * 2) return null; // 200 characters are at most 400 UTF-16 units
  const n = [...line].length;
  return n >= REASON_MIN && n <= REASON_MAX ? line : null;
}

// {error, status} when Not a fit can't be done for this lead state (NOT_FIT_STATE_SQL's row), else null.
function notFitRefused(state) {
  if (!state) return { error: LEAD_GONE, status: 404 };
  const emailed = (state.stage !== null && state.stage !== undefined && state.stage !== "ready")
    || !!state.first_sent_at || !!num(state.first_out);
  return emailed ? { error: NOT_A_FIT_ERRORS.emailed, status: 409 } : null;
}

/**
 * Nik's "Not a fit" (POST /api/leads/:id/not-a-fit): research status 'skipped' with the line
 * "[Nik <UK date of now>] Not a fit: <reason>" on top of the research notes (older lines kept below it), a first email
 * still queued for it cancelled, and a `ready` prospect deleted, in one batch. → {ok: true}, or {error, status}: 400
 * when the reason isn't 3 to 200 characters, 404 when the lead isn't in the database, 409 once it's been emailed (a
 * prospect at any stage after `ready`, or a first email sending or sent); nothing changes on a refusal. 4 D1 statements
 * (the lead's state, then the batch of 3); 5 when it was emailed in between.
 */
export async function markNotFit(DB, placeId, reason, now = new Date()) {
  const why = notFitReason(reason);
  if (why === null) return { error: NOT_A_FIT_ERRORS.reason, status: 400 };
  if (typeof placeId !== "string" || !placeId) return { error: LEAD_GONE, status: 404 };
  const refused = notFitRefused(await DB.prepare(NOT_FIT_STATE_SQL).bind(placeId).first());
  if (refused) return refused;

  const line = `[Nik ${ukDate(asDate(now))}] Not a fit: ${why}`;
  const [marked] = await DB.batch([
    DB.prepare(NOT_FIT_SQL).bind(placeId, line),
    DB.prepare(CANCEL_FIRST_SQL).bind(placeId, CANCELLED_WHY),
    DB.prepare(DROP_READY_SQL).bind(placeId),
  ]);
  if (marked?.meta?.changes) return { ok: true };
  // Emailed (or deleted) between the read and the batch: nothing was written.
  return notFitRefused(await DB.prepare(NOT_FIT_STATE_SQL).bind(placeId).first())
    ?? { error: NOT_A_FIT_ERRORS.emailed, status: 409 };
}
