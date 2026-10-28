// POST /api/todo/:id/send {body} → Nik sends Claude's draft (or his edit of it) from an escalation or call_time Todo
// (stage 11). The inbound message comes from the Todo's dedupe (messageIdFromDedupe in _lib/todo.js) and stage 7's
// sendAsNik sends it as his reply in that thread: it checks the words and the mailbox, adds his signature, and closes
// escalation:<id> / call_time:<id>. Its status and body come back as given (200 {ok, reply_id, status, due_at}; 422
// {error} in plain English). Any other Todo → 400 "Only replies can be sent from here."; an unknown id → 404; a Todo
// that's no longer open (done or dismissed, e.g. Nik answered on the Replies page or his phone while this page was
// stale) → 409 "That's already been dealt with, so nothing was sent. Refresh the page." and nothing is sent (sendAsNik
// sends to any inbound message, as the thread's "Reply as me", so this route must check). On 200 this Todo is done too (a freed "@…" dedupe isn't one sendAsNik closes). The reply goes straight away through the
// outbox in waitUntil, as on the Replies page; if that fails the tick's send step sends it. Behind the login
// (_middleware.js). Tested in tests/todo-api.test.mjs.
import { dispatchDue } from "../../../_lib/mail/outbox.js";
import { sendAsNik } from "../../../_lib/replies-db.js";
import { errorText } from "../../../_lib/tick.js";
import { messageIdFromDedupe } from "../../../_lib/todo.js";
import { bad, db, iso, json } from "../../../_lib/util.js";

const SENDABLE = new Set(["escalation", "call_time"]);

/** `context.now` (tests) or the time now. */
export async function onRequestPost(context) {
  const { request, env, params } = context;
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return bad("Couldn't send: the request wasn't readable. Refresh the page and try again.");
  }
  const id = typeof params?.id === "string" ? params.id : "";
  let DB;
  let at;
  let result;
  try {
    DB = await db(env);
    at = context.now ?? new Date();
    const todo = id ? await DB.prepare("SELECT kind, dedupe, status FROM todos WHERE id = ?").bind(id).first() : null;
    if (!todo) return bad("That item no longer exists. Refresh the page.", 404);
    if (todo.status !== "open") return bad("That's already been dealt with, so nothing was sent. Refresh the page.", 409);
    const messageId = SENDABLE.has(todo.kind) ? messageIdFromDedupe(todo.dedupe) : null;
    if (!messageId) return bad("Only replies can be sent from here.");

    result = await sendAsNik(DB, { message_id: messageId, body: input.body, now: at });
  } catch (err) {
    // In plain English, with any secret hidden. A reply queued before the error is still sent by the tick's send
    // step, and pressing Send again within 10 minutes returns that one (sendAsNik's duplicate check), never a second.
    return bad(`Couldn't send: ${errorText(err, env)}`, 500);
  }
  if (result.status === 200) {
    // The reply is queued whatever happens here; a todo left open is only a row Nik can tick Done.
    await DB.prepare("UPDATE todos SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'").bind(iso(at), id).run()
      .catch((err) => console.error(`Nik's reply is queued but its Todo couldn't be marked done: ${errorText(err, env)}`));
  }
  const reply = result.body;
  if (result.status === 200 && reply.status === "queued" && reply.due_at && reply.due_at <= iso(at)
    && typeof context.waitUntil === "function") {
    context.waitUntil(dispatchDue(DB, env, at, { limit: 1, kinds: ["reply"] }).catch((err) => {
      console.error(`Nik's reply couldn't be sent straight away (the tick's send step sends it if it's still queued): ${errorText(err, env)}`);
    }));
  }
  return json(reply, result.status);
}
