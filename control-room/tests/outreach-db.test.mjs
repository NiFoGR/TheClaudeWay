// Outreach database side: swapping old starters, Start outreach, Claude's questions. Run: node --test control-room/tests/outreach-db.test.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SCHEMA } from "../functions/_lib/schema.js";
import { loadOutreach } from "../functions/_lib/outreach-db.js";
import { SEED_FOLLOWUPS, SEED_TEST } from "../functions/_lib/outreach-seed.js";
import { onRequestPost as enrol } from "../functions/api/outreach/enrol.js";
import { onRequestPost as ask } from "../functions/api/agent/questions.js";
import { onRequestPatch as answer } from "../functions/api/outreach/questions/[id].js";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    _run: () => db.prepare(sql).run(...args),
  });
  SCHEMA.forEach((s) => db.exec(s));
  return { prepare: (sql) => stmt(sql), batch: async (list) => list.map((s) => (s._run ? s._run() : null)), raw: db };
}

const req = (body, headers = {}) => new Request("https://x/api", { method: "POST", body: JSON.stringify(body), headers });

test("old starters that were never sent are swapped for the demo-based ones, once", async () => {
  const DB = fakeD1();
  const ins = DB.raw.prepare("INSERT INTO outreach_versions (id, step, name, hypothesis, subject, body, status, author, created_at) VALUES (?, 1, ?, '', 's', 'b', ?, ?, '2026-10-01')");
  ins.run("old-proposed", "Maps rank vs the local leader", "proposed", "seed");
  ins.run("old-live", "Their biggest problem, then a demo offer", "live", "seed");
  ins.run("mine", "My own", "proposed", "owner");
  const d = await loadOutreach(DB);
  const names = d.versions.map((v) => v.name);
  assert.ok(!names.includes("Maps rank vs the local leader"));
  assert.equal(d.versions.find((v) => v.id === "old-live").status, "retired");
  assert.ok(names.includes("My own")); // the owner's own work is never touched
  assert.equal(d.versions.filter((v) => v.author === "seed" && v.status === "proposed").length, SEED_TEST.length + SEED_FOLLOWUPS.length);
  const again = await loadOutreach(DB);
  assert.equal(again.versions.length, d.versions.length); // no duplicates on the next load
});

test("Start outreach only adds leads with an email that weren't contacted yet; Stop puts them back", async () => {
  const DB = fakeD1();
  const add = DB.raw.prepare("INSERT INTO leads (place_id, name, trade, search_town, email, status, excluded, first_seen_at, updated_at) VALUES (?, ?, 'roofer', 'Leeds', ?, ?, ?, 'x', 'x')");
  add.run("a", "Smith Roofing", "dave@smith.co.uk", "new", 0);
  add.run("b", "No Email Roofing", null, "new", 0);
  add.run("c", "Chain Roofing", "info@chain.co.uk", "new", 1);
  add.run("d", "Old Roofing", "x@old.co.uk", "contacted", 0);
  const env = { DB };
  const out = await (await enrol({ request: req({ place_ids: ["a", "b", "c", "d"] }), env })).json();
  assert.equal(out.added, 1);
  assert.deepEqual(out.skipped.map((s) => s.place_id).sort(), ["b", "c", "d"]);
  assert.match(out.skipped.find((s) => s.place_id === "b").reason, /No email/);
  assert.equal(DB.raw.prepare("SELECT status FROM leads WHERE place_id = 'a'").get().status, "in outreach");
  const back = await (await enrol({ request: req({ place_ids: ["a"], action: "stop" }), env })).json();
  assert.equal(back.added, 1);
  assert.equal(DB.raw.prepare("SELECT status FROM leads WHERE place_id = 'a'").get().status, "new");
});

test("Claude can ask the owner up to 3 questions at a time; answers reach the report data", async () => {
  const DB = fakeD1();
  const env = { DB, OUTREACH_AGENT_TOKEN: "t".repeat(30) };
  const auth = { authorization: `Bearer ${"t".repeat(30)}` };
  assert.equal((await ask({ request: req({ question: "Would you ever mention price in a follow-up?" }), env })).status, 401);
  for (let i = 0; i < 3; i++) {
    assert.equal((await ask({ request: req({ question: `Question number ${i} for you?`, options: ["Yes", "No"] }, auth), env })).status, 201);
  }
  assert.equal((await ask({ request: req({ question: "One too many questions?" }, auth), env })).status, 429);
  const id = DB.raw.prepare("SELECT id FROM owner_questions LIMIT 1").get().id;
  const res = await answer({ request: new Request("https://x", { method: "PATCH", body: JSON.stringify({ answer: "Never" }) }), env, params: { id } });
  assert.equal(res.status, 200);
  const d = await loadOutreach(DB);
  assert.equal(d.questions.find((q) => q.id === id).answer, "Never");
  assert.deepEqual(d.questions.find((q) => q.id !== id).options, ["Yes", "No"]);
});
