// Nik's research routes (stage 2, Task 6): getResearch and requeueResearch in _lib/research-db.js,
// GET /api/research/:place_id (the drawer's research card) and POST /api/research/:place_id/wrong ("Research is
// wrong": Nik's note on top, back in the queue, the research Routine fired at most once every 30 minutes).
// Run: node --test control-room/tests/research-owner.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import {
  RECHECK_FIRE_MINUTES, claimKey, claimQueue, getResearch, requeueResearch,
} from "../functions/_lib/research-db.js";
import { latestNikNote, mergeNotes } from "../functions/_lib/research.js";
import { fireRoutine } from "../functions/_lib/routines.js";
import { setSecret } from "../functions/_lib/settings.js";
import { onRequestGet } from "../functions/api/research/[id].js";
import { onRequestPost } from "../functions/api/research/[id]/wrong.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const ORIGIN = "https://control.example";
const NOW = new Date("2026-10-19T09:00:00Z"); // 10:00 UK (BST)
const MIN = 60_000;
const QUEUED = "2026-10-18T06:47:00Z";
const RESEARCHED = "2026-10-18T07:10:00Z";
const CLAIMED = "2026-10-19T08:50:00Z";
const ID = "ChIJgreenleaf";
const NOTE = "Owner is Sue, not Dave";
const FIRE_TEXT = "research queued: 1 lead (Nik asked)";

const FIRED = "Queued. Claude has been asked to research it now. Check back in 15 minutes.";
const RECENT = "Queued. Claude will pick it up on its current or next run.";
const BAD_NOTE = "Say what's wrong in a few words (5 to 500 characters).";
const NOTHING = "This lead hasn't been researched yet, so there's nothing to re-check.";
// A lead Claude may not research now: refused before anything changes (the queue would only skip it again).
const EXCLUDED = "The scraper excluded this lead (Multiple branches (chain)), so Claude won't research it. Nothing was changed.";
const SUPPRESSED = "This business is on the do-not-contact list (opted out, bounced or blocked), so Claude won't research it. " +
  "Nothing was changed.";
const GONE = "This lead no longer exists, so there's nothing to re-check.";
const CHAIN = "Skipped: the scraper excluded this lead (Multiple branches (chain)).";
const SKIP_SUPPRESSED = "Skipped: this business is on the do-not-contact list (opted out, bounced or blocked).";
const FIRE_KEY = "research:recheck_fire_at";
const TEST_FIRE = "Test from the Control Room Setup page: post your heartbeat and stop.";
const FIRE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01AbC9xyz/fire";

const POINTS = { need: 5, means: 4, reach: 5, fit: 5, total: 19, capped: null,
  reasons: { need: "No website", means: "61 reviews at 4.9", reach: "Dave's own email", fit: "Owner-run landscaper" } };
const EMAILS = [{ email: "dave@greenleaf.co.uk", source_url: "https://greenleaf.co.uk/contact", where: "Contact page" }];
const OWNER = { first: "Dave", full: "Dave Smith", source_url: "https://greenleaf.co.uk/about", confident: true };

// ---------------------------------------------------------------- seeding

/** A done research row (Green Leaf, A+), or with `o` any other state. */
async function addResearch(DB, place_id, o = {}) {
  const text = (v, fallback) => (v === undefined ? fallback : v === null ? null : typeof v === "string" ? v : JSON.stringify(v));
  await DB.prepare(`INSERT INTO research (place_id, status, grade, points, grade_reason, angle, opener, owner, best_email,
      best_email_why, emails, copy, site_review, too_big, notes, searched, queued_at, researched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    place_id, o.status ?? "done", o.grade === undefined ? "A+" : o.grade, text(o.points, JSON.stringify(POINTS)),
    o.grade_reason === undefined ? "Owner-run landscaper with no website." : o.grade_reason,
    text(o.angle, JSON.stringify([{ fact: "No website", source_url: "https://greenleaf.co.uk" }])),
    o.opener === undefined ? "Line one.\nLine two." : o.opener, text(o.owner, JSON.stringify(OWNER)),
    o.best_email === undefined ? "dave@greenleaf.co.uk" : o.best_email, o.best_email_why ?? "Owner's own address",
    text(o.emails, JSON.stringify(EMAILS)), text(o.copy, null), text(o.site_review, null), o.too_big ?? 0,
    o.notes ?? "", text(o.searched, JSON.stringify(["search: a", "opened: b", "search: c"])),
    o.queued_at === undefined ? QUEUED : o.queued_at, o.researched_at === undefined ? RESEARCHED : o.researched_at,
  ).run();
}

const addQueued = (DB, place_id, o = {}) => addResearch(DB, place_id, {
  status: "queued", grade: null, points: null, grade_reason: null, angle: null, opener: null, owner: null,
  best_email: null, emails: null, searched: null, researched_at: null, ...o,
});

async function addLead(DB, place_id, o = {}) {
  await DB.prepare(`INSERT INTO leads (place_id, name, trade, search_town, town, audit, quality_score, excluded, exclude_reason,
      email, website, company_number, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    place_id, o.name ?? `Lead ${place_id}`, "landscaper", "Warrington", "Warrington", "{}", o.quality_score ?? 50,
    o.excluded ?? 0, o.exclude_reason ?? "", o.email ?? null, o.website ?? null, o.company_number ?? null, QUEUED, QUEUED,
  ).run();
}

/** The do-not-contact list: an opted-out address, a blocked company, a bounced domain. */
async function addSuppression(DB) {
  for (const [value, kind, reason] of [["dave@greenleaf.co.uk", "email", "opt_out"], ["01234567", "company", "blocked"],
    ["bounced.example", "domain", "bounce"]]) {
    await DB.prepare("INSERT INTO suppression (value, kind, reason, created_at) VALUES (?, ?, ?, ?)").bind(value, kind, reason, QUEUED).run();
  }
}

const claim = (DB, place_id, at = CLAIMED) =>
  DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(claimKey(place_id), at).run();
const logFire = (DB, at, { routine = "research", reason = "research queued: 4 leads", error = null } = {}) =>
  DB.prepare("INSERT INTO routine_fires (id, routine, reason, http_status, error, session_url, at) VALUES (?, ?, ?, ?, ?, NULL, ?)")
    .bind(crypto.randomUUID(), routine, reason, error ? 400 : 200, error, at).run();

const rowOf = (DB, place_id = ID) => DB.prepare("SELECT * FROM research WHERE place_id = ?").bind(place_id).first();
const claimOf = (DB, place_id = ID) =>
  DB.prepare("SELECT value FROM settings WHERE key = ?").bind(claimKey(place_id)).first("value");
const fireKeyOf = (DB) => DB.prepare("SELECT value FROM settings WHERE key = ?").bind(FIRE_KEY).first("value");
const fires = async (DB) => (await DB.prepare("SELECT routine, reason, error, at FROM routine_fires ORDER BY at, rowid").all()).results;

/** A stand-in for fireRoutine that records its arguments and answers `result`. */
function stubFire(result = { ok: true, status: 200 }) {
  const calls = [];
  const fire = async (...args) => {
    calls.push(args);
    return typeof result === "function" ? result(...args) : result;
  };
  return { calls, fire };
}

/** The Green Leaf lead and its done row (claimed, with Claude's notes) and 3 more leads waiting. */
async function seed({ research = {}, claimed = true } = {}) {
  const DB = fakeD1();
  if (research) {
    await addLead(DB, ID, { name: "Green Leaf Landscapes" });
    await addResearch(DB, ID, research);
  }
  if (claimed) await claim(DB, ID);
  for (const id of ["q1", "q2", "q3"]) await addQueued(DB, id);
  return DB;
}

async function getRoute(DB, id = ID) {
  const res = await onRequestGet({ request: new Request(`${ORIGIN}/api/research/${encodeURIComponent(id)}`), env: { DB }, params: { id } });
  return { status: res.status, body: await res.json() };
}

async function wrongRoute(DB, body, { id = ID, now = NOW } = {}) {
  const request = new Request(`${ORIGIN}/api/research/${encodeURIComponent(id)}/wrong`, {
    method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await onRequestPost({ request, env: { DB }, params: { id }, now });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------- the spec's tests (Task 6, Step 1)

test("GET returns parsed research and waiting count", async () => {
  const DB = await seed();
  const got = await getResearch(DB, ID);
  assert.equal(typeof got.research.points.need, "number");
  assert.equal(got.research.points.need, 5);
  assert.ok(Array.isArray(got.research.emails));
  assert.deepEqual(got.research.emails, EMAILS);
  assert.deepEqual(got.research.owner, OWNER);
  assert.equal(got.research.too_big, false);
  assert.equal(got.research.status, "done");
  assert.equal(got.research.place_id, ID);
  assert.equal(got.waiting, 3);
  assert.deepEqual(await getResearch(DB, "ChIJnobody"), { research: null, waiting: 3 });

  // the route returns the same
  const route = await getRoute(DB);
  assert.equal(route.status, 200);
  assert.deepEqual(route.body, JSON.parse(JSON.stringify(got)));
  assert.deepEqual((await getRoute(DB, "ChIJnobody")).body, { research: null, waiting: 3 });
});

test("wrong re-queues with Nik's note on top", async () => {
  const DB = await seed({ research: { notes: "Claude: checked the About page" } });
  const { calls, fire } = stubFire({ ok: true });
  const result = await requeueResearch(DB, ID, NOTE, new Date("2026-10-19T09:00:00Z"), { fire });
  assert.deepEqual(result, { fired: true, message: FIRED });

  assert.equal(calls.length, 1, "fired once");
  assert.equal(calls[0].length, 3, "with exactly (DB, name, text)");
  assert.equal(calls[0][0], DB);
  assert.equal(calls[0][1], "research");
  assert.equal(calls[0][2], FIRE_TEXT);

  const row = await rowOf(DB);
  assert.equal(row.status, "queued");
  assert.equal(row.queued_at, "2026-10-19T09:00:00Z");
  assert.ok(row.notes.startsWith("[Nik 2026-10-19] Owner is Sue, not Dave"), row.notes);
  assert.equal(row.notes, "[Nik 2026-10-19] Owner is Sue, not Dave\nClaude: checked the About page");
  // the old findings stay visible until Claude overwrites them
  assert.equal(row.grade, "A+");
  assert.deepEqual(JSON.parse(row.emails), EMAILS);
  assert.deepEqual(JSON.parse(row.points), POINTS);
  assert.equal(row.best_email, "dave@greenleaf.co.uk");
  assert.equal(row.researched_at, RESEARCHED, "still a re-check (researched before)");
  assert.equal(await claimOf(DB), null, "the claim is deleted");
});

test("one fire per 30 minutes", async () => {
  assert.equal(RECHECK_FIRE_MINUTES, 30);

  const DB = await seed();
  await logFire(DB, "2026-10-19T08:45:00Z");
  const { calls, fire } = stubFire({ ok: true });
  const result = await requeueResearch(DB, ID, NOTE, NOW, { fire });
  assert.deepEqual(result, { fired: false, message: RECENT });
  assert.equal(calls.length, 0, "no call made");
  const row = await rowOf(DB);
  assert.equal(row.status, "queued", "still re-queued");
  assert.equal(row.queued_at, "2026-10-19T09:00:00Z");
  assert.ok(row.notes.startsWith(`[Nik 2026-10-19] ${NOTE}`));
  assert.equal(await claimOf(DB), null);

  // a fire 31 minutes earlier doesn't hold it back
  const older = await seed();
  await logFire(older, "2026-10-19T08:29:00Z");
  const second = stubFire({ ok: true });
  assert.deepEqual(await requeueResearch(older, ID, NOTE, NOW, { fire: second.fire }), { fired: true, message: FIRED });
  assert.equal(second.calls.length, 1, "the stub is called");
});

test("fire failed", async () => {
  const DB = await seed();
  const { calls, fire } = stubFire({ ok: false, error: "HTTP 400" });
  const result = await requeueResearch(DB, ID, NOTE, NOW, { fire });
  assert.equal(result.fired, false);
  assert.equal(result.message, "Queued, but Claude couldn't be started (HTTP 400). It will be researched at 06:47 tomorrow.");
  assert.equal(calls.length, 1);
  assert.equal((await rowOf(DB)).status, "queued", "still queued");
});

test("route returns the message", async () => {
  const DB = await seed();
  const { status, body } = await wrongRoute(DB, { note: NOTE });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(Object.keys(body).sort(), ["fired", "message", "ok"]);
  assert.equal(body.ok, true);
  assert.equal(typeof body.fired, "boolean");
  assert.equal(typeof body.message, "string");
  assert.ok(body.message.startsWith("Queued"), body.message);
  // No Routine connected here: the real fireRoutine fails without calling Claude, and says so in the toast.
  assert.equal(body.fired, false);
  assert.equal(body.message, "Queued, but Claude couldn't be started (The Research Routine isn't connected: paste its URL " +
    "and token on Setup → Claude). It will be researched at 06:47 tomorrow.");
  const row = await rowOf(DB);
  assert.equal(row.status, "queued");
  assert.ok(row.notes.startsWith(`[Nik 2026-10-19] ${NOTE}`));
  assert.deepEqual((await fires(DB)).map((f) => [f.routine, f.reason]), [["research", FIRE_TEXT]], "the attempt is logged");
});

test("note length", async () => {
  const DB = await seed();
  const before = await rowOf(DB);
  for (const note of ["bad", "x".repeat(501)]) {
    const { status, body } = await wrongRoute(DB, { note });
    assert.equal(status, 400, note.slice(0, 10));
    assert.equal(body.error, BAD_NOTE);
  }
  // no note, not text, padding only, not JSON at all: the same 400
  for (const body of [{}, { note: 42 }, { note: null }, { note: "   \n  \t " }, { note: "  ab  " }, "not json", "[]"]) {
    const r = await wrongRoute(DB, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, BAD_NOTE);
  }
  assert.deepEqual(await rowOf(DB), before, "a refused note changes nothing");
  assert.equal(await claimOf(DB), CLAIMED);
  assert.deepEqual(await fires(DB), []);

  // the limits themselves are fine: 5 and 500 characters (padding not counted)
  assert.equal((await wrongRoute(DB, { note: "  wrong " })).status, 200);
  assert.equal((await wrongRoute(DB, { note: "y".repeat(500) })).status, 200);
});

test("nothing to re-check", async () => {
  const DB = await seed({ research: null, claimed: false });
  const { status, body } = await wrongRoute(DB, { note: NOTE });
  assert.equal(status, 404);
  assert.equal(body.error, NOTHING);
  assert.equal(await rowOf(DB), null, "no row is made");
  assert.deepEqual(await fires(DB), [], "Claude isn't woken for nothing");

  const { calls, fire } = stubFire();
  assert.equal(await requeueResearch(DB, ID, NOTE, NOW, { fire }), null);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- more

test("Nik's note keeps its own lines and every older note", async () => {
  // A note typed over several lines becomes one line, so the whole of it stays Nik's (mergeNotes keeps lines that
  // start "[Nik ") and the card and the queue read all of it.
  const DB = await seed({ research: { notes: "[Nik 2026-10-12] Not Dave's firm\nClaude's old note\nOwner's first name…" } });
  const { fire } = stubFire();
  await requeueResearch(DB, ID, "  Owner is Sue,\r\nnot Dave.\n\n  Her email is on Facebook  ", NOW, { fire });
  const { notes } = await rowOf(DB);
  assert.equal(notes, "[Nik 2026-10-19] Owner is Sue, not Dave. Her email is on Facebook\n[Nik 2026-10-12] Not Dave's firm\n" +
    "Claude's old note\nOwner's first name…");
  assert.equal(latestNikNote(notes), "Owner is Sue, not Dave. Her email is on Facebook");
  // Claude's next post keeps both of Nik's lines on top and replaces the rest
  assert.equal(mergeNotes(notes, "Checked: Sue Jones on the About page"),
    "[Nik 2026-10-19] Owner is Sue, not Dave. Her email is on Facebook\n[Nik 2026-10-12] Not Dave's firm\n" +
    "Checked: Sue Jones on the About page");

  // a second note the same day goes on top and is the one Claude reads
  await requeueResearch(DB, ID, "Also check Checkatrade", new Date(NOW.getTime() + 5 * MIN), { fire });
  const again = (await rowOf(DB)).notes;
  assert.ok(again.startsWith("[Nik 2026-10-19] Also check Checkatrade\n[Nik 2026-10-19] Owner is Sue"), again);
  assert.equal(latestNikNote(again), "Also check Checkatrade");

  // empty notes: just Nik's line, no blank line after it
  const empty = await seed({ research: { notes: "" } });
  await requeueResearch(empty, ID, NOTE, NOW, { fire });
  assert.equal((await rowOf(empty)).notes, `[Nik 2026-10-19] ${NOTE}`);
  const blank = await seed({ research: { notes: " \n\n" } });
  await requeueResearch(blank, ID, NOTE, NOW, { fire });
  assert.equal((await rowOf(blank)).notes, `[Nik 2026-10-19] ${NOTE}`);
});

test("the note's date is the UK day", async () => {
  // 23:30 UTC on 19 Oct is 00:30 on 20 Oct in the UK (BST)
  const DB = await seed();
  const { fire } = stubFire();
  await requeueResearch(DB, ID, NOTE, new Date("2026-10-19T23:30:00Z"), { fire });
  const row = await rowOf(DB);
  assert.ok(row.notes.startsWith(`[Nik 2026-10-20] ${NOTE}`), row.notes);
  assert.equal(row.queued_at, "2026-10-19T23:30:00Z", "stored in UTC");
  // after the clocks go back (GMT), UTC midnight is UK midnight
  const winter = await seed();
  await requeueResearch(winter, ID, NOTE, new Date("2026-11-02T23:59:59.900Z"), { fire });
  const w = await rowOf(winter);
  assert.ok(w.notes.startsWith(`[Nik 2026-11-02] ${NOTE}`), w.notes);
  assert.equal(w.queued_at, "2026-11-02T23:59:59Z", "no milliseconds");
});

test("a failed fire before 06:47 UK says today", async () => {
  // 05:00 UTC = 06:00 BST: the morning run hasn't happened yet
  const DB = await seed();
  const { fire } = stubFire({ ok: false, error: "HTTP 400" });
  assert.equal((await requeueResearch(DB, ID, NOTE, new Date("2026-10-20T05:00:00Z"), { fire })).message,
    "Queued, but Claude couldn't be started (HTTP 400). It will be researched at 06:47 today.");
  // 06:47 UK itself: that run has started, so the next one is tomorrow's
  const later = await seed();
  assert.equal((await requeueResearch(later, ID, NOTE, new Date("2026-10-20T05:47:00Z"), { fire })).message,
    "Queued, but Claude couldn't be started (HTTP 400). It will be researched at 06:47 tomorrow.");
  // GMT (November): 06:30 UTC = 06:30 UK, still today
  const gmt = await seed();
  assert.match((await requeueResearch(gmt, ID, NOTE, new Date("2026-11-03T06:30:00Z"), { fire })).message, /06:47 today\.$/);
});

test("the error in a failed fire's message", async () => {
  // fireRoutine's own sentences end in a full stop: the message doesn't double it inside the brackets
  const DB = await seed();
  const { fire } = stubFire({ ok: false, status: 401,
    error: "Claude rejected the token: generate a new one in the Routine (Edit → API trigger) and paste it on Setup." });
  assert.equal((await requeueResearch(DB, ID, NOTE, NOW, { fire })).message,
    "Queued, but Claude couldn't be started (Claude rejected the token: generate a new one in the Routine (Edit → API " +
    "trigger) and paste it on Setup). It will be researched at 06:47 tomorrow.");
  // no error text: the status, or plain words
  const bare = await seed();
  assert.match((await requeueResearch(bare, ID, NOTE, NOW, { fire: stubFire({ ok: false, status: 503 }).fire })).message,
    /^Queued, but Claude couldn't be started \(HTTP 503\)\./);
  const none = await seed();
  assert.match((await requeueResearch(none, ID, NOTE, NOW, { fire: stubFire({ ok: false, status: null }).fire })).message,
    /^Queued, but Claude couldn't be started \(no answer from Claude\)\./);
  // a fire that throws (a bug, or D1 failing while logging it): the lead is queued all the same, and the toast says so
  const thrown = await seed();
  const result = await requeueResearch(thrown, ID, NOTE, NOW, { fire: async () => { throw new Error("D1_ERROR: busy"); } });
  assert.deepEqual(result, { fired: false,
    message: "Queued, but Claude couldn't be started (D1_ERROR: busy). It will be researched at 06:47 tomorrow." });
  assert.equal((await rowOf(thrown)).status, "queued");
});

test("which fires hold it back", async () => {
  const cases = [
    // [what was logged, fired now?]
    [{ at: "2026-10-19T08:30:01Z" }, false], // 29 min 59 s ago
    [{ at: "2026-10-19T08:30:00Z" }, true], // exactly 30 min ago: no longer recent
    [{ at: "2026-10-19T08:59:59Z", reason: "research queued: 1 lead (Nik asked)" }, false], // Nik's earlier re-check
    [{ at: "2026-10-19T08:50:00Z", error: "The Routine is paused or its API trigger is off." }, false], // a failed attempt
    [{ at: "2026-10-19T08:50:00Z", routine: "reply" }, true], // another Routine
    [{ at: "2026-10-19T08:50:00Z", reason: TEST_FIRE }, true], // Setup's Test fire only checks in, it never researches
  ];
  for (const [logged, firesNow] of cases) {
    const DB = await seed();
    await logFire(DB, logged.at, logged);
    const { calls, fire } = stubFire();
    const result = await requeueResearch(DB, ID, NOTE, NOW, { fire });
    assert.equal(calls.length, firesNow ? 1 : 0, JSON.stringify(logged));
    assert.deepEqual(result, firesNow ? { fired: true, message: FIRED } : { fired: false, message: RECENT }, JSON.stringify(logged));
  }
});

test("two leads within 30 minutes: one Routine fire (the real fireRoutine)", async () => {
  const DB = await seed();
  await addLead(DB, "ChIJsecond");
  await addResearch(DB, "ChIJsecond", { grade: "B" });
  await setSecret(DB, "routine:research:url", FIRE_URL);
  await setSecret(DB, "routine:research:token", "sk-ant-oat01-x");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ claude_code_session_id: "session_abc" }), { status: 200 });
  };
  const fire = (D, name, text) => fireRoutine(D, name, text, { fetchImpl, now: NOW });

  assert.deepEqual(await requeueResearch(DB, ID, NOTE, NOW, { fire }), { fired: true, message: FIRED });
  assert.deepEqual(calls.map((c) => c.body), [{ text: FIRE_TEXT }]);
  assert.deepEqual(await fires(DB), [{ routine: "research", reason: FIRE_TEXT, error: null, at: "2026-10-19T09:00:00Z" }]);

  // the second lead, 20 minutes later: queued, no second fire
  const later = new Date(NOW.getTime() + 20 * MIN);
  assert.deepEqual(await requeueResearch(DB, "ChIJsecond", "Wrong trade, they do fencing", later, { fire }),
    { fired: false, message: RECENT });
  assert.equal(calls.length, 1, "Claude was asked once");
  assert.equal((await rowOf(DB, "ChIJsecond")).status, "queued");
  assert.equal((await getResearch(DB, ID)).waiting, 5);
});

test("the re-checked lead goes to the front of the queue, with Nik's note", async () => {
  const DB = fakeD1();
  await addLead(DB, ID, { name: "Green Leaf Landscapes", quality_score: 40 });
  await addResearch(DB, ID);
  for (const [id, score] of [["q1", 90], ["q2", 80]]) {
    await addLead(DB, id, { quality_score: score });
    await addQueued(DB, id);
  }
  await claim(DB, ID, "2026-10-19T08:00:00Z"); // a claim from an earlier run would otherwise hold it for 3 hours
  await requeueResearch(DB, ID, NOTE, NOW, { fire: stubFire().fire });

  const { leads } = await claimQueue(DB, { limit: 8, now: new Date(NOW.getTime() + MIN), origin: ORIGIN });
  assert.deepEqual(leads.map((l) => l.place_id), [ID, "q1", "q2"]);
  assert.equal(leads[0].nik_note, NOTE);
  assert.equal(leads[0].previous.grade, "A+", "Claude sees the research Nik says is wrong");
  assert.deepEqual(leads[0].previous.emails, EMAILS);
});

test("a lead Nik puts back that Claude never researched (or the purge blanked) also goes first, with his note", async () => {
  // The card says "Being re-checked after your note" and the toast says Claude was asked now, so the queue treats it
  // as a re-check too: first, nik_note = his note, previous null (there's nothing earlier to show).
  const purged = "Skipped: details deleted 12 months after last contact.";
  for (const research of [
    { status: "skipped", grade: null, points: null, grade_reason: null, angle: null, opener: null, owner: null, best_email: null,
      best_email_why: null, emails: null, searched: null, notes: purged, queued_at: null, researched_at: null },
    { status: "skipped", grade: null, points: null, grade_reason: null, angle: null, opener: null, owner: null, best_email: null,
      best_email_why: null, emails: null, searched: null, notes: "Skipped: the scraper excluded this lead (big firm).",
      researched_at: null },
  ]) {
    const DB = fakeD1();
    await addLead(DB, ID, { name: "Green Leaf Landscapes", quality_score: 20 });
    await addResearch(DB, ID, research);
    for (const [id, score] of [["q1", 90], ["q2", 80]]) {
      await addLead(DB, id, { quality_score: score });
      await addQueued(DB, id);
    }
    await requeueResearch(DB, ID, NOTE, NOW, { fire: stubFire().fire });

    const { leads } = await claimQueue(DB, { limit: 8, now: new Date(NOW.getTime() + MIN), origin: ORIGIN });
    assert.deepEqual(leads.map((l) => l.place_id), [ID, "q1", "q2"], research.notes);
    assert.equal(leads[0].nik_note, NOTE);
    assert.equal(leads[0].previous, null);
    for (const l of leads.slice(1)) assert.equal(l.nik_note, null, `${l.place_id}: not a re-check`);
  }
});

test("any row can be re-checked: queued, skipped or blanked by the purge", async () => {
  // Nik's "Not a fit" (stage 3) or the 12-month purge: "Research is wrong" is how Nik brings the lead back.
  const purged = "Skipped: details deleted 12 months after last contact.";
  for (const research of [
    { status: "skipped", notes: "[Nik 2026-10-12] Not a fit: Wrong trade" },
    { status: "skipped", grade: null, points: null, grade_reason: null, angle: null, opener: null, owner: null, best_email: null,
      best_email_why: null, emails: null, searched: null, notes: purged, queued_at: null, researched_at: null },
    { status: "queued", notes: "[Nik 2026-10-18] Check Facebook" },
  ]) {
    const DB = await seed({ research });
    const result = await requeueResearch(DB, ID, NOTE, NOW, { fire: stubFire().fire });
    assert.deepEqual(result, { fired: true, message: FIRED }, research.status);
    const row = await rowOf(DB);
    assert.equal(row.status, "queued");
    assert.equal(row.queued_at, "2026-10-19T09:00:00Z");
    assert.equal(row.notes, `[Nik 2026-10-19] ${NOTE}\n${research.notes}`);
  }
});

test("only that lead changes; D1 statements", async () => {
  const DB = await seed();
  await claim(DB, "q1");
  const before = (await DB.prepare("SELECT * FROM research WHERE place_id != ? ORDER BY place_id").bind(ID).all()).results;
  const counted = countingDB(DB);
  await requeueResearch(counted.DB, ID, NOTE, NOW, { fire: stubFire().fire });
  assert.equal(counted.used(), 5, "the lead's state, the do-not-contact list, then one batch: re-queue, claim delete, the fire check");
  assert.deepEqual((await DB.prepare("SELECT * FROM research WHERE place_id != ? ORDER BY place_id").bind(ID).all()).results, before);
  assert.equal(await claimOf(DB, "q1"), CLAIMED, "other leads keep their claims");

  const read = countingDB(DB);
  await getResearch(read.DB, ID);
  assert.equal(read.used(), 2, "one batch: the row and the waiting count");

  // a refusal stops after the read: the excluded or deleted lead's state (1), a suppressed lead's list too (2)
  for (const [lead, used] of [[{ excluded: 1, exclude_reason: "Multiple branches (chain)" }, 1], [null, 1], [{ email: "dave@greenleaf.co.uk" }, 2]]) {
    const one = fakeD1();
    await addSuppression(one);
    if (lead) await addLead(one, ID, lead);
    await addResearch(one, ID);
    const c = countingDB(one);
    assert.ok((await requeueResearch(c.DB, ID, NOTE, NOW, { fire: stubFire().fire })).refused, JSON.stringify(lead));
    assert.equal(c.used(), used, JSON.stringify(lead));
  }
  // nothing to re-check: the read alone
  const none = countingDB(await seed({ research: null, claimed: false }));
  assert.equal(await requeueResearch(none.DB, ID, NOTE, NOW, { fire: stubFire().fire }), null);
  assert.equal(none.used(), 1);
});

test("a lead Claude may not research now (excluded, on the do-not-contact list, deleted): refused, nothing changes", async () => {
  // The queue would skip it again straight away (and add the same "Skipped:" line again), so the toast would say
  // something untrue and a Routine session would start for nothing. Refused before anything is written.
  const cases = [
    // [what, the lead now (null = deleted by a re-scrape), the research row, kind, status, error]
    ["excluded, skipped row", { excluded: 1, exclude_reason: "Multiple branches (chain)" }, { status: "skipped", notes: CHAIN },
      "excluded", 409, EXCLUDED],
    ["excluded, done row", { excluded: 1, exclude_reason: "  Multiple branches (chain).\n" }, { notes: "Claude: checked the About page" },
      "excluded", 409, EXCLUDED],
    ["excluded, queued row", { excluded: 1, exclude_reason: "Multiple branches (chain)" }, { status: "queued", notes: "[Nik 2026-10-18] Check Facebook" },
      "excluded", 409, EXCLUDED],
    ["excluded, no reason saved", { excluded: 1, exclude_reason: "" }, { status: "skipped", notes: "Skipped: the scraper excluded this lead." },
      "excluded", 409, "The scraper excluded this lead, so Claude won't research it. Nothing was changed."],
    ["opted out, skipped row", { email: "Dave@GreenLeaf.co.uk" }, { status: "skipped", notes: SKIP_SUPPRESSED }, "suppressed", 409, SUPPRESSED],
    ["opted out, done row", { email: "dave@greenleaf.co.uk" }, {}, "suppressed", 409, SUPPRESSED],
    ["blocked company, done row", { company_number: " 01234567 " }, {}, "suppressed", 409, SUPPRESSED],
    ["bounced domain, skipped row", { website: "https://www.bounced.example/contact" }, { status: "skipped", notes: SKIP_SUPPRESSED },
      "suppressed", 409, SUPPRESSED],
    ["deleted, skipped row", null, { status: "skipped", notes: "Skipped: the lead no longer exists." }, "missing", 404, GONE],
    ["deleted, done row", null, {}, "missing", 404, GONE],
  ];
  for (const [what, lead, research, kind, status, error] of cases) {
    const DB = fakeD1();
    await addSuppression(DB);
    if (lead) await addLead(DB, ID, lead);
    await addResearch(DB, ID, research);
    await claim(DB, ID);
    await addLead(DB, "ChIJgood");
    await addResearch(DB, "ChIJgood", { grade: "B" });
    const before = await rowOf(DB);

    // the route: the refusal under the box, in plain English
    const route = await wrongRoute(DB, { note: NOTE });
    assert.equal(route.status, status, what);
    assert.deepEqual(route.body, { error }, what);
    // the function: a refusal, and no fire
    const { calls, fire } = stubFire();
    assert.deepEqual(await requeueResearch(DB, ID, NOTE, NOW, { fire }), { refused: kind, error }, what);
    assert.equal(calls.length, 0, `${what}: Claude isn't woken`);

    assert.deepEqual(await rowOf(DB), before, `${what}: the row is byte-identical`);
    assert.equal(await claimOf(DB), CLAIMED, `${what}: the claim is left alone`);
    assert.deepEqual(await fires(DB), [], `${what}: nothing logged`);
    assert.equal(await fireKeyOf(DB), null, `${what}: the 30-minute fire guard isn't used up`);

    // the next run neither hands it out nor adds a note line
    const queue = await claimQueue(DB, { now: new Date(NOW.getTime() + 4 * 60 * MIN), origin: ORIGIN });
    assert.ok(!queue.leads.some((l) => l.place_id === ID), what);
    if (research.status !== "queued") assert.deepEqual(await rowOf(DB), before, `${what}: untouched by the queue`);
    // and a press on a lead that can be researched still fires straight away
    assert.deepEqual(await requeueResearch(DB, "ChIJgood", NOTE, NOW, { fire }), { fired: true, message: FIRED }, what);
    assert.equal(calls.length, 1, what);
  }
});

test("a stale skip whose lead the scraper keeps again is re-queued, and a lead not on the list is fine", async () => {
  // The scraper excluded or lost the lead once (the row says so), but keeps it again now: Research is wrong brings it
  // back, ahead of new leads. The do-not-contact list only refuses its own matches.
  for (const [lead, notes] of [
    [{}, CHAIN],
    [{}, "Skipped: the lead no longer exists."],
    [{ email: "jo@greenleaf.co.uk", website: "https://greenleaf.co.uk", company_number: "07654321" }, SKIP_SUPPRESSED],
  ]) {
    const DB = fakeD1();
    await addSuppression(DB);
    await addLead(DB, ID, { quality_score: 20, ...lead });
    await addResearch(DB, ID, { status: "skipped", notes });
    await addLead(DB, "q1", { quality_score: 90 });
    await addQueued(DB, "q1");
    const { calls, fire } = stubFire();
    assert.deepEqual(await requeueResearch(DB, ID, NOTE, NOW, { fire }), { fired: true, message: FIRED }, notes);
    assert.equal(calls.length, 1);
    const row = await rowOf(DB);
    assert.equal(row.status, "queued");
    assert.equal(row.notes, `[Nik 2026-10-19] ${NOTE}\n${notes}`);
    const { leads } = await claimQueue(DB, { now: new Date(NOW.getTime() + MIN), origin: ORIGIN });
    assert.deepEqual(leads.map((l) => l.place_id), [ID, "q1"], notes);
    assert.equal(leads[0].nik_note, NOTE);
  }
});

test("the queue doesn't add a Skipped: line the notes already end with", async () => {
  // Nik brings back a lead the scraper had excluded; the scraper excludes it again before the run: one line, not two.
  const DB = fakeD1();
  await addLead(DB, ID);
  await addResearch(DB, ID, { status: "skipped", notes: CHAIN });
  assert.deepEqual(await requeueResearch(DB, ID, NOTE, NOW, { fire: stubFire().fire }), { fired: true, message: FIRED });
  await DB.prepare("UPDATE leads SET excluded = 1, exclude_reason = ? WHERE place_id = ?").bind("Multiple branches (chain)", ID).run();
  assert.deepEqual((await claimQueue(DB, { now: new Date(NOW.getTime() + MIN), origin: ORIGIN })).leads, []);
  const row = await rowOf(DB);
  assert.equal(row.status, "skipped");
  assert.equal(row.notes, `[Nik 2026-10-19] ${NOTE}\n${CHAIN}`, "one Skipped: line");

  // only an exact last line counts: another reason after it, the same words inside a longer line or Nik's line, or
  // an older copy further up all mean the newest reason is still added at the bottom
  const gone = "Skipped: the lead no longer exists.";
  for (const [notes, want] of [
    [CHAIN, CHAIN],
    [`Claude: old note\n${CHAIN}`, `Claude: old note\n${CHAIN}`],
    [`${CHAIN}\n \r\n\t`, `${CHAIN}\n \r\n\t`], // trailing blank lines: it's still the last line
    [`[Nik 2026-10-18] Look again\r\n${CHAIN}`, `[Nik 2026-10-18] Look again\r\n${CHAIN}`],
    [`${CHAIN}\n${gone}`, `${CHAIN}\n${gone}\n${CHAIN}`],
    [`${CHAIN} Extra`, `${CHAIN} Extra\n${CHAIN}`],
    [`[Nik 2026-10-18] ${CHAIN}`, `[Nik 2026-10-18] ${CHAIN}\n${CHAIN}`],
    [CHAIN.slice(1), `${CHAIN.slice(1)}\n${CHAIN}`],
    [CHAIN.toLowerCase(), `${CHAIN.toLowerCase()}\n${CHAIN}`],
    ["", CHAIN],
    [" \n", CHAIN],
  ]) {
    const one = fakeD1();
    await addLead(one, ID, { excluded: 1, exclude_reason: "Multiple branches (chain)" });
    await addQueued(one, ID, { notes });
    await claimQueue(one, { now: NOW, origin: ORIGIN });
    const got = await rowOf(one);
    assert.equal(got.status, "skipped", JSON.stringify(notes));
    assert.equal(got.notes, want, JSON.stringify(notes));
  }
  // a reason with LIKE's wildcards in it is compared as text
  const wild = fakeD1();
  await addLead(wild, ID, { excluded: 1, exclude_reason: "100% franchise_owned" });
  await addQueued(wild, ID, { notes: "Claude: old note\nSkipped: the scraper excluded this lead (1000 franchise owned)." });
  await claimQueue(wild, { now: NOW, origin: ORIGIN });
  assert.equal((await rowOf(wild)).notes, "Claude: old note\nSkipped: the scraper excluded this lead (1000 franchise owned).\n" +
    "Skipped: the scraper excluded this lead (100% franchise_owned).");
});

test("two presses at the same moment: one fire (fireRoutine logs only once Claude answers)", async () => {
  // fireRoutine writes its routine_fires row after the HTTP call, up to 15 s later. A double-click, or a second
  // drawer, inside that window must not start a second Routine session.
  const DB = await seed();
  await addLead(DB, "ChIJsecond");
  await addResearch(DB, "ChIJsecond", { grade: "B" });
  let release;
  const answered = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const fire = async (D, name, text) => {
    calls.push(text);
    await answered; // Claude hasn't answered yet
    await logFire(D, "2026-10-19T09:00:00Z", { reason: text });
    return { ok: true, status: 200 };
  };
  const first = requeueResearch(DB, ID, NOTE, NOW, { fire });
  const second = requeueResearch(DB, "ChIJsecond", "Wrong trade, they do fencing", new Date(NOW.getTime() + 2000), { fire });
  setTimeout(release, 30); // Claude answers after both presses have decided
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, { fired: true, message: FIRED });
  assert.deepEqual(secondResult, { fired: false, message: RECENT });
  assert.equal(calls.length, 1, "Claude was asked once");
  assert.equal((await rowOf(DB, "ChIJsecond")).status, "queued", "the second lead is queued all the same");

  // 30 minutes after that attempt, a press fires again
  const later = stubFire();
  assert.deepEqual(await requeueResearch(DB, "ChIJsecond", "Still the wrong trade", new Date(NOW.getTime() + 30 * MIN), { fire: later.fire }),
    { fired: true, message: FIRED });
  assert.equal(later.calls.length, 1);
});

test("pressed again with the same note while still queued (a retry): one line, no second fire", async () => {
  // The card says "Couldn't save. Check your connection and press Re-check again." when the answer is lost, though
  // the first press may have landed. Stage 11 counts [Nik …] lines as presses.
  const DB = await seed({ research: { notes: "Claude: checked the About page" } });
  const { calls, fire } = stubFire();
  assert.deepEqual(await requeueResearch(DB, ID, NOTE, NOW, { fire }), { fired: true, message: FIRED });
  const once = await rowOf(DB);
  assert.deepEqual(await requeueResearch(DB, ID, ` ${NOTE}\n`, new Date(NOW.getTime() + 40_000), { fire }),
    { fired: false, message: RECENT });
  assert.equal(calls.length, 1);
  const twice = await rowOf(DB);
  assert.equal(twice.notes, `[Nik 2026-10-19] ${NOTE}\nClaude: checked the About page`, "no second line");
  assert.equal(twice.queued_at, once.queued_at, "nothing changed");

  // a different note, or the same note once Claude has posted (done), is a new press: a new line on top
  await requeueResearch(DB, ID, "Her email is on Facebook", new Date(NOW.getTime() + 60_000), { fire });
  assert.ok((await rowOf(DB)).notes.startsWith(`[Nik 2026-10-19] Her email is on Facebook\n[Nik 2026-10-19] ${NOTE}\n`));
  const done = await seed({ research: { notes: `[Nik 2026-10-19] ${NOTE}\nChecked: still Dave` } });
  await requeueResearch(done, ID, NOTE, NOW, { fire });
  assert.equal((await rowOf(done)).notes, `[Nik 2026-10-19] ${NOTE}\n[Nik 2026-10-19] ${NOTE}\nChecked: still Dave`);
  // a note that only starts like the top line is a different note
  const prefix = await seed({ research: { status: "queued", notes: `[Nik 2026-10-19] ${NOTE} and Jo` } });
  await requeueResearch(prefix, ID, NOTE, NOW, { fire });
  assert.equal((await rowOf(prefix)).notes, `[Nik 2026-10-19] ${NOTE}\n[Nik 2026-10-19] ${NOTE} and Jo`);
});

test("a press on a lead with no research doesn't hold back the next fire", async () => {
  const DB = await seed();
  const { calls, fire } = stubFire();
  assert.equal(await requeueResearch(DB, "ChIJnobody", NOTE, NOW, { fire }), null);
  assert.equal(calls.length, 0);
  assert.deepEqual(await requeueResearch(DB, ID, NOTE, new Date(NOW.getTime() + MIN), { fire }), { fired: true, message: FIRED });
  assert.equal(calls.length, 1);
});

test("control characters in a note become spaces", async () => {
  const DB = await seed({ research: { notes: "" } });
  await requeueResearch(DB, ID, "Owner\u0000is\u001bSue not Dave\u007f", NOW, { fire: stubFire().fire });
  assert.equal((await rowOf(DB)).notes, "[Nik 2026-10-19] Owner is Sue not Dave");
});

test("the routes are behind the login", async () => {
  const { onRequest } = await import("../functions/_middleware.js");
  for (const [path, method] of [[`/api/research/${ID}`, "GET"], [`/api/research/${ID}/wrong`, "POST"]]) {
    let reached = false;
    const res = await onRequest({
      request: new Request(`https://goldbar.pages.dev${path}`, { method }),
      env: { CONTROL_ROOM_PASSWORD: "pw" },
      next: async () => { reached = true; return new Response("ok"); },
    });
    assert.equal(res.status, 401, path);
    assert.deepEqual(await res.json(), { error: "Not logged in" });
    assert.equal(reached, false, path);
  }
});
