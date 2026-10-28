// The tick's calls step (stage 8): release offers, today's calls, ask for outcomes.
// Run: node --test control-room/tests/calls-step.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { confirmCall, holdSlot, runCallsStep } from "../functions/_lib/calls-db.js";
import { STEPS } from "../functions/_lib/tick.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const D = (s) => new Date(s);
const EARLIER = "2026-10-19T07:01:03Z";
const one = (DB, sql, ...args) => DB.prepare(sql).bind(...args).first();
const all = async (DB, sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results;

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

// Two replied prospects: a (Mark, Diamond Kickboxing) and b (Sam, Smith Roofing).
async function seeded(extra = []) {
  const DB = fakeD1();
  for (const [placeId, name, phone, greet] of [
    ["a", "DIAMOND KICKBOXING LTD", "07969 770905", "Mark"],
    ["b", "Smith Roofing", null, "Sam"],
    ...extra,
  ]) {
    await insert(DB, "leads", {
      place_id: placeId, name, trade: "martial arts", search_town: "Leeds", phone, first_seen_at: EARLIER, updated_at: EARLIER,
    });
    await insert(DB, "prospects", {
      place_id: placeId, stage: "replied", stage_at: EARLIER, email: `${placeId}@them.co.uk`, greet_name: greet,
      created_at: EARLIER, updated_at: EARLIER,
    });
  }
  return DB;
}

// offer made Mon 19 Oct 19:00Z for Fri (b); confirmed call Tue 20 Oct 10:00Z for Mark (Diamond Kickboxing) (a)
async function planScene() {
  const DB = await seeded();
  const MON = D("2026-10-19T19:00:00Z");
  assert.equal((await holdSlot(DB, { place_id: "b", slot_at: D("2026-10-23T10:00:00Z"), now: MON })).ok, true);
  assert.equal((await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-20T10:00:00Z"), now: MON })).ok, true);
  return DB;
}

// --- Task 12, Step 1 (as written in the plan) ----------------------------------------------------------------------

test("release offers, today's calls once a day, ask for outcomes", async () => {
  const DB = await planScene();
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T05:59:00Z") }), "released 0, today 0, outcome 0");   // 06:59 UK
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T06:00:00Z") }), "released 0, today 1, outcome 0");
  assert.equal((await one(DB, "SELECT title FROM todos WHERE dedupe='calls-day:2026-10-20'")).title, "Today's calls: 11:00 Mark (Diamond Kickboxing)");
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T06:05:00Z") }), "released 0, today 0, outcome 0");   // once a day
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T10:30:00Z") }), "released 0, today 0, outcome 1");
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe LIKE 'call:%'")).status, "done");
  assert.equal((await one(DB, "SELECT title FROM todos WHERE dedupe LIKE 'call-outcome:%'")).title, "How did the call with Mark (Diamond Kickboxing) go?");
  assert.equal(await runCallsStep({ DB, now: D("2026-10-21T19:00:00Z") }), "released 1, today 0, outcome 0");
  assert.equal((await one(DB, "SELECT status FROM calls WHERE place_id='b'")).status, "cancelled");
});

// --- More cases ----------------------------------------------------------------------------------------------------

test("the Todos' kind, due time and link", async () => {
  const DB = await planScene();
  const { id } = await one(DB, "SELECT id FROM calls WHERE place_id='a'");
  await runCallsStep({ DB, now: D("2026-10-20T06:00:00Z") });
  const day = await one(DB, "SELECT * FROM todos WHERE dedupe='calls-day:2026-10-20'");
  assert.equal(day.kind, "call"); assert.equal(day.due_at, "2026-10-20T06:00:00Z");   // 07:00 UK (BST)
  assert.equal(day.link, `/#/call/${id}`); assert.equal(day.status, "open");
  await runCallsStep({ DB, now: D("2026-10-20T10:30:00Z") });
  const out = await one(DB, `SELECT * FROM todos WHERE dedupe='call-outcome:${id}'`);
  assert.equal(out.kind, "call"); assert.equal(out.due_at, "2026-10-20T10:30:00Z"); assert.equal(out.link, `/#/call/${id}`);
  assert.equal(out.place_id, "a"); assert.equal(out.status, "open");
  const closed = await one(DB, `SELECT * FROM todos WHERE dedupe='call:${id}'`);  // closed, dedupe kept (as calls-db does)
  assert.equal(closed.status, "done"); assert.equal(closed.done_at, "2026-10-20T10:30:00Z");
  assert.equal(day.status, "open");                                                   // today's list isn't closed
});

test("no outcome before slot + 30 minutes, and only one per call", async () => {
  const DB = await planScene();
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T10:29:00Z") }), "released 0, today 1, outcome 0");
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T10:35:00Z") }), "released 0, today 0, outcome 1");
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T10:40:00Z") }), "released 0, today 0, outcome 0");
  // Nik dismisses it: it never comes back while the call is still unrecorded.
  await DB.prepare("UPDATE todos SET status='dismissed' WHERE dedupe LIKE 'call-outcome:%'").run();
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T11:00:00Z") }), "released 0, today 0, outcome 0");
  assert.equal((await all(DB, "SELECT id FROM todos WHERE dedupe LIKE 'call-outcome:%'")).length, 1);
});

test("calls that aren't confirmed get no outcome Todo and aren't in today's list", async () => {
  const DB = await seeded();
  await insert(DB, "calls", { id: "x1", place_id: "a", slot_at: "2026-10-20T10:00:00Z", status: "done", note: "", created_at: EARLIER, updated_at: EARLIER });
  await insert(DB, "calls", { id: "x2", place_id: "b", slot_at: "2026-10-20T13:00:00Z", status: "cancelled", note: "", created_at: EARLIER, updated_at: EARLIER });
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T15:00:00Z") }), "released 0, today 0, outcome 0");
  assert.equal((await all(DB, "SELECT id FROM todos")).length, 0);
});

test("no calls today: no Todo", async () => {
  const DB = await seeded();
  await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-21T10:00:00Z"), now: D("2026-10-19T19:00:00Z") });
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T07:00:00Z") }), "released 0, today 0, outcome 0");
  assert.equal(await one(DB, "SELECT id FROM todos WHERE dedupe LIKE 'calls-day:%'"), null);
});

test("today's list: every confirmed call of the day in time order; a business with no name given", async () => {
  const DB = await seeded([["c", "GREEN LEAF LANDSCAPES LTD", null, null]]);
  const NOW = D("2026-10-19T19:00:00Z");
  await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-20T10:00:00Z"), now: NOW });
  await confirmCall(DB, { place_id: "c", slot_at: D("2026-10-20T15:30:00Z"), now: NOW, byNik: true });   // 16:30 UK
  await confirmCall(DB, { place_id: "b", slot_at: D("2026-10-20T08:00:00Z"), now: NOW, byNik: true });   // 09:00 UK
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T07:10:00Z") }), "released 0, today 1, outcome 0");
  assert.equal((await one(DB, "SELECT title FROM todos WHERE dedupe='calls-day:2026-10-20'")).title,
    "Today's calls: 09:00 Sam (Smith Roofing), 11:00 Mark (Diamond Kickboxing), 16:30 Green Leaf Landscapes");
});

test("GMT: 07:00 UK is 07:00Z after the clock change, and the slot is 11:00Z", async () => {
  const DB = await seeded();
  await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-27T11:00:00Z"), now: D("2026-10-26T12:00:00Z") });   // Tue, GMT
  assert.equal(await runCallsStep({ DB, now: D("2026-10-27T06:59:00Z") }), "released 0, today 0, outcome 0");
  assert.equal(await runCallsStep({ DB, now: D("2026-10-27T07:00:00Z") }), "released 0, today 1, outcome 0");
  const day = await one(DB, "SELECT * FROM todos WHERE dedupe='calls-day:2026-10-27'");
  assert.equal(day.title, "Today's calls: 11:00 Mark (Diamond Kickboxing)"); assert.equal(day.due_at, "2026-10-27T07:00:00Z");
});

test("offers: released at 48 hours or at the slot, whichever is sooner; held ones and booked ones stay", async () => {
  const DB = await seeded([["c", "Green Leaf", null, "Jo"], ["d", "Bright Spark", null, "Al"]]);
  // b: offered Mon 08:00Z for Tue 11:00 UK (slot sooner than 48 h); c: offered Mon 19:00Z for Fri; a: booked Sat.
  await holdSlot(DB, { place_id: "b", slot_at: D("2026-10-20T10:00:00Z"), now: D("2026-10-19T08:00:00Z") });
  await holdSlot(DB, { place_id: "c", slot_at: D("2026-10-23T10:00:00Z"), now: D("2026-10-19T19:00:00Z") });
  await confirmCall(DB, { place_id: "a", slot_at: D("2026-10-24T10:00:00Z"), now: D("2026-10-19T19:00:00Z") });
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T09:59:00Z") }), "released 0, today 0, outcome 0");
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T10:00:00Z") }), "released 1, today 0, outcome 0");
  assert.equal((await one(DB, "SELECT status, updated_at FROM calls WHERE place_id='b'")).updated_at, "2026-10-20T10:00:00Z");
  assert.equal((await one(DB, "SELECT status FROM calls WHERE place_id='c'")).status, "offered");
  assert.equal(await runCallsStep({ DB, now: D("2026-10-21T18:59:00Z") }), "released 0, today 0, outcome 0");
  assert.equal(await runCallsStep({ DB, now: D("2026-10-21T19:00:00Z") }), "released 1, today 0, outcome 0");
  assert.equal((await one(DB, "SELECT status FROM calls WHERE place_id='a'")).status, "confirmed");
  assert.equal((await all(DB, "SELECT id FROM todos WHERE dedupe LIKE 'call-outcome:%'")).length, 0);
});

test("reply drill calls never put Todos on Nik's board", async () => {
  const DB = await seeded([["drill:mark", "Diamond Kickboxing", null, "Mark"]]);
  await confirmCall(DB, { place_id: "drill:mark", slot_at: D("2026-10-20T10:00:00Z"), now: D("2026-10-19T19:00:00Z") });
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T07:00:00Z") }), "released 0, today 0, outcome 0");
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T11:00:00Z") }), "released 0, today 0, outcome 0");
  assert.equal((await all(DB, "SELECT id FROM todos")).length, 0);
});

test("a backlog of outcomes is worked through a few at a time, within the tick's D1 budget", async () => {
  const DB = await seeded();
  for (let i = 0; i < 5; i++) {
    await insert(DB, "calls", {
      id: `old${i}`, place_id: i % 2 ? "a" : "b", slot_at: `2026-10-0${i + 1}T10:00:00Z`, status: "confirmed", note: "",
      created_at: EARLIER, updated_at: EARLIER,
    });
  }
  let used = 0;
  const counted = new Proxy(DB, {
    get(target, prop) {
      if (prop === "prepare") return (...args) => { used++; return target.prepare(...args); };
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const budget = { left: () => 10 - used };
  assert.equal(await runCallsStep({ DB: counted, now: D("2026-10-20T05:00:00Z"), budget }), "released 0, today 0, outcome 3");
  assert.ok(used <= 9, `used ${used} D1 queries`);
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T05:05:00Z") }), "released 0, today 0, outcome 2");
  assert.equal((await all(DB, "SELECT id FROM todos WHERE dedupe LIKE 'call-outcome:%'")).length, 5);
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T05:10:00Z"), budget: { left: () => 3 } }), "released 0, today 0, outcome 0");
});

test("STEPS has calls at its marker (after stale_jobs), every 5 minutes", () => {
  const names = STEPS.map((s) => s.name);
  const i = names.indexOf("calls");
  assert.ok(i > names.indexOf("stale_jobs"));
  assert.ok(i < names.indexOf("health"));
  const step = STEPS[i];
  assert.equal(step.everyMinutes, 5); assert.equal(step.run, runCallsStep);
});

test("an earlier day's open list is closed (dedupe kept); dismissed ones and today's stay as they are", async () => {
  const DB = await planScene();
  await runCallsStep({ DB, now: D("2026-10-20T06:00:00Z") });
  await insert(DB, "todos", { id: "t-old", kind: "call", title: "Today's calls: 11:00 Jo", status: "dismissed", dedupe: "calls-day:2026-10-18", created_at: EARLIER });
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T22:59:00Z") }), "released 0, today 0, outcome 1");   // 23:59 UK
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe='calls-day:2026-10-20'")).status, "open");
  await runCallsStep({ DB, now: D("2026-10-20T23:00:00Z") });                                                    // 00:00 UK
  const day = await one(DB, "SELECT status, done_at FROM todos WHERE dedupe='calls-day:2026-10-20'");
  assert.equal(day.status, "done"); assert.equal(day.done_at, "2026-10-20T23:00:00Z");
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe='calls-day:2026-10-18'")).status, "dismissed");
  // the next morning with no calls adds nothing, and the closed list never comes back
  assert.equal(await runCallsStep({ DB, now: D("2026-10-21T06:00:00Z") }), "released 0, today 0, outcome 0");
  assert.equal((await all(DB, "SELECT id FROM todos WHERE dedupe LIKE 'calls-day:%'")).length, 2);
});

test("a run that stops part way: the next run still closes the call Todo and adds the outcome Todo", async () => {
  const DB = await planScene();
  let fail = true;
  const flaky = new Proxy(DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql) => {
          if (fail && /dedupe IN \(SELECT 'call:'/.test(sql)) { fail = false; throw new Error("killed"); }
          return target.prepare(sql);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T06:00:00Z") }), "released 0, today 1, outcome 0");
  await assert.rejects(runCallsStep({ DB: flaky, now: D("2026-10-20T10:30:00Z") }), /killed/);   // the call Todo's close
  assert.equal(fail, false);
  assert.equal(await runCallsStep({ DB, now: D("2026-10-20T10:35:00Z") }), "released 0, today 0, outcome 1");
  assert.equal((await one(DB, "SELECT status FROM todos WHERE dedupe LIKE 'call:%'")).status, "done");
  assert.equal((await all(DB, "SELECT id FROM todos WHERE dedupe LIKE 'call-outcome:%'")).length, 1);
});
