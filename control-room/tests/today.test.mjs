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
    liveFirstEmails: 0, stripeLive: false, autopilotOn: false };
  const t = steps(busy, {}, NOW);
  for (const s of [...t.daily, ...t.setup]) {
    assert.doesNotMatch(`${s.title} ${s.why || ""} ${s.how || ""}`, /Outreach page|Roadmap/, `${s.key} names a page that's gone`);
    if (!s.href?.startsWith("#/")) continue;
    const route = s.href.slice(2).split(/[/?]/)[0];
    assert.ok(ROUTES.includes(route), `${s.key} links to #/${route}, which isn't a page (it just reloads Home)`);
  }
});
