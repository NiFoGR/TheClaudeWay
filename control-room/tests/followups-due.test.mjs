// Follow-ups due today: queued follow-up messages plus prospects whose next follow-up falls before the end of UK today.
// Run: node --test control-room/tests/followups-due.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { followupsDueToday } from "../functions/_lib/followups.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const NOW = new Date("2026-10-21T08:00:00Z"); // Wed 09:00 UK (BST); UK today ends at 2026-10-21T23:00:00Z

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

const prospect = (place_id, next_followup_at) => ({
  place_id, stage: "emailed", stage_at: "2026-10-14T09:00:00Z", email: `${place_id}@example.co.uk`,
  next_followup_at, created_at: "2026-10-14T09:00:00Z", updated_at: "2026-10-14T09:00:00Z",
});

const message = (id, kind, status) => ({
  id, place_id: `p-${id}`, direction: "out", kind, author: kind === "first" ? "nik" : "system",
  to_addr: `${id}@example.co.uk`, body: "Hi,\n\nJust checking you saw the site I made you.", status,
  due_at: "2026-10-21T07:00:00Z", created_at: "2026-10-20T09:00:00Z",
});

test("counts queued follow-ups and prospects due by the end of UK today", async () => {
  const DB = fakeD1();
  await insert(DB, "prospects", prospect("early", "2026-10-21T06:00:00Z")); // 07:00 BST today
  await insert(DB, "prospects", prospect("late", "2026-10-21T22:30:00Z")); // 23:30 BST, still today
  await insert(DB, "prospects", prospect("tomorrow", "2026-10-21T23:30:00Z")); // 00:30 BST tomorrow
  await insert(DB, "prospects", prospect("stopped", null)); // stopped or finished: never counts
  await insert(DB, "messages", message("m1", "followup", "queued"));
  await insert(DB, "messages", message("m2", "followup", "sending")); // counted in sentToday, not here
  await insert(DB, "messages", message("m3", "followup", "sent"));
  await insert(DB, "messages", message("m4", "first", "queued"));
  assert.equal(await followupsDueToday(DB, NOW), 3);
});

// Stage 6 keeps next_followup_at after follow-up 9 as the close time (marked lost then, no email), and only emailed
// and viewed leads get follow-ups (replied and on stop the sequence), so neither takes a place in today's cap.
test("a finished sequence's close time and a stopped stage aren't follow-ups due", async () => {
  const DB = fakeD1();
  await insert(DB, "prospects", { ...prospect("closing", "2026-10-21T08:15:00Z"), followup_step: 9 });
  await insert(DB, "prospects", { ...prospect("replied", "2026-10-21T08:15:00Z"), stage: "replied" });
  await insert(DB, "prospects", { ...prospect("ready", "2026-10-21T08:15:00Z"), stage: "ready" });
  await insert(DB, "prospects", { ...prospect("viewed", "2026-10-20T08:15:00Z"), stage: "viewed", followup_step: 8 });
  assert.equal(await followupsDueToday(DB, NOW), 1); // only the viewed lead, overdue since yesterday
});

test("the end of UK today after the clocks go back is midnight GMT", async () => {
  const DB = fakeD1();
  const monday = new Date("2026-10-26T10:00:00Z"); // Mon 10:00 GMT (clocks went back on Sun 25 Oct)
  await insert(DB, "prospects", prospect("late", "2026-10-26T23:30:00Z")); // 23:30 GMT, still today
  await insert(DB, "prospects", prospect("midnight", "2026-10-27T00:00:00Z")); // 00:00 Tuesday
  assert.equal(await followupsDueToday(DB, monday), 1);
  assert.equal(await followupsDueToday(DB, "2026-10-26T10:00:00Z"), 1); // UTC ISO text works too, like sentToday
  await assert.rejects(followupsDueToday(DB, null), /UK time needs a valid date/);
});
