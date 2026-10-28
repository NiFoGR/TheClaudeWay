// The Leads API (stage 3, docs/rebuild/04-shortlist.md Task 5): GET /api/leads (listLeads), GET|PATCH /api/leads/:id
// (leadDetail, notes only) and "Not a fit" (POST /api/leads/:id/not-a-fit → markNotFit in _lib/shortlist-db.js).
// Handlers are called the way Pages calls them: {request, env: {DB}, params: {id}}.
// Run: node --test control-room/tests/leads-api.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { parseLeadFilters } from "../functions/_lib/shortlist.js";
import { listLeads, markNotFit } from "../functions/_lib/shortlist-db.js";
import { ukDate } from "../functions/_lib/ukTime.js";
import { onRequestGet as listRoute } from "../functions/api/leads.js";
import { onRequestGet as detailRoute, onRequestPatch as patchRoute } from "../functions/api/leads/[id]/index.js";
import { onRequestPost as notFitRoute } from "../functions/api/leads/[id]/not-a-fit.js";
import { drawerHtml } from "../public/js/leadview.js";
import { researchCard } from "../public/js/researchcard.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import {
  seedDemo, seedLead, seedMailbox, seedMessage, seedProspect, seedResearch,
} from "./helpers/shortlistSeed.mjs";

const ORIGIN = "https://control.example";
const NOW = new Date("2026-10-21T08:00:00Z"); // Wed 09:00 UK (BST); the seeded demos are live until 2027
const GONE = "That lead isn't in the database any more. Close this panel and refresh.";
const ONLY_NOTES = "Only notes can be changed here.";
const BAD_REASON = "Say why in a few words (3 to 200 characters).";
const EMAILED = "Already emailed. Stop the follow-ups from the conversation instead.";
const OLD_NOTES = "[Nik 2026-10-19] Owner is Sue, not Dave\nClaude: checked the contact page.";
const SENT = "2026-10-20T08:00:00Z";

const F = (s = "") => parseLeadFilters(new URLSearchParams(s));
const ids = (result) => result.rows.map((r) => r.place_id);

/** A request as Pages hands it to a handler: {request, env: {DB}, params}. `now` only when given (tests). */
function ctx(DB, path, { method = "GET", body, id, now } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const c = { request: new Request(`${ORIGIN}${path}`, init), env: { DB }, params: id === undefined ? {} : { id } };
  if (now) c.now = now;
  return c;
}
const leadPath = (id, tail = "") => `/api/leads/${encodeURIComponent(id)}${tail}`;
const patch = (DB, id, body) => patchRoute(ctx(DB, leadPath(id), { method: "PATCH", body, id }));
const notFit = (DB, id, body) => notFitRoute(ctx(DB, leadPath(id, "/not-a-fit"), { method: "POST", body, id }));

const researchOf = (DB, id) => DB.prepare("SELECT * FROM research WHERE place_id = ?").bind(id).first();
const prospectOf = (DB, id) => DB.prepare("SELECT * FROM prospects WHERE place_id = ?").bind(id).first();
const notesOf = async (DB, id) => (await DB.prepare("SELECT notes FROM leads WHERE place_id = ?").bind(id).first())?.notes;

// A lead with done research (grade A unless given), a `ready` prospect and a live demo: in Ready to email.
async function readyLead(DB, place_id, { lead = {}, research = {}, prospect = {} } = {}) {
  await seedLead(DB, { place_id, ...lead });
  await seedResearch(DB, { place_id, ...research });
  await seedProspect(DB, { place_id, ...prospect });
  await seedDemo(DB, { place_id });
}

// The research card's own text helpers (lib.js reads the page when it loads, and stage 3 rewrites it alongside).
const H = {
  esc: (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
  safeUrl: (u) => (/^https?:\/\//i.test(String(u ?? "")) ? String(u) : ""),
};
const plain = (html) => html.replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- the spec's tests (Task 5, Step 1)

test("GET /api/leads?view=all&grade=ap returns only A+ rows", async () => {
  const DB = fakeD1();
  await seedMailbox(DB);
  await readyLead(DB, "ap-ready", { lead: { quality_score: 70 }, research: { grade: "A+" } });
  await seedLead(DB, { place_id: "ap-new", quality_score: 40 });
  await seedResearch(DB, { place_id: "ap-new", grade: "A+" });
  await readyLead(DB, "a-ready");
  await seedLead(DB, { place_id: "b-lead" });
  await seedResearch(DB, { place_id: "b-lead", grade: "B" });
  await seedLead(DB, { place_id: "no-research" });
  await seedLead(DB, { place_id: "queued" });
  await seedResearch(DB, { place_id: "queued", status: "queued", grade: null });

  const res = await listRoute(ctx(DB, "/api/leads?view=all&grade=ap"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.rows.length > 0);
  assert.ok(body.rows.every((r) => r.grade === "A+"), JSON.stringify(body.rows.map((r) => r.grade)));
  assert.deepEqual(ids(body), ["ap-ready", "ap-new"]);
  // The new shape: listLeads' result as it is, not the old {leads}.
  assert.equal(body.total, 2);
  assert.equal(body.page, 1);
  assert.equal(body.pages, 1);
  assert.equal("leads" in body, false);
  for (const key of ["grade_counts", "view_counts", "facets", "capacity", "ready"]) assert.ok(key in body, key);
  assert.equal(body.grade_counts["A+"], 2);
  assert.equal(body.grade_counts.none, 2);

  // No view param: Ready to email (the default), exactly as listLeads gives it.
  const ready = await (await listRoute(ctx(DB, "/api/leads", { now: NOW }))).json();
  assert.deepEqual(ids(ready), ["ap-ready", "a-ready"]);
  assert.deepEqual(ready, JSON.parse(JSON.stringify(await listLeads(DB, F(""), NOW))));
  // A run's leads (the Lead Scraper's link) and page 2 go through the same parser.
  const page2 = await (await listRoute(ctx(DB, "/api/leads?view=all&page=2", { now: NOW }))).json();
  assert.deepEqual([page2.rows, page2.total, page2.page, page2.grade_counts], [[], 6, 2, null]);
});

test("GET /api/leads?q=<a long search>: D1 caps LIKE patterns at 50 bytes, so the search is a plain substring match", async () => {
  // a pasted long business name or URL used to be a 500 on live D1 ("LIKE or GLOB pattern too complex")
  const DB = fakeD1();
  const name = "Green Leaf Landscapes & Garden Design Services of North Warrington Ltd"; // 69 characters
  await seedLead(DB, { place_id: "long", name });
  await seedLead(DB, { place_id: "other", name: "Green Leaf" });
  await seedLead(DB, { place_id: "pct", name: "100%_a\\b Roofing", email: "o'neill@roofs.co.uk" });
  const search = async (q) => {
    const res = await listRoute(ctx(DB, `/api/leads?view=all&q=${encodeURIComponent(q)}`, { now: NOW }));
    assert.equal(res.status, 200, q);
    return res.json();
  };
  const full = await search(name);
  assert.equal(full.total, 1);
  assert.deepEqual(ids(full), ["long"]);
  assert.deepEqual(ids(await search(name.toUpperCase())), ["long"], "ASCII case doesn't matter, as with LIKE");
  assert.deepEqual(ids(await search(`https://www.greenleaflandscapesandgardendesign.co.uk/contact-us/${"x".repeat(40)}`)), []);
  // 500 × "é": cut to 100 characters (200 bytes), still a 200
  const accents = await search("é".repeat(500));
  assert.equal(accents.total, 0);
  // still literal: %, _, \ and quotes match only themselves
  assert.deepEqual(ids(await search("100%_a\\b")), ["pct"]);
  assert.deepEqual(ids(await search("100%")), ["pct"]);
  assert.deepEqual(ids(await search("1000")), []);
  assert.deepEqual(ids(await search("o'neill")), ["pct"]);
  assert.deepEqual(ids(await search("%")), ["pct"]);
  assert.deepEqual(ids(await search("_")), ["pct"]);
});

test("GET /api/leads/:id gives the panel's detail, or 404 with the exact message", async () => {
  const DB = fakeD1();
  await readyLead(DB, "ChIJgreen", {
    lead: { name: "Green Leaf", audit: { pages_html: "<html><body>raw</body></html>", findings: ["no_website"] } },
  });
  const res = await detailRoute(ctx(DB, leadPath("ChIJgreen"), { id: "ChIJgreen", now: NOW }));
  assert.equal(res.status, 200);
  const text = await res.text();
  const { detail } = JSON.parse(text);
  assert.equal(detail.lead.place_id, "ChIJgreen");
  assert.equal(detail.lead.name, "Green Leaf");
  assert.equal(detail.prospect.stage, "ready");
  assert.match(detail.demo.url, /^\/d\//);
  assert.equal(detail.offer.full.monthly, 24900);
  assert.doesNotMatch(text, /"audit"|<html/);

  // Without a test clock the handler uses the time now.
  assert.equal((await detailRoute(ctx(DB, leadPath("ChIJgreen"), { id: "ChIJgreen" }))).status, 200);

  for (const id of ["nope", ""]) {
    const missing = await detailRoute(ctx(DB, leadPath(id), { id, now: NOW }));
    assert.equal(missing.status, 404, id);
    assert.deepEqual(await missing.json(), { error: GONE });
  }
});

// The panel can open from Home (no list loaded) or long after the list: its own answer carries today's room, so
// Write first email is never enabled with no mailbox or no room left (Part A, the lead panel, item 2).
test("GET /api/leads/:id sends today's room with a ready lead (no mailbox → 0 mailboxes; cap 10, 7 follow-ups → room 3)", async () => {
  const DB = fakeD1();
  await readyLead(DB, "ChIJready");
  await seedLead(DB, { place_id: "ChIJnew" });
  const get = async (id) => (await detailRoute(ctx(DB, leadPath(id), { id, now: NOW }))).json();
  const button = (html) => (html.match(/<button[^>]*data-write-email[^>]*>/) || [""])[0];

  await seedMailbox(DB, { id: "sys", role: "system", cap_override: 50 }); // never sends cold email
  const none = await get("ChIJready");
  assert.equal(none.capacity.mailboxes, 0);
  assert.equal(none.capacity.room, 0);
  const noMailbox = drawerHtml(none.detail, { capacity: none.capacity, now: NOW });
  assert.match(button(noMailbox), /disabled title="Add a mailbox first"/);

  await seedMailbox(DB);
  for (let i = 0; i < 7; i++) await seedMessage(DB, { kind: "followup", status: "queued" });
  const three = await get("ChIJready");
  assert.equal(three.capacity.mailboxes, 1);
  assert.equal(three.capacity.room, 3);
  assert.equal(three.capacity.banner.text, "You can send 3 first emails today (10 a day, 7 follow-ups already due).");
  assert.doesNotMatch(button(drawerHtml(three.detail, { capacity: three.capacity, now: NOW })), /disabled/);

  for (let i = 0; i < 3; i++) await seedMessage(DB, { kind: "first", status: "sent" });
  const full = await get("ChIJready");
  assert.equal(full.capacity.room, 0);
  assert.match(button(drawerHtml(full.detail, { capacity: full.capacity, now: NOW })), /disabled title="No room left today"/);

  // Only a ready lead has Write first email, so only it pays for the room's reads.
  const other = await get("ChIJnew");
  assert.equal(other.detail.lead.place_id, "ChIJnew");
  assert.equal(other.capacity, null);
});

test("PATCH /api/leads/:id changes the notes and nothing else", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "p1", notes: "old" });

  const ok = await patch(DB, "p1", { notes: "Call Friday" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { notes: "Call Friday" });
  assert.equal(await notesOf(DB, "p1"), "Call Friday");
  const { detail } = await (await detailRoute(ctx(DB, leadPath("p1"), { id: "p1", now: NOW }))).json();
  assert.equal(detail.lead.notes, "Call Friday");

  const status = await patch(DB, "p1", { status: "won" });
  assert.equal(status.status, 400);
  assert.deepEqual(await status.json(), { error: ONLY_NOTES });
  // Any other field refuses the whole change, notes included.
  const both = await patch(DB, "p1", { notes: "Changed", status: "won" });
  assert.equal(both.status, 400);
  assert.deepEqual(await both.json(), { error: ONLY_NOTES });
  for (const body of [{}, [], "not json", "null", { notes: 5 }]) {
    const res = await patch(DB, "p1", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok((await res.json()).error, JSON.stringify(body));
  }
  assert.equal(await notesOf(DB, "p1"), "Call Friday");
  assert.equal((await DB.prepare("SELECT status FROM leads WHERE place_id = 'p1'").first()).status, "new");

  // Empty notes clear them; long notes are cut at 5,000 characters.
  assert.deepEqual(await (await patch(DB, "p1", { notes: "" })).json(), { notes: "" });
  assert.equal((await (await patch(DB, "p1", { notes: "x".repeat(6000) })).json()).notes.length, 5000);
  assert.equal((await notesOf(DB, "p1")).length, 5000);

  const missing = await patch(DB, "gone", { notes: "Call Friday" });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: GONE });
});

test("Not a fit hides a ready lead and writes Nik's line on top of the notes", async () => {
  const DB = fakeD1();
  await seedMailbox(DB);
  await readyLead(DB, "nf", { lead: { quality_score: 90 }, research: { notes: OLD_NOTES } });
  await readyLead(DB, "keep", { lead: { quality_score: 40 } });
  assert.deepEqual(ids(await listLeads(DB, F("view=ready"), NOW)), ["nf", "keep"]);

  const before = ukDate(new Date());
  const res = await notFit(DB, "nf", { reason: "Wrong trade" });
  const after = ukDate(new Date());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  assert.deepEqual(ids(await listLeads(DB, F("view=ready"), NOW)), ["keep"]);
  const r = await researchOf(DB, "nf");
  assert.equal(r.status, "skipped");
  const lines = r.notes.split("\n");
  assert.match(lines[0], /^\[Nik \d{4}-\d{2}-\d{2}\] Not a fit: Wrong trade$/);
  const day = lines[0].slice(5, 15);
  assert.ok(day === before || day === after, `${day} is the UK date of the call`);
  assert.deepEqual(lines.slice(1), OLD_NOTES.split("\n"));
  assert.equal(await prospectOf(DB, "nf"), null);
  // The rest of the research stays (the card shows why it was skipped; "Research is wrong" can bring it back).
  assert.equal(r.grade, "A");
  // The other lead is untouched.
  assert.equal((await researchOf(DB, "keep")).status, "done");
  assert.equal((await prospectOf(DB, "keep")).stage, "ready");

  // The line reads back through stage 2's research card (its NIK and NOT_A_FIT patterns).
  const { detail } = await (await detailRoute(ctx(DB, leadPath("nf"), { id: "nf", now: NOW }))).json();
  assert.equal(detail.prospect, null);
  assert.match(plain(researchCard({ research: detail.research, waiting: detail.research_waiting }, H)),
    /Skipped: you marked it not a fit \(Wrong trade\)\./);
  // Still in All leads, as researched.
  const all = await listLeads(DB, F("view=all"), NOW);
  assert.equal(all.rows.find((x) => x.place_id === "nf").research_status, "skipped");
  assert.equal(all.rows.find((x) => x.place_id === "nf").stage, null);
});

test("Not a fit refuses a reason that isn't 3 to 200 characters, and a lead already emailed", async () => {
  const DB = fakeD1();
  await readyLead(DB, "r1", { research: { notes: OLD_NOTES } });

  for (const body of [{ reason: "x" }, { reason: "  ab  " }, { reason: "y".repeat(201) }, { reason: "" }, {}, { reason: 42 },
    "not json", "null", []]) {
    const res = await notFit(DB, "r1", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: BAD_REASON }, JSON.stringify(body));
  }
  assert.equal((await researchOf(DB, "r1")).status, "done");
  assert.equal((await researchOf(DB, "r1")).notes, OLD_NOTES);
  assert.equal((await prospectOf(DB, "r1")).stage, "ready");

  // Exactly 3 and exactly 200 characters (after trimming) are fine.
  assert.equal((await notFit(DB, "r1", { reason: "  abc  " })).status, 200);
  assert.match((await researchOf(DB, "r1")).notes.split("\n")[0], /^\[Nik \d{4}-\d{2}-\d{2}\] Not a fit: abc$/);
  await readyLead(DB, "r2");
  assert.equal((await notFit(DB, "r2", { reason: "z".repeat(200) })).status, 200);

  // Once emailed (any stage after ready): refused, nothing changed.
  for (const stage of ["emailed", "viewed", "replied", "needs_nik", "call_booked", "won", "lost"]) {
    const id = `sent-${stage}`;
    await readyLead(DB, id, { research: { notes: OLD_NOTES }, prospect: { stage, first_sent_at: "2026-10-20T08:00:00Z" } });
    const res = await notFit(DB, id, { reason: "Wrong trade" });
    assert.equal(res.status, 409, stage);
    assert.deepEqual(await res.json(), { error: EMAILED }, stage);
    assert.equal((await researchOf(DB, id)).status, "done", stage);
    assert.equal((await researchOf(DB, id)).notes, OLD_NOTES, stage);
    assert.equal((await prospectOf(DB, id)).stage, stage, stage);
  }

  // A lead that's gone: the panel's 404 text.
  const missing = await notFit(DB, "nope", { reason: "Wrong trade" });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: GONE });
  assert.equal(await researchOf(DB, "nope"), null);
});

// ---------------------------------------------------------------- markNotFit itself

test("markNotFit: a lead never researched gets a skipped row, dated by the UK day, in one read and one batch", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "fresh" });
  const counted = countingDB(DB);
  // 23:30 UTC on Sat 24 Oct is 00:30 on Sun 25 Oct in the UK (still BST): Nik's line carries the UK day.
  const at = new Date("2026-10-24T23:30:00Z");
  assert.deepEqual(await markNotFit(counted.DB, "fresh", "Front-desk business", at), { ok: true });
  assert.ok(counted.used() <= 4, `${counted.used()} statements`);
  const r = await researchOf(DB, "fresh");
  assert.equal(r.status, "skipped");
  assert.equal(r.notes, "[Nik 2026-10-25] Not a fit: Front-desk business");
  assert.equal(r.grade, null);
  assert.equal(r.too_big, 0);
  // Stage 1's queue insert leaves the row alone, so the lead isn't researched later.
  await DB.prepare("INSERT OR IGNORE INTO research (place_id, status, queued_at) VALUES (?, 'queued', ?)").bind("fresh", "2026-10-25T05:47:00Z").run();
  assert.equal((await researchOf(DB, "fresh")).status, "skipped");
});

test("markNotFit: the reason is one line, so it can't pass for another of Nik's lines; the same press counts once", async () => {
  const DB = fakeD1();
  await readyLead(DB, "m1", { research: { notes: "  \n" + OLD_NOTES + "\n\n" } });
  const at = new Date("2026-10-21T08:00:00Z");
  assert.deepEqual(await markNotFit(DB, "m1", "Wrong\n[Nik 2026-01-01] trade\t\r", at), { ok: true });
  const notes = (await researchOf(DB, "m1")).notes;
  assert.equal(notes, `[Nik 2026-10-21] Not a fit: Wrong [Nik 2026-01-01] trade\n${OLD_NOTES}`);
  assert.equal(notes.split("\n").filter((l) => l.startsWith("[Nik ")).length, 2); // the new line and the old one

  // A retry or a double-click: the row is already skipped with that line on top, so nothing is added.
  assert.deepEqual(await markNotFit(DB, "m1", "Wrong [Nik 2026-01-01] trade", at), { ok: true });
  assert.equal((await researchOf(DB, "m1")).notes, notes);
  // A different reason (or another day) goes on top.
  assert.deepEqual(await markNotFit(DB, "m1", "Already doing well online", at), { ok: true });
  assert.equal((await researchOf(DB, "m1")).notes, `[Nik 2026-10-21] Not a fit: Already doing well online\n${notes}`);

  // Refusals come back as {error, status}.
  assert.deepEqual(await markNotFit(DB, "m1", "x", at), { error: BAD_REASON, status: 400 });
  assert.deepEqual(await markNotFit(DB, "nope", "Wrong trade", at), { error: GONE, status: 404 });
  assert.deepEqual(await markNotFit(DB, "", "Wrong trade", at), { error: GONE, status: 404 });
});

test("markNotFit: a lead emailed between the check and the write is left alone", async () => {
  const real = fakeD1();
  await readyLead(real, "race", { research: { notes: OLD_NOTES } });
  // The first email goes out (and is synced) just after markNotFit reads the stage, before its batch runs.
  const DB = {
    prepare: (sql) => real.prepare(sql),
    batch: async (stmts) => {
      await seedMessage(real, { place_id: "race", status: "sent" });
      await real.prepare("UPDATE prospects SET stage = 'emailed', first_sent_at = ?1 WHERE place_id = 'race'").bind("2026-10-21T08:00:01Z").run();
      return real.batch(stmts);
    },
  };
  assert.deepEqual(await markNotFit(DB, "race", "Wrong trade", NOW), { error: EMAILED, status: 409 });
  assert.equal((await researchOf(real, "race")).status, "done");
  assert.equal((await researchOf(real, "race")).notes, OLD_NOTES);
  assert.equal((await prospectOf(real, "race")).stage, "emailed");
});

// Stage 6 keeps the prospect `ready` while Nik's first email is queued or going out, and until its next followups step
// syncs a sent one (applyStageEvent "first_sent"). The stage alone isn't enough to know it was emailed.
test("Not a fit is refused once a first email is sending or sent, even while the stage still says ready", async () => {
  const DB = fakeD1();
  const cases = [
    ["sending", { status: "sending", sent_at: "2026-10-21T07:59:00Z" }, {}],
    ["sent", { status: "sent" }, {}],
    ["first_sent_at", null, { first_sent_at: "2026-10-21T07:00:00Z" }],
  ];
  for (const [id, message, prospect] of cases) {
    await readyLead(DB, id, { research: { notes: OLD_NOTES }, prospect });
    if (message) await seedMessage(DB, { place_id: id, ...message });
    const res = await notFit(DB, id, { reason: "Wrong trade" });
    assert.equal(res.status, 409, id);
    assert.deepEqual(await res.json(), { error: EMAILED }, id);
    assert.equal((await researchOf(DB, id)).status, "done", id);
    assert.equal((await researchOf(DB, id)).notes, OLD_NOTES, id);
    assert.equal((await prospectOf(DB, id)).stage, "ready", id);
  }
  // Sending and sent rows are left as they are.
  const { results } = await DB.prepare("SELECT place_id, status FROM messages ORDER BY place_id").all();
  assert.deepEqual(results.map((m) => `${m.place_id}:${m.status}`), ["sending:sending", "sent:sent"]);

  // A failed or cancelled first email never went: Not a fit goes ahead.
  for (const status of ["failed", "cancelled"]) {
    await readyLead(DB, `was-${status}`);
    await seedMessage(DB, { place_id: `was-${status}`, status });
    assert.equal((await notFit(DB, `was-${status}`, { reason: "Wrong trade" })).status, 200, status);
    assert.equal(await prospectOf(DB, `was-${status}`), null, status);
  }
});

test("Not a fit cancels a first email still queued for that lead, so it never goes", async () => {
  const DB = fakeD1();
  await readyLead(DB, "q1");
  await readyLead(DB, "q2");
  const mine = await seedMessage(DB, { place_id: "q1", status: "queued" });
  const theirs = await seedMessage(DB, { place_id: "q2", status: "queued" });
  const res = await notFit(DB, "q1", { reason: "Already doing well online" });
  assert.equal(res.status, 200);
  const status = async (id) => DB.prepare("SELECT status, error FROM messages WHERE id = ?").bind(id).first();
  assert.deepEqual({ ...(await status(mine.id)) }, { status: "cancelled", error: "Cancelled: you marked the lead not a fit." });
  assert.deepEqual({ ...(await status(theirs.id)) }, { status: "queued", error: null });
  assert.equal(await prospectOf(DB, "q1"), null);
  assert.equal((await prospectOf(DB, "q2")).stage, "ready");
  assert.equal((await researchOf(DB, "q1")).status, "skipped");

  // The outbox claims its row between markNotFit's read and its batch: refused, nothing changed, the email goes.
  const real = fakeD1();
  await readyLead(real, "claimed", { research: { notes: OLD_NOTES } });
  const m = await seedMessage(real, { place_id: "claimed", status: "queued" });
  const racing = {
    prepare: (sql) => real.prepare(sql),
    batch: async (stmts) => {
      await real.prepare("UPDATE messages SET status = 'sending', sent_at = ?1 WHERE id = ?2 AND status = 'queued'")
        .bind("2026-10-21T08:00:01Z", m.id).run();
      return real.batch(stmts);
    },
  };
  assert.deepEqual(await markNotFit(racing, "claimed", "Wrong trade", NOW), { error: EMAILED, status: 409 });
  assert.equal((await real.prepare("SELECT status FROM messages WHERE id = ?").bind(m.id).first()).status, "sending");
  assert.equal((await prospectOf(real, "claimed")).stage, "ready");
  assert.equal((await researchOf(real, "claimed")).status, "done");
  assert.equal((await researchOf(real, "claimed")).notes, OLD_NOTES);
});

test("Not a fit on a lead with no prospect row works and leaves other tables alone", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "np" });
  await seedResearch(DB, { place_id: "np", status: "queued", grade: null, notes: "" });
  await seedDemo(DB, { place_id: "np" });
  const res = await notFit(DB, "np", { reason: "Too big (not owner-run)" });
  assert.equal(res.status, 200);
  const r = await researchOf(DB, "np");
  assert.equal(r.status, "skipped");
  assert.match(r.notes, /^\[Nik \d{4}-\d{2}-\d{2}\] Not a fit: Too big \(not owner-run\)$/);
  // The lead and its demo stay (only the research row and a ready prospect change).
  assert.ok(await DB.prepare("SELECT 1 FROM leads WHERE place_id = 'np'").first());
  assert.ok(await DB.prepare("SELECT 1 FROM demos WHERE place_id = 'np'").first());
});
