// The tick's `hot` step (stage 4, docs/rebuild/05-demo.md Task 12, Part A §2 and §9): it keeps each lead's latest demo
// up until 180 days after the last email we sent them (syncDemoExpiry), makes up to 3 missing demos a run for leads
// that qualify (missingDemos + ensureDemo, the safety net), and raises one "Call now" todo per hot lead per UK day,
// closing it once they reply or leave emailed/viewed. At most 25 D1 statements a run.
// Run: node --test control-room/tests/demo-hot.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { approveTemplate, ensureDemo, missingDemos, syncDemoExpiry } from "../functions/_lib/demo-db.js";
import { TEMPLATES } from "../functions/_lib/demo/render.js";
import { hotStep, hotTitle } from "../functions/_lib/hot.js";
import { isHot } from "../functions/_lib/shortlist.js";
import { STEPS, errorText, runTick } from "../functions/_lib/tick.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { seedDemo, seedLead, seedMessage, seedProspect, seedResearch, seedSuppression } from "./helpers/shortlistSeed.mjs";

const NOW = new Date("2026-10-21T13:05:00Z"); // Wed 21 Oct 2026, 14:05 UK (BST)
const NEXT_DAY = new Date("2026-10-22T07:00:00Z"); // Thu 22 Oct, 08:00 UK
const FULL = { left: () => 50 };
const summary = (expiry, made, hot, closed) => `expiry +${expiry} · demos made ${made} · hot ${hot} · closed ${closed}`;
const run = (DB, now = NOW, budget = FULL) => hotStep({ DB, env: {}, now, budget });

const all = (DB, sql, ...args) => DB.raw.prepare(sql).all(...args).map((r) => ({ ...r }));
const one = (DB, sql, ...args) => {
  const row = DB.raw.prepare(sql).get(...args);
  return row ? { ...row } : row;
};
const count = (DB, sql, ...args) => Number(one(DB, sql, ...args).n);
const hotTodos = (DB) => all(DB, "SELECT * FROM todos WHERE kind = 'hot' ORDER BY created_at, dedupe");
const todoBy = (DB, dedupe) => one(DB, "SELECT * FROM todos WHERE dedupe = ?", dedupe);

/** A hot prospect: lead Green Leaf Landscapes Ltd (phone 0113 496 0000), viewed twice, last at 14:00 UK today. */
async function hotLead(DB, o = {}) {
  const place_id = o.place_id ?? "p1";
  await seedLead(DB, { place_id, name: "Green Leaf Landscapes Ltd", phone: "0113 496 0000", ...o.lead });
  await seedProspect(DB, {
    place_id, stage: "viewed", views: 2, last_view_at: "2026-10-21T13:00:00Z", last_inbound_at: null, ...o.prospect,
  });
  return place_id;
}

/** A lead that qualifies for a demo (Part A §1) and has none: research done, grade A, an email, no prospect. */
async function eligible(DB, place_id, o = {}) {
  await seedLead(DB, { place_id, name: `Lead ${place_id} Landscapes`, trade: "landscaper", ...o.lead });
  await seedResearch(DB, {
    place_id, grade: "A", best_email: `Owner@${place_id.toLowerCase()}.co.uk`,
    owner: { first: "Sam", full: "Sam Hill", source_url: "https://example.com", confident: true }, ...o.research,
  });
  return place_id;
}

const approveLandscaper = (DB) => approveTemplate(DB, "landscaper", TEMPLATES.landscaper.TEMPLATE.version, NOW);

// ---------------------------------------------------------------- the spec's tests (Task 12, Step 1)

test("isHot (stage 3's, the app's only one) follows the Part A §9 rule", () => {
  // isHot is imported from ../functions/_lib/shortlist.js (stage 3); these lock the Part A §9 rule it must follow
  assert.equal(isHot({ stage: "emailed", views: 2, last_view_at: "2026-10-10T10:00:00Z", last_inbound_at: null }, NOW), true);
  assert.equal(isHot({ stage: "viewed", views: 1, last_view_at: "2026-10-20T14:00:00Z", last_inbound_at: null }, NOW), true);
  assert.equal(isHot({ stage: "viewed", views: 1, last_view_at: "2026-10-20T12:00:00Z", last_inbound_at: null }, NOW), false);
  assert.equal(isHot({ stage: "replied", views: 5, last_view_at: "2026-10-21T13:00:00Z", last_inbound_at: "x" }, NOW), false);
});

test("hotTitle: 'once' for one view, '<N> times' otherwise", () => {
  assert.equal(hotTitle("Green Leaf Landscapes", 1), "Call now: Green Leaf Landscapes opened their site once");
  assert.equal(hotTitle("Green Leaf Landscapes", 3), "Call now: Green Leaf Landscapes opened their site 3 times");
  assert.equal(hotTitle("Green Leaf Landscapes", 2), "Call now: Green Leaf Landscapes opened their site 2 times");
  // a hot lead opened it at least once: never "0 times"
  for (const odd of [0, null, undefined, "x", -2]) {
    assert.equal(hotTitle("Green Leaf Landscapes", odd), "Call now: Green Leaf Landscapes opened their site once", String(odd));
  }
});

test("a hot prospect gets one todo for today, with the detail, link and due time", async () => {
  const DB = fakeD1();
  await hotLead(DB);
  assert.equal(await run(DB), summary(0, 0, 1, 0));
  const todos = hotTodos(DB);
  assert.equal(todos.length, 1);
  const t = todos[0];
  assert.equal(t.dedupe, "hot:p1:2026-10-21");
  assert.equal(t.kind, "hot");
  assert.equal(t.title, "Call now: Green Leaf Landscapes opened their site 2 times");
  assert.equal(t.detail, "Last opened Wed 14:00. Phone: 0113 496 0000. No reply yet.");
  assert.equal(t.link, "/#/lead/p1");
  assert.equal(t.place_id, "p1");
  assert.equal(t.due_at, "2026-10-21T13:05:00Z");
  assert.equal(t.status, "open");
  assert.equal(t.created_at, "2026-10-21T13:05:00Z");
});

test("running twice adds nothing; views 3 → title updated; next UK day → new todo, yesterday's closed", async () => {
  const DB = fakeD1();
  await hotLead(DB);
  await run(DB);
  const first = hotTodos(DB)[0];

  // running twice adds nothing, and costs no todo writes
  const c = countingDB(DB);
  assert.equal(await run(c.DB, new Date("2026-10-21T13:10:00Z")), summary(0, 0, 0, 0));
  assert.deepEqual(hotTodos(DB), [first]);
  assert.ok(c.used() <= 4, `an up-to-date run: ${c.used()} statements`);

  // views 3 → title (and detail) updated, same todo
  DB.raw.prepare("UPDATE prospects SET views = 3, last_view_at = '2026-10-21T13:12:00Z' WHERE place_id = 'p1'").run();
  assert.equal(await run(DB, new Date("2026-10-21T13:15:00Z")), summary(0, 0, 1, 0));
  const updated = hotTodos(DB);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, first.id);
  assert.equal(updated[0].title, "Call now: Green Leaf Landscapes opened their site 3 times");
  assert.equal(updated[0].detail, "Last opened Wed 14:12. Phone: 0113 496 0000. No reply yet.");
  assert.equal(updated[0].status, "open");

  // next UK day → a new todo, yesterday's closed (its dedupe freed, as closeTodos frees one)
  assert.equal(await run(DB, NEXT_DAY), summary(0, 0, 1, 1));
  const today = todoBy(DB, "hot:p1:2026-10-22");
  assert.equal(today.status, "open");
  assert.equal(today.title, "Call now: Green Leaf Landscapes opened their site 3 times");
  const yesterday = one(DB, "SELECT * FROM todos WHERE id = ?", first.id);
  assert.equal(yesterday.status, "done");
  assert.equal(yesterday.done_at, "2026-10-22T07:00:00Z");
  assert.ok(yesterday.dedupe.startsWith("hot:p1:2026-10-21@"), yesterday.dedupe);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE status = 'open'"), 1);
});

test("setting last_inbound_at closes it; an open todo with dedupe checkout:p1 (stage 9) stays open", async () => {
  const DB = fakeD1();
  await hotLead(DB);
  await run(DB);
  DB.raw.prepare(`INSERT INTO todos (id, kind, place_id, title, detail, status, dedupe, created_at)
    VALUES ('chk', 'hot', 'p1', 'Green Leaf Landscapes opened the payment page', '', 'open', 'checkout:p1', '2026-10-21T13:00:00Z')`).run();
  DB.raw.prepare("UPDATE prospects SET last_inbound_at = '2026-10-21T13:07:00Z' WHERE place_id = 'p1'").run();

  assert.equal(await run(DB, new Date("2026-10-21T13:10:00Z")), summary(0, 0, 0, 1));
  const closed = one(DB, "SELECT * FROM todos WHERE kind = 'hot' AND dedupe LIKE 'hot:%'");
  assert.equal(closed.status, "done");
  assert.ok(closed.dedupe.startsWith("hot:p1:2026-10-21@"), closed.dedupe);
  const checkout = todoBy(DB, "checkout:p1");
  assert.equal(checkout.status, "open", "stage 9's payment-page todo is never touched");
  assert.equal(checkout.done_at, null);
  // and nothing new is added for them while they've replied
  assert.equal(await run(DB, new Date("2026-10-21T13:15:00Z")), summary(0, 0, 0, 0));
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE status = 'open'"), 1);
});

test("a sent message on day 170 extends expires_at to sent_at + 180 days (latest demo only)", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "p1" });
  // an older demo, and the latest one: made 4 May (day 0), ending 31 Oct (day 180)
  await seedDemo(DB, { place_id: "p1", slug: "older-demo-aaaaaa", created_at: "2026-04-01T09:00:00Z", expires_at: "2026-09-28T09:00:00Z" });
  await seedDemo(DB, { place_id: "p1", slug: "latest-demo-bbbbbb", created_at: "2026-05-04T09:00:00Z", expires_at: "2026-10-31T09:00:00Z" });
  await seedMessage(DB, { place_id: "p1", status: "sent", sent_at: "2026-05-14T09:00:00Z" }); // day 10
  await seedMessage(DB, { place_id: "p1", kind: "followup", status: "sent", sent_at: "2026-10-21T09:00:00Z" }); // day 170
  // not sent by us: none of these count
  await seedMessage(DB, { place_id: "p1", kind: "followup", status: "queued", sent_at: null, due_at: "2026-10-26T09:00:00Z" });
  await seedMessage(DB, { place_id: "p1", kind: "followup", status: "failed", sent_at: null });
  await seedMessage(DB, { place_id: "p1", kind: "inbound", status: "received", received_at: "2026-10-22T09:00:00Z" });

  assert.equal(await run(DB), summary(1, 0, 0, 0));
  assert.equal(one(DB, "SELECT expires_at FROM demos WHERE slug = 'latest-demo-bbbbbb'").expires_at, "2027-04-19T09:00:00Z");
  assert.equal(one(DB, "SELECT expires_at FROM demos WHERE slug = 'older-demo-aaaaaa'").expires_at, "2026-09-28T09:00:00Z");
  // already in step: nothing to do
  assert.equal(await syncDemoExpiry(DB), 0);
});

test("50 eligible leads without demos → 3 made per run, each prospect created through applyStageEvent (stage 'ready')", async () => {
  // the deploy state first (the look not approved yet: the first demo also adds its setup todo), then approved
  for (const approved of [false, true]) await fiftyEligible(approved);
});

async function fiftyEligible(approved) {
  const DB = fakeD1();
  for (let i = 0; i < 50; i++) await eligible(DB, `e${String(i).padStart(2, "0")}`);
  if (approved) await approveLandscaper(DB); // Nik has OK'd the look, so no setup todo is added
  // record every statement, to see the prospects are made by applyStageEvent (its read, then its insert)
  const sqls = [];
  const recorded = {
    prepare: (sql) => {
      const stmt = DB.prepare(sql);
      const wrap = (s) => ({
        get statement() { return s.statement; },
        get params() { return s.params; },
        bind: (...v) => wrap(s.bind(...v)),
        first: (...a) => (sqls.push(sql), s.first(...a)),
        all: () => (sqls.push(sql), s.all()),
        run: () => (sqls.push(sql), s.run()),
        raw: () => (sqls.push(sql), s.raw()),
        _real: s,
      });
      return wrap(stmt);
    },
    batch: (stmts) => {
      for (const s of stmts) sqls.push(s._sql ?? "batch");
      return DB.batch(stmts.map((s) => s._real ?? s));
    },
  };
  assert.equal(await run(recorded), summary(0, 3, 0, 0), `approved ${approved}`);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 3, `approved ${approved}`);
  const prospects = all(DB, "SELECT * FROM prospects ORDER BY place_id");
  assert.equal(prospects.length, 3);
  for (const p of prospects) {
    assert.equal(p.stage, "ready");
    assert.equal(p.email, `owner@${p.place_id}.co.uk`);
    assert.equal(p.greet_name, "Sam");
    assert.equal(p.stage_at, "2026-10-21T13:05:00Z");
    assert.equal(p.created_at, "2026-10-21T13:05:00Z");
  }
  assert.equal(sqls.filter((s) => s === "SELECT stage, lost_reason FROM prospects WHERE place_id = ?").length, 3,
    "applyStageEvent's own read, once per new prospect");
  // each run makes 3 more, best first (grade, then score), until none are missing
  assert.equal(await run(DB, new Date("2026-10-21T13:10:00Z")), summary(0, 3, 0, 0));
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM prospects WHERE stage = 'ready'"), 6);
  assert.equal(count(DB, "SELECT COUNT(DISTINCT place_id) AS n FROM demos"), 6);
  // the setup todo once while the look waits for Nik's OK, none once it has it
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos"), approved ? 0 : 1);
  if (!approved) {
    assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = ?", `setup:demo-template:landscaper:v${TEMPLATES.landscaper.TEMPLATE.version}`), 1);
  }
}

test("budget: with 50 eligible + 20 hot leads, one run uses ≤ 25 statements (each statement in a batch counts)", async () => {
  for (const approved of [true, false]) {
    const DB = fakeD1();
    for (let i = 0; i < 50; i++) await eligible(DB, `e${String(i).padStart(2, "0")}`);
    for (let i = 0; i < 20; i++) {
      const minute = String(i).padStart(2, "0");
      await hotLead(DB, { place_id: `h${minute}`, prospect: { stage: i % 2 ? "emailed" : "viewed", last_view_at: `2026-10-21T12:${minute}:00Z` } });
    }
    if (approved) await approveLandscaper(DB);
    const c = countingDB(DB);
    const out = await hotStep({ DB: c.DB, env: {}, now: NOW, budget: { left: () => 50 } });
    assert.ok(c.used() <= 25, `approved ${approved}: ${c.used()} statements`);
    assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 3, "3 demos a run");
    if (approved) {
      assert.equal(out, summary(0, 3, 3, 0));
      assert.equal(c.used(), 25);
      // the most recent views first
      assert.deepEqual(hotTodos(DB).map((t) => t.place_id).sort(), ["h17", "h18", "h19"]);
    } else {
      // the look's first demo also adds its setup todo (one statement more): it comes out of the hot todos, so this
      // run makes 2 of them (the most recent views) and the third comes on the next run
      assert.equal(out, summary(0, 3, 2, 0));
      assert.deepEqual(hotTodos(DB).map((t) => t.place_id).sort(), ["h18", "h19"]);
      assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE kind = 'setup'"), 1);
      // and the next run, with that todo there, makes 3 demos and 3 hot todos within 25 again
      const c2 = countingDB(DB);
      const next = await hotStep({ DB: c2.DB, env: {}, now: new Date("2026-10-21T13:10:00Z"), budget: { left: () => 50 } });
      assert.equal(next, summary(0, 3, 3, 0));
      assert.ok(c2.used() <= 25, `next run: ${c2.used()} statements`);
      assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 6);
      assert.deepEqual(hotTodos(DB).map((t) => t.place_id).sort(), ["h15", "h16", "h17", "h18", "h19"]);
    }
  }
});

test("budget: { left: () => 24 } → no demos made, summary ends 'demos skipped: low budget'", async () => {
  const DB = fakeD1();
  for (let i = 0; i < 5; i++) await eligible(DB, `e${i}`);
  await hotLead(DB);
  const c = countingDB(DB);
  const out = await run(c.DB, NOW, { left: () => 24 });
  assert.ok(out.endsWith("demos skipped: low budget"), out);
  assert.equal(out, `${summary(0, 0, 1, 0)} · demos skipped: low budget`);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 0);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM prospects WHERE stage = 'ready'"), 0);
  assert.equal(hotTodos(DB).length, 1, "the hot todos still come");
  assert.ok(c.used() <= 23, String(c.used()));
});

// ---------------------------------------------------------------- more cases

test("hotStep on an empty database: the plain summary, 4 statements", async () => {
  const DB = fakeD1();
  const c = countingDB(DB);
  assert.equal(await run(c.DB), summary(0, 0, 0, 0));
  assert.equal(c.used(), 4, "sync, close, missing demos, hot select");
});

test("the dedupe is the UK date: 00:30 UK on the 22nd is the 22nd's todo", async () => {
  const DB = fakeD1();
  await hotLead(DB, { prospect: { last_view_at: "2026-10-21T23:20:00Z" } });
  await run(DB, new Date("2026-10-21T23:30:00Z")); // 00:30 BST, Thu 22 Oct
  assert.deepEqual(hotTodos(DB).map((t) => t.dedupe), ["hot:p1:2026-10-22"]);
  assert.equal(hotTodos(DB)[0].detail, "Last opened Thu 00:20. Phone: 0113 496 0000. No reply yet.");
});

test("detail: no phone, an old view (with its date), one view → 'once'", async () => {
  const DB = fakeD1();
  await hotLead(DB, { place_id: "a1", lead: { phone: null } });
  await hotLead(DB, { place_id: "a2", lead: { phone: "   " }, prospect: { views: 4, last_view_at: "2026-10-10T10:00:00Z" } });
  await hotLead(DB, { place_id: "a3", prospect: { views: 1, last_view_at: "2026-10-20T14:00:00Z" } });
  await run(DB);
  assert.equal(todoBy(DB, "hot:a1:2026-10-21").detail, "Last opened Wed 14:00. No phone number on file. No reply yet.");
  assert.equal(todoBy(DB, "hot:a2:2026-10-21").detail, "Last opened Sat 10 Oct 11:00. No phone number on file. No reply yet.");
  assert.equal(todoBy(DB, "hot:a2:2026-10-21").title, "Call now: Green Leaf Landscapes opened their site 4 times");
  assert.equal(todoBy(DB, "hot:a3:2026-10-21").title, "Call now: Green Leaf Landscapes opened their site once");
  assert.equal(todoBy(DB, "hot:a3:2026-10-21").detail, "Last opened Tue 15:00. Phone: 0113 496 0000. No reply yet.");
});

test("who is hot: only emailed/viewed, no reply, 2+ views or a view in the last 24 hours", async () => {
  const DB = fakeD1();
  await hotLead(DB, { place_id: "yes1" });
  await hotLead(DB, { place_id: "yes2", prospect: { stage: "emailed", views: 1, last_view_at: "2026-10-20T13:05:00Z" } }); // exactly 24 h
  await hotLead(DB, { place_id: "no1", prospect: { views: 1, last_view_at: "2026-10-20T13:00:00Z" } }); // 24 h 5 min
  await hotLead(DB, { place_id: "no2", prospect: { stage: "replied", views: 5 } });
  await hotLead(DB, { place_id: "no3", prospect: { stage: "ready", views: 3 } });
  await hotLead(DB, { place_id: "no4", prospect: { views: 3, last_inbound_at: "2026-10-21T10:00:00Z" } });
  await hotLead(DB, { place_id: "no5", prospect: { stage: "won", views: 3 } });
  await hotLead(DB, { place_id: "no6", prospect: { views: 0, last_view_at: null } });
  await run(DB);
  assert.deepEqual(hotTodos(DB).map((t) => t.place_id).sort(), ["yes1", "yes2"]);
});

test("max 3 a run, most recent view first; the rest come on the next run", async () => {
  const DB = fakeD1();
  for (const [id, at] of [["q1", "2026-10-21T09:00:00Z"], ["q2", "2026-10-21T12:00:00Z"], ["q3", "2026-10-21T11:00:00Z"], ["q4", "2026-10-21T13:00:00Z"]]) {
    await hotLead(DB, { place_id: id, prospect: { last_view_at: at } });
  }
  assert.equal(await run(DB), summary(0, 0, 3, 0));
  assert.deepEqual(hotTodos(DB).map((t) => t.place_id).sort(), ["q2", "q3", "q4"]);
  assert.equal(await run(DB, new Date("2026-10-21T13:10:00Z")), summary(0, 0, 1, 0));
  assert.equal(hotTodos(DB).length, 4);
});

test("a todo Nik ticked or dismissed today isn't made again, reopened or retitled; tomorrow's still comes", async () => {
  for (const status of ["done", "dismissed"]) {
    const DB = fakeD1();
    await hotLead(DB);
    await run(DB);
    // Nik ticks it (the todo keeps its dedupe, todo.js)
    DB.raw.prepare("UPDATE todos SET status = ?, done_at = '2026-10-21T13:06:00Z' WHERE dedupe = 'hot:p1:2026-10-21'").run(status);
    const ticked = todoBy(DB, "hot:p1:2026-10-21");
    DB.raw.prepare("UPDATE prospects SET views = 5, last_view_at = '2026-10-21T13:08:00Z' WHERE place_id = 'p1'").run();
    const c = countingDB(DB);
    assert.equal(await run(c.DB, new Date("2026-10-21T13:10:00Z")), summary(0, 0, 0, 0), status);
    assert.ok(c.used() <= 4, `${status}: ${c.used()}`);
    assert.deepEqual(todoBy(DB, "hot:p1:2026-10-21"), ticked, status);
    assert.equal(hotTodos(DB).length, 1, status);
    // the next UK day they're still hot: a new one
    await run(DB, NEXT_DAY);
    assert.equal(todoBy(DB, "hot:p1:2026-10-22").status, "open", status);
    assert.equal(todoBy(DB, "hot:p1:2026-10-22").title, "Call now: Green Leaf Landscapes opened their site 5 times");
    assert.deepEqual(todoBy(DB, "hot:p1:2026-10-21"), ticked, `${status}: Nik's own todo isn't closed again`);
  }
});

test("closing is exact: place_ids with _ or % never close another lead's todos, other kinds and prefixes are kept", async () => {
  const DB = fakeD1();
  await hotLead(DB, { place_id: "p_1" });
  await hotLead(DB, { place_id: "pa1" });
  await hotLead(DB, { place_id: "p%1" });
  await run(DB);
  // pa1 and p%1 cool off (one old view), p_1 stays hot
  DB.raw.prepare("UPDATE prospects SET views = 1, last_view_at = '2026-10-19T10:00:00Z' WHERE place_id IN ('pa1', 'p%1')").run();
  assert.equal(await run(DB, NEXT_DAY), summary(0, 0, 1, 1));
  assert.equal(todoBy(DB, "hot:pa1:2026-10-21").status, "open", "a cooled-off lead's todo stays until Nik ticks it");
  assert.equal(todoBy(DB, "hot:p%1:2026-10-21").status, "open");
  assert.equal(todoBy(DB, "hot:p_1:2026-10-22").status, "open");
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe LIKE 'hot:p\\_1:2026-10-21@%' ESCAPE '\\'"), 1);

  // p_1 replies: only its own todos close; pa1's, a setup todo and a hot todo keyed another way stay open
  DB.raw.prepare(`INSERT INTO todos (id, kind, place_id, title, detail, status, dedupe, created_at)
    VALUES ('s1', 'setup', 'p_1', 'Setup thing', '', 'open', 'hot:p_1:setup', '2026-10-21T13:00:00Z'),
           ('k1', 'hot', 'p_1', 'Payment page', '', 'open', 'checkout:p_1', '2026-10-21T13:00:00Z'),
           ('k2', 'hot', 'p_1', 'Old style', '', 'open', 'hot:checkout:p_1', '2026-10-21T13:00:00Z')`).run();
  DB.raw.prepare("UPDATE prospects SET stage = 'replied', last_inbound_at = '2026-10-22T07:02:00Z' WHERE place_id = 'p_1'").run();
  assert.equal(await run(DB, new Date("2026-10-22T07:05:00Z")), summary(0, 0, 0, 1));
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE status = 'open' AND substr(dedupe, 1, 8) = 'hot:p_1:'"), 1, "only the setup-kind one");
  for (const dedupe of ["hot:pa1:2026-10-21", "hot:p%1:2026-10-21", "hot:p_1:setup", "checkout:p_1", "hot:checkout:p_1"]) {
    assert.equal(todoBy(DB, dedupe).status, "open", dedupe);
  }
});

test("a prospect that leaves emailed/viewed (or is gone) gets its open hot todos closed", async () => {
  for (const change of ["UPDATE prospects SET stage = 'lost', lost_reason = 'opt_out'", "UPDATE prospects SET stage = 'call_booked'", "DELETE FROM prospects"]) {
    const DB = fakeD1();
    await hotLead(DB);
    await run(DB);
    DB.raw.prepare(`${change} WHERE place_id = 'p1'`).run();
    assert.equal(await run(DB, new Date("2026-10-21T13:10:00Z")), summary(0, 0, 0, 1), change);
    assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE status = 'open'"), 0, change);
  }
});

test("missingDemos: Part A §1 in SQL, no live demo or no prospect, prospect not yet emailed", async () => {
  const DB = fakeD1();
  await eligible(DB, "ok1"); // no demo, no prospect
  await eligible(DB, "ok2", { research: { grade: "A+" } }); // best grade first
  await eligible(DB, "ok3", { research: { grade: "B" } });
  await eligible(DB, "exp"); // ready prospect, demo expired before any email
  await seedProspect(DB, { place_id: "exp", email: "owner@exp.co.uk" });
  await seedDemo(DB, { place_id: "exp", expires_at: "2026-10-01T00:00:00Z" });
  await eligible(DB, "nopr"); // live demo but no prospect
  await seedDemo(DB, { place_id: "nopr" });
  // none of these
  await eligible(DB, "done"); // live demo and a ready prospect
  await seedProspect(DB, { place_id: "done", email: "owner@done.co.uk" });
  await seedDemo(DB, { place_id: "done" });
  await eligible(DB, "mail"); // already emailed, demo expired: never touched
  await seedProspect(DB, { place_id: "mail", stage: "emailed", email: "owner@mail.co.uk" });
  await seedDemo(DB, { place_id: "mail", expires_at: "2026-10-01T00:00:00Z" });
  await eligible(DB, "gc", { research: { grade: "C" } });
  await eligible(DB, "big", { research: { too_big: 1 } });
  await eligible(DB, "q", { research: { status: "queued" } });
  await eligible(DB, "ex", { lead: { excluded: 1, exclude_reason: "Chain" } });
  await eligible(DB, "ne", { research: { best_email: null } });
  await eligible(DB, "be", { research: { best_email: "  " } });
  for (const [id, bad] of [["m1", "owner at x.co.uk"], ["m2", "a@b@c.co.uk"], ["m3", "@x.co.uk"], ["m4", "owner@"], ["m5", "own er@x.co.uk"], ["m6", "own er@x.co.uk"]]) {
    await eligible(DB, id, { research: { best_email: bad } });
  }
  await eligible(DB, "sd");
  await seedSuppression(DB, "sd.co.uk", "domain");
  await eligible(DB, "se");
  await seedSuppression(DB, "owner@se.co.uk", "email");
  await seedLead(DB, { place_id: "nr" }); // no research at all

  assert.deepEqual(await missingDemos(DB, NOW, 10), ["ok2", "exp", "nopr", "ok1", "ok3"]);
  assert.deepEqual(await missingDemos(DB, NOW), ["ok2", "exp", "nopr"], "3 by default");
  assert.deepEqual(await missingDemos(DB, NOW, 0), []);
  // every one it gives, ensureDemo makes (so the safety net never sticks on a lead it can't make)
  for (const id of await missingDemos(DB, NOW, 10)) assert.equal((await ensureDemo(DB, id, NOW)).ok, true, id);
  assert.deepEqual(await missingDemos(DB, NOW, 10), []);
  // and every lead it leaves out is one ensureDemo refuses or has nothing to do for
  for (const id of ["gc", "big", "q", "ex", "ne", "be", "m1", "m2", "m3", "m4", "m5", "m6", "sd", "se", "nr"]) {
    assert.equal((await ensureDemo(DB, id, NOW)).ok, false, id);
  }
});

test("missingDemos runs on D1: its whitespace GLOB fits D1's 50-byte pattern limit and matches exactly JS's \\s", async () => {
  // Live D1 refuses LIKE/GLOB patterns over 50 bytes ("LIKE or GLOB pattern too complex"), and only once a row reaches
  // the GLOB: so one lead that qualifies is seeded, and fakeD1 refuses what D1 refuses.
  const DB = fakeD1();
  await eligible(DB, "p1");
  const bound = [];
  const recording = {
    prepare: (sql) => {
      const stmt = DB.prepare(sql);
      return { ...stmt, bind: (...v) => (sql.includes("GLOB") && bound.push(...v.filter((x) => typeof x === "string" && x.includes("["))), stmt.bind(...v)) };
    },
    batch: (stmts) => DB.batch(stmts),
  };
  assert.deepEqual(await missingDemos(recording, NOW), ["p1"]);
  assert.equal(bound.length, 1, "the GLOB pattern is bound once");
  const [pattern] = bound;
  assert.ok(new TextEncoder().encode(pattern).length <= 50, `${new TextEncoder().encode(pattern).length} bytes`);
  // and the tick's hot step, which runs it, works too
  assert.equal(await run(DB), summary(0, 1, 0, 0));
  // the GLOB holds exactly the characters JS's \s matches (EMAIL_RE's), so missingDemos and ensureDemo agree on them
  const glob = DB.raw.prepare("SELECT ? GLOB ? AS m");
  const differ = [];
  for (let cp = 0; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates aren't text
    const ch = String.fromCodePoint(cp);
    if ((glob.get(`a${ch}b`, pattern).m === 1) !== /\s/.test(ch)) differ.push(cp.toString(16));
  }
  for (const cp of [0x10000, 0x1f600, 0x10ffff]) {
    if (glob.get(`a${String.fromCodePoint(cp)}b`, pattern).m === 1) differ.push(cp.toString(16));
  }
  assert.deepEqual(differ, [], "code points where the GLOB and /\\s/ disagree");
});

test("expired demo of a lead not yet emailed: the safety net makes a new one (new slug)", async () => {
  const DB = fakeD1();
  await eligible(DB, "p1");
  await approveLandscaper(DB);
  const { demo } = await ensureDemo(DB, "p1", new Date("2026-04-01T10:00:00Z"));
  assert.equal(demo.expires_at, "2026-09-28T10:00:00Z");
  assert.equal(await run(DB), summary(0, 1, 0, 0));
  const demos = all(DB, "SELECT * FROM demos ORDER BY created_at");
  assert.equal(demos.length, 2);
  assert.notEqual(demos[1].slug, demo.slug);
  assert.equal(demos[1].expires_at, "2027-04-19T13:05:00Z");
  assert.equal(await run(DB, new Date("2026-10-21T13:10:00Z")), summary(0, 0, 0, 0));
});

test("syncDemoExpiry: only later, per lead, one statement, never for messages not sent", async () => {
  const DB = fakeD1();
  await seedLead(DB, { place_id: "a" });
  await seedLead(DB, { place_id: "b" });
  await seedLead(DB, { place_id: "c" });
  await seedDemo(DB, { place_id: "a", slug: "a-demo-aaaaaa", created_at: "2026-10-01T09:00:00Z", expires_at: "2027-03-30T09:00:00Z" });
  await seedDemo(DB, { place_id: "b", slug: "b-demo-bbbbbb", created_at: "2026-10-01T09:00:00Z", expires_at: "2027-12-01T00:00:00Z" });
  await seedDemo(DB, { place_id: "c", slug: "c-demo-cccccc", created_at: "2026-10-01T09:00:00Z", expires_at: "2027-03-30T09:00:00Z" });
  await seedMessage(DB, { place_id: "a", status: "sent", sent_at: "2026-10-20T08:30:00Z" });
  await seedMessage(DB, { place_id: "b", status: "sent", sent_at: "2026-10-20T08:30:00Z" }); // b already ends later
  await seedMessage(DB, { place_id: "c", status: "sending", sent_at: "2026-10-20T08:30:00Z" }); // not sent yet
  const c = countingDB(DB);
  assert.equal(await syncDemoExpiry(c.DB), 1);
  assert.equal(c.used(), 1);
  assert.equal(one(DB, "SELECT expires_at FROM demos WHERE place_id = 'a'").expires_at, "2027-04-18T08:30:00Z");
  assert.equal(one(DB, "SELECT expires_at FROM demos WHERE place_id = 'b'").expires_at, "2027-12-01T00:00:00Z");
  assert.equal(one(DB, "SELECT expires_at FROM demos WHERE place_id = 'c'").expires_at, "2027-03-30T09:00:00Z");
  // an old demo with milliseconds in its time (made by the old system) reads the same
  DB.raw.prepare("UPDATE demos SET expires_at = '2026-11-01T10:00:00.000Z' WHERE place_id = 'c'").run();
  DB.raw.prepare("UPDATE messages SET status = 'sent' WHERE place_id = 'c'").run();
  assert.equal(await syncDemoExpiry(DB), 1);
  assert.equal(one(DB, "SELECT expires_at FROM demos WHERE place_id = 'c'").expires_at, "2027-04-18T08:30:00Z");
});

test("syncDemoExpiry reads each lead's own messages (messages_place), never every sent message per demo", async () => {
  // D1 bills rows read (Workers Free: 5M a day) and this runs every 5 minutes. With no ANALYZE statistics SQLite would
  // pick messages_due (status, due_at) for `status = 'sent'` and walk every sent message of every lead for each demo.
  const DB = fakeD1();
  const sqls = [];
  const recording = { prepare: (sql) => (sqls.push(sql), DB.prepare(sql)), batch: (stmts) => DB.batch(stmts) };
  assert.equal(await syncDemoExpiry(recording), 0);
  assert.equal(sqls.length, 1);
  const plan = DB.raw.prepare(`EXPLAIN QUERY PLAN ${sqls[0]}`).all().map((r) => r.detail);
  const messages = plan.filter((d) => /\bm\b/.test(d));
  assert.ok(messages.length >= 1, plan.join("\n"));
  for (const d of messages) assert.match(d, /SEARCH m USING INDEX messages_place \(place_id=\?\)/, plan.join("\n"));
  assert.ok(!plan.some((d) => d.includes("messages_due")), plan.join("\n"));

  // and the rows it reads grow with each lead's own messages, not with demos × every sent message
  // (a counting function on the messages it reaches, on a copy of the statement)
  assert.ok(sqls[0].includes("FROM messages m\n    WHERE "), "the counting copy below finds its place");
  const reads = async (demos) => {
    const D = fakeD1();
    for (let i = 0; i < demos; i++) {
      await seedLead(D, { place_id: `l${i}` });
      await seedDemo(D, { place_id: `l${i}`, slug: `lead-${i}-demo-aaaaaa`, created_at: "2026-10-01T09:00:00Z", expires_at: "2027-03-30T09:00:00Z" });
      // sent long ago: nothing to extend, so the statement reads each demo's messages once
      for (let j = 0; j < 2; j++) await seedMessage(D, { place_id: `l${i}`, status: "sent", sent_at: "2026-09-01T09:00:00Z" });
    }
    let n = 0;
    D.raw.function("seen", { deterministic: false }, () => (n++, 1));
    D.raw.prepare(sqls[0].replaceAll("FROM messages m\n    WHERE ", "FROM messages m\n    WHERE seen() AND ")).run();
    return n;
  };
  const small = await reads(20);
  const big = await reads(80);
  assert.ok(small > 0 && small <= 20 * 2, `20 demos with 2 sent each read ${small} messages`);
  assert.ok(big <= 80 * 2, `80 demos with 2 sent each read ${big} messages: each lead's own, not every lead's (${80 * 160})`);
});

test("a demo that can't be made doesn't stop the hot todos; the step then fails with a plain-English error", async () => {
  const DB = fakeD1();
  await eligible(DB, "e1");
  await hotLead(DB);
  const failing = {
    prepare: (sql) => {
      if (!sql.startsWith("INSERT OR IGNORE INTO demos")) return DB.prepare(sql);
      const broken = { bind: () => broken, run: async () => { throw new Error("D1_ERROR: database is locked: SQLITE_BUSY"); } };
      return broken;
    },
    batch: (stmts) => DB.batch(stmts),
  };
  await assert.rejects(run(failing), (err) => {
    assert.match(err.message, /^The hot step couldn't make the demo site for 1 lead \(e1: D1_ERROR: database is locked: SQLITE_BUSY\)\. It tries again on the next run\./);
    assert.match(err.message, /expiry \+0 · demos made 0 · hot 1 · closed 0$/);
    return true;
  });
  assert.equal(hotTodos(DB).length, 1, "the hot todo was still made");

  // 3 leads with a long error: each is named, the error is cut, and what the tick keeps of it (300 characters) still
  // ends with what the step did
  const long = { ...failing, prepare: (sql) => {
    if (!sql.startsWith("INSERT OR IGNORE INTO demos")) return DB.prepare(sql);
    const broken = { bind: () => broken, run: async () => { throw new Error(`D1_ERROR: ${"the database could not do it ".repeat(20)}`); } };
    return broken;
  } };
  await eligible(DB, "ChIJN1t_tDeuEmsRUsoyG83frY4");
  await eligible(DB, "ChIJN1t_tDeuEmsRUsoyG83frY5");
  await assert.rejects(run(long, new Date("2026-10-21T13:10:00Z")), (err) => {
    const kept = errorText(err, {});
    assert.match(kept, /^The hot step couldn't make the demo site for 3 leads \(ChIJN1t_tDeuEmsRUsoyG83frY4, ChIJN1t_tDeuEmsRUsoyG83frY5, e1: D1_ERROR: the database could not do it .*…\)\. It tries again on the next run\./);
    assert.ok(kept.endsWith(`Done: ${summary(0, 0, 0, 0)}`), kept);
    assert.ok(err.message.length <= 300, String(err.message.length));
    return true;
  });
});

test("budget: with only 10 left (the least the tick starts a step with) it stays within 9 and keeps one for the beat", async () => {
  const DB = fakeD1();
  for (let i = 0; i < 5; i++) await eligible(DB, `e${i}`);
  for (let i = 0; i < 5; i++) await hotLead(DB, { place_id: `h${i}`, prospect: { last_view_at: `2026-10-21T12:0${i}:00Z` } });
  const c = countingDB(DB);
  const out = await run(c.DB, NOW, { left: () => 10 });
  assert.ok(c.used() <= 9, String(c.used()));
  assert.ok(out.endsWith(" · demos skipped: low budget"), out);
  assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 0);
  assert.ok(hotTodos(DB).length >= 1, "some hot todos still come");
});

test("budget: both looks' setup todos in one run still make 3 demos, and with 20 hot leads stay within 25", async () => {
  for (const hotLeads of [0, 20]) {
    const DB = fakeD1();
    // landscapers and other trades alternate, best score first: the first two demos each add their look's setup todo
    for (let i = 0; i < 50; i++) {
      const id = `e${String(i).padStart(2, "0")}`;
      await eligible(DB, id, { lead: { trade: i % 2 ? "landscaper" : "plumber", quality_score: 100 - i } });
    }
    for (let i = 0; i < hotLeads; i++) {
      await hotLead(DB, { place_id: `h${String(i).padStart(2, "0")}`, prospect: { last_view_at: `2026-10-21T12:${String(i).padStart(2, "0")}:00Z` } });
    }
    const c = countingDB(DB);
    const out = await run(c.DB);
    assert.ok(c.used() <= 25, `${hotLeads} hot: ${c.used()} statements`);
    assert.equal(count(DB, "SELECT COUNT(*) AS n FROM demos"), 3, `${hotLeads} hot`);
    assert.equal(count(DB, "SELECT COUNT(*) AS n FROM todos WHERE kind = 'setup'"), 2, "one setup todo per look");
    assert.equal(out, summary(0, 3, hotLeads ? 2 : 0, 0), `${hotLeads} hot`);
  }
});

test("budget: demo links that clash (a retry each) never take a run past 25", async () => {
  const realRandom = Math.random;
  try {
    for (const approved of [true, false]) {
      const DB = fakeD1();
      for (let i = 0; i < 50; i++) await eligible(DB, `e${String(i).padStart(2, "0")}`);
      for (let i = 0; i < 20; i++) {
        await hotLead(DB, { place_id: `h${String(i).padStart(2, "0")}`, prospect: { last_view_at: `2026-10-21T12:${String(i).padStart(2, "0")}:00Z` } });
      }
      if (approved) await approveLandscaper(DB);
      // every lead's first link is taken already (…-aaaaaa); its second try gets a free one
      for (let i = 0; i < 50; i++) {
        await seedDemo(DB, { place_id: "someone-else", slug: `lead-e${String(i).padStart(2, "0")}-landscapes-aaaaaa`, created_at: "2026-10-01T09:00:00Z", expires_at: "2027-03-30T09:00:00Z" });
      }
      let n = 0;
      Math.random = () => {
        const call = Math.floor(n / 6);
        const k = n++;
        return call % 2 === 0 ? 0 : ((k * 7 + call) % 31) / 31 + 0.001;
      };
      const c = countingDB(DB);
      await run(c.DB);
      Math.random = realRandom;
      assert.ok(c.used() <= 25, `approved ${approved}: ${c.used()} statements`);
      const made = all(DB, "SELECT slug FROM demos WHERE place_id <> 'someone-else'");
      assert.ok(made.every((d) => !d.slug.endsWith("-aaaaaa")), JSON.stringify(made));
      if (approved) {
        // 5 a demo (the retry): 3 demos, then the hot select and 2 todos fill the 25
        assert.equal(made.length, 3);
        assert.equal(hotTodos(DB).length, 2);
        assert.equal(c.used(), 25);
      } else {
        // the first also adds the setup todo (6): a third demo would leave room for only one hot todo, so it waits
        // for the next run and the 3 hot todos come now
        assert.equal(made.length, 2);
        assert.equal(hotTodos(DB).length, 3);
      }
    }
  } finally {
    Math.random = realRandom;
  }
});

test("tick.js runs it as `hot`, every 5 minutes, right after send and before pick", async () => {
  const names = STEPS.map((s) => s.name);
  assert.equal(names.filter((n) => n === "hot").length, 1);
  const entry = STEPS.find((s) => s.name === "hot");
  assert.equal(entry.everyMinutes, 5);
  assert.equal(typeof entry.run, "function");
  assert.equal(names[names.indexOf("pick") - 1], "hot");
  assert.ok(names.indexOf("send") < names.indexOf("hot"));
  // it runs hotStep with the tick's ctx
  const DB = fakeD1();
  await hotLead(DB);
  assert.equal(await entry.run({ DB, env: { DB }, now: NOW, reason: "cron", results: {}, budget: FULL }), summary(0, 0, 1, 0));
  // and in a real tick its summary is a string, within the tick's 50 queries
  const fresh = fakeD1();
  await hotLead(fresh);
  const c = countingDB(fresh);
  const r = await runTick({ DB: c.DB }, "cron", NOW);
  assert.equal(r.ran, true);
  assert.equal(r.steps.hot, summary(0, 0, 1, 0));
  assert.ok(c.used() <= 50, String(c.used()));
});
