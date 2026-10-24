// The morning pick todo (stage 3, Task 6): the tick step `pick`, every 30 minutes, acting from 07:00 UK. It adds one
// todo a UK day ("8 A-grade leads ready: you can send 3 first emails today"), on the first run from 07:00 or, when that
// one had nothing to pick, on the first later run that has; keeps its numbers true on later runs, closes it when room
// or ready leads run out (never making it again that day), and closes older days' ones on the first run of a new day.
// Only while first emails can actually go (stage 0's COLD_WINDOW, Mon–Sat 07:00–19:00 UK): none on a Sunday, and from
// 19:00 today's is closed.
// Rules: docs/rebuild/04-shortlist.md Part A ("Morning pick todo") and Part B Task 6.
// Run: node --test control-room/tests/pick.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { getSetting } from "../functions/_lib/settings.js";
import { pickStep } from "../functions/_lib/shortlist-db.js";
import { STEPS, runTick } from "../functions/_lib/tick.js";
import { db } from "../functions/_lib/util.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";
import { seedDemo, seedLead, seedMailbox, seedMessage, seedProspect, seedResearch } from "./helpers/shortlistSeed.mjs";

const DETAIL = "Open Leads → Ready to email, and write each first email from the lead's panel.";
const LINK = "/#/leads?view=ready";
const READY = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
const at = (text) => new Date(text);
const run = (DB, when, extra = {}) => pickStep({ DB, env: {}, now: at(when), ...extra });

// A lead in Ready to email: done research (grade A unless given), a `ready` prospect and a live demo.
async function readyLead(DB, place_id, grade = "A", quality_score = 50) {
  await seedLead(DB, { place_id, quality_score });
  await seedResearch(DB, { place_id, grade });
  await seedProspect(DB, { place_id });
  await seedDemo(DB, { place_id, created_at: "2026-10-19T08:00:00Z" });
}

// The spec's morning: 8 A leads ready, mailbox m1 (cap 10 from 5 Sep) and 7 follow-ups queued (one each to 7 leads
// emailed last week), so today's room is 10 − 0 − 7 − 0 = 3.
async function seedMorning(DB) {
  await seedMailbox(DB);
  for (const [i, place_id] of READY.entries()) await readyLead(DB, place_id, "A", 80 - i);
  for (let i = 1; i <= 7; i++) {
    const place_id = `e${i}`;
    await seedLead(DB, { place_id });
    await seedResearch(DB, { place_id });
    await seedProspect(DB, { place_id, stage: "emailed", first_sent_at: "2026-10-13T08:00:00Z", mailbox_id: "m1" });
    await seedMessage(DB, { place_id, kind: "followup", step: 1, status: "queued", due_at: "2026-10-20T08:00:00Z" });
  }
}

// Nik's first email to `place_id` went out at `sentAt`: its prospect is emailed and the sent first email counts in
// sentToday (so one less ready lead, and one less place today).
async function emailed(DB, place_id, sentAt) {
  await DB.prepare("UPDATE prospects SET stage = 'emailed', stage_at = ?1, first_sent_at = ?1, mailbox_id = 'm1' WHERE place_id = ?2")
    .bind(sentAt, place_id)
    .run();
  await seedMessage(DB, { place_id, kind: "first", status: "sent", due_at: sentAt, sent_at: sentAt, created_at: sentAt });
}

const allTodos = async (DB) =>
  (await DB.prepare("SELECT kind, title, detail, link, place_id, due_at, status, dedupe FROM todos ORDER BY dedupe").all()).results;
const openTodos = async (DB) => (await allTodos(DB)).filter((t) => t.status === "open");
const pickTodo = (title, day, due_at) => ({
  kind: "pick", title, detail: DETAIL, link: LINK, place_id: null, due_at, status: "open", dedupe: `pick:${day}`,
});

test("BST: nothing before 07:00 UK, one todo at 07:00, its title kept true through the day, closed at room 0; then GMT", async () => {
  const DB = fakeD1();
  await seedMorning(DB);

  // 06:59 BST (Tue 20 Oct): before 07:00, nothing is read or written.
  assert.equal(await run(DB, "2026-10-20T05:59:00Z"), "before 07:00");
  assert.deepEqual(await allTodos(DB), []);
  assert.equal(await getSetting(DB, "pick:last"), null);

  // 07:00 BST = 06:00 UTC: one open todo, due 07:00 UK today.
  const first = "8 A-grade leads ready: you can send 3 first emails today";
  assert.equal(await run(DB, "2026-10-20T06:00:00Z"), first);
  assert.deepEqual(await allTodos(DB), [pickTodo(first, "2026-10-20", "2026-10-20T06:00:00Z")]);
  assert.equal(await getSetting(DB, "pick:last"), "2026-10-20");

  // Half an hour later, nothing changed: still the one todo.
  assert.equal(await run(DB, "2026-10-20T06:30:00Z"), first);
  assert.deepEqual(await allTodos(DB), [pickTodo(first, "2026-10-20", "2026-10-20T06:00:00Z")]);

  // 10:00 UK: two ready prospects were emailed (2 first emails sent) → 6 ready, room 10 − 2 − 7 = 1.
  await emailed(DB, "a1", "2026-10-20T08:30:00Z");
  await emailed(DB, "a2", "2026-10-20T08:40:00Z");
  const second = "6 A-grade leads ready: you can send 1 first email today";
  assert.equal(await run(DB, "2026-10-20T09:00:00Z"), second);
  assert.deepEqual(await allTodos(DB), [pickTodo(second, "2026-10-20", "2026-10-20T06:00:00Z")]);

  // One more the same way → room 0 → today's todo is closed (done), not left open with a false number.
  await emailed(DB, "a3", "2026-10-20T09:10:00Z");
  assert.equal(await run(DB, "2026-10-20T09:30:00Z"), "nothing to pick");
  let rows = await allTodos(DB);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].status, "open");
  assert.equal(rows[0].status, "done");
  assert.equal(rows[0].title, second);
  assert.match(rows[0].dedupe, /^pick:2026-10-20@/); // closeTodos freed the dedupe

  // A closed todo isn't reopened that day, even when room comes back (the cap raised to 20 → room 10).
  await DB.prepare("UPDATE mailboxes SET cap_override = 20 WHERE id = 'm1'").run();
  assert.equal(await run(DB, "2026-10-20T10:00:00Z"), "5 A-grade leads ready: you can send 10 first emails today");
  assert.deepEqual(await openTodos(DB), []);
  assert.equal((await allTodos(DB)).length, 1);

  // GMT (the clocks went back on Sun 25 Oct): 06:59 UTC on Mon 26 Oct is 06:59 UK, still before 07:00.
  assert.equal(await run(DB, "2026-10-26T06:59:00Z"), "before 07:00");
  assert.equal(await getSetting(DB, "pick:last"), "2026-10-20");
  assert.deepEqual(await openTodos(DB), []);

  // Re-seed today's room: the cap back to 10; nothing sent yet today (20 Oct's sends don't count) and the 7
  // follow-ups still queued → room 3, 5 A leads still ready.
  await DB.prepare("UPDATE mailboxes SET cap_override = NULL WHERE id = 'm1'").run();
  const monday = "5 A-grade leads ready: you can send 3 first emails today";
  assert.equal(await run(DB, "2026-10-26T07:00:00Z"), monday);
  rows = await allTodos(DB);
  assert.equal(rows.length, 2);
  const old = rows.find((t) => t.dedupe.startsWith("pick:2026-10-20"));
  assert.equal(old.status, "done"); // the earlier pick:2026-10-20 todo is closed
  assert.deepEqual(await openTodos(DB), [pickTodo(monday, "2026-10-26", "2026-10-26T07:00:00Z")]);
  assert.equal(await getSetting(DB, "pick:last"), "2026-10-26");
});

test("the first run of a new UK day closes an older day's pick todo that is still open (on the clock-change day)", async () => {
  const DB = fakeD1();
  await seedMorning(DB);
  const title = "8 A-grade leads ready: you can send 3 first emails today";
  // Sat 24 Oct, 07:00 BST.
  assert.equal(await run(DB, "2026-10-24T06:00:00Z"), title);
  assert.deepEqual(await openTodos(DB), [pickTodo(title, "2026-10-24", "2026-10-24T06:00:00Z")]);

  // Sun 25 Oct, the clocks went back at 01:00 UTC: 06:30 UTC is 06:30 GMT, before 07:00, so Saturday's stays open.
  assert.equal(await run(DB, "2026-10-25T06:30:00Z"), "before 07:00");
  assert.deepEqual(await openTodos(DB), [pickTodo(title, "2026-10-24", "2026-10-24T06:00:00Z")]);

  // 07:00 GMT = 07:00 UTC: Saturday's is closed. No cold email goes out on a Sunday (stage 0's COLD_WINDOW is Mon–Sat
  // 07:00–19:00 UK), so no Sunday todo says "you can send … today": nothing is left open.
  const counted = countingDB(DB);
  assert.equal(await pickStep({ DB: counted.DB, env: {}, now: at("2026-10-25T07:00:00Z") }), "no first emails go out today (Sunday)");
  assert.ok(counted.used() <= 3, `a Sunday's first run: ${counted.used()}`);
  let rows = await allTodos(DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "done");
  assert.match(rows[0].dedupe, /^pick:2026-10-24@/);
  assert.deepEqual(await openTodos(DB), []);
  assert.equal(await getSetting(DB, "pick:last"), "2026-10-25");

  // Later on Sunday: still nothing made.
  assert.equal(await run(DB, "2026-10-25T13:00:00Z"), "no first emails go out today (Sunday)");
  assert.equal((await allTodos(DB)).length, 1);
  assert.deepEqual(await openTodos(DB), []);

  // Mon 26 Oct, 07:00 GMT: the next send day's todo, due 07:00 UK.
  assert.equal(await run(DB, "2026-10-26T07:00:00Z"), title);
  rows = await allTodos(DB);
  assert.equal(rows.length, 2);
  assert.deepEqual(await openTodos(DB), [pickTodo(title, "2026-10-26", "2026-10-26T07:00:00Z")]);
});

test("from 19:00 UK the send window has shut: today's todo is closed, and none is made until the next send day", async () => {
  const DB = fakeD1();
  await seedMorning(DB);
  const title = "8 A-grade leads ready: you can send 3 first emails today";
  // Sat 24 Oct, 07:00 BST, and 18:30 BST (still inside the window): one open todo.
  assert.equal(await run(DB, "2026-10-24T06:00:00Z"), title);
  assert.equal(await run(DB, "2026-10-24T17:30:00Z"), title);
  assert.deepEqual(await openTodos(DB), [pickTodo(title, "2026-10-24", "2026-10-24T06:00:00Z")]);

  // 19:30 BST: nothing more goes out until Monday 07:00, so the todo saying "today" is closed (done).
  const counted = countingDB(DB);
  assert.equal(await pickStep({ DB: counted.DB, env: {}, now: at("2026-10-24T18:30:00Z") }), "sending has stopped for today");
  assert.ok(counted.used() <= 3, `a run after 19:00: ${counted.used()}`);
  let rows = await allTodos(DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "done");
  assert.equal(rows[0].title, title);
  assert.match(rows[0].dedupe, /^pick:2026-10-24@/);
  assert.deepEqual(await openTodos(DB), []);

  // 20:00 BST: not reopened or made again.
  assert.equal(await run(DB, "2026-10-24T19:00:00Z"), "sending has stopped for today");
  rows = await allTodos(DB);
  assert.equal(rows.length, 1);
  assert.deepEqual(await openTodos(DB), []);

  // A day whose first run from 07:00 comes after 19:00 (Fri 23 Oct, 19:30 BST) makes no todo but still closes older ones.
  const late = fakeD1();
  await seedMorning(late);
  assert.equal(await run(late, "2026-10-22T06:00:00Z"), title); // Thu 07:00 BST, left open
  const lateCount = countingDB(late);
  assert.equal(await pickStep({ DB: lateCount.DB, env: {}, now: at("2026-10-23T18:30:00Z") }), "sending has stopped for today");
  assert.ok(lateCount.used() <= 3, `a new day's first run after 19:00: ${lateCount.used()}`);
  assert.deepEqual(await openTodos(late), []);
  assert.equal((await allTodos(late)).length, 1);
  assert.equal(await getSetting(late, "pick:last"), "2026-10-23");
  // The next send day (Sat 24 Oct) makes its own at 07:00 BST.
  assert.equal(await run(late, "2026-10-24T06:00:00Z"), title);
  assert.deepEqual(await openTodos(late), [pickTodo(title, "2026-10-24", "2026-10-24T06:00:00Z")]);
});

test("a todo Nik dismissed is neither reopened nor retitled that day; the next day gets its own", async () => {
  const DB = fakeD1();
  await seedMorning(DB);
  const title = "8 A-grade leads ready: you can send 3 first emails today";
  assert.equal(await run(DB, "2026-10-20T06:00:00Z"), title);
  await DB.prepare("UPDATE todos SET status = 'dismissed' WHERE dedupe = 'pick:2026-10-20'").run();

  await emailed(DB, "a1", "2026-10-20T08:30:00Z");
  assert.equal(await run(DB, "2026-10-20T09:00:00Z"), "7 A-grade leads ready: you can send 2 first emails today");
  assert.deepEqual(await allTodos(DB), [{ ...pickTodo(title, "2026-10-20", "2026-10-20T06:00:00Z"), status: "dismissed" }]);

  // Wed 21 Oct, 07:00 BST: a new todo; the dismissed one is left as Nik left it.
  const wednesday = "7 A-grade leads ready: you can send 3 first emails today";
  assert.equal(await run(DB, "2026-10-21T06:00:00Z"), wednesday);
  assert.deepEqual(await allTodos(DB), [
    { ...pickTodo(title, "2026-10-20", "2026-10-20T06:00:00Z"), status: "dismissed" },
    pickTodo(wednesday, "2026-10-21", "2026-10-21T06:00:00Z"),
  ]);
});

test("a later run adds today's todo when the first run from 07:00 had nothing to pick (leads ready or a mailbox added later)", async () => {
  // 07:00 BST: room 3 but nothing ready yet (yesterday's all emailed; Claude's 06:47 research is still posting).
  const DB = fakeD1();
  await seedMailbox(DB);
  for (let i = 1; i <= 7; i++) {
    await seedLead(DB, { place_id: `e${i}` });
    await seedResearch(DB, { place_id: `e${i}` });
    await seedProspect(DB, { place_id: `e${i}`, stage: "emailed", first_sent_at: "2026-10-13T08:00:00Z", mailbox_id: "m1" });
    await seedMessage(DB, { place_id: `e${i}`, kind: "followup", step: 1, status: "queued", due_at: "2026-10-20T08:00:00Z" });
  }
  assert.equal(await run(DB, "2026-10-20T06:00:00Z"), "nothing to pick");
  assert.deepEqual(await allTodos(DB), []);
  assert.equal(await getSetting(DB, "pick:last"), "2026-10-20");

  // 07:20 UK: research posted, two demos made → the 07:30 run adds the day's todo, still due 07:00 UK.
  await readyLead(DB, "a1");
  await readyLead(DB, "a2");
  const title = "2 A-grade leads ready: you can send 3 first emails today";
  const counted = countingDB(DB);
  assert.equal(await pickStep({ DB: counted.DB, env: {}, now: at("2026-10-20T06:30:00Z") }), title);
  assert.ok(counted.used() <= 9, `a later run that adds the todo: ${counted.used()}`);
  assert.deepEqual(await allTodos(DB), [pickTodo(title, "2026-10-20", "2026-10-20T06:00:00Z")]);
  // The next run only keeps it true: still one todo.
  assert.equal(await run(DB, "2026-10-20T07:00:00Z"), title);
  assert.deepEqual(await allTodos(DB), [pickTodo(title, "2026-10-20", "2026-10-20T06:00:00Z")]);

  // No mailbox at 07:00 (room 0); Nik adds it at 08:10 → the 08:30 run adds the todo.
  const later = fakeD1();
  for (const place_id of READY) await readyLead(later, place_id);
  assert.equal(await run(later, "2026-10-20T06:00:00Z"), "nothing to pick");
  await seedMailbox(later);
  const eight = "8 A-grade leads ready: you can send 10 first emails today";
  assert.equal(await run(later, "2026-10-20T07:30:00Z"), eight);
  assert.deepEqual(await allTodos(later), [pickTodo(eight, "2026-10-20", "2026-10-20T06:00:00Z")]);
});

test("B leads: the title counts them when no A+/A lead is ready and B is in Ready (room > top)", async () => {
  const DB = fakeD1();
  await seedMailbox(DB);
  await readyLead(DB, "b1", "B");
  await readyLead(DB, "b2", "B");
  await readyLead(DB, "c1", "C"); // never in Ready
  const title = "2 B-grade leads ready: you can send 10 first emails today";
  assert.equal(await run(DB, "2026-10-20T06:00:00Z"), title);
  assert.deepEqual(await openTodos(DB), [pickTodo(title, "2026-10-20", "2026-10-20T06:00:00Z")]);
});

test("nothing to pick: no mailbox (room 0), or no ready leads, adds no todo", async () => {
  const noMailbox = fakeD1();
  for (const place_id of READY) await readyLead(noMailbox, place_id);
  assert.equal(await run(noMailbox, "2026-10-20T06:00:00Z"), "nothing to pick");
  assert.deepEqual(await allTodos(noMailbox), []);
  assert.equal(await getSetting(noMailbox, "pick:last"), "2026-10-20");

  const noLeads = fakeD1();
  await seedMailbox(noLeads);
  await readyLead(noLeads, "c1", "C");
  assert.equal(await run(noLeads, "2026-10-20T06:00:00Z"), "nothing to pick");
  assert.deepEqual(await allTodos(noLeads), []);
});

test("D1 budget: a fresh day costs at most 9 statements, a later run 7; with too little left it waits", async () => {
  const DB = fakeD1();
  await seedMorning(DB);
  const before = countingDB(DB);
  assert.equal(await pickStep({ DB: before.DB, env: {}, now: at("2026-10-20T05:59:00Z") }), "before 07:00");
  assert.equal(before.used(), 0);

  const fresh = countingDB(DB);
  await pickStep({ DB: fresh.DB, env: {}, now: at("2026-10-20T06:00:00Z") });
  assert.ok(fresh.used() <= 9, `fresh day: ${fresh.used()}`);
  const later = countingDB(DB);
  await pickStep({ DB: later.DB, env: {}, now: at("2026-10-20T06:30:00Z") });
  assert.ok(later.used() <= 7, `later run: ${later.used()}`);

  // Too little left after the reads for the writes and the tick's beat: nothing is written; the next run (30
  // minutes on) does it.
  const tight = fakeD1();
  await seedMorning(tight);
  const waiting = await pickStep({ DB: tight, env: {}, now: at("2026-10-20T06:00:00Z"), budget: { left: () => 4 } });
  assert.match(waiting, /next run/);
  assert.deepEqual(await allTodos(tight), []);
  assert.equal(await getSetting(tight, "pick:last"), null);
  const title = "8 A-grade leads ready: you can send 3 first emails today";
  assert.equal(await pickStep({ DB: tight, env: {}, now: at("2026-10-20T06:00:00Z"), budget: { left: () => 5 } }), title);
});

test("in a real tick: the pick step with only 10 queries left stays within 50 and the tick still beats", async () => {
  await db({ DB: fakeD1() }); // the isolate's schema check, done once, so the tick below counts only its own queries
  const raw = fakeD1();
  await seedMorning(raw);
  const counted = countingDB(raw);
  const pick = STEPS.find((s) => s.name === "pick");
  // An earlier step (inbound, say) leaves exactly 10 queries, the least the tick starts a step with.
  const earlier = { name: "inbound", everyMinutes: 0, run: async (ctx) => {
    while (ctx.budget.left() > 10) await ctx.DB.prepare("SELECT 1 AS x").first();
    return `left ${ctx.budget.left()}`;
  } };
  const now = at("2026-10-20T06:00:30Z");
  const out = await runTick({ DB: counted.DB }, "cron", now, { steps: [earlier, pick] });
  assert.equal(out.ran, true);
  assert.equal(out.steps.pick, "8 A-grade leads ready: you can send 3 first emails today");
  assert.ok(counted.used() <= 50, `the tick used ${counted.used()}`);
  const beat = await raw.prepare("SELECT last_at FROM heartbeats WHERE name = 'tick'").first();
  assert.equal(beat?.last_at, "2026-10-20T06:00:30Z");
  assert.equal((await openTodos(raw)).length, 1);
});

test("STEPS: pick every 30 minutes, directly before daily_find and after every earlier slot, running pickStep", async () => {
  const SLOTS = ["inbound", "reply_fire", "followups", "send", "hot", "pick", "daily_find", "stale_jobs", "calls", "sites", "care", "purge", "health"];
  const names = STEPS.map((s) => s.name);
  assert.ok(names.includes("pick"));
  assert.equal(names.filter((n) => n === "pick").length, 1);
  assert.equal(names[names.indexOf("daily_find") - 1], "pick");
  for (const earlier of ["inbound", "reply_fire", "followups", "send", "hot"]) {
    if (names.includes(earlier)) assert.ok(names.indexOf(earlier) < names.indexOf("pick"), `${earlier} before pick`);
  }
  if (names.includes("hot")) assert.equal(names[names.indexOf("pick") - 1], "hot");
  // Only the steps already built are present, in overview §8's order.
  const positions = names.map((n) => SLOTS.indexOf(n));
  assert.ok(positions.every((p) => p >= 0), names.join(", "));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), names.join(", "));

  const entry = STEPS.find((s) => s.name === "pick");
  assert.equal(entry.everyMinutes, 30);
  assert.equal(typeof entry.run, "function");
  // It runs pickStep with the tick's DB and now.
  const DB = fakeD1();
  await seedMorning(DB);
  assert.equal(await entry.run({ DB, env: { DB }, now: at("2026-10-20T05:59:00Z"), reason: "cron", results: {} }), "before 07:00");
  assert.equal(await entry.run({ DB, env: { DB }, now: at("2026-10-20T06:00:00Z"), reason: "cron", results: {} }),
    "8 A-grade leads ready: you can send 3 first emails today");
});
