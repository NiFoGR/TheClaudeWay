// Prospect stages (overview §5) and suppression. Run: node --test control-room/tests/stages.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { LOST_REASONS, OPEN_STAGES, STAGES, nextStage } from "../functions/_lib/stages.js";
import { applyStageEvent, isSuppressed, suppress } from "../functions/_lib/prospects.js";
import { countingDB } from "../functions/_lib/d1count.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const NOW = new Date("2026-10-24T12:00:00Z");
const NOW_ISO = "2026-10-24T12:00:00Z";
const EARLIER = "2026-10-20T09:00:00Z";
const LATER = "2026-10-25T09:00:00Z";

const prospect = (DB, id) => DB.prepare("SELECT * FROM prospects WHERE place_id = ?").bind(id).first();
const message = (DB, id) => DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
const count = async (DB, table) => (await DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n"));

async function insert(DB, table, row) {
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

const seedProspect = (DB, place_id, stage, extra = {}) =>
  insert(DB, "prospects", {
    place_id, stage, stage_at: EARLIER, email: `${place_id}@example.com`, greet_name: null, next_followup_at: null,
    lost_reason: null, created_at: EARLIER, updated_at: EARLIER, ...extra,
  });

const AUTHOR = { first: "nik", followup: "system", reply: "claude", system: "system" };
const seedMessage = (DB, id, place_id, kind, status = "queued", extra = {}) =>
  insert(DB, "messages", {
    id, place_id, direction: "out", kind, author: AUTHOR[kind] ?? "system", to_addr: `${place_id}@example.com`,
    subject: "Your new website", body: "Hello", status, due_at: LATER, created_at: EARLIER, ...extra,
  });

// A DB whose batch() runs `before` first, as if another request wrote in between applyStageEvent's read and write.
function racing(DB, before) {
  let calls = 0;
  return {
    ...DB,
    batch: async (stmts) => {
      await before(++calls);
      return DB.batch(stmts);
    },
  };
}

// ---------------------------------------------------------------- the stage machine (pure)

test("STAGES, OPEN_STAGES and LOST_REASONS are overview §5's lists", () => {
  assert.deepEqual([...STAGES].sort(),
    ["call_booked", "emailed", "lost", "needs_nik", "ready", "replied", "viewed", "won"]);
  assert.equal(STAGES.length, 8);
  assert.deepEqual(OPEN_STAGES, ["ready", "emailed", "viewed", "replied", "needs_nik", "call_booked"]);
  assert.deepEqual(STAGES.filter((s) => !OPEN_STAGES.includes(s)).sort(), ["lost", "won"]);
  assert.deepEqual(LOST_REASONS, ["opt_out", "bounce", "sequence_done", "not_now", "not_interested", "call"]);
});

test("the shared lists can't be changed by a caller", () => {
  assert.throws(() => STAGES.push("hot"));
  assert.throws(() => OPEN_STAGES.push("won"));
  assert.throws(() => LOST_REASONS.push("other"));
  assert.equal(nextStage("won", "escalate"), "won");
});

test("nextStage: the plan's cases", () => {
  assert.equal(nextStage("emailed", "demo_view"), "viewed");
  assert.equal(nextStage("ready", "demo_view"), "ready");
  assert.equal(nextStage("won", "opt_out"), "won");
  assert.equal(nextStage("won", "bounce"), "won");
  assert.equal(nextStage("replied", "opt_out"), "lost");
  assert.equal(nextStage("lost", "paid"), "won");
  assert.equal(nextStage(null, "paid"), "won");
  assert.equal(nextStage("lost", "reopen"), "replied");
  assert.equal(nextStage("emailed", "reopen"), "emailed");
  assert.equal(nextStage("needs_nik", "nik_handled"), "replied");
  assert.equal(nextStage("call_booked", "call_cancelled"), "replied");
  assert.equal(nextStage("ready", "call_confirmed"), "ready");
  assert.equal(nextStage("call_booked", "inbound_human"), "replied");
  assert.equal(nextStage(null, "demo_ready"), "ready");
  assert.equal(nextStage("viewed", "nonsense"), "viewed");
});

// Overview §5's event table, written out again here so the module is checked against the spec, not against itself.
const OPEN = ["ready", "emailed", "viewed", "replied", "needs_nik", "call_booked"];
const EVERY = [...OPEN, "won", "lost"];
const TABLE = {
  demo_ready: { from: [null, "ready"], to: "ready" },
  first_sent: { from: ["ready"], to: "emailed" },
  demo_view: { from: ["emailed"], to: "viewed" },
  inbound_human: { from: ["emailed", "viewed", "call_booked"], to: "replied" },
  reopen: { from: ["lost"], to: "replied" },
  escalate: { from: OPEN, to: "needs_nik" },
  nik_handled: { from: ["needs_nik"], to: "replied" },
  call_confirmed: { from: OPEN.filter((s) => s !== "ready"), to: "call_booked" },
  call_cancelled: { from: ["call_booked"], to: "replied" },
  said_no: { from: OPEN, to: "lost" },
  sequence_done: { from: OPEN, to: "lost" },
  paid: { from: [null, ...EVERY], to: "won" },
  opt_out: { from: EVERY.filter((s) => s !== "won"), to: "lost" },
  bounce: { from: EVERY.filter((s) => s !== "won"), to: "lost" },
};

test("nextStage: every event from every stage (and from no row) matches overview §5", () => {
  for (const [event, { from, to }] of Object.entries(TABLE)) {
    for (const current of [null, ...EVERY]) {
      const want = from.includes(current) ? to : current;
      assert.equal(nextStage(current, event), want, `${event} from ${current}`);
    }
  }
});

test("nextStage: anything else returns current", () => {
  for (const current of [null, ...EVERY]) {
    for (const event of ["nonsense", "", "hot", "won", "lost", "DEMO_VIEW", "__proto__", "constructor", "toString",
      "hasOwnProperty", undefined, null, 42]) {
      assert.equal(nextStage(current, event), current, `${String(event)} from ${current}`);
    }
  }
  // an unknown stage isn't moved by anything, not even paid
  assert.equal(nextStage("archived", "paid"), "archived");
  assert.equal(nextStage("archived", "opt_out"), "archived");
  // no row yet: only demo_ready and paid make one
  for (const event of Object.keys(TABLE).filter((e) => e !== "demo_ready" && e !== "paid")) {
    assert.equal(nextStage(null, event), null, event);
  }
  assert.equal(nextStage(undefined, "demo_ready"), "ready");
});

// ---------------------------------------------------------------- applyStageEvent (db)

test("opt_out: lost, follow-ups stopped, queued first/follow-up emails cancelled, lost_reason opt_out", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "emailed", { next_followup_at: LATER, followup_step: 2 });
  await seedMessage(DB, "m1", "p1", "followup");
  assert.deepEqual(await applyStageEvent(DB, "p1", "opt_out", NOW), { from: "emailed", to: "lost" });
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "lost");
  assert.equal(p.next_followup_at, null);
  assert.equal(p.lost_reason, "opt_out");
  assert.equal(p.stage_at, NOW_ISO);
  assert.equal(p.updated_at, NOW_ISO);
  assert.equal(p.created_at, EARLIER);
  assert.equal(p.followup_step, 2);
  const m = await message(DB, "m1");
  assert.equal(m.status, "cancelled");
  assert.equal(m.error, "Stopped: opt_out");
});

test("said_no stores the caller's lost_reason", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p2", "replied", { next_followup_at: LATER });
  assert.deepEqual(await applyStageEvent(DB, "p2", "said_no", NOW, { lost_reason: "not_now" }), { from: "replied", to: "lost" });
  const p = await prospect(DB, "p2");
  assert.equal(p.stage, "lost");
  assert.equal(p.lost_reason, "not_now");
  assert.equal(p.next_followup_at, null);
  for (const [id, reason] of [["p3", "not_interested"], ["p4", "call"]]) {
    await seedProspect(DB, id, "call_booked");
    await applyStageEvent(DB, id, "said_no", NOW, { lost_reason: reason });
    assert.equal((await prospect(DB, id)).lost_reason, reason);
  }
});

test("said_no without one of its three reasons is refused and changes nothing", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p2", "replied");
  for (const lost_reason of [undefined, null, "", "opt_out", "bounce", "sequence_done", "maybe"]) {
    await assert.rejects(applyStageEvent(DB, "p2", "said_no", NOW, { lost_reason }), (err) => {
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /not_now, not_interested or call/);
      return true;
    });
  }
  const p = await prospect(DB, "p2");
  assert.equal(p.stage, "replied");
  assert.equal(p.lost_reason, null);
  assert.equal(p.updated_at, EARLIER);
});

test("bounce and sequence_done set lost_reason to the event name, whatever the caller passes", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "pb", "viewed");
  await seedProspect(DB, "ps", "emailed", { next_followup_at: LATER });
  await seedMessage(DB, "mb", "pb", "followup");
  await applyStageEvent(DB, "pb", "bounce", NOW, { lost_reason: "not_now" });
  await applyStageEvent(DB, "ps", "sequence_done", NOW, { lost_reason: "sequence_done" });
  assert.equal((await prospect(DB, "pb")).lost_reason, "bounce");
  assert.equal((await message(DB, "mb")).error, "Stopped: bounce");
  const s = await prospect(DB, "ps");
  assert.equal(s.stage, "lost");
  assert.equal(s.lost_reason, "sequence_done");
  assert.equal(s.next_followup_at, null);
  // opt_out with the reply Routine's lost_reason (stage 7's intentEffects) is the same as without it
  await seedProspect(DB, "po", "replied");
  await applyStageEvent(DB, "po", "opt_out", NOW, { lost_reason: "opt_out" });
  assert.equal((await prospect(DB, "po")).lost_reason, "opt_out");
});

test("demo_ready with an email makes the prospect row; without one it does nothing", async () => {
  const DB = fakeD1();
  assert.deepEqual(await applyStageEvent(DB, "p9", "demo_ready", NOW, { email: "Al@B.com", greet_name: "Al" }),
    { from: null, to: "ready" });
  const p = await prospect(DB, "p9");
  assert.equal(p.email, "al@b.com");
  assert.equal(p.greet_name, "Al");
  assert.equal(p.stage, "ready");
  assert.equal(p.stage_at, NOW_ISO);
  assert.equal(p.created_at, NOW_ISO);
  assert.equal(p.updated_at, NOW_ISO);
  assert.equal(p.lost_reason, null);
  assert.equal(p.next_followup_at, null);
  assert.equal(p.followup_step, 0);
  assert.equal(p.views, 0);
  assert.equal(await applyStageEvent(DB, "p10", "demo_ready", NOW, { greet_name: "Al" }), null);
  assert.equal(await applyStageEvent(DB, "p10", "demo_ready", NOW), null);
  for (const email of [null, "", "   "]) {
    assert.equal(await applyStageEvent(DB, "p10", "demo_ready", NOW, { email, greet_name: "Al" }), null, String(email));
  }
  assert.equal(await prospect(DB, "p10"), null);
  assert.equal(await count(DB, "prospects"), 1);
});

test("on an existing row the email and greet_name are ignored, even ones a new row would refuse", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "viewed", { greet_name: "Mark" });
  // e.g. stage 9's paid with an odd checkout email: the payment still makes them won
  assert.deepEqual(await applyStageEvent(DB, "p1", "paid", NOW, { email: "not an email", greet_name: 42 }),
    { from: "viewed", to: "won" });
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "won");
  assert.equal(p.email, "p1@example.com");
  assert.equal(p.greet_name, "Mark");
});

test("a new row: greet_name is NULL unless given; the email is trimmed and lower-cased", async () => {
  const DB = fakeD1();
  await applyStageEvent(DB, "a", "demo_ready", NOW, { email: "  Owner@Green-Leaf.co.UK " });
  await applyStageEvent(DB, "b", "demo_ready", NOW, { email: "b@x.com", greet_name: "  " });
  await applyStageEvent(DB, "c", "demo_ready", NOW, { email: "c@x.com", greet_name: null });
  assert.equal((await prospect(DB, "a")).email, "owner@green-leaf.co.uk");
  for (const id of ["a", "b", "c"]) assert.equal((await prospect(DB, id)).greet_name, null, id);
});

test("a new row is only made by an event that starts one (demo_ready, paid)", async () => {
  const DB = fakeD1();
  for (const event of ["first_sent", "demo_view", "inbound_human", "escalate", "opt_out", "bounce", "reopen", "nonsense"]) {
    assert.equal(await applyStageEvent(DB, "px", event, NOW, { email: "x@y.com" }), null, event);
  }
  assert.equal(await count(DB, "prospects"), 0);
});

test("a bad email for a new row is refused", async () => {
  const DB = fakeD1();
  for (const email of ["not an email", "nobody", "a b@c.com", "a@b.com\r\nBcc: x@y.com", 42]) {
    await assert.rejects(applyStageEvent(DB, "px", "demo_ready", NOW, { email }), TypeError, String(email));
  }
  assert.equal(await count(DB, "prospects"), 0);
});

test("paid with no row makes a won prospect and cancels queued cold emails for the lead", async () => {
  const DB = fakeD1();
  await seedMessage(DB, "m1", "p11", "first");
  assert.deepEqual(await applyStageEvent(DB, "p11", "paid", NOW, { email: "Pay@Er.com", greet_name: null }),
    { from: null, to: "won" });
  const p = await prospect(DB, "p11");
  assert.equal(p.stage, "won");
  assert.equal(p.email, "pay@er.com");
  assert.equal(p.greet_name, null);
  assert.equal(p.lost_reason, null);
  const m = await message(DB, "m1");
  assert.equal(m.status, "cancelled");
  assert.equal(m.error, "Stopped: paid");
});

test("paid on a lost prospect: won, lost_reason cleared, cold emails stopped", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "lost", { lost_reason: "opt_out" });
  await seedMessage(DB, "m1", "p1", "followup");
  assert.deepEqual(await applyStageEvent(DB, "p1", "paid", NOW, { email: "new@address.com" }), { from: "lost", to: "won" });
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "won");
  assert.equal(p.lost_reason, null);
  assert.equal(p.email, "p1@example.com", "an existing row keeps its email");
  assert.equal((await message(DB, "m1")).status, "cancelled");
});

test("reopen: lost → replied, and lost_reason is cleared (it only describes a lost prospect)", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "lost", { lost_reason: "not_now" });
  assert.deepEqual(await applyStageEvent(DB, "p1", "reopen", NOW), { from: "lost", to: "replied" });
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "replied");
  assert.equal(p.lost_reason, null);
  assert.equal(p.stage_at, NOW_ISO);
});

test("reopen applies only after not_now, not_interested, sequence_done or call (overview §5)", async () => {
  const DB = fakeD1();
  for (const reason of ["not_now", "not_interested", "sequence_done", "call"]) {
    await seedProspect(DB, `ok-${reason}`, "lost", { lost_reason: reason });
    assert.deepEqual(await applyStageEvent(DB, `ok-${reason}`, "reopen", NOW), { from: "lost", to: "replied" }, reason);
  }
  // an opt-out or a bounce is never reopened, nor a lost row with no reason recorded
  for (const reason of ["opt_out", "bounce", null]) {
    const id = `no-${reason}`;
    await seedProspect(DB, id, "lost", { lost_reason: reason });
    assert.equal(await applyStageEvent(DB, id, "reopen", NOW), null, String(reason));
    const p = await prospect(DB, id);
    assert.equal(p.stage, "lost", String(reason));
    assert.equal(p.lost_reason, reason, String(reason));
    assert.equal(p.updated_at, EARLIER, `${reason}: nothing written`);
  }
  // reopen still does nothing outside lost, and makes no row
  await seedProspect(DB, "open", "emailed");
  assert.equal(await applyStageEvent(DB, "open", "reopen", NOW), null);
  assert.equal(await applyStageEvent(DB, "none", "reopen", NOW, { email: "a@b.com" }), null);
  assert.equal(await prospect(DB, "none"), null);
});

test("a reopen racing an opt-out on the same lost prospect never undoes the opt-out", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "lost", { lost_reason: "not_now" });
  // stage 7 read lost/not_now and fires reopen; before it writes, the inbound step records their "no thanks"
  const raced = racing(DB, (n) => n === 1 && DB.exec("UPDATE prospects SET lost_reason = 'opt_out' WHERE place_id = 'p1'"));
  assert.equal(await applyStageEvent(raced, "p1", "reopen", NOW), null);
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "lost");
  assert.equal(p.lost_reason, "opt_out");
});

test("a won prospect given opt_out returns null and stays won", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "pw", "won");
  await seedMessage(DB, "ms", "pw", "system");
  assert.equal(await applyStageEvent(DB, "pw", "opt_out", NOW), null);
  assert.equal(await applyStageEvent(DB, "pw", "bounce", NOW), null);
  const p = await prospect(DB, "pw");
  assert.equal(p.stage, "won");
  assert.equal(p.lost_reason, null);
  assert.equal(p.updated_at, EARLIER);
  assert.equal((await message(DB, "ms")).status, "queued", "a client's system mail is never stopped");
});

test("opt_out or bounce on a prospect already lost for a reopenable reason records it (so it's never reopened)", async () => {
  const DB = fakeD1();
  // Part A: opt_out → lost with lost_reason opt_out. Stage 7 reopens only not_now, not_interested, sequence_done
  // and call, so a "not now" who later says "no thanks" must read opt_out, or their next email would reopen them.
  for (const [id, before, event] of [["a", "not_now", "opt_out"], ["b", "sequence_done", "opt_out"],
    ["c", "not_interested", "bounce"], ["d", "call", "bounce"], ["e", null, "opt_out"]]) {
    await seedProspect(DB, id, "lost", { lost_reason: before });
    assert.equal(await applyStageEvent(DB, id, event, NOW), null, `${event} after ${before}: the stage didn't change`);
    const p = await prospect(DB, id);
    assert.equal(p.stage, "lost", id);
    assert.equal(p.lost_reason, event, id);
    assert.equal(p.stage_at, EARLIER, `${id}: still lost since it was first lost`);
    assert.equal(p.updated_at, NOW_ISO, id);
  }
  // an opt-out and a bounce never overwrite each other
  await seedProspect(DB, "o", "lost", { lost_reason: "opt_out" });
  await seedProspect(DB, "b2", "lost", { lost_reason: "bounce" });
  assert.equal(await applyStageEvent(DB, "o", "bounce", NOW), null);
  assert.equal(await applyStageEvent(DB, "b2", "opt_out", NOW), null);
  for (const [id, reason] of [["o", "opt_out"], ["b2", "bounce"]]) {
    const p = await prospect(DB, id);
    assert.equal(p.lost_reason, reason, id);
    assert.equal(p.updated_at, EARLIER, `${id}: nothing written`);
  }
  // other events on a lost prospect still write nothing
  await seedProspect(DB, "n", "lost", { lost_reason: "not_now" });
  for (const event of ["said_no", "sequence_done", "escalate", "demo_view"]) {
    assert.equal(await applyStageEvent(DB, "n", event, NOW, { lost_reason: "not_interested" }), null, event);
  }
  const n = await prospect(DB, "n");
  assert.equal(n.lost_reason, "not_now");
  assert.equal(n.updated_at, EARLIER);
});

test("an opt-out racing another stop on a lost prospect reads the row again", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "lost", { lost_reason: "not_now" });
  // another request records a bounce between our read and our write
  const raced = {
    ...DB,
    prepare: (sql) => {
      const stmt = DB.prepare(sql);
      if (!sql.startsWith("UPDATE prospects SET lost_reason")) return stmt;
      return {
        bind: (...args) => {
          const bound = stmt.bind(...args);
          return {
            run: async () => {
              await DB.exec("UPDATE prospects SET lost_reason = 'bounce' WHERE place_id = 'p1'");
              return bound.run();
            },
          };
        },
      };
    },
  };
  assert.equal(await applyStageEvent(raced, "p1", "opt_out", NOW), null);
  assert.equal((await prospect(DB, "p1")).lost_reason, "bounce", "the other request's bounce is kept");
});

test("an event that doesn't change the stage writes nothing", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "ready", { greet_name: "Al" });
  await seedMessage(DB, "m1", "p1", "first");
  assert.equal(await applyStageEvent(DB, "p1", "demo_view", NOW), null);
  assert.equal(await applyStageEvent(DB, "p1", "demo_ready", NOW, { email: "other@x.com", greet_name: "Bo" }), null);
  assert.equal(await applyStageEvent(DB, "p1", "nonsense", NOW), null);
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "ready");
  assert.equal(p.email, "p1@example.com");
  assert.equal(p.greet_name, "Al");
  assert.equal(p.stage_at, EARLIER);
  assert.equal(p.updated_at, EARLIER);
  assert.equal((await message(DB, "m1")).status, "queued");
});

test("a change to an open stage leaves follow-ups and queued emails alone", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "emailed", { next_followup_at: LATER });
  await seedMessage(DB, "m1", "p1", "followup");
  assert.deepEqual(await applyStageEvent(DB, "p1", "demo_view", NOW), { from: "emailed", to: "viewed" });
  assert.deepEqual(await applyStageEvent(DB, "p1", "inbound_human", NOW), { from: "viewed", to: "replied" });
  const p = await prospect(DB, "p1");
  assert.equal(p.stage, "replied");
  assert.equal(p.next_followup_at, LATER);
  assert.equal(p.stage_at, NOW_ISO);
  assert.equal((await message(DB, "m1")).status, "queued");
});

test("stopping cancels only this lead's queued first/follow-up emails", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "emailed", { next_followup_at: LATER });
  await seedProspect(DB, "p2", "emailed", { next_followup_at: LATER });
  await seedMessage(DB, "f", "p1", "followup");
  await seedMessage(DB, "first", "p1", "first");
  await seedMessage(DB, "reply", "p1", "reply");
  await seedMessage(DB, "system", "p1", "system");
  await seedMessage(DB, "sent", "p1", "followup", "sent", { sent_at: EARLIER });
  await seedMessage(DB, "failed", "p1", "followup", "failed", { error: "SMTP said no" });
  await seedMessage(DB, "sending", "p1", "followup", "sending");
  await seedMessage(DB, "other", "p2", "followup");
  await applyStageEvent(DB, "p1", "said_no", NOW, { lost_reason: "not_interested" });
  const status = async (id) => (await message(DB, id)).status;
  assert.equal(await status("f"), "cancelled");
  assert.equal(await status("first"), "cancelled");
  assert.equal((await message(DB, "first")).error, "Stopped: said_no");
  assert.equal(await status("reply"), "queued");
  assert.equal(await status("system"), "queued");
  assert.equal(await status("sent"), "sent");
  assert.equal(await status("failed"), "failed");
  assert.equal((await message(DB, "failed")).error, "SMTP said no");
  assert.equal(await status("sending"), "sending");
  assert.equal(await status("other"), "queued");
  assert.equal((await prospect(DB, "p2")).next_followup_at, LATER);
});

test("now can be a Date or an ISO string, and is stored without milliseconds", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "ready");
  await applyStageEvent(DB, "p1", "first_sent", "2026-10-24T12:00:00.789Z");
  assert.equal((await prospect(DB, "p1")).stage_at, NOW_ISO);
  await applyStageEvent(DB, "p2", "demo_ready", new Date("2026-10-24T12:00:00.789Z"), { email: "a@b.com" });
  assert.equal((await prospect(DB, "p2")).created_at, NOW_ISO);
});

test("bad arguments are refused before anything is written", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "emailed");
  await assert.rejects(applyStageEvent(DB, "p1", "opt_out"), TypeError);
  await assert.rejects(applyStageEvent(DB, "p1", "opt_out", "yesterday"), TypeError);
  await assert.rejects(applyStageEvent(DB, "p1", "opt_out", { lost_reason: "not_now" }), TypeError); // options in now's place
  await assert.rejects(applyStageEvent(DB, "p1", "opt_out", new Date("nope")), TypeError);
  await assert.rejects(applyStageEvent(DB, "", "opt_out", NOW), TypeError);
  await assert.rejects(applyStageEvent(DB, null, "opt_out", NOW), TypeError);
  await assert.rejects(applyStageEvent(DB, "p1", undefined, NOW), TypeError);
  assert.equal((await prospect(DB, "p1")).stage, "emailed");
});

test("D1 cost (counted as the tick counts it): a no-op is 1 query, a move 2, a stop 3", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "emailed");
  let c = countingDB(DB);
  await applyStageEvent(c.DB, "p1", "first_sent", NOW);
  assert.equal(c.used(), 1);
  c = countingDB(DB);
  await applyStageEvent(c.DB, "p1", "demo_view", NOW);
  assert.equal(c.used(), 2);
  c = countingDB(DB);
  await applyStageEvent(c.DB, "p1", "opt_out", NOW);
  assert.equal(c.used(), 3);
  c = countingDB(DB);
  await applyStageEvent(c.DB, "none", "demo_view", NOW);
  assert.equal(c.used(), 1);
  // already lost: a repeat opt-out is 1 query, an opt-out after not_now is 2 (the read, then lost_reason)
  c = countingDB(DB);
  await applyStageEvent(c.DB, "p1", "opt_out", NOW);
  assert.equal(c.used(), 1);
  await seedProspect(DB, "p2", "lost", { lost_reason: "not_now" });
  c = countingDB(DB);
  await applyStageEvent(c.DB, "p2", "opt_out", NOW);
  assert.equal(c.used(), 2);
  // a new row: the read, then the insert (paid adds the cancel)
  c = countingDB(DB);
  await applyStageEvent(c.DB, "p3", "demo_ready", NOW, { email: "a@b.com" });
  assert.equal(c.used(), 2);
  c = countingDB(DB);
  await applyStageEvent(c.DB, "p4", "paid", NOW, { email: "a@b.com" });
  assert.equal(c.used(), 3);
});

// ---------------------------------------------------------------- concurrency

test("a stage changed between the read and the write is read again, never overwritten", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "emailed");
  // someone else marks it won first: escalate from won is a no-op
  const won = racing(DB, (n) => n === 1 && DB.exec("UPDATE prospects SET stage = 'won' WHERE place_id = 'p1'"));
  assert.equal(await applyStageEvent(won, "p1", "escalate", NOW), null);
  assert.equal((await prospect(DB, "p1")).stage, "won");

  // someone else moves it on to viewed first: escalate then applies from viewed
  await seedProspect(DB, "p2", "emailed");
  const viewed = racing(DB, (n) => n === 1 && DB.exec("UPDATE prospects SET stage = 'viewed' WHERE place_id = 'p2'"));
  assert.deepEqual(await applyStageEvent(viewed, "p2", "escalate", NOW), { from: "viewed", to: "needs_nik" });
  assert.equal((await prospect(DB, "p2")).stage, "needs_nik");
});

test("a lost write never cancels emails for a prospect that isn't stopped", async () => {
  const DB = fakeD1();
  await seedProspect(DB, "p1", "emailed", { next_followup_at: LATER });
  await seedMessage(DB, "m1", "p1", "followup");
  // the row flips between emailed and viewed on every write, so each write loses the race
  const flipping = racing(DB, () =>
    DB.exec("UPDATE prospects SET stage = CASE stage WHEN 'emailed' THEN 'viewed' ELSE 'emailed' END WHERE place_id = 'p1'"));
  await assert.rejects(applyStageEvent(flipping, "p1", "opt_out", NOW), /kept changing/);
  const p = await prospect(DB, "p1");
  assert.ok(["emailed", "viewed"].includes(p.stage));
  assert.equal(p.next_followup_at, LATER);
  assert.equal(p.lost_reason, null);
  assert.equal((await message(DB, "m1")).status, "queued");
  // once the race stops, the stop goes through
  await applyStageEvent(DB, "p1", "opt_out", NOW);
  assert.equal((await message(DB, "m1")).status, "cancelled");
});

test("two new rows for one lead: the second becomes an ordinary event on the first", async () => {
  const DB = fakeD1();
  const inserted = racing(DB, (n) => n === 1 && seedProspect(DB, "p9", "emailed", { email: "first@x.com" }));
  assert.equal(await applyStageEvent(inserted, "p9", "demo_ready", NOW, { email: "second@x.com" }), null);
  const p = await prospect(DB, "p9");
  assert.equal(p.stage, "emailed");
  assert.equal(p.email, "first@x.com");
  assert.equal(await count(DB, "prospects"), 1);

  const paid = racing(DB, (n) => n === 1 && seedProspect(DB, "p10", "viewed"));
  assert.deepEqual(await applyStageEvent(paid, "p10", "paid", NOW, { email: "pay@x.com" }), { from: "viewed", to: "won" });
  assert.equal((await prospect(DB, "p10")).stage, "won");
});

// ---------------------------------------------------------------- suppression

test("isSuppressed finds an address (any case) and any address at a suppressed domain", async () => {
  const DB = fakeD1();
  await suppress(DB, "bob@x.com", "email", "opt_out", NOW);
  assert.equal(await isSuppressed(DB, "Bob@X.com"), "opt_out");
  assert.equal(await isSuppressed(DB, "bob@x.com"), "opt_out");
  assert.equal(await isSuppressed(DB, "alice@x.com"), null);
  await suppress(DB, "spam.com", "domain", "manual", NOW);
  assert.equal(await isSuppressed(DB, "anyone@spam.com"), "manual");
  assert.equal(await isSuppressed(DB, "Someone.Else@SPAM.COM"), "manual");
  assert.equal(await isSuppressed(DB, "a@mail.spam.com"), null, "a subdomain is a different domain");
  assert.equal(await isSuppressed(DB, "a@notspam.com"), null);
  assert.equal(await isSuppressed(DB, "spam.com@other.com"), null);
});

test("isSuppressed: the address's own reason wins over its domain's", async () => {
  const DB = fakeD1();
  await suppress(DB, "x.com", "domain", "manual", NOW);
  await suppress(DB, "bob@x.com", "email", "bounce", NOW);
  assert.equal(await isSuppressed(DB, "bob@x.com"), "bounce");
  assert.equal(await isSuppressed(DB, "amy@x.com"), "manual");
});

test("isSuppressed: nothing to check is not suppressed; a company number never matches an email", async () => {
  const DB = fakeD1();
  await suppress(DB, "12345678", "company", "big firm", NOW);
  assert.equal(await isSuppressed(DB, ""), null);
  assert.equal(await isSuppressed(DB, null), null);
  assert.equal(await isSuppressed(DB, undefined), null);
  assert.equal(await isSuppressed(DB, "a@12345678"), null);
});

test("suppress stores a normalised row once (INSERT OR IGNORE keeps the first reason)", async () => {
  const DB = fakeD1();
  await suppress(DB, " Bob@X.com ", "email", "opt_out", NOW);
  await suppress(DB, "bob@x.com", "email", "bounce", "2026-10-25T08:00:00Z");
  await suppress(DB, "@Spam.com", "domain", "manual", NOW);
  await suppress(DB, " SC123456 ", "company", "big firm", NOW);
  const { results } = await DB.prepare("SELECT * FROM suppression ORDER BY value").all();
  assert.deepEqual(results, [
    { value: "SC123456", kind: "company", reason: "big firm", created_at: NOW_ISO },
    { value: "bob@x.com", kind: "email", reason: "opt_out", created_at: NOW_ISO },
    { value: "spam.com", kind: "domain", reason: "manual", created_at: NOW_ISO },
  ]);
});

test("suppress never loses an opt-out from an odd but real address", async () => {
  const DB = fakeD1();
  await suppress(DB, '"John Smith"@Example.com', "email", "opt_out", NOW);
  assert.equal(await isSuppressed(DB, '"john smith"@example.com'), "opt_out");
  assert.equal(await isSuppressed(DB, "anyone.else@example.com"), null);
});

test("a display-name form of an address is suppressed and checked as the bare address", async () => {
  const DB = fakeD1();
  await suppress(DB, "Bob Smith <Bob@X.com>", "email", "opt_out", NOW);
  assert.equal(await DB.prepare("SELECT value FROM suppression").first("value"), "bob@x.com");
  assert.equal(await isSuppressed(DB, "bob@x.com"), "opt_out");
  // what the outbox might hold in to_addr: never a way round the list
  assert.equal(await isSuppressed(DB, "Bobby <BOB@x.com>"), "opt_out");
  assert.equal(await isSuppressed(DB, " <bob@x.com> "), "opt_out");
  await suppress(DB, "spam.com", "domain", "manual", NOW);
  assert.equal(await isSuppressed(DB, "Spam Ltd <Sales@Spam.com>"), "manual");
  assert.equal(await isSuppressed(DB, "Amy <amy@y.com>"), null);
  // anything else in angle brackets is taken whole, as before, so an odd From never stops an opt-out being stored
  await suppress(DB, "x@y.com<z>", "email", "opt_out", NOW);
  assert.equal(await isSuppressed(DB, "X@y.com<z>"), "opt_out");
});

test("a company number is stored upper-cased, as leads.company_number holds it", async () => {
  const DB = fakeD1();
  await suppress(DB, " sc123456 ", "company", "big firm", NOW);
  await suppress(DB, "01234567", "company", "big firm", NOW);
  const { results } = await DB.prepare("SELECT value FROM suppression ORDER BY value").all();
  assert.deepEqual(results.map((r) => r.value), ["01234567", "SC123456"]);
  await assert.rejects(suppress(DB, "  ", "company", "big firm", NOW), TypeError);
});

test("suppress refuses a value that doesn't fit its kind", async () => {
  const DB = fakeD1();
  await assert.rejects(suppress(DB, "bob@x.com", "person", "opt_out", NOW), TypeError);
  await assert.rejects(suppress(DB, "x.com", "email", "opt_out", NOW), TypeError);
  await assert.rejects(suppress(DB, "bob\r\n@x.com", "email", "opt_out", NOW), TypeError);
  await assert.rejects(suppress(DB, "bob@x.com\r\nx", "email", "opt_out", NOW), TypeError);
  await assert.rejects(suppress(DB, "bob@", "email", "opt_out", NOW), TypeError);
  await assert.rejects(suppress(DB, "@x.com", "email", "opt_out", NOW), TypeError);
  await assert.rejects(suppress(DB, "bob@x.com", "domain", "manual", NOW), TypeError);
  await assert.rejects(suppress(DB, "", "email", "opt_out", NOW), TypeError);
  await assert.rejects(suppress(DB, "bob@x.com", "email", "", NOW), TypeError);
  await assert.rejects(suppress(DB, "bob@x.com", "email", "opt_out"), TypeError);
  assert.equal(await count(DB, "suppression"), 0);
});
