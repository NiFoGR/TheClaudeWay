// The Voice API (stage 5–6, docs/rebuild/06-email-followups.md Part A §A7, Task 12): GET /api/voice (the 9 follow-up
// templates with their checks and a preview, Nik's examples and rules, has_price_reply), PUT /api/voice/followups/:step
// (save: always a draft again), POST /api/voice/followups/:step/approve (checkFollowup must pass; all 9 approved closes
// the setup:followups todo), POST /api/voice/examples and DELETE /api/voice/examples/:id.
// Handlers are called the way Pages calls them: {request, env: {DB}, params, now}.
// Run: node --test control-room/tests/voice.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as gate } from "../functions/_middleware.js";
import { countingDB } from "../functions/_lib/d1count.js";
import { DRAFTS, followupsApproved } from "../functions/_lib/followups.js";
import { addTodo } from "../functions/_lib/todo.js";
import { db } from "../functions/_lib/util.js";
import { onRequestDelete as deleteExample } from "../functions/api/voice/examples/[id].js";
import { onRequestPost as addExample } from "../functions/api/voice/examples/index.js";
import { onRequestPost as approveFollowup } from "../functions/api/voice/followups/[step]/approve.js";
import { onRequestPut as putFollowup } from "../functions/api/voice/followups/[step]/index.js";
import { onRequestGet as getVoice } from "../functions/api/voice/index.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { seedDemo, seedLead, seedProspect } from "./helpers/shortlistSeed.mjs";

const ORIGIN = "https://control.example";
const NOW = new Date("2026-10-21T10:00:00Z");
const SEO = 'Don\'t say "SEO". Say "front page of Google" instead.';
const CHANGED = "This text isn't the one that's saved. Press Save first (or refresh the page if it was changed somewhere else), then approve.";
const NO_STEP = "That follow-up doesn't exist: they're numbered 1 to 9.";
// Part A §A7's sample, for when no prospect has a live demo.
const SAMPLE_STEP_1 = "Hi Mark,\n\nIn case my last email got buried: I made a new website for Green Leaf Landscapes and it's ready to look at.\n\nhttps://aetoswebsites.com/d/green-leaf-landscapes\n\nIt takes a minute on your phone.";

// db() checks the schema once per isolate. Done here, so the statement counts below are the routes' own.
await db({ DB: fakeD1() });

// ---------------------------------------------------------------- requests

/** A request as Pages hands it to a handler, with the tests' clock. */
function ctx(env, path, { method = "GET", body, params = {}, now = NOW } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return { request: new Request(`${ORIGIN}${path}`, init), env, params, now };
}
const approve = (env, step, body, now) => approveFollowup(ctx(env, `/api/voice/followups/${step}/approve`,
  { method: "POST", body, params: { step: String(step) }, now }));
const put = (env, step, body) => putFollowup(ctx(env, `/api/voice/followups/${step}`,
  { method: "PUT", body, params: { step: String(step) } }));
const voice = async (env, now) => {
  const res = await getVoice(ctx(env, "/api/voice", { now }));
  assert.equal(res.status, 200);
  return res.json();
};
const add = (env, body) => addExample(ctx(env, "/api/voice/examples", { method: "POST", body }));
const remove = (env, id) => deleteExample(ctx(env, `/api/voice/examples/${encodeURIComponent(id)}`, { method: "DELETE", params: { id } }));

/** fakeD1 with the open "Approve your 9 follow-up emails" todo, as the followups tick step adds it. */
async function voiceEnv() {
  const DB = fakeD1();
  await addTodo(DB, { kind: "setup", title: "Approve your 9 follow-up emails", link: "/#/voice", dedupe: "setup:followups" });
  return { env: { DB } };
}
// node:sqlite gives null-prototype rows: copied into plain objects, so deepEqual compares only their fields.
const rows = (DB, sql, ...args) => DB.raw.prepare(sql).all(...args).map((r) => ({ ...r }));
const one = (DB, sql, ...args) => {
  const row = DB.raw.prepare(sql).get(...args);
  return row ? { ...row } : row;
};
const template = (DB, step) => one(DB, "SELECT body, status, approved_at FROM followup_templates WHERE step = ?", step);

// ---------------------------------------------------------------- the spec's tests (Task 12, Step 1)

test("approve all 9 closes the setup todo; editing makes a draft again", async () => {
  const { env } = await voiceEnv();                                      // fakeD1 + open setup:followups todo
  for (let s = 1; s <= 9; s++) assert.equal((await approve(env, s)).status, 200);
  // closeTodos (stage 0's todo.js) frees the dedupe on closing, as "setup:followups@<done_at>", so the item can come
  // back if a template becomes a draft again: the closed todo is found under that freed dedupe.
  assert.equal((await env.DB.prepare("SELECT status FROM todos WHERE dedupe LIKE 'setup:followups@%'").first()).status, "done");
  assert.equal(await env.DB.prepare("SELECT 1 FROM todos WHERE dedupe = 'setup:followups'").first(), null);
  await put(env, 4, { body: DRAFTS[4] });
  assert.deepEqual(await followupsApproved(env.DB), { approved: 8, all: false });
});

test("approve refuses a body that fails the checks", async () => {
  const { env } = await voiceEnv(); await put(env, 1, { body: "{greeting}\n\nBetter SEO" });
  const r = await approve(env, 1);
  assert.equal(r.status, 400); assert.equal((await r.json()).error, SEO);
  assert.equal(template(env.DB, 1).status, "draft");
  assert.equal(one(env.DB, "SELECT status FROM todos WHERE dedupe = 'setup:followups'").status, "open");
});

test("examples: add, has_price_reply, delete", async () => {
  const { env } = await voiceEnv();
  const before = await voice(env);
  assert.deepEqual(before.examples, []);
  assert.equal(before.has_price_reply, false);

  const res = await add(env, { kind: "example", situation: "they ask the price", body: "It's around £2,000 for the site." });
  assert.equal(res.status, 200);
  const { example } = await res.json();
  assert.equal(example.kind, "example");
  assert.equal(example.situation, "they ask the price");
  assert.equal(example.body, "It's around £2,000 for the site.");
  assert.equal(example.source, "nik_written");
  assert.equal(example.created_at, "2026-10-21T10:00:00Z");
  assert.equal(typeof example.id, "string");
  assert.ok(example.id);

  const after = await voice(env);
  assert.deepEqual(after.examples, [example]);
  assert.equal(after.has_price_reply, true);

  const gone = await remove(env, example.id);
  assert.equal(gone.status, 200);
  assert.deepEqual(await gone.json(), { ok: true });
  const last = await voice(env);
  assert.deepEqual(last.examples, []);
  assert.equal(last.has_price_reply, false);
  assert.equal(one(env.DB, "SELECT COUNT(*) AS n FROM style_examples").n, 0);
});

test("bad example input", async () => {
  const { env } = await voiceEnv();
  const refused = async (body, error) => {
    const r = await add(env, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).error, error);
  };
  await refused({ kind: "x", situation: "they ask the price", body: "It's £1,950." }, "Pick Example reply or Rule.");
  await refused({ situation: "they ask the price", body: "It's £1,950." }, "Pick Example reply or Rule.");
  await refused({ kind: "example", situation: "they ask the price", body: "" }, "Write the text first.");
  await refused({ kind: "rule", situation: "always", body: " \n\t " }, "Write the text first.");
  await refused({ kind: "rule", situation: "always" }, "Write the text first.");
  await refused({ kind: "rule", situation: "  ", body: "Never discuss price." }, 'Fill in "When", e.g. "they ask the price".');
  await refused({ kind: "rule", situation: "x".repeat(201), body: "Never discuss price." }, 'Keep "When" short: 200 characters at most.');
  await refused({ kind: "rule", situation: "always", body: "x".repeat(2001) }, "Too long: 2,001 characters. Keep it to 2,000.");
  await refused("not json", "Pick Example reply or Rule.");
  await refused([1, 2], "Pick Example reply or Rule.");
  assert.equal(one(env.DB, "SELECT COUNT(*) AS n FROM style_examples").n, 0);

  // 2,000 characters is allowed (an emoji is one character), and what's saved is trimmed.
  const ok = await add(env, { kind: "rule", situation: "  they say\n they're busy ", body: `  ${"😀".repeat(2000)}\r\n` });
  assert.equal(ok.status, 200);
  const { example } = await ok.json();
  assert.equal(example.situation, "they say they're busy");
  assert.equal(example.body, "😀".repeat(2000));
  assert.equal(example.kind, "rule");
});

// ---------------------------------------------------------------- GET /api/voice

test("GET seeds the 9 drafts once, with their checks and the sample preview", async () => {
  const { env } = await voiceEnv();
  const body = await voice(env);
  assert.deepEqual(Object.keys(body).sort(), ["examples", "has_price_reply", "templates"]);
  assert.deepEqual(body.templates.map((t) => t.step), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(body.templates.map((t) => t.day_offset), [1, 2, 4, 7, 10, 17, 24, 30, 60]);
  for (const t of body.templates) {
    assert.deepEqual(Object.keys(t).sort(), ["approved_at", "body", "day_offset", "issues", "preview", "status", "step"]);
    assert.equal(t.body, DRAFTS[t.step], `step ${t.step}`);
    assert.equal(t.status, "draft");
    assert.equal(t.approved_at, null);
    assert.deepEqual(t.issues, [], `step ${t.step}`);
    assert.ok(t.preview.startsWith("Hi Mark,\n\n"), `step ${t.step}`);
    assert.ok(!/\{(greeting|business|demo_link)\}/.test(t.preview), `step ${t.step}`);
  }
  assert.equal(body.templates[0].preview, SAMPLE_STEP_1);
  assert.equal(body.templates[6].preview.includes("https://"), false);  // step 7 has no link

  // A second GET keeps Nik's edit (INSERT OR IGNORE), and shows the edit's own checks.
  await put(env, 3, { body: "{greeting}\n\nSee www.example.com" });
  const again = await voice(env);
  assert.equal(again.templates[2].body, "{greeting}\n\nSee www.example.com");
  assert.deepEqual(again.templates[2].issues, ["Only the demo link is allowed. Remove: www.example.com"]);
  assert.equal(again.templates[2].preview, "Hi Mark,\n\nSee www.example.com");
  assert.equal(one(env.DB, "SELECT COUNT(*) AS n FROM followup_templates").n, 9);
});

test("the preview uses the newest prospect with a live demo", async () => {
  const { env } = await voiceEnv();
  const DB = env.DB;
  // Oldest: a live demo, but a newer prospect has one too.
  await seedLead(DB, { place_id: "old", name: "Old Landscapes" });
  await seedProspect(DB, { place_id: "old", greet_name: "Olga", created_at: "2026-10-01T09:00:00Z" });
  await seedDemo(DB, { place_id: "old", slug: "old-landscapes-aa11" });
  // The one: Sam's, with a live demo whose newest row is the live one.
  await seedLead(DB, { place_id: "mid", name: "SMITH ROOFING LTD - Roofer in Leeds" });
  await seedProspect(DB, { place_id: "mid", greet_name: "Sam", created_at: "2026-10-10T09:00:00Z" });
  await seedDemo(DB, { place_id: "mid", slug: "smith-roofing-ab12", created_at: "2026-10-10T09:00:00Z", expires_at: "2026-12-01T00:00:00Z" });
  await seedDemo(DB, { place_id: "mid", slug: "smith-roofing-old1", created_at: "2026-03-01T09:00:00Z", expires_at: "2026-03-15T09:00:00Z" });
  // Newer, but its demo has ended.
  await seedLead(DB, { place_id: "ended", name: "Ended Gardens" });
  await seedProspect(DB, { place_id: "ended", created_at: "2026-10-15T09:00:00Z" });
  await seedDemo(DB, { place_id: "ended", slug: "ended-gardens-cc33", expires_at: "2026-10-20T09:00:00Z" });
  // Newer still: its latest demo has ended, though an older one is still up (the latest is the one that counts).
  await seedLead(DB, { place_id: "newer", name: "Newer Gardens" });
  await seedProspect(DB, { place_id: "newer", created_at: "2026-10-18T09:00:00Z" });
  await seedDemo(DB, { place_id: "newer", slug: "newer-gardens-new1", created_at: "2026-10-18T09:00:00Z", expires_at: "2026-10-20T09:00:00Z" });
  await seedDemo(DB, { place_id: "newer", slug: "newer-gardens-old1", created_at: "2026-10-01T09:00:00Z" });
  // Newest: no demo at all.
  await seedLead(DB, { place_id: "nodemo", name: "No Demo Ltd" });
  await seedProspect(DB, { place_id: "nodemo", created_at: "2026-10-20T09:00:00Z" });

  const body = await voice(env);
  assert.equal(body.templates[0].preview,
    "Hi Sam,\n\nIn case my last email got buried: I made a new website for Smith Roofing and it's ready to look at.\n\nhttps://aetoswebsites.com/d/smith-roofing-ab12\n\nIt takes a minute on your phone.");

  // No confident first name → "Hi,", as the follow-up itself would say.
  DB.raw.prepare("UPDATE prospects SET greet_name = NULL WHERE place_id = 'mid'").run();
  assert.ok((await voice(env)).templates[0].preview.startsWith("Hi,\n\nIn case my last email got buried: I made a new website for Smith Roofing"));

  // Once that demo has ended too, the next one down with a live demo is used; with none left, the sample.
  assert.ok((await voice(env, new Date("2026-12-31T10:00:00Z"))).templates[0].preview.startsWith("Hi Olga,"));
  assert.equal((await voice(env, new Date("2027-02-01T10:00:00Z"))).templates[0].preview, SAMPLE_STEP_1);
});

test("the preview greets a ready prospect's raw name as Send will store it: \"Hi Mark,\", never \"Hi MARK,\"", async () => {
  // A `ready` prospect's greet_name is stage 4's owner.first as research found it (Companies House writes names in
  // capitals); Send stores greetingFor's title-cased name, and the follow-ups say that.
  const { env } = await voiceEnv();
  await seedLead(env.DB, { place_id: "caps", name: "SMITH ROOFING LTD" });
  await seedProspect(env.DB, { place_id: "caps", greet_name: "MARK" });
  await seedDemo(env.DB, { place_id: "caps", slug: "smith-roofing" });
  const preview = async () => (await voice(env)).templates[0].preview;
  assert.ok((await preview()).startsWith("Hi Mark,\n\nIn case my last email got buried: I made a new website for Smith Roofing"));
  for (const [stored, line] of [["mark", "Hi Mark,"], ["  mARK ", "Hi Mark,"], ["mary-jane", "Hi Mary-Jane,"],
    ["DeShawn", "Hi DeShawn,"], ["Mark", "Hi Mark,"], ["Mark Green", "Hi,"], ["M4rk", "Hi,"], ["   ", "Hi,"]]) {
    env.DB.raw.prepare("UPDATE prospects SET greet_name = ? WHERE place_id = 'caps'").run(stored);
    assert.ok((await preview()).startsWith(`${line}\n\n`), `${JSON.stringify(stored)} → ${line}`);
  }
});

test("a prospect whose name cleans to nothing isn't used for the preview", async () => {
  const { env } = await voiceEnv();
  await seedLead(env.DB, { place_id: "blank", name: "   " });
  await seedProspect(env.DB, { place_id: "blank", greet_name: "Bob" });
  await seedDemo(env.DB, { place_id: "blank", slug: "blank-aa11" });
  assert.equal((await voice(env)).templates[0].preview, SAMPLE_STEP_1);
});

test("examples list Nik's own first, then the first emails he sent, newest first", async () => {
  const { env } = await voiceEnv();
  const insert = (id, kind, situation, source, created_at, body = `Body ${id}`) => env.DB.raw.prepare(
    "INSERT INTO style_examples (id, kind, situation, body, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, kind, situation, body, source, created_at);
  insert("sent:m1", "example", "first email", "nik_sent", "2026-10-20T09:00:00Z");
  insert("w-old", "rule", "always", "nik_written", "2026-10-01T09:00:00Z");
  insert("sent:m2", "example", "first email", "nik_sent", "2026-10-21T09:00:00Z");
  insert("w-new", "example", "can we have a call", "nik_written", "2026-10-05T09:00:00Z");
  // A first email he sent that talks about cost is still no price reply (stage 7 widens the match, not the rows).
  insert("sent:m3", "example", "first email", "nik_sent", "2026-10-19T09:00:00Z",
    "Hi Mark,\n\nA slow website is costing you jobs. Have a look at the one I made: no cost to look.");
  const body = await voice(env);
  assert.deepEqual(body.examples.map((e) => e.id), ["w-new", "w-old", "sent:m2", "sent:m1", "sent:m3"]);
  assert.deepEqual(body.examples[0], {
    id: "w-new", kind: "example", situation: "can we have a call", body: "Body w-new", source: "nik_written",
    created_at: "2026-10-05T09:00:00Z",
  });
  assert.equal(body.has_price_reply, false);

  // A sent first email can be deleted too (it stops being used as an example); its id has a ":" in it.
  const r = await remove(env, "sent:m1");
  assert.equal(r.status, 200);
  assert.deepEqual((await voice(env)).examples.map((e) => e.id), ["w-new", "w-old", "sent:m2", "sent:m3"]);
});

test("has_price_reply: only an example reply for 'they ask the price' counts, in any case", async () => {
  const { env } = await voiceEnv();
  await add(env, { kind: "rule", situation: "they ask the price", body: "Give the Full Package price first." });
  assert.equal((await voice(env)).has_price_reply, false);              // a rule isn't his reply
  await add(env, { kind: "example", situation: "they ask for more info", body: "It's all on the page." });
  assert.equal((await voice(env)).has_price_reply, false);
  // Only what Nik wrote on the Voice page (source nik_written) counts: never a first email he sent (nik_sent).
  env.DB.raw.prepare("INSERT INTO style_examples (id, kind, situation, body, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("sent:m9", "example", "they ask the price", "It's around £2,000.", "nik_sent", "2026-10-20T09:00:00Z");
  assert.equal((await voice(env)).has_price_reply, false);
  await add(env, { kind: "example", situation: "  They ask  the PRICE ", body: "It's around £2,000." });
  assert.equal((await voice(env)).has_price_reply, true);
});

test("GET costs 4 D1 statements", async () => {
  const { env } = await voiceEnv();
  const c = countingDB(env.DB);
  await getVoice(ctx({ DB: c.DB }, "/api/voice"));
  assert.equal(c.used(), 4);
});

// ---------------------------------------------------------------- PUT /api/voice/followups/:step

test("PUT saves the text as a draft and returns the template as GET shows it", async () => {
  const { env } = await voiceEnv();
  await voice(env);
  assert.equal((await approve(env, 2, undefined, new Date("2026-10-19T09:00:00Z"))).status, 200);
  assert.equal(template(env.DB, 2).status, "approved");

  const text = "{greeting}\r\n\r\nFor {business}: {demo_link}";
  const res = await put(env, 2, { body: text });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    template: {
      step: 2, day_offset: 2, body: "{greeting}\n\nFor {business}: {demo_link}", status: "draft", approved_at: null,
      issues: [], preview: "Hi Mark,\n\nFor Green Leaf Landscapes: https://aetoswebsites.com/d/green-leaf-landscapes",
    },
  });
  assert.deepEqual(template(env.DB, 2), { body: "{greeting}\n\nFor {business}: {demo_link}", status: "draft", approved_at: null });
  assert.equal(template(env.DB, 1).body, DRAFTS[1]);                    // the others are left alone

  // Saving the same text again still makes it a draft (any save does), and a failing text is saved with its issues.
  await approve(env, 2);
  await put(env, 2, { body: "{greeting}\n\nFor {business}: {demo_link}" });
  assert.equal(template(env.DB, 2).status, "draft");
  const failing = await (await put(env, 2, { body: "{greeting}\n\nBetter SEO" })).json();
  assert.deepEqual(failing.template.issues, [SEO]);
  assert.equal(failing.template.status, "draft");
});

test("PUT works before the templates are seeded and keeps the step's day", async () => {
  const { env } = await voiceEnv();
  const res = await put(env, 9, { body: DRAFTS[9] });
  assert.equal(res.status, 200);
  assert.deepEqual(one(env.DB, "SELECT step, day_offset, status FROM followup_templates"), { step: 9, day_offset: 60, status: "draft" });
});

test("PUT and approve refuse a step that isn't 1 to 9, and PUT a body that isn't text or is too long", async () => {
  const { env } = await voiceEnv();
  for (const step of ["0", "10", "x", "1.5", " 1", "", "01"]) {
    const p = await putFollowup(ctx(env, "/api/voice/followups/x", { method: "PUT", body: { body: DRAFTS[1] }, params: { step } }));
    assert.equal(p.status, 404, `PUT ${JSON.stringify(step)}`);
    assert.equal((await p.json()).error, NO_STEP);
    const a = await approveFollowup(ctx(env, "/api/voice/followups/x/approve", { method: "POST", params: { step } }));
    assert.equal(a.status, 404, `approve ${JSON.stringify(step)}`);
    assert.equal((await a.json()).error, NO_STEP);
  }
  for (const body of [{}, { body: 5 }, { body: null }, "nope", [DRAFTS[1]]]) {
    const r = await put(env, 1, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).error, "The follow-up's text didn't arrive. Refresh the page and try again.");
  }
  const long = await put(env, 1, { body: `{greeting}\n\n${"x".repeat(2000)}` });
  assert.equal(long.status, 400);
  assert.equal((await long.json()).error, "Too long: 2,012 characters. Keep it to 2,000.");
  assert.equal(one(env.DB, "SELECT COUNT(*) AS n FROM followup_templates").n, 0);
});

// ---------------------------------------------------------------- POST /api/voice/followups/:step/approve

test("approve returns the template and the count, and keeps the first approval date", async () => {
  const { env } = await voiceEnv();
  const res = await approve(env, 5, undefined, new Date("2026-10-19T09:00:00Z"));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.approved, 1);
  assert.equal(out.all, false);
  assert.equal(out.template.step, 5);
  assert.equal(out.template.status, "approved");
  assert.equal(out.template.approved_at, "2026-10-19T09:00:00Z");
  assert.deepEqual(out.template.issues, []);
  assert.ok(out.template.preview.startsWith("Hi Mark,\n\nThe point of the new site is more calls."));
  assert.equal(one(env.DB, "SELECT COUNT(*) AS n FROM followup_templates").n, 9); // seeded on the way

  // Approving it again changes nothing: "Approved 19 Oct" stays true.
  await approve(env, 5, undefined, new Date("2026-10-21T09:00:00Z"));
  assert.equal(template(env.DB, 5).approved_at, "2026-10-19T09:00:00Z");
  // After an edit, approving again is a new approval.
  await put(env, 5, { body: DRAFTS[5] });
  await approve(env, 5, undefined, new Date("2026-10-22T09:00:00Z"));
  assert.equal(template(env.DB, 5).approved_at, "2026-10-22T09:00:00Z");
  // Not all 9 approved, so the setup todo stays open.
  assert.equal(one(env.DB, "SELECT status FROM todos WHERE dedupe = 'setup:followups'").status, "open");
});

test("approve gives every issue, the first as the error", async () => {
  const { env } = await voiceEnv();
  await put(env, 1, { body: "{greeting}\n\nBetter SEO for £249? Really?" });
  const r = await approve(env, 1);
  assert.equal(r.status, 400);
  const out = await r.json();
  assert.equal(out.error, SEO);
  assert.deepEqual(out.issues, [SEO, "No prices in follow-ups: they change at weekends.", "One question at most."]);
});

test("approve refuses when the text changed since the page showed it", async () => {
  const { env } = await voiceEnv();
  await put(env, 3, { body: DRAFTS[3] });
  // The page sends the text Nik is looking at; another tab saved a different one since.
  await put(env, 3, { body: DRAFTS[3].replace("phones first", "phones") });
  const r = await approve(env, 3, { body: DRAFTS[3] });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, CHANGED);
  assert.equal(template(env.DB, 3).status, "draft");
  // The text he sees is the stored one: approved (line endings as a browser may send them don't matter).
  const ok = await approve(env, 3, { body: DRAFTS[3].replace("phones first", "phones").replace(/\n/g, "\r\n") });
  assert.equal(ok.status, 200);
  assert.equal(template(env.DB, 3).status, "approved");
});

test("approve refuses an edit Nik hasn't saved, and the 409 says to press Save", async () => {
  const { env } = await voiceEnv();
  await voice(env);
  // He changed the box but didn't press Save: the page sends what he sees, which isn't what's stored.
  const r = await approve(env, 6, { body: `${DRAFTS[6]}\n\nCheers.` });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /Press Save first/);
  assert.deepEqual(template(env.DB, 6), { body: DRAFTS[6], status: "draft", approved_at: null });
  // The text he sees is the saved one, but it fails the checks: the checks answer, not the 409.
  await put(env, 6, { body: "{greeting}\n\nBetter SEO" });
  const failing = await approve(env, 6, { body: "{greeting}\n\nBetter SEO" });
  assert.equal(failing.status, 400);
  assert.deepEqual(await failing.json(), { error: SEO, issues: [SEO] });
});

test("approve only approves the text it checked: a save landing in between gets the 409", async () => {
  const { env } = await voiceEnv();
  await voice(env);
  const edited = "{greeting}\n\nAnother tab's words for {business}.";
  // Another tab saves (a valid text) after this approval has read and checked the old one, before it writes.
  const racing = {
    raw: env.DB.raw,
    batch: (stmts) => env.DB.batch(stmts),
    prepare: (sql) => {
      if (/^UPDATE followup_templates SET status = 'approved'/.test(sql)) {
        env.DB.raw.prepare("UPDATE followup_templates SET body = ?, status = 'draft', approved_at = NULL WHERE step = 2")
          .run(edited);
      }
      return env.DB.prepare(sql);
    },
  };
  const r = await approve({ DB: racing }, 2);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, CHANGED);
  // Nothing was approved: the other tab's text is there, a draft, for Nik to read before approving.
  assert.deepEqual(template(env.DB, 2), { body: edited, status: "draft", approved_at: null });
  assert.deepEqual(await followupsApproved(env.DB), { approved: 0, all: false });
  assert.equal(one(env.DB, "SELECT status FROM todos WHERE dedupe = 'setup:followups'").status, "open");
});

test("all 9 approved: the todo closes once, and a later approval doesn't fail", async () => {
  const { env } = await voiceEnv();
  for (let s = 1; s <= 8; s++) await approve(env, s);
  assert.equal(one(env.DB, "SELECT status FROM todos WHERE dedupe = 'setup:followups'").status, "open");
  const last = await (await approve(env, 9)).json();
  assert.equal(last.approved, 9);
  assert.equal(last.all, true);
  assert.equal(rows(env.DB, "SELECT status FROM todos").map((t) => t.status).join(), "done");
  assert.equal((await approve(env, 9)).status, 200);
  assert.deepEqual(await followupsApproved(env.DB), { approved: 9, all: true });
});

// ---------------------------------------------------------------- DELETE /api/voice/examples/:id

test("DELETE of one that isn't there says so", async () => {
  const { env } = await voiceEnv();
  for (const id of ["nope", ""]) {
    const r = await remove(env, id);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, "That one isn't there any more. Refresh the page.");
  }
});

test("DELETE finds an id whether or not Pages decoded it", async () => {
  const { env } = await voiceEnv();
  env.DB.raw.prepare("INSERT INTO style_examples (id, kind, situation, body, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("sent:abc", "example", "first email", "Hi", "nik_sent", "2026-10-20T09:00:00Z");
  const r = await deleteExample(ctx(env, "/api/voice/examples/sent%3Aabc", { method: "DELETE", params: { id: "sent%3Aabc" } }));
  assert.equal(r.status, 200);
  assert.equal(one(env.DB, "SELECT COUNT(*) AS n FROM style_examples").n, 0);
});

// ---------------------------------------------------------------- behind the login

test("every /api/voice route is behind the login", async () => {
  const { env } = await voiceEnv();
  const routes = [["GET", "/api/voice"], ["PUT", "/api/voice/followups/1"], ["POST", "/api/voice/followups/1/approve"],
    ["POST", "/api/voice/examples"], ["DELETE", "/api/voice/examples/abc"]];
  for (const [method, path] of routes) {
    const res = await gate({
      request: new Request(`https://control-room.pages.dev${path}`, { method }),
      env: { ...env, CONTROL_ROOM_PASSWORD: "correct horse battery staple" },
      next: () => assert.fail(`${method} ${path} reached its function without a login`),
    });
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: "Not logged in" }, `${method} ${path}`);
  }
});
