// A D1-shaped database for tests: in-memory node:sqlite with the real schema behind D1's API.
// fakeD1({schema = true} = {}) → {prepare(sql), batch(stmts), exec(sql), raw: DatabaseSync}
//
// It also refuses what live D1 refuses, so a test can't pass on code that would fail on Cloudflare:
// unsupported bind types (undefined, Date, BigInt, plain objects), the wrong number of bound values,
// more than 100 bound values in one statement, BEGIN/COMMIT/SAVEPOINT (use batch), statements over
// 100,000 bytes, values over 2,000,000 bytes and LIKE/GLOB patterns over 50 bytes (D1's
// SQLITE_LIMIT_LIKE_PATTERN_LENGTH: "LIKE or GLOB pattern too complex", raised when a row reaches the LIKE, as on
// D1). Foreign keys are enforced, as on D1. SQLite's errors read like D1's ("D1_ERROR: <message>: SQLITE_<CODE>").
// One stricter rule: one SQL statement per prepare(). D1 would run the others too, outside any transaction, and
// return only the first one's results, so code must use batch() for several (exec() is for test seeding).
import { DatabaseSync } from "node:sqlite";
import { SCHEMA } from "../../functions/_lib/schema.js";

// developers.cloudflare.com/d1/platform/limits
const MAX_PARAMS = 100;
const MAX_SQL_BYTES = 100_000;
const MAX_VALUE_BYTES = 2_000_000;
const MAX_PATTERN_BYTES = 50; // LIKE and GLOB patterns
const SQLITE_RANGE = 25;
const LEADING = String.raw`(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*`; // whitespace and comments
const TRANSACTION_RE = new RegExp(String.raw`^${LEADING}(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b`, "i");
const EMPTY_RE = new RegExp(`^${LEADING}$`);
const TAIL_RE = /^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/; // what may follow the one statement
const bytes = (s) => new TextEncoder().encode(s).length;
// SQLite's primary result codes (errcode & 0xff), for D1's ": SQLITE_<CODE>" suffix.
const SQLITE_CODES = { 1: "ERROR", 4: "ABORT", 5: "BUSY", 6: "LOCKED", 8: "READONLY", 13: "FULL", 17: "SCHEMA", 18: "TOOBIG", 19: "CONSTRAINT", 20: "MISMATCH", 21: "MISUSE", 25: "RANGE" };

function show(value) {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// D1's own bind() rules (workerd d1-api.ts): numbers and strings as they are, booleans as 1/0, null,
// byte arrays / ArrayBuffers / typed arrays as BLOBs; anything else throws when bind() is called.
function d1Value(value) {
  const type = typeof value;
  if (type === "number" || type === "string") return value;
  if (type === "boolean") return value ? 1 : 0;
  if (value === null) return null;
  if (Array.isArray(value) && value.every((b) => typeof b === "number" && b >= 0 && b < 256)) return value;
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  throw new Error(`D1_TYPE_ERROR: Type '${type}' not supported for value '${show(value)}'`);
}

// D1 sends values to the database as JSON, so NaN and Infinity arrive as NULL, and a whole number is bound
// as an INTEGER (node:sqlite would bind every number as REAL, so a TEXT column would get "1.0" instead of "1").
// BigInt makes node:sqlite bind an integer.
function sqliteValue(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return value;
}

// Rows come back as plain objects (node:sqlite gives null-prototype ones). D1 returns BLOBs as arrays of
// bytes and every number as a JS number (big integers lose precision rather than throwing).
const cell = (v) => (v instanceof Uint8Array ? Array.from(v) : typeof v === "bigint" ? Number(v) : v);

function plain(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = cell(v);
  return out;
}

const d1Error = (message, sql) => new Error(`D1_ERROR: ${message} SQL: ${sql.replace(/\s+/g, " ").trim().slice(0, 200)}`);

// node:sqlite's own errors ("UNIQUE constraint failed: settings.key") get D1's wording around them.
function asD1Error(err) {
  if (typeof err?.message === "string" && err.message.startsWith("D1_")) return err;
  const code = SQLITE_CODES[Number(err?.errcode) & 0xff];
  return new Error(`D1_ERROR: ${err?.message ?? String(err)}${code ? `: SQLITE_${code}` : ""}`, { cause: err });
}

// D1 refuses LIKE and GLOB patterns over 50 bytes; node:sqlite (Node 22) can't lower SQLite's limit (no setLimit), so
// the operators are replaced on `db`: like(pattern, text[, escape]) and glob(pattern, text) are what SQLite calls for
// "text LIKE pattern [ESCAPE e]" and "text GLOB pattern". Over the limit they throw D1's error; otherwise a second,
// plain database gives SQLite's own answer.
function limitPatterns(db) {
  const plain = new DatabaseSync(":memory:");
  const ask = (sql) => {
    const stmt = plain.prepare(sql);
    stmt.setReadBigInts(true); // the answer stays an INTEGER
    return (...args) => stmt.get(...args).r;
  };
  const glob = ask("SELECT ?2 GLOB ?1 AS r");
  const like = ask("SELECT ?2 LIKE ?1 AS r");
  const likeEscape = ask("SELECT ?2 LIKE ?1 ESCAPE ?3 AS r");
  const size = (v) => (typeof v === "string" ? bytes(v) : v instanceof Uint8Array ? v.length : v === null ? 0 : bytes(String(v)));
  const limit = (pattern) => {
    if (size(pattern) > MAX_PATTERN_BYTES) throw new Error("D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR");
  };
  // node:sqlite registers each function for exactly fn.length arguments, so every one names its own.
  const options = { deterministic: true, useBigIntArguments: true };
  db.function("glob", options, (p, s) => (limit(p), glob(p, s)));
  db.function("like", options, (p, s) => (limit(p), like(p, s)));
  db.function("like", options, (p, s, e) => (limit(p), likeEscape(p, s, e)));
}

export function fakeD1({ schema = true } = {}) {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  limitPatterns(db);
  if (schema) SCHEMA.forEach((sql) => db.exec(sql));

  const countersStmt = db.prepare("SELECT total_changes() AS t, changes() AS c, last_insert_rowid() AS id");
  const counters = () => countersStmt.get();

  // Live D1 rejects these before running anything; checking here keeps every rejected statement side-effect free.
  const check = (sql, values) => {
    if (typeof sql !== "string" || EMPTY_RE.test(sql)) throw d1Error("No SQL statements detected.", String(sql ?? ""));
    if (TRANSACTION_RE.test(sql)) {
      throw d1Error("D1 doesn't run BEGIN, COMMIT or SAVEPOINT statements: put the statements in one DB.batch([...]) instead.", sql);
    }
    if (bytes(sql) > MAX_SQL_BYTES) throw d1Error(`Statement too long: SQLITE_TOOBIG (${bytes(sql)} bytes; D1's limit is ${MAX_SQL_BYTES}).`, sql);
    if (values.length > MAX_PARAMS) {
      throw d1Error(`too many SQL variables: SQLITE_ERROR (${values.length} bound; D1 allows ${MAX_PARAMS} per statement).`, sql);
    }
    for (const v of values) {
      const size = typeof v === "string" ? bytes(v) : v instanceof Uint8Array ? v.length : 0;
      if (size > MAX_VALUE_BYTES) throw d1Error(`string or blob too big: SQLITE_TOOBIG (${size} bytes; D1's limit is ${MAX_VALUE_BYTES}).`, sql);
    }
    // node:sqlite compiles only the first statement and would quietly ignore the rest.
    const probe = db.prepare(sql);
    const compiled = typeof probe.sourceSQL === "function" ? probe.sourceSQL() : probe.sourceSQL;
    if (typeof compiled === "string" && sql.startsWith(compiled) && !TAIL_RE.test(sql.slice(compiled.length))) {
      throw d1Error("A prepared SQL statement must contain only one statement: prepare each one and run them in one DB.batch([...]).", sql);
    }
    // D1 requires exactly as many values as the SQL has parameters (node:sqlite would bind missing ones as NULL).
    // iterate() binds without running, so a probe tells us the count; SQLITE_RANGE means "more values than parameters".
    const fits = (list) => {
      try {
        probe.iterate(...list);
        return true;
      } catch (err) {
        if (err?.errcode === SQLITE_RANGE) return false;
        throw err;
      }
    };
    if (!fits(values) || fits([...values, null])) {
      throw d1Error(`Wrong number of parameter bindings for SQL query. (${values.length} bound)`, sql);
    }
  };

  // Runs one statement and returns D1's result shape. meta.changes is SQLite's changes() (rows this statement
  // changed directly, not trigger rows), and 0 for a statement that changed nothing, even straight after a write.
  // With `arrays`, rows are arrays of values and `columns` holds the column names (for raw()).
  const execute = (sql, params, arrays = false) => {
    try {
      const values = JSON.parse(JSON.stringify(params)).map(sqliteValue);
      check(sql, values);
      const stmt = db.prepare(sql);
      stmt.setReadBigInts(true);
      if (arrays) stmt.setReturnArrays(true);
      const before = counters();
      const rows = stmt.all(...values);
      const after = counters();
      const changes = after.t > before.t ? Number(after.c) : 0;
      const meta = { changes, last_row_id: Number(after.id), changed_db: changes > 0, duration: 0 };
      if (arrays) return { results: rows.map((r) => r.map(cell)), columns: stmt.columns().map((c) => c.name), meta };
      return { success: true, results: rows.map(plain), meta };
    } catch (err) {
      throw asD1Error(err);
    }
  };

  // Like D1PreparedStatement: `statement` and `params` are what batch() reads, so a wrapper (e.g. countingDB)
  // must hand batch() the original statements or objects carrying the same two fields, exactly as on D1.
  const statement = (sql, params = []) => ({
    statement: sql,
    params,
    bind: (...values) => statement(sql, values.map(d1Value)),
    first: async (col) => {
      const row = execute(sql, params).results[0];
      if (col === undefined) return row ?? null;
      if (row && !Object.hasOwn(row, col)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${col})`);
      return row?.[col] ?? null;
    },
    all: async () => execute(sql, params),
    run: async () => execute(sql, params),
    // D1's raw(): rows as arrays of values; {columnNames: true} puts the column names first.
    raw: async ({ columnNames = false } = {}) => {
      const { results, columns } = execute(sql, params, true);
      return columnNames ? [columns, ...results] : results;
    },
  });

  return {
    prepare: (sql) => statement(sql),
    // One transaction: every statement or none.
    batch: async (stmts) => {
      for (const s of stmts) {
        if (typeof s?.statement !== "string" || !Array.isArray(s.params)) {
          throw new TypeError("batch() takes statements made by DB.prepare(...)");
        }
      }
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => execute(s.statement, s.params));
        db.exec("COMMIT");
        return out;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // SQLite already rolled back (e.g. SQLITE_FULL); keep the original error.
        }
        throw err;
      }
    },
    // Test seeding only (raw SQL, several statements). Runs before the promise returns.
    exec: async (sql) => {
      db.exec(sql);
      return { duration: 0 };
    },
    raw: db,
  };
}
