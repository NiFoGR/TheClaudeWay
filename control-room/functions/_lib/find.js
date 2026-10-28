// Find, the database part (02-find Tasks 10–13): start a lead search, the pipeline numbers the daily decision reads,
// the searches of the last month, and the territory setting; the research queue (every lead filter 1 hands to Claude,
// once) and the research Routine's fire guard; stuck searches and scans marked failed. The rules themselves are pure,
// in _lib/territory.js; the tick steps daily_find and stale_jobs and POST /api/scrape act through this module.
//
// Every time written here is iso() text (UTC, no milliseconds), the same as Python's _now(), so stored times compare
// as strings. iso lives in util.js: other stages import it from there, this module only passes it on.
import { countingDB } from "./d1count.js";
import { startWorkflow } from "./github.js";
import { registerLight } from "./health.js";
import { suppressionKeys } from "./prospects.js";
import { beat, fireRoutine } from "./routines.js";
import { getSetting, setSetting } from "./settings.js";
import { FIND_FROM, MIN_RESEARCH_SCORE, RECENT_DAYS, decideFind, parseTerritory, todayLine } from "./territory.js";
import { addTodo, closeTodos } from "./todo.js";
import { addUkDays, ukDate, ukParts } from "./ukTime.js";
import { iso, parseJson } from "./util.js";

export { iso } from "./util.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SCRAPE_WORKFLOW = "scrape-leads.yml";
const GITHUB_TOKEN_RE = /\b(?:gh[opusr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/g;

// The GitHub token never goes into a saved error (it is stored on the job, shown on the page and in todos): a fetch
// that throws can quote a header value, e.g. Node does for a GITHUB_TOKEN pasted with a stray line break.
function hideToken(text, env) {
  let out = String(text);
  const token = typeof env?.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN : "";
  for (const secret of new Set([token, token.trim()])) {
    if (secret.length >= 8) out = out.split(secret).join("[hidden]");
  }
  return out.replace(GITHUB_TOKEN_RE, "[hidden]");
}

/** The territory setting ({on, trade, towns, next, max}) over the defaults; unreadable or missing → the defaults. */
export async function loadTerritory(DB) {
  return parseTerritory(await getSetting(DB, "territory"));
}

/**
 * Save the territory as the JSON text {on, trade, towns, next, max}: the shape Python's autopilot.py json.loads and
 * stripe.js getSetting read. Only those five keys are stored.
 */
export async function saveTerritory(DB, territory) {
  await setSetting(DB, "territory", territoryText(territory));
}

// The territory as stored: JSON text of exactly {on, trade, towns, next, max}.
function territoryText({ on, trade, towns, next, max }) {
  return JSON.stringify({ on, trade, towns, next, max });
}

/**
 * Start one lead search: save its jobs row ('queued') and ask GitHub to run scrape-leads.yml with
 * {trade, town, max (as text), job_id}. A refused start is saved as 'failed' with startWorkflow's plain-English
 * reason, and so is a start that throws (GitHub unreachable), so no run is left queued with nothing behind it.
 * → {job: the saved jobs row, error: "" or the reason}. 1 D1 statement when it starts, 2 when it doesn't.
 * The caller checks trade, town and max (10–300) first.
 */
export async function startScrape(DB, env, { trade, town, max }, { start = startWorkflow, now = new Date() } = {}) {
  const id = crypto.randomUUID();
  const ts = iso(now);
  let job = await DB.prepare(
    "INSERT INTO jobs (id, trade, town, max_results, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?) RETURNING *",
  ).bind(id, trade, town, max, ts, ts).first();

  let error;
  try {
    error = await start(env, SCRAPE_WORKFLOW, { trade, town, max: String(max), job_id: id });
  } catch (err) {
    const why = hideToken(String(err?.message || err), env).slice(0, 200).replace(/[\s.]+$/, "");
    error = `Couldn't reach GitHub to start the run (${why}). Try again in a few minutes.`;
  }
  error = error ? hideToken(String(error), env) : "";
  if (error) {
    job = await DB.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? RETURNING *")
      .bind(error, ts, id).first();
  }
  return { job, error };
}

/**
 * The numbers today's decision reads, in one D1 statement:
 * - goodWaiting: graded leads ready to email and not emailed yet (research done, grade A+/A/B, not too big, lead not
 *   excluded, no prospects row with first_sent_at set). The shortlist's "A+/A/B not emailed" count.
 * - researchQueued: research rows still queued for Claude.
 * - activeJobs: searches (any, Nik's too) queued or running.
 */
export async function pipelineCounts(DB) {
  const row = await DB.prepare(`SELECT
    (SELECT COUNT(*) FROM research r JOIN leads l ON l.place_id = r.place_id
      WHERE r.status = 'done' AND r.grade IN ('A+','A','B') AND r.too_big = 0 AND l.excluded = 0
        AND NOT EXISTS (SELECT 1 FROM prospects p WHERE p.place_id = r.place_id AND p.first_sent_at IS NOT NULL)) AS goodWaiting,
    (SELECT COUNT(*) FROM research WHERE status = 'queued') AS researchQueued,
    (SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')) AS activeJobs`).first();
  return {
    goodWaiting: Number(row?.goodWaiting) || 0,
    researchQueued: Number(row?.researchQueued) || 0,
    activeJobs: Number(row?.activeJobs) || 0,
  };
}

/**
 * Every search created in the last RECENT_DAYS + 1 days (31: one more than the 30 UK days chooseTown looks at, so a
 * UK day boundary never cuts one off), newest first, any trade or status: chooseTown leaves out failed runs and other
 * trades itself. → [{trade, town, status, created_at}]. One D1 statement.
 */
export async function recentJobs(DB, now = new Date()) {
  const since = iso(new Date(now).getTime() - (RECENT_DAYS + 1) * DAY_MS);
  const { results } = await DB.prepare(
    "SELECT trade, town, status, created_at FROM jobs WHERE created_at >= ? ORDER BY created_at DESC",
  ).bind(since).all();
  return results;
}

// ---------------------------------------------------------------- the research queue (filter 1 → Claude)

// A research fire is attempted at most this often (failed attempts count): the same 30-minute duplicate guard stage 2's
// "Research is wrong" re-check uses, so every search that queues a lead wakes Claude, but a burst of them fires once.
export const RESEARCH_FIRE_GAP_MINUTES = 30;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// A domain as the suppression list compares it: lower case, no leading "@" or "www.", no trailing dot.
const domainKey = (value) =>
  String(value ?? "").trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "").replace(/^www\./, "");

// The host a lead's website is on, as domainKey reads it ("" when there's no website or it can't be read). A website
// saved without a scheme ("www.smith.co.uk/contact") is read as http://.
function siteHost(website) {
  const text = typeof website === "string" ? website.trim() : "";
  if (!text) return "";
  try {
    return domainKey(new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname);
  } catch {
    return "";
  }
}

// The suppression rows ({value, kind}: email | domain | company) as one test: lead → true when it may not be
// researched or pitched. Built once per list, so a whole batch of leads costs one pass over the rows.
function suppressionTest(suppressionRows) {
  const emails = new Set();
  const domains = new Set();
  const companies = new Set();
  for (const row of Array.isArray(suppressionRows) ? suppressionRows : []) {
    if (row?.kind === "email") emails.add(suppressionKeys(String(row.value ?? "")).address);
    else if (row?.kind === "domain") domains.add(domainKey(row.value));
    else if (row?.kind === "company") companies.add(String(row.value ?? "").trim().toUpperCase());
  }
  emails.delete("");
  domains.delete("");
  companies.delete("");
  return (lead) => {
    const { email, website, company_number } = lead ?? {};
    const { address, domain } = suppressionKeys(typeof email === "string" ? email : "");
    if (address.includes("@") && (emails.has(address) || domains.has(domainKey(domain)))) return true;
    const host = siteHost(website);
    if (host && domains.has(host)) return true;
    const company = typeof company_number === "string" ? company_number.trim().toUpperCase() : "";
    return Boolean(company) && companies.has(company);
  };
}

const suppressionTests = new WeakMap(); // suppressionRows list → {length, test} (forgotten with the list)

/**
 * True when the lead is on the do-not-contact list (opted out, bounced or blocked): its email address, its email's
 * domain, its website's host (with or without www.) or its company number matches a suppression row of that kind.
 * Ignores case; a subdomain is another domain (as prospects.js isSuppressed reads it). Pure: suppressionRows are
 * the `suppression` table's rows ({value, kind}). Stage 2 uses it to skip queued leads suppressed since.
 * Called once per lead with the same rows, the rows are read once (not once per lead, which would cost ~40 ms of CPU
 * for 200 leads against 1,100 rows): the test built from them is kept while that list's length is unchanged, so a
 * row added to the list counts from the next call. Don't edit rows in place between calls; pass a new list instead.
 */
export function leadSuppressed(lead, suppressionRows) {
  if (!Array.isArray(suppressionRows)) return suppressionTest(suppressionRows)(lead);
  let built = suppressionTests.get(suppressionRows);
  if (built?.length !== suppressionRows.length) {
    built = { length: suppressionRows.length, test: suppressionTest(suppressionRows) };
    suppressionTests.set(suppressionRows, built);
  }
  return built.test(lead);
}

/**
 * Queue for Claude's research every lead filter 1 hands on and research has never seen: not excluded, scoring
 * MIN_RESEARCH_SCORE (35) or more or not checkable by the website checker (finding not_checked), and not suppressed.
 * INSERT OR IGNORE, so a lead already queued, done or skipped is never touched. → the number of rows queued.
 * 1 D1 statement when nothing is new, 2 when no new lead may be queued (all suppressed), 3 otherwise (however many).
 * A lead whose audit JSON is unreadable is judged on its score alone, so one bad row never stops the queue. A lead row
 * without a place_id is never queued: research would take a NULL key every time, so the queue would never settle.
 */
export async function enqueueResearch(DB, now = new Date()) {
  const { results: candidates } = await DB.prepare(`SELECT l.place_id, l.email, l.website, l.company_number FROM leads l
    WHERE l.excluded = 0
      AND (l.quality_score >= ?
        OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(l.audit) THEN l.audit END, '$.findings') WHERE value = 'not_checked'))
      AND NOT EXISTS (SELECT 1 FROM research r WHERE r.place_id = l.place_id)`).bind(MIN_RESEARCH_SCORE).all();
  if (!candidates.length) return 0;
  const { results: suppression } = await DB.prepare("SELECT value, kind FROM suppression").all();
  const suppressed = suppressionTest(suppression);
  const placeIds = candidates
    .filter((lead) => typeof lead.place_id === "string" && lead.place_id && !suppressed(lead))
    .map((lead) => lead.place_id);
  if (!placeIds.length) return 0;
  const { meta } = await DB.prepare(
    "INSERT OR IGNORE INTO research (place_id, status, queued_at) SELECT value, 'queued', ? FROM json_each(?)",
  ).bind(iso(now), JSON.stringify(placeIds)).run();
  return Number(meta?.changes) || 0;
}

/**
 * Wake the research Routine when Claude has leads waiting: fire(DB, "research", "research queued: {n} leads", {now})
 * (n = every queued row) unless a research fire was attempted in the last RESEARCH_FIRE_GAP_MINUTES (30) minutes (a
 * row exactly 30 minutes old no longer counts). Failed attempts count, so a broken Routine is tried at most every 30
 * minutes, not every tick; the Routine's own daily schedule is the catch-up. daily_find calls it only after an
 * enqueue that queued at least one lead.
 * → "empty" (nothing queued), "recent", "fired", or "failed" (fireRoutine answered ok: false; it logged the attempt
 * itself). 1 D1 statement, plus fireRoutine's own (up to 5) when it fires.
 */
export async function maybeFireResearch(DB, now = new Date(), { fire = fireRoutine } = {}) {
  const when = new Date(now);
  const since = iso(when.getTime() - RESEARCH_FIRE_GAP_MINUTES * MINUTE_MS);
  const row = await DB.prepare(`SELECT (SELECT COUNT(*) FROM research WHERE status = 'queued') AS queued,
    EXISTS (SELECT 1 FROM routine_fires WHERE routine = 'research' AND at > ?) AS recent`).bind(since).first();
  const queued = Number(row?.queued) || 0;
  if (!queued) return "empty";
  if (Number(row?.recent)) return "recent";
  const result = await fire(DB, "research", `research queued: ${queued} leads`, { now: when });
  return result?.ok ? "fired" : "failed";
}

// ---------------------------------------------------------------- the tick step daily_find (Task 12)

// D1 statements one run may make at most. In the tick a run also stays within the tick's budget: ctx.budget.left()
// less 1, kept for the tick's own closing beat (as the send step does). The tick starts a step with 10 or more left,
// so a run there always has at least 9.
export const DAILY_FIND_MAX = 14;
// The most the research queue and its fire cost: enqueueResearch 3, maybeFireResearch 1, fireRoutine up to 5 (a 429)
// and the research:enqueued_at write 1. Without room for all of it nothing is queued or written: the same condition
// holds on the next tick, 5 minutes later.
const ENQUEUE_MAX = 10;
// The most the morning decision itself costs: the claim, the pipeline counts, the recent searches, the start (2 when
// GitHub refuses it; 1 and the pointer's save when it starts), the settings write (research:enqueued_at goes in it
// too), one todo and the beat; a decision that throws costs no more, recordBroken's 2 included. A run without room for
// it (after a real Routine fire, or late in a busy tick) decides on the next tick: the day is claimed only when it's
// decided, so it's never claimed without room to save it.
const DECISION_MAX = 8;
// checkTodaysJob: the job's read, its todo and the beat.
const CHECK_MAX = 3;
const LIGHT_STALE_HOURS = 26;
const SCRAPER_LINK = "/#/scraper";
const TRY_AGAIN = "Press Find leads to try again.";

// The four settings daily_find reads, and when the newest finished search was marked done, in one statement. That
// last row has no key (NULL), so no setting can be taken for it.
const READ_SQL = `SELECT key, value FROM settings WHERE key IN ('find:day', 'find:today', 'research:enqueued_at', 'territory')
  UNION ALL SELECT NULL, MAX(updated_at) FROM jobs WHERE status = 'done'`;
// Several settings in one statement: ?1 is a JSON object {key: text}. SQLite needs the WHERE before ON CONFLICT when
// an upsert takes its rows from a SELECT.
const SETTINGS_SQL =
  "INSERT INTO settings (key, value) SELECT j.key, j.value FROM json_each(?1) AS j WHERE 1 ON CONFLICT (key) DO UPDATE SET value = excluded.value";
// Compare-and-set: changes one row only when find:day isn't already this UK day.
const CLAIM_SQL =
  "INSERT INTO settings (key, value) VALUES ('find:day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value != excluded.value";

const LIGHT_RED_FIX =
  "Open the Lead Scraper page and press Find leads. If it fails again, check GITHUB_TOKEN in Cloudflare (Pages → Settings → Variables and Secrets) is still valid.";
const LIGHT_STALE_FIX =
  "The daily search runs from the tick: check the tick light. If that is green, press Find leads on the Lead Scraper page.";

const clock = (n) => String(n).padStart(2, "0");
// An error ends with a full stop before the todo's next sentence ("…Bad credentials. Check GITHUB_TOKEN…").
const sentence = (text) => {
  const t = String(text ?? "").trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** Claim today's decision: true only for the first call on UK day `ukToday` (compare-and-set on find:day). */
export async function claimDay(DB, ukToday) {
  const result = await DB.prepare(CLAIM_SQL).bind(ukToday).run();
  return result?.meta?.changes === 1;
}

async function writeSettings(DB, values) {
  const keys = Object.keys(values);
  if (!keys.length) return;
  await DB.prepare(SETTINGS_SQL).bind(JSON.stringify(values)).run();
  for (const key of keys) delete values[key];
}

// Move territory.next past today's town, only while the setting is still the text this run read (`readText`, or
// undefined when there was no row): an edit Nik saved on the Lead Scraper page meanwhile, e.g. while GitHub was
// starting the run, wins over the pointer. Same JSON as saveTerritory. 1 D1 statement.
async function movePointer(DB, readText, territory) {
  const text = territoryText(territory);
  if (typeof readText === "string") {
    await DB.prepare("UPDATE settings SET value = ? WHERE key = 'territory' AND value = ?").bind(text, readText).run();
  } else {
    await DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('territory', ?)").bind(text).run();
  }
}

// Today's decision, once the day is claimed: decide, start or skip, save find:today (with any other pending settings),
// move the pointer, then the todo and the beat. → the summary's part. `state.pending` holds the decision once it's
// made (so a failed save can still record a run that started), and `state.saved` is set once find:today is written.
async function decide(DB, env, when, { territory, readText, day, at, start, writes, state }) {
  const counts = await pipelineCounts(DB);
  const decision = decideFind({ territory, ...counts, recentJobs: await recentJobs(DB, when), ukToday: day });
  let saved;
  let job = null;
  if (decision.search) {
    const started = await startScrape(DB, env, { trade: territory.trade, town: decision.town, max: territory.max }, { start, now: when });
    job = started.job;
    saved = { day, at, search: true, town: decision.town, job_id: job?.id ?? null };
    if (started.error) saved.error = started.error;
  } else {
    saved = { day, at, ...decision };
  }
  state.pending = { saved, job };
  writes["find:today"] = JSON.stringify(saved);
  await writeSettings(DB, writes);
  state.saved = true;
  // Saved after find:today, so a run that started is never recorded as one that didn't. A refused start keeps the
  // pointer: the failed run doesn't make the town recent, so tomorrow tries it again.
  if (decision.search && !saved.error) await movePointer(DB, readText, { ...territory, next: decision.next });

  if (saved.error) {
    await addTodo(DB, {
      kind: "health",
      title: "Today's lead search didn't start",
      detail: `${sentence(saved.error)} Check GITHUB_TOKEN in Cloudflare (Pages → Settings → Variables and Secrets) is still valid, then press Find leads.`,
      link: SCRAPER_LINK,
      dedupe: `health:find:${day}`,
    });
  } else if (decision.search) {
    await closeTodos(DB, "health:find:towns");
  } else if (decision.reason === "towns") {
    await addTodo(DB, {
      kind: "health",
      title: "Add more towns to your automatic search",
      detail: "Every town on your list was searched in the last 30 days, so nothing new is being found. Add towns on the Lead Scraper page.",
      link: SCRAPER_LINK,
      dedupe: "health:find:towns",
    });
  }
  await beat(DB, "find", !saved.error, todayLine(saved, job, when), when);

  if (saved.error) return `couldn't start ${saved.town}`;
  if (decision.search) return `searched ${saved.town}`;
  return `skipped: ${decision.reason}${decision.n === undefined ? "" : ` (${decision.n})`}`;
}

// The last automatic search, once started (today's, or yesterday's until this morning's decision: one started late in
// the evening can be stopped after midnight): when its job has failed, the health:find:failed:<id> todo, and the
// find beat goes red (once: only when the todo is new), with the line of the decision's own day.
// → the summary's part ("" when there's nothing to say).
async function checkTodaysJob(DB, saved, when) {
  const job = await DB.prepare("SELECT id, town, status, error, found, created_at FROM jobs WHERE id = ?").bind(saved.job_id).first();
  if (job?.status !== "failed") return "";
  // stale_jobs' own error already ends with what to do, so the todo doesn't say it twice.
  const why = sentence(job.error || "No reason was recorded");
  const added = await addTodo(DB, {
    kind: "health",
    title: `Today's lead search failed: ${job.town || saved.town}`,
    detail: why.endsWith(TRY_AGAIN) ? why : `${why} ${TRY_AGAIN}`,
    link: SCRAPER_LINK,
    dedupe: `health:find:failed:${job.id}`,
  });
  if (!added) return "";
  const decidedAt = new Date(saved.at ?? "");
  const lineAt = saved.day === ukDate(when) || Number.isNaN(decidedAt.getTime()) ? when : decidedAt;
  await beat(DB, "find", false, todayLine(saved, job, lineAt), when);
  return "today's search failed";
}

// A decision that threw after the day was claimed (a D1 fault): the day stays decided (no retry every 5 minutes),
// so the page and the lead_search light say what happened: the decision itself when it was made (a run may have
// started) but couldn't be saved, else what went wrong. Best effort: a database that just failed may fail again.
async function recordBroken(DB, env, when, day, at, err, pending) {
  let saved = pending?.saved;
  if (!saved) {
    const why = hideToken(String(err?.message || err), env).replace(/\s+/g, " ").trim().slice(0, 200);
    saved = { day, at, search: false, error: `something went wrong while deciding (${why}). Press Find leads to search now` };
  }
  try {
    await setSetting(DB, "find:today", JSON.stringify(saved));
    await beat(DB, "find", !saved.error, todayLine(saved, pending?.job ?? null, when), when);
  } catch {
    // the tick's own heartbeat still shows the step's error
  }
}

/**
 * The tick step daily_find, in order (Part A "Daily automatic search" and "Research queue"):
 * 1. Research queue: when a search was marked done at or after research:enqueued_at, or from 06:00 UK when the last
 *    enqueue was on an earlier UK day: enqueueResearch, then, when it queued at least one lead, maybeFireResearch.
 * 2. From 06:00 UK, once per UK day (claimDay): decideFind, start the search or skip, save find:today, the todos and
 *    beat("find", ok, today's line). A search that starts moves territory.next (unless Nik saved the territory
 *    meanwhile) and closes health:find:towns. It waits for a research queue that is due (it reads the queue).
 * 3. Until the next decision: the last automatic search (today's, or yesterday's before 06:00) failing adds
 *    health:find:failed:<job id> and beats find not ok.
 * At most DAILY_FIND_MAX (14) D1 statements, and with `budget` (the tick's ctx.budget) at most budget.left() − 1: a
 * part without room waits for the next tick ("research queue on the next tick", "deciding on the next tick",
 * "checking today's search on the next tick"). → a short summary, e.g. "queued 12; fired research; searched Warrington".
 */
export async function runDailyFind(DB, env, now = new Date(), { start = startWorkflow, fire = fireRoutine, budget } = {}) {
  const when = new Date(now);
  const at = iso(when);
  const day = ukDate(when);
  const { hh, mm } = ukParts(when);
  const morning = `${clock(hh)}:${clock(mm)}` >= FIND_FROM;
  const counter = countingDB(DB);
  const D = counter.DB;
  // The tick's budget less 1 for its closing beat, never more than DAILY_FIND_MAX; a call without a budget gets the cap.
  const left = typeof budget?.left === "function" ? Number(budget.left()) : NaN;
  const limit = Number.isFinite(left) ? Math.min(DAILY_FIND_MAX, left - 1) : DAILY_FIND_MAX;
  const fits = (n) => counter.used() + n <= limit;

  const settings = {};
  let lastDone = null;
  for (const row of (await D.prepare(READ_SQL).all()).results) {
    if (row.key === null) lastDone = row.value;
    else settings[row.key] = row.value;
  }
  const savedToday = parseJson(settings["find:today"], null);
  const enqueuedAt = settings["research:enqueued_at"] ?? "";
  const enqueuedDay = Number.isFinite(Date.parse(enqueuedAt)) ? ukDate(new Date(enqueuedAt)) : "";

  const parts = [];
  const writes = {};
  // A search finished in the same second as the last enqueue counts as since (>=): its leads may have been saved
  // just after that enqueue read them. It only costs one more (cheap) enqueue.
  const afterSearch = typeof lastDone === "string" && lastDone >= enqueuedAt;
  const enqueueDue = afterSearch || (morning && enqueuedDay < day);
  const enqueueWaits = enqueueDue && !fits(ENQUEUE_MAX);
  if (enqueueWaits) {
    parts.push("research queue on the next tick");
  } else if (enqueueDue) {
    const queued = await enqueueResearch(D, when);
    parts.push(`queued ${queued}`);
    writes["research:enqueued_at"] = at;
    // Only new leads wake Claude: a morning with nothing new leaves the waiting ones to the Routine's 06:47 schedule.
    if (queued > 0) {
      const fired = await maybeFireResearch(D, when, { fire });
      if (fired === "fired") parts.push("fired research");
      else if (fired === "failed") parts.push("research fire failed");
    }
  }
  const pendingWrite = () => (Object.keys(writes).length ? 1 : 0);

  if (morning && settings["find:day"] !== day) {
    if (enqueueWaits || !fits(DECISION_MAX)) {
      parts.push("deciding on the next tick");
    } else if (await claimDay(D, day)) {
      const state = { saved: false, pending: null };
      const territory = parseTerritory(settings.territory ?? null);
      try {
        parts.push(await decide(D, env, when, { territory, readText: settings.territory, day, at, start, writes, state }));
      } catch (err) {
        if (!state.saved) await recordBroken(D, env, when, day, at, err, state.pending);
        throw err;
      }
    } else {
      parts.push("decided by another tick");
    }
  } else if ((savedToday?.day === day || savedToday?.day === addUkDays(day, -1))
    && savedToday.search && savedToday.job_id && !savedToday.error) {
    if (!fits(CHECK_MAX + pendingWrite())) {
      parts.push("checking today's search on the next tick");
    } else {
      const line = await checkTodaysJob(D, savedToday, when);
      if (line) parts.push(line);
    }
  }

  await writeSettings(D, writes);
  return parts.join("; ") || (morning ? "nothing new" : "waiting for 6am");
}

/** The tick's daily_find step (slot 7 of overview §8: after pick, before stale_jobs), within the tick's budget. */
export const dailyFindStep = {
  name: "daily_find",
  everyMinutes: 5,
  run: (ctx) => runDailyFind(ctx.DB, ctx.env, ctx.now, { budget: ctx.budget }),
};

/**
 * The lead_search light (pure), from the find heartbeat ({ok, last_at, detail} or null): grey before any automatic
 * search; red when the latest beat is older than 26 hours (or its time can't be read), or when it went wrong
 * (ok = 0); otherwise green with today's line. Staleness is checked first: a failure from days ago isn't "today's".
 */
export function leadSearchLight(beatRow, now = new Date()) {
  const name = "lead_search";
  if (!beatRow) return { name, level: "grey", detail: "No automatic search has run yet", fix: "" };
  const age = new Date(now).getTime() - Date.parse(beatRow.last_at ?? "");
  if (!(age <= LIGHT_STALE_HOURS * HOUR_MS)) {
    const hours = Number.isFinite(age) ? `${Math.floor(age / HOUR_MS)} hours` : `over ${LIGHT_STALE_HOURS} hours`;
    return { name, level: "red", detail: `The automatic lead search hasn't run for ${hours}`, fix: LIGHT_STALE_FIX };
  }
  const detail = String(beatRow.detail ?? "");
  if (!(beatRow.ok === true || Number(beatRow.ok) === 1)) {
    return { name, level: "red", detail: `Today's lead search went wrong: ${detail}`, fix: LIGHT_RED_FIX };
  }
  return { name, level: "green", detail, fix: "" };
}

// Registered once, when this module loads (tick.js imports it, and api/health.js imports tick.js): 1 D1 statement.
registerLight(async (DB, env, now) =>
  leadSearchLight(await DB.prepare("SELECT ok, last_at, detail FROM heartbeats WHERE name = 'find'").first(), now));

// ---------------------------------------------------------------- the tick step stale_jobs (Task 13)

export const STALE_MINUTES = 45; // the workflows time out after 30, so a healthy run never gets here
export const STALE_JOB_ERROR = "Stopped: no progress for 45 minutes. Press Find leads to try again.";
export const STALE_SCAN_ERROR = "Stopped: no progress for 45 minutes. Press Run scan to try again.";
// Runs stopped in one go; any more wait for the next run (15 minutes later). It keeps the JSON bound to one statement
// far below D1's 2 MB a value.
const STALE_MAX_ROWS = 200;
const STALE_JOB_DETAIL =
  "It made no progress for 45 minutes, so it was marked failed. Press Find leads to try again. If it happens twice, open GitHub → Actions → Scrape leads and look at the red run.";
const STALE_SCAN_DETAIL = "It made no progress for 45 minutes, so it was marked failed. Press Run scan to try again.";

// Searches and scans queued or running whose last sign of life is before the cutoff (?1). A search's is the newer of
// its jobs row and its job_progress row (the engine reports progress, and touches the job row only at the start and
// the end). Care scans (source 'care') are stage 11's: its care_scans light fails them with its own text.
const STALE_SQL = `SELECT 'job' AS kind, j.id, j.trade AS what, j.town FROM jobs j LEFT JOIN job_progress p ON p.job_id = j.id
    WHERE j.status IN ('queued','running') AND max(j.updated_at, COALESCE(p.updated_at, '')) < ?1
  UNION ALL
  SELECT 'scan', s.id, s.keyword, s.town FROM scans s
    WHERE s.status IN ('queued','running') AND s.updated_at < ?1 AND COALESCE(s.source, '') != 'care'
  LIMIT ${STALE_MAX_ROWS}`;
// The writes (one batch, so the runs and their todos are saved together or not at all). Each update checks again
// that the run is still stuck, so one that reported in after the look above is left alone. ?1 error, ?2 now,
// ?3 the ids (JSON), ?4 the cutoff.
const STALE_JOBS_SQL = `UPDATE jobs SET status = 'failed', error = ?1, updated_at = ?2
  WHERE id IN (SELECT value FROM json_each(?3)) AND status IN ('queued','running')
    AND max(updated_at, COALESCE((SELECT p.updated_at FROM job_progress p WHERE p.job_id = jobs.id), '')) < ?4`;
const STALE_SCANS_SQL = `UPDATE scans SET status = 'failed', error = ?1, updated_at = ?2
  WHERE id IN (SELECT value FROM json_each(?3)) AND status IN ('queued','running') AND updated_at < ?4
    AND COALESCE(source, '') != 'care'`;
// Every todo in one statement, with the columns addTodo writes (INSERT OR IGNORE on the dedupe, so one Nik dismissed
// stays dismissed). Only for a run the updates above just failed: failed with our error at this run's time (?2).
// ?1 the todos (JSON [{id, kind, ref, title, detail, link, dedupe}]), ?3 and ?4 the two errors.
const STALE_TODOS_SQL = `INSERT OR IGNORE INTO todos (id, kind, title, detail, link, status, dedupe, created_at)
  SELECT json_extract(t.value, '$.id'), 'health', json_extract(t.value, '$.title'), json_extract(t.value, '$.detail'),
    json_extract(t.value, '$.link'), 'open', json_extract(t.value, '$.dedupe'), ?2
  FROM json_each(?1) AS t
  WHERE CASE json_extract(t.value, '$.kind')
    WHEN 'job' THEN EXISTS (SELECT 1 FROM jobs WHERE id = json_extract(t.value, '$.ref') AND status = 'failed' AND error = ?3 AND updated_at = ?2)
    WHEN 'scan' THEN EXISTS (SELECT 1 FROM scans WHERE id = json_extract(t.value, '$.ref') AND status = 'failed' AND error = ?4 AND updated_at = ?2)
    ELSE 0 END`;

// The health todo for one stopped run (Part A "Todos added").
function staleTodo({ kind, id, what, town }) {
  const job = kind === "job";
  return {
    id: crypto.randomUUID(),
    kind,
    ref: id,
    title: job ? `Lead search stopped: ${what} in ${town}` : `Map Rank scan stopped: ${what} in ${town}`,
    detail: job ? STALE_JOB_DETAIL : STALE_SCAN_DETAIL,
    link: job ? SCRAPER_LINK : "/#/maprank",
    dedupe: `health:stale:${kind}:${id}`,
  };
}

/**
 * Stop the searches (jobs) and Map Rank scans that are queued or running with no progress for more than
 * STALE_MINUTES (45): status 'failed' with STALE_JOB_ERROR / STALE_SCAN_ERROR, and one health todo each
 * (health:stale:job:<id> / health:stale:scan:<id>). A search's progress is the newest of jobs.updated_at and
 * job_progress.updated_at. Care scans are never touched (stage 11 owns them). A stopped run isn't queued or running
 * any more, so running this again stops nothing twice. → {jobs, scans}: how many were stopped.
 * 1 D1 statement when nothing is stuck, at most 4 otherwise (the look, then one batch of up to 3).
 */
export async function markStale(DB, now = new Date()) {
  const when = new Date(now);
  const at = iso(when);
  const cutoff = iso(when.getTime() - STALE_MINUTES * 60_000);
  const { results: stuck } = await DB.prepare(STALE_SQL).bind(cutoff).all();
  if (!stuck.length) return { jobs: 0, scans: 0 };

  const ids = (kind) => stuck.filter((r) => r.kind === kind).map((r) => r.id);
  const writes = [];
  const jobIds = ids("job");
  const scanIds = ids("scan");
  if (jobIds.length) writes.push(["jobs", DB.prepare(STALE_JOBS_SQL).bind(STALE_JOB_ERROR, at, JSON.stringify(jobIds), cutoff)]);
  if (scanIds.length) writes.push(["scans", DB.prepare(STALE_SCANS_SQL).bind(STALE_SCAN_ERROR, at, JSON.stringify(scanIds), cutoff)]);
  const todos = DB.prepare(STALE_TODOS_SQL).bind(JSON.stringify(stuck.map(staleTodo)), at, STALE_JOB_ERROR, STALE_SCAN_ERROR);
  const results = await DB.batch([...writes.map(([, stmt]) => stmt), todos]);

  const stopped = { jobs: 0, scans: 0 };
  writes.forEach(([table], i) => {
    stopped[table] = Number(results[i]?.meta?.changes) || 0;
  });
  return stopped;
}

/** The tick's stale_jobs step (slot 8 of overview §8: right after daily_find, before calls). */
export const staleJobsStep = {
  name: "stale_jobs",
  everyMinutes: 15,
  run: (ctx) => markStale(ctx.DB, ctx.now).then((r) => `${r.jobs} searches, ${r.scans} scans stopped`),
};
