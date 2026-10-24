// Research notes merge, parsing, email hit rate and the research health light (03-research-grade Task 3; all pure),
// then the light's facts from D1 and its place in stage 0's healthFromDb (Task 7; db section at the end).
// Run: node --test control-room/tests/research-health.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { healthFromDb, healthStep } from "../functions/_lib/health.js";
import { researchFacts } from "../functions/_lib/research-db.js";
import { emailHitRate, latestNikNote, mergeNotes, parseResearch, researchLight } from "../functions/_lib/research.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const HOUR = 3_600_000;
const now = new Date("2026-10-20T12:00:00Z");
const ago = (hours) => new Date(now.getTime() - hours * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");
// n rows {best_email, too_big}: the first `hits` have an email.
const rows = (hits, n, tooBig = 0) =>
  Array.from({ length: n }, (_, i) => ({ best_email: i < hits ? `owner${i}@firm${i}.co.uk` : null, too_big: tooBig }));

const RED_FIX = `Open claude.ai/code/routines, check "aetos-research" is on and its last run finished, then press Run now.`;
const AMBER_FIX = `Open a few on the Leads page and press "Research is wrong" where Claude missed an email.`;

// ---------------------------------------------------------------- mergeNotes

test("mergeNotes: Nik's lines stay on top, Claude's notes replace the rest, then the warnings", () => {
  assert.equal(
    mergeNotes("[Nik 2026-10-19] wrong owner\nold claude", "new claude", ["Owner's first name…"]),
    "[Nik 2026-10-19] wrong owner\nnew claude\nOwner's first name…",
  );
});

test("mergeNotes: every Nik line is kept, in order, even ones below Claude's old notes; old warnings go", () => {
  const old = "[Nik 2026-10-19] Owner is Sue, not Dave\n[Nik 2026-10-12] Not a fit: Wrong trade\nold claude line one\n" +
    "old claude line two\nOwner's first name is also in the business name, so emails say \"Hi,\" until Nik confirms it.\n" +
    "[Nik 2026-10-01] check the Facebook page";
  assert.equal(
    mergeNotes(old, "Checked: Sue Jones on the About page", []),
    "[Nik 2026-10-19] Owner is Sue, not Dave\n[Nik 2026-10-12] Not a fit: Wrong trade\n[Nik 2026-10-01] check the Facebook page\n" +
      "Checked: Sue Jones on the About page",
  );
});

test("mergeNotes: nothing old, no Claude notes, no warnings, null or Windows line ends", () => {
  assert.equal(mergeNotes("", "new claude"), "new claude");
  assert.equal(mergeNotes(null, null), "");
  assert.equal(mergeNotes(undefined, "", ["  ", "A warning"]), "A warning");
  assert.equal(mergeNotes("[Nik 2026-10-19] owner is Sue\r\nold claude", ""), "[Nik 2026-10-19] owner is Sue");
  assert.equal(mergeNotes("Skipped: the lead no longer exists.", "line one\nline two"), "line one\nline two");
});

test("mergeNotes: a line of Claude's that passes for one of Nik's is never kept as his", () => {
  // validateResearch rejects these; this is the last guard, so a forged line can't reach the top on the next post.
  const merged = mergeNotes("[Nik 2026-10-19] owner is Sue", "Checked the About page\n  [Nik 2026-10-20] owner is Bob\nDone", []);
  assert.equal(merged, "[Nik 2026-10-19] owner is Sue\nChecked the About page\nDone");
  assert.equal(mergeNotes(merged, "Second run", []), "[Nik 2026-10-19] owner is Sue\nSecond run");
  assert.equal(latestNikNote(merged), "owner is Sue");
});

// ---------------------------------------------------------------- latestNikNote

test("latestNikNote: of two Nik lines, the last (newest) one's text, without the [Nik date] prefix", () => {
  assert.equal(latestNikNote("[Nik 2026-10-12] wrong owner\n[Nik 2026-10-19] owner is Sue"), "owner is Sue");
});

test("latestNikNote: newest by date when lines are on top (as Research is wrong writes them); same day = the top one", () => {
  assert.equal(latestNikNote("[Nik 2026-10-19] owner is Sue\n[Nik 2026-10-12] wrong owner\nclaude"), "owner is Sue");
  assert.equal(latestNikNote("[Nik 2026-10-19] second note\n[Nik 2026-10-19] first note"), "second note");
  assert.equal(latestNikNote("[Nik 2026-10-19] owner is Sue"), "owner is Sue");
  assert.equal(latestNikNote("[Nik 2026-10-19] Not a fit: Wrong trade"), "Not a fit: Wrong trade");
});

test("latestNikNote: null when there's no Nik line", () => {
  assert.equal(latestNikNote(""), null);
  assert.equal(latestNikNote(null), null);
  assert.equal(latestNikNote("Checked: Nik said nothing\nSkipped: the lead no longer exists."), null);
});

// ---------------------------------------------------------------- parseResearch

test("parseResearch: bad JSON falls back, too_big becomes a boolean; null gives null", () => {
  const r = parseResearch({
    place_id: "p1", status: "done", grade: "C", points: "{bad", grade_reason: "Why", angle: "[oops", opener: "Hi",
    owner: "nope", best_email: null, emails: "{", copy: "]", site_review: "{x", too_big: 1, notes: "", searched: "[",
    queued_at: "2026-10-19T06:00:00Z", researched_at: "2026-10-19T07:00:00Z",
  });
  assert.equal(r.points, null);
  assert.equal(r.too_big, true);
  assert.deepEqual(r.angle, []);
  assert.equal(r.owner, null);
  assert.deepEqual(r.emails, []);
  assert.equal(r.copy, null);
  assert.equal(r.site_review, null);
  assert.deepEqual(r.searched, []);
  assert.equal(r.grade, "C");
  assert.equal(r.researched_at, "2026-10-19T07:00:00Z");
  assert.equal(parseResearch(null), null);
});

test("parseResearch: a stored row comes back with every JSON column parsed", () => {
  const points = { need: 5, means: 4, reach: 5, fit: 5, total: 19, capped: null,
    reasons: { need: "No website", means: "61 reviews", reach: "Dave's own email", fit: "Owner-run landscaper" } };
  const owner = { first: "Dave", full: "Dave Smith", source_url: "https://greenleaf.co.uk/about", confident: true };
  const emails = [{ email: "dave@greenleaf.co.uk", source_url: "https://greenleaf.co.uk/contact", where: "Contact page" }];
  const copy = { headline: "Landscaping in Warrington", intro: "Patios", services: ["Patios"], areas: ["Warrington"], about: "" };
  const siteReview = { verdict: "Dated", summary: "Hard to use on a phone", problems: ["No tap-to-call"], good: [] };
  const r = parseResearch({
    place_id: "p1", status: "done", grade: "A+", points: JSON.stringify(points), grade_reason: "Why",
    angle: JSON.stringify([{ fact: "No website", source_url: "https://x.co" }]), opener: "Line one\nLine two",
    owner: JSON.stringify(owner), best_email: "dave@greenleaf.co.uk", best_email_why: "Owner's own address",
    emails: JSON.stringify(emails), copy: JSON.stringify(copy), site_review: JSON.stringify(siteReview), too_big: 0,
    notes: "[Nik 2026-10-19] owner is Sue", searched: JSON.stringify(["a", "b", "c"]), queued_at: null,
    researched_at: "2026-10-19T07:00:00Z",
  });
  assert.deepEqual(r.points, points);
  assert.equal(r.points.reasons.need, "No website");
  assert.deepEqual(r.angle, [{ fact: "No website", source_url: "https://x.co" }]);
  assert.deepEqual(r.owner, owner);
  assert.deepEqual(r.emails, emails);
  assert.deepEqual(r.copy, copy);
  assert.deepEqual(r.site_review, siteReview);
  assert.deepEqual(r.searched, ["a", "b", "c"]);
  assert.equal(r.too_big, false);
  assert.equal(r.notes, "[Nik 2026-10-19] owner is Sue");
  assert.equal(r.best_email, "dave@greenleaf.co.uk");
  assert.equal(r.opener, "Line one\nLine two");
});

test("parseResearch: a queued row (no data yet) and JSON of the wrong shape", () => {
  const r = parseResearch({ place_id: "p2", status: "queued", too_big: 0, notes: "", queued_at: "2026-10-19T06:00:00Z" });
  assert.equal(r.points, null);
  assert.deepEqual(r.emails, []);
  assert.deepEqual(r.angle, []);
  assert.equal(r.owner, null);
  assert.equal(r.too_big, false);
  const odd = parseResearch({ points: "[1,2]", emails: "{\"a\":1}", owner: "\"Dave\"", searched: "5", too_big: null, notes: null });
  assert.equal(odd.points, null);
  assert.deepEqual(odd.emails, []);
  assert.equal(odd.owner, null);
  assert.deepEqual(odd.searched, []);
  assert.equal(odd.too_big, false);
  assert.equal(odd.notes, "");
});

// ---------------------------------------------------------------- emailHitRate

test("emailHitRate: 7 emails in 20 rows is 35%; too_big rows aren't counted", () => {
  assert.deepEqual(emailHitRate(rows(7, 20)), { hits: 7, n: 20, pct: 35 });
  assert.deepEqual(emailHitRate([...rows(7, 20), ...rows(3, 4, 1)]), { hits: 7, n: 20, pct: 35 });
  assert.deepEqual(emailHitRate([...rows(2, 3), { best_email: "info@big.co.uk", too_big: true }]), { hits: 2, n: 3, pct: 67 });
});

test("emailHitRate: no judged rows gives pct null; an empty best_email isn't a hit", () => {
  assert.deepEqual(emailHitRate([]), { hits: 0, n: 0, pct: null });
  assert.deepEqual(emailHitRate(rows(2, 2, 1)), { hits: 0, n: 0, pct: null });
  assert.deepEqual(emailHitRate([{ best_email: "", too_big: 0 }, { best_email: "  ", too_big: 0 }]), { hits: 0, n: 2, pct: 0 });
});

// ---------------------------------------------------------------- researchLight

test("researchLight: 27 h without a post while 5 wait is red", () => {
  assert.deepEqual(researchLight({ queued: 5, lastPostAt: ago(27), recent: rows(10, 20) }, now), {
    name: "research", level: "red", detail: "No research posted for 27 hours; 5 leads waiting.", fix: RED_FIX,
  });
});

test("researchLight: never posted, the oldest lead queued 30 h ago is red", () => {
  const l = researchLight({ queued: 5, lastPostAt: null, oldestQueuedAt: ago(30), recent: [] }, now);
  assert.equal(l.level, "red");
  assert.equal(l.detail, "No research posted for 30 hours; 5 leads waiting.");
  assert.equal(l.fix, RED_FIX);
});

test("researchLight: nothing waiting is never red, however long since the last post", () => {
  const l = researchLight({ queued: 0, lastPostAt: ago(5 * 24), oldestQueuedAt: null, recent: rows(10, 20) }, now);
  assert.notEqual(l.level, "red");
  assert.equal(l.level, "green");
  assert.equal(l.detail, "0 waiting · last research 120 h ago · emails found 50%");
});

test("researchLight: 7 of the last 20 with an email is amber", () => {
  assert.deepEqual(researchLight({ queued: 3, lastPostAt: ago(2), oldestQueuedAt: ago(1), recent: rows(7, 20) }, now), {
    name: "research", level: "amber", detail: "Emails found for 7 of the last 20 researched (35%); target 40%+.", fix: AMBER_FIX,
  });
});

test("researchLight: fewer than 10 judged is green (3 of 9)", () => {
  const l = researchLight({ queued: 3, lastPostAt: ago(2), oldestQueuedAt: ago(1), recent: rows(3, 9) }, now);
  assert.equal(l.level, "green");
  assert.equal(l.detail, "3 waiting · last research 2 h ago · emails found 33%");
  assert.equal(l.fix, "");
});

test("researchLight: 8 of 20 is green with the hit rate shown", () => {
  const l = researchLight({ queued: 3, lastPostAt: ago(2), oldestQueuedAt: ago(1), recent: rows(8, 20) }, now);
  assert.equal(l.level, "green");
  assert.ok(l.detail.includes("emails found 40%"), l.detail);
  assert.equal(l.name, "research");
});

test("researchLight: too_big rows don't count towards the 10, and only the last 20 rows are read", () => {
  // 12 too big + 8 judged (1 hit): only 8 judged, so not amber.
  const mixed = [...rows(0, 12, 1), ...rows(1, 8)];
  assert.equal(researchLight({ queued: 1, lastPostAt: ago(1), recent: mixed }, now).level, "green");
  // The newest 20 have 10 hits (50%); 30 older rows with none are past the last 20.
  const many = [...rows(10, 20), ...rows(0, 30)];
  const l = researchLight({ queued: 1, lastPostAt: ago(1), recent: many }, now);
  assert.equal(l.level, "green");
  assert.ok(l.detail.endsWith("emails found 50%"), l.detail);
});

test("researchLight: red is checked before amber, and hours are rounded down", () => {
  const l = researchLight({ queued: 2, lastPostAt: ago(26.9), oldestQueuedAt: ago(40), recent: rows(1, 20) }, now);
  assert.equal(l.level, "red");
  assert.equal(l.detail, "No research posted for 26 hours; 2 leads waiting.");
  assert.equal(researchLight({ queued: 2, lastPostAt: ago(25.99), oldestQueuedAt: ago(40), recent: [] }, now).level, "green");
});

test("researchLight: leads waiting since before the last post: red 26 h after that post", () => {
  // Like the db test's data: 4 queued since 2026-10-18T05:00:00Z, the newest post a day later, now 27 h after it.
  const facts = { queued: 4, lastPostAt: "2026-10-19T09:00:00Z", oldestQueuedAt: "2026-10-18T05:00:00Z", recent: rows(7, 20) };
  const l = researchLight(facts, new Date("2026-10-20T12:00:00Z"));
  assert.equal(l.level, "red");
  assert.equal(l.detail, "No research posted for 27 hours; 4 leads waiting.");
  assert.equal(researchLight(facts, new Date("2026-10-20T10:59:59Z")).level, "amber"); // 25 h 59 min 59 s: not yet
  assert.equal(researchLight(facts, new Date("2026-10-20T11:00:00Z")).level, "red"); // 26 h exactly
});

test("researchLight: one lead waiting reads \"1 lead waiting\"", () => {
  const l = researchLight({ queued: 1, lastPostAt: null, oldestQueuedAt: ago(48), recent: [] }, now);
  assert.equal(l.detail, "No research posted for 48 hours; 1 lead waiting.");
});

test("researchLight: a lead queued just now after quiet days isn't red until it has waited 26 h too", () => {
  // The Routine ran daily with nothing to do, then Nik pressed "Research is wrong" an hour ago.
  const fresh = researchLight({ queued: 1, lastPostAt: ago(5 * 24), oldestQueuedAt: ago(1), recent: rows(10, 20) }, now);
  assert.equal(fresh.level, "green");
  assert.equal(fresh.detail, "1 waiting · last research 120 h ago · emails found 50%");
  // Once it has waited 26 h with still no post, it is red, and the detail tells the true time since the last post.
  const stuck = researchLight({ queued: 1, lastPostAt: ago(5 * 24), oldestQueuedAt: ago(26), recent: rows(10, 20) }, now);
  assert.equal(stuck.level, "red");
  assert.equal(stuck.detail, "No research posted for 120 hours; 1 lead waiting.");
});

test("researchLight: green leaves out what isn't known; the light is never grey", () => {
  assert.deepEqual(researchLight({ queued: 0, lastPostAt: null, oldestQueuedAt: null, recent: [] }, now), {
    name: "research", level: "green", detail: "0 waiting", fix: "",
  });
  assert.equal(researchLight({ queued: 4, lastPostAt: ago(3), recent: [] }, now).detail, "4 waiting · last research 3 h ago");
  assert.equal(researchLight({ queued: 4, lastPostAt: null, oldestQueuedAt: ago(2), recent: rows(1, 2) }, now).detail,
    "4 waiting · emails found 50%");
  for (const facts of [{}, null, undefined, { queued: "x", lastPostAt: "not a time", recent: "nope" }]) {
    const l = researchLight(facts, now);
    assert.equal(l.level, "green");
    assert.equal(l.name, "research");
  }
  // ISO text works as the time now too, as it does for stage 0's lights.
  assert.equal(researchLight({ queued: 5, lastPostAt: ago(27) }, "2026-10-20T12:00:00Z").level, "red");
});

test("researchLight: the light is named exactly research, never a prefix of routine:research or the reverse", () => {
  const { name } = researchLight({ queued: 0, recent: [] }, now);
  assert.equal(name, "research");
  assert.ok(!"routine:research".startsWith(name) && !name.startsWith("routine:research"));
  assert.notEqual(name, "research_queue");
});

// ---------------------------------------------------------------- the facts from D1, and healthFromDb (Task 7)

const NEWEST_POST = "2026-10-19T09:00:00Z";
const OLDEST_QUEUED = "2026-10-18T05:00:00Z";
const isoAt = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const dbCtx = (DB, at) => ({ DB, env: {}, now: at, reason: "health", results: {}, budget: { left: () => 50 } });

const addRow = (DB, place_id, o = {}) =>
  DB.prepare("INSERT INTO research (place_id, status, best_email, too_big, notes, queued_at, researched_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(place_id, o.status ?? "done", o.best_email ?? null, o.too_big ?? 0, o.notes ?? "", o.queued_at ?? null,
      o.researched_at ?? null).run();

// 4 queued (the oldest since OLDEST_QUEUED) and 22 done, d<i> posted i hours before NEWEST_POST. 7 of the newest 20
// have a best_email, and so do both older ones (d20, d21), so reading all 22, or the wrong 20, gives another count.
// The done rows were queued before OLDEST_QUEUED, so only the queued rows may set oldestQueuedAt. Inserted out of
// order, so only ORDER BY researched_at finds the newest.
const DONE_HITS = new Set([0, 2, 4, 6, 8, 10, 12, 20, 21]);
async function seedStalled(DB) {
  for (const [i, queuedAt] of ["2026-10-19T06:00:00Z", OLDEST_QUEUED, "2026-10-19T10:00:00Z", "2026-10-18T20:00:00Z"].entries()) {
    await addRow(DB, `q${i}`, { status: "queued", queued_at: queuedAt });
  }
  for (let k = 0; k < 22; k++) {
    const i = (k * 7) % 22; // each of 0..21 once, out of order
    await addRow(DB, `d${i}`, {
      best_email: DONE_HITS.has(i) ? `owner${i}@firm${i}.co.uk` : null,
      queued_at: "2026-10-17T06:00:00Z",
      researched_at: isoAt(Date.parse(NEWEST_POST) - i * HOUR),
    });
  }
}

test("facts from the db", async () => {
  const DB = fakeD1();
  await seedStalled(DB);
  const facts = await researchFacts(DB);
  assert.equal(facts.queued, 4);
  assert.equal(facts.oldestQueuedAt, "2026-10-18T05:00:00Z");
  assert.equal(facts.recent.length, 20);
  assert.equal(facts.lastPostAt, NEWEST_POST);
  assert.deepEqual(Object.keys(facts).sort(), ["lastPostAt", "oldestQueuedAt", "queued", "recent"]);
  // The last 20 done rows, newest first, each exactly {best_email, too_big}: 7 with an email.
  assert.deepEqual(facts.recent.map((r) => r.best_email),
    Array.from({ length: 20 }, (_, i) => (DONE_HITS.has(i) ? `owner${i}@firm${i}.co.uk` : null)));
  for (const r of facts.recent) assert.deepEqual(Object.keys(r).sort(), ["best_email", "too_big"]);
  assert.deepEqual(emailHitRate(facts.recent), { hits: 7, n: 20, pct: 35 });
});

test("researchFacts: one D1 statement; nothing yet; skipped and re-queued rows; too_big comes back", async () => {
  const empty = countingDB(fakeD1());
  assert.deepEqual(await researchFacts(empty.DB), { queued: 0, lastPostAt: null, oldestQueuedAt: null, recent: [] });
  assert.equal(empty.used(), 1);

  const DB = fakeD1();
  await addRow(DB, "big", { best_email: "info@bigfirm.co.uk", too_big: 1, researched_at: "2026-10-19T08:00:00Z" });
  await addRow(DB, "none", { researched_at: "2026-10-19T07:00:00Z" });
  // Nik's "Not a fit" after Claude's post: not waiting and not in the hit rate, but Claude did post at 10:00.
  await addRow(DB, "skip", { status: "skipped", best_email: "jo@skip.co.uk", notes: "[Nik 2026-10-19] Not a fit: Wrong trade",
    queued_at: "2026-10-18T06:00:00Z", researched_at: "2026-10-19T10:00:00Z" });
  // Skipped by the queue before any research: no post time, never waiting.
  await addRow(DB, "gone", { status: "skipped", notes: "Skipped: the lead no longer exists.", queued_at: "2026-10-17T06:00:00Z" });
  // "Research is wrong": queued again, keeping its old post time.
  await addRow(DB, "recheck", { status: "queued", best_email: "sue@recheck.co.uk", queued_at: "2026-10-19T11:00:00Z",
    researched_at: "2026-10-19T09:00:00Z" });
  const counted = countingDB(DB);
  assert.deepEqual(await researchFacts(counted.DB), {
    queued: 1,
    lastPostAt: "2026-10-19T10:00:00Z",
    oldestQueuedAt: "2026-10-19T11:00:00Z",
    recent: [{ best_email: "info@bigfirm.co.uk", too_big: 1 }, { best_email: null, too_big: 0 }],
  });
  assert.equal(counted.used(), 1, "a registered light makes at most 1 D1 query");
});

test("healthFromDb includes research", async () => {
  const DB = fakeD1();
  await seedStalled(DB);
  const now27 = new Date(Date.parse(NEWEST_POST) + 27 * HOUR);
  const { lights } = await healthFromDb(DB, {}, now27);
  assert.equal(lights.find((l) => l.name === "research").level, "red");
  assert.equal(lights.some((l) => l.name === "research_queue"), false);
  const mine = lights.filter((l) => l.name === "research");
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0], { name: "research", level: "red", detail: "No research posted for 27 hours; 4 leads waiting.", fix: RED_FIX });
  assert.ok(lights.indexOf(mine[0]) >= 10, "after stage 0's 10");
  const names = lights.map((l) => l.name);
  for (const a of names) for (const b of names) if (a !== b) assert.ok(!b.startsWith(a), `${a} is a prefix of ${b}`);
  // 25 h after the post it isn't red yet: the same data is amber (7 of 20).
  const early = (await healthFromDb(DB, {}, new Date(Date.parse(NEWEST_POST) + 25 * HOUR))).lights.find((l) => l.name === "research");
  assert.equal(early.level, "amber");
  assert.equal(early.detail, "Emails found for 7 of the last 20 researched (35%); target 40%+.");
});

test("the health step opens health:research when it's red and closes it once Claude posts again", async () => {
  const DB = fakeD1();
  await seedStalled(DB);
  const now27 = new Date(Date.parse(NEWEST_POST) + 27 * HOUR);
  await healthStep.run(dbCtx(DB, now27));
  const open = await DB.prepare("SELECT * FROM todos WHERE dedupe = 'health:research'").first();
  assert.equal(open.status, "open");
  assert.equal(open.kind, "health");
  assert.equal(open.title, "No research posted for 27 hours; 4 leads waiting.");
  assert.equal(open.detail, RED_FIX);

  // Claude posts one lead; 5 minutes later the light isn't red, so the todo closes (by its exact dedupe).
  await DB.prepare("UPDATE research SET status = 'done', researched_at = ? WHERE place_id = 'q1'").bind(isoAt(now27)).run();
  const later = new Date(now27.getTime() + 5 * 60_000);
  await healthStep.run(dbCtx(DB, later));
  assert.equal(await DB.prepare("SELECT * FROM todos WHERE dedupe = 'health:research'").first(), null);
  const closed = await DB.prepare("SELECT status FROM todos WHERE dedupe = ?").bind(`health:research@${isoAt(later)}`).first();
  assert.equal(closed.status, "done");
});

test("GET /api/health shows the research light in an isolate that loaded nothing else (tick.js imports research-db.js)", () => {
  // A fresh node process importing only the route, like a /api/health call that is the isolate's first request.
  const url = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  const code = `
    import { onRequestGet } from ${url("../functions/api/health.js")};
    import { fakeD1 } from ${url("./helpers/fakeD1.mjs")};
    const DB = fakeD1();
    await DB.prepare("INSERT INTO research (place_id, status, queued_at) VALUES ('q1', 'queued', '2000-01-01T00:00:00Z')").run();
    const body = await (await onRequestGet({ env: { DB } })).json();
    console.log(JSON.stringify(body.lights.filter((l) => l.name === "research" || l.name === "research_queue")));`;
  const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { encoding: "utf8" });
  const lights = JSON.parse(out.trim().split("\n").pop());
  assert.equal(lights.length, 1);
  assert.equal(lights[0].name, "research");
  assert.equal(lights[0].level, "red");
  assert.match(lights[0].detail, /^No research posted for \d+ hours; 1 lead waiting\.$/);
  assert.equal(lights[0].fix, RED_FIX);
});
