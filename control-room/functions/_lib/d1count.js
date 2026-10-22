// Counting D1 queries. The free plan allows 50 D1 queries per invocation, so the tick (and each step in it) keeps
// count. countingDB(DB) wraps a D1 database with the same prepare/batch surface and counts every statement run: each
// first(), all(), run() or raw() is one, and each statement in a batch() is one. A statement is counted when it's
// sent, so one that fails still counts (D1 still ran a query). Preparing and binding cost nothing.

/** countingDB(DB) → {DB, used}: `DB` is the wrapper to hand on, `used()` the statements it has run so far. */
export function countingDB(DB) {
  let used = 0;
  const originals = new WeakMap(); // wrapper → the statement it wraps

  const wrap = (stmt) => {
    const counted = (method) => (...args) => {
      used++;
      return stmt[method](...args);
    };
    const wrapper = {
      // D1's batch() reads these two fields, so code that inspects a statement sees the real ones.
      get statement() {
        return stmt.statement;
      },
      get params() {
        return stmt.params;
      },
      bind: (...values) => wrap(stmt.bind(...values)),
      first: counted("first"),
      all: counted("all"),
      run: counted("run"),
      raw: counted("raw"),
    };
    originals.set(wrapper, stmt);
    return wrapper;
  };

  return {
    DB: {
      prepare: (sql) => wrap(DB.prepare(sql)),
      // D1 only runs statements it made itself, so the wrapped ones are swapped back before the batch is sent.
      batch: (stmts) => {
        const real = stmts.map((s) => originals.get(s) ?? s);
        used += real.length;
        return DB.batch(real);
      },
    },
    used: () => used,
  };
}
