// The tick step stale_jobs: searches and Map Rank scans with no progress for 45 minutes are marked failed, once, each
// with one health todo; care scans are stage 11's (02-find Task 13, Part A "Stale runs").
// Run: node --test control-room/tests/stale-jobs.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import {
  STALE_JOB_ERROR, STALE_MINUTES, STALE_SCAN_ERROR, markStale, staleJobsStep,
} from "../functions/_lib/find.js";
import { STEPS, runTick } from "../functions/_lib/tick.js";
import { db } from "../functions/_lib/util.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

// db() checks the schema once per isolate; do it now, so the runTick test below counts only the tick's own queries.
await db({ DB: fakeD1() });

const count = async (DB, sql) => (await DB.prepare(sql).first()).n;
const row = (DB, sql) => DB.prepare(sql).first();
const T0 = "2026-10-19T06:00:00Z";
const NOW = new Date("2026-10-19T12:00:00Z");
// The time `minutes` before NOW, as stored (UTC, no milliseconds).
const ago = (minutes, now = NOW) => new Date(now.getTime() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

// Seeding (raw SQL through the D1 API).
async function job(DB, id, status, updated_at, { trade = "landscaper", town = "Leigh", created_at = T0 } = {}) {
  await DB.prepare("INSERT INTO jobs (id, trade, town, max_results, status, created_at, updated_at) VALUES (?, ?, ?, 60, ?, ?, ?)")
    .bind(id, trade, town, status, created_at, updated_at).run();
}
const progress = (DB, job_id, updated_at) =>
  DB.prepare("INSERT INTO job_progress (job_id, stage, done, total, scouted, updated_at) VALUES (?, 'audit', 3, 60, 60, ?)")
    .bind(job_id, updated_at).run();
async function scan(DB, id, status, updated_at, { source = "manual", keyword = "landscaper", town = "Wigan" } = {}) {
  await DB.prepare(`INSERT INTO scans (id, keyword, town, grid, spacing_m, source, status, created_at, updated_at)
    VALUES (?, ?, ?, 5, 1000, ?, ?, ?, ?)`).bind(id, keyword, town, source, status, T0, updated_at).run();
}

// ---------------------------------------------------------------- the spec's tests (Task 13, Step 1)

test("marks runs with no progress for 45 minutes as failed, once", async () => {
  const DB = fakeD1(); const now = new Date("2026-10-19T12:00:00Z");
  // jobs: old (running, updated 11:14) → failed; alive (running, jobs.updated 10:00, job_progress.updated 11:50) → untouched;
  // fresh (queued, updated 11:16) → untouched; finished (done, updated 08:00) → untouched
  // scans: s1 (running, updated 11:10) → failed; c1 (running, source 'care', updated 09:00) → untouched
  await job(DB, "old", "running", "2026-10-19T11:14:00Z", { trade: "landscaper", town: "Leigh" });
  await job(DB, "alive", "running", "2026-10-19T10:00:00Z");
  await progress(DB, "alive", "2026-10-19T11:50:00Z");
  await job(DB, "fresh", "queued", "2026-10-19T11:16:00Z");
  await job(DB, "finished", "done", "2026-10-19T08:00:00Z");
  await scan(DB, "s1", "running", "2026-10-19T11:10:00Z");
  await scan(DB, "c1", "running", "2026-10-19T09:00:00Z", { source: "care" });
  assert.deepEqual(await markStale(DB, now), { jobs: 1, scans: 1 });
  assert.equal((await row(DB, "SELECT status FROM scans WHERE id = 'c1'")).status, "running");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:stale:scan:c1'"), 0);
  assert.equal((await row(DB, "SELECT status, error FROM jobs WHERE id = 'old'")).error, STALE_JOB_ERROR);
  assert.equal((await row(DB, "SELECT error FROM scans WHERE id = 's1'")).error, STALE_SCAN_ERROR);
  assert.deepEqual(await markStale(DB, now), { jobs: 0, scans: 0 });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:stale:job:old'"), 1);
  assert.equal((await row(DB, "SELECT title FROM todos WHERE dedupe = 'health:stale:job:old'")).title, "Lead search stopped: landscaper in Leigh");

  // The rest of that picture: the old job is failed, the others are as they were, and only the two todos exist.
  const jobs = Object.fromEntries((await DB.prepare("SELECT id, status FROM jobs").all()).results.map((r) => [r.id, r.status]));
  assert.deepEqual(jobs, { old: "failed", alive: "running", fresh: "queued", finished: "done" });
  assert.equal((await row(DB, "SELECT status FROM scans WHERE id = 's1'")).status, "failed");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos"), 2);
});

test("tick order: stale_jobs right after daily_find", () => {   // moved here from Task 12's "tick order" test
  const names = STEPS.map((s) => s.name);
  assert.ok(names.indexOf("daily_find") >= 0 && names.indexOf("daily_find") < names.indexOf("stale_jobs"));
  assert.ok(names.indexOf("stale_jobs") < names.indexOf("health"));
});

// ---------------------------------------------------------------- more (Review Focus 4: alive or dead)

test("STALE_MINUTES is 45 and the errors are Part A's, word for word", () => {
  assert.equal(STALE_MINUTES, 45);
  assert.equal(STALE_JOB_ERROR, "Stopped: no progress for 45 minutes. Press Find leads to try again.");
  assert.equal(STALE_SCAN_ERROR, "Stopped: no progress for 45 minutes. Press Run scan to try again.");
});

test("queued for 46 minutes is stopped; 44 minutes, or exactly 45, is not", async () => {
  const DB = fakeD1();
  await job(DB, "q46", "queued", ago(46));
  await job(DB, "q45", "queued", ago(45));
  await job(DB, "q44", "queued", ago(44));
  await scan(DB, "s46", "queued", ago(46));
  await scan(DB, "s45", "running", ago(45));
  await scan(DB, "s44", "running", ago(44));
  assert.deepEqual(await markStale(DB, NOW), { jobs: 1, scans: 1 });
  const statuses = async (table) =>
    Object.fromEntries((await DB.prepare(`SELECT id, status FROM ${table}`).all()).results.map((r) => [r.id, r.status]));
  assert.deepEqual(await statuses("jobs"), { q46: "failed", q45: "queued", q44: "queued" });
  assert.deepEqual(await statuses("scans"), { s46: "failed", s45: "running", s44: "running" });
});

test("a search counts as alive while either its job row or its progress row is fresh", async () => {
  const DB = fakeD1();
  await job(DB, "progress-new", "running", ago(120));
  await progress(DB, "progress-new", ago(10)); // the engine reports progress; the job row isn't touched until the end
  await job(DB, "job-new", "running", ago(10));
  await progress(DB, "job-new", ago(120)); // an old progress row never hides a fresh job row
  await job(DB, "both-old", "running", ago(50));
  await progress(DB, "both-old", ago(46));
  assert.deepEqual(await markStale(DB, NOW), { jobs: 1, scans: 0 });
  assert.equal((await row(DB, "SELECT status FROM jobs WHERE id = 'both-old'")).status, "failed");
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'"), 2);
});

test("finished and failed runs are never touched, however old", async () => {
  const DB = fakeD1();
  await job(DB, "done", "done", ago(600));
  await job(DB, "failed", "failed", ago(600));
  await DB.prepare("UPDATE jobs SET error = 'Google refused the search.' WHERE id = 'failed'").run();
  await scan(DB, "done", "done", ago(600));
  await scan(DB, "failed", "failed", ago(600));
  assert.deepEqual(await markStale(DB, NOW), { jobs: 0, scans: 0 });
  assert.equal((await row(DB, "SELECT error FROM jobs WHERE id = 'failed'")).error, "Google refused the search.");
  assert.equal((await row(DB, "SELECT updated_at FROM jobs WHERE id = 'done'")).updated_at, ago(600));
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos"), 0);
});

test("manual and scrape scans are stopped; care scans never are", async () => {
  const DB = fakeD1();
  await scan(DB, "m", "running", ago(60), { source: "manual" });
  await scan(DB, "sc", "queued", ago(60), { source: "scrape" });
  await scan(DB, "care-q", "queued", ago(600), { source: "care" });
  await scan(DB, "care-r", "running", ago(600), { source: "care" });
  assert.deepEqual(await markStale(DB, NOW), { jobs: 0, scans: 2 });
  assert.deepEqual((await DB.prepare("SELECT id FROM scans WHERE status = 'failed' ORDER BY id").all()).results.map((r) => r.id), ["m", "sc"]);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'health:stale:scan:care%'"), 0);
  assert.equal((await row(DB, "SELECT error FROM scans WHERE id = 'care-r'")).error, null);
});

test("a stopped run's row and todo: Part A's text, link and dedupe; failed at the tick's time", async () => {
  const DB = fakeD1();
  await job(DB, "j1", "running", ago(90), { trade: "roofer", town: "St Helens" });
  await scan(DB, "k1", "queued", ago(90), { keyword: "tree surgeon", town: "Newton-le-Willows" });
  assert.deepEqual(await markStale(DB, NOW), { jobs: 1, scans: 1 });
  assert.deepEqual(await row(DB, "SELECT status, error, updated_at FROM jobs WHERE id = 'j1'"),
    { status: "failed", error: STALE_JOB_ERROR, updated_at: "2026-10-19T12:00:00Z" });
  assert.deepEqual(await row(DB, "SELECT status, error, updated_at FROM scans WHERE id = 'k1'"),
    { status: "failed", error: STALE_SCAN_ERROR, updated_at: "2026-10-19T12:00:00Z" });
  const todo = (dedupe) =>
    DB.prepare("SELECT kind, title, detail, link, status, place_id, client_id, draft, due_at FROM todos WHERE dedupe = ?").bind(dedupe).first();
  assert.deepEqual(await todo("health:stale:job:j1"), {
    kind: "health",
    title: "Lead search stopped: roofer in St Helens",
    detail: "It made no progress for 45 minutes, so it was marked failed. Press Find leads to try again. If it happens twice, open GitHub → Actions → Scrape leads and look at the red run.",
    link: "/#/scraper",
    status: "open",
    place_id: null,
    client_id: null,
    draft: null,
    due_at: null,
  });
  assert.deepEqual(await todo("health:stale:scan:k1"), {
    kind: "health",
    title: "Map Rank scan stopped: tree surgeon in Newton-le-Willows",
    detail: "It made no progress for 45 minutes, so it was marked failed. Press Run scan to try again.",
    link: "/#/maprank",
    status: "open",
    place_id: null,
    client_id: null,
    draft: null,
    due_at: null,
  });
  // Each todo has its own id, like addTodo's.
  const ids = (await DB.prepare("SELECT id FROM todos").all()).results.map((r) => r.id);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("a todo Nik dismissed doesn't come back, and nothing is stopped twice", async () => {
  const DB = fakeD1();
  await job(DB, "j1", "running", ago(90));
  await markStale(DB, NOW);
  await DB.prepare("UPDATE todos SET status = 'dismissed' WHERE dedupe = 'health:stale:job:j1'").run();
  // The engine wrote again after it was stopped (e.g. a re-run of the same job id): it isn't stopped a second time
  // while it's fresh, and when it goes stale again its todo stays dismissed.
  await DB.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = 'j1'").bind(ago(5)).run();
  assert.deepEqual(await markStale(DB, NOW), { jobs: 0, scans: 0 });
  const later = new Date(NOW.getTime() + 60 * 60_000);
  assert.deepEqual(await markStale(DB, later), { jobs: 1, scans: 0 });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos"), 1);
  assert.equal((await row(DB, "SELECT status FROM todos")).status, "dismissed");
});

test("a run that reports in between the check and the update is left alone, with no todo", async () => {
  const base = fakeD1();
  await job(base, "late", "running", ago(90));
  await job(base, "dead", "running", ago(90));
  await scan(base, "late-scan", "running", ago(90));
  // The engine finishes one search and reports on a scan just after markStale has looked, before it writes.
  const DB = {
    prepare: (sql) => base.prepare(sql),
    batch: async (stmts) => {
      await base.prepare("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = 'late'").bind(ago(0)).run();
      await base.prepare("UPDATE scans SET updated_at = ? WHERE id = 'late-scan'").bind(ago(0)).run();
      return base.batch(stmts);
    },
  };
  assert.deepEqual(await markStale(DB, NOW), { jobs: 1, scans: 0 });
  assert.equal((await row(base, "SELECT status FROM jobs WHERE id = 'late'")).status, "done");
  assert.equal((await row(base, "SELECT status FROM scans WHERE id = 'late-scan'")).status, "running");
  assert.deepEqual((await base.prepare("SELECT dedupe FROM todos").all()).results.map((r) => r.dedupe), ["health:stale:job:dead"]);
});

test("at most 6 D1 statements a run, however many runs are stuck; 1 when none is", async () => {
  const DB = fakeD1();
  const quiet = countingDB(DB);
  assert.deepEqual(await markStale(quiet.DB, NOW), { jobs: 0, scans: 0 });
  assert.equal(quiet.used(), 1);

  for (let i = 0; i < 60; i++) await job(DB, `j${i}`, i % 2 ? "running" : "queued", ago(60 + i), { town: `Town ${i}` });
  for (let i = 0; i < 40; i++) await scan(DB, `s${i}`, "running", ago(60 + i));
  const busy = countingDB(DB);
  assert.deepEqual(await markStale(busy.DB, NOW), { jobs: 60, scans: 40 });
  assert.ok(busy.used() <= 6, `used ${busy.used()} statements`);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'health:stale:%'"), 100);
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'"), 60);

  // Only searches stuck: the scans' statement isn't sent.
  const onlyJobs = fakeD1();
  await job(onlyJobs, "j", "running", ago(60));
  const c = countingDB(onlyJobs);
  assert.deepEqual(await markStale(c.DB, NOW), { jobs: 1, scans: 0 });
  assert.ok(c.used() <= 3, `used ${c.used()} statements`);
});

test("a failed write stops nothing: the runs and their todos are saved together or not at all", async () => {
  const base = fakeD1();
  await job(base, "j1", "running", ago(90));
  await scan(base, "s1", "running", ago(90));
  await base.exec("CREATE TRIGGER no_todos BEFORE INSERT ON todos BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  await assert.rejects(markStale(base, NOW), /disk full/);
  assert.equal((await row(base, "SELECT status FROM jobs WHERE id = 'j1'")).status, "running");
  assert.equal((await row(base, "SELECT status FROM scans WHERE id = 's1'")).status, "running");
  await base.exec("DROP TRIGGER no_todos");
  assert.deepEqual(await markStale(base, NOW), { jobs: 1, scans: 1 });
  assert.equal(await count(base, "SELECT COUNT(*) AS n FROM todos"), 2);
});

test("the STEPS entry: stale_jobs every 15 minutes, summary 'N searches, M scans stopped'", async () => {
  const entry = STEPS.find((s) => s.name === "stale_jobs");
  assert.equal(entry, staleJobsStep);
  assert.equal(entry.everyMinutes, 15);
  const DB = fakeD1();
  await job(DB, "j1", "running", ago(90));
  await scan(DB, "s1", "queued", ago(90));
  await scan(DB, "s2", "queued", ago(90));
  assert.equal(await entry.run({ DB, env: { DB }, now: NOW }), "1 searches, 2 scans stopped");
  assert.equal(await entry.run({ DB, env: { DB }, now: NOW }), "0 searches, 0 scans stopped");
});

// ---------------------------------------------------------------- review additions

test("a search whose progress row moves between the check and the update is left alone, with no todo", async () => {
  const base = fakeD1();
  await job(base, "busy", "running", ago(120));
  await progress(base, "busy", ago(50));
  await job(base, "dead", "running", ago(120));
  await progress(base, "dead", ago(50));
  // The engine reports progress on one search (job_progress only; the jobs row isn't touched) after the look.
  const DB = {
    prepare: (sql) => base.prepare(sql),
    batch: async (stmts) => {
      await base.prepare("UPDATE job_progress SET updated_at = ? WHERE job_id = 'busy'").bind(ago(0)).run();
      return base.batch(stmts);
    },
  };
  assert.deepEqual(await markStale(DB, NOW), { jobs: 1, scans: 0 });
  assert.deepEqual(await row(base, "SELECT status, error FROM jobs WHERE id = 'busy'"), { status: "running", error: null });
  assert.equal((await row(base, "SELECT status FROM jobs WHERE id = 'dead'")).status, "failed");
  assert.deepEqual((await base.prepare("SELECT dedupe FROM todos").all()).results.map((r) => r.dedupe), ["health:stale:job:dead"]);
});

test("a progress row exactly 45 minutes old keeps an older search alive; at 46 it doesn't", async () => {
  const DB = fakeD1();
  await job(DB, "p45", "running", ago(300));
  await progress(DB, "p45", ago(45));
  await job(DB, "p46", "running", ago(300));
  await progress(DB, "p46", ago(46));
  assert.deepEqual(await markStale(DB, NOW), { jobs: 1, scans: 0 });
  assert.equal((await row(DB, "SELECT status FROM jobs WHERE id = 'p45'")).status, "running");
  assert.equal((await row(DB, "SELECT status FROM jobs WHERE id = 'p46'")).status, "failed");
});

test("through runTick: stale_jobs runs every 15 minutes, within the tick's budget, and its summary reaches the tick beat", async () => {
  const DB = fakeD1();
  const env = { DB };
  await job(DB, "j1", "running", ago(90), { town: "Leigh" });
  const counter = countingDB(DB);
  const first = await runTick({ DB: counter.DB }, "cron", NOW, { steps: [staleJobsStep] });
  assert.deepEqual(first, { ran: true, steps: { stale_jobs: "1 searches, 0 scans stopped" } });
  // The runner's own 6 (gap check, lease, tick:last, last runs, release, beat) and the step's cap of 6.
  assert.ok(counter.used() <= 6 + 6, `the tick used ${counter.used()} statements`);
  assert.equal((await row(DB, "SELECT status FROM jobs WHERE id = 'j1'")).status, "failed");
  assert.match((await row(DB, "SELECT detail FROM heartbeats WHERE name = 'tick'")).detail, /stale_jobs: 1 searches, 0 scans stopped/);

  // Another stuck run 5 minutes later waits for the step's 15 minutes; then it is stopped.
  await job(DB, "j2", "running", ago(90));
  const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000);
  assert.deepEqual(await runTick(env, "cron", at(5), { steps: [staleJobsStep] }), { ran: true, steps: { stale_jobs: "skipped" } });
  assert.equal((await row(DB, "SELECT status FROM jobs WHERE id = 'j2'")).status, "running");
  assert.deepEqual(await runTick(env, "cron", at(15), { steps: [staleJobsStep] }), { ran: true, steps: { stale_jobs: "1 searches, 0 scans stopped" } });
  assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'health:stale:job:%'"), 2);
});
