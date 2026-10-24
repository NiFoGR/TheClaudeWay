// Find, the database part: start a search, pipeline counts, recent searches, the territory setting (02-find Task 10);
// the research queue and the research Routine's fire guard (Task 11).
// Run: node --test control-room/tests/find.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { onRequestPost as postScrape } from "../functions/api/scrape.js";
import { countingDB } from "../functions/_lib/d1count.js";
import {
  enqueueResearch, iso, leadSuppressed, loadTerritory, maybeFireResearch, pipelineCounts, recentJobs, saveTerritory,
  startScrape,
} from "../functions/_lib/find.js";
import { suppress } from "../functions/_lib/prospects.js";
import { getSetting as getJsonSetting } from "../functions/_lib/stripe.js";
import { getSetting, setSetting } from "../functions/_lib/settings.js";
import { DEFAULT_TERRITORY } from "../functions/_lib/territory.js";
import { iso as utilIso, now as utilNow } from "../functions/_lib/util.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const T0 = "2026-10-01T00:00:00Z";

// Seeding helpers (raw SQL through the D1 API, so the binds follow D1's rules).
async function lead(DB, place_id, extra = {}) {
  const row = { place_id, name: `Lead ${place_id}`, trade: "landscaper", search_town: "Warrington", excluded: 0,
    quality_score: 60, first_seen_at: T0, updated_at: T0, ...extra };
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO leads (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...Object.values(row)).run();
}
const research = (DB, place_id, status, grade = null, too_big = 0) =>
  DB.prepare("INSERT INTO research (place_id, status, grade, too_big, queued_at) VALUES (?, ?, ?, ?, ?)")
    .bind(place_id, status, grade, too_big, T0).run();
const prospect = (DB, place_id, first_sent_at) =>
  DB.prepare("INSERT INTO prospects (place_id, stage, stage_at, email, first_sent_at, created_at, updated_at) VALUES (?, 'emailed', ?, ?, ?, ?, ?)")
    .bind(place_id, T0, `${place_id}@example.co.uk`, first_sent_at, T0, T0).run();
const jobRow = (DB, id, status, created_at = T0, trade = "landscaper", town = "Widnes") =>
  DB.prepare("INSERT INTO jobs (id, trade, town, max_results, status, created_at, updated_at) VALUES (?, ?, ?, 60, ?, ?, ?)")
    .bind(id, trade, town, status, created_at, created_at).run();
const jobById = (DB, id) => DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first();

// ---------------------------------------------------------------- the spec's tests (Task 10, Step 1)

test("iso lives in util.js and find.js re-exports the same function", () => {
  assert.equal(utilIso(new Date("2026-10-19T05:02:03.456Z")), "2026-10-19T05:02:03Z");
  assert.equal(iso, utilIso);
});

test("startScrape records the run and starts the workflow", async () => {
  const DB = fakeD1(); const calls = [];
  const { job, error } = await startScrape(DB, {}, { trade: "landscaper", town: "Widnes", max: 60 },
    { start: async (env, wf, inputs) => { calls.push([wf, inputs]); return ""; } });
  assert.equal(error, ""); assert.equal(job.status, "queued");
  assert.deepEqual(calls, [["scrape-leads.yml", { trade: "landscaper", town: "Widnes", max: "60", job_id: job.id }]]);
});

test("a refused start is saved as failed with GitHub's reason", async () => {
  const DB = fakeD1();
  const { job, error } = await startScrape(DB, {}, { trade: "landscaper", town: "Widnes", max: 60 },
    { start: async () => "GitHub refused to start the run (401): Bad credentials" });
  assert.equal(job.status, "failed"); assert.equal(job.error, error);
});

test("pipeline counts only graded, unemailed, pitchable A+/A/B", async () => {
  const DB = fakeD1();
  // leads g1..g6 (excluded = 0 except g5); research: g1 A+, g2 A, g3 B, g4 C (done); g5 A but lead excluded;
  // g6 A with prospects.first_sent_at set; q1, q2 queued; one jobs row 'running', one 'done'
  for (const id of ["g1", "g2", "g3", "g4", "g6", "q1", "q2"]) await lead(DB, id);
  await lead(DB, "g5", { excluded: 1, exclude_reason: "Chain / national brand" });
  await research(DB, "g1", "done", "A+");
  await research(DB, "g2", "done", "A");
  await research(DB, "g3", "done", "B");
  await research(DB, "g4", "done", "C");
  await research(DB, "g5", "done", "A");
  await research(DB, "g6", "done", "A");
  await prospect(DB, "g6", "2026-10-05T09:00:00Z");
  await research(DB, "q1", "queued");
  await research(DB, "q2", "queued");
  await jobRow(DB, "j-running", "running");
  await jobRow(DB, "j-done", "done");
  assert.deepEqual(await pipelineCounts(DB), { goodWaiting: 3, researchQueued: 2, activeJobs: 1 });
});

// ---------------------------------------------------------------- more: startScrape

test("startScrape saves the jobs row as api/scrape.js always has, at the given time", async () => {
  const DB = fakeD1();
  const now = new Date("2026-10-19T05:02:03.456Z");
  const { job } = await startScrape(DB, {}, { trade: "landscaper", town: "Widnes", max: 60 }, { start: async () => "", now });
  assert.match(job.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await jobById(DB, job.id), {
    id: job.id, trade: "landscaper", town: "Widnes", max_results: 60, status: "queued", found: null, pitchable: null,
    error: null, created_at: "2026-10-19T05:02:03Z", updated_at: "2026-10-19T05:02:03Z",
  });
  assert.deepEqual(job, await jobById(DB, job.id), "the job returned is the saved row");
});

test("a refused start: the saved row is failed with the reason, and the env goes to the workflow call", async () => {
  const DB = fakeD1(); const seen = [];
  const env = { GITHUB_REPO: "NiFoGR/TheClaudeWay" };
  const reason = "GitHub isn't connected yet (GITHUB_TOKEN / GITHUB_REPO not set).";
  const { job, error } = await startScrape(DB, env, { trade: "roofer", town: "Leigh", max: 100 },
    { start: async (e) => { seen.push(e); return reason; }, now: new Date("2026-10-19T05:00:00Z") });
  assert.equal(error, reason);
  assert.equal(seen[0], env);
  const saved = await jobById(DB, job.id);
  assert.equal(saved.status, "failed"); assert.equal(saved.error, reason);
  assert.equal(saved.max_results, 100); assert.equal(saved.updated_at, "2026-10-19T05:00:00Z");
  assert.deepEqual(job, saved);
});

test("a start that throws (GitHub unreachable) is saved as failed with a plain-English reason, never left queued", async () => {
  const DB = fakeD1();
  const { job, error } = await startScrape(DB, {}, { trade: "landscaper", town: "Widnes", max: 60 },
    { start: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(error, "Couldn't reach GitHub to start the run (fetch failed). Try again in a few minutes.");
  assert.equal(job.status, "failed"); assert.equal(job.error, error);
  assert.equal((await jobById(DB, job.id)).status, "failed");
});

test("the GitHub token never reaches the saved error, the job or the answer", async () => {
  const token = "ghp_R3alLookingT0kenValue1234567890abcd";
  // Node's fetch quotes the header for a token pasted with a line break; the real startWorkflow throws that.
  const env = { GITHUB_TOKEN: `${token.slice(0, 20)}\n${token.slice(20)}`, GITHUB_REPO: "NiFoGR/TheClaudeWay" };
  const DB = fakeD1();
  const thrown = await startScrape(DB, env, { trade: "landscaper", town: "Widnes", max: 60 });
  assert.equal(thrown.job.status, "failed");
  assert.match(thrown.error, /^Couldn't reach GitHub to start the run \(.*\[hidden\].*[^.]\)\. Try again in a few minutes\.$/s);
  for (const piece of [env.GITHUB_TOKEN, token.slice(0, 20), token.slice(20)]) {
    assert.ok(!JSON.stringify(thrown).includes(JSON.stringify(piece).slice(1, -1)), "token piece in the result");
    assert.ok(!JSON.stringify(await jobById(DB, thrown.job.id)).includes(JSON.stringify(piece).slice(1, -1)), "token piece saved");
  }
  // A reason that quotes the token (or any GitHub token) is cleaned too, whoever wrote it.
  const quoted = await startScrape(fakeD1(), { GITHUB_TOKEN: token }, { trade: "landscaper", town: "Widnes", max: 60 },
    { start: async () => `GitHub refused to start the run (401): token ${token} or ghp_SomeOtherToken0123456789abc is bad` });
  assert.equal(quoted.error, "GitHub refused to start the run (401): token [hidden] or [hidden] is bad");
  assert.equal(quoted.job.error, quoted.error);
});

test("startScrape uses 1 D1 statement when GitHub starts the run, 2 when it refuses (the daily_find budget)", async () => {
  const ok = countingDB(fakeD1());
  await startScrape(ok.DB, {}, { trade: "landscaper", town: "Widnes", max: 60 }, { start: async () => "" });
  assert.equal(ok.used(), 1);
  const refused = countingDB(fakeD1());
  await startScrape(refused.DB, {}, { trade: "landscaper", town: "Widnes", max: 60 }, { start: async () => "no" });
  assert.equal(refused.used(), 2);
});

// ---------------------------------------------------------------- more: pipeline counts

test("pipeline counts: too big isn't counted; a prospect row that hasn't been emailed yet still counts", async () => {
  const DB = fakeD1();
  for (const id of ["big", "ready"]) await lead(DB, id);
  await research(DB, "big", "done", "A+", 1);
  await research(DB, "ready", "done", "A");
  await prospect(DB, "ready", null); // a prospects row before the first email is sent
  await research(DB, "skipped", "skipped", "A"); // skipped rows aren't graded leads waiting
  await research(DB, "no-lead-row", "done", "A"); // research for a lead that's gone isn't a lead waiting
  await jobRow(DB, "j-queued", "queued");
  await jobRow(DB, "j-failed", "failed");
  assert.deepEqual(await pipelineCounts(DB), { goodWaiting: 1, researchQueued: 0, activeJobs: 1 });
});

test("pipeline counts on an empty database are all 0, in one D1 statement", async () => {
  const { DB, used } = countingDB(fakeD1());
  assert.deepEqual(await pipelineCounts(DB), { goodWaiting: 0, researchQueued: 0, activeJobs: 0 });
  assert.equal(used(), 1);
});

// ---------------------------------------------------------------- more: recent searches

test("recentJobs: every search created in the last 31 days, any trade or status, as {trade, town, status, created_at}", async () => {
  const DB = fakeD1();
  const now = new Date("2026-10-19T05:00:00Z");
  await jobRow(DB, "old", "done", "2026-09-18T04:59:59Z", "landscaper", "Wigan"); // 31 days and 1 second ago
  await jobRow(DB, "edge", "done", "2026-09-18T05:00:00Z", "landscaper", "Leigh"); // exactly 31 days ago
  await jobRow(DB, "failed", "failed", "2026-10-18T06:00:00Z", "landscaper", "Widnes");
  await jobRow(DB, "roofer", "running", "2026-10-19T04:00:00Z", "roofer", "Runcorn");
  const { DB: counted, used } = countingDB(DB);
  const rows = await recentJobs(counted, now);
  assert.equal(used(), 1);
  assert.deepEqual(rows, [
    { trade: "roofer", town: "Runcorn", status: "running", created_at: "2026-10-19T04:00:00Z" },
    { trade: "landscaper", town: "Widnes", status: "failed", created_at: "2026-10-18T06:00:00Z" },
    { trade: "landscaper", town: "Leigh", status: "done", created_at: "2026-09-18T05:00:00Z" },
  ]);
});

// ---------------------------------------------------------------- more: the territory setting

test("loadTerritory: the defaults when nothing is saved or the saved JSON is unreadable", async () => {
  const DB = fakeD1();
  assert.deepEqual(await loadTerritory(DB), DEFAULT_TERRITORY);
  await setSetting(DB, "territory", "{bad");
  assert.deepEqual(await loadTerritory(DB), DEFAULT_TERRITORY);
});

test("saveTerritory stores the JSON {on, trade, towns, next, max} that Python and stripe.js getSetting read", async () => {
  const DB = fakeD1();
  const t = { on: false, trade: "roofer", towns: ["Leigh", "Wigan"], next: 1, max: 100 };
  await saveTerritory(DB, { ...t, upcoming: "Wigan" }); // anything else isn't part of the setting
  const text = await getSetting(DB, "territory");
  assert.equal(typeof text, "string");
  assert.deepEqual(JSON.parse(text), t); // what aetos_leads/autopilot.py json.loads
  assert.deepEqual(Object.keys(JSON.parse(text)), ["on", "trade", "towns", "next", "max"]);
  assert.deepEqual(await getJsonSetting(DB, "territory"), t); // api/today.js reads it this way
  assert.deepEqual(await loadTerritory(DB), t);
});

test("loadTerritory reads what Python's autopilot.py saves", async () => {
  const DB = fakeD1();
  // json.dumps({**t, "next": nxt}) with Python's default separators
  await setSetting(DB, "territory", '{"on": true, "trade": "landscaper", "towns": ["Warrington", "Widnes"], "next": 1, "max": 60}');
  assert.deepEqual(await loadTerritory(DB), { on: true, trade: "landscaper", towns: ["Warrington", "Widnes"], next: 1, max: 60 });
});

// ---------------------------------------------------------------- more: POST /api/scrape keeps its answers

const post = (body) => new Request("https://control.example/api/scrape", {
  method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
});

test("POST /api/scrape keeps its plain-English checks", async () => {
  const env = { DB: fakeD1() };
  const cases = [
    ["{bad", "Send JSON"],
    ["null", "Type a niche, e.g. roofer"],
    [{ trade: "r", town: "Leeds", max: 60 }, "Type a niche, e.g. roofer"],
    [{ trade: "roofer", town: " ", max: 60 }, "Type a UK town, e.g. Leeds"],
    [{ trade: "roofer", town: "Leeds", max: 5 }, "Number of leads must be between 10 and 300"],
    [{ trade: "roofer", town: "Leeds", max: "sixty" }, "Number of leads must be between 10 and 300"],
  ];
  for (const [body, message] of cases) {
    const resp = await postScrape({ request: post(body), env });
    assert.equal(resp.status, 400);
    assert.deepEqual(await resp.json(), { error: message });
  }
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first()).n, 0);
});

test("POST /api/scrape: GitHub not connected → 502 with the failed job and startWorkflow's message", async () => {
  // No GITHUB_TOKEN, so the real startWorkflow answers without touching the network.
  const env = { DB: fakeD1() };
  const resp = await postScrape({ request: post({ trade: " roofer ", town: " Leeds ", max: 60 }), env });
  assert.equal(resp.status, 502);
  const { job } = await resp.json();
  assert.equal(job.status, "failed");
  assert.equal(job.error, "GitHub isn't connected yet (GITHUB_TOKEN / GITHUB_REPO not set).");
  assert.equal(job.trade, "roofer"); assert.equal(job.town, "Leeds"); assert.equal(job.max_results, 60);
  assert.deepEqual(await jobById(env.DB, job.id), job);
  assert.match(job.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(job.created_at <= utilNow());
});

// ================================================================ Task 11: the research queue and the Routine fire

const ids = async (DB, sql) => (await DB.prepare(sql).all()).results.map((r) => Object.values(r)[0]);
const blockRow = (DB, value, kind) => suppress(DB, value, kind, "opt_out", new Date(T0));
const fireRow = (DB, at, { routine = "research", http_status = 500, error = "Claude couldn't start the Routine." } = {}) =>
  DB.prepare("INSERT INTO routine_fires (id, routine, reason, http_status, error, session_url, at) VALUES (?, ?, ?, ?, ?, NULL, ?)")
    .bind(crypto.randomUUID(), routine, "research queued: 2 leads", http_status, error, at).run();
const researchRow = (DB, place_id) => DB.prepare("SELECT * FROM research WHERE place_id = ?").bind(place_id).first();

// ---------------------------------------------------------------- the spec's tests (Task 11, Step 1)

test("queues every pitchable lead scoring 35+ or not checked, once", async () => {
  const DB = fakeD1();
  // a: score 60 → yes; b: 34 → no; c: 10 with audit.findings ["not_checked"] → yes; d: 90 excluded → no;
  // e: 70, email in suppression (kind email) → no; f: 70, website https://www.blocked.co.uk, suppression domain blocked.co.uk → no;
  // g: 80 with research row status 'done' → unchanged
  await lead(DB, "a", { quality_score: 60 });
  await lead(DB, "b", { quality_score: 34 });
  await lead(DB, "c", { quality_score: 10, audit: JSON.stringify({ findings: ["not_checked"] }) });
  await lead(DB, "d", { quality_score: 90, excluded: 1, exclude_reason: "Chain / national brand" });
  await lead(DB, "e", { quality_score: 70, email: "bob@optedout.co.uk", website: "https://optedout.co.uk/" });
  await blockRow(DB, "bob@optedout.co.uk", "email");
  await lead(DB, "f", { quality_score: 70, website: "https://www.blocked.co.uk" });
  await blockRow(DB, "blocked.co.uk", "domain");
  await lead(DB, "g", { quality_score: 80 });
  await research(DB, "g", "done", "A");
  assert.equal(await enqueueResearch(DB, new Date("2026-10-19T05:00:00Z")), 2);
  assert.deepEqual(await ids(DB, "SELECT place_id FROM research WHERE status = 'queued' ORDER BY place_id"), ["a", "c"]);
  assert.equal(await enqueueResearch(DB, new Date("2026-10-19T06:00:00Z")), 0);
  const g = await researchRow(DB, "g");
  assert.equal(g.status, "done"); assert.equal(g.grade, "A"); assert.equal(g.queued_at, T0);
});

test("fires the research Routine at most every 30 minutes, only with a queue", async () => {
  const DB = fakeD1(); const fired = [];
  const fire = async (db, name, text) => { fired.push([name, text]); return { ok: true, status: 200 }; };
  assert.equal(await maybeFireResearch(DB, new Date("2026-10-19T05:00:00Z"), { fire }), "empty");
  // insert 2 queued research rows
  await research(DB, "q1", "queued");
  await research(DB, "q2", "queued");
  assert.equal(await maybeFireResearch(DB, new Date("2026-10-19T05:00:00Z"), { fire }), "fired");
  assert.deepEqual(fired, [["research", "research queued: 2 leads"]]);
  // insert routine_fires row (routine 'research', at '2026-10-19T05:30:01Z', http_status 500)
  await fireRow(DB, "2026-10-19T05:30:01Z");
  assert.equal(await maybeFireResearch(DB, new Date("2026-10-19T06:00:00Z"), { fire }), "recent");
});

// ---------------------------------------------------------------- more: what goes into the queue

test("queued rows: status 'queued', queued_at is the time given, everything else as a new research row", async () => {
  const DB = fakeD1();
  await lead(DB, "a", { quality_score: 35 }); // exactly the threshold
  assert.equal(await enqueueResearch(DB, new Date("2026-10-19T05:00:00.789Z")), 1);
  const row = await researchRow(DB, "a");
  assert.equal(row.status, "queued"); assert.equal(row.queued_at, "2026-10-19T05:00:00Z");
  assert.equal(row.grade, null); assert.equal(row.too_big, 0); assert.equal(row.notes, ""); assert.equal(row.researched_at, null);
});

test("a lead already queued, done or skipped is never touched", async () => {
  const DB = fakeD1();
  for (const id of ["queued", "done", "skipped"]) {
    await lead(DB, id, { quality_score: 90 });
    await research(DB, id, id, id === "done" ? "B" : null);
  }
  assert.equal(await enqueueResearch(DB, new Date("2026-10-19T05:00:00Z")), 0);
  for (const id of ["queued", "done", "skipped"]) {
    const row = await researchRow(DB, id);
    assert.equal(row.status, id); assert.equal(row.queued_at, T0);
  }
});

test("a broken or missing audit never stops the queue: the score alone decides for that lead", async () => {
  const DB = fakeD1();
  await lead(DB, "bad-low", { quality_score: 10, audit: "{bad" });
  await lead(DB, "bad-high", { quality_score: 50, audit: "{bad" });
  await lead(DB, "empty-high", { quality_score: 60, audit: "" });
  await lead(DB, "null-low", { quality_score: 0, audit: null });
  await lead(DB, "array-low", { quality_score: 5, audit: "[]" });
  await lead(DB, "no-findings", { quality_score: 20, audit: JSON.stringify({ status: "ok" }) });
  await lead(DB, "other-findings", { quality_score: 20, audit: JSON.stringify({ findings: ["no_title", "not_mobile"] }) });
  await lead(DB, "mixed", { quality_score: 0, audit: JSON.stringify({ status: "blocked", findings: ["no_title", "not_checked"] }) });
  assert.equal(await enqueueResearch(DB, new Date("2026-10-19T05:00:00Z")), 3);
  assert.deepEqual(await ids(DB, "SELECT place_id FROM research ORDER BY place_id"), ["bad-high", "empty-high", "mixed"]);
});

test("suppressed leads are never queued: email, its domain, the website host (with or without www.) and the company", async () => {
  const DB = fakeD1();
  await blockRow(DB, "Bob@OptedOut.co.uk", "email"); // stored lower-cased by suppress()
  await blockRow(DB, "bounced.co.uk", "domain");
  await blockRow(DB, "blocked.co.uk", "domain");
  await blockRow(DB, "sc123456", "company"); // stored upper-cased by suppress()
  await lead(DB, "email", { email: "BOB@optedout.co.uk" });
  await lead(DB, "email-domain", { email: "info@bounced.co.uk", website: "https://another-site.co.uk/" });
  await lead(DB, "host", { website: "http://blocked.co.uk/contact-us" });
  await lead(DB, "www-host", { website: "https://WWW.Blocked.co.uk/" });
  await lead(DB, "company", { company_number: "SC123456" });
  await lead(DB, "subdomain", { website: "https://shop.blocked.co.uk/" }); // a subdomain is another domain
  await lead(DB, "same-person-other-address", { email: "bob@optedout-gardens.co.uk" });
  await lead(DB, "clean", { email: "jo@clean.co.uk", website: "https://www.clean.co.uk", company_number: "01234567" });
  assert.equal(await enqueueResearch(DB, new Date("2026-10-19T05:00:00Z")), 3);
  assert.deepEqual(await ids(DB, "SELECT place_id FROM research ORDER BY place_id"), ["clean", "same-person-other-address", "subdomain"]);
});

test("enqueue costs 1 D1 statement with nothing new, 2 when every new lead is suppressed, 3 otherwise, however many", async () => {
  const none = countingDB(fakeD1());
  assert.equal(await enqueueResearch(none.DB, new Date("2026-10-19T05:00:00Z")), 0);
  assert.equal(none.used(), 1);

  const blocked = fakeD1();
  await lead(blocked, "x", { email: "x@blocked.co.uk" });
  await blockRow(blocked, "blocked.co.uk", "domain");
  const all = countingDB(blocked);
  assert.equal(await enqueueResearch(all.DB, new Date("2026-10-19T05:00:00Z")), 0);
  assert.equal(all.used(), 2);

  // Day one: about 200 of the 287 landscapers qualify. One INSERT, never more than D1's 100 bound values.
  const many = fakeD1();
  for (let i = 0; i < 250; i++) await lead(many, `p${String(i).padStart(3, "0")}`, { quality_score: 35 + (i % 60) });
  const counted = countingDB(many);
  assert.equal(await enqueueResearch(counted.DB, new Date("2026-10-19T05:00:00Z")), 250);
  assert.equal(counted.used(), 3);
  assert.equal((await many.prepare("SELECT COUNT(*) AS n FROM research WHERE status = 'queued'").first()).n, 250);
});

// ---------------------------------------------------------------- more: leadSuppressed (pure)

test("leadSuppressed: email, email domain, website host without www., company number; kinds are kept apart", () => {
  const rows = [
    { value: "bob@optedout.co.uk", kind: "email" },
    { value: "bounced.co.uk", kind: "domain" },
    { value: "SC123456", kind: "company" },
    { value: "companyword.co.uk", kind: "company" }, // a company row never blocks a domain
    { value: "jo@listed-as-domain.co.uk", kind: "domain" }, // nor a domain row an address
  ];
  assert.equal(leadSuppressed({ email: "bob@optedout.co.uk" }, rows), true);
  assert.equal(leadSuppressed({ email: " Bob@OptedOut.CO.UK " }, rows), true);
  assert.equal(leadSuppressed({ email: "anyone@bounced.co.uk" }, rows), true);
  assert.equal(leadSuppressed({ website: "https://bounced.co.uk" }, rows), true);
  assert.equal(leadSuppressed({ website: "https://www.bounced.co.uk/about?x=1" }, rows), true);
  assert.equal(leadSuppressed({ website: "www.bounced.co.uk/contact" }, rows), true); // no scheme
  assert.equal(leadSuppressed({ website: "bounced.co.uk" }, rows), true);
  assert.equal(leadSuppressed({ company_number: "SC123456" }, rows), true);
  assert.equal(leadSuppressed({ company_number: " sc123456 " }, rows), true);
  assert.equal(leadSuppressed({ email: "jo@other.co.uk", website: "https://other.co.uk", company_number: "SC654321" }, rows), false);
  assert.equal(leadSuppressed({ website: "https://companyword.co.uk/" }, rows), false);
  assert.equal(leadSuppressed({ email: "jo@listed-as-domain.co.uk" }, rows), false);
  assert.equal(leadSuppressed({ website: "https://shop.bounced.co.uk/" }, rows), false); // a subdomain is another domain
  assert.equal(leadSuppressed({ email: "bob@optedout.co.uk.evil.com" }, rows), false);
});

test("leadSuppressed copes with missing fields, odd rows and junk websites without throwing", () => {
  assert.equal(leadSuppressed({}, []), false);
  assert.equal(leadSuppressed({ email: null, website: null, company_number: null }, [{ value: "x.co.uk", kind: "domain" }]), false);
  assert.equal(leadSuppressed({ email: "", website: "", company_number: "" }, [{ value: "", kind: "email" }, { value: "", kind: "company" }]), false);
  assert.equal(leadSuppressed({ website: "not a website at all", email: "no-at-sign" }, [{ value: "no-at-sign", kind: "domain" }]), false);
  assert.equal(leadSuppressed({ website: "https://x.co.uk" }, [{ value: null, kind: "domain" }, { kind: "domain" }, null]), false);
  assert.equal(leadSuppressed({ website: "https://x.co.uk" }, null), false);
  assert.equal(leadSuppressed({ website: "https://x.co.uk" }, [{ value: "@X.co.uk", kind: "domain" }]), true);
  assert.equal(leadSuppressed({ email: "Bob Smith <bob@x.co.uk>" }, [{ value: "bob@x.co.uk", kind: "email" }]), true);
});

test("leadSuppressed once per lead reads the suppression list once, not once per lead (stage 2 checks every queued row)", () => {
  // 1,100 rows and 200 leads cost ~40 ms of CPU when the list is read for every lead: over the free plan's 10 ms.
  const list = [];
  for (let i = 0; i < 1000; i++) list.push({ value: `person${i}@business${i}.co.uk`, kind: "email" });
  for (let i = 0; i < 100; i++) list.push({ value: `dom${i}.co.uk`, kind: "domain" });
  let reads = 0;
  const rows = new Proxy(list, { // counts every read of a row
    get: (target, key, receiver) => {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  let hits = 0;
  for (let i = 0; i < 200; i++) if (leadSuppressed({ email: `info@lead${i}.co.uk`, website: `https://dom${i}.co.uk/` }, rows)) hits++;
  assert.equal(hits, 100);
  assert.ok(reads <= list.length, `the list was read ${reads} times for ${list.length} rows`);
  // A row added to the same list counts from the next call; another list is read afresh.
  assert.equal(leadSuppressed({ email: "new@added.co.uk" }, rows), false);
  rows.push({ value: "new@added.co.uk", kind: "email" });
  assert.equal(leadSuppressed({ email: "new@added.co.uk" }, rows), true);
  assert.equal(leadSuppressed({ email: "new@added.co.uk" }, [{ value: "other@added.co.uk", kind: "email" }]), false);
});

test("a lead row without a place_id is never queued (it would be queued again on every run)", async () => {
  const DB = fakeD1();
  await lead(DB, "a");
  await DB.prepare("INSERT INTO leads (place_id, name, trade, search_town, quality_score, first_seen_at, updated_at) VALUES (NULL, 'No id', 'landscaper', 'Widnes', 90, ?, ?)")
    .bind(T0, T0).run();
  assert.equal(await enqueueResearch(DB, new Date("2026-10-19T05:00:00Z")), 1);
  assert.equal(await enqueueResearch(DB, new Date("2026-10-19T06:00:00Z")), 0);
  assert.deepEqual(await ids(DB, "SELECT place_id FROM research"), ["a"]);
});

// ---------------------------------------------------------------- more: the fire guard

test("a fire Claude refused is 'failed', and still holds the next fire back for 30 minutes (no hammering)", async () => {
  const DB = fakeD1();
  await research(DB, "q1", "queued");
  // The real fireRoutine: nothing pasted on Setup → Claude, so it logs a failed routine_fires row without calling Claude.
  assert.equal(await maybeFireResearch(DB, new Date("2026-10-19T05:00:00Z")), "failed");
  const logged = await DB.prepare("SELECT routine, reason, http_status, error, at FROM routine_fires").all();
  assert.deepEqual(logged.results, [{
    routine: "research", reason: "research queued: 1 leads", http_status: null,
    error: "The Research Routine isn't connected: paste its URL and token on Setup → Claude.", at: "2026-10-19T05:00:00Z",
  }]);
  let calls = 0;
  const fire = async () => { calls++; return { ok: true, status: 200 }; };
  assert.equal(await maybeFireResearch(DB, new Date("2026-10-19T05:29:59Z"), { fire }), "recent");
  assert.equal(calls, 0);
  assert.equal(await maybeFireResearch(DB, new Date("2026-10-19T05:30:00Z"), { fire }), "fired");
  assert.equal(calls, 1);

  const refused = fakeD1();
  await research(refused, "q1", "queued");
  const no = async () => ({ ok: false, status: 401, error: "Claude rejected the token: generate a new one." });
  assert.equal(await maybeFireResearch(refused, new Date("2026-10-19T05:00:00Z"), { fire: no }), "failed");
});

test("the guard: a fire exactly 30 minutes ago no longer counts; another Routine's fires never count; no queue wins", async () => {
  const DB = fakeD1(); const fired = [];
  const fire = async (db, name, text, opts) => { fired.push([name, text, opts.now.toISOString()]); return { ok: true, status: 200 }; };
  await research(DB, "q1", "queued"); await research(DB, "q2", "queued"); await research(DB, "q3", "queued");
  await research(DB, "d1", "done", "A"); await research(DB, "s1", "skipped");
  await fireRow(DB, "2026-10-19T05:30:00Z", { http_status: 200, error: null });
  await fireRow(DB, "2026-10-19T05:59:00Z", { routine: "reply", http_status: 200, error: null });
  assert.equal(await maybeFireResearch(DB, new Date("2026-10-19T06:00:00Z"), { fire }), "fired");
  assert.deepEqual(fired, [["research", "research queued: 3 leads", "2026-10-19T06:00:00.000Z"]]); // the time is passed on

  const recent = fakeD1();
  await research(recent, "q1", "queued");
  await fireRow(recent, "2026-10-19T05:30:01Z");
  assert.equal(await maybeFireResearch(recent, new Date("2026-10-19T06:00:00Z"), { fire }), "recent");

  const empty = fakeD1();
  await research(empty, "d1", "done", "A");
  await fireRow(empty, "2026-10-19T05:00:00Z");
  const { DB: counted, used } = countingDB(empty);
  assert.equal(await maybeFireResearch(counted, new Date("2026-10-19T06:00:00Z"), { fire }), "empty");
  assert.equal(used(), 1, "the queue and the guard are read in one statement");
  assert.equal(fired.length, 1);
});
