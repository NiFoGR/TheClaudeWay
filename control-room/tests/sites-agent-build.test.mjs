// The build Routine's API (stage 10, 09-build.md Part A §6, Part B Task 14): GET /api/agent/build/:client_id hands
// Claude everything it may use (the client's form, their lead, research, Google reviews, photos, the facts the form
// proves and every limit); POST /api/agent/build/:client_id/content checks the site content (validateContent), copies
// the photos (copyPhotos), stores it (saveContent) and files the Approve or "Claude updated" todo.
// Run: node --test control-room/tests/sites-agent-build.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formFacts, LIMITS } from "../functions/_lib/sites/content.js";
import { ensureSite, setSiteStatus } from "../functions/_lib/sites/db.js";
import { addTodo } from "../functions/_lib/todo.js";
import { setSecret } from "../functions/_lib/settings.js";
import { onRequestGet } from "../functions/api/agent/build/[client_id].js";
import { onRequestPost } from "../functions/api/agent/build/[client_id]/content.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const FX = JSON.parse(readFileSync(new URL("./fixtures/site-content.json", import.meta.url), "utf8"));
const CTX = JSON.parse(readFileSync(new URL("./fixtures/site-ctx.json", import.meta.url), "utf8"));
const JPG = new Uint8Array(readFileSync(new URL("./fixtures/img/3x2.jpg", import.meta.url)));
const PNG = new Uint8Array(readFileSync(new URL("./fixtures/img/3x2.png", import.meta.url)));
const fx = () => structuredClone(FX);

const KEY = randomBytes(32).toString("base64url");
const ORIGIN = "https://control.example";
const SUBMITTED = "2026-10-24T22:30:00Z";
const DUE = "2026-10-31T22:30:00Z";
const NOW = new Date("2026-10-26T10:00:00Z");
const NOW_ISO = "2026-10-26T10:00:00Z";
const FILE_ID = CTX.files[0].id; // the chimney photo already copied for this client (the fixture's /s/f/ photo)

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

/**
 * Smith Roofing (client c1, full package) with its lead (Google reviews and brand from site-ctx.json), research, a
 * submitted onboarding form (site-ctx.json's), its site row and the one photo already in site_files.
 * `submitted: false` leaves the form unsent.
 */
async function seed({ submitted = true } = {}) {
  const DB = fakeD1();
  await setSecret(DB, "agent_token", KEY);
  await insert(DB, "leads", {
    place_id: "p-c1", name: "Smith Roofing", trade: "roofer", search_town: "Swindon", town: "Swindon",
    address: "12 High St, Swindon SN1 1AA", postcode: "SN1 1AA", phone: "01793 123456",
    website: "https://smithroofing.co.uk", maps_url: "https://maps.google.com/?cid=1", rating: 4.9, review_count: 37,
    socials: JSON.stringify({ facebook: "https://www.facebook.com/smithroofing" }),
    audit: JSON.stringify({ reviews: CTX.reviews, brand: CTX.brand, findings: [] }),
    first_seen_at: SUBMITTED, updated_at: SUBMITTED,
  });
  await insert(DB, "research", {
    place_id: "p-c1", status: "done", grade: "A",
    copy: JSON.stringify({ headline: "Roof repairs in Swindon", services: ["Roof repairs"] }),
    owner: JSON.stringify({ first: "John", full: "John Smith", source_url: "https://smithroofing.co.uk/about", confident: true }),
    site_review: JSON.stringify({ verdict: "dated", summary: "Old site", problems: [], good: [] }),
    angle: JSON.stringify([{ fact: "37 reviews at 4.9", source_url: "https://maps.google.com/?cid=1" }]),
  });
  await insert(DB, "clients", {
    id: "c1", name: "Smith Roofing", place_id: "p-c1", package: "full", build_fee_pence: 195000, monthly_pence: 24900,
    free_days: 60, paid_on: "2026-10-24", created_at: SUBMITTED,
  });
  await insert(DB, "onboarding", {
    client_id: "c1", token: "t".repeat(32), status: submitted ? "building" : "sent", form: JSON.stringify(CTX.form),
    submitted_at: submitted ? SUBMITTED : null, due_live_at: submitted ? DUE : null, created_at: SUBMITTED,
  });
  await ensureSite(DB, "c1", { name: "Smith Roofing", place_id: "p-c1" }, new Date(SUBMITTED));
  await insert(DB, "site_files", {
    id: FILE_ID, client_id: "c1", kind: "photo", mime: "image/jpeg", bytes: JPG, size: JPG.length, width: 3, height: 2,
    source_url: null, alt: CTX.files[0].alt, created_at: SUBMITTED,
  });
  return DB;
}

/** Their old site's photos and logo, as tiny real images. */
function fakeFetch() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const path = new URL(url).pathname;
    if (path.endsWith(".jpg")) return new Response(JPG, { status: 200, headers: { "content-type": "image/jpeg" } });
    if (path.endsWith(".png")) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    return new Response("Not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

function req(path, { method = "GET", token = KEY, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}

async function get(DB, { id = "c1", token = KEY } = {}) {
  const res = await onRequestGet({ request: req(`/api/agent/build/${id}`, { token }), env: { DB }, params: { client_id: id }, now: NOW });
  return { status: res.status, body: await res.json() };
}

async function post(DB, content, { id = "c1", token = KEY, fetchImpl = fakeFetch().fetchImpl } = {}) {
  const body = typeof content === "string" ? content : JSON.stringify(content);
  const res = await onRequestPost({
    request: req(`/api/agent/build/${id}/content`, { method: "POST", token, body }),
    env: { DB }, params: { client_id: id }, now: NOW, fetchImpl,
  });
  return { status: res.status, body: await res.json() };
}

const siteOf = (DB) => DB.prepare("SELECT * FROM client_sites WHERE client_id = 'c1'").first();
const onboardingOf = (DB) => DB.prepare("SELECT * FROM onboarding WHERE client_id = 'c1'").first();
const todoOf = (DB, dedupe) => DB.prepare("SELECT * FROM todos WHERE dedupe = ?").bind(dedupe).first();
const todosLike = (DB, prefix) =>
  DB.prepare("SELECT * FROM todos WHERE substr(dedupe, 1, length(?)) = ? ORDER BY created_at").bind(prefix, prefix).all().then((r) => r.results);

// The fixture with a home title of 121 characters that still names "Roofing contractor" and "Swindon".
const badTitle = () => {
  const c = fx();
  c.pages[0].title = `${c.pages[0].title} and chimney repairs`.padEnd(121, "s");
  return c;
};

// ---------------------------------------------------------------- the spec's tests (Task 14, Step 1)

test("without the bearer token both endpoints answer 401", async () => {
  const DB = await seed();
  assert.equal((await get(DB, { token: null })).status, 401);
  assert.equal((await get(DB, { token: "wrong-token" })).status, 401);
  const res = await post(DB, fx(), { token: null });
  assert.equal(res.status, 401);
  assert.equal((await siteOf(DB)).content, null, "nothing stored");
});

test("unknown client → 404 No client with that id.", async () => {
  const DB = await seed();
  assert.deepEqual(await get(DB, { id: "nope" }), { status: 404, body: { error: "No client with that id." } });
  const res = await post(DB, fx(), { id: "nope" });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "No client with that id.");
});

test("form not submitted → 409", async () => {
  const DB = await seed({ submitted: false });
  assert.deepEqual(await get(DB), { status: 409, body: { error: "The onboarding form hasn't been sent yet." } });
  const res = await post(DB, fx());
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "The onboarding form hasn't been sent yet.");
  assert.equal((await siteOf(DB)).content, null, "nothing stored");
});

test("GET returns the limits, the form's facts, the lead's Google reviews and brand", async () => {
  const DB = await seed();
  const { status, body } = await get(DB);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.limits.title.max, 120);
  assert.deepEqual(body.limits, JSON.parse(JSON.stringify(LIMITS)));
  assert.deepEqual(body.facts, formFacts(CTX.form));
  assert.ok(body.facts.some((f) => f.text === "Started in 2009" && f.source === "form"));
  assert.deepEqual(body.reviews, CTX.reviews);
  assert.deepEqual(body.brand, CTX.brand);
  // The rest of section 6's shape.
  assert.deepEqual(body.client, { id: "c1", name: "Smith Roofing", package: "full" });
  assert.deepEqual(body.onboarding, { status: "building", submitted_at: SUBMITTED, due_live_at: DUE, form: CTX.form });
  assert.deepEqual(Object.keys(body.lead).sort(), ["address", "maps_url", "name", "phone", "place_id", "postcode", "rating",
    "review_count", "socials", "town", "trade", "website"]);
  assert.equal(body.lead.place_id, "p-c1");
  assert.equal(body.lead.website, "https://smithroofing.co.uk");
  assert.deepEqual(body.lead.socials, { facebook: "https://www.facebook.com/smithroofing" });
  assert.equal(body.research.owner.first, "John");
  assert.equal(body.research.copy.headline, "Roof repairs in Swindon");
  assert.equal(body.research.site_review.verdict, "dated");
  assert.equal(body.research.angle[0].fact, "37 reviews at 4.9");
  assert.deepEqual(body.files, [{ id: FILE_ID, kind: "photo", url: `/s/f/${FILE_ID}`, alt: CTX.files[0].alt }]);
  assert.match(body.site.slug, /^smith-roofing-/);
  assert.deepEqual({ ...body.site, slug: "" }, { slug: "", status: "draft", content: null, change_notes: null });
  assert.deepEqual(Object.keys(body).sort(), ["brand", "client", "facts", "files", "lead", "limits", "onboarding", "research",
    "reviews", "site"]);
});

test("POST of the fixture with one bad title → 400 with that one line, nothing stored, errors kept in last_errors", async () => {
  const DB = await seed();
  const { fetchImpl, calls } = fakeFetch();
  const res = await post(DB, badTitle(), { fetchImpl });
  assert.deepEqual(res, { status: 400, body: { ok: false, errors: ["home: title is 121 characters; the limit is 120"] } });
  const site = await siteOf(DB);
  assert.equal(site.content, null, "nothing stored");
  assert.equal(site.status, "draft");
  assert.deepEqual(JSON.parse(site.last_errors), ["home: title is 121 characters; the limit is 120"]);
  assert.equal(calls.length, 0, "no photo fetched for refused content");
  assert.equal((await onboardingOf(DB)).status, "building");
  assert.equal(await todoOf(DB, "build:c1:approve"), null);
});

test("POST valid → 200 review, onboarding review, Approve todo due 48 h before the deadline, stuck closed", async () => {
  const DB = await seed();
  await addTodo(DB, { kind: "build", title: "Claude hasn't built Smith Roofing's site", client_id: "c1", dedupe: "build:c1:stuck" });
  await post(DB, badTitle()); // a refused try first: its last_errors are cleared by the good one
  const { fetchImpl, calls } = fakeFetch();
  const { status, body } = await post(DB, fx(), { fetchImpl });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, { ok: true, status: "review", pages: 11, warnings: [] });

  const site = await siteOf(DB);
  assert.equal(site.status, "review");
  assert.equal(site.last_errors, null);
  assert.equal(site.content_at, NOW_ISO);
  const stored = JSON.parse(site.content);
  assert.equal(stored.pages.length, 11);
  for (const p of stored.photos) assert.match(p.url, /^\/s\/f\/[0-9a-f]{32}$/);
  assert.equal(stored.photos[2].url, `/s/f/${FILE_ID}`, "the photo already copied isn't fetched again");
  assert.match(stored.theme.logo, /^\/s\/f\/[0-9a-f]{32}$/);
  assert.deepEqual([stored.theme.logo_w, stored.theme.logo_h], [3, 2]);
  assert.deepEqual(calls.sort(), ["https://smithroofing.co.uk/images/flat-roof.jpg", "https://smithroofing.co.uk/images/logo.png",
    "https://smithroofing.co.uk/images/slate-roof.jpg"]);

  assert.equal((await onboardingOf(DB)).status, "review");
  const approve = await todoOf(DB, "build:c1:approve");
  assert.ok(approve, "approve todo filed");
  assert.equal(approve.title, "Approve Smith Roofing's site (due live Sat 31 Oct)");
  assert.equal(approve.due_at, "2026-10-29T22:30:00Z");
  assert.equal(approve.kind, "build");
  assert.equal(approve.link, "/#/site/c1");
  assert.equal(approve.client_id, "c1");
  assert.equal(approve.status, "open");
  const stuck = await todosLike(DB, "build:c1:stuck");
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].status, "done", "build:c1:stuck closed");
  assert.equal(await todoOf(DB, "build:c1:updated"), null);
});

test("the refused POST stored its errors in last_errors", async () => {
  const DB = await seed();
  const c = fx();
  c.pages[0].title = `${c.pages[0].title} and chimney repairs`.padEnd(121, "s");
  c.reviews[0].text += " Best roofer ever.";
  const { status, body } = await post(DB, c);
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.ok(body.errors.length >= 2, JSON.stringify(body.errors));
  assert.deepEqual(JSON.parse((await siteOf(DB)).last_errors), body.errors);
});

test("POST valid on a live site → stays live, no approve todo, todo build:c1:updated", async () => {
  const DB = await seed();
  await setSiteStatus(DB, "c1", "live", new Date(SUBMITTED), { approved: true });
  const { status, body } = await post(DB, fx());
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, { ok: true, status: "live", pages: 11, warnings: [] });
  const site = await siteOf(DB);
  assert.equal(site.status, "live");
  assert.equal(JSON.parse(site.content).pages.length, 11, "the new content is served at once");
  assert.equal(await todoOf(DB, "build:c1:approve"), null, "no approve todo");
  const updated = await todoOf(DB, "build:c1:updated");
  assert.ok(updated, "updated todo filed");
  assert.equal(updated.title, "Claude updated Smith Roofing's live site: have a look");
  assert.equal(updated.kind, "build");
  assert.equal(updated.link, "/#/site/c1");
});

test("body > 600,000 bytes → 413 The site content is over 600 KB.", async () => {
  const DB = await seed();
  const c = fx();
  c.padding = "x".repeat(600_001);
  const { status, body } = await post(DB, c);
  assert.equal(status, 413);
  assert.equal(body.ok, false);
  assert.equal(body.error, "The site content is over 600 KB.");
  assert.deepEqual(body.errors, ["The site content is over 600 KB."]);
  const site = await siteOf(DB);
  assert.equal(site.content, null, "nothing stored");
  assert.deepEqual(JSON.parse(site.last_errors), ["The site content is over 600 KB."]);
});

// ---------------------------------------------------------------- edges

test("a body of exactly 600,000 bytes isn't refused for its size", async () => {
  const DB = await seed();
  const c = fx();
  const text = JSON.stringify(c);
  const padded = `${text.slice(0, -1)}${" ".repeat(600_000 - new TextEncoder().encode(text).length)}}`;
  assert.equal(new TextEncoder().encode(padded).length, 600_000);
  const { status, body } = await post(DB, padded);
  assert.equal(status, 200, JSON.stringify(body));
});

test("a body that isn't JSON → 400 with a plain-English line, kept in last_errors", async () => {
  const DB = await seed();
  const { status, body } = await post(DB, "{not json");
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.match(body.errors[0], /isn't valid JSON/);
  assert.deepEqual(JSON.parse((await siteOf(DB)).last_errors), body.errors);
  const list = await post(DB, "[1, 2]");
  assert.equal(list.status, 400);
  assert.equal(list.body.errors[0], "The site content must be one JSON object (SiteContent version 1)");
});

test("photos that can't be copied come back as warnings; content is still stored", async () => {
  const DB = await seed();
  const fetchImpl = async (url) => (String(url).endsWith("flat-roof.jpg")
    ? new Response("Not found", { status: 404 })
    : fakeFetch().fetchImpl(url));
  const { status, body } = await post(DB, fx(), { fetchImpl });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.warnings.length, 1);
  assert.match(body.warnings[0], /^Photo https:\/\/smithroofing\.co\.uk\/images\/flat-roof\.jpg couldn't be fetched/);
  assert.equal(JSON.parse((await siteOf(DB)).content).photos.length, 2);
});

test("a second post while the Approve todo is open keeps one todo; after Nik closed it a new post files it again", async () => {
  const DB = await seed();
  await post(DB, fx());
  await post(DB, fx());
  assert.equal((await todosLike(DB, "build:c1:approve")).length, 1);
  await DB.prepare("UPDATE todos SET status = 'dismissed', done_at = ? WHERE dedupe = 'build:c1:approve'").bind(NOW_ISO).run();
  await post(DB, fx());
  const all = await todosLike(DB, "build:c1:approve");
  assert.equal(all.length, 2);
  assert.equal(all.filter((t) => t.status === "open" && t.dedupe === "build:c1:approve").length, 1);
});

test("each update of a live site files its own 'have a look' todo once Nik marked the last one done", async () => {
  const DB = await seed();
  await setSiteStatus(DB, "c1", "live", new Date(SUBMITTED), { approved: true });
  await post(DB, fx());
  await DB.prepare("UPDATE todos SET status = 'done', done_at = ? WHERE dedupe = 'build:c1:updated'").bind(NOW_ISO).run();
  await post(DB, fx());
  const open = (await todosLike(DB, "build:c1:updated")).filter((t) => t.status === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].dedupe, "build:c1:updated");
});

test("build:c1:stuck closing doesn't touch another client's (c10) todo", async () => {
  const DB = await seed();
  await addTodo(DB, { kind: "build", title: "Claude hasn't built Other's site", client_id: "c10", dedupe: "build:c10:stuck" });
  await post(DB, fx());
  assert.equal((await todoOf(DB, "build:c10:stuck")).status, "open");
});

test("the client is checked before the body: unknown → 404 and unsent form → 409 even for a huge or broken body, nothing written", async () => {
  const DB = await seed({ submitted: false });
  const huge = fx();
  huge.padding = "x".repeat(600_001);
  const unknown = await post(DB, huge, { id: "nope" });
  assert.deepEqual(unknown, { status: 404, body: { error: "No client with that id." } });
  for (const body of [huge, "{not json"]) {
    const res = await post(DB, body);
    assert.deepEqual(res, { status: 409, body: { error: "The onboarding form hasn't been sent yet." } });
  }
  const site = await siteOf(DB);
  assert.equal(site.last_errors, null, "no refusal stored on a site that can't be built yet");
  assert.equal(site.content, null);
});

test("a Content-Length over 600,000 bytes → 413 before the body is read", async () => {
  const DB = await seed();
  const request = new Request(`${ORIGIN}/api/agent/build/c1/content`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "content-length": "600001" },
    body: JSON.stringify(fx()),
  });
  const res = await onRequestPost({ request, env: { DB }, params: { client_id: "c1" }, now: NOW, fetchImpl: fakeFetch().fetchImpl });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, "The site content is over 600 KB.");
  assert.equal((await siteOf(DB)).content, null, "nothing stored");
});

test("two 'have a look' todos Nik closed in the same second don't block the next update", async () => {
  const DB = await seed();
  await setSiteStatus(DB, "c1", "live", new Date(SUBMITTED), { approved: true });
  for (let i = 0; i < 3; i++) {
    const res = await post(DB, fx());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await DB.prepare("UPDATE todos SET status = 'done', done_at = ? WHERE dedupe = 'build:c1:updated'").bind(NOW_ISO).run();
  }
  const res = await post(DB, fx());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const all = await todosLike(DB, "build:c1:updated");
  assert.equal(all.length, 4);
  assert.equal(new Set(all.map((t) => t.dedupe)).size, 4);
  assert.equal(all.filter((t) => t.status === "open" && t.dedupe === "build:c1:updated").length, 1);
});

test("Changes: the stored content (server /s/f/ URLs, w/h, logo_w/logo_h) posted back as it is is accepted, nothing fetched", async () => {
  const DB = await seed();
  assert.equal((await post(DB, fx())).status, 200);
  const { body: got } = await get(DB);
  assert.equal(got.site.status, "review");
  await setSiteStatus(DB, "c1", "draft", NOW, { notes: "Make the home intro shorter" });
  const { fetchImpl, calls } = fakeFetch();
  const res = await post(DB, got.site.content, { fetchImpl });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true, status: "review", pages: 11, warnings: [] });
  assert.equal(calls.length, 0, "photos already copied aren't fetched again");
  const site = await siteOf(DB);
  assert.equal(site.change_notes, null, "change_notes cleared");
  assert.deepEqual(JSON.parse(site.content), got.site.content);
});

test("a refused post leaves the stuck todo open", async () => {
  const DB = await seed();
  await addTodo(DB, { kind: "build", title: "Claude hasn't built Smith Roofing's site", client_id: "c1", dedupe: "build:c1:stuck" });
  assert.equal((await post(DB, badTitle())).status, 400);
  assert.equal((await todoOf(DB, "build:c1:stuck")).status, "open");
});
