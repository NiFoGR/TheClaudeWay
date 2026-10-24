// The research queue for Claude's research Routine (stage 2, Task 4): claimQueue in _lib/research-db.js and
// GET /api/agent/research-queue. 8 leads at a time, each claimed for 3 hours, re-checks first; excluded, deleted and
// suppressed leads are skipped first; never a Maps line from another town's scan.
// Run: node --test control-room/tests/research-queue.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { CLAIM_HOURS, claimQueue } from "../functions/_lib/research-db.js";
import { setSecret } from "../functions/_lib/settings.js";
import { onRequestGet } from "../functions/api/agent/research-queue.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const KEY = randomBytes(32).toString("base64url");
const ORIGIN = "https://control.example";
const NOW = new Date("2026-10-20T09:00:00Z");
const QUEUED = "2026-10-19T06:00:00Z";
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms) => new Date(NOW.getTime() + ms);

const SKIP_MISSING = "Skipped: the lead no longer exists.";
const SKIP_SUPPRESSED = "Skipped: this business is on the do-not-contact list (opted out, bounced or blocked).";
const PURGED = "Skipped: details deleted 12 months after last contact.";

// ---------------------------------------------------------------- seeding

async function addLead(DB, place_id, o = {}) {
  const v = (x) => (x === undefined ? null : x);
  const json = (x) => (x === undefined ? null : typeof x === "string" ? x : JSON.stringify(x));
  await DB.prepare(`INSERT INTO leads (place_id, name, trade, search_town, town, address, phone, website, maps_url, rating,
      review_count, email, emails, socials, audit, director_first_name, director_name, company_number, excluded,
      exclude_reason, quality_score, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    place_id, o.name ?? `Lead ${place_id}`, o.trade ?? "landscaper", o.search_town ?? "Warrington", v(o.town),
    v(o.address), v(o.phone), v(o.website), v(o.maps_url), v(o.rating), v(o.review_count), v(o.email),
    json(o.emails), json(o.socials), json(o.audit ?? {}), v(o.director_first_name), v(o.director_name),
    v(o.company_number), o.excluded ?? 0, v(o.exclude_reason), o.quality_score ?? 50, QUEUED, QUEUED,
  ).run();
}

async function addResearch(DB, place_id, o = {}) {
  await DB.prepare(`INSERT INTO research (place_id, status, grade, points, emails, best_email, notes, queued_at, researched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    place_id, o.status ?? "queued", o.grade ?? null, o.points ?? null, o.emails ?? null, o.best_email ?? null,
    o.notes ?? "", o.queued_at === undefined ? QUEUED : o.queued_at, o.researched_at ?? null,
  ).run();
}

const addMapRank = (DB, place_id, o = {}) =>
  DB.prepare("INSERT INTO lead_map_rank (place_id, scan_id, keyword, town, avg_rank, top3_pct, found_pct, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(place_id, o.scan_id ?? "scan1", o.keyword ?? "landscaper", o.town ?? "Warrington", o.avg_rank ?? 9.4,
      o.top3_pct ?? 12, o.found_pct ?? 64, QUEUED).run();

const suppress = (DB, value, kind) =>
  DB.prepare("INSERT INTO suppression (value, kind, reason, created_at) VALUES (?, ?, 'opt_out', ?)").bind(value, kind, QUEUED).run();

const researchRow = (DB, place_id) => DB.prepare("SELECT * FROM research WHERE place_id = ?").bind(place_id).first();
const claimOf = (DB, place_id) =>
  DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`research:claim:${place_id}`).first("value");
const ids = (body) => body.leads.map((l) => l.place_id);
const pid = (n) => `L${String(n).padStart(2, "0")}`;

// The 12 queued leads of the spec's tests. L01 is a re-check, L02 has a real email, L03 a guessed one; the rest have
// distinct scores (the guessed lead sits among them by its score).
const SCORES = { L01: 40, L02: 41, L03: 72, L04: 90, L05: 85, L06: 80, L07: 75, L08: 70, L09: 65, L10: 60, L11: 50, L12: 45 };
const BY_ORDER = ["L01", "L02", "L04", "L05", "L06", "L07", "L03", "L08", "L09", "L10", "L11", "L12"];

async function seed12(DB) {
  await setSecret(DB, "agent_token", KEY);
  for (let n = 1; n <= 12; n++) {
    const id = pid(n);
    const o = { quality_score: SCORES[id] };
    if (id === "L02") Object.assign(o, { email: "dave@greenleaf.co.uk", audit: { email_source: "website" } });
    if (id === "L03") Object.assign(o, { email: "info@guessed-domain.co.uk", audit: { email_source: "guessed" } });
    await addLead(DB, id, o);
    await addResearch(DB, id, id === "L01" ? {
      grade: "B",
      points: JSON.stringify({ need: 4, means: 3, reach: 2, fit: 5, total: 14, capped: null, reasons: { need: "x", means: "x", reach: "x", fit: "x" } }),
      emails: JSON.stringify([{ email: "info@l01.co.uk", source_url: "https://l01.co.uk/contact", where: "Contact page" }]),
      best_email: "info@l01.co.uk",
      notes: "[Nik 2026-10-19] owner is Sue\nChecked the contact page.",
      researched_at: "2026-10-18T07:30:00Z",
    } : {});
  }
  return DB;
}

const request = (query = "", token = KEY) => new Request(`${ORIGIN}/api/agent/research-queue${query}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
async function call(DB, query, { token = KEY, now = NOW } = {}) {
  const res = await onRequestGet({ request: request(query, token), env: { DB }, now });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------- the spec's tests (Task 4, Step 1)

test("401 without the token", async () => {
  const DB = await seed12(fakeD1());
  const res = await onRequestGet({ request: request("", null), env: { DB }, now: NOW });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Wrong token" });
  assert.equal(await claimOf(DB, "L01"), null, "nothing claimed");
  const wrong = await call(DB, "", { token: "not-the-key" });
  assert.equal(wrong.status, 401);
});

test("order", async () => {
  const DB = await seed12(fakeD1());
  const { status, body } = await call(DB, "?limit=8");
  assert.equal(status, 200);
  assert.deepEqual(ids(body), BY_ORDER.slice(0, 8));
  const [recheck, realEmail, ...rest] = body.leads;
  // the re-check first, with Nik's note and the earlier research
  assert.equal(recheck.place_id, "L01");
  assert.equal(recheck.nik_note, "owner is Sue");
  assert.notEqual(recheck.previous, null);
  assert.equal(recheck.previous.grade, "B");
  assert.equal(recheck.previous.points.need, 4);
  assert.equal(recheck.previous.emails[0].email, "info@l01.co.uk");
  assert.equal(recheck.previous.too_big, false);
  // then the real (not guessed) email
  assert.equal(realEmail.place_id, "L02");
  assert.equal(realEmail.scraper.email, "dave@greenleaf.co.uk");
  // then quality_score descending; the guessed email doesn't jump the queue
  const scores = rest.map((l) => l.score.total);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.ok(ids(body).indexOf("L03") > 2, "a guessed email doesn't count as a real one");
  for (const l of body.leads.slice(1)) {
    assert.equal(l.previous, null, `${l.place_id}: not a re-check`);
    assert.equal(l.nik_note, null, `${l.place_id}: not a re-check`);
  }
});

test("limit capped at 8", async () => {
  for (const [query, n, remaining] of [["?limit=50", 8, 4], ["?limit=0", 8, 4], ["", 8, 4], ["?limit=abc", 8, 4], ["?limit=3", 3, 9]]) {
    const DB = await seed12(fakeD1());
    const { status, body } = await call(DB, query);
    assert.equal(status, 200, query);
    assert.equal(body.leads.length, n, query);
    assert.equal(body.remaining, remaining, query);
  }
});

test("claims stop double handouts", async () => {
  const DB = await seed12(fakeD1());
  assert.equal(CLAIM_HOURS, 3);
  const first = await claimQueue(DB, { now: NOW, origin: ORIGIN });
  assert.equal(first.leads.length, 8);
  assert.equal(first.remaining, 4);
  for (const id of ids(first)) assert.equal(await claimOf(DB, id), "2026-10-20T09:00:00Z", `${id} claimed at the time of the call`);
  const { results: claims } = await DB.prepare("SELECT key FROM settings WHERE key LIKE 'research:claim:%' ORDER BY key").all();
  assert.deepEqual(claims.map((c) => c.key), ids(first).map((id) => `research:claim:${id}`).sort(), "only the leads handed out");

  const second = await claimQueue(DB, { now: at(MIN), origin: ORIGIN });
  assert.equal(second.leads.length, 4);
  assert.deepEqual(ids(second).filter((id) => ids(first).includes(id)), [], "none repeated");
  assert.deepEqual([...ids(first), ...ids(second)].sort(), Object.keys(SCORES).sort());
  assert.equal(second.remaining, 8, "the first run's 8 are still queued");

  const third = await claimQueue(DB, { now: at(3 * HOUR + MIN), origin: ORIGIN });
  assert.ok(third.leads.length > 0);
  assert.deepEqual(ids(third).filter((id) => !ids(first).includes(id)), [], "the first set again (the second set is still claimed)");
  assert.deepEqual(ids(third), ids(first));
});

test("two runs calling at the same moment never get the same lead", async () => {
  // The 06:47 schedule and an after-search fire can call within milliseconds: the claims go in with the pick (one
  // batch, one transaction on D1), so the second call already sees them.
  const DB = await seed12(fakeD1());
  const [a, b] = await Promise.all([claimQueue(DB, { now: NOW, origin: ORIGIN }), claimQueue(DB, { now: NOW, origin: ORIGIN })]);
  assert.deepEqual(ids(a).filter((id) => ids(b).includes(id)), [], "none handed out twice");
  assert.deepEqual([...ids(a), ...ids(b)].sort(), Object.keys(SCORES).sort());
  for (const id of Object.keys(SCORES)) assert.equal(await claimOf(DB, id), "2026-10-20T09:00:00Z", id);
});

test("excluded or missing leads are skipped", async () => {
  const DB = await seed12(fakeD1());
  await addLead(DB, "EXC", { excluded: 1, exclude_reason: "Multiple branches (chain)", quality_score: 99 });
  await addResearch(DB, "EXC");
  await addResearch(DB, "GONE"); // no leads row: deleted by a re-scrape since it was queued
  const { body } = await call(DB, "");
  assert.ok(!ids(body).includes("EXC") && !ids(body).includes("GONE"));
  const exc = await researchRow(DB, "EXC");
  assert.equal(exc.status, "skipped");
  assert.ok(exc.notes.includes("Skipped: the scraper excluded this lead"), exc.notes);
  assert.equal(exc.notes, "Skipped: the scraper excluded this lead (Multiple branches (chain)).");
  const gone = await researchRow(DB, "GONE");
  assert.equal(gone.status, "skipped");
  assert.equal(gone.notes, SKIP_MISSING);
  assert.equal(body.remaining, 4, "skipped rows aren't waiting");
  assert.equal(await claimOf(DB, "EXC"), null);
});

test("suppressed leads are skipped", async () => {
  // by the email's domain
  const DB = await seed12(fakeD1());
  await addLead(DB, "SUP", { email: "dave@smithroofing.co.uk", audit: { email_source: "website" }, quality_score: 99 });
  await addResearch(DB, "SUP");
  await suppress(DB, "smithroofing.co.uk", "domain");
  const { body } = await call(DB, "");
  assert.ok(!ids(body).includes("SUP"));
  const row = await researchRow(DB, "SUP");
  assert.equal(row.status, "skipped");
  assert.ok(row.notes.includes("Skipped: this business is on the do-not-contact list"), row.notes);
  assert.equal(row.notes, SKIP_SUPPRESSED);
  assert.equal(await claimOf(DB, "SUP"), null);

  // by the company number
  const DB2 = await seed12(fakeD1());
  await addLead(DB2, "CO", { company_number: "12345678", quality_score: 99 });
  await addResearch(DB2, "CO");
  await suppress(DB2, "12345678", "company");
  const second = await call(DB2, "");
  assert.ok(!ids(second.body).includes("CO"));
  const co = await researchRow(DB2, "CO");
  assert.equal(co.status, "skipped");
  assert.ok(co.notes.includes("Skipped: this business is on the do-not-contact list"), co.notes);
  assert.equal(second.body.remaining, 4);
});

test("no Maps lines from another town", async () => {
  const DB = fakeD1();
  await setSecret(DB, "agent_token", KEY);
  const findings = ["no_website", "maps_invisible", "reviews_behind"];
  await addLead(DB, "AWAY", { town: "Warrington", audit: { findings, map_rank: { scan_town: "Runcorn", home: false } }, quality_score: 90 });
  await addLead(DB, "OLD", { town: "Warrington", audit: { findings, map_rank: { scan_town: "Runcorn", avg_rank: 20, top3_pct: 0, found_pct: 0 } }, quality_score: 80 });
  await addLead(DB, "HOME", { town: "Warrington", audit: { findings, map_rank: { scan_town: "Warrington", home: true, avg_rank: 9.4, top3_pct: 12, found_pct: 64 } }, quality_score: 70 });
  for (const id of ["AWAY", "OLD", "HOME"]) {
    await addResearch(DB, id);
    await addMapRank(DB, id, { scan_id: `scan-${id}` });
  }
  const { body } = await call(DB, "");
  const by = Object.fromEntries(body.leads.map((l) => [l.place_id, l]));
  for (const id of ["AWAY", "OLD"]) {
    assert.equal(by[id].map_rank, null, id);
    assert.deepEqual(by[id].findings, ["no_website"], id);
    assert.ok(!by[id].findings.some((f) => f.startsWith("maps_") || f === "reviews_behind"), id);
  }
  assert.notEqual(by.HOME.map_rank, null);
  assert.deepEqual(by.HOME.findings, findings);
});

test("a lead_map_rank row from another town's scan is never handed out, whatever the audit says", async () => {
  const DB = fakeD1();
  await addLead(DB, "STALE", { town: "Warrington", audit: { map_rank: { scan_town: "Warrington", home: true } } });
  await addLead(DB, "SAINT", { town: "St. Helens", search_town: "St Helens", audit: { map_rank: { scan_town: "Saint Helens", home: true } } });
  await addResearch(DB, "STALE");
  await addResearch(DB, "SAINT");
  await addMapRank(DB, "STALE", { town: "Runcorn" });
  await addMapRank(DB, "SAINT", { town: "Saint Helens", scan_id: "sh" });
  const by = Object.fromEntries((await claimQueue(DB, { now: NOW, origin: ORIGIN })).leads.map((l) => [l.place_id, l]));
  assert.equal(by.STALE.map_rank, null);
  assert.equal(by.SAINT.map_rank?.town, "Saint Helens", "St. Helens = Saint Helens (townKey)");
});

test("facts included", async () => {
  const DB = fakeD1();
  await setSecret(DB, "agent_token", KEY);
  const long = "Brilliant work on our garden, ".repeat(25).trim(); // 749 characters
  const reviews = [
    { author: "Sarah K.", text: long, rating: 5 },
    { author: "Tom B.", text: "Dave turned up on time and the patio looks great, would use again.", rating: 5 },
    { author: "Ann P.", text: "Lovely fencing, tidy job and fair price for the work done.", rating: 4 },
    { author: "Joe R.", text: "A fourth review that should never be handed out to Claude at all.", rating: 5 },
  ];
  await addLead(DB, "ChIJ-green_leaf", {
    town: "Warrington", director_first_name: "Dave", director_name: "Dave Smith",
    audit: { reviews, owner_source: "website", owner_confident: true, map_rank: { scan_town: "Warrington", home: true } },
    quality_score: 72,
  });
  await addLead(DB, "ChIJ-other", { director_first_name: "Bob", audit: { owner_source: "Companies House" }, quality_score: 60 });
  await addResearch(DB, "ChIJ-green_leaf");
  await addResearch(DB, "ChIJ-other");
  await addMapRank(DB, "ChIJ-green_leaf", { scan_id: "s-123", top3_pct: 12, found_pct: 64, avg_rank: 9.4 });
  const { body } = await call(DB, "");
  const [green, other] = body.leads;
  assert.equal(green.place_id, "ChIJ-green_leaf");
  assert.equal(green.map_rank.top3_pct, 12);
  assert.equal(green.map_rank.source_url, `${ORIGIN}/#/maprank?scan=s-123&biz=ChIJ-green_leaf`);
  assert.deepEqual(green.map_rank, {
    keyword: "landscaper", town: "Warrington", top3_pct: 12, found_pct: 64, avg_rank: 9.4,
    source_url: `${ORIGIN}/#/maprank?scan=s-123&biz=ChIJ-green_leaf`,
  });
  assert.ok(green.top_reviews.length <= 3);
  assert.equal(green.top_reviews.length, 3);
  for (const r of green.top_reviews) assert.ok(r.text.length <= 400, `${r.author}: ${r.text.length}`);
  assert.deepEqual(green.top_reviews.slice(1), reviews.slice(1, 3).map(({ author, text, rating }) => ({ author, rating, text })));
  assert.ok(long.startsWith(green.top_reviews[0].text.replace(/…$/, "")), "a long review is cut, not rewritten");
  assert.equal(green.scraper.owner.confident, true);
  assert.deepEqual(green.scraper.owner, { first: "Dave", full: "Dave Smith", source: "website", confident: true });
  assert.equal(other.scraper.owner.confident, false);
  assert.equal(other.map_rank, null, "no lead_map_rank row");
  assert.deepEqual(other.top_reviews, []);
});

// ---------------------------------------------------------------- more

test("the item carries everything the scraper already knows", async () => {
  const DB = fakeD1();
  await addLead(DB, "ChIJ1", {
    name: "Green Leaf Landscapes", trade: "landscaper", search_town: "Warrington", town: null, address: "1 High St, Warrington",
    phone: "01925 000000", website: "https://greenleaf.co.uk", maps_url: "https://maps.google.com/?cid=1", rating: 4.9,
    review_count: 61, email: "info@greenleaf.co.uk", emails: ["info@greenleaf.co.uk"], socials: { facebook: "https://facebook.com/gl" },
    director_first_name: "Dave", director_name: "Dave Smith", company_number: "12345678", quality_score: 72,
    audit: { email_source: "website", owner_source: "website", findings: ["no_reviews_shown", "not_mobile"], score: { total: 72, website: 30, seo: 22, maps: 20 } },
  });
  await addResearch(DB, "ChIJ1");
  const { leads, remaining } = await claimQueue(DB, { now: NOW, origin: ORIGIN });
  assert.equal(remaining, 0);
  assert.deepEqual(leads, [{
    place_id: "ChIJ1", name: "Green Leaf Landscapes", trade: "landscaper", town: "Warrington",
    address: "1 High St, Warrington", phone: "01925 000000", website: "https://greenleaf.co.uk",
    google_maps: "https://maps.google.com/?cid=1", rating: 4.9, reviews: 61, company_number: "12345678",
    scraper: {
      email: "info@greenleaf.co.uk", email_source: "website", emails: ["info@greenleaf.co.uk"],
      owner: { first: "Dave", full: "Dave Smith", source: "website", confident: false },
      socials: { facebook: "https://facebook.com/gl" },
    },
    findings: ["no_reviews_shown", "not_mobile"],
    score: { total: 72, website: 30, seo: 22, maps: 20 },
    map_rank: null,
    top_reviews: [],
    previous: null,
    nik_note: null,
  }]);
});

test("what the scraper didn't find is null, never an empty string", async () => {
  const DB = fakeD1();
  await addLead(DB, "BARE", { address: "", phone: "", website: "", maps_url: "", email: "", company_number: "", director_first_name: "", director_name: "" });
  await addResearch(DB, "BARE");
  const [lead] = (await claimQueue(DB, { now: NOW, origin: ORIGIN })).leads;
  for (const k of ["address", "phone", "website", "google_maps", "company_number", "rating", "reviews"]) assert.equal(lead[k], null, k);
  assert.equal(lead.scraper.email, null);
  assert.equal(lead.scraper.email_source, null);
  assert.deepEqual(lead.scraper.emails, []);
  assert.deepEqual(lead.scraper.socials, {});
  assert.deepEqual(lead.scraper.owner, { first: null, full: null, source: null, confident: false });
  assert.deepEqual(lead.findings, []);
  assert.deepEqual(lead.score, { total: 50 });
});

test("ties on score go to the lead queued longest", async () => {
  const DB = fakeD1();
  await addLead(DB, "NEW", { quality_score: 60 });
  await addLead(DB, "OLD", { quality_score: 60 });
  await addResearch(DB, "NEW", { queued_at: "2026-10-19T08:00:00Z" });
  await addResearch(DB, "OLD", { queued_at: "2026-10-18T08:00:00Z" });
  assert.deepEqual(ids(await claimQueue(DB, { now: NOW, origin: ORIGIN })), ["OLD", "NEW"]);
});

test("only queued rows are touched: done, skipped and purged rows stay as they are", async () => {
  const DB = await seed12(fakeD1());
  await addLead(DB, "DONE", { quality_score: 99, excluded: 1, exclude_reason: "Front desk / gatekeeper" });
  await addResearch(DB, "DONE", { status: "done", grade: "A", researched_at: "2026-10-18T07:00:00Z", notes: "Claude's note" });
  await addResearch(DB, "PURGED", { status: "skipped", queued_at: null, notes: PURGED }); // file 11's purge, no lead any more
  await addLead(DB, "NOTFIT", { quality_score: 99 });
  await addResearch(DB, "NOTFIT", { status: "skipped", notes: "[Nik 2026-10-19] Not a fit: Wrong trade" });
  await suppress(DB, "12345678", "company");
  const before = await Promise.all(["DONE", "PURGED", "NOTFIT"].map((id) => researchRow(DB, id)));
  const { body } = await call(DB, "");
  const after = await Promise.all(["DONE", "PURGED", "NOTFIT"].map((id) => researchRow(DB, id)));
  assert.deepEqual(after, before);
  assert.ok(!ids(body).some((id) => ["DONE", "PURGED", "NOTFIT"].includes(id)));
  assert.equal(body.remaining, 4);
});

test("a skipped re-check keeps Nik's lines and Claude's old notes, with the reason below", async () => {
  const DB = fakeD1();
  await addLead(DB, "R1", { excluded: 1, exclude_reason: "Front desk / gatekeeper." });
  await addResearch(DB, "R1", { notes: "[Nik 2026-10-19] owner is Sue\nOld Claude note\n", researched_at: "2026-10-18T07:00:00Z" });
  await claimQueue(DB, { now: NOW, origin: ORIGIN });
  const row = await researchRow(DB, "R1");
  assert.equal(row.status, "skipped");
  assert.equal(row.notes, "[Nik 2026-10-19] owner is Sue\nOld Claude note\nSkipped: the scraper excluded this lead (Front desk / gatekeeper).");
});

test("an excluded lead with no reason saved still gets a plain note", async () => {
  const DB = fakeD1();
  await addLead(DB, "X", { excluded: 1, exclude_reason: null });
  await addResearch(DB, "X");
  await claimQueue(DB, { now: NOW, origin: ORIGIN });
  assert.equal((await researchRow(DB, "X")).notes, "Skipped: the scraper excluded this lead.");
});

test("a suppressed website host, or the exact email, skips the lead too", async () => {
  const DB = fakeD1();
  await addLead(DB, "WEB", { website: "https://www.blocked.co.uk/contact" });
  await addLead(DB, "MAIL", { email: "Dave@Opted-Out.co.uk" });
  await addLead(DB, "OK", { email: "sue@fine.co.uk", website: "https://fine.co.uk" });
  for (const id of ["WEB", "MAIL", "OK"]) await addResearch(DB, id);
  await suppress(DB, "blocked.co.uk", "domain");
  await suppress(DB, "dave@opted-out.co.uk", "email");
  const body = await claimQueue(DB, { now: NOW, origin: ORIGIN });
  assert.deepEqual(ids(body), ["OK"]);
  assert.equal((await researchRow(DB, "WEB")).status, "skipped");
  assert.equal((await researchRow(DB, "MAIL")).status, "skipped");
  assert.equal(body.remaining, 0);
});

test("an unreadable audit never stops the queue", async () => {
  const DB = fakeD1();
  await addLead(DB, "BAD", { audit: "{not json", email: "a@b.co.uk", quality_score: 80 });
  await addLead(DB, "NULL", { audit: "null", quality_score: 70 });
  await addLead(DB, "ARR", { audit: "[1,2]", emails: "null", socials: "\"x\"", quality_score: 60 });
  for (const id of ["BAD", "NULL", "ARR"]) await addResearch(DB, id);
  const body = await claimQueue(DB, { now: NOW, origin: ORIGIN });
  assert.deepEqual(ids(body), ["BAD", "NULL", "ARR"]); // BAD's email counts as real: no source says it was guessed
  for (const l of body.leads) {
    assert.deepEqual(l.findings, []);
    assert.equal(l.map_rank, null);
    assert.deepEqual(l.top_reviews, []);
    assert.equal(l.scraper.owner.confident, false);
  }
  assert.deepEqual(body.leads[2].scraper.emails, []);
  assert.deepEqual(body.leads[2].scraper.socials, {});
});

test("hundreds of leads: skips and claims are one statement each, under D1's 100 bound values", async () => {
  const DB = fakeD1();
  const stmts = [];
  for (let n = 0; n < 180; n++) {
    const id = `P${String(n).padStart(3, "0")}`;
    stmts.push(DB.prepare("INSERT INTO leads (place_id, name, trade, search_town, company_number, quality_score, first_seen_at, updated_at) VALUES (?, ?, 'roofer', 'Leeds', ?, ?, ?, ?)")
      .bind(id, `Roofer ${n}`, n < 150 ? "99999999" : `C${n}`, n, QUEUED, QUEUED));
    stmts.push(DB.prepare("INSERT INTO research (place_id, status, queued_at) VALUES (?, 'queued', ?)").bind(id, QUEUED));
  }
  await DB.batch(stmts);
  await suppress(DB, "99999999", "company");
  const counted = countingDB(DB);
  const body = await claimQueue(counted.DB, { now: NOW, origin: ORIGIN });
  assert.equal(body.leads.length, 8);
  assert.equal(body.remaining, 22);
  assert.ok(counted.used() <= 6, `${counted.used()} statements`);
  const { n } = await DB.prepare("SELECT COUNT(*) AS n FROM research WHERE status = 'skipped'").first();
  assert.equal(n, 150);
});

test("a handful of D1 statements: 1 for an empty queue, at most 6 otherwise", async () => {
  const empty = countingDB(fakeD1());
  assert.deepEqual(await claimQueue(empty.DB, { now: NOW, origin: ORIGIN }), { leads: [], remaining: 0 });
  assert.equal(empty.used(), 1);

  const DB = await seed12(fakeD1());
  await addResearch(DB, "GONE");
  const counted = countingDB(DB);
  const body = await claimQueue(counted.DB, { now: NOW, origin: ORIGIN });
  assert.equal(body.leads.length, 8);
  assert.ok(counted.used() <= 6, `${counted.used()} statements`);

  // Everything claimed: nothing handed out, nothing written.
  const later = countingDB(DB);
  await claimQueue(later.DB, { now: at(MIN), origin: ORIGIN });
  const none = await claimQueue(later.DB, { now: at(2 * MIN), origin: ORIGIN });
  assert.deepEqual(none, { leads: [], remaining: 12 });
});

test("a claim exactly 3 hours old still counts; one a second older doesn't", async () => {
  const DB = fakeD1();
  await addLead(DB, "A");
  await addResearch(DB, "A");
  await claimQueue(DB, { now: NOW, origin: ORIGIN });
  assert.deepEqual(ids(await claimQueue(DB, { now: at(3 * HOUR), origin: ORIGIN })), []);
  assert.deepEqual(ids(await claimQueue(DB, { now: at(3 * HOUR + 1000), origin: ORIGIN })), ["A"]);
  assert.equal(await claimOf(DB, "A"), "2026-10-20T12:00:01Z", "handing it out again renews the claim");
});

test("the Maps link is built from the request's own address", async () => {
  const DB = fakeD1();
  await setSecret(DB, "agent_token", KEY);
  await addLead(DB, "M1", { town: "Warrington", audit: { map_rank: { scan_town: "Warrington", home: true } } });
  await addResearch(DB, "M1");
  await addMapRank(DB, "M1", { scan_id: "abc" });
  const res = await onRequestGet({
    request: new Request("https://aetos-control.pages.dev/api/agent/research-queue?limit=8", { headers: { authorization: `Bearer ${KEY}` } }),
    env: { DB }, now: NOW,
  });
  const body = await res.json();
  assert.equal(body.leads[0].map_rank.source_url, "https://aetos-control.pages.dev/#/maprank?scan=abc&biz=M1");
});
