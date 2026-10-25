// The Control Room API for demos (stage 4, docs/rebuild/05-demo.md Task 13): GET /api/demo (each look with Nik's OK,
// the leads waiting for it and 3 previews; the demo sites table), GET /api/demo/preview (one lead drawn in one look, for
// the Control Room's sandboxed frames), POST /api/demo/approve (Approve this look), GET /api/demo/check (real leads
// through checkDemoHtml) and GET /api/demo/lead/:id (the lead drawer's Demo site card), plus pickPreviews (pure).
// Handlers are called the way Pages calls them: {request, env: {DB}, params, now}.
// Run: node --test control-room/tests/demo-api.test.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { onRequest as gate } from "../functions/_middleware.js";
import { countingDB } from "../functions/_lib/d1count.js";
import { checkDemoHtml } from "../functions/_lib/demo/check.js";
import { buildDemoData } from "../functions/_lib/demo/data.js";
import { renderSite, TEMPLATES } from "../functions/_lib/demo/render.js";
import { DEMO_BASE, ensureDemo } from "../functions/_lib/demo-db.js";
import { db } from "../functions/_lib/util.js";
import { onRequestPost as approveRoute } from "../functions/api/demo/approve.js";
import { onRequestGet as checkRoute } from "../functions/api/demo/check.js";
import { onRequestGet as demoRoute, pickPreviews } from "../functions/api/demo/index.js";
import { onRequestGet as leadRoute } from "../functions/api/demo/lead/[id].js";
import { onRequestGet as previewRoute } from "../functions/api/demo/preview.js";
import { onRequestGet as publicDemo } from "../functions/d/[slug]/index.js";
import { LEADS, NASTY, nastyLead } from "./fixtures/demo-fixtures.mjs";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { seedDemo, seedLead, seedProspect, seedResearch, seedSuppression } from "./helpers/shortlistSeed.mjs";

const ORIGIN = "https://control.example";
const NOW = new Date("2026-10-21T10:00:00Z"); // a Wednesday: the weekday offer
// Part A "Errors in plain English" and Task 13's interfaces, word for word.
const CHANGED = "This look changed since you opened the page. Refresh and check it again before approving.";
const NO_PREVIEW = "There's no graded lead to preview this look with yet. Approve it once research grades one.";
const GONE = "That lead isn't in the database any more.";
const NO_LOOK = "That look doesn't exist. The looks are: generic, landscaper.";
const WAITING = "Waiting for you to approve the Landscaper look on the Demo page";
// Part A §6's CSP, framed by the Control Room itself instead of nobody. A preview has no beacon and is served on the
// logged-in Control Room origin, so no script runs and nothing connects, even if the URL is opened outside its frame.
const PREVIEW_CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const SLUG = /^[a-z0-9-]{3,60}$/;

// db() checks the schema once per isolate (3 statements the first time). Done here, so the statement counts below are
// the routes' own.
await db({ DB: fakeD1() });

// ---------------------------------------------------------------- seeding

// The 5 landscaper fixtures, newest research first, and when each was researched.
const LANDSCAPERS = ["full", "paleColour", "noPhotos", "httpPhotos", "bare"];
const RESEARCHED = {
  full: "2026-10-20T12:00:00Z", paleColour: "2026-10-20T11:00:00Z", noPhotos: "2026-10-20T10:00:00Z",
  httpPhotos: "2026-10-20T09:00:00Z", bare: "2026-10-20T08:00:00Z",
};
const id = (key) => LEADS[key].place_id;

/** A fixture lead and (unless research is null) its research row, with overrides. → its place_id. */
async function addFixture(DB, key, { lead = {}, research = {} } = {}) {
  const { research: row, ...rest } = LEADS[key];
  await seedLead(DB, { ...rest, ...lead });
  if (research !== null) await seedResearch(DB, { ...row, ...research });
  return lead.place_id ?? rest.place_id;
}

/**
 * The spec's seed: 5 landscapers graded A or B with an email (full and noPhotos with their demo and ready prospect
 * made by ensureDemo) and 2 generic leads, neither graded A+, A or B (the kickboxing gym graded C, the roofer still
 * queued).
 */
async function scenario() {
  const DB = fakeD1();
  for (const key of LANDSCAPERS) await addFixture(DB, key, { research: { researched_at: RESEARCHED[key] } });
  await addFixture(DB, "kickboxing", { research: { grade: "C" } });
  await addFixture(DB, "roofer", { research: { status: "queued", grade: null, researched_at: null } });
  for (const key of ["full", "noPhotos"]) assert.equal((await ensureDemo(DB, id(key), NOW)).ok, true, key);
  return DB;
}

// ---------------------------------------------------------------- requests

/** A request as Pages hands it to a handler, with the tests' clock. */
function ctx(DB, path, { method = "GET", body, params = {}, now = NOW } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return { request: new Request(`${ORIGIN}${path}`, init), env: { DB }, params, now };
}
const getDemo = async (DB) => {
  const res = await demoRoute(ctx(DB, "/api/demo"));
  assert.equal(res.status, 200);
  return res.json();
};
const approve = (DB, body) => approveRoute(ctx(DB, "/api/demo/approve", { method: "POST", body }));
const previewPath = (template, place_id) =>
  `/api/demo/preview?template=${encodeURIComponent(template)}&place_id=${encodeURIComponent(place_id)}`;
const preview = (DB, template, place_id) => previewRoute(ctx(DB, previewPath(template, place_id)));
const check = async (DB, query = "?limit=10") => {
  const res = await checkRoute(ctx(DB, `/api/demo/check${query}`));
  assert.equal(res.status, 200);
  return res.json();
};
const leadInfo = async (DB, place_id) => {
  const res = await leadRoute(ctx(DB, `/api/demo/lead/${encodeURIComponent(place_id)}`, { params: { id: place_id } }));
  assert.equal(res.status, 200);
  return res.json();
};
const lookOf = (body, look) => body.templates.find((t) => t.id === look);

const one = (DB, sql, ...args) => DB.raw.prepare(sql).get(...args);
const setting = (DB, key) => one(DB, "SELECT value FROM settings WHERE key = ?", key)?.value ?? null;

/** The headers every preview response carries: framed by the Control Room only, never indexed, cached or referred. */
function assertPreviewHeaders(res, label) {
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8", `${label}: content-type`);
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN", `${label}: x-frame-options`);
  assert.equal(res.headers.get("content-security-policy"), PREVIEW_CSP, `${label}: CSP`);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow", `${label}: x-robots-tag`);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer", `${label}: referrer-policy`);
  assert.equal(res.headers.get("cache-control"), "no-store", `${label}: cache-control`);
}

// ---------------------------------------------------------------- the spec's tests (Task 13, Step 1)

test("pickPreviews returns 3 distinct leads incl. one with photos and one without", async () => {
  const DB = await scenario();
  const picks = lookOf(await getDemo(DB), "landscaper").previews;
  assert.equal(picks.length, 3);
  assert.equal(new Set(picks.map((p) => p.place_id)).size, 3);
  assert.ok(picks.some((p) => p.photos >= 2), "one with photos");
  assert.ok(picks.some((p) => p.photos === 0), "one without");

  const rows = [
    { place_id: "a", grade: "B", researched_at: "2026-10-20T12:00:00Z", photos: 4, services: 5, reviews: 3, logo: true },
    { place_id: "b", grade: "A", researched_at: "2026-10-20T11:00:00Z", photos: 3, services: 8, reviews: 3, logo: true },
    { place_id: "c", grade: "A+", researched_at: "2026-10-20T10:00:00Z", photos: 0, services: 4, reviews: 2, logo: true },
    { place_id: "d", grade: "B", researched_at: "2026-10-20T09:00:00Z", photos: 0, services: 0, reviews: 0, logo: false },
    { place_id: "e", grade: "A+", researched_at: "2026-10-20T08:00:00Z", photos: 1, services: 2, reviews: 1, logo: true },
  ];
  const picked = pickPreviews(rows);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((r) => r.place_id)).size, 3);
  assert.ok(picked.some((r) => r.photos >= 2));
  assert.ok(picked.some((r) => r.photos === 0));
});

test("GET /api/demo shows waiting: 2 for landscaper when 2 ready prospects use it and approved: false", async () => {
  const DB = await scenario();
  const body = await getDemo(DB);
  const land = lookOf(body, "landscaper");
  assert.equal(land.waiting, 2);
  assert.equal(land.approved, false);
});

test("approve with version 1 → 200 then approved: true; version 0 → 409 with the exact message", async () => {
  const DB = await scenario();
  const stale = await approve(DB, { template: "landscaper", version: 0 });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: CHANGED });
  assert.equal(setting(DB, "demo:template:landscaper:approved"), null, "a refused approval stores nothing");

  const res = await approve(DB, { template: "landscaper", version: 1 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(lookOf(await getDemo(DB), "landscaper").approved, true);
});

test("approve generic with no graded generic lead → 400", async () => {
  const DB = await scenario();
  const res = await approve(DB, { template: "generic", version: 1 });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: NO_PREVIEW });
  assert.equal(setting(DB, "demo:template:generic:approved"), null);
});

test("preview of a missing lead → 404", async () => {
  const DB = await scenario();
  const res = await preview(DB, "landscaper", "no-such-lead");
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /That lead isn&#39;t in the database any more\./);
  assertPreviewHeaders(res, "404");
});

test("check?limit=10 returns ≤ 10 rows with problems: [] for clean fixtures", async () => {
  const DB = fakeD1();
  for (const key of Object.keys(LEADS)) await addFixture(DB, key);
  const { rows } = await check(DB, "?limit=10");
  assert.ok(rows.length <= 10);
  assert.equal(rows.length, 10, "all 10 fixtures qualify");
  for (const r of rows) {
    assert.deepEqual(r.problems, [], r.place_id);
    assert.ok(r.bytes > 0 && r.bytes < 100000, `${r.place_id}: ${r.bytes} bytes`);
  }
});

test("lead/:id returns ready.reason 'No demo yet: Grade C: only A+, A and B get a demo' for a C lead", async () => {
  const DB = await scenario();
  const info = await leadInfo(DB, id("kickboxing"));
  assert.equal(info.ready.reason, "No demo yet: Grade C: only A+, A and B get a demo");
  assert.equal(info.ready.ok, false);
  assert.equal(info.demo, null);
});

// ---------------------------------------------------------------- pickPreviews (pure)

const ROWS = Object.freeze([
  Object.freeze({ place_id: "a", grade: "B", researched_at: "2026-10-20T12:00:00Z", photos: 4, services: 5, reviews: 3, logo: true }),
  Object.freeze({ place_id: "b", grade: "A", researched_at: "2026-10-20T11:00:00Z", photos: 3, services: 8, reviews: 3, logo: true }),
  Object.freeze({ place_id: "c", grade: "A+", researched_at: "2026-10-20T10:00:00Z", photos: 0, services: 4, reviews: 2, logo: true }),
  Object.freeze({ place_id: "d", grade: "B", researched_at: "2026-10-20T09:00:00Z", photos: 0, services: 0, reviews: 0, logo: false }),
  Object.freeze({ place_id: "e", grade: "A+", researched_at: "2026-10-20T08:00:00Z", photos: 1, services: 2, reviews: 1, logo: true }),
]);
const picks = (rows) => pickPreviews(rows).map((r) => r.place_id);

test("pickPreviews: newest with 2+ photos, newest with none, then the one with the least data", () => {
  assert.deepEqual(picks(ROWS), ["a", "c", "d"]);
  assert.equal(pickPreviews(ROWS)[0], ROWS[0], "the rows it was given, not copies");
  // newest research first whatever order they come in
  assert.deepEqual(picks([...ROWS].reverse()), ["a", "c", "d"]);
  assert.deepEqual(picks([ROWS[3], ROWS[1], ROWS[4], ROWS[0], ROWS[2]]), ["a", "c", "d"]);
});

test("pickPreviews: the least data counts services, reviews, photos and the logo; ties go to the newest", () => {
  const thin = (place_id, researched_at, o) => ({ place_id, grade: "A", researched_at, photos: 0, services: 0, reviews: 0, logo: false, ...o });
  const rows = [
    { place_id: "rich", grade: "A", researched_at: "2026-10-20T12:00:00Z", photos: 6, services: 8, reviews: 3, logo: true },
    thin("no-photos", "2026-10-20T11:00:00Z", { services: 3, reviews: 2, logo: true }), // 6
    thin("logo-only", "2026-10-20T10:00:00Z", { photos: 1, logo: true }), // 2
    thin("one-review", "2026-10-20T09:00:00Z", { photos: 1, reviews: 1 }), // 2, older
    thin("services", "2026-10-20T08:00:00Z", { photos: 1, services: 3 }), // 4
  ];
  assert.deepEqual(picks(rows), ["rich", "no-photos", "logo-only"]);
  assert.deepEqual(picks(rows.slice(0, 2).concat(rows[3], rows[4])), ["rich", "no-photos", "one-review"]);
});

test("pickPreviews: no duplicates, filled to 3 by best grade (newest first within a grade)", () => {
  const row = (place_id, grade, researched_at, o) => ({ place_id, grade, researched_at, photos: 3, services: 4, reviews: 2, logo: true, ...o });
  // The newest without photos is also the one with the least data: the third goes to the best grade left.
  const rows = [
    row("b1", "B", "2026-10-20T12:00:00Z"),
    row("thin", "B", "2026-10-20T11:00:00Z", { photos: 0, services: 0, reviews: 0, logo: false }),
    row("a-old", "A", "2026-10-20T08:00:00Z"),
    row("ap", "A+", "2026-10-20T09:00:00Z"),
    row("a-new", "A", "2026-10-20T10:00:00Z"),
  ];
  assert.deepEqual(picks(rows), ["b1", "thin", "ap"]);
  // No lead with 2+ photos: none, the least data, then the best grade.
  const fewPhotos = rows.map((r) => ({ ...r, photos: r.place_id === "thin" ? 0 : 1 }));
  assert.deepEqual(picks(fewPhotos), ["thin", "ap", "a-new"]);
  // Fewer than 3 leads: each once.
  assert.deepEqual(picks([rows[0], rows[1]]), ["b1", "thin"]);
  assert.deepEqual(picks([rows[0]]), ["b1"]);
  assert.deepEqual(picks([rows[0], { ...rows[0] }, { ...rows[0], photos: 0 }]), ["b1"], "one place_id is one lead");
});

test("pickPreviews: only leads graded A+, A or B; anything else gives []", () => {
  const rows = [
    { place_id: "c", grade: "C", researched_at: "2026-10-20T12:00:00Z", photos: 4, services: 1, reviews: 1, logo: true },
    { place_id: "d", grade: "D", researched_at: "2026-10-20T11:00:00Z", photos: 0, services: 0, reviews: 0, logo: false },
    { place_id: "none", grade: null, researched_at: "2026-10-20T10:00:00Z", photos: 0, services: 0, reviews: 0, logo: false },
    { place_id: "b", grade: "B", researched_at: "2026-10-20T09:00:00Z", photos: 2, services: 3, reviews: 1, logo: true },
  ];
  assert.deepEqual(picks(rows), ["b"]);
  for (const bad of [[], null, undefined, "rows", [null, 7, "x", {}]]) assert.deepEqual(pickPreviews(bad), [], String(bad));
});

// ---------------------------------------------------------------- GET /api/demo

test("GET /api/demo: each look, in the Demo page's order, with its previews; the demo sites", async () => {
  const DB = await scenario();
  const body = await getDemo(DB);
  assert.deepEqual(Object.keys(body).sort(), ["demos", "templates"]);
  assert.deepEqual(body.templates.map((t) => t.id), ["landscaper", "generic"], "Landscaper look, then Everything else");

  const land = lookOf(body, "landscaper");
  assert.deepEqual(Object.keys(land).sort(),
    ["approved", "approved_at", "approved_version", "id", "label", "previews", "version", "waiting"]);
  assert.equal(land.label, TEMPLATES.landscaper.TEMPLATE.label);
  assert.equal(land.label, "Landscaper");
  assert.equal(land.version, TEMPLATES.landscaper.TEMPLATE.version);
  assert.equal(land.approved_at, null);
  assert.equal(land.approved_version, null);
  // newest research first: full has 6 photos, noPhotos is the newest with none, bare has the least data
  assert.deepEqual(land.previews, [
    { place_id: "fx-full", name: "Green Leaf Landscapes", town: "Warrington", photos: 6, problems: [] },
    { place_id: "fx-no-photos", name: "Hedge & Edge Garden Services", town: "Widnes", photos: 0, problems: [] },
    { place_id: "fx-bare", name: "Tidy Gardens", town: "", photos: 0, problems: [] },
  ]);

  // No generic lead is graded A+, A or B: nothing to preview, nobody waiting.
  assert.deepEqual(lookOf(body, "generic"), {
    id: "generic", label: "Everything else", version: TEMPLATES.generic.TEMPLATE.version, approved: false,
    approved_at: null, approved_version: null, waiting: 0, previews: [],
  });

  assert.equal(body.demos.length, 2);
  for (const d of body.demos) {
    assert.deepEqual(Object.keys(d).sort(),
      ["expires_at", "grade", "last_view_at", "name", "place_id", "slug", "stage", "url", "views"]);
    assert.match(d.slug, SLUG);
    assert.equal(d.url, `${DEMO_BASE}/d/${d.slug}`);
    assert.equal(d.url, `https://aetoswebsites.com/d/${d.slug}`);
    assert.equal(d.stage, "ready");
    assert.equal(d.views, 0);
    assert.equal(d.last_view_at, null);
    assert.equal(d.expires_at, "2027-04-19T10:00:00Z");
  }
  const full = body.demos.find((d) => d.place_id === "fx-full");
  assert.equal(full.name, LEADS.full.name, "the lead's name as the Leads page shows it");
  assert.equal(full.grade, "A");
  assert.match(full.slug, /^green-leaf-landscapes-[a-hj-km-np-z2-9]{6}$/);
});

test("GET /api/demo: an approved look, a look changed since its approval, and every graded look previewed", async () => {
  const DB = await scenario();
  assert.equal((await approve(DB, { template: "landscaper", version: 1 })).status, 200);
  let land = lookOf(await getDemo(DB), "landscaper");
  assert.equal(land.approved, true);
  assert.equal(land.approved_version, 1);
  assert.equal(land.approved_at, "2026-10-21T10:00:00Z");
  assert.equal(land.waiting, 0, "nobody waits for an approved look");
  assert.equal(land.previews.length, 3, "Look again shows the previews");

  // An OK of an older version (a redesign since): not approved, and the page can say which version was.
  await DB.prepare("UPDATE settings SET value = ? WHERE key = 'demo:template:landscaper:approved'")
    .bind(JSON.stringify({ version: 0, at: "2026-10-01T09:00:00Z" })).run();
  land = lookOf(await getDemo(DB), "landscaper");
  assert.equal(land.approved, false);
  assert.equal(land.approved_version, 0);
  assert.equal(land.approved_at, "2026-10-01T09:00:00Z");
  assert.equal(land.waiting, 2);

  // A generic lead graded A+ (no demo yet) is previewable; ungraded, excluded and other-look leads never are.
  await addFixture(DB, "electrician");
  await addFixture(DB, "locksmith", { lead: { excluded: 1, exclude_reason: "Chain" } });
  const generic = lookOf(await getDemo(DB), "generic");
  assert.deepEqual(generic.previews.map((p) => p.place_id), ["fx-electrician"]);
  assert.deepEqual(generic.previews[0], { place_id: "fx-electrician", name: "Bright Spark Electrical", town: "Wigan", photos: 4, problems: [] });
  assert.equal(generic.waiting, 0);
});

test("GET /api/demo: a look is previewed with photos (and without) even when the newest 30 graded leads all lack (or all have) them", async () => {
  // When the i-th of 32 copies was researched: all newer than the one lead of the other kind.
  const at = (i) => `2026-10-20T${String(10 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 10).padStart(2, "0")}:00Z`;
  const OLD = "2026-10-01T09:00:00Z";

  const thin = fakeD1();
  for (let i = 0; i < 32; i++) {
    const place_id = `no-photos-${String(i).padStart(2, "0")}`;
    await addFixture(thin, "noPhotos", { lead: { place_id }, research: { place_id, researched_at: at(i) } });
  }
  await addFixture(thin, "full", { research: { researched_at: OLD } });
  const c = countingDB(thin);
  const res = await demoRoute({ request: new Request(`${ORIGIN}/api/demo`), env: { DB: c.DB }, params: {}, now: NOW });
  const previews = lookOf(await res.json(), "landscaper").previews;
  assert.deepEqual(previews.map((p) => [p.place_id, p.photos]), [["fx-full", 6], ["no-photos-31", 0], ["no-photos-30", 0]]);
  assert.ok(c.used() <= 6, `still one query per look: ${c.used()} statements`);

  const rich = fakeD1();
  for (let i = 0; i < 32; i++) {
    const place_id = `photos-${String(i).padStart(2, "0")}`;
    await addFixture(rich, "full", { lead: { place_id }, research: { place_id, researched_at: at(i) } });
  }
  await addFixture(rich, "noPhotos", { research: { researched_at: OLD } });
  const picked = lookOf(await getDemo(rich), "landscaper").previews;
  assert.equal(picked.length, 3);
  assert.deepEqual(picked[0], { ...picked[0], place_id: "photos-31", photos: 6 });
  assert.deepEqual(picked[1], { ...picked[1], place_id: "fx-no-photos", photos: 0 });
});

test("GET /api/demo: the demo sites table is each lead's latest demo, last viewed first, then newest, max 200", async () => {
  const DB = fakeD1();
  const add = async (place_id, demos, prospect) => {
    await seedLead(DB, { place_id, name: `Lead ${place_id}` });
    await seedResearch(DB, { place_id, grade: "B" });
    for (const d of demos) await seedDemo(DB, { place_id, ...d });
    if (prospect) await seedProspect(DB, { place_id, ...prospect });
  };
  await add("p-viewed-early", [{ slug: "viewed-early-aaaaaa", created_at: "2026-10-01T09:00:00Z" }],
    { stage: "viewed", views: 2, last_view_at: "2026-10-20T13:00:00Z" });
  await add("p-viewed-late", [{ slug: "viewed-late-aaaaaa", created_at: "2026-09-01T09:00:00Z" }],
    { stage: "viewed", views: 1, last_view_at: "2026-10-21T09:00:00Z" });
  await add("p-new", [{ slug: "new-aaaaaa", created_at: "2026-10-21T08:00:00Z" }], { stage: "ready" });
  await add("p-old", [{ slug: "old-aaaaaa", created_at: "2026-10-02T08:00:00Z" }], null);
  await add("p-twice", [
    { slug: "twice-first-aaaaaa", created_at: "2026-04-01T08:00:00Z", expires_at: "2026-09-28T08:00:00Z" },
    { slug: "twice-second-aaaaaa", created_at: "2026-10-10T08:00:00Z" },
  ], { stage: "emailed" });
  const { demos } = await getDemo(DB);
  assert.deepEqual(demos.map((d) => d.slug), ["viewed-late-aaaaaa", "viewed-early-aaaaaa", "new-aaaaaa", "twice-second-aaaaaa", "old-aaaaaa"]);
  assert.deepEqual(demos[1], {
    place_id: "p-viewed-early", name: "Lead p-viewed-early", grade: "B", stage: "viewed", slug: "viewed-early-aaaaaa",
    url: "https://aetoswebsites.com/d/viewed-early-aaaaaa", views: 2, last_view_at: "2026-10-20T13:00:00Z",
    expires_at: "2027-01-01T00:00:00Z",
  });
  assert.equal(demos[4].stage, null, "no prospect yet");
  assert.equal(demos[4].views, 0);

  for (let i = 0; i < 200; i++) await add(`bulk-${i}`, [{ slug: `bulk-${i}-aaaaaa` }], null);
  assert.equal((await getDemo(DB)).demos.length, 200);
});

test("GET /api/demo uses at most 6 D1 statements (trades, 2 approvals, 2 preview queries, demos)", async () => {
  const DB = await scenario();
  await addFixture(DB, "electrician"); // both looks have a graded lead, so both preview queries run
  const c = countingDB(DB);
  const res = await demoRoute({ request: new Request(`${ORIGIN}/api/demo`), env: { DB: c.DB }, params: {}, now: NOW });
  assert.equal(res.status, 200);
  assert.ok(c.used() <= 6, `${c.used()} statements`);
});

test("GET /api/demo: previews of hostile text are escaped and pass the quality checks", async () => {
  for (const n of NASTY) {
    const DB = fakeD1();
    const { research, ...lead } = nastyLead(n);
    await seedLead(DB, lead);
    await seedResearch(DB, research);
    const [p] = lookOf(await getDemo(DB), "generic").previews;
    assert.equal(p.place_id, "fx-nasty", JSON.stringify(n));
    assert.deepEqual(p.problems, [], JSON.stringify(n));
    const html = await (await preview(DB, "generic", "fx-nasty")).text();
    if (/[<>"]/.test(n)) assert.equal(html.includes(n), false, `unescaped ${JSON.stringify(n)}`);
    assert.doesNotMatch(html, /<script>alert|<img src=x|<\/style><script>/, JSON.stringify(n));
  }
});

// ---------------------------------------------------------------- GET /api/demo/preview

test("preview: their demo in demo mode, framed by the Control Room, with no view beacon", async () => {
  const DB = await scenario();
  const slug = one(DB, "SELECT slug FROM demos WHERE place_id = 'fx-full'").slug;
  const res = await preview(DB, "landscaper", "fx-full");
  assert.equal(res.status, 200);
  assertPreviewHeaders(res, "200");
  const html = await res.text();
  assert.match(html, /Preview made for <b>Green Leaf Landscapes<\/b>/);
  assert.match(html, /<body data-template="landscaper"/);
  assert.ok(html.includes(`href="/d/${slug}/order"`), "their Order this site button");
  assert.doesNotMatch(html, /<script|sendBeacon/, "count_views false: opening a preview never counts");
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);

  // A graded lead with no demo row yet still previews, without an Order button.
  const pale = await (await preview(DB, "landscaper", "fx-pale-colour")).text();
  assert.match(pale, /Preview made for <b>Sunny Patios<\/b>/);
  assert.doesNotMatch(pale, /\/order"|<script/);
});

test("preview: the look asked for is the one drawn; an unknown look → 400", async () => {
  const DB = await scenario();
  const generic = await (await preview(DB, "generic", "fx-full")).text();
  assert.match(generic, /<body data-template="generic"/);
  assert.match(generic, /--main:#2e7d32/, "their own colour in any look");
  // No colour of their own: the look's default (landscaper green, generic Charcoal).
  assert.match(await (await preview(DB, "landscaper", "fx-http-photos")).text(), /--main:#2f6b3a/);
  assert.match(await (await preview(DB, "generic", "fx-http-photos")).text(), /--main:#1a1c20/);
  // A generic lead drawn in the landscaper look gets the landscaper default too.
  await addFixture(DB, "plumber", { lead: { place_id: "fx-plain" }, research: { place_id: "fx-plain" } });
  await DB.prepare("UPDATE leads SET audit = ? WHERE place_id = 'fx-plain'").bind(JSON.stringify({ brand: {} })).run();
  assert.match(await (await preview(DB, "generic", "fx-plain")).text(), /--main:#1a1c20/);
  assert.match(await (await preview(DB, "landscaper", "fx-plain")).text(), /--main:#2f6b3a/);

  for (const bad of ["", "nope", "constructor", "__proto__", "Landscaper"]) {
    const res = await preview(DB, bad, "fx-full");
    assert.equal(res.status, 400, bad);
    assertPreviewHeaders(res, `look ${JSON.stringify(bad)}`);
    assert.match(await res.text(), /That look doesn&#39;t exist\. The looks are: generic, landscaper\./, bad);
  }
  const noLook = await previewRoute(ctx(DB, "/api/demo/preview?place_id=fx-full"));
  assert.equal(noLook.status, 400);
  const noLead = await previewRoute(ctx(DB, "/api/demo/preview?template=landscaper"));
  assert.equal(noLead.status, 404);
  assert.match(await noLead.text(), /That lead isn&#39;t in the database any more\./);
});

test("preview reads one statement and is what GET /api/demo checked", async () => {
  const DB = await scenario();
  const c = countingDB(DB);
  const res = await previewRoute({ request: new Request(`${ORIGIN}${previewPath("landscaper", "fx-bare")}`), env: { DB: c.DB }, params: {}, now: NOW });
  assert.equal(res.status, 200);
  assert.equal(c.used(), 1);
  const html = await res.text();
  assert.match(html, /Your services will go here/, "the bare lead's services placeholder, never a default list");
});

test("preview: odd audits are read as buildDemoData reads the whole audit (reviews as text, a broken audit)", async () => {
  const { research, ...lead } = LEADS.full;
  const audit = typeof lead.audit === "string" ? JSON.parse(lead.audit) : lead.audit;
  const odd = [
    { ...audit, reviews: JSON.stringify(audit.reviews) }, // a list written as text is not a list
    { ...audit, brand: JSON.stringify(audit.brand) }, // a brand written as JSON text is still read
    { ...audit, reviews: 7, brand: "logo.png" },
    "{not json",
  ];
  for (const a of odd) {
    const DB = fakeD1();
    await seedLead(DB, { ...lead, audit: typeof a === "string" ? a : JSON.stringify(a) });
    await seedResearch(DB, research);
    const html = await (await preview(DB, "landscaper", "fx-full")).text();
    const raw = one(DB, "SELECT * FROM leads WHERE place_id = 'fx-full'");
    const data = buildDemoData({ lead: raw, research: one(DB, "SELECT * FROM research WHERE place_id = 'fx-full'"), demo: null, now: NOW });
    assert.equal(html, renderSite(data, { now: NOW }), JSON.stringify(a).slice(0, 60));
  }
});

// ---------------------------------------------------------------- POST /api/demo/approve

test("approve closes the look's setup todo and stores {version, at}", async () => {
  const DB = await scenario();
  const todo = one(DB, "SELECT id, status FROM todos WHERE dedupe = 'setup:demo-template:landscaper:v1'");
  assert.equal(todo.status, "open");
  assert.equal((await approve(DB, { template: "landscaper", version: 1 })).status, 200);
  assert.deepEqual(JSON.parse(setting(DB, "demo:template:landscaper:approved")), { version: 1, at: "2026-10-21T10:00:00Z" });
  assert.equal(one(DB, "SELECT status FROM todos WHERE id = ?", todo.id).status, "done");
});

test("approve: an unknown look or a bad body → 400; a version that isn't the number shown → 409; nothing stored", async () => {
  const DB = await scenario();
  for (const body of [{ template: "nope", version: 1 }, { template: "constructor", version: 1 }, { version: 1 }, ["landscaper"], "not json", null]) {
    const res = await approve(DB, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: NO_LOOK }, JSON.stringify(body));
  }
  for (const version of ["1", 2, null, undefined, 1.5, true]) {
    const res = await approve(DB, { template: "landscaper", version });
    assert.equal(res.status, 409, JSON.stringify(version));
    assert.deepEqual(await res.json(), { error: CHANGED });
  }
  assert.equal(setting(DB, "demo:template:landscaper:approved"), null);
  assert.equal(lookOf(await getDemo(DB), "landscaper").approved, false);
});

test("approve: an excluded or ungraded lead isn't one to preview with; a graded one is", async () => {
  const DB = await scenario();
  await addFixture(DB, "electrician", { lead: { excluded: 1, exclude_reason: "Chain" } });
  await addFixture(DB, "locksmith", { research: { grade: "D" } });
  assert.equal((await approve(DB, { template: "generic", version: 1 })).status, 400);
  await addFixture(DB, "plumber");
  const res = await approve(DB, { template: "generic", version: 1 });
  assert.equal(res.status, 200);
  assert.equal(lookOf(await getDemo(DB), "generic").approved, true);
});

test("approve uses 3 D1 statements (the trades, then the setting and closing its todos)", async () => {
  const DB = await scenario();
  const c = countingDB(DB);
  const res = await approveRoute({
    request: new Request(`${ORIGIN}/api/demo/approve`, { method: "POST", body: JSON.stringify({ template: "landscaper", version: 1 }) }),
    env: { DB: c.DB }, params: {}, now: NOW,
  });
  assert.equal(res.status, 200);
  assert.equal(c.used(), 3);
});

// ---------------------------------------------------------------- GET /api/demo/check

/** All 10 fixtures, researched one hour apart in LEADS order (the last one newest), plus leads that don't qualify. */
async function checkSeed() {
  const DB = fakeD1();
  const keys = Object.keys(LEADS);
  for (const [i, key] of keys.entries()) {
    await addFixture(DB, key, { research: { researched_at: `2026-10-20T${String(i).padStart(2, "0")}:00:00Z` } });
  }
  // Newer than every fixture, but none of them qualifies (Part A §1).
  const late = "2026-10-21T09:00:00Z";
  const copy = (place_id, lead, research) => addFixture(DB, "roofer", {
    lead: { place_id, ...lead }, research: { place_id, researched_at: late, ...research },
  });
  await copy("x-grade-c", {}, { grade: "C" });
  await copy("x-queued", {}, { status: "queued" });
  await copy("x-excluded", { excluded: 1, exclude_reason: "Chain" }, {});
  await copy("x-too-big", {}, { too_big: 1 });
  await copy("x-no-email", {}, { best_email: "" });
  await copy("x-blank-email", {}, { best_email: "   " });
  await copy("x-opted-out", {}, { best_email: "Owner@Opted-Out.example" });
  await seedSuppression(DB, "owner@opted-out.example");
  await copy("x-domain", {}, { best_email: "sales@blocked.example" });
  await seedSuppression(DB, "blocked.example", "domain");
  return { DB, keys };
}

test("check: only leads that qualify for a demo, newest research first, each drawn as its prospect sees it", async (t) => {
  const { DB, keys } = await checkSeed();
  const { rows } = await check(DB);
  const newestFirst = keys.map((k) => LEADS[k].place_id).reverse();
  assert.deepEqual(rows.map((r) => r.place_id), newestFirst);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ["bytes", "name", "place_id", "problems", "template"]);
  }
  const byId = Object.fromEntries(rows.map((r) => [r.place_id, r]));
  assert.equal(byId["fx-full"].template, "landscaper");
  assert.equal(byId["fx-full"].name, "Green Leaf Landscapes");
  assert.equal(byId["fx-kickboxing"].template, "generic");
  assert.equal(byId["fx-kickboxing"].name, "Diamond Kickboxing Academy");

  // A lead with its demo: exactly the bytes GET /d/<slug> sends its prospect (Order button and beacon included).
  const made = await ensureDemo(DB, "fx-full", NOW);
  const withDemo = (await check(DB)).rows.find((r) => r.place_id === "fx-full");
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const page = await publicDemo({ env: { DB }, params: { slug: made.demo.slug } });
  t.mock.timers.reset();
  assert.equal(page.status, 200);
  const sent = new TextEncoder().encode(await page.text()).length;
  assert.equal(withDemo.bytes, sent);
  assert.ok(withDemo.bytes > byId["fx-full"].bytes, "the demo's Order button and view beacon are counted");
  assert.deepEqual(withDemo.problems, []);
});

test("check: limit is 1 to 10 (10 when missing or unreadable)", async () => {
  const { DB } = await checkSeed();
  // 15 leads qualify, so a limit above 10 would show.
  for (let i = 1; i <= 5; i++) {
    await addFixture(DB, "kickboxing", { lead: { place_id: `y-${i}` }, research: { place_id: `y-${i}`, researched_at: "2026-10-19T09:00:00Z" } });
  }
  assert.deepEqual((await check(DB, "?limit=3")).rows.map((r) => r.place_id), ["fx-electrician", "fx-locksmith", "fx-plumber"]);
  assert.equal((await check(DB, "?limit=1")).rows.length, 1);
  assert.equal((await check(DB, "?limit=10")).rows.length, 10);
  for (const q of ["?limit=50", "?limit=11", "", "?limit=abc", "?limit=0", "?limit=-3", "?limit=2.5", "?limit="]) {
    assert.equal((await check(DB, q)).rows.length, 10, q);
  }
});

test("check: a page that can't be drawn is a plain-English problem on its row, not a failed request", async () => {
  const DB = fakeD1();
  await addFixture(DB, "full", { research: { researched_at: "2026-10-20T12:00:00Z" } });
  await addFixture(DB, "roofer", { research: { researched_at: "2026-10-20T11:00:00Z" } });
  await seedDemo(DB, { place_id: "fx-full", slug: "Not A Slug!" });
  const { rows } = await check(DB);
  assert.equal(rows.length, 2);
  const [broken, fine] = rows;
  assert.equal(broken.place_id, "fx-full");
  assert.equal(broken.template, "landscaper");
  assert.equal(broken.bytes, 0);
  assert.equal(broken.problems.length, 1);
  assert.match(broken.problems[0], /^Couldn't draw this page: This demo's slug isn't valid/);
  assert.deepEqual(fine.problems, []);
});

test("check uses 2 D1 statements (the leads, then the do-not-contact list)", async () => {
  const { DB } = await checkSeed();
  const c = countingDB(DB);
  const res = await checkRoute({ request: new Request(`${ORIGIN}/api/demo/check?limit=10`), env: { DB: c.DB }, params: {}, now: NOW });
  assert.equal(res.status, 200);
  assert.equal(c.used(), 2);
});

// ---------------------------------------------------------------- GET /api/demo/lead/:id

test("lead/:id: the demo, its views and demoReady, before and after the look is approved", async () => {
  const DB = await scenario();
  await DB.prepare("UPDATE prospects SET views = 3, last_view_at = '2026-10-20T13:05:00Z' WHERE place_id = 'fx-full'").run();
  const row = one(DB, "SELECT slug, expires_at FROM demos WHERE place_id = 'fx-full'");
  const before = await leadInfo(DB, "fx-full");
  assert.deepEqual(before, {
    demo: { slug: row.slug, url: `https://aetoswebsites.com/d/${row.slug}`, expires_at: row.expires_at },
    views: 3,
    last_view_at: "2026-10-20T13:05:00Z",
    stage: "ready",
    ready: { ok: false, reason: WAITING, url: null, slug: null },
  });
  assert.equal((await approve(DB, { template: "landscaper", version: 1 })).status, 200);
  const after = await leadInfo(DB, "fx-full");
  assert.deepEqual(after.ready, { ok: true, reason: "", url: `https://aetoswebsites.com/d/${row.slug}`, slug: row.slug });
  assert.deepEqual(after.demo, before.demo);
});

test("lead/:id: a lead that qualifies but missed its demo gets it from demoReady, and the card shows it", async () => {
  const DB = await scenario();
  assert.equal(one(DB, "SELECT COUNT(*) AS n FROM demos WHERE place_id = 'fx-pale-colour'").n, 0);
  const info = await leadInfo(DB, "fx-pale-colour");
  assert.equal(info.ready.reason, WAITING);
  assert.ok(info.demo, "read after demoReady made it");
  assert.match(info.demo.slug, /^sunny-patios-[a-hj-km-np-z2-9]{6}$/);
  assert.equal(info.demo.url, `https://aetoswebsites.com/d/${info.demo.slug}`);
  assert.equal(info.views, 0);
  assert.equal(info.last_view_at, null);
});

test("lead/:id: a lead that's gone, or was never researched", async () => {
  const DB = await scenario();
  assert.deepEqual(await leadInfo(DB, "no-such-lead"), {
    demo: null, views: 0, last_view_at: null, stage: null, ready: { ok: false, reason: "No demo yet: Lead not found", url: null, slug: null },
  });
  const queued = await leadInfo(DB, id("roofer"));
  assert.equal(queued.ready.reason, "No demo yet: Not researched yet");
  assert.equal(queued.demo, null);
});

test("lead/:id: a won prospect's demo is ready whatever expires_at says, and the answer carries its stage", async () => {
  const DB = await scenario();
  assert.equal((await approve(DB, { template: "landscaper", version: 1 })).status, 200);
  await DB.prepare("UPDATE prospects SET stage = 'won' WHERE place_id = 'fx-full'").run();
  await DB.prepare("UPDATE demos SET expires_at = '2026-01-01T00:00:00Z' WHERE place_id = 'fx-full'").run();
  const { slug } = one(DB, "SELECT slug FROM demos WHERE place_id = 'fx-full'");
  const info = await leadInfo(DB, "fx-full");
  assert.equal(info.stage, "won");
  assert.deepEqual(info.ready, { ok: true, reason: "", url: `https://aetoswebsites.com/d/${slug}`, slug });
  assert.deepEqual(info.demo, { slug, url: `https://aetoswebsites.com/d/${slug}`, expires_at: "2026-01-01T00:00:00Z" });
  // a lead with no prospect yet: stage null
  assert.equal((await leadInfo(DB, id("roofer"))).stage, null);
});

test("lead/:id uses 2 D1 statements for a lead that has its demo (demoReady, then the card's facts)", async () => {
  const DB = await scenario();
  const c = countingDB(DB);
  const res = await leadRoute({ request: new Request(`${ORIGIN}/api/demo/lead/fx-full`), env: { DB: c.DB }, params: { id: "fx-full" }, now: NOW });
  assert.equal(res.status, 200);
  assert.equal(c.used(), 2);
});

// ---------------------------------------------------------------- behind the login; the old route is gone

test("every /api/demo route is behind the login", async () => {
  const DB = await scenario();
  const env = { DB, CONTROL_ROOM_PASSWORD: "correct horse battery staple" };
  const paths = ["/api/demo", "/api/demo/preview?template=landscaper&place_id=fx-full", "/api/demo/approve", "/api/demo/check?limit=10", "/api/demo/lead/fx-full"];
  for (const path of paths) {
    const method = path.endsWith("approve") ? "POST" : "GET";
    const res = await gate({
      request: new Request(`https://control-room.pages.dev${path}`, { method }),
      env,
      next: () => assert.fail(`${path} reached its function without a login`),
    });
    assert.equal(res.status, 401, path);
    assert.deepEqual(await res.json(), { error: "Not logged in" }, path);
  }
});

test("POST /api/demos is gone and nothing in the Control Room calls it", () => {
  assert.equal(existsSync(new URL("../functions/api/demos.js", import.meta.url)), false);
  const dir = new URL("../public/js/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /\/api\/demos\b/, f);
  }
});

test("the lead drawer's Preview frame asks for the URL the preview route answers", () => {
  const src = readFileSync(new URL("../public/js/leadview.js", import.meta.url), "utf8");
  assert.match(src, /\/api\/demo\/preview\?template=\$\{encodeURIComponent\(template\)\}&place_id=/);
  assert.match(src, /<iframe[^>]*sandbox=""/);
});

test("the problems GET /api/demo lists are checkDemoHtml's, on the page the preview frame shows", async () => {
  const DB = await scenario();
  const html = await (await preview(DB, "landscaper", "fx-full")).text();
  const [listed] = lookOf(await getDemo(DB), "landscaper").previews;
  assert.equal(listed.place_id, "fx-full");
  // The same page drawn from the fixture's data passes the same check the route ran.
  const { research, ...lead } = LEADS.full;
  const data = buildDemoData({ lead, research, demo: { slug: one(DB, "SELECT slug FROM demos WHERE place_id = 'fx-full'").slug, count_views: false }, now: NOW });
  assert.equal(renderSite(data, { now: NOW }), html, "the frame's page is the fixture's page in demo mode, no beacon");
  assert.deepEqual(checkDemoHtml(html, data, { now: NOW }), listed.problems);
});
