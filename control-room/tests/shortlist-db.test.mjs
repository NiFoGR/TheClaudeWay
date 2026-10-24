// Shortlist in D1 (stage 3, Tasks 3 and 4): the lead list with its filters and sort, the "Ready to email" rule, today's
// room for first emails (capacityNow), the ready counts behind it, and the lead panel's one-request payload
// (leadDetail). Rules: docs/rebuild/04-shortlist.md Part A.
// Run: node --test control-room/tests/shortlist-db.test.mjs
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { parseLeadFilters } from "../functions/_lib/shortlist.js";
import { READY_SQL, capacityNow, leadDetail, listLeads, readyCounts } from "../functions/_lib/shortlist-db.js";
import { GUARANTEE, offerFor } from "../functions/_lib/offer.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import {
  LIVE_UNTIL, SEED_AT, seedDemo, seedLead, seedMailbox, seedMessage, seedProspect, seedResearch, seedSuppression,
} from "./helpers/shortlistSeed.mjs";

const NOW = new Date("2026-10-21T08:00:00Z"); // Wed 09:00 UK (BST); mailbox m1 (started 2026-08-01) has cap 10
const EXPIRED = "2026-10-21T07:59:59Z"; // a second before NOW
const F = (s = "") => parseLeadFilters(new URLSearchParams(s));
const ALL = (o = {}) => ({ ...F("view=all"), ...o });
const ids = (result) => result.rows.map((r) => r.place_id);
const sorted = (list) => [...list].sort();

const ROW_KEYS = [
  "place_id", "name", "trade", "town", "phone", "website", "rating", "review_count", "quality_score", "excluded", "grade",
  "grade_reason", "research_status", "email", "suppressed", "stage", "stage_label", "views", "last_view_at", "hot",
  "demo_slug", "top_issue", "owner_first",
];

// A lead with done A research, a ready prospect and a live demo (the ready rule), each part overridable or left out.
async function readyLead(DB, place_id, { lead = {}, research = {}, prospect = {}, demo = {}, noProspect = false } = {}) {
  await seedLead(DB, { place_id, ...lead });
  await seedResearch(DB, { place_id, ...research });
  if (!noProspect) await seedProspect(DB, { place_id, ...prospect });
  await seedDemo(DB, { place_id, ...demo });
}

// The spec's 12 leads: 3 qualifying (A+ 60, A 80, A 50) and 9 that each break exactly one rule. The breakers score
// higher, so one that leaked into Ready would sort first. `followups` queued follow-ups take places in today's cap.
async function seedTwelve(DB, followups) {
  await seedMailbox(DB);
  await readyLead(DB, "ok-ap", { lead: { quality_score: 60 }, research: { grade: "A+" } });
  await readyLead(DB, "ok-a80", { lead: { quality_score: 80 } });
  await readyLead(DB, "ok-a50", { lead: { quality_score: 50 } });
  await readyLead(DB, "grade-c", { lead: { quality_score: 91 }, research: { grade: "C" } });
  await readyLead(DB, "grade-b", { lead: { quality_score: 92 }, research: { grade: "B" } });
  await readyLead(DB, "excluded", { lead: { quality_score: 93, excluded: 1, exclude_reason: "A chain" } });
  await readyLead(DB, "too-big", { lead: { quality_score: 94 }, research: { too_big: 1 } });
  await readyLead(DB, "queued", { lead: { quality_score: 95 }, research: { status: "queued" } });
  await readyLead(DB, "emailed", { lead: { quality_score: 96 }, prospect: { stage: "emailed", first_sent_at: "2026-10-20T08:00:00Z" } });
  await readyLead(DB, "no-prospect", { lead: { quality_score: 97 }, research: { best_email: "dave@noprospect.co.uk" }, noProspect: true });
  await readyLead(DB, "expired", { lead: { quality_score: 98 }, demo: { created_at: "2026-09-21T08:00:00Z", expires_at: EXPIRED } });
  await readyLead(DB, "suppressed", { lead: { quality_score: 99 }, prospect: { email: "Joe@Example.co.uk" } });
  const stored = await seedSuppression(DB, "EXAMPLE.co.uk", "domain");
  assert.equal(stored.value, "example.co.uk"); // stored lower-case, as suppress() stores it
  for (let i = 0; i < followups; i++) await seedMessage(DB, { place_id: "emailed", kind: "followup", status: "queued" });
}

test("ready view", async () => {
  const DB = fakeD1();
  await seedTwelve(DB, 7);
  const result = await listLeads(DB, F(""), NOW);
  const { rows, ready } = result;
  assert.deepEqual(rows.map((r) => r.grade + ":" + r.quality_score), ["A+:60", "A:80", "A:50"]);
  assert.equal(ready.top, 3);
  assert.equal(ready.b_included, false);
  assert.equal(ready.b, 1);
  assert.deepEqual(ready.grades, ["A+", "A"]);
  assert.equal(result.capacity.room, 3);
  assert.equal(result.total, 3);
  assert.deepEqual(result.view_counts, { ready: 3, all: 11 }); // All leads hides the excluded one
  assert.ok(rows.every((r) => r.email && r.demo_slug && r.stage === "ready" && r.stage_label === "Ready to email"));
  assert.deepEqual(ids(result), ["ok-ap", "ok-a80", "ok-a50"]);
  // Trade, town, search and grade chips still narrow Ready.
  assert.deepEqual(ids(await listLeads(DB, F("grade=ap"), NOW)), ["ok-ap"]);
  assert.deepEqual(ids(await listLeads(DB, F("grade=a"), NOW)), ["ok-a80", "ok-a50"]);
  assert.deepEqual(ids(await listLeads(DB, F("grade=b"), NOW)), []); // B isn't in Ready today
  // Ready shows only the A+, A and B chips: a C, D or Not graded chip carried over from All leads is ignored there.
  assert.deepEqual(ids(await listLeads(DB, F("grade=c,d,none"), NOW)), ["ok-ap", "ok-a80", "ok-a50"]);
  assert.deepEqual(ids(await listLeads(DB, F("grade=ap,c"), NOW)), ["ok-ap"]);
  assert.deepEqual(ids(await listLeads(DB, { ...F(""), grades: [] }, NOW)), ["ok-ap", "ok-a80", "ok-a50"]); // no chips ticked
  assert.deepEqual(ids(await listLeads(DB, F("q=ok-a8"), NOW)), ["ok-a80"]);
  assert.deepEqual(ids(await listLeads(DB, F("trade=roofer"), NOW)), []);
  // Grade chips in Ready count every grade the ready rule lets through (B's count shows beside "Spare room only").
  assert.deepEqual(result.grade_counts, { "A+": 1, A: 2, B: 1, C: 1, D: 0, none: 0 });
  // In All leads the suppressed lead is tagged, never hidden.
  const all = await listLeads(DB, ALL(), NOW);
  assert.equal(all.total, 11);
  assert.equal(all.rows.find((r) => r.place_id === "suppressed").suppressed, true);
  assert.equal(all.rows.find((r) => r.place_id === "ok-ap").suppressed, false);
  assert.equal(all.rows.find((r) => r.place_id === "no-prospect").email, "dave@noprospect.co.uk");
});

test("B joins with spare room", async () => {
  const DB = fakeD1();
  await seedTwelve(DB, 0);
  const { rows, ready, capacity } = await listLeads(DB, F(""), NOW);
  assert.equal(capacity.room, 10);
  assert.deepEqual(rows.map((r) => r.grade + ":" + r.quality_score), ["A+:60", "A:80", "A:50", "B:92"]);
  assert.equal(ready.b_included, true);
  assert.deepEqual(ready.grades, ["A+", "A", "B"]);
  assert.deepEqual(ids(await listLeads(DB, F("grade=b"), NOW)), ["grade-b"]);
  assert.equal((await readyCounts(DB, NOW, 3)).b_included, false); // room 3 = top 3: not larger
  assert.equal((await readyCounts(DB, NOW, 4)).b_included, true);
});

test("waiting for demo", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "a1" });
  await seedResearch(DB, { place_id: "a1", grade: "A", best_email: "mark@greenleaf.co.uk" });
  assert.equal((await readyCounts(DB, NOW, 0)).graded_top, 1);
  const { ready, rows } = await listLeads(DB, F(""), NOW);
  assert.equal(ready.waiting_demo, 1);
  assert.equal(ready.top, 0);
  assert.deepEqual(rows, []);
  // Not waiting: a B lead, an A lead with no email anywhere, one already emailed, one suppressed, one too big.
  await seedLead(DB, { place_id: "b1" });
  await seedResearch(DB, { place_id: "b1", grade: "B", best_email: "b1@b1.co.uk" });
  await seedLead(DB, { place_id: "a-noemail", email: "" });
  await seedResearch(DB, { place_id: "a-noemail", grade: "A+", best_email: "" });
  await readyLead(DB, "a-emailed", { prospect: { stage: "emailed" } });
  await seedLead(DB, { place_id: "a-supp", email: "Mark@Blocked.co.uk" });
  await seedResearch(DB, { place_id: "a-supp" });
  await seedSuppression(DB, "mark@blocked.co.uk", "email");
  await seedLead(DB, { place_id: "a-big", email: "info@big.co.uk" });
  await seedResearch(DB, { place_id: "a-big", too_big: 1 });
  // Waiting: a ready prospect whose only demo has expired, and an A+ lead with the scraper's email.
  await readyLead(DB, "a-expired", { demo: { expires_at: EXPIRED } });
  await seedLead(DB, { place_id: "ap-scraped", email: "hello@scraped.co.uk" });
  await seedResearch(DB, { place_id: "ap-scraped", grade: "A+" });
  assert.equal((await readyCounts(DB, NOW, 0)).waiting_demo, 3);
  // graded_top: every lead graded A+ or A, whatever happened since (emailed, no email, suppressed, too big), never B.
  assert.equal((await readyCounts(DB, NOW, 0)).graded_top, 7);
});

test("graded A+/A leads are counted even when none is ready or waiting for its demo", async () => {
  const DB = fakeD1();
  assert.equal((await readyCounts(DB, NOW, 10)).graded_top, 0); // no leads at all
  await seedLead(DB, { place_id: "ungraded" });
  await seedResearch(DB, { place_id: "ungraded", grade: null });
  await seedLead(DB, { place_id: "c1" });
  await seedResearch(DB, { place_id: "c1", grade: "C" });
  assert.equal((await readyCounts(DB, NOW, 10)).graded_top, 0); // C and not graded aren't A-grade
  // Every A-grade lead emailed or marked Not a fit: Ready is empty and nothing waits on a demo, yet they exist.
  await readyLead(DB, "a-emailed", { prospect: { stage: "emailed", first_sent_at: "2026-10-20T08:00:00Z" } });
  await seedLead(DB, { place_id: "ap-skipped", email: "jo@skipped.co.uk" });
  await seedResearch(DB, { place_id: "ap-skipped", grade: "A+", status: "skipped" });
  const ready = await readyCounts(DB, NOW, 10);
  assert.deepEqual({ top: ready.top, waiting_demo: ready.waiting_demo, graded_top: ready.graded_top },
    { top: 0, waiting_demo: 0, graded_top: 2 });
  assert.equal((await listLeads(DB, F(""), NOW)).ready.graded_top, 2);
});

test("all view filters", async () => {
  const DB = fakeD1();
  await readyLead(DB, "ap", { lead: { quality_score: 70 }, research: { grade: "A+" } });
  // "Saxby" holds a, x, b: a "_" read as a wildcard would match it.
  await readyLead(DB, "a-emailed", { lead: { quality_score: 60, name: "Saxby Builders" }, prospect: { stage: "emailed" } });
  await seedLead(DB, { place_id: "ng-norow", name: "100% Roofing", trade: "roofer", email: "" });
  await seedLead(DB, { place_id: "ng-null", name: "1000 Roofs", trade: "roofer", email: "info@1000roofs.co.uk" });
  await seedResearch(DB, { place_id: "ng-null", status: "queued", grade: null });
  await seedLead(DB, { place_id: "sk", name: "O'Neill Plumbing", trade: "plumber", search_town: "Runcorn", town: "Runcorn" });
  await seedResearch(DB, {
    place_id: "sk", status: "skipped", grade: "D", best_email: "pat@oneill.co.uk",
    emails: [{ email: "pat@oneill.co.uk", source_url: "https://oneill.co.uk", where: "Contact page" }, { email: "jobs@oneill.co.uk", source_url: "https://oneill.co.uk/jobs", where: "Jobs" }],
    owner: { first: "Pat", full: "Patrick O'Neill", source_url: "https://oneill.co.uk/about", confident: true },
  });
  await seedLead(DB, { place_id: "b", name: "A_B Gardens", email: "hi@ab.co.uk", emails: ["hi@ab.co.uk", "accounts@ab-gardens.co.uk"] });
  await seedResearch(DB, { place_id: "b", grade: "B" });
  await seedLead(DB, { place_id: "x-excl", name: "Excluded Ltd", excluded: 1, exclude_reason: "Front desk" });

  assert.deepEqual(ids(await listLeads(DB, ALL({ grades: ["A+"] }), NOW)), ["ap"]);
  assert.ok((await listLeads(DB, ALL({ grades: ["A+"] }), NOW)).rows.every((r) => r.grade === "A+"));
  assert.deepEqual(sorted(ids(await listLeads(DB, ALL({ grades: ["none"] }), NOW))), ["ng-norow", "ng-null"]);
  assert.deepEqual(sorted(ids(await listLeads(DB, ALL({ grades: ["B", "none"] }), NOW))), ["b", "ng-norow", "ng-null"]);
  assert.deepEqual(sorted(ids(await listLeads(DB, ALL({ stages: ["none"] }), NOW))), ["b", "ng-norow", "ng-null", "sk"]);
  assert.deepEqual(ids(await listLeads(DB, ALL({ stages: ["emailed"] }), NOW)), ["a-emailed"]);
  assert.deepEqual(ids(await listLeads(DB, ALL({ email: false }), NOW)), ["ng-norow"]);
  assert.deepEqual(sorted(ids(await listLeads(DB, ALL({ email: true }), NOW))), ["a-emailed", "ap", "b", "ng-null", "sk"]);
  assert.deepEqual(sorted(ids(await listLeads(DB, ALL({ researched: true }), NOW))), ["a-emailed", "ap", "b", "sk"]);
  assert.deepEqual(sorted(ids(await listLeads(DB, ALL({ researched: false }), NOW))), ["ng-norow", "ng-null"]);
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "100%" }), NOW)), ["ng-norow"]);
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "o'neill" }), NOW)), ["sk"]);
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "a_b" }), NOW)), ["b"]); // _ is literal, not "any one character"
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "patrick" }), NOW)), ["sk"]); // owner's full name
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "JOBS@" }), NOW)), ["sk"]); // any of research's emails
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "accounts@" }), NOW)), ["b"]); // any of the scraper's emails
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "source_url" }), NOW)), []); // never the JSON around them
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "runcorn" }), NOW)), ["sk"]);
  assert.deepEqual(sorted(ids(await listLeads(DB, ALL({ trade: "roofer" }), NOW))), ["ng-norow", "ng-null"]);
  assert.deepEqual(ids(await listLeads(DB, ALL({ town: "Runcorn" }), NOW)), ["sk"]);
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "excluded" }), NOW)), []);
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "excluded", excluded: true }), NOW)), ["x-excl"]);
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "%" }), NOW)), ["ng-norow"]);
  // Sort: grade A+ → D → not graded, then score.
  assert.deepEqual(ids(await listLeads(DB, ALL(), NOW)), ["ap", "a-emailed", "b", "sk", "ng-norow", "ng-null"]);
  // An empty set of chips means no filter (Part A), even when a caller passes [] instead of null.
  assert.deepEqual(ids(await listLeads(DB, ALL({ grades: [], stages: [] }), NOW)), ["ap", "a-emailed", "b", "sk", "ng-norow", "ng-null"]);
  await seedLead(DB, { place_id: "bs", name: "Back\\Slash Fencing" });
  await seedLead(DB, { place_id: "bs-not", name: "BackSlash Fencing" });
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "k\\s" }), NOW)), ["bs"]); // \ is literal, not an escape
});

test("a lead with two demos and three messages appears once", async () => {
  const DB = fakeD1();
  await seedMailbox(DB);
  await readyLead(DB, "twice", { demo: { slug: "green-leaf", created_at: "2026-10-01T08:00:00Z", expires_at: "2026-10-31T08:00:00Z" } });
  await seedDemo(DB, { place_id: "twice", slug: "green-leaf-old", created_at: "2026-09-01T08:00:00Z", expires_at: "2026-10-01T08:00:00Z" });
  await seedDemo(DB, { place_id: "twice", slug: "green-leaf-new-dead", created_at: "2026-10-05T08:00:00Z", expires_at: EXPIRED });
  for (const kind of ["first", "followup", "inbound"]) await seedMessage(DB, { place_id: "twice", kind, status: kind === "inbound" ? "received" : "sent" });
  for (const [id, status] of [["call-1", "cancelled"], ["call-2", "offered"]]) {
    await DB.prepare("INSERT INTO calls (id, place_id, slot_at, status, created_at, updated_at) VALUES (?1, 'twice', ?2, ?3, ?2, ?2)")
      .bind(id, "2026-10-22T10:00:00Z", status).run();
  }
  const now = new Date("2026-10-21T08:00:00Z");
  for (const filters of [ALL(), F("")]) {
    const result = await listLeads(DB, filters, now);
    assert.equal(result.rows.length, 1);
    assert.equal(result.total, 1);
    assert.equal(result.rows[0].demo_slug, "green-leaf");
  }
  assert.equal((await readyCounts(DB, now, 10)).top, 1);
  // Two live demos: the newest is the one shown, whichever was saved first.
  await readyLead(DB, "renewed", { demo: { slug: "renewed-old", created_at: "2026-09-25T08:00:00Z", expires_at: "2026-10-25T08:00:00Z" } });
  await seedDemo(DB, { place_id: "renewed", slug: "renewed-new", created_at: "2026-10-20T08:00:00Z" });
  const both = await listLeads(DB, ALL(), now);
  assert.deepEqual(both.rows.map((r) => [r.place_id, r.demo_slug]).sort(), [["renewed", "renewed-new"], ["twice", "green-leaf"]]);
  assert.equal(both.total, 2);
});

test("grade counts", async () => {
  const DB = fakeD1();
  const plan = [["A+", 5], ["A", 10], ["B", 10], ["C", 5], ["D", 5], [null, 5], ["norow", 10]];
  let n = 0;
  for (const [grade, count] of plan) {
    for (let i = 0; i < count; i++) {
      const place_id = `g${String(++n).padStart(2, "0")}`;
      await seedLead(DB, { place_id, excluded: n % 9 === 0 ? 1 : 0, trade: n % 2 ? "roofer" : "landscaper" });
      if (grade !== "norow") await seedResearch(DB, { place_id, grade, status: grade === null ? "queued" : "done" });
    }
  }
  const page1 = await listLeads(DB, F("view=all&excluded=1"), NOW);
  assert.equal(page1.total, 50);
  assert.equal(page1.pages, 1);
  const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(sum(page1.grade_counts), page1.total);
  assert.deepEqual(page1.grade_counts, { "A+": 5, A: 10, B: 10, C: 5, D: 5, none: 15 });
  assert.equal(page1.view_counts.all, 50);
  assert.deepEqual(page1.facets.trades, [{ value: "landscaper", n: 25 }, { value: "roofer", n: 25 }]);
  assert.deepEqual(page1.facets.towns, [{ value: "Warrington", n: 50 }]);
  // The grade filter doesn't change the chip counts (all filters except grade).
  const onlyA = await listLeads(DB, F("view=all&excluded=1&grade=a"), NOW);
  assert.equal(onlyA.total, 10);
  assert.deepEqual(onlyA.grade_counts, page1.grade_counts);
  // Show excluded off: 5 excluded leads (every 9th) leave the list and the counts.
  const shown = await listLeads(DB, F("view=all"), NOW);
  assert.equal(shown.total, 45);
  assert.equal(sum(shown.grade_counts), 45);
  assert.equal(shown.view_counts.all, 45);
  // Page 2: rows only.
  for (let i = 0; i < 10; i++) await seedLead(DB, { place_id: `z${i}` });
  const page2 = await listLeads(DB, F("view=all&excluded=1&page=2"), NOW);
  assert.equal(page2.grade_counts, null);
  assert.equal(page2.view_counts, null);
  assert.equal(page2.facets, null);
  assert.equal(page2.total, 60);
  assert.equal(page2.page, 2);
  assert.equal(page2.pages, 2);
  assert.equal(page2.rows.length, 10);
  // Past the last page: no rows, the total still true.
  const page9 = await listLeads(DB, F("view=all&excluded=1&page=9"), NOW);
  assert.deepEqual([page9.rows.length, page9.total, page9.pages, page9.page], [0, 60, 2, 9]);
});

test("capacity", async () => {
  const DB = fakeD1();
  await seedMailbox(DB);
  await seedMailbox(DB, { id: "sys", role: "system", cap_override: 50 }); // never sends cold email
  for (let i = 0; i < 7; i++) await seedMessage(DB, { kind: "followup", status: "queued" });
  await seedMessage(DB, { kind: "first", status: "sent", sent_at: "2026-10-20T15:00:00Z" }); // yesterday
  await seedMessage(DB, { kind: "reply", status: "sent" }); // replies aren't cold email
  const c = await capacityNow(DB, NOW);
  assert.equal(c.room, 3);
  assert.deepEqual(c.banner, { tone: "ok", text: "You can send 3 first emails today (10 a day, 7 follow-ups already due).", link: null });
  assert.deepEqual({ ...c, banner: undefined }, {
    mailboxes: 1, paused: [], cap: 10, sent: 0, followupsDue: 7, firstQueued: 0, room: 3, warmupFrom: "2026-10-21",
    today: "2026-10-21", sendDay: "2026-10-21", nextDay: "2026-10-22", banner: undefined,
  });
  await seedMessage(DB, { kind: "first", status: "sent" });
  await seedMessage(DB, { kind: "first", status: "sent" });
  await seedMessage(DB, { kind: "first", status: "queued" });
  const full = await capacityNow(DB, NOW);
  assert.equal(full.room, 0); // 10 − 2 − 7 − 1
  assert.deepEqual([full.sent, full.followupsDue, full.firstQueued], [2, 7, 1]);
  assert.equal(full.banner.text,
    "No room for more first emails today (10 a day, 7 follow-ups already due, 2 already sent, 1 first email waiting to go). The next ones can go tomorrow.");
  const none = await capacityNow(fakeD1(), NOW);
  assert.equal(none.banner.link.href, "#/setup");
  assert.equal(none.banner.text, "Add your mailbox on Setup to start emailing.");
  assert.deepEqual([none.mailboxes, none.cap, none.room, none.warmupFrom], [0, 0, 0, null]);
});

test("capacity: paused and warming-up mailboxes", async () => {
  const paused = fakeD1();
  await seedMailbox(paused, { status: "paused", paused_reason: "2 hard bounces in 7 days" });
  const p = await capacityNow(paused, NOW);
  assert.deepEqual(p.paused, [{ address: "m1@aetoswebsites.com", reason: "2 hard bounces in 7 days" }]);
  assert.equal(p.cap, 0);
  assert.equal(p.banner.text, "Sending is paused: 2 hard bounces in 7 days. Fix it on Setup.");
  const warming = fakeD1();
  await seedMailbox(warming, { started_on: "2026-10-20" });
  const w = await capacityNow(warming, NOW);
  assert.deepEqual([w.cap, w.room, w.warmupFrom], [0, 0, "2026-11-03"]);
  assert.equal(w.banner.text, "Your mailbox is warming up. First emails can go from Tue 3 Nov.");
  // Two cold mailboxes, one paused: the other's cap still counts, and the banner isn't "paused".
  const two = fakeD1();
  await seedMailbox(two, { id: "m1", status: "paused", paused_reason: "You paused it on Setup." });
  await seedMailbox(two, { id: "m2", cap_override: 6 });
  const t = await capacityNow(two, NOW);
  assert.deepEqual([t.mailboxes, t.cap, t.room, t.paused.length], [2, 6, 6, 1]);
  assert.equal(t.banner.tone, "ok");
});

test("capacity outside the send window never says first emails go today", async () => {
  // Cold email goes Mon–Sat 07:00–19:00 UK only (stage 0's COLD_WINDOW). One mailbox at 10 a day, nothing due.
  const DB = fakeD1();
  await seedMailbox(DB);
  const cases = [
    // [now, today, sendDay, nextDay, banner]
    ["2026-10-25T07:00:00Z", "2026-10-25", "2026-10-26", "2026-10-26", // Sun 07:00 GMT (the clocks went back)
      "You can write 10 first emails now. They go out Mon 26 Oct from 07:00 (10 a day)."],
    ["2026-10-24T19:30:00Z", "2026-10-24", "2026-10-26", "2026-10-26", // Sat 20:30 BST
      "You can write 10 first emails now. They go out Mon 26 Oct from 07:00 (10 a day)."],
    ["2027-03-28T06:00:00Z", "2027-03-28", "2027-03-29", "2027-03-29", // Sun 07:00 BST (the clocks went forward)
      "You can write 10 first emails now. They go out Mon 29 Mar from 07:00 (10 a day)."],
    ["2026-10-21T18:00:00Z", "2026-10-21", "2026-10-22", "2026-10-22", // Wed 19:00 BST: 19:00 itself is outside
      "You can write 10 first emails now. They go out Thu 22 Oct from 07:00 (10 a day)."],
    ["2026-10-24T17:59:00Z", "2026-10-24", "2026-10-24", "2026-10-26", // Sat 18:59 BST: still inside
      "You can send 10 first emails today (10 a day)."],
    ["2026-10-24T05:30:00Z", "2026-10-24", "2026-10-24", "2026-10-26", // Sat 06:30 BST: today's window opens at 07:00
      "You can send 10 first emails today (10 a day)."],
  ];
  for (const [now, today, sendDay, nextDay, text] of cases) {
    const c = await capacityNow(DB, new Date(now));
    assert.deepEqual([c.today, c.sendDay, c.nextDay], [today, sendDay, nextDay], now);
    assert.equal(c.banner.text, text, now);
  }
});

test("statement budget", async () => {
  const DB = fakeD1();
  await seedMailbox(DB);
  for (let i = 0; i < 60; i++) {
    const place_id = `s${String(i).padStart(2, "0")}`;
    if (i % 3 === 0) await readyLead(DB, place_id, { research: { grade: i % 2 ? "A" : "B" } });
    else await seedLead(DB, { place_id, quality_score: i });
    if (i % 5 === 0) await seedMessage(DB, { place_id, kind: "first", status: "sent" });
  }
  let prepared = 0;
  const wrapped = { ...DB, prepare: (sql) => (prepared++, DB.prepare(sql)) };
  const counted = countingDB(wrapped);
  const result = await listLeads(counted.DB, parseLeadFilters(new URLSearchParams("view=all")), NOW);
  assert.ok(prepared <= 12, `listLeads prepared ${prepared} statements`);
  assert.ok(counted.used() <= 12, `listLeads ran ${counted.used()} statements`);
  assert.equal(result.rows.length, 50);
  assert.equal(result.pages, 2);
  assert.equal(result.total, 60);
  for (const s of ["", "view=all&page=2", "view=all&grade=ap,none&stage=none&email=1&researched=1&q=s1&trade=landscaper&town=Warrington&job=j1&excluded=1"]) {
    const c = countingDB(DB);
    await listLeads(c.DB, F(s), NOW);
    assert.ok(c.used() <= 12, `"${s}" ran ${c.used()} statements`);
  }
});

test("no audit or html", async () => {
  const DB = fakeD1();
  await readyLead(DB, "h1", {
    lead: { audit: { pages_html: "<html><body>Their site</body></html>", findings: ["no_website"] }, issues: ["No website"] },
  });
  for (const filters of [F(""), ALL(), ALL({ q: "html" })]) {
    const text = JSON.stringify(await listLeads(DB, filters, NOW));
    assert.doesNotMatch(text, /"audit"/);
    assert.doesNotMatch(text, /<html/);
  }
  assert.deepEqual(ids(await listLeads(DB, ALL({ q: "html" }), NOW)), []); // search never reads the audit
});

test("row fields", async () => {
  const DB = fakeD1();
  await readyLead(DB, "r1", {
    lead: { name: "Green Leaf", phone: "01925 111222", website: "https://greenleaf.co.uk", rating: 4.9, review_count: 61, quality_score: 72, issues: ["No photos of your work", "No reviews link"] },
    research: { grade: "A+", grade_reason: "Owner-run, good reviews, weak site.", owner: { first: "Mark", full: "Mark Dean", source_url: "https://greenleaf.co.uk/about", confident: true } },
    prospect: { email: "mark@greenleaf.co.uk" },
    demo: { slug: "green-leaf" },
  });
  await readyLead(DB, "r2", {
    research: { owner: { first: "Dave", full: "Dave Smith", source_url: "https://x.co.uk", confident: false } },
    prospect: { stage: "viewed", views: 2, last_view_at: "2026-10-20T08:00:00Z" },
  });
  await readyLead(DB, "r3", { lead: { issues: "not json" }, research: { owner: "not json" }, prospect: { stage: "replied", views: 3, last_inbound_at: "2026-10-20T09:00:00Z" } });
  await seedLead(DB, { place_id: "r4", company_number: "01234567" });
  await seedSuppression(DB, "01234567", "company");
  const { rows } = await listLeads(DB, ALL(), NOW);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), [...ROW_KEYS].sort());
  const by = Object.fromEntries(rows.map((r) => [r.place_id, r]));
  assert.deepEqual(by.r1, {
    place_id: "r1", name: "Green Leaf", trade: "landscaper", town: "Warrington", phone: "01925 111222",
    website: "https://greenleaf.co.uk", rating: 4.9, review_count: 61, quality_score: 72, excluded: false, grade: "A+",
    grade_reason: "Owner-run, good reviews, weak site.", research_status: "done", email: "mark@greenleaf.co.uk",
    suppressed: false, stage: "ready", stage_label: "Ready to email", views: 0, last_view_at: null, hot: false,
    demo_slug: "green-leaf", top_issue: "No photos of your work", owner_first: "Mark",
  });
  assert.equal(by.r2.owner_first, null); // not confident: emails say "Hi,"
  assert.equal(by.r2.hot, true);
  assert.equal(by.r2.stage_label, "Opened demo");
  assert.deepEqual([by.r3.top_issue, by.r3.owner_first, by.r3.hot, by.r3.stage_label], [null, null, false, "Replied"]);
  assert.deepEqual([by.r4.stage, by.r4.stage_label, by.r4.grade, by.r4.research_status, by.r4.suppressed], [null, "Not contacted", null, null, true]);
});

test("a suppressed address, domain or company number never reaches Ready", async () => {
  const DB = fakeD1();
  await seedMailbox(DB);
  await readyLead(DB, "ok");
  await readyLead(DB, "by-address", { prospect: { email: "Pat@Mixed.co.uk" } });
  await seedSuppression(DB, "PAT@mixed.CO.UK", "email"); // stored lower-case
  await readyLead(DB, "by-company", { lead: { company_number: "SC123456" } });
  await seedSuppression(DB, "sc123456", "company"); // stored upper-case, as Companies House writes it
  // Only the domain of the address we'd write to counts: another lead at a different domain stays in.
  await readyLead(DB, "other-domain", { prospect: { email: "pat@mixed.com" } });
  const { rows, ready } = await listLeads(DB, F(""), NOW);
  assert.deepEqual(sorted(rows.map((r) => r.place_id)), ["ok", "other-domain"]);
  assert.equal(ready.top, 2);
  const all = await listLeads(DB, ALL(), NOW);
  assert.deepEqual(
    sorted(all.rows.filter((r) => r.suppressed).map((r) => r.place_id)), ["by-address", "by-company"]);
});

test("READY_SQL is the ready rule, binding now as ?1", async () => {
  assert.match(READY_SQL, /d\.expires_at > \?1/);
  assert.doesNotMatch(READY_SQL, /\?(?!1\b)/);
  const DB = fakeD1();
  await readyLead(DB, "ok");
  await readyLead(DB, "late", { demo: { expires_at: "2026-10-21T09:00:00Z" } });
  const sql = `SELECT l.place_id FROM leads l LEFT JOIN research r ON r.place_id = l.place_id
    LEFT JOIN prospects p ON p.place_id = l.place_id WHERE ${READY_SQL} ORDER BY l.place_id`;
  const at = async (iso) => (await DB.prepare(sql).bind(iso).all()).results.map((r) => r.place_id);
  assert.deepEqual(await at("2026-10-21T08:00:00Z"), ["late", "ok"]);
  assert.deepEqual(await at("2026-10-21T09:00:00Z"), ["ok"]); // expired at that very second
});

// ---- The lead panel's payload (Task 4: leadDetail) ----

const POINTS = {
  need: 4, means: 3, reach: 5, fit: 4, total: 16, capped: null,
  reasons: { need: "No website", means: "61 reviews", reach: "Owner's own email", fit: "Landscaper" },
};
const MARK = { first: "Mark", full: "Mark Dean", source_url: "https://x.co.uk/about", confident: true };
const DETAIL_KEYS = ["lead", "research", "research_waiting", "prospect", "demo", "map_rank", "messages", "calls", "suppressed", "offer", "guarantee"];
const LEAD_KEYS = [
  "place_id", "name", "trade", "town", "search_town", "address", "postcode", "phone", "website", "maps_url", "rating",
  "review_count", "quality_score", "company_number", "excluded", "exclude_reason", "issues", "findings", "socials", "reviews",
  "notes", "first_seen_at", "email",
];
const MESSAGE_KEYS = [
  "id", "direction", "kind", "step", "author", "from_addr", "to_addr", "subject", "body", "status", "sent_at", "received_at",
  "created_at", "class",
];
const keys = (o) => Object.keys(o).sort();
// demo.template is stage 4's templateIdFor(trade): null until _lib/demo/data.js ships.
const DEMO_DATA = new URL("../functions/_lib/demo/data.js", import.meta.url);
const templateOf = async (trade) => (existsSync(DEMO_DATA) ? (await import(DEMO_DATA.href)).templateIdFor(trade) : null);
// Hour i of 1 Oct 2026, as stored.
const msgAt = (i) => new Date(Date.parse("2026-10-01T08:00:00Z") + i * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");

async function seedMapRank(DB, place_id, o = {}) {
  const row = {
    place_id, scan_id: "scan-w", keyword: "landscaper", town: "Warrington", avg_rank: 6.5, top3_pct: 12, found_pct: 80,
    updated_at: SEED_AT, ...o,
  };
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO lead_map_rank (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`)
    .bind(...Object.values(row)).run();
}

async function seedCall(DB, id, place_id, slot_at, status) {
  await DB.prepare("INSERT INTO calls (id, place_id, slot_at, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)")
    .bind(id, place_id, slot_at, status, SEED_AT).run();
}

// Green Leaf: an A lead ready to email, with Claude's research, a live demo (and a newer expired one), its own town's
// Map Rank row, 5 reviews and raw HTML in its audit, 40 messages saved out of order (plus another lead's) and 6 calls.
// Two more leads wait in the research queue.
async function seedGreenLeaf(DB) {
  const reviews = [
    { author: "Sarah K.", rating: 5, text: "Brilliant job on our garden, tidy and on time." },
    { author: "Tom B.", rating: 5, text: "y".repeat(900) },
    { author: "Jo P.", rating: 4, text: "Good value and friendly, would use again." },
    { author: "Ann C.", rating: 5, text: "Fourth review, not shown." },
    { author: "Bob D.", rating: 5, text: "Fifth review, not shown." },
  ];
  await seedLead(DB, {
    place_id: "gl", name: "Green Leaf Landscapes", address: "1 High St, Warrington", postcode: "WA1 1AA",
    phone: "01925 111222", website: "https://greenleaf.co.uk", maps_url: "https://maps.google.com/?cid=1", rating: 4.9,
    review_count: 61, quality_score: 72, company_number: "01234567", email: "info@greenleaf.co.uk",
    issues: ["No photos of your work"], socials: { facebook: "https://facebook.com/greenleaf" }, notes: "Call Friday",
    audit: {
      pages_html: "<html><body>Their site</body></html>", findings: ["no_website", "maps_invisible"], reviews,
      map_rank: { avg_rank: 6.5, top3_pct: 12, found_pct: 80, scan_town: "Warrington", home: true },
    },
  });
  await seedResearch(DB, {
    place_id: "gl", grade: "A", points: POINTS, owner: MARK, grade_reason: "Owner-run, good reviews, weak site.",
    angle: [{ fact: "No photos of their work on Google", source_url: "https://g.co/x" }], best_email: "mark@greenleaf.co.uk",
    emails: [{ email: "mark@greenleaf.co.uk", source_url: "https://x.co.uk/about", where: "About page" }],
  });
  for (const id of ["q1", "q2"]) {
    await seedLead(DB, { place_id: id });
    await seedResearch(DB, { place_id: id, status: "queued", grade: null, researched_at: null });
  }
  await seedProspect(DB, { place_id: "gl", email: "mark@greenleaf.co.uk", greet_name: "Mark" });
  await seedDemo(DB, { place_id: "gl", slug: "green-leaf", created_at: "2026-10-15T08:00:00Z" });
  await seedDemo(DB, { place_id: "gl", slug: "green-leaf-dead", created_at: "2026-10-16T08:00:00Z", expires_at: EXPIRED });
  await seedMapRank(DB, "gl");
  for (let n = 0; n < 40; n++) {
    const i = (n * 17) % 40; // every hour 0–39 once, saved out of order
    const kind = i === 0 ? { kind: "first", status: "sent", sent_at: msgAt(0) }
      : i % 2 ? { kind: "inbound", class: "human" } : { kind: "followup", step: i / 2, status: "sent" };
    await seedMessage(DB, { id: `gl-${String(i).padStart(2, "0")}`, place_id: "gl", created_at: msgAt(i), ...kind });
  }
  await seedMessage(DB, { id: "other-1", place_id: "q1", created_at: msgAt(0) });
  for (let i = 0; i < 6; i++) {
    await seedCall(DB, `call-${i}`, "gl", `2026-10-${22 + i}T10:00:00Z`, i === 5 ? "confirmed" : "cancelled");
  }
}

test("lead detail", async () => {
  const DB = fakeD1();
  await seedGreenLeaf(DB);
  const d = await leadDetail(DB, "gl", NOW);
  assert.deepEqual(keys(d), [...DETAIL_KEYS].sort());
  // Claude's research, parsed as stage 2's card reads it.
  assert.equal(d.research.points.reach, 5);
  assert.equal(d.research.points.reasons.reach, "Owner's own email");
  assert.deepEqual(d.research.points, POINTS);
  assert.deepEqual(d.research.owner, MARK);
  assert.deepEqual(d.research.angle, [{ fact: "No photos of their work on Google", source_url: "https://g.co/x" }]);
  assert.deepEqual([d.research.place_id, d.research.status, d.research.grade, d.research.too_big], ["gl", "done", "A", false]);
  assert.equal(d.research.grade_reason, "Owner-run, good reviews, weak site.");
  assert.equal(d.research.best_email, "mark@greenleaf.co.uk");
  assert.equal(d.research_waiting, 2);
  // The live demo, as a relative link (Nik's own visits never count); the expired newer one is ignored.
  assert.equal(d.demo.url, "/d/green-leaf");
  assert.deepEqual(d.demo, { slug: "green-leaf", url: "/d/green-leaf", expires_at: LIVE_UNTIL, template: await templateOf("landscaper") });
  // The lead: best 3 reviews (text cut to 600 characters), its own town's Maps findings, never the audit.
  assert.equal(d.lead.reviews.length, 3);
  assert.deepEqual(d.lead.reviews[0], { author: "Sarah K.", rating: 5, text: "Brilliant job on our garden, tidy and on time." });
  assert.equal(d.lead.reviews[1].text, `${"y".repeat(600)}…`);
  assert.deepEqual(d.lead.reviews.map((r) => r.author), ["Sarah K.", "Tom B.", "Jo P."]);
  assert.equal("audit" in d.lead, false);
  assert.deepEqual(keys(d.lead), [...LEAD_KEYS].sort());
  assert.deepEqual(d.lead.findings, ["no_website", "maps_invisible"]);
  assert.deepEqual(d.lead.issues, ["No photos of your work"]);
  assert.deepEqual(d.lead.socials, { facebook: "https://facebook.com/greenleaf" });
  assert.deepEqual(
    [d.lead.name, d.lead.town, d.lead.search_town, d.lead.postcode, d.lead.company_number, d.lead.excluded, d.lead.notes],
    ["Green Leaf Landscapes", "Warrington", "Warrington", "WA1 1AA", "01234567", false, "Call Friday"]);
  assert.equal(d.lead.email, "mark@greenleaf.co.uk"); // the address we'd write to, as in the list
  // Every message, oldest first; only this lead's.
  assert.equal(d.messages.length, 40);
  assert.deepEqual(d.messages.map((m) => m.created_at), Array.from({ length: 40 }, (_, i) => msgAt(i)));
  for (const m of d.messages) assert.deepEqual(keys(m), [...MESSAGE_KEYS].sort());
  assert.deepEqual([d.messages[0].id, d.messages[0].kind, d.messages[0].direction, d.messages[0].author], ["gl-00", "first", "out", "nik"]);
  assert.deepEqual([d.messages[1].kind, d.messages[1].direction, d.messages[1].class], ["inbound", "in", "human"]);
  assert.equal(d.messages[2].step, 1);
  // The 5 latest calls, latest first.
  assert.deepEqual(d.calls.map((c) => c.slot_at), [27, 26, 25, 24, 23].map((n) => `2026-10-${n}T10:00:00Z`));
  assert.deepEqual(d.calls[0], { slot_at: "2026-10-27T10:00:00Z", status: "confirmed" });
  assert.deepEqual(d.map_rank, { scan_id: "scan-w", keyword: "landscaper", avg_rank: 6.5, top3_pct: 12, found_pct: 80, updated_at: SEED_AT });
  assert.deepEqual(d.prospect, {
    stage: "ready", stage_label: "Ready to email", stage_at: SEED_AT, email: "mark@greenleaf.co.uk", greet_name: "Mark",
    first_sent_at: null, followup_step: 0, next_followup_at: null, views: 0, last_view_at: null, last_inbound_at: null,
    lost_reason: null, hot: false,
  });
  assert.equal(d.suppressed, false);
  // Today's offer and the guarantee, from offer.js.
  assert.equal(d.offer.full.monthly, 24900);
  assert.deepEqual(d.offer, offerFor(NOW));
  assert.equal(d.guarantee.headline, "Top 3 in Google search results in 90 days. GUARANTEED.");
  assert.deepEqual(d.guarantee, GUARANTEE);
  // No raw HTML or audit blob leaves the API.
  const text = JSON.stringify(d);
  assert.doesNotMatch(text, /"audit"/);
  assert.doesNotMatch(text, /<html/);
});

test("lead detail without research, prospect or demo; hot, suppressed and weekend", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "bare" });
  const d = await leadDetail(DB, "bare", NOW);
  assert.deepEqual({ ...d, lead: undefined, offer: undefined, guarantee: undefined }, {
    lead: undefined, research: null, research_waiting: 0, prospect: null, demo: null, map_rank: null, messages: [], calls: [],
    suppressed: false, offer: undefined, guarantee: undefined,
  });
  assert.deepEqual(d.lead, {
    place_id: "bare", name: "Lead bare", trade: "landscaper", town: "Warrington", search_town: "Warrington", address: null,
    postcode: null, phone: null, website: null, maps_url: null, rating: 4.8, review_count: 20, quality_score: 50,
    company_number: null, excluded: false, exclude_reason: null, issues: [], findings: [], socials: {}, reviews: [],
    notes: "", first_seen_at: SEED_AT, email: null,
  });
  // Only an expired demo: none. Viewed twice: hot. Its company number on the do-not-contact list: suppressed.
  await seedLead(DB, { place_id: "hot", company_number: "SC123456", excluded: 1, exclude_reason: "A chain" });
  await seedProspect(DB, { place_id: "hot", stage: "viewed", views: 2, last_view_at: "2026-10-20T08:00:00Z", first_sent_at: "2026-10-19T08:00:00Z" });
  await seedDemo(DB, { place_id: "hot", expires_at: EXPIRED });
  await seedSuppression(DB, "sc123456", "company");
  const h = await leadDetail(DB, "hot", NOW);
  assert.equal(h.demo, null);
  assert.deepEqual([h.prospect.stage, h.prospect.stage_label, h.prospect.views, h.prospect.hot], ["viewed", "Opened demo", 2, true]);
  assert.equal(h.suppressed, true);
  assert.deepEqual([h.lead.excluded, h.lead.exclude_reason, h.lead.email], [true, "A chain", "hot@example.com"]);
  // A suppressed domain of the address we'd write to (any case).
  await seedLead(DB, { place_id: "dom", email: "Pat@Blocked.co.uk" });
  await seedSuppression(DB, "BLOCKED.co.uk", "domain");
  assert.equal((await leadDetail(DB, "dom", NOW)).suppressed, true);
  // Saturday (UK time): the weekend deal.
  const sat = new Date("2026-10-24T10:00:00Z");
  const w = await leadDetail(DB, "hot", sat);
  assert.equal(w.offer.weekend, true);
  assert.deepEqual(w.offer, offerFor(sat));
});

test("detail budget", async () => {
  const DB = fakeD1();
  await seedGreenLeaf(DB);
  let prepared = 0;
  const wrapped = { ...DB, prepare: (sql) => (prepared++, DB.prepare(sql)) };
  const counted = countingDB(wrapped);
  const d = await leadDetail(counted.DB, "gl", NOW);
  assert.equal(d.messages.length, 40);
  // The lead row (with research_waiting as a scalar subquery), then one batch of demo, messages and calls.
  assert.ok(prepared <= 4, `leadDetail prepared ${prepared} statements`);
  assert.ok(counted.used() <= 4, `leadDetail ran ${counted.used()} statements`);
  const missing = countingDB(DB);
  assert.equal(await leadDetail(missing.DB, "nope", NOW), null);
  assert.equal(missing.used(), 1); // the lead lookup only
});

test("bad json and missing lead", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "bj", issues: "nope", socials: "[1,2]", audit: "{not json" });
  await seedResearch(DB, { place_id: "bj", angle: "not json", points: "{bad", owner: "[]", emails: '{"a":1}', site_review: "nope" });
  await seedProspect(DB, { place_id: "bj" });
  await seedMapRank(DB, "bj");
  const d = await leadDetail(DB, "bj", NOW);
  assert.deepEqual(d.research.angle, []);
  assert.deepEqual([d.research.points, d.research.owner, d.research.site_review, d.research.emails], [null, null, null, []]);
  assert.deepEqual([d.lead.issues, d.lead.findings, d.lead.reviews, d.lead.socials], [[], [], [], {}]);
  assert.equal(d.map_rank.scan_id, "scan-w"); // an unreadable audit can't say the scan is another town's
  // JSON of the wrong shape: findings and reviews that aren't lists, odd items in them, a Map Rank part that's a list.
  await seedLead(DB, {
    place_id: "odd", issues: ["Slow site", 3, null],
    audit: {
      findings: ["no_website", 7, { a: 1 }],
      reviews: [null, "great", { author: 5, rating: "5", text: "Lovely work, thank you!" }, { author: "Ed", rating: 4, text: "" }],
      map_rank: [1],
    },
  });
  const o = await leadDetail(DB, "odd", NOW);
  assert.deepEqual(o.lead.findings, ["no_website"]);
  assert.deepEqual(o.lead.issues, ["Slow site"]);
  assert.deepEqual(o.lead.reviews, [{ author: "", rating: null, text: "Lovely work, thank you!" }]);
  await seedLead(DB, { place_id: "shape", audit: { findings: { a: 1 }, reviews: "great", map_rank: "Runcorn" } });
  const s = await leadDetail(DB, "shape", NOW);
  assert.deepEqual([s.lead.findings, s.lead.reviews], [[], []]);
  // A lead that isn't there (deleted between the list and the panel), or no id at all.
  assert.equal(await leadDetail(DB, "nope", NOW), null);
  assert.equal(await leadDetail(DB, undefined, NOW), null);
  assert.equal(await leadDetail(DB, "", NOW), null);
});

test("no Maps lines from another town", async () => {
  const DB = fakeD1();
  const findings = ["no_website", "maps_invisible", "reviews_behind"];
  const runcorn = { avg_rank: 21, top3_pct: 0, found_pct: 0, scan_town: "Runcorn" };
  // A lead with those findings, the audit's Map Rank part `mapRank` and a lead_map_rank row of its own town (unless
  // `row` says otherwise).
  const detail = async (place_id, town, mapRank, row = {}) => {
    await seedLead(DB, { place_id, town, search_town: town, audit: { findings, map_rank: mapRank } });
    await seedMapRank(DB, place_id, { town, ...row });
    return leadDetail(DB, place_id, NOW);
  };
  const away = await detail("w1", "Warrington", runcorn);
  assert.deepEqual(away.lead.findings, ["no_website"]);
  assert.equal(away.map_rank, null);
  const marked = await detail("w2", "Warrington", { ...runcorn, home: false });
  assert.deepEqual(marked.lead.findings, ["no_website"]);
  assert.equal(marked.map_rank, null);
  const sth = await detail("sh", "St. Helens", { avg_rank: 4, top3_pct: 40, found_pct: 90, scan_town: "Saint Helens" }, { town: "Saint Helens" });
  assert.deepEqual(sth.lead.findings, findings);
  assert.deepEqual(sth.map_rank, { scan_id: "scan-w", keyword: "landscaper", avg_rank: 6.5, top3_pct: 12, found_pct: 80, updated_at: SEED_AT });
  // Marked another town's even under the lead's own town name; an old part without scan_town counts as theirs.
  const homeFalse = await detail("w3", "Warrington", { avg_rank: 3, scan_town: "Warrington", home: false });
  assert.deepEqual([homeFalse.lead.findings, homeFalse.map_rank], [["no_website"], null]);
  const old = await detail("w4", "Warrington", { avg_rank: 3, top3_pct: 50, found_pct: 100 });
  assert.deepEqual(old.lead.findings, findings);
  assert.equal(old.map_rank.scan_id, "scan-w");
  // Its lead_map_rank row must be of its own town too (as stage 2's research queue checks): an old Runcorn row isn't
  // shown, while the audit's own-town findings stay.
  const oldRow = await detail("w5", "Warrington", { avg_rank: 3, scan_town: "Warrington" }, { town: "Runcorn" });
  assert.deepEqual([oldRow.lead.findings, oldRow.map_rank], [findings, null]);
});

test("long bodies are cut", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "lb" });
  await seedMessage(DB, { id: "long", place_id: "lb", body: "x".repeat(9000), created_at: msgAt(0) });
  await seedMessage(DB, { id: "exact", place_id: "lb", body: "z".repeat(5000), created_at: msgAt(1) });
  await seedMessage(DB, { id: "emoji", place_id: "lb", kind: "inbound", body: "😀".repeat(6000), created_at: msgAt(2) });
  const [long, exact, emoji] = (await leadDetail(DB, "lb", NOW)).messages;
  assert.ok(long.body.length <= 5000 + "…".length, `body is ${long.body.length} long`);
  assert.equal(long.body, `${"x".repeat(5000)}…`);
  assert.equal(exact.body, "z".repeat(5000)); // 5,000 exactly isn't cut
  assert.equal(emoji.body, `${"😀".repeat(5000)}…`); // 5,000 characters, never half of one
});

test("a body with a NUL character is shown whole, not cut at the NUL", async () => {
  // SQLite's text functions (substr, length) stop at a NUL, so a broken inbound part would show only what comes before
  // it, with no "…": Nik would read "Thanks!" while the rest says something else.
  const DB = fakeD1();
  await seedLead(DB, { place_id: "nul" });
  await seedMessage(DB, { id: "n1", place_id: "nul", kind: "inbound", body: "Thanks!\u0000 Actually, stop emailing me.", created_at: msgAt(0) });
  await seedMessage(DB, { id: "n2", place_id: "nul", kind: "inbound", body: `\u0000${"x".repeat(9000)}`, created_at: msgAt(1) });
  await seedMessage(DB, { id: "n3", place_id: "nul", kind: "inbound", body: `a\u0000${"é".repeat(15000)}`, created_at: msgAt(2) });
  await seedMessage(DB, { id: "n4", place_id: "nul", kind: "inbound", body: "H\u0000i\u0000 \u0000😀\u0000", created_at: msgAt(3) });
  const [short, long, wide, odd] = (await leadDetail(DB, "nul", NOW)).messages;
  assert.equal(short.body, "Thanks! Actually, stop emailing me.");
  assert.equal(long.body, `${"x".repeat(5000)}…`);
  assert.equal(wide.body, `a${"é".repeat(4999)}…`);
  assert.equal(odd.body, "Hi 😀");
});
