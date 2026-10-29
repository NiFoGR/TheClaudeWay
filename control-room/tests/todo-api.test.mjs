// Todo board loader and routes (docs/rebuild/11-todo-kpis.md, Task 3): loadBoard, setTodoStatus, sortTodos,
// visibleTodos, messageIdFromDedupe in _lib/todo.js; GET /api/todo, GET /api/todo/count, PATCH /api/todo/:id and
// POST /api/todo/:id/send. Seeded from tests/fixtures/board-seed.sql.
// Run: node --test control-room/tests/todo-api.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CLIENTS_SQL, KIND_ORDER, addTodo, loadBoard, messageIdFromDedupe, setTodoStatus, sortTodos, visibleTodos,
} from "../functions/_lib/todo.js";
import { onRequestGet as boardRoute } from "../functions/api/todo.js";
import { onRequestGet as countRoute } from "../functions/api/todo/count.js";
import { onRequestPatch as patchRoute } from "../functions/api/todo/[id].js";
import { onRequestPost as sendRoute } from "../functions/api/todo/[id]/send.js";
import { sendAsNik } from "../functions/_lib/replies-db.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const SEED = readFileSync(new URL("./fixtures/board-seed.sql", import.meta.url), "utf8");
const NOW = new Date("2026-10-22T12:00:00Z");
const ENV = {};

function seeded() {
  const DB = fakeD1();
  DB.exec(SEED);
  return DB;
}
const DB = seeded();

const req = (method, body) => new Request("https://control.example/api/todo", {
  method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
const patch = (id, body, db = DB) => patchRoute({ request: req("PATCH", body), env: { DB: db }, params: { id }, now: NOW });
const send = (id, body, db = DB) => sendRoute({ request: req("POST", body), env: { DB: db }, params: { id } });
async function ids(db = DB) {
  const r = await boardRoute({ request: req("GET"), env: { DB: db }, params: {}, now: NOW });
  assert.equal(r.status, 200);
  const { today } = await r.json();
  return [...today.overdue, ...today.today, ...today.later].map((t) => t.id);
}

test("board groups, sorts and enriches today's items", async () => {
  const b = await loadBoard(DB, ENV, NOW);
  assert.deepEqual(b.today.overdue.map((t) => t.id), ["t-pay"]);
  assert.deepEqual(b.today.today.map((t) => t.id), ["t-esc", "t-find", "t-gone", "t-hot", "t-setup"]);
  assert.deepEqual(b.today.later.map((t) => t.id), ["t-call", "t-kpi"]);
  const call = b.today.later[0];
  assert.deepEqual([call.phone, call.thread_link, call.business], ["07969 123456", "/#/replies/pc", "Castle Car Sales"]);
  assert.equal(b.today.today[0].can_send, true);                       // t-esc: draft + message id
  assert.ok(!JSON.stringify(b.today).includes("t-health") && !JSON.stringify(b.today).includes("t-done"));
  assert.deepEqual(b.pipeline.columns.map((c) => c.count), [1, 1, 2, 1, 1, 1, 1]);
  assert.equal(b.counts.due, 6);
  assert.ok(b.counts.red >= 1);
});

test("call_at is the booked call's time, set only for a call:<id> Todo (not the outcome question or the day list)", async () => {
  const db = seeded();
  await addTodo(db, { kind: "call", title: "How did the call with Ian (Castle Car Sales) go?", place_id: "pc",
    link: "/#/call/call-pc", due_at: "2026-10-23T10:30:00Z", dedupe: "call-outcome:call-pc" });
  await addTodo(db, { kind: "call", title: "Today's calls: 11:00 Ian (Castle Car Sales)", link: "/#/call/call-pc",
    due_at: "2026-10-23T06:00:00Z", dedupe: "calls-day:2026-10-23" });
  await addTodo(db, { kind: "setup", title: "Something with a call: dedupe", due_at: "2026-10-23T09:00:00Z", dedupe: "call:not-a-call" });
  const b = await loadBoard(db, ENV, NOW);
  const all = [...b.today.overdue, ...b.today.today, ...b.today.later];
  const by = (title) => all.find((t) => t.title.startsWith(title));
  assert.equal(by("Call Ian at Castle").call_at, "2026-10-23T10:00:00Z");
  assert.equal(by("How did the call").call_at, null);
  assert.equal(by("How did the call").due_at, "2026-10-23T10:30:00Z");
  assert.equal(by("Today's calls").call_at, null);
  assert.equal(by("Something with").call_at, null);
  assert.ok(all.every((t) => "call_at" in t), "every item carries call_at");
});

test("dedupe helpers", () => {
  assert.equal(messageIdFromDedupe("escalation:m2"), "m2");
  assert.equal(messageIdFromDedupe("call_time:m7@2026-10-22"), "m7");
  assert.equal(messageIdFromDedupe("hot:p1:views"), null);
  assert.equal(messageIdFromDedupe("escalation:client:c1"), null);
  assert.equal(messageIdFromDedupe("escalation:unknown:u1"), null);
  assert.deepEqual(visibleTodos([{ kind: "health", dedupe: "health:tick" }, { kind: "health", dedupe: "health:find:towns" }],
    [{ name: "tick", level: "red" }]).map((t) => t.dedupe), ["health:find:towns"]);
});

test("todos without a lead still show", async () => {
  const b = await loadBoard(DB, ENV, NOW); const s = b.today.today.find((t) => t.id === "t-setup"), g = b.today.today.find((t) => t.id === "t-gone");
  assert.deepEqual([s.lead_link, s.thread_link, s.business], [null, null, null]);
  assert.deepEqual([g.business, g.phone], [null, null]);
});

test("done disappears and stays gone", async () => {
  const r = await patch("t-hot", { status: "done" }); assert.equal(r.status, 200);
  assert.ok(!(await ids()).includes("t-hot"));
  assert.equal(await addTodo(DB, { kind: "hot", title: "again", dedupe: "hot:ph:2026-10-22" }), null);
  assert.ok(!(await ids()).includes("t-hot"));
});

test("patch is safe to repeat", async () => {
  assert.equal((await patch("t-hot", { status: "done" })).status, 200);
  assert.deepEqual(await (await patch("nope", { status: "done" })).json(), { error: "That item no longer exists. Refresh the page." });
  assert.deepEqual(await (await patch("t-esc", { status: "open" })).json(), { error: "Status must be done or dismissed." });
});

test("send posts Nik's edited reply and closes the todo", async () => {
  const r = await send("t-esc", { body: "Hi Sam, Tuesday works." }); assert.equal(r.status, 200);
  const m = await DB.prepare("SELECT kind, author, body FROM messages WHERE place_id = 'pn' AND direction = 'out' ORDER BY created_at DESC").first();
  // stage 7's sendAsNik adds the signature under Nik's words, like every reply ("\n\n<sender_name>\nAetos Websites")
  assert.deepEqual([m.kind, m.author], ["reply", "nik"]);
  assert.ok(m.body.startsWith("Hi Sam, Tuesday works.\n\n"), m.body); assert.ok(m.body.endsWith("Aetos Websites"), m.body);
  assert.equal((await DB.prepare("SELECT status FROM todos WHERE id = 't-esc'").first()).status, "done");
  assert.deepEqual(await (await send("t-pay", { body: "x" })).json(), { error: "Only replies can be sent from here." });
  assert.equal((await send("t-call", { body: "x" })).status, 400);           // kind call: not a reply
  await DB.prepare("INSERT INTO todos (id, kind, client_id, title, draft, dedupe, status, created_at) VALUES ('t-cli','escalation','c2','x','y','escalation:client:c2','open','2026-10-22T11:00:00Z')").run();
  assert.deepEqual(await (await send("t-cli", { body: "x" })).json(), { error: "Only replies can be sent from here." });
});

test("send passes stage 7's errors through", async () => {
  await DB.prepare("INSERT INTO todos (id, kind, place_id, title, dedupe, status, created_at) VALUES ('t-esc2','escalation','pn','x','escalation:m-pn1@2','open','2026-10-22T11:00:00Z')").run();
  const r = await send("t-esc2", { body: "   " });
  assert.deepEqual([r.status, (await r.json()).error], [422, "Couldn't save: write something first."]);
});

test("send refuses a todo that's already done or dismissed, and nothing goes out", async () => {
  const outCount = async (db) => (await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE place_id = 'pn' AND direction = 'out' AND kind = 'reply'").first()).n;
  const dealt = { error: "That's already been dealt with, so nothing was sent. Refresh the page." };
  // Nik answered in his own words elsewhere (Replies page, his phone): stage 7 closes escalation:m-pn1 as done.
  const db = seeded();
  const own = await sendAsNik(db, { message_id: messageIdFromDedupe("escalation:m-pn1"), body: "My own words.", now: NOW });
  assert.equal(own.status, 200);
  assert.equal((await db.prepare("SELECT status FROM todos WHERE id = 't-esc'").first()).status, "done");
  const before = await outCount(db);
  const r = await send("t-esc", { body: "Claude draft" }, db);
  assert.deepEqual([r.status, await r.json()], [409, dealt]);
  assert.equal(await outCount(db), before);
  // A dismissed escalation's draft from a stale page is refused too.
  const db2 = seeded();
  assert.equal((await patch("t-esc", { status: "dismissed" }, db2)).status, 200);
  const before2 = await outCount(db2);
  const r2 = await send("t-esc", { body: "Claude draft" }, db2);
  assert.deepEqual([r2.status, await r2.json()], [409, dealt]);
  assert.equal(await outCount(db2), before2);
});

// ---------------------------------------------------------------- beyond the spec's seven

test("two presses of Send at once send one reply; a refused send leaves the todo open", async () => {
  const db = seeded();
  const outCount = async () => (await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE place_id = 'pn' AND direction = 'out' AND kind = 'reply'").first()).n;
  // Two tabs (or Send and Send edited) at the same moment, with different words so stage 7's duplicate check can't help.
  const [a, b] = await Promise.all([send("t-esc", { body: "Hi Sam, sorry." }, db), send("t-esc", { body: "Hi Sam, so sorry." }, db)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(await outCount(), 1);
  assert.equal((await db.prepare("SELECT status FROM todos WHERE id = 't-esc'").first()).status, "done");
  // Stage 7 refuses (no words): nothing is sent and the todo is still there to send.
  await db.prepare("INSERT INTO todos (id, kind, place_id, title, dedupe, status, created_at) VALUES ('t-esc3','escalation','pn','x','escalation:m-pn1@3','open','2026-10-22T11:00:00Z')").run();
  assert.equal((await send("t-esc3", { body: "  " }, db)).status, 422);
  const t = await db.prepare("SELECT status, done_at FROM todos WHERE id = 't-esc3'").first();
  assert.deepEqual([t.status, t.done_at], ["open", null]);
  assert.equal(await outCount(), 1);
});


// A DB that runs `fault(sql)` on each prepare (it may throw) and holds every batch() until `gate` settles.
function faulty(db, { fault = () => {}, gate = null } = {}) {
  return new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (sql) => { fault(sql); return t.prepare(sql); };
      if (k === "batch" && gate) return async (stmts) => { await gate; return t.batch(stmts); };
      return typeof t[k] === "function" ? t[k].bind(t) : t[k];
    },
  });
}
const nikReplies = async (db) => (await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE place_id = 'pn' AND direction = 'out' AND kind = 'reply' AND author = 'nik'").first()).n;
const todoRow = async (db, id = "t-esc") => db.prepare("SELECT status, done_at FROM todos WHERE id = ?").bind(id).first();
const tick = () => new Promise((r) => setImmediate(r));

test("send's claim and send run to the end in waitUntil, so closing the tab can't split them", async () => {
  // Nik presses Send, then loses signal or closes the tab while it's sending: Cloudflare may cancel the request's own
  // promise, but what's handed to waitUntil runs to the end. Here the send fails after the claim: the todo opens again.
  for (const fails of [true, false]) {
    const db = seeded();
    let release;
    const gate = new Promise((res, rej) => { release = fails ? () => rej(new Error("D1_ERROR: network lost")) : res; });
    gate.catch(() => {});
    const waits = [];
    const route = sendRoute({ request: req("POST", { body: "Sorry Sam, I'll ring you." }), env: { DB: faulty(db, { gate }) },
      params: { id: "t-esc" }, now: NOW, waitUntil: (p) => waits.push(p) });
    route.catch(() => {});
    for (let i = 0; i < 50 && !waits.length; i++) await tick();
    assert.ok(waits.length >= 1, "the claim and the send are handed to waitUntil before anything is awaited on them");
    assert.equal((await todoRow(db)).status, "done");                     // claimed, nothing sent yet
    release();
    await waits[0];                                                       // the request itself is never awaited
    if (fails) {
      assert.deepEqual(await todoRow(db), { status: "open", done_at: null });
      assert.equal(await nikReplies(db), 0);
    } else {
      assert.equal((await todoRow(db)).status, "done");
      assert.equal(await nikReplies(db), 1);
    }
  }
});

test("a reply queued before an error keeps its todo closed; an error before the queue leaves it open", async () => {
  // nikHandled's stage update fails after the reply is queued: the 500 leaves the todo done, so a second press with
  // other words gets the 409 instead of a second email in the thread.
  const db = seeded();
  let thrown = 0;
  const broken = faulty(db, { fault: (sql) => {
    if (/UPDATE prospects SET stage/.test(sql) && !thrown++) throw new Error("D1_ERROR: stage write failed");
  } });
  const r = await sendRoute({ request: req("POST", { body: "Hi Sam, sorry about that." }), env: { DB: broken }, params: { id: "t-esc" }, now: NOW });
  assert.equal(r.status, 500);
  assert.equal(thrown, 1);
  assert.equal((await todoRow(db)).status, "done");
  assert.equal(await nikReplies(db), 1);
  const again = await sendRoute({ request: req("POST", { body: "Hi Sam, really sorry." }), env: { DB: broken }, params: { id: "t-esc" }, now: NOW });
  assert.deepEqual([again.status, (await again.json()).error], [409, "That's already been dealt with, so nothing was sent. Refresh the page."]);
  assert.equal(await nikReplies(db), 1);
  // The batch read fails (nothing queued yet): the todo is open again to send.
  const db2 = seeded();
  const gate = Promise.reject(new Error("D1_ERROR: read failed"));
  gate.catch(() => {});
  const r2 = await sendRoute({ request: req("POST", { body: "Hi Sam, sorry." }), env: { DB: faulty(db2, { gate }) }, params: { id: "t-esc" }, now: NOW });
  assert.equal(r2.status, 500);
  assert.deepEqual(await todoRow(db2), { status: "open", done_at: null });
  assert.equal(await nikReplies(db2), 0);
});

test("kind order, then due time (none last), then id", () => {
  assert.deepEqual(KIND_ORDER, ["escalation", "health", "call_time", "call", "hot", "payment", "build", "care", "kpi", "pick", "setup"]);
  const items = [
    { id: "b", kind: "setup" }, { id: "z", kind: "hot", due_at: null }, { id: "y", kind: "hot", due_at: "2026-10-22T09:00:00Z" },
    { id: "a", kind: "hot", due_at: null }, { id: "x", kind: "escalation", due_at: "2026-10-22T11:00:00Z" },
    { id: "w", kind: "mystery" },
  ];
  assert.deepEqual(sortTodos(items).map((t) => t.id), ["x", "y", "a", "z", "b", "w"]);
  assert.equal(items[0].id, "b", "sortTodos leaves its input alone");
});

test("only escalation and call_time items with a draft and a message id can be sent", async () => {
  const b = await loadBoard(seeded(), ENV, NOW);
  const all = [...b.today.overdue, ...b.today.today, ...b.today.later];
  assert.deepEqual(all.filter((t) => t.can_send).map((t) => t.id), ["t-esc"]);
  const esc = all.find((t) => t.id === "t-esc");
  assert.deepEqual([esc.phone, esc.business, esc.lead_link, esc.thread_link, esc.draft],
    ["01925 100006", "North Locksmiths", "/#/lead/pn", "/#/replies/pn", "Hi Sam, sorry about that. You won't hear from me again."]);
  assert.ok(!("dedupe" in esc) && !("status" in esc), "the item carries only the board's fields");
  // A hot item uses the lead's phone; a payment item has none.
  assert.equal(all.find((t) => t.id === "t-hot").phone, "01925 100004");
  assert.equal(all.find((t) => t.id === "t-pay").phone, null);
  assert.ok(!all.some((t) => t.id === "t-drill"), "drill leads never show");
});

test("lights come red first, and the count route matches the board", async () => {
  const db = seeded();
  const b = await loadBoard(db, ENV, NOW);
  const rank = { red: 0, amber: 1, green: 2, grey: 3 };
  const levels = b.health.map((l) => rank[l.level]);
  assert.deepEqual(levels, [...levels].sort((x, y) => x - y));
  assert.equal(b.health_error, null);
  assert.equal(b.counts.red, b.health.filter((l) => l.level === "red").length);
  assert.equal(b.now, "2026-10-22T12:00:00Z");
  assert.deepEqual([b.clients.cards.map((c) => c.client_id), b.clients.past], [["c3", "c5", "c1", "c2", "c6"], 1]);
  assert.equal(b.clients.cards.find((c) => c.client_id === "c2").rank_link, "/#/maprank?scan=s1&biz=lp2");
  const r = await countRoute({ request: req("GET"), env: { DB: db }, params: {}, now: NOW });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), b.counts);
});

test("a broken health check still gives the rest of the board", async () => {
  const db = seeded();
  const broken = {
    prepare(sql) {
      if (/heartbeats/.test(sql)) throw new Error("no such table: heartbeats");
      return db.prepare(sql);
    },
    batch: (stmts) => db.batch(stmts),
  };
  const b = await loadBoard(broken, ENV, NOW);
  assert.deepEqual(b.health, []);
  assert.match(b.health_error, /heartbeats/);
  assert.equal(b.counts.red, 0);
  // With no lights, the health:tick todo isn't covered by one, so it shows.
  assert.ok(b.today.today.some((t) => t.id === "t-health"));
});

test("setTodoStatus: open → done/dismissed once, closed ones are left alone, unknown ids are missing", async () => {
  const db = seeded();
  assert.equal(await setTodoStatus(db, "t-kpi", "dismissed", NOW), "ok");
  assert.equal(await setTodoStatus(db, "t-kpi", "done", new Date("2026-10-23T09:00:00Z")), "ok");
  const row = await db.prepare("SELECT status, done_at, dedupe FROM todos WHERE id = 't-kpi'").first();
  assert.deepEqual([row.status, row.done_at, row.dedupe], ["dismissed", "2026-10-22T12:00:00Z", "kpi:2026-W43"]);
  assert.equal(await setTodoStatus(db, "nope", "done", NOW), "missing");
  await assert.rejects(setTodoStatus(db, "t-kpi", "open", NOW), /done or dismissed/);
  assert.equal((await patch("t-kpi", "not an object", db)).status, 400);
});

test("Done or Dismiss on an escalation hands the lead back like the Replies page", async () => {
  const db = seeded();
  const r = await patch("t-esc", { status: "done" }, db);
  assert.equal(r.status, 200);
  const t = await db.prepare("SELECT status, dedupe FROM todos WHERE id = 't-esc'").first();
  assert.deepEqual([t.status, t.dedupe], ["done", "escalation:m-pn1"]);
  // Nothing waits on Nik for pn any more, so the stage goes back to replied (stage 7's nik_handled); nothing is sent.
  assert.equal((await db.prepare("SELECT stage FROM prospects WHERE place_id = 'pn'").first()).stage, "replied");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE place_id = 'pn' AND direction = 'out'").first()).n, 0);
  assert.equal((await patch("t-esc", { status: "dismissed" }, db)).status, 200);
  assert.equal((await db.prepare("SELECT status FROM todos WHERE id = 't-esc'").first()).status, "done");
});

test("the seed's pipeline cards read exactly as Task 1's words", async () => {
  const b = await loadBoard(seeded(), ENV, NOW);
  const cards = b.pipeline.columns.flatMap((c) => c.cards).concat(b.pipeline.lost.cards);
  assert.deepEqual(Object.fromEntries(cards.map((c) => [c.place_id, c.event])), {
    pr: "Demo ready · today", pe: "You emailed · 2 days ago", pv: "Viewed site once · 2 days ago",
    ph: "Viewed site 3× · yesterday", prp: "Replied · today", pn: "Replied · yesterday", pc: "Call tomorrow 11:00",
    pw: "Paid · 15 Oct", pl: "Said no thanks · yesterday",
  });
  assert.deepEqual(b.pipeline.columns[2].cards.map((c) => [c.place_id, c.hot]), [["ph", true], ["pv", false]]);
  assert.deepEqual([b.pipeline.lost.count, cards.find((c) => c.place_id === "pr").grade], [1, "A"]);
  assert.ok(!cards.some((c) => c.place_id.startsWith("drill:")), "drill leads never reach the pipeline");
});

test("a call's phone: the next confirmed call, else the latest past one, else the lead's", async () => {
  const db = seeded();
  const phoneOfCall = async () => {
    const b = await loadBoard(db, ENV, NOW);
    return [...b.today.overdue, ...b.today.today, ...b.today.later].find((t) => t.id === "t-call").phone;
  };
  // An older confirmed call already past, and a later one ahead: the one ahead after the seed's (soonest first).
  await db.prepare(`INSERT INTO calls (id, place_id, slot_at, status, phone, created_at, updated_at) VALUES
    ('call-old', 'pc', '2026-10-01T10:00:00Z', 'confirmed', '07000 000001', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z'),
    ('call-past', 'pc', '2026-10-21T10:00:00Z', 'confirmed', '07000 000002', '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z'),
    ('call-late', 'pc', '2026-10-30T10:00:00Z', 'confirmed', '07000 000003', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z'),
    ('call-off', 'pc', '2026-10-22T13:00:00Z', 'cancelled', '07000 000004', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z')`).run();
  assert.equal(await phoneOfCall(), "07969 123456");
  await db.prepare("UPDATE calls SET status = 'done' WHERE id IN ('call-pc', 'call-late')").run();
  assert.equal(await phoneOfCall(), "07000 000002", "of the past ones, the latest");
  await db.prepare("UPDATE calls SET status = 'done' WHERE place_id = 'pc'").run();
  assert.equal(await phoneOfCall(), "01234 567890", "no confirmed call: the lead's phone");
});

test("routes answer in plain English when the database isn't connected", async () => {
  const noDb = { request: req("PATCH", { status: "done" }), env: {}, params: { id: "t-hot" } };
  for (const r of [await patchRoute(noDb), await sendRoute({ ...noDb, request: req("POST", { body: "x" }) }),
    await boardRoute({ request: req("GET"), env: {}, params: {} }), await countRoute({ request: req("GET"), env: {}, params: {} })]) {
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /database isn't connected/);
  }
});

test("the clients query leaves the name `care` free for stage 10's table (its Task 15 LEFT JOINs it here)", async () => {
  const db = seeded();
  db.exec("CREATE TABLE IF NOT EXISTS care (client_id TEXT PRIMARY KEY, guarantee TEXT)");
  const client = (await db.prepare("SELECT id FROM clients ORDER BY id LIMIT 1").first()).id;
  await db.prepare("INSERT OR REPLACE INTO care (client_id, guarantee) VALUES (?, 'working_free')").bind(client).run();
  // Stage 10 Task 15, written as its plan says: one more LEFT JOIN on the table `care`, in this same statement.
  const withCare = CLIENTS_SQL
    .replace("\n  FROM clients c\n", "\n    , cr.guarantee AS care_guarantee\n  FROM clients c\n")
    .replace("\n  WHERE c.place_id IS NULL", "\n  LEFT JOIN care cr ON cr.client_id = c.id\n  WHERE c.place_id IS NULL");
  assert.notEqual(withCare, CLIENTS_SQL);
  const rows = (await db.prepare(withCare).all()).results;
  assert.equal(rows.find((r) => r.id === client).care_guarantee, "working_free");
  // The board's own care fields are unchanged by the name.
  assert.ok(rows.every((r) => "care_title" in r && "care_due_at" in r));
});

// Setup's test client (stage 10, api/sites/test-client.js: notes TEST, a cl_test_ id, place_id NULL) stays off the
// board, through the onboarding, building and live stages; the Sites page still lists it.
test("Setup's test client gets no client card; a real client with notes TEST does", async () => {
  const db = seeded();
  const add = (id, notes) => db.batch([
    db.prepare(`INSERT INTO clients (id, name, place_id, package, build_fee_pence, monthly_pence, free_days, paid_on, notes, created_at)
      VALUES (?, ?, NULL, 'full', 0, 0, 0, '2026-10-20', ?, '2026-10-20T09:00:00Z')`).bind(id, `Client ${id}`, notes),
    db.prepare("INSERT INTO onboarding (client_id, token, status, live_at, created_at) VALUES (?, ?, 'live', '2026-10-21T09:00:00Z', '2026-10-20T09:00:00Z')")
      .bind(id, `${id}-token`.padEnd(32, "t")),
  ]);
  await add("cl_test_ab12cd34ef56", "TEST");
  await add("clxtest_9", "TEST"); // not the test client's id ("_" is no wildcard here)
  const ids = (await loadBoard(db, ENV, NOW)).clients.cards.map((c) => c.client_id);
  assert.ok(!ids.includes("cl_test_ab12cd34ef56"), ids.join(", "));
  assert.ok(ids.includes("clxtest_9"), ids.join(", "));
  assert.ok(ids.includes("c1"), "the real clients are still there");
});
