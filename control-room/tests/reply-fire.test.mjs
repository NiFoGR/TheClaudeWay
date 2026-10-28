// Stage 7 replies: the tick step reply_fire (waking the reply Routine) and the Replies health light (Task 7).
// Run: node --test control-room/tests/reply-fire.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { countingDB } from "../functions/_lib/d1count.js";
import { healthFromDb } from "../functions/_lib/health.js";
import { runReplyFire, waitingStats } from "../functions/_lib/replies-db.js";
import { setSecret, setSetting } from "../functions/_lib/settings.js";
import { STEPS, runTick } from "../functions/_lib/tick.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const D = (s) => new Date(s);
const URL_OK = "https://api.anthropic.com/v1/claude_code/routines/trig_01AbC9xyz/fire";
const TOKEN = "sk-ant-oat01-test-token-for-reply-fire";
const env = {};

let n = 0;
// A waiting message: inbound human mail linked to a lead, needs_reply 1, stored as stage 0's processInbound stores it
// (only for mail linked to a prospect, so its prospect is added too: replied, which Claude answers).
async function waiting(DB, received_at, extra = {}) {
  n += 1;
  const placeId = Object.hasOwn(extra, "place_id") ? extra.place_id : "test:p1";
  if (placeId) {
    await DB.prepare(`INSERT OR IGNORE INTO prospects (place_id, stage, stage_at, email, created_at, updated_at)
      VALUES (?, 'replied', ?, 'mark@greenleaf.co.uk', ?, ?)`).bind(placeId, received_at, received_at, received_at).run();
  }
  const row = {
    id: `w${n}`, place_id: "test:p1", mailbox_id: "mb1", direction: "in", kind: "inbound", author: "them",
    from_addr: "mark@greenleaf.co.uk", subject: "Re: Your new website", body: "Looks good, how much?",
    status: "received", received_at, class: "human", needs_reply: 1, created_at: received_at, ...extra,
  };
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO messages (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
}

async function connected() {
  const DB = fakeD1();
  await setSecret(DB, "routine:reply:url", URL_OK);
  await setSecret(DB, "routine:reply:token", TOKEN);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    return { status: 200, json: async () => ({ type: "routine_fire", claude_code_session_id: "session_01abc" }) };
  };
  return { DB, calls, fetchImpl };
}

test("reply_fire: fires once per burst, skips at night and while paused; the Replies light is one query", async () => {
  const { DB, calls, fetchImpl } = await connected();
  const addWaiting = (at) => waiting(DB, at);
  await addWaiting("2026-10-20T08:00:00Z");

  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T08:00:30Z"), fetchImpl }), /^fired/);
  assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0].body).text, "reply waiting: 1 message(s)");
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T08:01:30Z"), fetchImpl }), /^skipped/);
  await addWaiting("2026-10-20T08:01:00Z");
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T08:03:00Z"), fetchImpl }), /^fired \(2 waiting\)/);
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T22:45:00Z"), fetchImpl }), /^skipped: outside reply hours/);
  await setSetting(DB, "replies:paused", "1");
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T09:00:00Z"), fetchImpl }), /^skipped: paused/);
  assert.equal(calls.length, 2);
  // a third waiting row with place_id NULL is seeded: it never counts
  await waiting(DB, "2026-10-20T07:30:00Z", { place_id: null });
  assert.equal((await waitingStats(DB)).waiting, 2);
  const c = countingDB(DB); assert.equal((await waitingStats(c.DB)).paused, true); assert.equal(c.used(), 1);   // the light's only query
  // health light
  const light = (await healthFromDb(DB, env, D("2026-10-20T08:21:00Z"))).lights.find((l) => l.name === "replies");
  assert.equal(light.level, "grey");   // paused
  assert.deepEqual(Object.keys(light).sort(), ["detail", "fix", "level", "name"]);
});

test("waitingStats: counts, oldest and newest of the waiting mail only, and the paused flag", async () => {
  const DB = fakeD1();
  assert.deepEqual(await waitingStats(DB), {
    waiting: 0, oldestAt: null, newestAt: null, paused: false, failed: 0, failedPlaceId: null, failedError: null,
  });
  await waiting(DB, "2026-10-20T08:00:00Z");
  await waiting(DB, "2026-10-20T08:05:00Z");
  await waiting(DB, "2026-10-20T07:00:00Z", { needs_reply: 0 }); // answered
  await waiting(DB, "2026-10-20T07:10:00Z", { direction: "out", kind: "reply", author: "claude", status: "queued" });
  await waiting(DB, "2026-10-20T07:20:00Z", { place_id: null }); // not tied to a lead
  const s = await waitingStats(DB);
  assert.equal(s.waiting, 2);
  assert.ok(s.oldestAt instanceof Date && s.newestAt instanceof Date);
  assert.equal(s.oldestAt.toISOString(), "2026-10-20T08:00:00.000Z");
  assert.equal(s.newestAt.toISOString(), "2026-10-20T08:05:00.000Z");
  assert.equal(s.paused, false);
  await setSetting(DB, "replies:paused", "0");
  assert.equal((await waitingStats(DB)).paused, false, "only '1' pauses");
  await setSetting(DB, "replies:paused", "1");
  assert.equal((await waitingStats(DB)).paused, true);
});

test("reply_fire: newer mail means stored after the last fire, so mail the fire couldn't see is never left 10 minutes", async () => {
  const { DB, calls, fetchImpl } = await connected();
  await waiting(DB, "2026-10-20T08:00:00Z");
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T08:00:30Z"), fetchImpl }), /^fired \(1 waiting\)/);
  // The relay saved it at 08:00:20, before the fire, but it was only read on the 08:05 tick.
  await waiting(DB, "2026-10-20T08:00:20Z", { created_at: "2026-10-20T08:05:00Z" });
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T08:05:00Z"), fetchImpl }), /^fired \(2 waiting\)/);
  assert.equal(calls.length, 2);
});

test("reply_fire: refires after 10 minutes when the last run didn't clear it, and not before", async () => {
  const { DB, calls, fetchImpl } = await connected();
  await waiting(DB, "2026-10-20T08:00:00Z");
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T08:00:30Z"), fetchImpl }), /^fired/);
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T08:09:00Z"), fetchImpl }), /^skipped: /);
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T08:10:30Z"), fetchImpl }), /^fired \(1 waiting\)/);
  assert.equal(calls.length, 2);
  const rows = (await DB.prepare("SELECT at FROM routine_fires WHERE routine = 'reply' ORDER BY at").all()).results;
  assert.deepEqual(rows.map((r) => r.at), ["2026-10-20T08:00:30Z", "2026-10-20T08:10:30Z"]);
});

test("reply_fire: nothing waiting is skipped without a fire; another Routine's fires don't count", async () => {
  const { DB, calls, fetchImpl } = await connected();
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T08:00:30Z"), fetchImpl }), /^skipped: nothing waiting/);
  await DB.prepare("INSERT INTO routine_fires (id, routine, reason, http_status, at) VALUES ('r1', 'research', 'x', 200, ?)")
    .bind("2026-10-20T08:00:00Z")
    .run();
  await waiting(DB, "2026-10-20T07:59:00Z");
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T08:01:00Z"), fetchImpl }), /^fired \(1 waiting\)/);
  assert.equal(calls.length, 1);
});

test("reply_fire: overnight mail (BST, 20 Oct) waits for 07:00 UK, then fires at 06:00Z on 21 Oct", async () => {
  const { DB, calls, fetchImpl } = await connected();
  await waiting(DB, "2026-10-20T22:40:00Z"); // 23:40 BST
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T22:45:00Z"), fetchImpl }), /^skipped: outside reply hours/);
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-21T05:59:00Z"), fetchImpl }), /^skipped: outside reply hours/);
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-21T06:00:00Z"), fetchImpl }), /^fired \(1 waiting\)/);
  assert.equal(calls.length, 1);
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS n FROM routine_fires WHERE at < '2026-10-21T06:00:00Z'").first()).n,
    0,
    "no reply fire at night",
  );
});

test("reply_fire: a fire Claude refuses is reported (no secret in it) and not retried for 2 minutes", async () => {
  const DB = fakeD1();
  const calls = [];
  const fetchImpl = async () => {
    calls.push(1);
    return { status: 200 };
  };
  await waiting(DB, "2026-10-20T08:00:00Z");
  const out = await runReplyFire({ DB, env, now: D("2026-10-20T08:00:30Z"), fetchImpl });
  assert.match(out, /^fire failed \(1 waiting\): The Replies Routine isn't connected/);
  assert.equal(calls.length, 0);
  // the failed attempt is logged, so the next tick doesn't try again straight away
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T08:01:30Z"), fetchImpl }), /^skipped: /);

  await setSecret(DB, "routine:reply:url", URL_OK);
  await setSecret(DB, "routine:reply:token", TOKEN);
  const refused = async () => ({ status: 401 });
  const out2 = await runReplyFire({ DB, env, now: D("2026-10-20T08:11:00Z"), fetchImpl: refused });
  assert.match(out2, /^fire failed \(1 waiting\): Claude rejected the token/);
  assert.ok(!out2.includes(TOKEN) && !out2.includes("trig_01AbC9xyz"));
});

test("reply_fire: a tick without room for a fire defers it", async () => {
  const { DB, calls, fetchImpl } = await connected();
  await waiting(DB, "2026-10-20T08:00:00Z");
  const budget = { left: () => 6 };
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-20T08:00:30Z"), fetchImpl, budget }), /^skipped: /);
  assert.equal(calls.length, 0);
});

test("the Replies light: green, red after 20 minutes inside hours, grey at night", async () => {
  const DB = fakeD1();
  const replies = async (now) => (await healthFromDb(DB, env, D(now))).lights.find((l) => l.name === "replies");
  assert.deepEqual(await replies("2026-10-20T08:21:00Z"), { name: "replies", level: "green", detail: "No replies waiting.", fix: "" });
  await waiting(DB, "2026-10-20T08:00:00Z");
  assert.equal((await replies("2026-10-20T08:10:00Z")).detail, "1 reply waiting.");
  const red = await replies("2026-10-20T08:21:00Z");
  assert.deepEqual(red, {
    name: "replies",
    level: "red",
    detail: "A reply has waited 21 minutes.",
    fix: "Check the aetos-reply Routine is switched on (routines/README.md) and its URL and token are saved on Setup → Claude.",
  });
  assert.deepEqual(await replies("2026-10-20T22:45:00Z"), {
    name: "replies", level: "grey", detail: "Replies start again at 7am (1 waiting).", fix: "",
  });
  // registered once, though tick.js imports replies-db.js too
  const lights = (await healthFromDb(DB, env, D("2026-10-20T08:10:00Z"))).lights;
  assert.equal(lights.filter((l) => l.name === "replies").length, 1);
});

test("STEPS: reply_fire runs every tick, straight after inbound (position 2)", () => {
  const names = STEPS.map((s) => s.name);
  assert.equal(names[1], "reply_fire");
  assert.equal(names.indexOf("reply_fire"), names.indexOf("inbound") + 1);
  const step = STEPS[1];
  assert.equal(step.everyMinutes, 0);
  assert.equal(step.run, runReplyFire);
});

test("reply_fire in a real tick: fires with the tick's clock, within 50 queries, no secret in the heartbeat; never in ?reason=health", async () => {
  const { DB } = await connected();
  await waiting(DB, "2026-10-20T08:00:00Z");
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    return { status: 200, json: async () => ({}) };
  };
  try {
    const health = await runTick({ DB }, "health", D("2026-10-20T08:00:30Z"));
    assert.ok(!("reply_fire" in health.steps));
    assert.equal(calls.length, 0);
    const c = countingDB(DB);
    const r = await runTick({ DB: c.DB }, "cron", D("2026-10-20T08:01:00Z"));
    assert.equal(r.ran, true);
    assert.equal(r.steps.reply_fire, "fired (1 waiting)");
    assert.ok(c.used() <= 50, String(c.used()));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, URL_OK);
    assert.equal(JSON.parse(calls[0].body).text, "reply waiting: 1 message(s)");
    const fire = await DB.prepare("SELECT at, reason, error FROM routine_fires WHERE routine = 'reply'").first();
    assert.deepEqual({ ...fire }, { at: "2026-10-20T08:01:00Z", reason: "reply waiting: 1 message(s)", error: null });
    const hb = await DB.prepare("SELECT detail FROM heartbeats WHERE name = 'tick'").first();
    assert.match(hb.detail, /reply_fire: fired \(1 waiting\)/);
    assert.ok(!hb.detail.includes(TOKEN) && !hb.detail.includes("trig_01AbC9xyz"));
    // the next tick, 5 minutes on with no new mail, doesn't fire again
    const next = await runTick({ DB }, "cron", D("2026-10-20T08:06:00Z"));
    assert.match(next.steps.reply_fire, /^skipped: no new mail since the fire 5 minutes ago \(1 waiting\)$/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = real;
  }
});

test("reply_fire after the clock change (GMT, 26 Oct): 06:30Z is still night, 07:00Z fires; 23:29 UK fires, 23:30 doesn't", async () => {
  const { DB, calls, fetchImpl } = await connected();
  await waiting(DB, "2026-10-25T23:10:00Z");
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-26T06:30:00Z"), fetchImpl }), /^skipped: outside reply hours/);
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-26T07:00:00Z"), fetchImpl }), /^fired \(1 waiting\)/);
  await waiting(DB, "2026-10-26T23:20:00Z");
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-26T23:29:00Z"), fetchImpl }), /^fired \(2 waiting\)/);
  await waiting(DB, "2026-10-26T23:29:30Z");
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-26T23:31:30Z"), fetchImpl }), /^skipped: outside reply hours/);
  assert.match(await runReplyFire({ DB, env, now: D("2026-10-26T23:30:00Z"), fetchImpl }), /^skipped: outside reply hours/);
  assert.equal(calls.length, 2);
});

// A reply that didn't send: the send step marked it failed (final: nothing retries it), so the light says so.
async function sentReply(DB, id, place_id, created_at, status, error = null) {
  await DB.prepare(`INSERT INTO messages (id, place_id, mailbox_id, direction, kind, author, to_addr, from_addr, subject, body,
      status, due_at, error, created_at) VALUES (?, ?, 'mb1', 'out', 'reply', 'claude', 'mark@greenleaf.co.uk',
      'nik@aetoswebsites.com', 'Re: Your new website', 'Hi', ?, ?, ?, ?)`)
    .bind(id, place_id, status, created_at, error, created_at).run();
}

test("the Replies light: a reply that didn't send is red until a later email goes in that thread; the drill never counts", async () => {
  const DB = fakeD1();
  const replies = async (now) => (await healthFromDb(DB, env, D(now))).lights.find((l) => l.name === "replies");
  const ERR = "Couldn't log in to nik@aetoswebsites.com: check the password on Setup → Mailboxes.";
  await DB.prepare(`INSERT INTO prospects (place_id, stage, stage_at, email, created_at, updated_at)
    VALUES ('p1', 'replied', ?1, 'mark@greenleaf.co.uk', ?1, ?1)`).bind("2026-10-19T07:00:00Z").run();
  await sentReply(DB, "r1", "p1", "2026-10-20T08:00:00Z", "failed", ERR);
  await sentReply(DB, "d1", "drill:angry", "2026-10-20T08:00:00Z", "failed", "drill: not sent");
  await sentReply(DB, "t1", "test:p1", "2026-10-20T08:00:00Z", "failed", "boom");
  const s = await waitingStats(DB, D("2026-10-20T08:05:00Z"));
  assert.equal(s.failed, 1); assert.equal(s.failedPlaceId, "p1"); assert.equal(s.failedError, ERR);
  const red = await replies("2026-10-20T08:05:00Z");
  assert.deepEqual(red, {
    name: "replies",
    level: "red",
    detail: `A reply didn't send: ${ERR}`,
    fix: "Check the mailbox password on Setup → Mailboxes, then open the thread on the Replies page and send it again with Reply as me. If the error says it may have gone, check the Sent folder first.",
  });
  assert.equal((await replies("2026-10-20T23:00:00Z")).level, "red"); // at night too: nothing will retry it
  await setSetting(DB, "replies:paused", "1");
  assert.equal((await replies("2026-10-20T08:05:00Z")).level, "grey"); // paused wins
  await setSetting(DB, "replies:paused", "0");
  // a week later it no longer counts
  assert.equal((await replies("2026-10-27T08:01:00Z")).level, "green");
  // Nik's resend in the same thread clears it (queued, then sent)
  await sentReply(DB, "r2", "p1", "2026-10-20T09:00:00Z", "queued");
  assert.equal((await replies("2026-10-20T09:01:00Z")).level, "green");
  DB.raw.prepare("UPDATE messages SET status = 'sent' WHERE id = 'r2'").run();
  assert.equal((await replies("2026-10-20T09:05:00Z")).level, "green");
  // two in other threads say how many
  await DB.prepare(`INSERT INTO prospects (place_id, stage, stage_at, email, created_at, updated_at)
    VALUES ('p2', 'replied', ?1, 'a@b.co.uk', ?1, ?1), ('p3', 'replied', ?1, 'c@d.co.uk', ?1, ?1)`).bind("2026-10-19T07:00:00Z").run();
  await sentReply(DB, "r3", "p2", "2026-10-20T10:00:00Z", "failed", "Older error.");
  await sentReply(DB, "r4", "p3", "2026-10-20T10:05:00Z", "failed", "The mail server said no.");
  assert.equal((await replies("2026-10-20T10:10:00Z")).detail, "2 replies didn't send: The mail server said no.");
  // a thread that opted out since never counts (nothing may be sent there)
  DB.raw.prepare("UPDATE prospects SET stage = 'lost', lost_reason = 'opt_out' WHERE place_id IN ('p2', 'p3')").run();
  assert.equal((await replies("2026-10-20T10:10:00Z")).level, "green");
  const c = countingDB(DB); await waitingStats(c.DB, D("2026-10-20T10:10:00Z")); assert.equal(c.used(), 1); // still one statement
});
