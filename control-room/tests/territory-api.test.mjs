// GET/PUT /api/territory: the Lead Scraper page's Automatic search card (02-find Task 14). It replaces the old autopilot route;
// the old route's test ("autopilot settings…" in outreach-db.test.mjs) is ported here.
// Run: node --test control-room/tests/territory-api.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet, onRequestPut } from "../functions/api/territory.js";
import { loadTerritory, saveTerritory } from "../functions/_lib/find.js";
import { getSetting, setSetting } from "../functions/_lib/settings.js";
import { DEFAULT_TERRITORY } from "../functions/_lib/territory.js";
import { ukDate } from "../functions/_lib/ukTime.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const T0 = "2026-10-01T00:00:00Z";
const NONE_LEFT = "none (every town searched in the last 30 days)";

const jsonRequest = (body) => new Request("https://control.example/api/territory", {
  method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const get = async (DB, now) => (await onRequestGet({ env: { DB }, now })).json();
const put = (DB, body) => onRequestPut({ env: { DB }, request: jsonRequest(body) });
const today = (DB, decision) => setSetting(DB, "find:today", JSON.stringify(decision));
const jobRow = (DB, id, town, status, created_at, { trade = "landscaper", found = null, error = null } = {}) =>
  DB.prepare("INSERT INTO jobs (id, trade, town, max_results, status, found, error, created_at, updated_at) VALUES (?, ?, ?, 60, ?, ?, ?, ?, ?)")
    .bind(id, trade, town, status, found, error, created_at, created_at).run();
const lead = (DB, place_id, excluded = 0) =>
  DB.prepare("INSERT INTO leads (place_id, name, trade, search_town, excluded, quality_score, first_seen_at, updated_at) VALUES (?, ?, 'landscaper', 'Warrington', ?, 60, ?, ?)")
    .bind(place_id, `Lead ${place_id}`, excluded, T0, T0).run();
const research = (DB, place_id, status, grade = null) =>
  DB.prepare("INSERT INTO research (place_id, status, grade, queued_at) VALUES (?, ?, ?, ?)").bind(place_id, status, grade, T0).run();

// ---------------------------------------------------------------- the spec's tests (Task 14, Step 1)

test("GET explains today and the next town", async () => {
  const DB = fakeD1(); const now = new Date("2026-10-19T09:00:00Z");
  await today(DB, { day: "2026-10-19", search: false, reason: "good", n: 34 });
  const body = await (await onRequestGet({ env: { DB }, now })).json();
  assert.equal(body.today, "Skipped: 34 good leads waiting");
  assert.equal(body.upcoming, "Warrington");
});

test("PUT validates and keeps the place in the list", async () => {
  const DB = fakeD1();
  const bad = await onRequestPut({ env: { DB }, request: jsonRequest({ trade: "landscaper", towns: "", max: 60 }) });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).error, "Add at least one town (one per line)");
  assert.equal(await getSetting(DB, "territory"), null); // nothing saved

  // The place in the list is kept when only on/off or the size changes…
  await saveTerritory(DB, { on: true, trade: "landscaper", towns: ["Warrington", "Widnes", "Runcorn"], next: 2, max: 60 });
  const same = await put(DB, { on: false, trade: "landscaper", towns: "Warrington\nWidnes\nRuncorn", max: 100 });
  assert.equal(same.status, 200);
  assert.deepEqual(await same.json(), { territory: { on: false, trade: "landscaper", towns: ["Warrington", "Widnes", "Runcorn"], next: 2, max: 100 } });
  assert.equal((await loadTerritory(DB)).next, 2);
  // …and starts from the top for a new trade or a new list.
  assert.equal((await (await put(DB, { on: true, trade: "roofer", towns: "Warrington\nWidnes\nRuncorn", max: 60 })).json()).territory.next, 0);
  await saveTerritory(DB, { on: true, trade: "landscaper", towns: ["Warrington", "Widnes", "Runcorn"], next: 2, max: 60 });
  assert.equal((await (await put(DB, { on: true, trade: "landscaper", towns: "Warrington\nRuncorn", max: 60 })).json()).territory.next, 0);
  assert.equal((await loadTerritory(DB)).next, 0);
});

// ---------------------------------------------------------------- ported from outreach-db.test.mjs (the old autopilot route)

test("territory settings: defaults to landscapers, keeps its place, rejects nonsense", async () => {
  const DB = fakeD1();
  const a = await get(DB);
  assert.equal(a.territory.trade, "landscaper");
  assert.equal(a.upcoming, "Warrington");
  assert.equal((await put(DB, { on: true, trade: "landscaper", towns: "", max: 60 })).status, 400);
  const saved = await (await put(DB, { on: false, trade: "landscaper", towns: "Leeds\nYork\nLeeds", max: 40 })).json();
  assert.deepEqual(saved.territory.towns, ["Leeds", "York"]);
  assert.equal(saved.territory.on, false);
});

// ---------------------------------------------------------------- more: GET

test("GET on an empty database: the defaults, Warrington next, not decided yet, nothing waiting", async () => {
  const DB = fakeD1();
  const body = await get(DB, new Date("2026-10-19T09:00:00Z"));
  assert.deepEqual(body, {
    territory: { ...DEFAULT_TERRITORY, towns: [...DEFAULT_TERRITORY.towns] },
    upcoming: "Warrington",
    today: "Decided after 6am",
    counts: { goodWaiting: 0, researchQueued: 0 },
  });
});

test("GET: today's line reads today's job (done, running, failed) and yesterday's decision is not today's", async () => {
  const DB = fakeD1(); const now = new Date("2026-10-19T09:00:00Z");
  const decision = { day: "2026-10-19", at: "2026-10-19T05:02:00Z", search: true, town: "Widnes", job_id: "j1" };
  await today(DB, decision);
  await jobRow(DB, "j1", "Widnes", "running", "2026-10-19T05:02:00Z");
  assert.equal((await get(DB, now)).today, "Searching Widnes (started 06:02)");
  await DB.prepare("UPDATE jobs SET status = 'done', found = 41 WHERE id = 'j1'").run();
  assert.equal((await get(DB, now)).today, "Searched Widnes at 06:02 — 41 found");
  await DB.prepare("UPDATE jobs SET status = 'failed', error = 'Google refused the search.' WHERE id = 'j1'").run();
  assert.equal((await get(DB, now)).today, "Searched Widnes at 06:02 — it failed: Google refused the search.");
  assert.equal((await get(DB, new Date("2026-10-20T09:00:00Z"))).today, "Decided after 6am");
  await today(DB, { day: "2026-10-19", at: "2026-10-19T05:02:00Z", search: false, town: "Widnes", job_id: "j2",
    error: "GitHub refused to start the run (401): Bad credentials" });
  assert.equal((await get(DB, now)).today, "Couldn't start the search for Widnes: GitHub refused to start the run (401): Bad credentials");
  await today(DB, { day: "2026-10-19", at: "2026-10-19T05:00:00Z", search: false, reason: "off" });
  assert.equal((await get(DB, now)).today, "Off. Nothing is searched automatically");
});

test("GET without context.now uses the time now", async () => {
  const DB = fakeD1();
  await today(DB, { day: ukDate(new Date()), search: false, reason: "running" });
  assert.equal((await get(DB)).today, "Skipped: a search was already running");
});

test("GET: the next town skips towns searched in the last 30 days, and says when none is left", async () => {
  const DB = fakeD1(); const now = new Date("2026-10-19T09:00:00Z");
  await saveTerritory(DB, { on: true, trade: "landscaper", towns: ["Warrington", "Widnes", "Runcorn"], next: 0, max: 60 });
  await jobRow(DB, "w", "Warrington", "done", "2026-10-10T06:00:00Z");
  await jobRow(DB, "x", "Widnes", "failed", "2026-10-18T06:00:00Z"); // failed: not recent
  await jobRow(DB, "y", "Widnes", "done", "2026-10-18T06:00:00Z", { trade: "roofer" }); // another trade
  assert.equal((await get(DB, now)).upcoming, "Widnes");
  await jobRow(DB, "z", "Widnes", "done", "2026-10-18T07:00:00Z");
  assert.equal((await get(DB, now)).upcoming, "Runcorn");
  await jobRow(DB, "r", "Runcorn", "queued", "2026-10-19T05:00:00Z");
  assert.equal((await get(DB, now)).upcoming, NONE_LEFT);
  assert.equal((await get(DB, new Date("2026-11-10T09:00:00Z"))).upcoming, "Warrington"); // a month on, Warrington is due again
});

test("GET never fails on a bad saved decision or a missing job, and stays within a few D1 statements", async () => {
  const DB = fakeD1(); const now = new Date("2026-10-19T09:00:00Z");
  await setSetting(DB, "find:today", "{bad");
  assert.equal((await get(DB, now)).today, "Decided after 6am");
  await setSetting(DB, "find:today", "null");
  assert.equal((await get(DB, now)).today, "Decided after 6am");
  // today's search whose jobs row is gone (or not written yet): still a plain line, never "undefined"
  await today(DB, { day: "2026-10-19", at: "2026-10-19T05:02:00Z", search: true, town: "Widnes", job_id: "gone" });
  let statements = 0;
  const counted = { ...DB, prepare: (sql) => { statements++; return DB.prepare(sql); } };
  const resp = await onRequestGet({ env: { DB: counted }, now });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).today, "Searching Widnes (started 06:02)");
  assert.ok(statements <= 6, `GET used ${statements} D1 statements`); // territory, counts, jobs, find:today, its job (+ schema check)
});

test("GET counts good leads waiting and research queued (and nothing else)", async () => {
  const DB = fakeD1();
  for (const id of ["g1", "g2", "g3", "q1"]) await lead(DB, id);
  await lead(DB, "gx", 1);
  await research(DB, "g1", "done", "A+");
  await research(DB, "g2", "done", "B");
  await research(DB, "g3", "done", "C");
  await research(DB, "gx", "done", "A"); // excluded lead
  await research(DB, "q1", "queued");
  await research(DB, "q2", "queued");
  await jobRow(DB, "run", "Widnes", "running", "2026-10-19T05:00:00Z");
  const { counts } = await get(DB, new Date("2026-10-19T09:00:00Z"));
  assert.deepEqual(counts, { goodWaiting: 2, researchQueued: 2 });
});

// ---------------------------------------------------------------- more: PUT

test("PUT: every plain-English error, and nothing is saved", async () => {
  const DB = fakeD1();
  const cases = [
    [{ trade: "x", towns: "Leigh", max: 60 }, "Type the niche to search, e.g. landscaper"],
    ["{bad", "Type the niche to search, e.g. landscaper"],
    ["null", "Type the niche to search, e.g. landscaper"],
    [{ trade: "landscaper", towns: " \n , ", max: 60 }, "Add at least one town (one per line)"],
    [{ trade: "landscaper", towns: "Leigh", max: 5 }, "Leads per search must be between 10 and 300"],
    [{ trade: "landscaper", towns: "Leigh", max: 301 }, "Leads per search must be between 10 and 300"],
  ];
  for (const [body, error] of cases) {
    const resp = await put(DB, body);
    assert.equal(resp.status, 400);
    assert.deepEqual(await resp.json(), { error });
  }
  assert.equal(await getSetting(DB, "territory"), null);
});

test("PUT saves only the five keys Python reads, and the on switch is saved as sent", async () => {
  const DB = fakeD1();
  const resp = await put(DB, { on: false, trade: " roofer ", towns: ["Leigh", "Wigan"], max: 100, next: 9, upcoming: "Wigan" });
  assert.equal(resp.status, 200);
  const t = { on: false, trade: "roofer", towns: ["Leigh", "Wigan"], next: 0, max: 100 };
  assert.deepEqual(await resp.json(), { territory: t });
  assert.deepEqual(JSON.parse(await getSetting(DB, "territory")), t);
  assert.deepEqual(Object.keys(JSON.parse(await getSetting(DB, "territory"))), ["on", "trade", "towns", "next", "max"]);
  assert.equal((await loadTerritory(DB)).on, false);
  await put(DB, { on: true, trade: "roofer", towns: ["Leigh", "Wigan"], max: 100 });
  assert.equal((await loadTerritory(DB)).on, true);
  const { territory, upcoming } = await get(DB, new Date("2026-10-19T09:00:00Z"));
  assert.deepEqual(territory, { ...t, on: true });
  assert.equal(upcoming, "Leigh");
});
