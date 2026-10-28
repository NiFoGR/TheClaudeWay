// GET /api/todo/count → {due, red} for the Todo nav badge, on every page load (stage 11): the same numbers as
// GET /api/todo's counts (todoCounts in _lib/todo.js), without the pipeline and clients. Importing tick.js registers
// every stage's health light, as api/health.js does. Behind the login (_middleware.js). Tested in
// tests/todo-api.test.mjs.
import { errorText } from "../../_lib/tick.js";
import { todoCounts } from "../../_lib/todo.js";
import { bad, db, json } from "../../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestGet(context) {
  const { env } = context;
  try {
    const DB = await db(env);
    return json(await todoCounts(DB, env, context.now ?? new Date()));
  } catch (err) {
    return bad(errorText(err, env), 500);
  }
}
