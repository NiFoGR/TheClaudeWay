// The tick step daily_find: the morning search decision, research queued after every finished search, today's job
// failing, and the lead_search light (02-find Task 12).
// Run: node --test control-room/tests/daily-find.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test, { beforeEach } from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import {
  DAILY_FIND_MAX, claimDay, dailyFindStep, leadSearchLight, loadTerritory, runDailyFind, saveTerritory,
} from "../functions/_lib/find.js";
import { healthFromDb } from "../functions/_lib/health.js";
import { beat, fireRoutine } from "../functions/_lib/routines.js";
import { getSetting, setSecret, setSetting } from "../functions/_lib/settings.js";
import { DEFAULT_TERRITORY, todayLine } from "../functions/_lib/territory.js";
import { STEPS, runTick } from "../functions/_lib/tick.js";
import { addTodo } from "../functions/_lib/todo.js";
import { db, iso } from "../functions/_lib/util.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

// The stubs: start records every workflow start and says GitHub started it; fire records every Routine fire.
const starts = [];
const fired = [];
const start = async (env, wf, inputs) => {
  starts.push([wf, inputs]);
  return "";
};
const fire = async (db, name, text) => {
  fired.push([name, text]);
  return { ok: true, status: 200 };
};
beforeEach(() => {
  starts.length = 0;
  fired.length = 0;
});

const count = async (DB, sql) => (await DB.prepare(sql).first()).n;
const row = (DB, sql) => DB.prepare(sql).first();
const today = async (DB) => JSON.parse(await getSetting(DB, "find:today"));
const T0 = "2026-10-01T00:00:00Z";

// Seeding (raw SQL through the D1 API).
async function lead(DB, place_id, extra = {}) {
  const r = { place_id, name: `Lead ${place_id}`, trade: "landscaper", search_town: "Warrington", excluded: 0,
    quality_score: 60, first_seen_at: T0, updated_at: T0, ...extra };
  const cols = Object.keys(r);
  await DB.prepare(`INSERT INTO leads (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...Object.values(r)).run();
}
const research = (DB, place_id, status, grade = null) =>
  DB.prepare("INSERT INTO research (place_id, status, grade, queued_at) VALUES (?, ?, ?, ?)").bind(place_id, status, grade, T0).run();
async function job(DB, id, { trade = "landscaper", town = "Widnes", status = "done", created_at = T0, updated_at } = {}) {
  await DB.prepare("INSERT INTO jobs (id, trade, town, max_results, status, created_at, updated_at) VALUES (?, ?, ?, 60, ?, ?, ?)")
    .bind(id, trade, town, status, created_at, updated_at ?? created_at).run();
}
const fireRow = (DB, at, http_status = 200) =>
  DB.prepare("INSERT INTO routine_fires (id, routine, reason, http_status, error, at) VALUES (?, 'research', 'x', ?, NULL, ?)")
    .bind(crypto.randomUUID(), http_status, at).run();
const findBeat = (DB) => row(DB, "SELECT ok, last_at, detail FROM heartbeats WHERE name = 'find'");

// ---------------------------------------------------------------- the spec's tests (Task 12, Step 1)

test("before 06:00 UK nothing is decided", async () => {
  const DB = fakeD1(); await runDailyFind(DB, {}, new Date("2026-10-19T04:59:00Z"), { start, fire });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM jobs"), 0);
  assert.equal(await getSetting(DB, "find:today"), null);
});

test("06:00 BST: searches the next town once, and moves the pointer", async () => {
  const DB = fakeD1();
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  await runDailyFind(DB, {}, new Date("2026-10-19T05:05:00Z"), { start, fire });
  assert.equal(starts.length, 1); assert.equal(starts[0][1].town, "Warrington");
  assert.equal((await loadTerritory(DB)).next, 1);
  assert.equal(JSON.parse(await getSetting(DB, "find:today")).town, "Warrington");
});

test("GMT after the clocks go back", async () => {
  const DB = fakeD1();
  await runDailyFind(DB, {}, new Date("2026-10-25T05:30:00Z"), { start, fire }); assert.equal(starts.length, 0);
  await runDailyFind(DB, {}, new Date("2026-10-25T06:00:00Z"), { start, fire }); assert.equal(starts.length, 1);
});

test("skips with 30 good leads waiting and says so", async () => {
  const DB = fakeD1();
  // seed 30 leads + research rows done grade 'A', not emailed
  for (let i = 0; i < 30; i++) {
    await lead(DB, `g${i}`);
    await research(DB, `g${i}`, "done", "A");
  }
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  assert.equal(starts.length, 0);
  assert.equal(todayLine(JSON.parse(await getSetting(DB, "find:today")), null, new Date("2026-10-19T09:00:00Z")), "Skipped: 30 good leads waiting");
});

test("a refused start adds a health todo and doesn't retry today", async () => {
  const DB = fakeD1();
  const refuse = async () => "GitHub refused to start the run (401): Bad credentials";
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start: refuse, fire });
  await runDailyFind(DB, {}, new Date("2026-10-19T05:05:00Z"), { start: refuse, fire });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'"), 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:2026-10-19' AND kind = 'health'"), 1);
});

test("every town recent → 'Add more towns' todo; a later search closes it", async () => {
  const DB = fakeD1();
  // jobs: one 'done' landscaper job per DEFAULT_TERRITORY town, created 2026-10-10T06:00:00Z
  for (const [i, town] of DEFAULT_TERRITORY.towns.entries()) await job(DB, `j${i}`, { town, created_at: "2026-10-10T06:00:00Z" });
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  assert.equal(starts.length, 0);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:towns' AND status = 'open'"), 1);
  await runDailyFind(DB, {}, new Date("2026-11-10T06:00:00Z"), { start, fire });   // 31 days later
  assert.equal(starts.length, 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:towns' AND status = 'open'"), 0);
});

test("a job finished since the last enqueue queues research at 14:00", async () => {
  const DB = fakeD1();
  // research:enqueued_at = 2026-10-19T05:00:00Z; jobs row done updated_at 2026-10-19T05:40:00Z; lead score 60
  await setSetting(DB, "research:enqueued_at", "2026-10-19T05:00:00Z");
  await job(DB, "j1", { created_at: "2026-10-19T05:00:00Z", updated_at: "2026-10-19T05:40:00Z" });
  await lead(DB, "a", { quality_score: 60, last_job_id: "j1" });
  await runDailyFind(DB, {}, new Date("2026-10-19T13:00:00Z"), { start, fire });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM research WHERE status = 'queued'"), 1);
});

test("today's automatic job failing adds a health todo", async () => {
  const DB = fakeD1();
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  const { job_id } = JSON.parse(await getSetting(DB, "find:today"));
  await DB.prepare("UPDATE jobs SET status = 'failed', error = 'Google refused the search.' WHERE id = ?").bind(job_id).run();
  await runDailyFind(DB, {}, new Date("2026-10-19T05:30:00Z"), { start, fire });
  assert.equal((await row(DB, `SELECT title FROM todos WHERE dedupe = 'health:find:failed:${job_id}'`)).title, "Today's lead search failed: Warrington");
});

test("tick order", () => {
  const names = STEPS.map((s) => s.name);
  assert.ok(names.indexOf("send") < names.indexOf("daily_find") && names.indexOf("daily_find") < names.indexOf("health"));
  // "pick" (stage 3) and "stale_jobs" (Task 13) don't exist yet; 04 Task 6 and Task 13's test assert their places.
});

test("lead_search light", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  assert.equal(leadSearchLight(null, now).level, "grey");
  assert.deepEqual(leadSearchLight({ ok: 1, last_at: "2026-10-19T05:00:00Z", detail: "Skipped: 34 good leads waiting" }, now),
    { name: "lead_search", level: "green", detail: "Skipped: 34 good leads waiting", fix: "" });
  assert.equal(leadSearchLight({ ok: 0, last_at: "2026-10-19T05:00:00Z", detail: "x" }, now).level, "red");
  assert.equal(leadSearchLight({ ok: 1, last_at: "2026-10-18T09:59:00Z", detail: "x" }, now).level, "red");   // 26 h 1 min
  assert.equal(leadSearchLight({ ok: 1, last_at: "2026-10-18T10:01:00Z", detail: "x" }, now).level, "green");
});

test("lead_search is registered with healthFromDb", async () => {
  const DB = fakeD1();
  await beat(DB, "find", false, "Couldn't start the search for Widnes: GitHub refused");
  const { lights } = await healthFromDb(DB, {}, new Date());
  assert.equal(lights.find((l) => l.name === "lead_search").level, "red");
});

// ---------------------------------------------------------------- claimDay

test("claimDay: compare-and-set on find:day, so only the first claim of a UK day wins", async () => {
  const DB = fakeD1();
  assert.equal(await claimDay(DB, "2026-10-19"), true);
  assert.equal(await claimDay(DB, "2026-10-19"), false);
  assert.equal(await getSetting(DB, "find:day"), "2026-10-19");
  assert.equal(await claimDay(DB, "2026-10-20"), true);
  assert.equal(await claimDay(DB, "2026-10-20"), false);
  assert.equal(await getSetting(DB, "find:day"), "2026-10-20");
});

test("two ticks in the same minute: the second starts nothing", async () => {
  const DB = fakeD1();
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:30Z"), { start, fire });
  assert.equal(starts.length, 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM jobs"), 1);
});

test("a day someone else claimed (find:day already today) is never decided again", async () => {
  const DB = fakeD1();
  await setSetting(DB, "find:day", "2026-10-19");
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  assert.equal(starts.length, 0);
  assert.equal(await getSetting(DB, "find:today"), null);
});

test("05:59 UK (BST) decides nothing; 06:00 decides; a tick at 23:00 still decides for that day", async () => {
  const DB = fakeD1();
  await runDailyFind(DB, {}, new Date("2026-10-19T04:59:59Z"), { start, fire });
  assert.equal(starts.length, 0);
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  assert.equal(starts.length, 1);
  await DB.prepare("UPDATE jobs SET status = 'done', updated_at = '2026-10-19T05:40:00Z'").run();
  // The tick was down all of the next day until 23:00 UK.
  await runDailyFind(DB, {}, new Date("2026-10-20T22:00:00Z"), { start, fire });
  assert.equal(starts.length, 2);
  assert.equal((await today(DB)).day, "2026-10-20");
  assert.equal(starts[1][1].town, "Widnes");
});

// ---------------------------------------------------------------- the decision, as saved

test("a search: find:today, the workflow inputs, the pointer, the beat and the summary", async () => {
  const DB = fakeD1();
  const now = new Date("2026-10-19T05:02:00Z");
  const out = await runDailyFind(DB, {}, now, { start, fire });
  assert.deepEqual(starts, [["scrape-leads.yml", { trade: "landscaper", town: "Warrington", max: "60", job_id: starts[0][1].job_id }]]);
  const saved = await today(DB);
  assert.deepEqual(saved, { day: "2026-10-19", at: "2026-10-19T05:02:00Z", search: true, town: "Warrington", job_id: starts[0][1].job_id });
  const jobRow = await row(DB, "SELECT * FROM jobs");
  assert.equal(jobRow.id, saved.job_id);
  assert.equal(jobRow.status, "queued");
  assert.equal(jobRow.created_at, "2026-10-19T05:02:00Z");
  assert.equal((await loadTerritory(DB)).next, 1);
  assert.deepEqual(await findBeat(DB), { ok: 1, last_at: "2026-10-19T05:02:00Z", detail: "Searching Warrington (started 06:02)" });
  assert.equal(typeof out, "string");
  assert.match(out, /searched Warrington/);
});

test("skips, in Part A's order, each saved with its reason and count and beaten ok", async () => {
  const now = new Date("2026-10-19T05:00:00Z");
  const later = new Date("2026-10-19T09:00:00Z");

  const off = fakeD1();
  await saveTerritory(off, { ...DEFAULT_TERRITORY, on: false });
  await runDailyFind(off, {}, now, { start, fire });
  assert.deepEqual(await today(off), { day: "2026-10-19", at: "2026-10-19T05:00:00Z", search: false, reason: "off" });
  assert.equal(todayLine(await today(off), null, later), "Off. Nothing is searched automatically");
  assert.deepEqual(await findBeat(off), { ok: 1, last_at: "2026-10-19T05:00:00Z", detail: "Off. Nothing is searched automatically" });

  const running = fakeD1();
  await job(running, "manual", { status: "running", created_at: "2026-10-19T04:50:00Z" });
  await runDailyFind(running, {}, now, { start, fire });
  assert.equal((await today(running)).reason, "running");
  assert.equal(todayLine(await today(running), null, later), "Skipped: a search was already running");

  const research41 = fakeD1();
  for (let i = 0; i < 41; i++) {
    await lead(research41, `q${i}`);
    await research(research41, `q${i}`, "queued");
  }
  await fireRow(research41, "2026-10-19T04:00:00Z"); // nothing new is queued this morning, so no fire either way
  await runDailyFind(research41, {}, now, { start, fire });
  assert.deepEqual(await today(research41), { day: "2026-10-19", at: "2026-10-19T05:00:00Z", search: false, reason: "research", n: 41 });
  assert.equal(todayLine(await today(research41), null, later), "Skipped: Claude has 41 leads to research first");

  assert.equal(starts.length, 0);
  assert.deepEqual(fired, []);
});

test("every town recent: the towns line, beaten ok, and the todo's exact words", async () => {
  const DB = fakeD1();
  for (const [i, town] of DEFAULT_TERRITORY.towns.entries()) await job(DB, `j${i}`, { town, created_at: "2026-10-10T06:00:00Z" });
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  assert.equal(todayLine(await today(DB), null, new Date("2026-10-19T09:00:00Z")),
    "Skipped: every town on your list was searched in the last 30 days. Add more towns");
  const t = await row(DB, "SELECT kind, title, detail, link, status FROM todos WHERE dedupe = 'health:find:towns'");
  assert.deepEqual(t, {
    kind: "health",
    title: "Add more towns to your automatic search",
    detail: "Every town on your list was searched in the last 30 days, so nothing new is being found. Add towns on the Lead Scraper page.",
    link: "/#/scraper",
    status: "open",
  });
  assert.equal((await findBeat(DB)).ok, 1);
});

test("a refused start: failed job, find:today.error, the todo's exact words, beat not ok, pointer kept for tomorrow", async () => {
  const DB = fakeD1();
  const refuse = async () => "GitHub refused to start the run (401): Bad credentials";
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start: refuse, fire });
  const saved = await today(DB);
  const failed = await row(DB, "SELECT * FROM jobs");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "GitHub refused to start the run (401): Bad credentials");
  assert.deepEqual(saved, { day: "2026-10-19", at: "2026-10-19T05:00:00Z", search: true, town: "Warrington", job_id: failed.id,
    error: "GitHub refused to start the run (401): Bad credentials" });
  const line = "Couldn't start the search for Warrington: GitHub refused to start the run (401): Bad credentials";
  assert.equal(todayLine(saved, failed, new Date("2026-10-19T09:00:00Z")), line);
  const t = await row(DB, "SELECT kind, title, detail, link FROM todos WHERE dedupe = 'health:find:2026-10-19'");
  assert.deepEqual(t, {
    kind: "health",
    title: "Today's lead search didn't start",
    detail: "GitHub refused to start the run (401): Bad credentials. Check GITHUB_TOKEN in Cloudflare (Pages → Settings → Variables and Secrets) is still valid, then press Find leads.",
    link: "/#/scraper",
  });
  assert.deepEqual(await findBeat(DB), { ok: 0, last_at: "2026-10-19T05:00:00Z", detail: line });
  // A refused start isn't "today's search failed" as well: that todo is for a run that started.
  await runDailyFind(DB, {}, new Date("2026-10-19T05:30:00Z"), { start: refuse, fire });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'health:find:failed:%'"), 0);
  // The pointer didn't move, and the failed run doesn't make Warrington recent: tomorrow tries it again.
  assert.equal((await loadTerritory(DB)).next, 0);
  await runDailyFind(DB, {}, new Date("2026-10-20T05:00:00Z"), { start, fire });
  assert.equal(starts[0][1].town, "Warrington");
  assert.equal((await loadTerritory(DB)).next, 1);
});

test("GitHub not connected (no GITHUB_TOKEN): no network, startWorkflow's own words everywhere", async () => {
  const DB = fakeD1();
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { fire });
  const message = "GitHub isn't connected yet (GITHUB_TOKEN / GITHUB_REPO not set).";
  assert.equal((await today(DB)).error, message);
  assert.equal((await row(DB, "SELECT detail FROM todos WHERE dedupe = 'health:find:2026-10-19'")).detail,
    `${message} Check GITHUB_TOKEN in Cloudflare (Pages → Settings → Variables and Secrets) is still valid, then press Find leads.`);
});

test("today's job failing: the todo's exact words, the beat goes red once, and nothing more is added", async () => {
  const DB = fakeD1();
  await runDailyFind(DB, {}, new Date("2026-10-19T05:02:00Z"), { start, fire });
  const { job_id } = await today(DB);
  await DB.prepare("UPDATE jobs SET status = 'failed', error = 'Google refused the search.' WHERE id = ?").bind(job_id).run();
  await runDailyFind(DB, {}, new Date("2026-10-19T05:30:00Z"), { start, fire });
  const t = await row(DB, `SELECT kind, title, detail, link FROM todos WHERE dedupe = 'health:find:failed:${job_id}'`);
  assert.deepEqual(t, {
    kind: "health",
    title: "Today's lead search failed: Warrington",
    detail: "Google refused the search. Press Find leads to try again.",
    link: "/#/scraper",
  });
  const line = "Searched Warrington at 06:02 — it failed: Google refused the search.";
  assert.deepEqual(await findBeat(DB), { ok: 0, last_at: "2026-10-19T05:30:00Z", detail: line });
  await runDailyFind(DB, {}, new Date("2026-10-19T05:35:00Z"), { start, fire });
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:failed:${job_id}'`), 1);
  assert.equal((await findBeat(DB)).last_at, "2026-10-19T05:30:00Z", "beaten once, when the todo was added");
  // A failed run with no error text still says something.
  const DB2 = fakeD1();
  await runDailyFind(DB2, {}, new Date("2026-10-19T05:02:00Z"), { start, fire });
  const second = (await today(DB2)).job_id;
  await DB2.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").bind(second).run();
  await runDailyFind(DB2, {}, new Date("2026-10-19T05:30:00Z"), { start, fire });
  assert.equal((await row(DB2, `SELECT detail FROM todos WHERE dedupe = 'health:find:failed:${second}'`)).detail,
    "No reason was recorded. Press Find leads to try again.");
});

test("today's job still running or done: no todo, no new beat", async () => {
  const DB = fakeD1();
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  const { job_id } = await today(DB);
  await DB.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").bind(job_id).run();
  await runDailyFind(DB, {}, new Date("2026-10-19T05:10:00Z"), { start, fire });
  await DB.prepare("UPDATE jobs SET status = 'done', found = 41, updated_at = '2026-10-19T05:40:00Z' WHERE id = ?").bind(job_id).run();
  await runDailyFind(DB, {}, new Date("2026-10-19T05:45:00Z"), { start, fire });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'health:find:%'"), 0);
  assert.equal((await findBeat(DB)).last_at, "2026-10-19T05:00:00Z");
});

test("a search that starts closes the 'Add more towns' todo, and only that one", async () => {
  const DB = fakeD1();
  await addTodo(DB, { kind: "health", title: "Add more towns to your automatic search", dedupe: "health:find:towns" });
  await addTodo(DB, { kind: "health", title: "Today's lead search didn't start", dedupe: "health:find:2026-10-18" });
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:towns' AND status = 'open'"), 0);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:2026-10-18' AND status = 'open'"), 1);
  // A refused start doesn't close it: nothing new is being found yet.
  const DB2 = fakeD1();
  await addTodo(DB2, { kind: "health", title: "Add more towns to your automatic search", dedupe: "health:find:towns" });
  await runDailyFind(DB2, {}, new Date("2026-10-19T05:00:00Z"), { start: async () => "GitHub refused to start the run (500): x", fire });
  assert.equal(await count(DB2, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:towns' AND status = 'open'"), 1);
});

test("a decision that throws after the claim: the day stays decided, and the page and the light say what went wrong", async () => {
  const DB = fakeD1();
  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  // The pipeline counts fail (a D1 fault), with a token in the message as a worst case.
  const broken = {
    prepare: (sql) => (/AS goodWaiting/.test(sql)
      ? { first: async () => { throw new Error(`D1_ERROR: network connection lost ${token}`); } }
      : DB.prepare(sql)),
    batch: (stmts) => DB.batch(stmts),
  };
  await assert.rejects(runDailyFind(broken, { GITHUB_TOKEN: token }, new Date("2026-10-19T05:00:00Z"), { start, fire }), /network connection lost/);
  assert.equal(await getSetting(DB, "find:day"), "2026-10-19");
  const saved = await today(DB);
  assert.equal(saved.search, false);
  const line = "Couldn't start today's search: something went wrong while deciding (D1_ERROR: network connection lost [hidden]). Press Find leads to search now";
  assert.equal(todayLine(saved, null, new Date("2026-10-19T09:00:00Z")), line);
  assert.deepEqual(await findBeat(DB), { ok: 0, last_at: "2026-10-19T05:00:00Z", detail: line });
  // No retry every 5 minutes: the next tick doesn't decide again.
  await runDailyFind(DB, {}, new Date("2026-10-19T05:05:00Z"), { start, fire });
  assert.equal(starts.length, 0);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM jobs"), 0);
});

test("a search started late that fails after midnight still gets its todo, before the next morning's decision", async () => {
  const DB = fakeD1();
  // The tick was down until 23:30 UK: the day's search starts then, and is stopped after midnight.
  await runDailyFind(DB, {}, new Date("2026-10-19T22:30:00Z"), { start, fire });
  const { job_id, day } = await today(DB);
  assert.equal(day, "2026-10-19");
  const why = "Stopped: no progress for 45 minutes. Press Find leads to try again.";
  await DB.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = '2026-10-19T23:20:00Z' WHERE id = ?").bind(why, job_id).run();
  await runDailyFind(DB, {}, new Date("2026-10-19T23:25:00Z"), { start, fire }); // 00:25 UK on the 20th
  assert.deepEqual(await row(DB, `SELECT title, detail FROM todos WHERE dedupe = 'health:find:failed:${job_id}'`), {
    title: "Today's lead search failed: Warrington",
    detail: why, // stale_jobs' error already says what to do: not "… try again. Press Find leads to try again."
  });
  // The line is the decision's own day's, never "Decided after 6am".
  assert.deepEqual(await findBeat(DB),
    { ok: 0, last_at: "2026-10-19T23:25:00Z", detail: `Searched Warrington at 23:30 — it failed: ${why}` });
  // A search from two days ago isn't checked any more.
  const old = fakeD1();
  await runDailyFind(old, {}, new Date("2026-10-17T05:00:00Z"), { start, fire });
  await old.prepare("UPDATE jobs SET status = 'failed', error = 'x'").run();
  await setSetting(old, "find:day", "2026-10-19");
  await runDailyFind(old, {}, new Date("2026-10-19T05:30:00Z"), { start, fire });
  assert.equal(await count(old, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'health:find:failed:%'"), 0);
});

test("a territory edit saved while GitHub starts the run is kept: the pointer move gives way", async () => {
  const DB = fakeD1();
  const edited = { on: true, trade: "roofer", towns: ["Leeds", "York"], next: 0, max: 100 };
  const slowStart = async (env, wf, inputs) => {
    starts.push([wf, inputs]);
    await saveTerritory(DB, edited); // Nik presses Save on the Lead Scraper page meanwhile
    return "";
  };
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start: slowStart, fire });
  assert.equal(starts[0][1].town, "Warrington");
  assert.deepEqual(await loadTerritory(DB), edited);
  // With no edit in between, a saved territory's pointer moves past the town searched.
  const DB2 = fakeD1();
  await saveTerritory(DB2, { ...DEFAULT_TERRITORY, towns: ["Widnes", "Runcorn"], next: 1 });
  await runDailyFind(DB2, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  assert.equal(starts[1][1].town, "Runcorn");
  assert.deepEqual(await loadTerritory(DB2), { ...DEFAULT_TERRITORY, towns: ["Widnes", "Runcorn"], next: 0 });
});

test("the settings write failing after the run started: find:today says it's searching, not that it couldn't start", async () => {
  const DB = fakeD1();
  const broken = {
    prepare: (sql) => (/json_each\(\?1\)/.test(sql)
      ? { bind: () => ({ run: async () => { throw new Error("D1_ERROR: network connection lost"); } }) }
      : DB.prepare(sql)),
    batch: (stmts) => DB.batch(stmts),
  };
  await assert.rejects(runDailyFind(broken, {}, new Date("2026-10-19T05:00:00Z"), { start, fire }), /network connection lost/);
  assert.equal(starts.length, 1);
  const saved = await today(DB);
  assert.deepEqual(saved, { day: "2026-10-19", at: "2026-10-19T05:00:00Z", search: true, town: "Warrington", job_id: starts[0][1].job_id });
  assert.equal((await row(DB, "SELECT status FROM jobs")).status, "queued");
  assert.deepEqual(await findBeat(DB), { ok: 1, last_at: "2026-10-19T05:00:00Z", detail: "Searching Warrington (started 06:00)" });
  // The day stays decided, and tomorrow's search goes on to the next town (Warrington is recent).
  await runDailyFind(DB, {}, new Date("2026-10-19T05:05:00Z"), { start, fire });
  assert.equal(starts.length, 1);
  await DB.prepare("UPDATE jobs SET status = 'done', found = 41, updated_at = '2026-10-19T05:40:00Z'").run();
  await runDailyFind(DB, {}, new Date("2026-10-20T05:00:00Z"), { start, fire });
  assert.equal(starts[1][1].town, "Widnes");
});

// ---------------------------------------------------------------- the research queue from the tick

test("the morning enqueue: once per UK day from 06:00, before the decision (so day one's queue pauses searching)", async () => {
  const DB = fakeD1();
  for (let i = 0; i < 45; i++) await lead(DB, `l${i}`, { quality_score: 50 });
  await runDailyFind(DB, {}, new Date("2026-10-19T04:59:00Z"), { start, fire });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM research"), 0, "nothing before 06:00 with no finished search");
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM research WHERE status = 'queued'"), 45);
  assert.equal(await getSetting(DB, "research:enqueued_at"), "2026-10-19T05:00:00Z");
  assert.deepEqual(fired, [["research", "research queued: 45 leads"]]);
  // The decision saw the new queue: 45 to research, so no search today.
  assert.equal(starts.length, 0);
  assert.deepEqual(await today(DB), { day: "2026-10-19", at: "2026-10-19T05:00:00Z", search: false, reason: "research", n: 45 });
  // A new lead later the same day isn't queued until a search finishes (or tomorrow morning).
  await lead(DB, "late", { quality_score: 50 });
  await runDailyFind(DB, {}, new Date("2026-10-19T08:00:00Z"), { start, fire });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM research WHERE place_id = 'late'"), 0);
  await runDailyFind(DB, {}, new Date("2026-10-20T05:00:00Z"), { start, fire });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM research WHERE place_id = 'late'"), 1);
  assert.equal(await getSetting(DB, "research:enqueued_at"), "2026-10-20T05:00:00Z");
});

test("a finished search queues research before 06:00 too; an older one doesn't trigger it again", async () => {
  const DB = fakeD1();
  await setSetting(DB, "research:enqueued_at", "2026-10-18T05:00:00Z");
  await job(DB, "old", { created_at: "2026-10-18T04:00:00Z", updated_at: "2026-10-18T04:40:00Z" });
  await lead(DB, "a");
  await runDailyFind(DB, {}, new Date("2026-10-19T03:00:00Z"), { start, fire });   // 04:00 UK
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM research"), 0, "the done job is older than the last enqueue");
  await job(DB, "night", { created_at: "2026-10-19T02:00:00Z", updated_at: "2026-10-19T02:40:00Z" });
  await runDailyFind(DB, {}, new Date("2026-10-19T03:05:00Z"), { start, fire });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM research WHERE status = 'queued'"), 1);
  assert.equal(await getSetting(DB, "research:enqueued_at"), "2026-10-19T03:05:00Z");
  assert.equal(starts.length, 0, "still before 06:00: no decision");
  assert.equal(await getSetting(DB, "find:today"), null);
});

test("the research Routine is fired after an enqueue only when nothing was fired in the last 30 minutes", async () => {
  const DB = fakeD1();
  await lead(DB, "a");
  await fireRow(DB, "2026-10-19T04:45:00Z", 500); // a failed attempt 15 minutes ago still counts
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM research WHERE status = 'queued'"), 1);
  assert.deepEqual(fired, []);
});

test("every search that queues a lead fires the research Routine (overview §7), at most once per 30 minutes", async () => {
  const DB = fakeD1();
  await connectResearch(DB);
  for (let i = 0; i < 10; i++) {
    await lead(DB, `q${i}`);
    await research(DB, `q${i}`, "queued");
  }
  // 06:00 BST: nothing new to queue, so no fire (the Routine's own 06:47 schedule takes the 10 waiting); the search starts.
  assert.equal(await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire: realFireOk }), "queued 0; searched Warrington");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM routine_fires"), 0);
  // The automatic search is done at 06:40 with 5 new leads: fired.
  const { job_id } = await today(DB);
  await DB.prepare("UPDATE jobs SET status = 'done', found = 5, updated_at = '2026-10-19T05:40:00Z' WHERE id = ?").bind(job_id).run();
  for (let i = 0; i < 5; i++) await lead(DB, `w${i}`, { last_job_id: job_id });
  assert.equal(await runDailyFind(DB, {}, new Date("2026-10-19T05:45:00Z"), { start, fire: realFireOk }), "queued 5; fired research");
  // Nik's own search, done at 11:30 with 1 new lead: fired again, hours before the next morning.
  await job(DB, "nik", { created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:30:00Z" });
  await lead(DB, "n1", { last_job_id: "nik" });
  assert.equal(await runDailyFind(DB, {}, new Date("2026-10-19T10:35:00Z"), { start, fire: realFireOk }), "queued 1; fired research");
  // Another one done 10 minutes after that: queued, but the fire 10 minutes ago is recent.
  await job(DB, "nik2", { created_at: "2026-10-19T10:20:00Z", updated_at: "2026-10-19T10:40:00Z" });
  await lead(DB, "n2", { last_job_id: "nik2" });
  assert.equal(await runDailyFind(DB, {}, new Date("2026-10-19T10:45:00Z"), { start, fire: realFireOk }), "queued 1");
  assert.deepEqual((await DB.prepare("SELECT reason, at FROM routine_fires ORDER BY at").all()).results, [
    { reason: "research queued: 15 leads", at: "2026-10-19T05:45:00Z" },
    { reason: "research queued: 16 leads", at: "2026-10-19T10:35:00Z" },
  ]);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM research WHERE status = 'queued'"), 17);
});

test("a research row file 11's purge leaves (skipped, no data, no dates) keeps the lead out of the queue for good", async () => {
  const DB = fakeD1();
  await lead(DB, "old1", { email: "dave@davesgardens.co.uk" });
  await lead(DB, "old2");
  // What the purge leaves of a non-client 12 months after last contact: prospects and messages gone, research blanked.
  for (const id of ["old1", "old2"]) {
    await DB.prepare(`INSERT INTO research (place_id, status, grade, points, grade_reason, angle, opener, owner, best_email,
      best_email_why, emails, copy, site_review, searched, too_big, notes, queued_at, researched_at)
      VALUES (?, 'skipped', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
        'Skipped: details deleted 12 months after last contact.', NULL, NULL)`).bind(id).run();
  }
  await setSetting(DB, "research:enqueued_at", "2027-12-01T06:05:00Z");
  const out = await runDailyFind(DB, {}, new Date("2027-12-02T06:05:00Z"), { start, fire }); // 06:05 UK (GMT)
  assert.match(out, /^queued 0(;|$)/);
  assert.deepEqual(fired, []);
  assert.deepEqual((await DB.prepare("SELECT place_id, status, queued_at FROM research ORDER BY place_id").all()).results, [
    { place_id: "old1", status: "skipped", queued_at: null },
    { place_id: "old2", status: "skipped", queued_at: null },
  ]);
});

// ---------------------------------------------------------------- the D1 budget (at most 14 statements a run)

// A research Routine that is connected, so the real fireRoutine reads its URL, token and 429 hold, and logs the fire.
async function connectResearch(DB) {
  await setSecret(DB, "routine:research:url", "https://api.anthropic.com/v1/claude_code/routines/trig_abc123/fire");
  await setSecret(DB, "routine:research:token", "sk-ant-oat01-test-token");
}
// The real fireRoutine, answered with a 429 (its dearest path: 5 statements).
const realFire429 = (DB, name, text, opts) =>
  fireRoutine(DB, name, text, { ...opts, fetchImpl: async () => ({ status: 429, headers: { "retry-after": "60" } }) });
const realFireOk = (DB, name, text, opts) =>
  fireRoutine(DB, name, text, { ...opts, fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });

test("D1 budget: an enqueue, a recent fire, a search that starts and a todo to close: at most 14 statements", async () => {
  const DB = fakeD1();
  for (let i = 0; i < 5; i++) await lead(DB, `l${i}`);
  await DB.prepare("INSERT INTO suppression (value, kind, reason, created_at) VALUES ('x@y.co.uk', 'email', 'opted out', ?)").bind(T0).run();
  await fireRow(DB, "2026-10-19T04:45:00Z");
  await addTodo(DB, { kind: "health", title: "Add more towns to your automatic search", dedupe: "health:find:towns" });
  const c = countingDB(DB);
  await runDailyFind(c.DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire: realFireOk });
  assert.equal(starts.length, 1);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM research WHERE status = 'queued'"), 5);
  assert.ok(c.used() <= DAILY_FIND_MAX, String(c.used()));
  assert.equal(DAILY_FIND_MAX, 14);
});

test("D1 budget: an enqueue and a refused start: at most 14 statements", async () => {
  const DB = fakeD1();
  for (let i = 0; i < 5; i++) await lead(DB, `l${i}`);
  await DB.prepare("INSERT INTO suppression (value, kind, reason, created_at) VALUES ('x@y.co.uk', 'email', 'opted out', ?)").bind(T0).run();
  await fireRow(DB, "2026-10-19T04:45:00Z");
  const c = countingDB(DB);
  await runDailyFind(c.DB, {}, new Date("2026-10-19T05:00:00Z"), { start: async () => "GitHub refused to start the run (401): x", fire: realFireOk });
  assert.equal((await today(DB)).error, "GitHub refused to start the run (401): x");
  assert.ok(c.used() <= DAILY_FIND_MAX, String(c.used()));
});

test("D1 budget: a real Routine fire leaves the decision to the next tick, and both stay within 14", async () => {
  const DB = fakeD1();
  await connectResearch(DB);
  for (let i = 0; i < 5; i++) await lead(DB, `l${i}`);
  const first = countingDB(DB);
  const out = await runDailyFind(first.DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire: realFire429 });
  assert.ok(first.used() <= DAILY_FIND_MAX, String(first.used()));
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM routine_fires WHERE routine = 'research'"), 1);
  assert.equal(await getSetting(DB, "find:today"), null, "decided on the next tick");
  assert.equal(await getSetting(DB, "find:day"), null, "the day isn't claimed until it's decided");
  assert.match(out, /next tick/);
  const second = countingDB(DB);
  await runDailyFind(second.DB, {}, new Date("2026-10-19T05:05:00Z"), { start, fire: realFire429 });
  assert.ok(second.used() <= DAILY_FIND_MAX, String(second.used()));
  assert.equal(starts.length, 1);
  assert.equal((await today(DB)).town, "Warrington");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM routine_fires WHERE routine = 'research'"), 1, "not fired again");
});

test("D1 budget: today's job failed, a search finished since the last enqueue and a real fire: at most 14", async () => {
  const DB = fakeD1();
  await connectResearch(DB);
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  const { job_id } = await today(DB);
  await DB.prepare("UPDATE jobs SET status = 'failed', error = 'Google refused the search.', updated_at = '2026-10-19T05:20:00Z' WHERE id = ?").bind(job_id).run();
  await job(DB, "manual", { created_at: "2026-10-19T05:10:00Z", updated_at: "2026-10-19T05:25:00Z" });
  for (let i = 0; i < 5; i++) await lead(DB, `l${i}`, { last_job_id: "manual" });
  const c = countingDB(DB);
  await runDailyFind(c.DB, {}, new Date("2026-10-19T05:30:00Z"), { start, fire: realFire429 });
  assert.ok(c.used() <= DAILY_FIND_MAX, String(c.used()));
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM research WHERE status = 'queued'"), 5);
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:failed:${job_id}'`), 1);
});

// A D1 that refuses statement 51 onwards, as the free plan does. Each first/all/run/raw is one statement and each
// statement in a batch is one, as countingDB counts them; a refused one is recorded (its SQL, shortened).
function d1Limit(DB, limit = 50) {
  let used = 0;
  const refused = [];
  const originals = new WeakMap();
  const take = (sql) => {
    used++;
    if (used > limit) {
      refused.push(String(sql).replace(/\s+/g, " ").slice(0, 80));
      throw new Error("D1_ERROR: Too many API requests by single worker invocation.");
    }
  };
  const wrap = (stmt, sql) => {
    const w = {
      get statement() {
        return stmt.statement;
      },
      get params() {
        return stmt.params;
      },
      bind: (...v) => wrap(stmt.bind(...v), sql),
      first: async (...a) => (take(sql), stmt.first(...a)),
      all: async (...a) => (take(sql), stmt.all(...a)),
      run: async (...a) => (take(sql), stmt.run(...a)),
      raw: async (...a) => (take(sql), stmt.raw(...a)),
    };
    originals.set(w, stmt);
    return w;
  };
  return {
    DB: {
      prepare: (sql) => wrap(DB.prepare(sql), sql),
      batch: async (stmts) => {
        for (const s of stmts) take(s.statement);
        return DB.batch(stmts.map((s) => originals.get(s) ?? s));
      },
    },
    refused,
  };
}

// GitHub (starts, or refuses with 401) and Claude (always a 429: fireRoutine's dearest path, 5 statements), for the
// real startWorkflow and fireRoutine the tick step uses.
async function withFetch({ githubRefuses = false } = {}, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://api.github.com/")) {
      return githubRefuses ? new Response("Bad credentials", { status: 401 }) : new Response(null, { status: 204 });
    }
    return new Response(null, { status: 429, headers: { "retry-after": "60" } });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("D1 budget in a real tick: daily_find reads ctx.budget, so a tick with 10–14 queries left never goes over 50", async () => {
  await db({ DB: fakeD1() }); // the isolate's schema check, done once, so each tick below counts only its own queries
  const DAY = "2026-10-19";
  const MORNING = new Date("2026-10-19T05:00:30Z"); // 06:00 BST
  const AFTERNOON = new Date("2026-10-19T13:00:30Z");
  const env = (DB) => ({ DB, GITHUB_TOKEN: "ghp_testtoken0123456789abcdefABCDEF", GITHUB_REPO: "NiFoGR/TheClaudeWay" });
  const cases = [
    { name: "morning: new leads queued and a real fire", now: MORNING, queued: 5, seed: async (DB) => {
      await connectResearch(DB);
      for (let i = 0; i < 5; i++) await lead(DB, `l${i}`);
    } },
    { name: "morning: an empty queue", now: MORNING, queued: 0, seed: async () => {} },
    { name: "morning: a recent fire", now: MORNING, queued: 5, seed: async (DB) => {
      await connectResearch(DB);
      for (let i = 0; i < 5; i++) await lead(DB, `l${i}`);
      await fireRow(DB, "2026-10-19T04:45:00Z");
    } },
    { name: "morning: GitHub refuses the start", now: MORNING, queued: 5, githubRefuses: true, seed: async (DB) => {
      await connectResearch(DB);
      for (let i = 0; i < 5; i++) await lead(DB, `l${i}`);
      await fireRow(DB, "2026-10-19T04:45:00Z");
    } },
    { name: "daytime: a search finished since the last enqueue, and today's search failed", now: AFTERNOON, queued: 5,
      seed: async (DB) => {
        await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire }); // this morning's decision
        const { job_id } = await today(DB);
        await DB.prepare("UPDATE jobs SET status = 'failed', error = 'Google refused the search.', updated_at = '2026-10-19T05:20:00Z' WHERE id = ?").bind(job_id).run();
        await job(DB, "manual", { created_at: "2026-10-19T12:00:00Z", updated_at: "2026-10-19T12:40:00Z" });
        await connectResearch(DB);
        for (let i = 0; i < 5; i++) await lead(DB, `l${i}`, { last_job_id: "manual" });
      } },
  ];

  for (const c of cases) {
    for (const left of [10, 11, 12, 13, 14]) {
      const label = `${c.name}, ${left} left`;
      const raw = fakeD1();
      await c.seed(raw);
      const dayBefore = await getSetting(raw, "find:day");
      const limited = d1Limit(raw);
      // An earlier step (inbound, say) leaves exactly `left` queries; then the real daily_find step runs.
      const earlier = { name: "inbound", everyMinutes: 0, run: async (ctx) => {
        while (ctx.budget.left() > left) await ctx.DB.prepare("SELECT 1 AS x").first();
        return `left ${ctx.budget.left()}`;
      } };
      let used = null;
      const measured = { ...dailyFindStep, run: async (ctx) => {
        const before = ctx.budget.left();
        assert.equal(before, left, label);
        try {
          return await dailyFindStep.run(ctx);
        } finally {
          used = before - ctx.budget.left();
        }
      } };
      const out = await withFetch(c, () => runTick(env(limited.DB), "cron", c.now, { steps: [earlier, measured] }));

      assert.deepEqual(limited.refused, [], `${label}: a statement was refused`);
      assert.ok(used <= left - 1, `${label}: daily_find used ${used}`);
      const summary = out.steps.daily_find;
      assert.equal(typeof summary, "string", `${label}: ${JSON.stringify(summary)}`);
      assert.equal((await row(raw, "SELECT last_at FROM heartbeats WHERE name = 'tick'"))?.last_at, iso(c.now), `${label}: tick beat`);
      const findDay = await getSetting(raw, "find:day");
      if (findDay === DAY) {
        assert.equal((await today(raw))?.day, DAY, `${label}: find:today`);
        const fb = await findBeat(raw);
        assert.ok(fb, `${label}: find beat`);
        if (dayBefore !== DAY) assert.equal(fb.last_at, iso(c.now), `${label}: find beat`);
      } else {
        assert.equal(findDay, dayBefore, `${label}: find:day`);
        assert.match(summary, /deciding on the next tick/, label);
      }

      // Nothing is lost: the next ticks, 5 and 10 minutes later with the whole budget, do whatever was left (a real
      // fire on one tick leaves the decision to the one after it).
      for (const minutes of [5, 10]) {
        const next = d1Limit(raw);
        const later = new Date(c.now.getTime() + minutes * 60_000);
        await withFetch(c, () => runTick(env(next.DB), "cron", later, { steps: [dailyFindStep] }));
        assert.deepEqual(next.refused, [], `${label}: the tick ${minutes} minutes later`);
      }
      assert.equal((await today(raw))?.day, DAY, `${label}: decided by the next ticks`);
      assert.equal(await count(raw, "SELECT COUNT(*) AS n FROM research WHERE status = 'queued'"), c.queued, `${label}: queued`);
      assert.ok(await findBeat(raw), `${label}: find beat after the next tick`);
    }
  }
});

test("D1 budget: daily_find keeps one query back for the tick's beat, and with less room it waits", async () => {
  const leads = async (DB) => {
    await connectResearch(DB);
    for (let i = 0; i < 5; i++) await lead(DB, `l${i}`);
  };
  // 10 left (the least the tick starts a step with): nothing fits, so nothing is claimed or written.
  const tight = fakeD1();
  await leads(tight);
  const c1 = countingDB(tight);
  const out1 = await runDailyFind(c1.DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire: realFire429, budget: { left: () => 10 } });
  assert.equal(c1.used(), 1, "the settings read only");
  assert.equal(out1, "research queue on the next tick; deciding on the next tick");
  assert.equal(await getSetting(tight, "find:day"), null);
  assert.equal(await getSetting(tight, "research:enqueued_at"), null);
  assert.equal(await count(tight, "SELECT COUNT(*) AS n FROM research"), 0);
  // 12 left: the queue and the fire (10 at most) fit in 11, the decision waits for the next tick.
  const roomy = fakeD1();
  await leads(roomy);
  const c2 = countingDB(roomy);
  const out2 = await runDailyFind(c2.DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire: realFire429, budget: { left: () => 12 } });
  assert.ok(c2.used() <= 11, String(c2.used()));
  assert.match(out2, /^queued 5; research fire failed; deciding on the next tick$/);
  assert.equal(await getSetting(roomy, "find:day"), null);
  assert.equal(await getSetting(roomy, "research:enqueued_at"), "2026-10-19T05:00:00Z");
  // No budget given (a direct call): DAILY_FIND_MAX is the cap, as before.
  const free = fakeD1();
  await leads(free);
  const c3 = countingDB(free);
  await runDailyFind(c3.DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire: realFire429 });
  assert.ok(c3.used() <= DAILY_FIND_MAX, String(c3.used()));
  // A budget bigger than DAILY_FIND_MAX doesn't raise the cap.
  const big = fakeD1();
  await leads(big);
  const c4 = countingDB(big);
  await runDailyFind(c4.DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire: realFire429, budget: { left: () => 50 } });
  assert.ok(c4.used() <= DAILY_FIND_MAX, String(c4.used()));
  assert.equal(await getSetting(big, "find:day"), null, "the fire left no room for the decision within 14");
});

test("D1 budget: today's failed search is checked only when its todo and beat fit", async () => {
  const DB = fakeD1();
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  const { job_id } = await today(DB);
  await DB.prepare("UPDATE jobs SET status = 'failed', error = 'Google refused the search.' WHERE id = ?").bind(job_id).run();
  const c = countingDB(DB);
  // 3 left → 2 to use: the read, then no room for the job's read, todo and beat.
  const out = await runDailyFind(c.DB, {}, new Date("2026-10-19T05:30:00Z"), { start, fire, budget: { left: () => 3 } });
  assert.equal(c.used(), 1);
  assert.equal(out, "checking today's search on the next tick");
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:failed:${job_id}'`), 0);
  // 4 left → 3: the read, the job's read, the todo and the beat (4) don't fit either; 5 left → 4 do.
  await runDailyFind(DB, {}, new Date("2026-10-19T05:35:00Z"), { start, fire, budget: { left: () => 4 } });
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:failed:${job_id}'`), 0);
  const c2 = countingDB(DB);
  assert.equal(await runDailyFind(c2.DB, {}, new Date("2026-10-19T05:40:00Z"), { start, fire, budget: { left: () => 5 } }), "today's search failed");
  assert.equal(c2.used(), 4);
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:failed:${job_id}'`), 1);
});

test("D1 budget: a quiet tick (decided, nothing new) costs 2 statements", async () => {
  const DB = fakeD1();
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  const c = countingDB(DB);
  await runDailyFind(c.DB, {}, new Date("2026-10-19T05:05:00Z"), { start, fire });
  assert.equal(c.used(), 2); // the settings read, and today's job
  const before = countingDB(fakeD1());
  await runDailyFind(before.DB, {}, new Date("2026-10-19T04:00:00Z"), { start, fire });
  assert.equal(before.used(), 1); // before 06:00 with nothing finished: the settings read only
});

// ---------------------------------------------------------------- the light and the step

test("lead_search light: Part A's words", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  assert.deepEqual(leadSearchLight(null, now), { name: "lead_search", level: "grey", detail: "No automatic search has run yet", fix: "" });
  assert.deepEqual(leadSearchLight({ ok: 0, last_at: "2026-10-19T05:00:00Z", detail: "Couldn't start the search for Widnes: x" }, now), {
    name: "lead_search",
    level: "red",
    detail: "Today's lead search went wrong: Couldn't start the search for Widnes: x",
    fix: "Open the Lead Scraper page and press Find leads. If it fails again, check GITHUB_TOKEN in Cloudflare (Pages → Settings → Variables and Secrets) is still valid.",
  });
  assert.deepEqual(leadSearchLight({ ok: 1, last_at: "2026-10-18T09:59:00Z", detail: "x" }, now), {
    name: "lead_search",
    level: "red",
    detail: "The automatic lead search hasn't run for 26 hours",
    fix: "The daily search runs from the tick: check the tick light. If that is green, press Find leads on the Lead Scraper page.",
  });
  assert.equal(leadSearchLight({ ok: 1, last_at: "2026-10-16T12:00:00Z", detail: "x" }, now).detail, "The automatic lead search hasn't run for 72 hours");
  // A failure from days ago isn't "today's": the light says it hasn't run.
  assert.equal(leadSearchLight({ ok: 0, last_at: "2026-10-16T12:00:00Z", detail: "x" }, now).detail, "The automatic lead search hasn't run for 72 hours");
  // A time that can't be read is never taken as fresh.
  assert.equal(leadSearchLight({ ok: 1, last_at: "soon", detail: "x" }, now).level, "red");
});

test("lead_search: one light, after stage 0's 10, grey before any decision and green from the decision's beat", async () => {
  const DB = fakeD1();
  const lightOf = async (now) => {
    const { lights } = await healthFromDb(DB, {}, now);
    const mine = lights.filter((l) => l.name === "lead_search");
    assert.equal(mine.length, 1);
    assert.ok(lights.indexOf(mine[0]) >= 10);
    return mine[0];
  };
  assert.equal((await lightOf(new Date("2026-10-19T04:00:00Z"))).level, "grey");
  await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
  assert.deepEqual(await lightOf(new Date("2026-10-19T09:00:00Z")),
    { name: "lead_search", level: "green", detail: "Searching Warrington (started 06:00)", fix: "" });
});

test("GET /api/health shows lead_search in an isolate that loaded nothing else (the import chain registers it)", () => {
  // A fresh node process importing only the route, like a /api/health call that is the isolate's first request.
  const url = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  const code = `
    import { onRequestGet } from ${url("../functions/api/health.js")};
    import { beat } from ${url("../functions/_lib/routines.js")};
    import { fakeD1 } from ${url("./helpers/fakeD1.mjs")};
    const DB = fakeD1();
    await beat(DB, "find", false, "Couldn't start the search for Widnes: GitHub refused");
    const body = await (await onRequestGet({ env: { DB } })).json();
    console.log(JSON.stringify(body.lights.filter((l) => l.name === "lead_search")));`;
  const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { encoding: "utf8" });
  const lights = JSON.parse(out.trim().split("\n").pop());
  assert.equal(lights.length, 1);
  assert.equal(lights[0].level, "red");
  assert.equal(lights[0].detail, "Today's lead search went wrong: Couldn't start the search for Widnes: GitHub refused");
});

test("STEPS: daily_find every 5 minutes, between send and health, running runDailyFind with the tick's DB, env and now", async () => {
  const entry = STEPS.find((s) => s.name === "daily_find");
  assert.equal(entry, dailyFindStep);
  assert.equal(entry.everyMinutes, 5);
  const DB = fakeD1();
  const out = await entry.run({ DB, env: { DB }, now: new Date("2026-10-19T05:00:00Z"), reason: "cron", results: {}, budget: { left: () => 50 } });
  assert.equal(typeof out, "string");
  // No GITHUB_TOKEN in env: startWorkflow's own refusal, and no network call.
  assert.equal((await today(DB)).error, "GitHub isn't connected yet (GITHUB_TOKEN / GITHUB_REPO not set).");
});
