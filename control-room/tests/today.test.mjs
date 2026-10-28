// "What to do" checklist. Run: node --test control-room/tests/today.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { steps } from "../functions/_lib/today.js";

const NOW = Date.parse("2026-10-14T09:00:00Z");
const base = { hot: 0, waitingClaude: 0, lastResearchAt: null, stripeLive: false, autopilotOn: true };
// The routes app.js really has (same regex as shell.test.mjs): an unknown route just reloads Home.
const ROUTES = [...readFileSync(new URL("../public/js/app.js", import.meta.url), "utf8").matchAll(/route: "([^"]*)"/g)].map((m) => m[1]);

test("steps with work are to-do, the rest are ticked, in the order to do them", () => {
  const t = steps({ ...base, hot: 2 }, {}, NOW);
  assert.deepEqual(t.daily.map((s) => [s.key, s.status]), [["sitrep", "todo"], ["calls", "done"], ["replies", "done"], ["hot", "optional"]]);
  assert.match(t.daily.find((s) => s.key === "hot").title, /2 hot leads/);
  assert.equal(steps(base, {}, NOW).daily.find((s) => s.key === "hot").status, "done");
});

test("a stalled Claude is flagged near the top", () => {
  const t = steps({ ...base, waitingClaude: 43, lastResearchAt: "2026-10-03T23:33:00Z" }, {}, NOW);
  assert.equal(t.daily[1].key, "claude");
  assert.equal(t.daily[1].status, "warn");
  const fine = steps({ ...base, waitingClaude: 43, lastResearchAt: "2026-10-14T08:00:00Z" }, {}, NOW);
  assert.ok(!fine.daily.some((s) => s.key === "claude"));
});

test("setup ticks itself where it can, the rest by hand", () => {
  const t = steps({ ...base, stripeLive: true, lastResearchAt: "2026-10-14T08:00:00Z" }, { mailboxes: true }, NOW);
  const done = Object.fromEntries(t.setup.map((s) => [s.key, s.done]));
  assert.deepEqual(done, { routine: true, reply_routine: false, autopilot: true, domain: false, mailboxes: true, stripe: true, funnel: false });
  assert.equal(t.setupLeft, 3);
  assert.match(t.setup.find((s) => s.key === "mailboxes").how, /Setup → Mailboxes/);
});

test("every Control Room link in the checklist goes to a page that exists (no Outreach or Roadmap)", () => {
  assert.ok(ROUTES.includes("home") && ROUTES.length >= 5, `couldn't read the routes from app.js: ${ROUTES}`);
  // Every step on show: work waiting everywhere, a stalled Claude, nothing set up.
  const busy = { picks: 67, proposals: 5, questions: 3, flaggedReplies: 2, hot: 4, waitingClaude: 9, lastResearchAt: null,
    oldestQueuedAt: "2026-10-10T09:00:00Z", liveFirstEmails: 0, stripeLive: false, autopilotOn: false, needYou: 3,
    calls: [{ id: "c1", slot_at: "2026-10-14T10:00:00Z", who: "Mark (Diamond Kickboxing)", phone: "07969 770905" }] };
  const t = steps(busy, {}, NOW);
  assert.ok(t.daily.some((s) => s.key === "claude"), "9 leads waiting 4 days and never researched is a stalled Claude");
  for (const s of [...t.daily, ...t.setup]) {
    assert.doesNotMatch(`${s.title} ${s.why || ""} ${s.how || ""}`, /Outreach page|Roadmap/, `${s.key} names a page that's gone`);
    if (!s.href?.startsWith("#/")) continue;
    const route = s.href.slice(2).split(/[/?]/)[0];
    assert.ok(ROUTES.includes(route), `${s.key} links to #/${route}, which isn't a page (it just reloads Home)`);
  }
});

test("Home reads Claude's research from the research table (stage 2), not leads.audit.ai_research", async () => {
  // The old route that wrote audit.ai_research is gone, so reading it would leave "Claude hasn't researched leads
  // lately" up for ever, pointing at the old Routine.
  const { fakeD1 } = await import("./helpers/fakeD1.mjs");
  const { onRequestGet } = await import("../functions/api/today.js");
  const DB = fakeD1();
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const add = (id, status, researched_at) => DB.prepare("INSERT INTO research (place_id, status, notes, queued_at, researched_at) VALUES (?, ?, '', ?, ?)")
    .bind(id, status, ago(4), researched_at).run();
  await add("q1", "queued", null);
  await add("q2", "queued", null);
  await add("d1", "done", ago(3));
  const get = async () => (await onRequestGet({ env: { DB } })).json();

  const stale = await get();
  const claude = stale.daily.find((s) => s.key === "claude");
  assert.ok(claude, "2 leads waiting and no research for 3 days is flagged");
  assert.match(claude.why, /^2 leads waiting\. /);
  assert.match(claude.why, /"aetos-research"/);
  assert.doesNotMatch(claude.why, /Aetos lead research \(daily\)/, "the old Routine is deleted, so Home doesn't send Nik to it");
  assert.equal(stale.setup.find((s) => s.key === "routine").done, false);

  await add("d2", "done", ago(0.1));
  const fresh = await get();
  assert.ok(!fresh.daily.some((s) => s.key === "claude"), "research posted today clears it");
  assert.equal(fresh.setup.find((s) => s.key === "routine").done, true);
  assert.doesNotMatch(fresh.setup.find((s) => s.key === "routine").how, /Aetos lead research \(daily\)/);
});

// Home's research step and Setup's research light share one rule (research.js researchLight): leads waiting and no
// post for 26 h, counted from the later of the last post and the oldest lead waiting. So a Routine that ran with
// nothing to queue isn't called stopped the moment a search (or "Research is wrong") queues leads.
test("leads queued just now after quiet days aren't a stalled Claude; the same leads 27 h later are", () => {
  const ago = (h) => new Date(NOW - h * 3600000).toISOString();
  const fresh = steps({ ...base, waitingClaude: 6, lastResearchAt: ago(72), oldestQueuedAt: ago(10 / 60) }, {}, NOW);
  assert.ok(!fresh.daily.some((s) => s.key === "claude"), "6 queued 10 minutes ago, last post 3 days ago: not stalled");
  assert.equal(fresh.setup.find((s) => s.key === "routine").done, true, "the Routine has posted and isn't stalled");
  const stuck = steps({ ...base, waitingClaude: 6, lastResearchAt: ago(72), oldestQueuedAt: ago(27) }, {}, NOW);
  const claude = stuck.daily.find((s) => s.key === "claude");
  assert.ok(claude, "the same 6 leads queued 27 h ago: stalled");
  assert.match(claude.why, /^6 leads waiting\. /);
  assert.equal(stuck.setup.find((s) => s.key === "routine").done, false);
  // Never posted: counted from the oldest lead waiting, as the light does.
  assert.ok(!steps({ ...base, waitingClaude: 2, oldestQueuedAt: ago(1) }, {}, NOW).daily.some((s) => s.key === "claude"));
  assert.ok(steps({ ...base, waitingClaude: 2, oldestQueuedAt: ago(26) }, {}, NOW).daily.some((s) => s.key === "claude"));
});

test("an empty queue keeps \"Claude researching leads daily\" ticked once Claude has posted, however long ago", () => {
  // The daily search stops at 30 good leads waiting, so the queue drains and the Routine's runs post nothing.
  const t = steps({ ...base, waitingClaude: 0, lastResearchAt: new Date(NOW - 3 * 86400000).toISOString() }, {}, NOW);
  assert.equal(t.setup.find((s) => s.key === "routine").done, true);
  assert.ok(!t.daily.some((s) => s.key === "claude"));
  assert.equal(steps(base, {}, NOW).setup.find((s) => s.key === "routine").done, false, "never posted: not set up yet");
});

test("Home's research step follows the research table's queue times (onRequestGet)", async () => {
  const { fakeD1 } = await import("./helpers/fakeD1.mjs");
  const { onRequestGet } = await import("../functions/api/today.js");
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const add = (DB, id, status, queued_at, researched_at) => DB.prepare("INSERT INTO research (place_id, status, notes, queued_at, researched_at) VALUES (?, ?, '', ?, ?)")
    .bind(id, status, queued_at, researched_at).run();
  const get = async (DB) => (await onRequestGet({ env: { DB } })).json();

  // Done rows only, the newest 3 days old, nothing queued: the Routine is fine, there's just nothing to do.
  const idle = fakeD1();
  await add(idle, "d1", "done", ago(5), ago(4));
  await add(idle, "d2", "done", ago(4), ago(3));
  const quiet = await get(idle);
  assert.equal(quiet.setup.find((s) => s.key === "routine").done, true);
  assert.ok(!quiet.daily.some((s) => s.key === "claude"));

  // A search queues 6 leads now: still fine (the Routine has just been fired).
  for (let i = 1; i <= 6; i++) await add(idle, `q${i}`, "queued", ago(10 / 1440), null);
  const justQueued = await get(idle);
  assert.ok(!justQueued.daily.some((s) => s.key === "claude"), "6 queued 10 minutes ago, last post 3 days ago: no warning");
  assert.equal(justQueued.setup.find((s) => s.key === "routine").done, true);

  // The same leads, queued 27 h ago and still waiting: Claude has stopped.
  const late = fakeD1();
  await add(late, "d2", "done", ago(4), ago(3));
  for (let i = 1; i <= 6; i++) await add(late, `q${i}`, "queued", ago(27 / 24), null);
  const stalled = await get(late);
  const claude = stalled.daily.find((s) => s.key === "claude");
  assert.ok(claude, "6 leads waiting 27 h is flagged");
  assert.match(claude.why, /^6 leads waiting\. /);
  assert.equal(stalled.setup.find((s) => s.key === "routine").done, false);
});

// Home's hot step is the board's isHot (stage 3's _lib/shortlist.js, the app's only hot rule) until stage 11 removes
// Home, so its number always matches the `hot` todos the tick raises (docs/rebuild/05-demo.md Part A §9). A reply, a
// call booked or a lost lead isn't hot whatever its views; order-page events aren't views; and views ≥ 2 stay hot
// after a week.
test("Home's hot step counts the same leads the hot tick step raises todos for (isHot)", async () => {
  const { fakeD1 } = await import("./helpers/fakeD1.mjs");
  const { seedLead, seedProspect } = await import("./helpers/shortlistSeed.mjs");
  const { onRequestGet } = await import("../functions/api/today.js");
  const { hotStep } = await import("../functions/_lib/hot.js");
  const { isHot } = await import("../functions/_lib/shortlist.js");
  const DB = fakeD1();
  const now = Date.now();
  const ago = (h) => new Date(now - h * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const event = (place_id, kind, at) => DB.prepare("INSERT INTO demo_events (slug, place_id, kind, at) VALUES (?, ?, ?, ?)")
    .bind(`demo-${place_id}`, place_id, kind, at).run();
  const lead = async (place_id, prospect) => {
    await seedLead(DB, { place_id, name: `Lead ${place_id} Roofing`, phone: "0113 496 0000" });
    await seedProspect(DB, { place_id, last_inbound_at: null, ...prospect });
  };
  // Replied (2 views today): not hot, though the legacy leads.status still says "new".
  await lead("replied1", { stage: "replied", views: 2, last_view_at: ago(1), last_inbound_at: ago(0.5) });
  await event("replied1", "view", ago(3));
  await event("replied1", "view", ago(1));
  // Lost (2 views today): not hot.
  await lead("lost1", { stage: "lost", views: 2, last_view_at: ago(2) });
  await event("lost1", "view", ago(4));
  await event("lost1", "view", ago(2));
  // Emailed, 0 views, one "Order this site" click (the demo's order_page, then the order page's own beacon): not hot.
  await lead("order1", { stage: "emailed", views: 0, last_view_at: null });
  await event("order1", "order_page", ago(2));
  await event("order1", "order_page", ago(2));
  // Viewed once 24.5 hours ago: inside the query's 25-hour window, but isHot says no.
  await lead("once1", { stage: "viewed", views: 1, last_view_at: ago(24.5) });
  await event("once1", "view", ago(24.5));
  // Viewed twice, the last time ten days ago: hot (views ≥ 2), though outside a 7-day window.
  await lead("viewed1", { stage: "viewed", views: 2, last_view_at: ago(240) });
  await event("viewed1", "view", ago(250));
  await event("viewed1", "view", ago(240));

  const sql = [];
  const watched = { prepare: (q) => (sql.push(q), DB.prepare(q)), batch: (s) => DB.batch(s) };
  const home = await (await onRequestGet({ env: { DB: watched } })).json();
  const hot = home.daily.find((s) => s.key === "hot");
  assert.equal(hot.title, "Optional: call 1 hot lead");
  assert.equal(hot.status, "optional");
  // FROM, not any mention: Home's calls step joins prospects for the greeting name (upcomingCalls in calls-db.js).
  assert.equal(sql.filter((q) => /\bFROM prospects\b/.test(q)).length, 1, "the hot count is one D1 statement on prospects");
  assert.ok(!sql.some((q) => /\bdemo_events\b/.test(q)), "Home's hot count doesn't read demo_events");

  // The tick's hot step raises todos for exactly the same leads, and they are the ones isHot calls hot.
  await hotStep({ DB, env: {}, now: new Date(now), budget: { left: () => 50 } });
  const todos = DB.raw.prepare("SELECT DISTINCT place_id FROM todos WHERE kind = 'hot' AND status = 'open' ORDER BY place_id")
    .all().map((r) => r.place_id);
  assert.deepEqual(todos, ["viewed1"]);
  const prospects = DB.raw.prepare("SELECT * FROM prospects ORDER BY place_id").all();
  assert.deepEqual(prospects.filter((p) => isHot(p, new Date(now))).map((p) => p.place_id), todos);
  assert.match(hot.title, new RegExp(`call ${todos.length} hot lead`));
});

// Until stage 11's Todo page, Home is where Nik sees the calls Claude books and the replies that need him
// (docs/rebuild/07-replies-calls.md Part A "What Nik sees": Home). Calls from 30 minutes ago to the end of tomorrow
// (UK), confirmed only; the replies count is the Replies page's Needs you (open escalation and call_time Todos).
test("Home lists today's and tomorrow's calls and the replies that need Nik", () => {
  // NOW = Wed 14 Oct 2026 10:00 UK.
  const none = steps(base, {}, NOW);
  const calls = none.daily.find((s) => s.key === "calls");
  assert.equal(calls.status, "done");
  assert.equal(calls.doneText, "No calls booked.");
  const replies = none.daily.find((s) => s.key === "replies");
  assert.equal(replies.status, "done");
  assert.equal(replies.href, "#/replies");

  const today = steps({ ...base, calls: [{ id: "c1", slot_at: "2026-10-14T10:00:00Z", who: "Mark (Diamond Kickboxing)", phone: "07969 770905" }] }, {}, NOW)
    .daily.find((s) => s.key === "calls");
  assert.equal(today.title, "Call Mark (Diamond Kickboxing) at 11:00 today");
  assert.equal(today.href, "#/call/c1");
  assert.equal(today.cta, "Open call");
  assert.equal(today.status, "todo");
  assert.match(today.why, /07969 770905/);

  const tomorrow = steps({ ...base, calls: [{ id: "c2", slot_at: "2026-10-15T10:00:00Z", who: "Sam (Smith Roofing)", phone: null }] }, {}, NOW)
    .daily.find((s) => s.key === "calls");
  assert.equal(tomorrow.title, "Call Sam (Smith Roofing) Thu 11:00");
  assert.equal(tomorrow.href, "#/call/c2");
  assert.match(tomorrow.why, /no number yet/);

  const both = steps({ ...base, calls: [
    { id: "c1", slot_at: "2026-10-14T10:00:00Z", who: "Mark (Diamond Kickboxing)", phone: "07969 770905" },
    { id: "c2", slot_at: "2026-10-15T10:00:00Z", who: "Sam (Smith Roofing)", phone: null },
  ] }, {}, NOW).daily.find((s) => s.key === "calls");
  assert.equal(both.title, "Call Mark (Diamond Kickboxing) at 11:00 today");
  assert.match(both.why, /Thu 11:00 Sam \(Smith Roofing\)/, "the next call is listed under the first");

  const need = steps({ ...base, needYou: 2 }, {}, NOW).daily.find((s) => s.key === "replies");
  assert.deepEqual([need.title, need.status, need.cta], ["2 replies need you", "warn", "Open Replies"]);
  assert.equal(steps({ ...base, needYou: 1 }, {}, NOW).daily.find((s) => s.key === "replies").title, "1 reply needs you");
});

test("Home's calls and replies steps read the calls and todos tables (onRequestGet)", async () => {
  const { fakeD1 } = await import("./helpers/fakeD1.mjs");
  const { onRequestGet } = await import("../functions/api/today.js");
  const DB = fakeD1();
  const at = new Date("2026-10-14T08:00:00Z"); // Wed 14 Oct, 09:00 UK
  const stamp = "2026-10-12T09:00:00Z";
  const run = (sql, ...args) => DB.prepare(sql).bind(...args).run();
  for (const [id, name, greet, phone] of [["a", "DIAMOND KICKBOXING LTD", "Mark", "07969 770905"], ["b", "Smith Roofing", "Sam", null],
    ["c", "Jones Plumbing", "Dai", null], ["d", "Late Locks", "Bob", null]]) {
    await run("INSERT INTO leads (place_id, name, trade, search_town, phone, first_seen_at, updated_at) VALUES (?, ?, 'trade', 'Leeds', ?, ?, ?)",
      id, name, phone, stamp, stamp);
    await run("INSERT INTO prospects (place_id, stage, stage_at, email, greet_name, created_at, updated_at) VALUES (?, 'call_booked', ?, ?, ?, ?, ?)",
      id, stamp, `${id}@them.co.uk`, greet, stamp, stamp);
  }
  const call = (id, place_id, slot_at, status) => run(
    "INSERT INTO calls (id, place_id, slot_at, status, phone, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
    id, place_id, slot_at, status, stamp, stamp);
  const get = async () => (await onRequestGet({ env: { DB }, now: at })).json();

  const empty = await get();
  assert.equal(empty.daily.find((s) => s.key === "calls").status, "done", "no calls booked");
  assert.equal(empty.daily.find((s) => s.key === "replies").status, "done");

  await call("cx", "c", "2026-10-14T10:00:00Z", "cancelled"); // today 11:00, cancelled: left out
  await call("cl", "d", "2026-10-16T10:00:00Z", "confirmed"); // Friday: past tomorrow, left out
  await call("drill1", "drill:price", "2026-10-14T10:00:00Z", "confirmed"); // practice: left out
  const cancelledOnly = await get();
  assert.equal(cancelledOnly.daily.find((s) => s.key === "calls").status, "done", "a cancelled call, a practice call and Friday's aren't shown");

  await call("tm", "b", "2026-10-15T10:00:00Z", "confirmed"); // tomorrow
  const tmr = (await get()).daily.find((s) => s.key === "calls");
  assert.equal(tmr.title, "Call Sam (Smith Roofing) Thu 11:00");
  assert.equal(tmr.href, "#/call/tm");

  await call("td", "a", "2026-10-14T10:00:00Z", "confirmed"); // today
  const tdy = (await get()).daily.find((s) => s.key === "calls");
  assert.equal(tdy.title, "Call Mark (Diamond Kickboxing) at 11:00 today");
  assert.equal(tdy.href, "#/call/td");
  assert.match(tdy.why, /07969 770905/, "the lead's number when the call has none");

  const todo = (id, kind, status) => run("INSERT INTO todos (id, kind, place_id, title, status, dedupe, created_at) VALUES (?, ?, 'a', 't', ?, ?, ?)",
    id, kind, status, `${kind}:${id}`, stamp);
  await todo("t1", "escalation", "open");
  await todo("t2", "call_time", "open");
  await todo("t3", "escalation", "done");
  await todo("t4", "call", "open"); // a call Todo isn't a reply that needs him
  const r = (await get()).daily.find((s) => s.key === "replies");
  assert.deepEqual([r.title, r.status, r.href], ["2 replies need you", "warn", "#/replies"]);
});

test("\"Claude answering replies\" ticks itself once the reply Routine has checked in", async () => {
  const unset = steps(base, {}, NOW).setup.find((s) => s.key === "reply_routine");
  assert.equal(unset.title, "Claude answering replies");
  assert.equal(unset.done, false);
  assert.match(unset.how, /aetos-reply/);
  assert.match(unset.how, /routines\/README\.md/);
  assert.equal(steps({ ...base, replyRoutineAt: "2026-10-14T08:00:00Z" }, {}, NOW).setup.find((s) => s.key === "reply_routine").done, true);

  const { fakeD1 } = await import("./helpers/fakeD1.mjs");
  const { onRequestGet } = await import("../functions/api/today.js");
  const DB = fakeD1();
  const get = async () => (await onRequestGet({ env: { DB } })).json();
  assert.equal((await get()).setup.find((s) => s.key === "reply_routine").done, false);
  await DB.prepare("INSERT INTO heartbeats (name, last_at, ok, detail) VALUES ('routine:reply', '2026-10-14T08:00:00Z', 1, 'test ok')").run();
  assert.equal((await get()).setup.find((s) => s.key === "reply_routine").done, true);
});
