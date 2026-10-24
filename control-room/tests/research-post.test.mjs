// Claude's research post (stage 2, Task 5): POST /api/agent/research/:place_id and saveResearch in _lib/research-db.js.
// The server checks every field (research.js validateResearch), works out the grade itself (grade.js), stores the row
// as done with Nik's note lines kept on top, deletes the claim, and never touches the leads table. Part A rule 12 (an
// unknown place_id is a 404) is tested here. Run: node --test control-room/tests/research-post.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { gradeFrom } from "../functions/_lib/grade.js";
import { parseResearch, validateResearch } from "../functions/_lib/research.js";
import { claimKey, saveResearch } from "../functions/_lib/research-db.js";
import { setSecret } from "../functions/_lib/settings.js";
import { onRequestPost } from "../functions/api/agent/research/[id].js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const KEY = randomBytes(32).toString("base64url");
const ORIGIN = "https://control.example";
const NOW = new Date("2026-10-24T09:00:00Z");
const QUEUED = "2026-10-23T06:47:00Z";
const CLAIMED = "2026-10-24T08:50:00Z";
const ID = "ChIJgreenleaf";
const MAP_RANK_URL = `${ORIGIN}/#/maprank?scan=s1&biz=${ID}`;
const NO_LEAD = "No lead with that place_id. Use the place_id from the queue exactly.";
const NOT_OBJECT = "Body must be a JSON object.";
const OWNER_IN_NAME = `Owner's first name is also in the business name, so emails say "Hi," until Nik confirms it.`;
const STAYS_SKIPPED = "This lead was taken off the list while you were researching it (marked not a fit, excluded by " +
  "the scraper or on the do-not-contact list), so this research wasn't saved. Nothing to fix: go on to the next lead.";
const PURGED = "Skipped: details deleted 12 months after last contact.";

// The Green Leaf body from Part A, valid (the same as research.test.mjs's).
const greenLeaf = () => ({
  points: { need: 5, means: 4, reach: 5, fit: 5 },
  reasons: { need: "No website; top 3 on Maps in 12% of Warrington", means: "61 reviews at 4.9, trading since 2014",
    reach: "Dave's own email, on the contact page", fit: "Owner-run landscaper" },
  grade_reason: "Owner-run landscaper with 61 great reviews but no website and rarely in the Maps top 3. We have Dave's own email.",
  angle: [{ fact: "Not in the Google Maps top 3 for 'landscaper Warrington' (Map Rank: 12% top-3)", source_url: MAP_RANK_URL }],
  opener: "Came across Green Leaf looking for a landscaper in Warrington: 61 five-star reviews, but you're not in the top 3 " +
    "on Google Maps there.\nSo I put together a quick site for you that puts those reviews front and centre.",
  owner: { first: "Dave", full: "Dave Smith", source_url: "https://greenleaf.co.uk/about", confident: true },
  emails: [{ email: "dave@greenleaf.co.uk", source_url: "https://greenleaf.co.uk/contact", where: "Contact page" }],
  best_email: "dave@greenleaf.co.uk", best_email_why: "Owner's own address",
  copy: { headline: "Garden design and landscaping in Warrington",
    intro: "Patios, fencing and garden makeovers across Warrington and Lymm, from a local family firm.",
    services: ["Patios", "Fencing"], areas: ["Warrington", "Lymm"], about: "Family-run, trading since 2014." },
  site_review: null,
  too_big: false,
  notes: "",
  searched: ["search: \"Green Leaf Landscapes\" Warrington facebook", "opened: https://greenleaf.co.uk/contact",
    "search: \"Green Leaf Landscapes\" Warrington email"],
});

// What Claude posts when it found nothing (Part A: "Post even when nothing was found").
const nothingFound = () => {
  const b = { ...greenLeaf(), emails: [], best_email: null, owner: null, points: { need: 5, means: 4, reach: 0, fit: 5 },
    reasons: { ...greenLeaf().reasons, reach: "No email anywhere: website, Facebook, Yell, Checkatrade" } };
  delete b.best_email_why;
  return b;
};

// ---------------------------------------------------------------- seeding

const LEAD_AUDIT = { email_source: "website", owner_source: "website", owner_confident: false, findings: ["no_website"],
  map_rank: { home: true, scan_town: "Warrington" } };

async function addLead(DB, place_id, o = {}) {
  await DB.prepare(`INSERT INTO leads (place_id, name, trade, search_town, town, website, email, emails, audit,
      director_first_name, director_name, quality_score, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    place_id, o.name ?? "Green Leaf Landscapes", o.trade ?? "landscaper", o.search_town ?? "Warrington",
    o.town ?? "Warrington", o.website ?? "https://greenleaf.co.uk", o.email ?? "info@greenleaf.co.uk",
    JSON.stringify(["info@greenleaf.co.uk"]), JSON.stringify(o.audit ?? LEAD_AUDIT), "David", "David Smith", 72,
    QUEUED, QUEUED,
  ).run();
}

async function addResearch(DB, place_id, o = {}) {
  await DB.prepare(`INSERT INTO research (place_id, status, grade, points, best_email, notes, queued_at, researched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    place_id, o.status ?? "queued", o.grade ?? null, o.points ?? null, o.best_email ?? null, o.notes ?? "",
    o.queued_at === undefined ? QUEUED : o.queued_at, o.researched_at ?? null,
  ).run();
}

const claim = (DB, place_id, at = CLAIMED) =>
  DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(claimKey(place_id), at).run();

/** A database with the agent key, the Green Leaf lead, its queued research row (or `research: null` for none) and its claim. */
async function seed({ lead = {}, research = {}, claimed = true } = {}) {
  const DB = fakeD1();
  await setSecret(DB, "agent_token", KEY);
  if (lead) await addLead(DB, ID, lead);
  if (research) await addResearch(DB, ID, research);
  if (claimed) await claim(DB, ID);
  return DB;
}

const rowOf = (DB, place_id = ID) => DB.prepare("SELECT * FROM research WHERE place_id = ?").bind(place_id).first();
const leadOf = (DB, place_id = ID) => DB.prepare("SELECT * FROM leads WHERE place_id = ?").bind(place_id).first();
const claimOf = (DB, place_id = ID) => DB.prepare("SELECT value FROM settings WHERE key = ?").bind(claimKey(place_id)).first("value");

async function post(DB, body, { id = ID, token = KEY, now = NOW } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = new Request(`${ORIGIN}/api/agent/research/${encodeURIComponent(id)}`, {
    method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await onRequestPost({ request, env: { DB }, params: { id }, now });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------- the spec's tests (Task 5, Step 1)

test("stores and grades", async () => {
  const DB = await seed();
  assert.equal(await claimOf(DB), CLAIMED, "claimed before the post");
  const { status, body } = await post(DB, greenLeaf());
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, { ok: true, place_id: ID, grade: "A+", total: 19, capped: null, warnings: [] });

  const row = await rowOf(DB);
  assert.equal(row.status, "done");
  assert.equal(row.grade, "A+");
  assert.equal(row.researched_at, "2026-10-24T09:00:00Z");
  const points = JSON.parse(row.points);
  assert.equal(points.reasons.need, "No website; top 3 on Maps in 12% of Warrington");
  assert.equal(await claimOf(DB), null, "the claim is gone");
});

test("server grade wins", async () => {
  const DB = await seed();
  const before = await rowOf(DB);
  const { status, body } = await post(DB, { ...greenLeaf(), grade: "A+" });
  assert.equal(status, 400);
  assert.ok(body.problems.some((p) => p.startsWith(`Unknown field "grade"`)), JSON.stringify(body.problems));
  assert.ok(body.problems.includes(`Unknown field "grade". Allowed: points, reasons, grade_reason, angle, opener, owner, ` +
    "emails, best_email, best_email_why, copy, site_review, too_big, notes, searched"));
  assert.deepEqual(await rowOf(DB), before, "a rejected post changes nothing");
  assert.equal(await claimOf(DB), CLAIMED, "and keeps the claim");
  // Claude can't send a total either
  const totalled = await post(DB, { ...greenLeaf(), total: 19 });
  assert.equal(totalled.status, 400);
  assert.ok(totalled.body.problems.some((p) => p.startsWith(`Unknown field "total"`)));
});

test("nothing found", async () => {
  const DB = await seed();
  const { status, body } = await post(DB, nothingFound());
  assert.equal(status, 200, JSON.stringify(body));
  // need 5 + means 4 + reach 0 + fit 5 = 14: B on the total (A needs reach 3+), held at C by the reach cap
  assert.deepEqual(body, { ok: true, place_id: ID, grade: "C", total: 14, capped: "reach", warnings: [] });
  assert.deepEqual(body.grade, gradeFrom({ need: 5, means: 4, reach: 0, fit: 5 }).grade);
  const row = await rowOf(DB);
  assert.equal(row.status, "done", "done even when nothing was found");
  assert.equal(row.grade, "C");
  assert.equal(row.best_email, null);
  assert.equal(row.best_email_why, null);
  assert.equal(row.emails, "[]");
  assert.equal(row.owner, null);
  assert.equal(JSON.parse(row.points).capped, "reach");
});

test("400 lists every problem", async () => {
  const DB = await seed();
  const before = await rowOf(DB);
  const b = greenLeaf();
  b.points.need = 6; // 1
  delete b.grade_reason; // 2
  b.searched = b.searched.slice(0, 2); // 3
  const { status, body } = await post(DB, b);
  assert.equal(status, 400);
  assert.equal(body.problems.length, 3, JSON.stringify(body.problems));
  assert.ok(body.error.startsWith("3 problems:"), body.error);
  assert.deepEqual(body.problems.sort(), [
    "Missing field \"grade_reason\"",
    "points.need must be a whole number from 0 to 5",
    "searched must list at least 3 things you searched or opened",
  ]);
  for (const p of body.problems) assert.ok(body.error.includes(p), `the error names "${p}"`);
  assert.deepEqual(await rowOf(DB), before);
});

test("bad JSON", async () => {
  const DB = await seed();
  const before = await rowOf(DB);
  const { status, body } = await post(DB, "not json");
  assert.equal(status, 400);
  assert.equal(body.error, NOT_OBJECT);
  // JSON that isn't an object is the same 400
  for (const raw of ["[]", "[{}]", '"text"', "42", "null", ""]) {
    const r = await post(DB, raw);
    assert.equal(r.status, 400, raw);
    assert.equal(r.body.error, NOT_OBJECT, raw);
    assert.deepEqual(r.body.problems, [NOT_OBJECT], raw);
  }
  assert.deepEqual(await rowOf(DB), before);
});

test("unknown lead", async () => {
  const DB = await seed();
  const { status, body } = await post(DB, greenLeaf(), { id: "ChIJnobody" });
  assert.equal(status, 404);
  assert.equal(body.error, NO_LEAD);
  assert.equal(await rowOf(DB, "ChIJnobody"), null, "no research row made");
  // a lead deleted by a re-scrape while its research was queued (Part A edge case): 404, the row left alone
  const gone = await seed({ lead: null });
  const before = await rowOf(gone);
  const r = await post(gone, greenLeaf());
  assert.equal(r.status, 404);
  assert.equal(r.body.error, NO_LEAD);
  assert.deepEqual(await rowOf(gone), before);
  assert.equal(await claimOf(gone), CLAIMED);
});

test("Nik's note survives", async () => {
  const DB = await seed({ research: { notes: "[Nik 2026-10-19] owner is Sue" } });
  const { status } = await post(DB, { ...greenLeaf(), notes: "Checked: Sue Jones on About page" });
  assert.equal(status, 200);
  assert.equal((await rowOf(DB)).notes, "[Nik 2026-10-19] owner is Sue\nChecked: Sue Jones on About page");
});

test("second post overwrites", async () => {
  const DB = await seed({ research: { notes: "[Nik 2026-10-19] owner is Sue" } });
  const first = await post(DB, { ...greenLeaf(), notes: "First look." });
  assert.equal(first.body.grade, "A+");
  // the second post (latest wins): reach 2, a generic inbox → 16, but A needs reach 3+ → B
  const second = greenLeaf();
  second.points.reach = 2;
  second.reasons.reach = "Generic inbox of a small firm";
  second.notes = "Second look.";
  const later = new Date(NOW.getTime() + 60_000);
  const { status, body } = await post(DB, second, { now: later });
  assert.equal(status, 200);
  assert.equal(body.grade, "B");
  const row = await rowOf(DB);
  assert.equal(row.grade, body.grade, "the stored grade matches the second post");
  assert.equal(JSON.parse(row.points).reach, 2);
  assert.equal(row.researched_at, "2026-10-24T09:01:00Z");
  assert.equal(row.notes, "[Nik 2026-10-19] owner is Sue\nSecond look.", "Claude's old notes replaced, Nik's kept");
});

test("leads table untouched", async () => {
  const DB = await seed();
  const before = await leadOf(DB);
  const count = async () => (await DB.prepare("SELECT COUNT(*) AS n FROM leads").first("n"));
  const n = await count();
  // the research names a different owner and best email from the scraper's (David, info@)
  const { status } = await post(DB, greenLeaf());
  assert.equal(status, 200);
  const after = await leadOf(DB);
  assert.deepEqual(after, before);
  assert.equal(JSON.stringify(after), JSON.stringify(before), "byte-identical");
  assert.equal(after.email, "info@greenleaf.co.uk");
  assert.equal(after.director_name, "David Smith");
  assert.equal(after.audit, JSON.stringify(LEAD_AUDIT));
  assert.ok(!after.audit.includes("ai_research"), "nothing writes audit.ai_research");
  assert.equal(await count(), n);
});

// ---------------------------------------------------------------- more

test("401 without the token; nothing written", async () => {
  const DB = await seed();
  const before = await rowOf(DB);
  for (const token of [null, "not-the-key"]) {
    const { status, body } = await post(DB, greenLeaf(), { token });
    assert.equal(status, 401);
    assert.deepEqual(body, { error: "Wrong token" });
  }
  assert.deepEqual(await rowOf(DB), before);
  assert.equal(await claimOf(DB), CLAIMED);
});

test("every column stored as the cleaned post; the row reads back with parseResearch", async () => {
  const DB = await seed();
  const b = greenLeaf();
  b.emails = [
    { email: " Dave@GreenLeaf.co.uk ", source_url: "https://greenleaf.co.uk/contact", where: "Contact page" },
    { email: "info@greenleaf.co.uk", source_url: "https://greenleaf.co.uk/contact", where: "Footer" },
  ];
  b.best_email = "Dave@GreenLeaf.co.uk ";
  b.site_review = { verdict: "Dated", summary: "Old layout, hard to use on a phone.", problems: ["No tap-to-call"], good: ["Clear photos"] };
  b.notes = "Facebook page last posted in September.";
  const { status } = await post(DB, b);
  assert.equal(status, 200);
  const { clean } = validateResearch(b, { name: "Green Leaf Landscapes", town: "Warrington", search_town: "Warrington" });
  const row = await rowOf(DB);
  const r = parseResearch(row);
  assert.equal(row.best_email, "dave@greenleaf.co.uk", "stored lower-cased and trimmed");
  assert.equal(row.best_email_why, "Owner's own address");
  assert.deepEqual(r.points, { need: 5, means: 4, reach: 5, fit: 5, total: 19, capped: null, reasons: clean.reasons });
  assert.deepEqual(Object.keys(r.points), ["need", "means", "reach", "fit", "total", "capped", "reasons"]);
  assert.equal(row.grade_reason, clean.grade_reason);
  assert.deepEqual(r.angle, clean.angle);
  assert.equal(row.opener, clean.opener);
  assert.deepEqual(r.owner, clean.owner);
  assert.deepEqual(r.emails, clean.emails);
  assert.equal(r.emails[0].email, "dave@greenleaf.co.uk");
  assert.deepEqual(r.copy, clean.copy);
  assert.deepEqual(r.site_review, clean.site_review);
  assert.equal(row.too_big, 0);
  assert.equal(r.too_big, false);
  assert.equal(row.notes, "Facebook page last posted in September.");
  assert.deepEqual(r.searched, clean.searched);
  assert.equal(row.queued_at, QUEUED, "queued_at kept");
  // Perfect when #8: the stored grade is what the rubric gives for the stored points
  assert.equal(gradeFrom(r.points, r.too_big).grade, row.grade);
});

test("too big: grade D, capped too_big, copy and site review null", async () => {
  const DB = await seed();
  const b = { ...greenLeaf(), too_big: true, angle: [], opener: "", copy: null, notes: "Twelve vans and an office team." };
  const { status, body } = await post(DB, b);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, { ok: true, place_id: ID, grade: "D", total: 19, capped: "too_big", warnings: [] });
  const row = await rowOf(DB);
  assert.equal(row.too_big, 1);
  assert.equal(row.copy, null);
  assert.equal(row.site_review, null);
  assert.equal(row.angle, "[]");
  assert.equal(row.opener, "");
  assert.equal(JSON.parse(row.points).capped, "too_big");
  assert.equal(gradeFrom(parseResearch(row).points, row.too_big).grade, "D");
});

test("owner named like the business: saved not confident, the warning in the reply and the notes", async () => {
  const DB = await seed({ lead: { name: "Dave's Gardens" }, research: { notes: "[Nik 2026-10-19] check the owner" } });
  const { status, body } = await post(DB, { ...greenLeaf(), notes: "Owner from the About page." });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.warnings, [OWNER_IN_NAME]);
  const row = await rowOf(DB);
  assert.equal(JSON.parse(row.owner).confident, false);
  assert.equal(row.notes, `[Nik 2026-10-19] check the owner\nOwner from the About page.\n${OWNER_IN_NAME}`);
  // the next post without the problem drops the old warning (warnings are replaced like Claude's notes)
  await post(DB, { ...greenLeaf(), owner: { ...greenLeaf().owner, first: "David" }, notes: "" });
  assert.equal((await rowOf(DB)).notes, "[Nik 2026-10-19] check the owner");
});

test("the town as the owner's name is a 400 (the route passes the lead's town and search town)", async () => {
  const DB = await seed({ lead: { town: "Lymm", search_town: "Warrington" } });
  for (const first of ["Warrington", "lymm"]) {
    const { status, body } = await post(DB, { ...greenLeaf(), owner: { ...greenLeaf().owner, first } });
    assert.equal(status, 400);
    assert.ok(body.problems.includes(`"${first}" is the town, not a person`), JSON.stringify(body.problems));
    assert.ok(body.error.startsWith("1 problem: "), body.error);
  }
});

test("a lead with no research row yet gets a done row", async () => {
  const DB = await seed({ research: null, claimed: false });
  const { status, body } = await post(DB, greenLeaf());
  assert.equal(status, 200);
  assert.equal(body.grade, "A+");
  const row = await rowOf(DB);
  assert.equal(row.status, "done");
  assert.equal(row.queued_at, null, "never queued");
  assert.equal(row.researched_at, "2026-10-24T09:00:00Z");
  assert.equal(row.notes, "");
});

test("a re-check: queued again by Nik, the post makes it done with his note on top", async () => {
  const DB = await seed({ research: {
    status: "queued", grade: "B", researched_at: "2026-10-20T07:00:00Z",
    notes: "[Nik 2026-10-23] owner is Sue, not Dave\n[Nik 2026-10-19] Not a fit: Wrong trade\nOld Claude note.\nOld warning.",
  } });
  const { status } = await post(DB, { ...greenLeaf(), notes: "Sue Jones runs it (About page).\nNo second email." });
  assert.equal(status, 200);
  const row = await rowOf(DB);
  assert.equal(row.status, "done");
  assert.equal(row.notes, "[Nik 2026-10-23] owner is Sue, not Dave\n[Nik 2026-10-19] Not a fit: Wrong trade\n" +
    "Sue Jones runs it (About page).\nNo second email.");
});

test("a lead skipped while Claude researched it (Not a fit) is left as it is", async () => {
  const DB = await seed({ research: { status: "skipped", notes: "[Nik 2026-10-24] Not a fit: Wrong trade" } });
  const before = await rowOf(DB);
  const { status, body } = await post(DB, greenLeaf());
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, { ok: true, place_id: ID, grade: "A+", total: 19, capped: null, warnings: [STAYS_SKIPPED] });
  const row = await rowOf(DB);
  assert.deepEqual(row, before, "a post never undoes Nik's Not a fit, nor writes its research into the row");
  assert.equal(row.status, "skipped");
  assert.equal(row.grade, null);
  assert.equal(await claimOf(DB), null, "the claim is still deleted");
});

test("a lead the queue skipped keeps its Skipped: line (the card's reason)", async () => {
  const notes = "Skipped: the scraper excluded this lead (Chain).";
  const DB = await seed({ research: { status: "skipped", notes } });
  const { status, body } = await post(DB, { ...greenLeaf(), notes: "Owner on the About page." });
  assert.equal(status, 200);
  assert.deepEqual(body.warnings, [STAYS_SKIPPED]);
  const row = await rowOf(DB);
  assert.equal(row.status, "skipped");
  assert.equal(row.notes, notes);
  assert.equal(row.points, null);
  assert.equal(row.researched_at, null);
});

test("a row the 12-month purge blanked stays blank", async () => {
  const DB = await seed({ research: { status: "skipped", notes: PURGED, queued_at: null } });
  const before = await rowOf(DB);
  const { status, body } = await post(DB, greenLeaf());
  assert.equal(status, 200);
  assert.deepEqual(body.warnings, [STAYS_SKIPPED]);
  const row = await rowOf(DB);
  assert.deepEqual(row, before);
  for (const c of ["grade", "points", "owner", "emails", "best_email", "copy", "searched", "queued_at", "researched_at"]) {
    assert.equal(row[c], null, `${c} stays empty`);
  }
});

test("the post uses at most 6 D1 statements", async () => {
  const DB = await seed({ research: { notes: "[Nik 2026-10-19] owner is Sue" } });
  const counted = countingDB(DB);
  const request = new Request(`${ORIGIN}/api/agent/research/${ID}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(greenLeaf()),
  });
  const res = await onRequestPost({ request, env: { DB: counted.DB }, params: { id: ID }, now: NOW });
  assert.equal(res.status, 200);
  assert.ok(counted.used() <= 6, `used ${counted.used()}`);
  assert.equal((await rowOf(DB)).status, "done");
});

// ---------------------------------------------------------------- saveResearch

const cleanOf = (body = greenLeaf()) =>
  validateResearch(body, { name: "Green Leaf Landscapes", town: "Warrington", search_town: "Warrington" });

test("saveResearch: one read and one batch (upsert + claim delete)", async () => {
  const DB = await seed();
  const { clean, warnings } = cleanOf();
  const counted = countingDB(DB);
  const result = await saveResearch(counted.DB, ID, clean, gradeFrom(clean.points, clean.too_big), warnings, NOW);
  assert.equal(result, undefined);
  assert.equal(counted.used(), 3);
  assert.equal((await rowOf(DB)).status, "done");
  assert.equal(await claimOf(DB), null);
});

test("saveResearch: a skipped row costs 2 statements and is left as it is", async () => {
  const DB = await seed({ research: { status: "skipped", notes: "[Nik 2026-10-24] Not a fit: Wrong trade" } });
  const before = await rowOf(DB);
  const { clean, warnings } = cleanOf();
  const counted = countingDB(DB);
  assert.equal(await saveResearch(counted.DB, ID, clean, gradeFrom(clean.points), warnings, NOW), undefined);
  assert.equal(counted.used(), 2);
  assert.deepEqual(await rowOf(DB), before);
  assert.equal(await claimOf(DB), null);
});

test("saveResearch: Nik's Not a fit landing while it saves is kept", async () => {
  const DB = await seed();
  const { clean, warnings } = cleanOf({ ...greenLeaf(), notes: "Claude's note." });
  // stage 3's Not a fit lands between saveResearch's read and its write
  let raced = 0;
  const racing = {
    prepare: (sql) => DB.prepare(sql),
    batch: async (stmts) => {
      if (!raced++) {
        await DB.prepare("UPDATE research SET status = 'skipped', notes = ? WHERE place_id = ?")
          .bind("[Nik 2026-10-24] Not a fit: Wrong trade", ID).run();
      }
      return DB.batch(stmts);
    },
  };
  await saveResearch(racing, ID, clean, gradeFrom(clean.points), warnings, NOW);
  assert.equal(raced, 1, "the first write changed nothing; the second read saw the skip and wrote nothing more");
  const row = await rowOf(DB);
  assert.equal(row.status, "skipped");
  assert.equal(row.notes, "[Nik 2026-10-24] Not a fit: Wrong trade");
  assert.equal(row.grade, null);
  assert.equal(await claimOf(DB), null);
});

test("saveResearch: a status change alone (same notes) also stops the write", async () => {
  const DB = await seed({ research: { notes: "Skipped: the lead no longer exists." } });
  const { clean, warnings } = cleanOf();
  let raced = 0;
  const racing = {
    prepare: (sql) => DB.prepare(sql),
    batch: async (stmts) => {
      if (!raced++) await DB.prepare("UPDATE research SET status = 'skipped' WHERE place_id = ?").bind(ID).run();
      return DB.batch(stmts);
    },
  };
  await saveResearch(racing, ID, clean, gradeFrom(clean.points), warnings, NOW);
  const row = await rowOf(DB);
  assert.equal(row.status, "skipped");
  assert.equal(row.grade, null);
  assert.equal(row.notes, "Skipped: the lead no longer exists.");
});

test("saveResearch: a note Nik adds while it saves isn't lost", async () => {
  const DB = await seed({ research: { notes: "[Nik 2026-10-19] owner is Sue" } });
  const { clean, warnings } = cleanOf({ ...greenLeaf(), notes: "Claude's note." });
  // Nik's "Research is wrong" lands between saveResearch's read and its write
  let raced = 0;
  const racing = {
    prepare: (sql) => DB.prepare(sql),
    batch: async (stmts) => {
      if (!raced++) {
        await DB.prepare("UPDATE research SET notes = ? || char(10) || notes WHERE place_id = ?")
          .bind("[Nik 2026-10-24] the email is wrong", ID).run();
      }
      return DB.batch(stmts);
    },
  };
  await saveResearch(racing, ID, clean, gradeFrom(clean.points), warnings, NOW);
  assert.equal(raced, 2, "the first write saw changed notes, so it read again");
  assert.equal((await rowOf(DB)).notes, "[Nik 2026-10-24] the email is wrong\n[Nik 2026-10-19] owner is Sue\nClaude's note.");
});

test("saveResearch: notes that keep changing → a plain error, Nik's lines intact", async () => {
  const DB = await seed({ research: { notes: "[Nik 2026-10-19] owner is Sue" } });
  const { clean, warnings } = cleanOf();
  let n = 0;
  const busy = {
    prepare: (sql) => DB.prepare(sql),
    batch: async (stmts) => {
      await DB.prepare("UPDATE research SET notes = ? || char(10) || notes WHERE place_id = ?")
        .bind(`[Nik 2026-10-24] note ${++n}`, ID).run();
      return DB.batch(stmts);
    },
  };
  await assert.rejects(saveResearch(busy, ID, clean, gradeFrom(clean.points), warnings, NOW), /kept changing.*post it again/i);
  const row = await rowOf(DB);
  assert.equal(row.status, "queued", "nothing of the post was written");
  assert.ok(row.notes.endsWith("[Nik 2026-10-19] owner is Sue"));
  assert.equal(row.notes.split("\n").length, n + 1);
});
