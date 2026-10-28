// GET /api/todo → the Todo page in one call (stage 11, docs/rebuild/11-todo-kpis.md Part A "Todo page"): loadBoard in
// _lib/todo.js gives {now, health, health_error, today: {overdue, today, later}, pipeline, clients, counts: {due, red}}.
// Importing tick.js registers every stage's health light (as api/health.js does), so the lights match Setup's. Behind
// the login (_middleware.js). Tested in tests/todo-api.test.mjs.
import { errorText } from "../_lib/tick.js";
import { loadBoard } from "../_lib/todo.js";
import { bad, db, json } from "../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestGet(context) {
  const { env } = context;
  try {
    const DB = await db(env);
    const board = await loadBoard(DB, env, context.now ?? new Date());
    // The lights' error is shown on the page: one scrubbed line, never a secret.
    if (board.health_error) board.health_error = errorText(new Error(board.health_error), env);
    return json(board);
  } catch (err) {
    // In plain English (db() says how to bind the database), with any secret hidden. The page wraps it in "Couldn't
    // load your Todo list: <error>."
    return bad(errorText(err, env), 500);
  }
}
