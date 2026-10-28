// POST /api/replies/dismiss {todo_id} → Nik dealt with an escalation or call-time Todo elsewhere (Dismiss on the Replies
// page; stage 7, docs/rebuild/07-replies-calls.md). dismissTodo in _lib/replies-db.js closes it and the other Todos
// about the same email, and moves the stage back to replied when nothing else waits on him. Nothing is sent.
// 200 {ok}; 404 / 409 / 422 {error} in plain English. Behind the login (_middleware.js). Tested in
// tests/escalate.test.mjs.
import { dismissTodo } from "../../_lib/replies-db.js";
import { bad, db, json } from "../../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestPost(context) {
  const { request, env } = context;
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad("Couldn't dismiss it: the request wasn't readable. Refresh the page and try again.");
  const DB = await db(env);
  const result = await dismissTodo(DB, { todo_id: input.todo_id, now: context.now ?? new Date() });
  return json(result.body, result.status);
}
