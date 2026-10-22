// The shared fake D1 (node:sqlite behind D1's shape). Run: node --test control-room/tests/fakeD1.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { fakeD1 } from "./helpers/fakeD1.mjs";

const count = (DB, table = "settings") => DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n");

test("shape matches D1", async () => {
  const DB = fakeD1();
  const res = await DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind("k", "v").run();
  assert.ok(res.meta.changes === 1);
  assert.equal(typeof res.meta.last_row_id, "number");
  const sel = DB.prepare("SELECT key, value FROM settings WHERE key = ?").bind("k");
  assert.ok((await sel.first("value")) === "v");
  assert.deepStrictEqual(await sel.first(), { key: "k", value: "v" });
  assert.deepStrictEqual((await sel.all()).results, [{ key: "k", value: "v" }]);
  assert.deepStrictEqual((await DB.prepare("SELECT key, value FROM settings").all()).results, [{ key: "k", value: "v" }]);
  assert.equal(await DB.prepare("SELECT value FROM settings WHERE key = 'missing'").first(), null);
  assert.equal(await DB.prepare("SELECT value FROM settings WHERE key = 'missing'").first("value"), null);
  await assert.rejects(sel.first("nope"), /D1_COLUMN_NOTFOUND: Column not found \(nope\)/);
  // a SELECT changes nothing, even right after a write
  assert.equal((await sel.run()).meta.changes, 0);
  // bind() returns a new statement; the unbound one is untouched
  const ins = DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  await ins.bind("a", "1").run();
  await ins.bind("b", "2").run();
  assert.equal(await count(DB), 3);
  const upd = await DB.prepare("UPDATE settings SET value = 'x' WHERE key IN ('a', 'b')").run();
  assert.equal(upd.meta.changes, 2);
  assert.equal(upd.success, true);
  // RETURNING rows come back from run() and first(), as on D1
  const ret = await DB.prepare("UPDATE settings SET value = ? WHERE key = ? RETURNING value").bind("y", "a").first("value");
  assert.equal(ret, "y");
});

test("booleans bind as 1/0", async () => {
  const DB = fakeD1({ schema: false });
  await DB.exec("CREATE TABLE b (x)");
  await DB.prepare("INSERT INTO b (x) VALUES (?)").bind(true).run();
  await DB.prepare("INSERT INTO b (x) VALUES (?)").bind(false).run();
  assert.deepStrictEqual((await DB.prepare("SELECT x, typeof(x) AS t FROM b ORDER BY rowid").all()).results,
    [{ x: 1, t: "integer" }, { x: 0, t: "integer" }]);
});

test("whole numbers bind as integers, like D1 (a TEXT column gets '1', not '1.0')", async () => {
  const DB = fakeD1();
  await DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind("n", 1).run();
  await DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind("t", true).run();
  await DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind("r", 1.5).run();
  assert.equal(await DB.prepare("SELECT value FROM settings WHERE key = 'n'").first("value"), "1");
  assert.equal(await DB.prepare("SELECT value FROM settings WHERE key = 't'").first("value"), "1");
  assert.equal(await DB.prepare("SELECT value FROM settings WHERE key = 'r'").first("value"), "1.5");
});

test("values travel the way D1 sends them: NaN as NULL, bytes as BLOBs read back as arrays, big integers as numbers", async () => {
  const DB = fakeD1();
  assert.deepStrictEqual(await DB.prepare("SELECT ? AS v, typeof(?) AS t").bind(NaN, NaN).first(), { v: null, t: "null" });
  const blob = await DB.prepare("SELECT ? AS a, ? AS b, ? AS c, typeof(?) AS t")
    .bind([1, 2], new Uint8Array([3, 4]).buffer, new Uint8Array([5, 6]), [7]).first();
  assert.deepStrictEqual(blob, { a: [1, 2], b: [3, 4], c: [5, 6], t: "blob" });
  assert.equal(await DB.prepare("SELECT 9007199254740993 AS n").first("n"), 9007199254740992);
});

test("bind() refuses what D1's bind() refuses", () => {
  const DB = fakeD1();
  const s = DB.prepare("SELECT ?");
  assert.throws(() => s.bind(undefined), /D1_TYPE_ERROR: Type 'undefined' not supported/);
  assert.throws(() => s.bind(new Date("2026-10-21T00:00:00Z")), /D1_TYPE_ERROR: Type 'object'/);
  assert.throws(() => s.bind(1n), /D1_TYPE_ERROR: Type 'bigint'/);
  assert.throws(() => s.bind({ a: 1 }), /D1_TYPE_ERROR/);
  assert.throws(() => s.bind([1, 300]), /D1_TYPE_ERROR/);
});

test("a statement D1 would reject fails here too, and writes nothing", async () => {
  const DB = fakeD1();
  const ins = "INSERT INTO settings (key, value) VALUES (?, ?)";
  // the wrong number of bound values (node:sqlite alone would quietly bind a missing one as NULL)
  await assert.rejects(DB.prepare(ins).bind("k").run(), /Wrong number of parameter bindings/);
  await assert.rejects(DB.prepare(ins).run(), /Wrong number of parameter bindings for SQL query\. \(0 bound\)/);
  await assert.rejects(DB.prepare(ins).bind("k", "v", "x").run(), /Wrong number of parameter bindings/);
  await assert.rejects(DB.prepare("SELECT ?").first(), /Wrong number/);
  assert.equal(await DB.prepare("SELECT ?1 AS a, ?1 AS b").bind(7).first("b"), 7);
  assert.equal(await DB.prepare("SELECT 'what?' AS q").first("q"), "what?");
  // D1 allows 100 bound values per statement (why the health step splits its INSERT every 15 rows)
  const marks = (n) => Array(n).fill("?").join(", ");
  assert.equal((await DB.prepare(`SELECT ${marks(100)}`).bind(...Array(100).fill(1)).all()).results.length, 1);
  await assert.rejects(DB.prepare(`SELECT ${marks(101)}`).bind(...Array(101).fill(1)).all(), /too many SQL variables/);
  // transactions only through batch()
  await assert.rejects(DB.prepare("BEGIN TRANSACTION").run(), /use .*batch|batch/);
  await assert.rejects(DB.prepare("-- note\n  commit").run(), /batch/);
  await assert.rejects(DB.prepare("SAVEPOINT s1").run(), /batch/);
  // empty SQL, and D1's size limits
  await assert.rejects(DB.prepare("  -- nothing\n").run(), /No SQL statements detected/);
  await assert.rejects(DB.prepare(`SELECT '${"x".repeat(100_001)}'`).run(), /Statement too long/);
  await assert.rejects(DB.prepare(ins).bind("big", "x".repeat(2_000_001)).run(), /string or blob too big/);
  await DB.prepare(ins).bind("raw", "x".repeat(262_144)).run(); // the inbound raw cap fits
  assert.equal(await count(DB), 1);
});

test("one statement per prepare(): the rest isn't quietly dropped", async () => {
  const DB = fakeD1({ schema: false });
  await DB.exec("CREATE TABLE t (a)");
  await assert.rejects(DB.prepare("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)").run(),
    /D1_ERROR: A prepared SQL statement must contain only one statement: .*DB\.batch/);
  await assert.rejects(DB.prepare("INSERT INTO t VALUES (?);\nDELETE FROM t").bind(1).run(), /only one statement/);
  assert.equal(await count(DB, "t"), 0);
  // a trailing semicolon or comment is still one statement
  assert.equal(await DB.prepare("SELECT 1 AS x;").first("x"), 1);
  assert.equal(await DB.prepare("SELECT 'a;b' AS x ; -- done\n;").first("x"), "a;b");
  assert.equal((await DB.prepare("INSERT INTO t VALUES (?); /* one */").bind(3).run()).meta.changes, 1);
});

test("raw() gives rows as arrays, with the column names first on request", async () => {
  const DB = fakeD1();
  await DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind("k", "v").run();
  const sel = DB.prepare("SELECT key, value, 2 AS n FROM settings WHERE key = ?");
  assert.deepStrictEqual(await sel.bind("k").raw(), [["k", "v", 2]]);
  assert.deepStrictEqual(await sel.bind("k").raw({ columnNames: true }), [["key", "value", "n"], ["k", "v", 2]]);
  assert.deepStrictEqual(await sel.bind("missing").raw({ columnNames: true }), [["key", "value", "n"]]);
  assert.deepStrictEqual(await sel.bind("missing").raw(), []);
  await assert.rejects(sel.raw(), /Wrong number of parameter bindings/);
});

test("SQLite's errors read like D1's", async () => {
  const DB = fakeD1();
  await assert.rejects(DB.prepare("SELECT * FROM nowhere").all(), (err) => {
    assert.equal(err.message, "D1_ERROR: no such table: nowhere: SQLITE_ERROR");
    return true;
  });
  const ins = DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  await ins.bind("k", "v").run();
  await assert.rejects(ins.bind("k", "secret-value").run(), (err) => {
    assert.equal(err.message, "D1_ERROR: UNIQUE constraint failed: settings.key: SQLITE_CONSTRAINT");
    return true; // and the bound value never appears in the error
  });
  await assert.rejects(DB.batch([ins.bind("j", "v"), ins.bind("k", "v")]), /^Error: D1_ERROR: UNIQUE constraint failed: settings\.key: SQLITE_CONSTRAINT$/);
  assert.equal(await count(DB), 1);
});

test("foreign keys are enforced, as on D1", async () => {
  const DB = fakeD1({ schema: false });
  await DB.exec("CREATE TABLE p (id TEXT PRIMARY KEY); CREATE TABLE c (pid TEXT REFERENCES p(id));");
  await assert.rejects(DB.prepare("INSERT INTO c VALUES (?)").bind("nobody").run(), /FOREIGN KEY/);
});

test("meta.changes counts only the rows the statement itself changed", async () => {
  const DB = fakeD1({ schema: false });
  await DB.exec(`CREATE TABLE t (a); CREATE TABLE log (x);
    CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES (1); INSERT INTO log VALUES (2); END;`);
  const res = await DB.prepare("INSERT INTO t VALUES (?)").bind(1).run();
  assert.equal(res.meta.changes, 1);
  assert.equal(res.meta.changed_db, true);
  assert.equal(await count(DB, "log"), 2);
  assert.equal((await DB.prepare("UPDATE t SET a = 2 WHERE a = 99").run()).meta.changes, 0);
  assert.equal((await DB.prepare("SELECT * FROM t").run()).meta.changes, 0);
});

test("batch is atomic", async () => {
  const DB = fakeD1();
  const ins = (k) => DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind(k, "v");
  await assert.rejects(DB.batch([ins("k"), DB.prepare("INSERT INTO nowhere VALUES (1)")]));
  assert.equal(await count(DB), 0);
  // a syntax error, and a constraint failure after a good write, roll back the same way
  await assert.rejects(DB.batch([ins("k"), DB.prepare("INSERT INTO settings VALUES (,)")]), /syntax error/);
  await assert.rejects(DB.batch([ins("k"), ins("k")]), /UNIQUE constraint failed/);
  await assert.rejects(DB.batch([ins("k"), DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind("j")]), /Wrong number/);
  assert.equal(await count(DB), 0);
  // anything that isn't a statement is refused before anything runs
  await assert.rejects(DB.batch([ins("k"), { run: async () => ({}) }]), /takes statements made by DB.prepare/);
  assert.equal(await count(DB), 0);
  // a good batch commits, returning one {results, meta} per statement
  const out = await DB.batch([ins("k"), DB.prepare("SELECT key, value FROM settings")]);
  assert.equal(out.length, 2);
  assert.equal(out[0].meta.changes, 1);
  assert.deepStrictEqual(out[0].results, []);
  assert.deepStrictEqual(out[1].results, [{ key: "k", value: "v" }]);
  assert.equal(out[1].meta.changes, 0);
  // the database is still usable after a rolled-back batch
  assert.equal(await count(DB), 1);
  // a rolled-back batch also undoes its updates, and booleans bind as 1/0 inside a batch too
  const set = (v) => DB.prepare("UPDATE settings SET value = ? WHERE key = 'k'").bind(v);
  await assert.rejects(DB.batch([set("changed"), DB.prepare("INSERT INTO nowhere VALUES (1)")]), /no such table/);
  assert.equal(await DB.prepare("SELECT value FROM settings WHERE key = 'k'").first("value"), "v");
  await DB.batch([set(true)]);
  assert.equal(await DB.prepare("SELECT value FROM settings WHERE key = 'k'").first("value"), "1");
  await DB.batch([set("v")]);
  // like D1, batch() reads each statement's `statement` and `params`, so a wrapper passing those through works
  const copy = { ...ins("j"), run: async () => assert.fail("batch must not call the wrapper's run()") };
  await DB.batch([copy]);
  assert.equal(await count(DB), 2);
});

test("schema applied", async () => {
  const DB = fakeD1();
  const row = await DB.prepare("SELECT name FROM sqlite_master WHERE name='settings'").first();
  assert.deepStrictEqual(row, { name: "settings" });
  assert.equal(DB.raw.prepare("SELECT name FROM sqlite_master WHERE name='settings'").get()?.name, "settings");
});

test("schema:false gives an empty db", async () => {
  const DB = fakeD1({ schema: false });
  assert.deepStrictEqual((await DB.prepare("SELECT name FROM sqlite_master").all()).results, []);
});

test("exec runs several statements", async () => {
  const DB = fakeD1();
  await DB.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);");
  const { n } = await DB.prepare("SELECT COUNT(*) AS n FROM t").first();
  assert.ok(n === 2);
  await assert.rejects(DB.exec("INSERT INTO nowhere VALUES (1);"), /no such table/);
});
