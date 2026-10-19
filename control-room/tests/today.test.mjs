// "What to do" checklist. Run: node --test control-room/tests/today.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { steps } from "../functions/_lib/today.js";

const NOW = Date.parse("2026-10-14T09:00:00Z");
const base = { picks: 0, proposals: 0, questions: 0, flaggedReplies: 0, hot: 0, waitingClaude: 0, lastResearchAt: null,
  liveFirstEmails: 0, stripeLive: false, autopilotOn: true };

test("steps with work are to-do, the rest are ticked, in the order to do them", () => {
  const t = steps({ ...base, picks: 7, proposals: 5, hot: 2 }, {}, NOW);
  assert.deepEqual(t.daily.map((s) => [s.key, s.status]), [
    ["sitrep", "todo"], ["picks", "todo"], ["versions", "todo"], ["questions", "done"], ["replies", "done"], ["hot", "optional"]]);
  assert.match(t.daily[1].title, /7 ready/);
  assert.match(t.daily[2].title, /5 email versions/);
});

test("a stalled Claude is flagged near the top", () => {
  const t = steps({ ...base, waitingClaude: 43, lastResearchAt: "2026-10-03T23:33:00Z" }, {}, NOW);
  assert.equal(t.daily[1].key, "claude");
  assert.equal(t.daily[1].status, "warn");
  const fine = steps({ ...base, waitingClaude: 43, lastResearchAt: "2026-10-14T08:00:00Z" }, {}, NOW);
  assert.ok(!fine.daily.some((s) => s.key === "claude"));
});

test("setup ticks itself where it can, the rest by hand", () => {
  const t = steps({ ...base, liveFirstEmails: 2, stripeLive: true, lastResearchAt: "2026-10-14T08:00:00Z" }, { mailboxes: true }, NOW);
  const done = Object.fromEntries(t.setup.map((s) => [s.key, s.done]));
  assert.deepEqual(done, { routine: true, autopilot: true, emails: true, domain: false, mailboxes: true, stripe: true, funnel: false });
  assert.equal(t.setupLeft, 2);
});
