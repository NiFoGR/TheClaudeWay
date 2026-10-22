// Settings, secrets and todos (overview §6 and §8). Run: node --test control-room/tests/settings-todo.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getSecret, getSetting, secretStatus, setSecret, setSetting } from "../functions/_lib/settings.js";
import { addTodo, closeTodos, groupBoard } from "../functions/_lib/todo.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const row = (DB, id) => DB.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first();
const openDedupes = async (DB) =>
  (await DB.prepare("SELECT dedupe FROM todos WHERE status = 'open' ORDER BY dedupe").all()).results.map((r) => r.dedupe);

// ---------------------------------------------------------------- settings and secrets

test("getSetting gives the fallback until setSetting stores a value", async () => {
  const DB = fakeD1();
  assert.equal(await getSetting(DB, "x", "fb"), "fb");
  assert.equal(await getSetting(DB, "x"), null);
  await setSetting(DB, "x", "1");
  assert.equal(await getSetting(DB, "x", "fb"), "1");
  assert.equal(await getSetting(DB, "x"), "1");
  await setSetting(DB, "x", "2"); // overwrites, one row
  assert.equal(await getSetting(DB, "x"), "2");
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'x'").first("n"), 1);
  await setSetting(DB, "blank", ""); // an empty value is a value, not "missing"
  assert.equal(await getSetting(DB, "blank", "fb"), "");
});

test("settings are plain strings: numbers become text, objects are refused", async () => {
  const DB = fakeD1();
  await setSetting(DB, "n", 3);
  assert.equal(await getSetting(DB, "n"), "3");
  await assert.rejects(setSetting(DB, "obj", { a: 1 }), /JSON\.stringify/);
  await assert.rejects(setSetting(DB, "nothing", undefined), /must be text/);
  await assert.rejects(setSetting(DB, "nothing", null), /must be text/);
  assert.equal(await getSetting(DB, "obj"), null);
  // a Date gets an ISO hint, not the JSON.stringify one (that would store it with quotes)
  const err = await setSetting(DB, "when", new Date("2026-10-21T10:00:00Z")).catch((e) => e);
  assert.match(err.message, /got a Date \(store times as UTC ISO text/);
  assert.doesNotMatch(err.message, /JSON\.stringify/);
  await assert.rejects(setSetting(DB, "flag", true), /must be text, got boolean/); // switches are '1', never true
  assert.equal(await getSetting(DB, "when"), null);
});

test("secrets live under secret:<name>, and secretStatus says only set or not", async () => {
  const DB = fakeD1();
  await setSecret(DB, "agent_token", "abc");
  assert.equal(await DB.prepare("SELECT key FROM settings WHERE key = 'secret:agent_token'").first("key"), "secret:agent_token");
  assert.equal(await DB.prepare("SELECT value FROM settings WHERE key = 'secret:agent_token'").first("value"), "abc");
  assert.equal(await getSecret(DB, "agent_token"), "abc");
  assert.equal(await getSecret(DB, "mailbox:m1"), null);
  const status = await secretStatus(DB, ["agent_token", "mailbox:m1"]);
  assert.deepEqual(status, { agent_token: true, "mailbox:m1": false });
  assert.ok(!JSON.stringify(status).includes("abc"), "never the value");
});

test("secretStatus matches whole names only, and gives only booleans", async () => {
  const DB = fakeD1();
  await setSecret(DB, "mailbox:m10", "pw10");
  await setSecret(DB, "routine:reply:url", "https://api.anthropic.com/v1/claude_code/routines/trig_1/fire");
  const status = await secretStatus(DB, ["mailbox:m1", "mailbox:m10", "routine:reply", "routine:reply:url"]);
  assert.deepEqual(status, { "mailbox:m1": false, "mailbox:m10": true, "routine:reply": false, "routine:reply:url": true });
  assert.ok(Object.values(status).every((v) => typeof v === "boolean"));
  assert.ok(!/pw10|anthropic/.test(JSON.stringify(status)));
});

test("secretStatus: an empty secret counts as not set; no names, no query", async () => {
  const DB = fakeD1();
  await setSecret(DB, "routine:reply:token", "");
  assert.equal(await getSecret(DB, "routine:reply:token"), null);
  // a plain setting with the same name isn't a secret
  await setSetting(DB, "routine:reply:url", "https://example.com");
  assert.deepEqual(await secretStatus(DB, ["routine:reply:token", "routine:reply:url"]), {
    "routine:reply:token": false, "routine:reply:url": false,
  });
  let prepared = 0;
  const counting = { ...DB, prepare: (sql) => (prepared++, DB.prepare(sql)) };
  assert.deepEqual(await secretStatus(counting, []), {});
  assert.equal(prepared, 0);
  // more names than D1's 100 bound values per statement still take one query
  const many = Array.from({ length: 150 }, (_, i) => `mailbox:m${i}`);
  await setSecret(DB, "mailbox:m149", "pw");
  const big = await secretStatus(counting, many);
  assert.equal(prepared, 1);
  assert.equal(Object.keys(big).length, 150);
  assert.equal(big["mailbox:m149"], true);
  assert.equal(big["mailbox:m0"], false);
});

test("a refused secret's error never shows the value", async () => {
  const DB = fakeD1();
  const err = await setSecret(DB, "routine:build:token", { token: "sk-ant-oat01-SECRETVALUE" }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.ok(!err.message.includes("SECRETVALUE"), err.message);
  assert.match(err.message, /routine:build:token/);
  assert.equal(await getSecret(DB, "routine:build:token"), null);
});

// ---------------------------------------------------------------- addTodo and closeTodos

test("two addTodo calls with the same dedupe give an id, then null", async () => {
  const DB = fakeD1();
  const id = await addTodo(DB, { kind: "health", title: "The heartbeat has stopped", link: "/#/setup", dedupe: "health:tick" });
  assert.match(id, UUID);
  assert.equal(await addTodo(DB, { kind: "health", title: "The heartbeat has stopped", dedupe: "health:tick" }), null);
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM todos").first("n"), 1);
});

test("addTodo stores every field, with the table's defaults", async () => {
  const DB = fakeD1();
  const id = await addTodo(DB, {
    kind: "hot", title: "Call now", detail: "Opened 3 times", link: "/#/lead/p1", place_id: "p1", client_id: "c1",
    draft: "Hi Sam,", due_at: "2026-10-24T10:00:00Z", dedupe: "hot:p1:views",
  });
  const r = await row(DB, id);
  assert.deepEqual(
    [r.kind, r.title, r.detail, r.link, r.place_id, r.client_id, r.draft, r.due_at, r.dedupe, r.status, r.done_at],
    ["hot", "Call now", "Opened 3 times", "/#/lead/p1", "p1", "c1", "Hi Sam,", "2026-10-24T10:00:00Z", "hot:p1:views", "open", null],
  );
  assert.match(r.created_at, ISO);
  const bare = await row(DB, await addTodo(DB, { kind: "setup", title: "Add your first mailbox", detail: null }));
  assert.deepEqual([bare.detail, bare.link, bare.place_id, bare.due_at, bare.dedupe, bare.status], ["", null, null, null, null, "open"]);
  // a Date due_at is stored as UTC ISO text
  const dated = await row(DB, await addTodo(DB, { kind: "kpi", title: "Numbers", due_at: new Date("2026-10-26T08:00:00.000Z") }));
  assert.equal(dated.due_at, "2026-10-26T08:00:00Z");
});

test("addTodo stores due_at as UTC ISO without milliseconds, and refuses a time it can't read", async () => {
  const DB = fakeD1();
  const due = async (due_at) => (await row(DB, await addTodo(DB, { kind: "call", title: "t", due_at }))).due_at;
  assert.equal(await due("2026-10-26T08:00:00.000Z"), "2026-10-26T08:00:00Z"); // toISOString() text
  assert.equal(await due("2026-10-23T11:00:00+01:00"), "2026-10-23T10:00:00Z"); // an offset becomes UTC
  assert.equal(await due(""), null);
  assert.equal(await due(undefined), null);
  // no zone, no time, words, an invalid Date, a number, and days/times that don't exist (Date.parse would roll
  // 30 Feb over to 2 Mar and read 24:00 as the next day)
  for (const bad of ["2026-10-26 08:00", "2026-10-26", "tomorrow", new Date("nope"), 1761465600000,
    "2026-02-30T08:00:00Z", "2026-02-29T08:00:00Z", "2026-10-26T24:00:00Z", "2026-10-26T08:60:00Z"]) {
    await assert.rejects(addTodo(DB, { kind: "call", title: "t", due_at: bad }), /due_at must be a Date or UTC ISO text/);
  }
  assert.equal(await due("2028-02-29T08:00:00Z"), "2028-02-29T08:00:00Z"); // a real leap day
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM todos").first("n"), 5);
});

test("addTodo refuses an empty or non-text dedupe (an empty one would swallow every later todo)", async () => {
  const DB = fakeD1();
  for (const dedupe of ["", 5, true, {}]) {
    await assert.rejects(addTodo(DB, { kind: "health", title: "t", dedupe }), /dedupe must be text/);
  }
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM todos").first("n"), 0);
  assert.match(await addTodo(DB, { kind: "health", title: "t", dedupe: null }), UUID); // null means none
  assert.match(await addTodo(DB, { kind: "health", title: "t", dedupe: null }), UUID);
});

test("each settings and todo helper is one D1 query", async () => {
  const DB = fakeD1();
  let prepared = 0;
  const counting = { ...DB, prepare: (sql) => (prepared++, DB.prepare(sql)) };
  const one = async (call) => {
    prepared = 0;
    await call();
    assert.equal(prepared, 1, call.toString());
  };
  await one(() => setSetting(counting, "x", "1"));
  await one(() => getSetting(counting, "x"));
  await one(() => setSecret(counting, "agent_token", "abc"));
  await one(() => getSecret(counting, "agent_token"));
  await one(() => secretStatus(counting, ["agent_token", "mailbox:m1"]));
  await one(() => addTodo(counting, { kind: "health", title: "t", dedupe: "health:tick" }));
  await one(() => addTodo(counting, { kind: "health", title: "t", dedupe: "health:tick" }));
  await one(() => closeTodos(counting, "health:"));
});

test("settings.js and todo.js use nothing Node-only (they run on Cloudflare Workers)", () => {
  for (const file of ["settings.js", "todo.js"]) {
    const src = readFileSync(new URL(`../functions/_lib/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /from\s+["']node:|\brequire\(|\bprocess\.|\bBuffer\b|\bfrom\s+["'][^"']*legacy\//, file);
  }
});

test("todos without a dedupe are all added", async () => {
  const DB = fakeD1();
  assert.match(await addTodo(DB, { kind: "escalation", title: "a" }), UUID);
  assert.match(await addTodo(DB, { kind: "escalation", title: "a" }), UUID);
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM todos").first("n"), 2);
});

test("addTodo refuses a todo without a kind or title (INSERT OR IGNORE would drop it silently)", async () => {
  const DB = fakeD1();
  await assert.rejects(addTodo(DB, { kind: "health", dedupe: "health:x" }), /kind and a title/);
  await assert.rejects(addTodo(DB, { title: "x" }), /kind and a title/);
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM todos").first("n"), 0);
});

test("closeTodos closes, frees the dedupe, and the todo can be added again", async () => {
  const DB = fakeD1();
  const first = await addTodo(DB, { kind: "health", title: "t", dedupe: "health:tick" });
  assert.equal(await closeTodos(DB, "health:tick"), 1);
  const closed = await row(DB, first);
  assert.equal(closed.status, "done");
  assert.match(closed.done_at, ISO);
  assert.equal(closed.dedupe, `health:tick@${closed.done_at}`);
  const again = await addTodo(DB, { kind: "health", title: "t", dedupe: "health:tick" });
  assert.match(again, UUID);
  assert.notEqual(again, first);
  assert.equal(await closeTodos(DB, "health:tick"), 1);
  assert.equal(await closeTodos(DB, "health:tick"), 0); // nothing open left
});

test("closing the same re-added todo twice in a row never collides on the dedupe", async () => {
  const DB = fakeD1();
  for (let i = 0; i < 20; i++) {
    await addTodo(DB, { kind: "health", title: "t", dedupe: "health:relay" });
    assert.equal(await closeTodos(DB, "health:relay"), 1);
  }
  const { n, unique } = await DB.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT dedupe) AS \"unique\" FROM todos").first();
  assert.deepEqual([n, unique], [20, 20]);
});

test("a dismissed todo isn't re-added, and closeTodos leaves it alone", async () => {
  const DB = fakeD1();
  const id = await addTodo(DB, { kind: "setup", title: "Add your name and business address", dedupe: "setup:business" });
  await DB.prepare("UPDATE todos SET status = 'dismissed' WHERE id = ?").bind(id).run();
  assert.equal(await addTodo(DB, { kind: "setup", title: "Add your name and business address", dedupe: "setup:business" }), null);
  assert.equal(await closeTodos(DB, "setup:business"), 0);
  const r = await row(DB, id);
  assert.deepEqual([r.status, r.dedupe], ["dismissed", "setup:business"]);
});

test("closeTodos matches by prefix (health:tick also closes health:tickle), and % or _ are literal", async () => {
  const DB = fakeD1();
  for (const dedupe of ["health:tick", "health:tickle", "health:relay", "a_b:1", "axb:1", "50%:x", "50x:x"]) {
    await addTodo(DB, { kind: "health", title: dedupe, dedupe });
  }
  assert.equal(await closeTodos(DB, "health:tick"), 2);
  assert.deepEqual(await openDedupes(DB), ["50%:x", "50x:x", "a_b:1", "axb:1", "health:relay"]);
  assert.equal(await closeTodos(DB, "a_b"), 1);
  assert.equal(await closeTodos(DB, "50%"), 1);
  assert.deepEqual(await openDedupes(DB), ["50x:x", "axb:1", "health:relay"]);
});

test("closeTodos leaves todos without a dedupe, todos Nik marked done, and other cases alone", async () => {
  const DB = fakeD1();
  const plain = await addTodo(DB, { kind: "escalation", title: "no dedupe" });
  const nikDone = await addTodo(DB, { kind: "hot", title: "done by Nik", dedupe: "hot:p1:2026-10-20" });
  await DB.prepare("UPDATE todos SET status = 'done', done_at = '2026-10-20T10:00:00Z' WHERE id = ?").bind(nikDone).run();
  await addTodo(DB, { kind: "health", title: "upper", dedupe: "Health:tick" });
  assert.equal(await closeTodos(DB, "hot:p1:"), 0);
  assert.equal(await closeTodos(DB, "health:tick"), 0); // case matters
  assert.deepEqual([(await row(DB, plain)).status, (await row(DB, plain)).dedupe], ["open", null]);
  const r = await row(DB, nikDone);
  assert.deepEqual([r.status, r.dedupe, r.done_at], ["done", "hot:p1:2026-10-20", "2026-10-20T10:00:00Z"]);
});

test("closeTodos closes every match in one go, each with its own freed dedupe", async () => {
  const DB = fakeD1();
  for (const key of ["a", "b", "c"]) await addTodo(DB, { kind: "care", title: key, dedupe: `care:c1:${key}` });
  await addTodo(DB, { kind: "care", title: "other client", dedupe: "care:c10:a" });
  assert.equal(await closeTodos(DB, "care:c1:"), 3);
  const closed = (await DB.prepare("SELECT dedupe, done_at FROM todos WHERE status = 'done' ORDER BY dedupe").all()).results;
  assert.deepEqual(closed.map((t) => t.dedupe), ["a", "b", "c"].map((k) => `care:c1:${k}@${closed[0].done_at}`));
  assert.ok(closed.every((t) => t.done_at === closed[0].done_at));
  assert.deepEqual(await openDedupes(DB), ["care:c10:a"]);
});

test("closeTodos refuses an empty prefix rather than closing everything", async () => {
  const DB = fakeD1();
  await addTodo(DB, { kind: "health", title: "t", dedupe: "health:tick" });
  await assert.rejects(closeTodos(DB, ""), /prefix/);
  await assert.rejects(closeTodos(DB, undefined), /prefix/);
  assert.deepEqual(await openDedupes(DB), ["health:tick"]);
});

// ---------------------------------------------------------------- groupBoard (pure)

const open = (id, due_at, created_at = "2026-10-20T09:00:00Z") => ({ id, status: "open", due_at, created_at });
const ids = (list) => list.map((r) => r.id);

test("groupBoard splits open todos at the UK day's start and end", () => {
  const now = new Date("2026-10-24T12:00:00Z"); // Saturday in BST: the UK day runs 2026-10-23T23:00Z to 2026-10-24T23:00Z
  const b = groupBoard([
    open("fri", "2026-10-23T22:00:00Z"), // Fri 23:00 UK
    open("sat", "2026-10-23T23:30:00Z"), // Sat 00:30 UK
    open("none", null),
    open("sun", "2026-10-25T09:00:00Z"), // Sunday
    { ...open("done", "2026-10-24T10:00:00Z"), status: "done" },
    { ...open("dismissed", null), status: "dismissed" },
  ], now);
  assert.deepEqual(Object.keys(b).sort(), ["later", "overdue", "today"]);
  assert.ok(ids(b.overdue).includes("fri"));
  assert.ok(ids(b.today).includes("sat"));
  assert.ok(ids(b.today).includes("none"));
  assert.ok(ids(b.later).includes("sun"));
  assert.deepEqual(ids([...b.overdue, ...b.today, ...b.later]).sort(), ["fri", "none", "sat", "sun"]);
});

test("groupBoard edges: exactly midnight UK, and the 25-hour day the clocks go back", () => {
  const sat = groupBoard([
    open("before", "2026-10-23T22:59:59Z"),
    open("start", "2026-10-23T23:00:00Z"), // Sat 00:00 BST
    open("last", "2026-10-24T22:59:59Z"), // Sat 23:59:59 BST
    open("next", "2026-10-24T23:00:00Z"), // Sun 00:00 BST
  ], new Date("2026-10-24T12:00:00Z"));
  assert.deepEqual([ids(sat.overdue), ids(sat.today), ids(sat.later)], [["before"], ["start", "last"], ["next"]]);
  // Sunday 25 Oct is 25 hours long: 2026-10-24T23:00Z (00:00 BST) to 2026-10-26T00:00Z (Mon 00:00 GMT)
  const sun = groupBoard([
    open("sat-late", "2026-10-24T22:59:00Z"),
    open("sun-late", "2026-10-25T23:30:00Z"), // Sun 23:30 GMT
    open("mon", "2026-10-26T00:00:00Z"),
  ], "2026-10-25T12:00:00Z");
  assert.deepEqual([ids(sun.overdue), ids(sun.today), ids(sun.later)], [["sat-late"], ["sun-late"], ["mon"]]);
});

test("groupBoard on the 23-hour day the clocks go forward (29 Mar)", () => {
  // Sunday 29 Mar runs 2026-03-29T00:00Z (00:00 GMT) to 2026-03-29T23:00Z (Mon 00:00 BST)
  const b = groupBoard([
    open("sat", "2026-03-28T23:59:59Z"),
    open("start", "2026-03-29T00:00:00Z"),
    open("late", "2026-03-29T22:59:59Z"), // Sun 23:59:59 BST
    open("mon", "2026-03-29T23:00:00Z"), // Mon 00:00 BST
  ], new Date("2026-03-29T12:00:00Z"));
  assert.deepEqual([ids(b.overdue), ids(b.today), ids(b.later)], [["sat"], ["start", "late"], ["mon"]]);
});

test("groupBoard leaves its input alone, and a row with no due_at field is today", () => {
  const rows = [open("later", "2026-10-30T09:00:00Z"), { id: "bare", status: "open" }, open("over", "2026-10-01T09:00:00Z")];
  const copy = structuredClone(rows);
  const b = groupBoard(rows, new Date("2026-10-24T12:00:00Z"));
  assert.deepEqual(rows, copy);
  assert.deepEqual([ids(b.overdue), ids(b.today), ids(b.later)], [["over"], ["bare"], ["later"]]);
});

test("groupBoard on rows read back from D1: addTodo's due_at lands in the right group, closed ones drop out", async () => {
  const DB = fakeD1();
  const now = new Date("2026-10-24T12:00:00Z"); // Saturday, BST
  await addTodo(DB, { kind: "call", title: "fri", due_at: new Date("2026-10-23T22:00:00Z") }); // Fri 23:00 UK
  await addTodo(DB, { kind: "call", title: "sat", due_at: "2026-10-24T00:30:00+01:00" }); // Sat 00:30 UK
  await addTodo(DB, { kind: "setup", title: "none" });
  await addTodo(DB, { kind: "kpi", title: "mon", due_at: new Date("2026-10-26T08:00:00Z") });
  await addTodo(DB, { kind: "health", title: "closed", dedupe: "health:relay" });
  await closeTodos(DB, "health:relay");
  const { results } = await DB.prepare("SELECT * FROM todos").all();
  const b = groupBoard(results, now);
  const titles = (list) => list.map((r) => r.title);
  assert.deepEqual([titles(b.overdue), titles(b.today), titles(b.later)], [["fri"], ["sat", "none"], ["mon"]]);
});

test("groupBoard sorts each group by due_at (none last), then created_at", () => {
  const b = groupBoard([
    open("a", "2026-10-24T10:00:00Z", "2026-10-22T02:00:00Z"),
    open("c", null, "2026-10-22T09:00:00Z"),
    open("b", "2026-10-24T09:00:00.000Z", "2026-10-22T05:00:00Z"),
    open("d", null, "2026-10-22T08:00:00Z"),
    open("e", "2026-10-24T10:00:00.000Z", "2026-10-22T01:00:00Z"),
    open("o2", "2026-10-21T09:00:00Z"),
    open("o1", "2026-10-20T09:00:00Z"),
  ], new Date("2026-10-24T12:00:00Z"));
  assert.deepEqual(ids(b.today), ["b", "e", "a", "d", "c"]);
  assert.deepEqual(ids(b.overdue), ["o1", "o2"]);
  assert.deepEqual(b.later, []);
});
