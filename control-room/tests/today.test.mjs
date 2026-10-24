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
  assert.deepEqual(t.daily.map((s) => [s.key, s.status]), [["sitrep", "todo"], ["hot", "optional"]]);
  assert.match(t.daily[1].title, /2 hot leads/);
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
  assert.deepEqual(done, { routine: true, autopilot: true, domain: false, mailboxes: true, stripe: true, funnel: false });
  assert.equal(t.setupLeft, 2);
  assert.match(t.setup.find((s) => s.key === "mailboxes").how, /Setup → Mailboxes/);
});

test("every Control Room link in the checklist goes to a page that exists (no Outreach or Roadmap)", () => {
  assert.ok(ROUTES.includes("home") && ROUTES.length >= 5, `couldn't read the routes from app.js: ${ROUTES}`);
  // Every step on show: work waiting everywhere, a stalled Claude, nothing set up.
  const busy = { picks: 67, proposals: 5, questions: 3, flaggedReplies: 2, hot: 4, waitingClaude: 9, lastResearchAt: null,
    oldestQueuedAt: "2026-10-10T09:00:00Z", liveFirstEmails: 0, stripeLive: false, autopilotOn: false };
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
