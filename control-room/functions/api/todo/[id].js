// PATCH /api/todo/:id {status: "done"|"dismissed"} → Nik's Done or Dismiss on the Todo page (stage 11): 200 {ok},
// 400 a status that isn't done or dismissed, 404 an id that isn't there. A second tap is a harmless 200, and the
// dedupe is kept, so the same item is never added again (setTodoStatus in _lib/todo.js).
//
// An open escalation or call_time Todo goes through stage 7's dismissTodo first, exactly as the Replies page's
// Dismiss does: the other Todos about the same email close, the email stops waiting, and the lead's stage goes back
// from Needs you to Replied when nothing else waits on Nik. Nothing is sent. Behind the login (_middleware.js).
// Tested in tests/todo-api.test.mjs.
import { dismissTodo } from "../../_lib/replies-db.js";
import { errorText } from "../../_lib/tick.js";
import { setTodoStatus } from "../../_lib/todo.js";
import { bad, db, json } from "../../_lib/util.js";

const MISSING = "That item no longer exists. Refresh the page.";
const BAD_STATUS = "Status must be done or dismissed.";
const UNREADABLE = "Couldn't update it: the request wasn't readable. Refresh the page and try again.";
const HAND_BACK = new Set(["escalation", "call_time"]);

/** `context.now` (tests) or the time now. */
export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad(UNREADABLE);
  if (input.status !== "done" && input.status !== "dismissed") return bad(BAD_STATUS);
  const id = typeof params?.id === "string" ? params.id : "";
  try {
    const DB = await db(env);
    const at = context.now ?? new Date();

    const todo = id ? await DB.prepare("SELECT kind, status FROM todos WHERE id = ?").bind(id).first() : null;
    if (!todo) return bad(MISSING, 404);
    if (todo.status === "open" && HAND_BACK.has(todo.kind)) {
      const handed = await dismissTodo(DB, { todo_id: id, now: at });
      // dismissTodo leaves it dismissed; Done keeps Nik's word for it. A 409 (closed meanwhile) is a second tap.
      if (handed.status === 200 && input.status === "done") {
        await DB.prepare("UPDATE todos SET status = 'done' WHERE id = ? AND status = 'dismissed'").bind(id).run();
      }
      if (handed.status === 200 || handed.status === 409) return json({ ok: true });
    }
    return (await setTodoStatus(DB, id, input.status, at)) === "ok" ? json({ ok: true }) : bad(MISSING, 404);
  } catch (err) {
    // In plain English (db() says how to bind the database), with any secret hidden; the page shows it in
    // "Couldn't update it: <error>".
    return bad(errorText(err, env), 500);
  }
}
