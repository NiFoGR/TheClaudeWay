// POST /api/agent/reply (agent token) {message_id, intent, body, call?, asked_time?} → the reply Routine (aetos-reply,
// stage 7, docs/rebuild/07-replies-calls.md) answers one waiting message. Every check, the queued reply in the thread
// and the intent's bookkeeping (stage, call, Todos, opt-out) are recordReply's in _lib/replies-db.js: 200 {ok, reply_id,
// status, due_at, call}, 404 unknown message, 409 already answered / a newer message / Nik's thread, 422 {error,
// reasons} for anything Claude must fix or escalate. A reply due now is sent straight away through the outbox
// (dispatchDue, replies only, one email) in waitUntil; one posted outside reply hours waits for 07:00 UK and the tick's
// send step. The answer never depends on the send: the reply is queued either way. If this call never reached the
// row (it threw first), the tick's send step sends it while it is still queued; a send that fails is final (status
// failed, nothing retries it) and turns the Replies light red. Tested in tests/agent-reply.test.mjs.
import { requireAgent } from "../../_lib/agentAuth.js";
import { dispatchDue } from "../../_lib/mail/outbox.js";
import { recordReply } from "../../_lib/replies-db.js";
import { errorText } from "../../_lib/tick.js";
import { db, iso, json } from "../../_lib/util.js";

const NOT_OBJECT = "Body must be a JSON object.";

/** `context.now` (tests) or the time now. */
export async function onRequestPost(context) {
  const { request, env } = context;
  const DB = await db(env);
  const denied = await requireAgent(request, env, DB);
  if (denied) return denied;

  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: NOT_OBJECT, reasons: [NOT_OBJECT] }, 400);
  const at = context.now ?? new Date();
  const { message_id, intent, body, call, asked_time } = input;
  const result = await recordReply(DB, { message_id, intent, body, call, asked_time, now: at });

  const reply = result.body;
  if (result.status === 200 && reply.status === "queued" && reply.due_at && reply.due_at <= iso(at)
    && typeof context.waitUntil === "function") {
    context.waitUntil(dispatchDue(DB, env, at, { limit: 1, kinds: ["reply"] }).catch((err) => {
      console.error(`The reply couldn't be sent straight away (the tick's send step sends it if it's still queued): ${errorText(err, env)}`);
    }));
  }
  return json(reply, result.status);
}
