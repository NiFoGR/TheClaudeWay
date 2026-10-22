// The rebuild's tables (overview §4) and db()'s version gate. Run: node --test control-room/tests/schema.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { SCHEMA as LIVE_SCHEMA } from "../../legacy/control-room/functions/_lib/schema.js";
import { countingDB } from "../functions/_lib/d1count.js";
import { SCHEMA, SCHEMA_VERSION } from "../functions/_lib/schema.js";
import { fakeD1 } from "./helpers/fakeD1.mjs";

// db() remembers per isolate that the schema is ready, so each import with a new query string is a new isolate.
let isolates = 0;
const newIsolate = () => import(`../functions/_lib/util.js?isolate=${++isolates}`);

// Counts what db() asks of D1. The statements themselves are the fake's own, so batch() still accepts them.
function counted(DB) {
  const calls = { prepare: 0, batch: 0 };
  const wrapped = {
    ...DB,
    prepare: (sql) => {
      calls.prepare++;
      return DB.prepare(sql);
    },
    batch: (stmts) => {
      calls.batch++;
      return DB.batch(stmts);
    },
  };
  return { DB: wrapped, calls };
}

const storedVersion = (DB) => DB.prepare("SELECT value FROM settings WHERE key='schema:version'").first("value");
const tableExists = async (DB, name) =>
  !!(await DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first());
const columns = async (DB, table) => (await DB.prepare(`PRAGMA table_info(${table})`).all()).results.map((c) => c.name);
// A brand-new database needs two calls: its 52 statements don't fit in one invocation's 50 D1 queries.
const migrate = async (db, env) => {
  await db(env);
  await db(env);
};
// The live database before stage 0: the old system's 29 statements (legacy/ is that system, frozen), no version.
const liveDB = () => {
  const DB = fakeD1({ schema: false });
  LIVE_SCHEMA.forEach((sql) => DB.raw.exec(sql));
  return DB;
};

test("SCHEMA_VERSION is 12 hex characters", () => {
  assert.match(SCHEMA_VERSION, /^[0-9a-f]{12}$/);
  assert.ok(SCHEMA.length >= 52, `${SCHEMA.length} statements`);
});

test("db() applies the schema once per version", async () => {
  const DB = fakeD1({ schema: false });
  const env = { DB };
  const { db } = await newIsolate();
  assert.equal(await db(env), DB);
  assert.equal(await db(env), DB);
  assert.ok(await tableExists(DB, "todos"));
  assert.equal(await storedVersion(DB), SCHEMA_VERSION);

  // A new isolate on a database already at this version: 1 query, no batch.
  const same = counted(DB);
  const second = await newIsolate();
  assert.equal(await second.db({ DB: same.DB }), same.DB);
  assert.deepEqual(same.calls, { prepare: 1, batch: 0 });
  // The same isolate again: no queries at all.
  await second.db({ DB: same.DB });
  assert.deepEqual(same.calls, { prepare: 1, batch: 0 });

  // The schema changed (an older version is stored, a table is new): the batch runs once and the new version is written.
  await DB.exec("DROP TABLE todos");
  await DB.prepare("UPDATE settings SET value='000000000000' WHERE key='schema:version'").run();
  const changed = counted(DB);
  const third = await newIsolate();
  await third.db({ DB: changed.DB });
  assert.equal(changed.calls.batch, 1);
  assert.ok(await tableExists(DB, "todos"));
  assert.equal(await storedVersion(DB), SCHEMA_VERSION);
  await third.db({ DB: changed.DB });
  assert.equal(changed.calls.batch, 1);
});

test("db() on an empty database counts the failed version read as a mismatch", async () => {
  const DB = fakeD1({ schema: false });
  await assert.rejects(storedVersion(DB), /no such table: settings/);
  const c = counted(DB);
  const { db } = await newIsolate();
  await migrate(db, { DB: c.DB });
  assert.equal(c.calls.batch, 2);
  assert.equal(await storedVersion(DB), SCHEMA_VERSION);
});

test("db() on the live database (the old tables, no version yet) keeps every row", async () => {
  const DB = liveDB();
  await DB.exec(
    "INSERT INTO leads (place_id, name, trade, search_town, first_seen_at, updated_at) VALUES ('p1', 'Smith Roofing', 'roofer', 'Leeds', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');" +
      "INSERT INTO settings (key, value) VALUES ('territory', '{\"towns\":[\"Leeds\"]}');",
  );
  const c = counted(DB);
  const { db } = await newIsolate();
  await db({ DB: c.DB });
  assert.equal(c.calls.batch, 1);
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM leads").first("n"), 1);
  assert.equal(await DB.prepare("SELECT value FROM settings WHERE key='territory'").first("value"), '{"towns":["Leeds"]}');
  assert.equal(await storedVersion(DB), SCHEMA_VERSION);
});

test("db() tries again on the next call when the schema batch fails", async () => {
  const DB = fakeD1({ schema: false });
  let failures = 1;
  const flaky = {
    ...DB,
    batch: (stmts) => (failures-- > 0 ? Promise.reject(new Error("D1_ERROR: network connection lost")) : DB.batch(stmts)),
  };
  const { db } = await newIsolate();
  await assert.rejects(db({ DB: flaky }), /network connection lost/);
  assert.equal(await tableExists(DB, "settings"), false);
  await migrate(db, { DB: flaky });
  assert.ok(await tableExists(DB, "todos"));
  assert.equal(await storedVersion(DB), SCHEMA_VERSION);
});

test("db() without a DB binding says how to connect it", async () => {
  const { db } = await newIsolate();
  await assert.rejects(db({}), /The database isn't connected\. In Cloudflare: your Pages project → Settings → Bindings → add D1 database, variable name DB, then redeploy\./);
});

// ---------------------------------------------------------------- the migration stays inside one invocation's 50 queries
// The free plan allows 50 D1 queries per invocation, and each statement in a batch may count as one. The first call
// after a deploy that changes the schema must fit, or it fails every time and the whole Control Room with it.

test("every schema statement is CREATE TABLE|INDEX IF NOT EXISTS <name>, so db() can tell what's missing", async () => {
  const { schemaObject } = await newIsolate();
  const names = SCHEMA.map((sql) => schemaObject(sql));
  for (const [i, name] of names.entries()) assert.match(name ?? "", /^(table|index):\w+$/, SCHEMA[i].slice(0, 80));
  assert.equal(new Set(names).size, names.length, "two statements create the same thing");
  assert.equal(schemaObject("ALTER TABLE leads ADD COLUMN x TEXT"), null);
});

test("migrating the live database (old 29 statements, no version) runs only the 23 new ones: 26 queries", async () => {
  assert.equal(LIVE_SCHEMA.length, 29);
  const DB = liveDB();
  await DB.exec("INSERT INTO leads (place_id, name, trade, search_town, first_seen_at, updated_at) VALUES ('p1', 'Smith Roofing', 'roofer', 'Leeds', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
  const c = countingDB(DB);
  const { db, schemaObject } = await newIsolate();
  const report = {};
  await db({ DB: c.DB }, report);
  assert.equal(c.used(), 1 + 1 + 23 + 1, "version read, sqlite_master, the 23 new statements, version write");
  assert.ok(c.used() <= 50);
  assert.deepEqual(report, { migrated: 25, created: 23 }, "what the migration itself ran, after the version read");
  assert.equal(await storedVersion(DB), SCHEMA_VERSION);
  for (const sql of SCHEMA) {
    const [type, name] = schemaObject(sql).split(":");
    assert.ok(await DB.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = ? AND name = ?").bind(type, name).first(), name);
  }
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM leads").first("n"), 1);
  // Done: the next call in this isolate runs nothing and reports no migration.
  await db({ DB: c.DB }, report);
  assert.equal(c.used(), 26);
  assert.deepEqual(report, { migrated: 0, created: 0 });
});

test("a brand-new database is set up over two calls, each within 50 queries", async () => {
  const DB = fakeD1({ schema: false });
  const { db, MIGRATION_MAX } = await newIsolate();
  assert.ok(MIGRATION_MAX + 3 <= 50, "the version read, sqlite_master and the version write fit beside the batch");
  const first = countingDB(DB);
  const r1 = {};
  await db({ DB: first.DB }, r1);
  assert.ok(first.used() <= 50, String(first.used()));
  assert.equal(first.used(), 1 + 1 + MIGRATION_MAX);
  assert.deepEqual(r1, { migrated: 1 + MIGRATION_MAX, created: MIGRATION_MAX });
  assert.equal(await storedVersion(DB), null, "the version waits until nothing is missing");
  const second = countingDB(DB);
  const r2 = {};
  await db({ DB: second.DB }, r2);
  assert.ok(second.used() <= 50, String(second.used()));
  assert.equal(second.used(), 1 + 1 + (SCHEMA.length - MIGRATION_MAX) + 1);
  assert.deepEqual(r2, { migrated: 1 + (SCHEMA.length - MIGRATION_MAX) + 1, created: SCHEMA.length - MIGRATION_MAX });
  assert.equal(await storedVersion(DB), SCHEMA_VERSION);
  assert.ok(await tableExists(DB, "onboarding"));
  const third = countingDB(DB);
  await db({ DB: third.DB });
  assert.equal(third.used(), 0);
});

test("a new version with nothing missing only writes the version", async () => {
  const DB = fakeD1();
  const c = countingDB(DB);
  const { db } = await newIsolate();
  const report = {};
  await db({ DB: c.DB }, report);
  assert.equal(c.used(), 3, "version read, sqlite_master, version write: no batch");
  assert.deepEqual(report, { migrated: 2, created: 0 });
  assert.equal(await storedVersion(DB), SCHEMA_VERSION);
  // A new isolate at this version: 1 query and no migration.
  const again = countingDB(DB);
  const r2 = {};
  await (await newIsolate()).db({ DB: again.DB }, r2);
  assert.equal(again.used(), 1);
  assert.deepEqual(r2, { migrated: 0, created: 0 });
});

test("every overview §4 column exists", async () => {
  const DB = fakeD1({ schema: false });
  const { db } = await newIsolate();
  await migrate(db, { DB });

  const messages = await columns(DB, "messages");
  for (const c of ["needs_reply", "class", "refs", "handled_at", "intent"]) assert.ok(messages.includes(c), `messages.${c}`);
  const mailboxes = await columns(DB, "mailboxes");
  for (const c of ["cap_override", "paused_reason"]) assert.ok(mailboxes.includes(c), `mailboxes.${c}`);
  assert.ok((await columns(DB, "calls")).includes("note"), "calls.note");

  // Every new table, with exactly overview §4's columns in its order.
  const expected = {
    research: ["place_id", "status", "grade", "points", "grade_reason", "angle", "opener", "owner", "best_email",
      "best_email_why", "emails", "copy", "site_review", "too_big", "notes", "searched", "queued_at", "researched_at"],
    prospects: ["place_id", "stage", "stage_at", "email", "greet_name", "mailbox_id", "subject", "root_message_id",
      "first_sent_at", "followup_step", "next_followup_at", "views", "last_view_at", "last_inbound_at", "lost_reason",
      "created_at", "updated_at"],
    mailboxes: ["id", "address", "display_name", "role", "smtp_host", "smtp_port", "started_on", "cap_override", "status",
      "paused_reason", "created_at"],
    messages: ["id", "place_id", "client_id", "mailbox_id", "direction", "kind", "step", "author", "to_addr", "from_addr",
      "subject", "body", "message_id", "in_reply_to", "refs", "status", "due_at", "sent_at", "received_at", "error",
      "class", "needs_reply", "handled_at", "intent", "created_at"],
    inbound_raw: ["id", "received_at", "envelope_from", "envelope_to", "headers", "raw", "processed_at", "outcome"],
    followup_templates: ["step", "day_offset", "body", "status", "approved_at"],
    style_examples: ["id", "kind", "situation", "body", "source", "created_at"],
    calls: ["id", "place_id", "slot_at", "status", "phone", "note", "created_at", "updated_at"],
    todos: ["id", "kind", "place_id", "client_id", "title", "detail", "link", "draft", "due_at", "status", "dedupe",
      "created_at", "done_at"],
    heartbeats: ["name", "last_at", "ok", "detail"],
    routine_fires: ["id", "routine", "reason", "http_status", "error", "session_url", "at"],
    kpi_reports: ["week", "numbers", "analysis", "created_at"],
    onboarding: ["client_id", "token", "status", "form", "submitted_at", "due_live_at", "live_at", "site_url", "created_at"],
  };
  for (const [table, cols] of Object.entries(expected)) assert.deepEqual(await columns(DB, table), cols, table);

  // The old tables are all still there.
  for (const t of ["leads", "jobs", "job_progress", "scans", "scan_points", "scan_businesses", "lead_map_rank", "api_usage",
    "clients", "money", "settings", "payments", "client_links", "suppression", "demos", "demo_events", "outreach_tests",
    "outreach_versions", "outreach_sends", "outreach_replies", "outreach_briefs", "owner_questions"]) {
    assert.ok(await tableExists(DB, t), t);
  }

  // Indexes, with their columns.
  const indexes = {
    research_status: ["status", "grade"],
    prospects_stage: ["stage"],
    prospects_followup: ["next_followup_at"],
    messages_place: ["place_id", "created_at"],
    messages_due: ["status", "due_at"],
    messages_reply: ["needs_reply", "received_at"],
    messages_msgid: ["message_id"],
    inbound_raw_todo: ["processed_at"],
    calls_slot: ["slot_at", "status"],
    todos_open: ["status", "due_at"],
  };
  for (const [name, cols] of Object.entries(indexes)) {
    const info = (await DB.prepare(`PRAGMA index_info(${name})`).all()).results.map((c) => c.name);
    assert.deepEqual(info, cols, name);
  }

  // Defaults later stages rely on.
  const t = "2026-10-21T09:00:00Z";
  await DB.prepare("INSERT INTO mailboxes (id, address, display_name, role, started_on, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind("m1", "nik@aetoswebsites.com", "Nik", "cold", "2026-10-21", t).run();
  assert.deepEqual(await DB.prepare("SELECT smtp_host, smtp_port, status, cap_override FROM mailboxes").first(), {
    smtp_host: "mail.privateemail.com", smtp_port: 465, status: "active", cap_override: null,
  });
  await DB.prepare("INSERT INTO messages (id, direction, kind, author, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind("x1", "in", "inbound", "them", "hello", "received", t).run();
  assert.equal(await DB.prepare("SELECT needs_reply FROM messages").first("needs_reply"), 0);
  await DB.prepare("INSERT INTO calls (id, place_id, slot_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind("c1", "p1", t, "offered", t, t).run();
  assert.equal(await DB.prepare("SELECT note FROM calls").first("note"), "");
  await DB.prepare("INSERT INTO prospects (place_id, stage, stage_at, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind("p1", "ready", t, "a@b.co.uk", t, t).run();
  assert.deepEqual(await DB.prepare("SELECT followup_step, views FROM prospects").first(), { followup_step: 0, views: 0 });

  // todos.dedupe is unique, so the same item can't be added twice.
  const addTodo = DB.prepare("INSERT OR IGNORE INTO todos (id, kind, title, dedupe, created_at) VALUES (?, ?, ?, ?, ?)");
  assert.equal((await addTodo.bind("t1", "setup", "Add your first mailbox", "setup:first_mailbox", t).run()).meta.changes, 1);
  assert.equal((await addTodo.bind("t2", "setup", "Add your first mailbox", "setup:first_mailbox", t).run()).meta.changes, 0);
  assert.deepEqual(await DB.prepare("SELECT status, detail FROM todos").first(), { status: "open", detail: "" });
});
