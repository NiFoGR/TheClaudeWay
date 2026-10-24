// The tick runner (runTick), GET/POST /api/tick, and the middleware's new public paths (stage 0, Task 16; Part A
// "Tick", overview §2 and §8).
// Run: node --test control-room/tests/tick.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { onRequest } from "../functions/_middleware.js";
import { countingDB } from "../functions/_lib/d1count.js";
import { getSetting, setSetting } from "../functions/_lib/settings.js";
import { STEPS, TICK_BUDGET, runTick, tickReason } from "../functions/_lib/tick.js";
import { db } from "../functions/_lib/util.js";
import { onRequestGet, onRequestPost } from "../functions/api/tick.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

// db() creates the tables once per isolate (here, once per test process). Do it now, so no test's first tick pays
// for the schema batch and every count below is the runner's and the steps' own.
await db({ DB: fakeD1() });

const S = 1000;
const MIN = 60 * S;
const T0 = new Date("2026-10-21T10:00:00Z");
const at = (ms) => new Date(T0.getTime() + ms);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

// The 13 slots of overview §8, in order.
const SLOTS = ["inbound", "reply_fire", "followups", "send", "hot", "pick", "daily_find", "stale_jobs", "calls", "sites", "care", "purge", "health"];

const step = (name, run, everyMinutes = 0) => ({ name, everyMinutes, run });
const setup = () => {
  const DB = fakeD1();
  return { DB, env: { DB } };
};
const beatRow = (DB, name) => DB.prepare("SELECT * FROM heartbeats WHERE name = ?").bind(name).first();
// n throwaway queries through the step's (counted) DB.
async function spend(ctx, n) {
  for (let i = 0; i < n; i++) await ctx.DB.prepare("SELECT 1 AS x").first();
}

// Records the SQL of every statement run, in order (to check what the runner's last query is).
function recordingDB(DB) {
  const sqls = [];
  const originals = new WeakMap();
  const wrap = (stmt, sql) => {
    const w = {
      get statement() {
        return stmt.statement;
      },
      get params() {
        return stmt.params;
      },
      bind: (...v) => wrap(stmt.bind(...v), sql),
      first: (...a) => (sqls.push(sql), stmt.first(...a)),
      all: () => (sqls.push(sql), stmt.all()),
      run: () => (sqls.push(sql), stmt.run()),
    };
    originals.set(w, stmt);
    return w;
  };
  return {
    DB: {
      prepare: (sql) => wrap(DB.prepare(sql), sql),
      batch: (stmts) => {
        stmts.forEach((s) => sqls.push(s.statement));
        return DB.batch(stmts.map((s) => originals.get(s) ?? s));
      },
    },
    sqls,
  };
}

// ---------------------------------------------------------------- the Step 1 list

test("runs steps in order, captures errors", async () => {
  const { env } = setup();
  const order = [];
  const steps = [
    step("a", async () => (order.push("a"), "A")),
    step("b", async () => {
      order.push("b");
      throw new Error("boom");
    }),
    step("c", async () => (order.push("c"), "C")),
  ];
  const r = await runTick(env, "cron", T0, { steps });
  assert.deepEqual(r, { ran: true, steps: { a: "A", b: { error: "boom" }, c: "C" } });
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(Object.keys(r.steps), ["a", "b", "c"]);
});

test("20 s gap: a second call at now + 10 s is too_soon; at now + 21 s it runs", async () => {
  const { DB, env } = setup();
  let runs = 0;
  const steps = [step("a", async () => (runs++, "A"))];
  assert.equal((await runTick(env, "cron", T0, { steps })).ran, true);
  assert.deepEqual(await runTick(env, "cron", at(10 * S), { steps }), { ran: false, why: "too_soon" });
  assert.equal(runs, 1);
  assert.equal(await getSetting(DB, "tick:last"), iso(T0), "a turned-away call doesn't move tick:last");
  assert.equal((await beatRow(DB, "tick")).last_at, iso(T0), "nor beat");
  const r = await runTick(env, "cron", at(21 * S), { steps });
  assert.deepEqual(r, { ran: true, steps: { a: "A" } });
  assert.equal(runs, 2);
});

test("lease: tick:lock = now + 30 s makes the call locked; at now + 51 s it runs, the lease having expired", async () => {
  const { DB, env } = setup();
  let runs = 0;
  const steps = [step("a", async () => (runs++, "A"))];
  await setSetting(DB, "tick:lock", iso(at(30 * S)));
  assert.deepEqual(await runTick(env, "cron", T0, { steps }), { ran: false, why: "locked" });
  assert.equal(runs, 0);
  assert.equal(await getSetting(DB, "tick:last"), null, "tick:last is set only after the lease is taken");
  assert.equal(await beatRow(DB, "tick"), null);
  assert.deepEqual(await runTick(env, "cron", at(51 * S), { steps }), { ran: true, steps: { a: "A" } });
  assert.equal(runs, 1);
});

test("everyMinutes: a 60-minute step runs at t0 and is skipped at t0 + 30 min", async () => {
  const { DB, env } = setup();
  let hourly = 0;
  let each = 0;
  const steps = [step("hourly", async () => (hourly++, "H"), 60), step("each", async () => (each++, "E"))];
  assert.deepEqual(await runTick(env, "cron", T0, { steps }), { ran: true, steps: { hourly: "H", each: "E" } });
  assert.equal(await getSetting(DB, "tick:last:hourly"), iso(T0));
  const r = await runTick(env, "cron", at(30 * MIN), { steps }); // the 20 s rule is satisfied
  assert.deepEqual(r, { ran: true, steps: { hourly: "skipped", each: "E" } });
  assert.deepEqual([hourly, each], [1, 2]);
  assert.equal(await getSetting(DB, "tick:last:hourly"), iso(T0), "a skipped step keeps its last run time");
  assert.equal((await runTick(env, "cron", at(60 * MIN), { steps })).steps.hourly, "H");
  assert.equal(hourly, 2);
});

test("budget: a makes 40 queries, so b is deferred; a's ctx.budget.left() is 50 − the queries used so far", async () => {
  const { DB } = setup();
  const outer = countingDB(DB); // counts everything the tick does, independently of the runner
  const env = { DB: outer.DB };
  const seen = {};
  const steps = [
    step("a", async (ctx) => {
      seen.budgetType = typeof ctx.budget;
      seen.leftType = typeof ctx.budget.left();
      seen.start = [ctx.budget.left(), outer.used()];
      await spend(ctx, 40);
      seen.end = [ctx.budget.left(), outer.used()];
      return "A";
    }),
    step("b", async () => "B", 5),
  ];
  const r = await runTick(env, "cron", T0, { steps });
  assert.equal(seen.budgetType, "object", "ctx.budget is an object, never a number");
  assert.equal(seen.leftType, "number");
  assert.equal(seen.start[0], 50 - seen.start[1]);
  assert.equal(seen.end[0], 50 - seen.end[1]);
  assert.equal(seen.start[0] - seen.end[0], 40);
  assert.deepEqual(r, { ran: true, steps: { a: "A", b: "deferred" } });
  assert.equal(await getSetting(DB, "tick:last:b"), null, "a deferred step's tick:last:<step> isn't updated");
  // So it runs on the next tick.
  assert.deepEqual((await runTick(env, "cron", at(5 * MIN), { steps: [steps[1]] })).steps, { b: "B" });
  assert.equal(await getSetting(DB, "tick:last:b"), iso(at(5 * MIN)));
});

test("health on its own call", async () => {
  const { DB, env } = setup();
  const ran = [];
  let healthLeft = null;
  const steps = [
    step("a", async () => (ran.push("a"), "A")),
    step("health", async (ctx) => {
      ran.push("health");
      healthLeft = ctx.budget.left();
      return "H";
    }),
  ];
  const cron = await runTick(env, "cron", T0, { steps });
  assert.deepEqual(cron, { ran: true, steps: { a: "A" } });
  assert.ok(!("health" in cron.steps), "every other reason skips health");
  assert.deepEqual(ran, ["a"]);
  const tickBeat = await beatRow(DB, "tick");
  assert.ok(tickBeat, "a non-health tick leaves a tick heartbeat");
  assert.equal(tickBeat.last_at, iso(T0));

  // A health call at the same now still runs (its own gap key), and runs only health.
  const health = await runTick(env, "health", T0, { steps });
  assert.deepEqual(health, { ran: true, steps: { health: "H" } });
  assert.deepEqual(ran, ["a", "health"]);
  assert.ok(healthLeft >= 45, `health's budget.left() was ${healthLeft}`);

  // tick:lock held: the health call still runs. tick:health:lock held: it's locked.
  const other = setup();
  await setSetting(other.DB, "tick:lock", iso(at(30 * S)));
  assert.deepEqual(await runTick(other.env, "health", T0, { steps }), { ran: true, steps: { health: "H" } });
  const third = setup();
  await setSetting(third.DB, "tick:health:lock", iso(at(30 * S)));
  assert.deepEqual(await runTick(third.env, "health", T0, { steps }), { ran: false, why: "locked" });
  // ...while the main tick doesn't care about the health lease.
  assert.deepEqual(await runTick(third.env, "cron", T0, { steps }), { ran: true, steps: { a: "A" } });
});

test("markers: tick.js has a marker comment for each of the 13 slots, in overview §8 order", () => {
  const source = readFileSync(new URL("../functions/_lib/tick.js", import.meta.url), "utf8");
  const markers = [...source.matchAll(/^\s*\/\/ slot: ([a-z_]+)\b/gm)].map((m) => m[1]);
  assert.deepEqual(markers, SLOTS);
});

test("route hides details: ?reason=<script> gives only ok/error/skipped/deferred, and the reason passed is unknown", async () => {
  const DB = fakeD1();
  const reasons = [];
  await setSetting(DB, "tick:last:hourly", iso(new Date())); // so `hourly` is skipped
  const steps = [
    step("fine", async (ctx) => (reasons.push(ctx.reason), "sent 1 to <b>bob@x.com</b>")),
    step("broken", async () => {
      throw new Error("D1_ERROR: no such table: messages");
    }),
    step("hourly", async () => "never", 60),
    step("hog", async (ctx) => {
      await spend(ctx, ctx.budget.left() - 5);
      return "used nearly everything";
    }),
    step("late", async () => "never"),
  ];
  const request = new Request("https://control.x/api/tick?reason=%3Cscript%3Ealert(1)%3C/script%3E");
  const res = await onRequestGet({ request, env: { DB, __tickSteps: steps } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body), ["ran", "steps"]);
  assert.equal(body.ran, true);
  for (const value of Object.values(body.steps)) assert.ok(["ok", "error", "skipped", "deferred"].includes(value), value);
  assert.deepEqual(body.steps, { fine: "ok", broken: "error", hourly: "skipped", hog: "ok", late: "deferred" });
  assert.deepEqual(reasons, ["unknown"]);
  for (const detail of ["bob@x.com", "<b>", "D1_ERROR", "no such table", "script", "nearly"]) {
    assert.ok(!text.includes(detail), `the response shows "${detail}"`);
  }
  // The details go to the tick heartbeat instead.
  const { detail, ok } = await beatRow(DB, "tick");
  assert.equal(ok, 0, "a step error makes the beat ok=0");
  assert.match(detail, /broken: error: D1_ERROR: no such table: messages/);
  assert.match(detail, /fine: sent 1 to <b>bob@x.com<\/b>/);
});

test("middleware lets /api/tick through without a cookie, while /api/leads gives 401", async () => {
  const env = { CONTROL_ROOM_PASSWORD: "test-password-123", DB: fakeD1() };
  const next = async () => new Response("from next", { status: 200 });
  const res = await onRequest({ request: new Request("https://control.x/api/tick"), env, next });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "from next");
  const leads = await onRequest({ request: new Request("https://control.x/api/leads"), env, next });
  assert.equal(leads.status, 401);
});

// ---------------------------------------------------------------- more on the runner

test("TICK_BUDGET is {total: 50, minToStart: 10}", () => {
  assert.deepEqual(TICK_BUDGET, { total: 50, minToStart: 10 });
  assert.ok(Object.isFrozen(TICK_BUDGET));
});

test("STEPS: stage 0's inbound and send, in slot order, each {name, everyMinutes, run}", () => {
  const names = STEPS.map((s) => s.name);
  assert.equal(names[0], "inbound");
  assert.ok(names.includes("send"));
  // Later stages insert theirs at their markers, so the names always follow the slot order.
  const positions = names.map((n) => SLOTS.indexOf(n));
  assert.ok(positions.every((p) => p >= 0), `unknown step in ${names}`);
  assert.deepEqual(positions, [...positions].sort((x, y) => x - y), `out of order: ${names}`);
  for (const s of STEPS) {
    assert.equal(typeof s.name, "string");
    assert.equal(typeof s.everyMinutes, "number");
    assert.equal(typeof s.run, "function");
  }
  assert.equal(STEPS.find((s) => s.name === "inbound").everyMinutes, 0);
  assert.equal(STEPS.find((s) => s.name === "send").everyMinutes, 0);
});

test("ctx is {DB, env, now, reason, results, budget}: DB counted, results = the steps so far", async () => {
  const { DB, env } = setup();
  const outer = countingDB(DB);
  const seen = [];
  const record = (name, out) =>
    step(name, async (ctx) => {
      seen.push({ name, keys: Object.keys(ctx).sort(), now: ctx.now, reason: ctx.reason, results: ctx.results, left: ctx.budget.left() });
      if (name === "a") {
        await ctx.DB.prepare("SELECT 1").first(); // through ctx.DB: counted
        await ctx.env.DB.prepare("SELECT 1").first(); // through ctx.env.DB: counted too
      }
      return out;
    });
  await runTick({ ...env, DB: outer.DB, EXTRA: "kept" }, "inbound", T0, {
    steps: [record("a", "A"), step("b", async () => { throw new Error("x"); }), record("c", "C")],
  });
  assert.deepEqual(seen[0].keys, ["DB", "budget", "env", "now", "reason", "results"]);
  assert.ok(seen[0].now instanceof Date);
  assert.equal(seen[0].now.getTime(), T0.getTime());
  assert.equal(seen[0].reason, "inbound");
  assert.deepEqual(seen[0].results, {});
  assert.deepEqual(seen[1].results, { a: "A", b: { error: "x" } });
  assert.equal(seen[0].left - seen[1].left, 2, "both of a's queries were counted");
});

test("a step is started with exactly 10 left, and deferred with 9", async () => {
  for (const [leave, expected] of [[10, "B"], [9, "deferred"]]) {
    const { env } = setup();
    let leftAtB = null;
    const steps = [
      step("a", async (ctx) => {
        await spend(ctx, ctx.budget.left() - leave);
        return "A";
      }),
      step("b", async (ctx) => {
        leftAtB = ctx.budget.left();
        return "B";
      }),
    ];
    const r = await runTick(env, "cron", T0, { steps });
    assert.equal(r.steps.b, expected, `with ${leave} left`);
    if (expected === "B") assert.equal(leftAtB, 10);
  }
});

test("the tick beat is the last query, with the steps summary as its detail", async () => {
  const { DB } = setup();
  const rec = recordingDB(DB);
  const steps = [step("a", async () => "A done"), step("b", async () => "B done"), step("c", async () => "x", 60)];
  await setSetting(DB, "tick:last:c", iso(T0));
  await runTick({ DB: rec.DB }, "cron", at(MIN), { steps });
  assert.match(rec.sqls.at(-1), /^INSERT INTO heartbeats/);
  const row = await beatRow(DB, "tick");
  assert.equal(row.ok, 1);
  assert.equal(row.last_at, iso(at(MIN)));
  assert.equal(row.detail, "a: A done | b: B done | c: skipped");
});

test("a long summary puts the errors first, so the heartbeat's 500-character cut never hides one", async () => {
  const { DB, env } = setup();
  // Eleven chatty steps (as later stages will have), then one that fails last with a long error.
  const steps = [
    ...Array.from({ length: 11 }, (_, i) => step(`step_${i}`, async () => `did a fair amount of work, number ${i}`)),
    step("last", async () => {
      throw new Error(`the last step broke: ${"x".repeat(250)}`);
    }),
  ];
  const r = await runTick(env, "cron", T0, { steps });
  assert.deepEqual(Object.keys(r.steps), [...steps.map((s) => s.name)], "the result keeps run order");
  const { detail, ok } = await beatRow(DB, "tick");
  assert.equal(ok, 0);
  assert.ok(detail.startsWith("last: error: the last step broke: xxx"), detail);
  assert.ok(detail.includes("x".repeat(250)), "the whole error is kept");
  assert.ok(detail.includes("step_0: did a fair amount of work, number 0"), "then the rest, in run order");
  // Short summaries stay in run order, errors and all.
  const short = setup();
  await runTick(short.env, "cron", T0, { steps: [step("a", async () => "A"), step("b", async () => { throw new Error("boom"); })] });
  assert.equal((await beatRow(short.DB, "tick")).detail, "a: A | b: error: boom");
});

test("the health call doesn't beat tick (the health step beats health itself)", async () => {
  const { DB, env } = setup();
  const steps = [step("health", async () => "H")];
  assert.equal((await runTick(env, "health", T0, { steps })).ran, true);
  assert.equal(await beatRow(DB, "tick"), null);
  assert.equal(await getSetting(DB, "tick:health:last"), iso(T0));
  assert.equal(await getSetting(DB, "tick:last"), null, "the health call uses its own gap key");
  // Its own 20 s gap.
  assert.deepEqual(await runTick(env, "health", at(10 * S), { steps }), { ran: false, why: "too_soon" });
  assert.equal((await runTick(env, "health", at(20 * S), { steps })).ran, true, "20 s itself is not too soon");
});

test("a failing health step is logged (scrubbed), and the runner doesn't beat health or tick for it", async () => {
  const { DB, env } = setup();
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const steps = [step("health", async () => { throw new Error("lights broke near sk-ant-oat01-Zz9"); })];
    assert.deepEqual(await runTick(env, "health", T0, { steps }), { ran: true, steps: { health: { error: "lights broke near [hidden]" } } });
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, ["The tick's health step failed: lights broke near [hidden]"]);
  assert.equal(await beatRow(DB, "health"), null, "a beat would make broken health look fresh");
  assert.equal(await beatRow(DB, "tick"), null);
});

test("the health call gets the full budget even straight after a cron tick that used most of its own", async () => {
  const { env } = setup();
  let healthLeft = null;
  const steps = [
    step("hog", async (ctx) => {
      await spend(ctx, 40);
      return "hog";
    }),
    step("health", async (ctx) => {
      healthLeft = ctx.budget.left();
      return "H";
    }),
  ];
  await runTick(env, "cron", T0, { steps });
  await runTick(env, "health", T0, { steps });
  assert.ok(healthLeft >= 45, String(healthLeft));
});

test("the lease is 50 s while a tick runs, is released at the end, and blocks a call past the 20 s gap", async () => {
  const { DB, env } = setup();
  let during = null;
  let nested = null;
  const steps = [
    step("a", async (ctx) => {
      during = await getSetting(ctx.DB, "tick:lock");
      // The relay's inbound call lands 25 s into a long tick: past the gap, but the lease is held.
      nested = await runTick(env, "inbound", at(25 * S), { steps: [step("x", async () => "X")] });
      return "A";
    }),
  ];
  assert.equal((await runTick(env, "cron", T0, { steps })).ran, true);
  assert.equal(during, iso(at(50 * S)));
  assert.deepEqual(nested, { ran: false, why: "locked" });
  assert.equal(await getSetting(DB, "tick:lock"), null, "released at the end");
  assert.equal((await runTick(env, "cron", at(30 * S), { steps: [step("y", async () => "Y")] })).ran, true);
});

test("the release only removes this tick's own lease", async () => {
  const { DB, env } = setup();
  const theirs = iso(at(2 * MIN));
  const steps = [
    step("slow", async (ctx) => {
      // As if this tick outlived its lease and another tick took a new one.
      await setSetting(ctx.DB, "tick:lock", theirs);
      return "slow";
    }),
  ];
  await runTick(env, "cron", T0, { steps });
  assert.equal(await getSetting(DB, "tick:lock"), theirs);
});

test("two overlapping ticks: exactly one runs, and it's the lease that stops the other", async () => {
  const { env } = setup();
  let runs = 0;
  const steps = [step("a", async () => (runs++, "A"))];
  // Both read tick:last before either has written it, so both pass the 20 s check and race for the lease.
  const [r1, r2] = await Promise.all([runTick(env, "cron", T0, { steps }), runTick(env, "inbound", T0, { steps })]);
  assert.deepEqual([r1.ran, r2.ran].sort(), [false, true]);
  const loser = r1.ran ? r2 : r1;
  assert.deepEqual(loser, { ran: false, why: "locked" });
  assert.equal(runs, 1);
});

test("timed steps' last runs are saved in one query after the steps; skipped and deferred keep theirs", async () => {
  const { DB } = setup();
  const old = iso(at(-MIN));
  await setSetting(DB, "tick:last:skip", old);
  const c = countingDB(DB);
  const steps = [
    step("p", async () => "p", 5),
    step("boom", async () => {
      throw new Error("x");
    }, 5),
    step("skip", async () => "never", 60),
    step("q", async () => "q", 5),
  ];
  const r = await runTick({ DB: c.DB }, "cron", T0, { steps });
  assert.deepEqual(r.steps, { p: "p", boom: { error: "x" }, skip: "skipped", q: "q" });
  assert.equal(c.used(), 6, "read, lease, tick:last, the timed steps' last runs (one query), release, beat");
  for (const name of ["p", "boom", "q"]) assert.equal(await getSetting(DB, `tick:last:${name}`), iso(T0), name);
  assert.equal(await getSetting(DB, "tick:last:skip"), old);

  // A deferred timed step keeps its old time too, and a tick where no timed step ran makes no such write.
  const d = setup();
  await setSetting(d.DB, "tick:last:late", old);
  const c2 = countingDB(d.DB);
  const r2 = await runTick({ DB: c2.DB }, "cron", T0, {
    steps: [step("hog", async (ctx) => (await spend(ctx, ctx.budget.left() - 9), "hog")), step("late", async () => "never", 1)],
  });
  assert.deepEqual(r2.steps, { hog: "hog", late: "deferred" });
  assert.equal(await getSetting(d.DB, "tick:last:late"), old);
  assert.equal(c2.used(), 50 - 9 + 2, "only the release and the beat after the steps");
});

test("a step that takes every query it's given: the runner adds only the beat after it", async () => {
  const { DB } = setup();
  const c = countingDB(DB);
  let afterStep = null;
  const steps = [
    step("all", async (ctx) => {
      await spend(ctx, ctx.budget.left());
      afterStep = c.used();
      return "all";
    }, 5),
  ];
  await runTick({ DB: c.DB }, "cron", T0, { steps });
  assert.equal(afterStep, 50);
  assert.equal(c.used() - afterStep, 1, "no last-run write, no release: only the beat");
  assert.equal((await beatRow(DB, "tick")).detail, "all: all");
  assert.equal(await getSetting(DB, "tick:last:all"), null, "it simply runs again next time");
  assert.equal(await getSetting(DB, "tick:lock"), iso(at(50 * S)), "the lease lapses on its own");
});

test("a finishing query that fails is logged (scrubbed) and doesn't undo the tick", async () => {
  const { DB } = setup();
  const password = "the-control-room-password";
  // The heartbeat write fails, as if D1 refused one query too many.
  const failing = {
    prepare: (sql) => (/^INSERT INTO heartbeats/.test(sql.trim())
      ? { bind: () => ({ run: async () => { throw new Error(`D1_ERROR: too many queries (${password})`); } }) }
      : DB.prepare(sql)),
    batch: (stmts) => DB.batch(stmts),
  };
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  let r;
  try {
    r = await runTick({ DB: failing, CONTROL_ROOM_PASSWORD: password }, "cron", T0, { steps: [step("a", async () => "A")] });
  } finally {
    console.error = original;
  }
  assert.deepEqual(r, { ran: true, steps: { a: "A" } });
  assert.deepEqual(logged, ["The tick (cron) couldn't beat: D1_ERROR: too many queries ([hidden])"]);
  assert.equal(await getSetting(DB, "tick:lock"), null, "the release before it still happened");
});

test("a step is due again 30 s early (cron calls drift by a few seconds)", async () => {
  const steps = [step("five", async () => "F", 5)];
  for (const [after, expected] of [[4 * MIN + 29 * S, "skipped"], [4 * MIN + 30 * S, "F"], [4 * MIN + 59 * S, "F"]]) {
    const { env } = setup();
    await runTick(env, "cron", T0, { steps });
    assert.equal((await runTick(env, "cron", at(after), { steps })).steps.five, expected, `${after / S} s after its last run`);
  }
});

test("odd tick:last values never stop the tick for good", async () => {
  for (const value of ["garbage", iso(at(60 * MIN))]) {
    const { DB, env } = setup();
    await setSetting(DB, "tick:last", value);
    assert.equal((await runTick(env, "cron", T0, { steps: [] })).ran, true, value);
  }
});

test("a step's error text is one line, at most 300 characters, and never holds a secret", async () => {
  const { env } = setup();
  const password = "the-control-room-password";
  const steps = [
    step("long", async () => {
      throw new Error(`line one\nline two ${"z".repeat(1000)}`);
    }),
    step("leaky", async () => {
      throw new Error(`login failed for ${password} with sk-ant-oat01-AbC_d-9`);
    }),
    step("plain", async () => {
      throw "just a string";
    }),
    step("nothing", async () => undefined),
  ];
  const r = await runTick({ ...env, CONTROL_ROOM_PASSWORD: password }, "cron", T0, { steps });
  assert.ok(r.steps.long.error.length <= 300);
  assert.ok(r.steps.long.error.startsWith("line one line two z"));
  assert.equal(r.steps.leaky.error, "login failed for [hidden] with [hidden]");
  assert.deepEqual(r.steps.plain, { error: "just a string" });
  assert.equal(r.steps.nothing, "done");
  const { detail } = await beatRow(env.DB, "tick");
  assert.ok(!detail.includes(password) && !detail.includes("sk-ant-oat01"), detail);
});

test("a step that throws something with no text still becomes {error}, and the rest still run", async () => {
  const { DB, env } = setup();
  const odd = new Error("x");
  Object.defineProperty(odd, "message", {
    get() {
      throw new Error("no message for you");
    },
  });
  const steps = [
    step("nullproto", async () => {
      throw Object.create(null); // String() of this throws
    }),
    step("getter", async () => {
      throw odd;
    }),
    step("after", async () => "after"),
  ];
  const r = await runTick(env, "cron", T0, { steps });
  assert.equal(r.ran, true);
  assert.deepEqual(r.steps.nullproto, { error: "[object Object]" });
  assert.deepEqual(r.steps.getter, { error: "[object Error]" });
  assert.equal(r.steps.after, "after");
  assert.equal(await getSetting(DB, "tick:lock"), null, "the lease was still released");
  const row = await beatRow(DB, "tick");
  assert.equal(row.ok, 0);
  assert.match(row.detail, /nullproto: error: \[object Object\]/);
});

test("a step whose everyMinutes isn't a number of minutes is an error and isn't run (never every tick)", async () => {
  const { DB, env } = setup();
  let runs = 0;
  const run = async () => (runs++, "ran");
  const bad = { text: "monthly", missing: undefined, negative: -5, nan: NaN, numeric_text: "5", forever: Infinity, nothing: null };
  const steps = [...Object.entries(bad).map(([name, everyMinutes]) => ({ name, everyMinutes, run })), step("fine", async () => "fine", 5)];
  const r = await runTick(env, "cron", T0, { steps });
  assert.equal(runs, 0);
  for (const name of Object.keys(bad)) {
    assert.deepEqual(r.steps[name], { error: `The ${name} step's everyMinutes must be a number of minutes (0 = every tick), so it wasn't run.` }, name);
    assert.equal(await getSetting(DB, `tick:last:${name}`), null, name);
  }
  assert.equal(r.steps.fine, "fine");
  assert.equal(await getSetting(DB, "tick:last:fine"), iso(T0));
  // Fractions are fine: half a minute is due again 30 s early, i.e. on every tick past the 20 s gap.
  assert.equal((await runTick(setup().env, "cron", T0, { steps: [step("half", async () => "half", 0.5)] })).steps.half, "half");
});

test("tickReason keeps ^[a-z_]{1,20}$ and makes anything else unknown", () => {
  for (const ok of ["cron", "health", "inbound", "manual", "a_b", "a".repeat(20)]) assert.equal(tickReason(ok), ok);
  for (const no of ["", null, undefined, "CRON", "Health", "a".repeat(21), "cron;drop", "héalth", " cron", "cron\n", "<script>", 5]) {
    assert.equal(tickReason(no), "unknown", JSON.stringify(no));
  }
});

test("runTick cleans the reason too, and only exactly 'health' runs the health step", async () => {
  const { env } = setup();
  const reasons = [];
  const steps = [step("a", async (ctx) => (reasons.push(ctx.reason), "A")), step("health", async () => "H")];
  const r = await runTick(env, "HEALTH", T0, { steps });
  assert.deepEqual(r.steps, { a: "A" });
  assert.deepEqual(reasons, ["unknown"]);
});

test("runTick takes now as a Date or ISO text, and refuses anything else", async () => {
  const { env } = setup();
  assert.equal((await runTick(env, "cron", "2026-10-21T10:00:00Z", { steps: [] })).ran, true);
  await assert.rejects(() => runTick(setup().env, "cron", "not a time", { steps: [] }), TypeError);
  await assert.rejects(() => runTick(setup().env, "cron", 12345, { steps: [] }), TypeError);
});

test("no DB binding gives db()'s plain-English error", async () => {
  await assert.rejects(() => runTick({}, "cron", T0, { steps: [] }), /The database isn't connected/);
});

test("the runner's own cost: 1 query when too soon, 2 when locked, 5 for a tick with no steps", async () => {
  const { DB } = setup();
  const c = countingDB(DB);
  await runTick({ DB: c.DB }, "cron", T0, { steps: [] });
  assert.equal(c.used(), 5, "read, lease, tick:last, release, beat");
  const before = c.used();
  await runTick({ DB: c.DB }, "cron", at(5 * S), { steps: [] });
  assert.equal(c.used() - before, 1);
  const locked = setup();
  await setSetting(locked.DB, "tick:lock", iso(at(MIN)));
  const c2 = countingDB(locked.DB);
  await runTick({ DB: c2.DB }, "cron", T0, { steps: [] });
  assert.equal(c2.used(), 2);
});

test("with no room left for both, the lease isn't released (it lapses in 50 s) but the tick still beats", async () => {
  const { DB } = setup();
  const c = countingDB(DB);
  const steps = [
    step("all", async (ctx) => {
      await spend(ctx, ctx.budget.left() - 1);
      return "all";
    }),
  ];
  await runTick({ DB: c.DB }, "cron", T0, { steps });
  assert.equal(c.used(), 50);
  assert.equal(await getSetting(DB, "tick:lock"), iso(at(50 * S)));
  assert.equal((await beatRow(DB, "tick")).detail, "all: all");
});

test("stage 0's real steps on an empty database: inbound and send ok, within 50 queries", async () => {
  const { DB } = setup();
  const c = countingDB(DB);
  const r = await runTick({ DB: c.DB }, "cron", T0);
  assert.equal(r.ran, true);
  assert.equal(r.steps.inbound, "0 processed");
  assert.equal(r.steps.send, "sent 0, failed 0, held 0");
  assert.ok(!("health" in r.steps));
  assert.ok(c.used() <= 50, String(c.used()));
  const h = await runTick({ DB: c.DB }, "health", T0);
  assert.equal(h.ran, true);
  assert.ok(!("inbound" in h.steps) && !("send" in h.steps), JSON.stringify(h.steps));
});

// ---------------------------------------------------------------- the first tick after a schema change
// db() checks the schema once per isolate, and this process's isolate is already done (above), so each case runs in
// a fresh node process: like the first invocation after a deploy, where the tick may be the first call.
function freshProcess(body) {
  const url = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  const code = `
    import { countingDB } from ${url("../functions/_lib/d1count.js")};
    import { getSetting } from ${url("../functions/_lib/settings.js")};
    import { runTick } from ${url("../functions/_lib/tick.js")};
    import { SCHEMA_VERSION } from ${url("../functions/_lib/schema.js")};
    import { fakeD1 } from ${url("./helpers/fakeD1.mjs")};
    import { SCHEMA as OLD_SCHEMA } from ${url("../../legacy/control-room/functions/_lib/schema.js")};
    const T0 = Date.parse("2026-10-21T10:00:00Z");
    const tick = async (DB, s) => {
      const c = countingDB(DB);
      const r = await runTick({ DB: c.DB }, "cron", new Date(T0 + s * 1000));
      return { r, used: c.used(), lock: await getSetting(DB, "tick:lock"), version: (await getSetting(DB, "schema:version")) === SCHEMA_VERSION };
    };
    ${body}`;
  const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}

// Stage 0's steps ran clean, and so did every step later stages have added (e.g. daily_find): none is an {error}.
function assertStage0Steps(steps) {
  assert.deepEqual({ inbound: steps.inbound, send: steps.send }, { inbound: "0 processed", send: "sent 0, failed 0, held 0" });
  for (const [name, value] of Object.entries(steps)) assert.equal(typeof value, "string", `${name}: ${JSON.stringify(value)}`);
}

test("the first tick after a schema change only migrates (within 50 queries), holds no lease, and the next tick runs", () => {
  // The live database right after the deploy: the old system's 29 statements, no schema:version.
  const live = freshProcess(`
    const DB = fakeD1({ schema: false });
    OLD_SCHEMA.forEach((sql) => DB.raw.exec(sql));
    console.log(JSON.stringify([await tick(DB, 0), await tick(DB, 30)]));`);
  assert.deepEqual(live[0].r, { ran: false, why: "migrated" });
  assert.ok(live[0].used <= TICK_BUDGET.total, String(live[0].used));
  assert.equal(live[0].lock, null, "the lease was never taken, so it can't be left held");
  assert.equal(live[0].version, true);
  assert.equal(live[1].r.ran, true, JSON.stringify(live[1].r));
  assert.equal(live[1].r.steps.inbound, "0 processed");
  assert.equal(live[1].r.steps.send, "sent 0, failed 0, held 0");
  assert.ok(live[1].used <= TICK_BUDGET.total, String(live[1].used));

  // A brand-new database takes two migrating ticks, each within 50 queries; then the steps run.
  const empty = freshProcess(`
    const DB = fakeD1({ schema: false });
    console.log(JSON.stringify([await tick(DB, 0), await tick(DB, 30), await tick(DB, 60)]));`);
  assert.deepEqual(empty.map((t) => t.r.ran), [false, false, true], JSON.stringify(empty.map((t) => t.r)));
  assert.deepEqual(empty.slice(0, 2).map((t) => t.r.why), ["migrated", "migrated"]);
  for (const t of empty) assert.ok(t.used <= TICK_BUDGET.total, String(t.used));
  assert.deepEqual(empty.map((t) => t.version), [false, true, true]);
  assert.equal(empty[1].lock, null);
  assertStage0Steps(empty[2].r.steps);

  // Every table there but no version (e.g. the schema applied by hand): only the version is written (2 queries),
  // and that tick runs its steps within the budget.
  const versionOnly = freshProcess(`
    const DB = fakeD1();
    console.log(JSON.stringify([await tick(DB, 0)]));`);
  assert.equal(versionOnly[0].r.ran, true, JSON.stringify(versionOnly[0].r));
  assertStage0Steps(versionOnly[0].r.steps);
  assert.ok(versionOnly[0].used <= TICK_BUDGET.total, String(versionOnly[0].used));
  assert.equal(versionOnly[0].version, true);
  assert.equal(versionOnly[0].lock, null, "released");
});

// ---------------------------------------------------------------- the route

const tickRequest = (query, init) => new Request(`https://control.x/api/tick${query}`, init);

test("POST works the same, reads only ?reason (not the body), and a second call is too_soon", async () => {
  const DB = fakeD1();
  const reasons = [];
  const steps = [step("a", async (ctx) => (reasons.push(ctx.reason), "A")), step("health", async () => "H")];
  const env = { DB, __tickSteps: steps };
  const init = { method: "POST", body: JSON.stringify({ reason: "health" }), headers: { "content-type": "application/json" } };
  const res = await onRequestPost({ request: tickRequest("?reason=cron", init), env });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ran: true, steps: { a: "ok" } });
  assert.deepEqual(reasons, ["cron"]);
  const again = await onRequestPost({ request: tickRequest("?reason=cron", { method: "POST" }), env });
  assert.equal(again.status, 200, "the relay treats anything but 2xx as a failed call");
  assert.deepEqual(await again.json(), { ran: false, why: "too_soon" });
  // ?reason=health runs only the health step, straight after.
  const health = await onRequestGet({ request: tickRequest("?reason=health"), env });
  assert.deepEqual(await health.json(), { ran: true, steps: { health: "ok" } });
  // No ?reason at all is unknown.
  const DB2 = fakeD1();
  const seen = [];
  await onRequestGet({ request: tickRequest(""), env: { DB: DB2, __tickSteps: [step("a", async (ctx) => (seen.push(ctx.reason), "A"))] } });
  assert.deepEqual(seen, ["unknown"]);
});

test("the route uses the real STEPS unless a test passes env.__tickSteps", async () => {
  const res = await onRequestGet({ request: tickRequest("?reason=manual"), env: { DB: fakeD1() } });
  const body = await res.json();
  assert.equal(body.ran, true);
  assert.equal(body.steps.inbound, "ok");
  assert.equal(body.steps.send, "ok");
});

test("a tick that can't run at all is a 500 with no details (they go to the log)", async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const res = await onRequestGet({ request: tickRequest("?reason=cron"), env: {} });
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { ran: false, why: "error" });
    assert.ok(!text.includes("database"));
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((line) => line.includes("The database isn't connected")), logged.join("\n"));
});

test("the route's log line never holds a secret", async () => {
  const password = "the-control-room-password";
  const DB = {
    prepare: () => {
      throw new Error(`D1_ERROR: auth failed for ${password} near sk-ant-oat01-Secret_9`);
    },
    batch: async () => [],
  };
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  let res;
  try {
    res = await onRequestPost({ request: tickRequest("?reason=cron", { method: "POST" }), env: { DB, CONTROL_ROOM_PASSWORD: password } });
  } finally {
    console.error = original;
  }
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ran: false, why: "error" });
  assert.deepEqual(logged, ["The tick (cron) couldn't run: D1_ERROR: auth failed for [hidden] near [hidden]"]);
});

// ---------------------------------------------------------------- the middleware

test("middleware: /api/tick (GET and POST), /onboard/* and /s/* are public; the rest is unchanged", async () => {
  const password = "test-password-123";
  const env = { CONTROL_ROOM_PASSWORD: password, DB: fakeD1() };
  const next = async () => new Response("from next", { status: 200 });
  const call = (path, init) => onRequest({ request: new Request(`https://control.x${path}`, init), env, next });

  for (const path of ["/api/tick", "/api/tick?reason=cron", "/onboard/abc123", "/onboard/abc/submit", "/s/f/0123", "/s/chat.js"]) {
    const res = await call(path);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), "from next", path);
  }
  assert.equal((await call("/api/tick?reason=cron", { method: "POST" })).status, 200);
  // Near misses still need the login.
  for (const path of ["/api/ticks", "/api/tick/x", "/api/leads", "/api/setup"]) assert.equal((await call(path)).status, 401, path);
  for (const path of ["/onboard", "/onboardx", "/s", "/sx/y", "/"]) {
    const res = await call(path);
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.get("location"), "/login", path);
  }
  // Unchanged: demo sites, the agent API (checks its own token), the login page and a logged-in request.
  for (const path of ["/d/abc", "/api/agent/heartbeat", "/login", "/style.css", "/api/stripe/webhook"]) {
    assert.equal((await call(path)).status, 200, path);
  }
  const cookie = `cr_session=${createHmac("sha256", password).update("goldbar-control-room-session").digest("hex")}`;
  assert.equal((await call("/api/leads", { headers: { cookie } })).status, 200);
  // Unchanged: no password set is still a 500, for /api/tick too.
  const none = await onRequest({ request: new Request("https://control.x/api/tick"), env: { DB: fakeD1() }, next });
  assert.equal(none.status, 500);
});
