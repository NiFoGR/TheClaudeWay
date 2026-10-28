// Stages 7-8 contract: the stage events and columns the replies + calls code relies on were built in stage 0.
// A failure here means stage 0 is incomplete: fix stages.js / lead-manager/schema.sql there, not here.
// Run: node --test control-room/tests/stages-replies.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { SCHEMA } from "../functions/_lib/schema.js";
import { nextStage } from "../functions/_lib/stages.js";

test("events this stage fires exist", () => {
  assert.equal(nextStage("needs_nik", "nik_handled"), "replied");
  assert.equal(nextStage("call_booked", "call_cancelled"), "replied");
  assert.equal(nextStage("lost", "reopen"), "replied");
  assert.equal(nextStage("emailed", "nik_handled"), "emailed");
  assert.equal(nextStage("lost", "call_cancelled"), "lost");
  assert.equal(nextStage("won", "reopen"), "won");
});

// schema.sql aligns its columns with runs of spaces ("intent       TEXT"), so the gap is \s+ rather than one space.
test("columns this stage writes exist", () => {
  assert.ok(SCHEMA.some((s) => /TABLE IF NOT EXISTS messages[\s\S]*\bintent\s+TEXT/.test(s)));
  assert.ok(SCHEMA.some((s) => /TABLE IF NOT EXISTS calls[\s\S]*\bnote\s+TEXT NOT NULL DEFAULT ''/.test(s)));
});

// Edge cases the replies code relies on: each event moves only from its own stage, and intent stays nullable
// (outbound rows and unread inbound rows are written without it).
test("the events move only from their own stage, and intent is nullable", () => {
  assert.equal(nextStage("replied", "reopen"), "replied");
  assert.equal(nextStage("call_booked", "nik_handled"), "call_booked");
  assert.equal(nextStage("needs_nik", "call_cancelled"), "needs_nik");
  assert.equal(nextStage("call_booked", "call_cancelled"), "replied"); // a no-show uses the same event
  const messages = SCHEMA.find((s) => /TABLE IF NOT EXISTS messages\b/.test(s));
  assert.match(messages, /\bintent\s+TEXT\s*,/);
});
