// POST /api/todo/:id/send {body} → Nik sends Claude's draft (or his edit of it) from an escalation or call_time Todo
// (stage 11). The inbound message comes from the Todo's dedupe (messageIdFromDedupe in _lib/todo.js) and stage 7's
// sendAsNik sends it as his reply in that thread: it checks the words and the mailbox, adds his signature, and closes
// escalation:<id> / call_time:<id>. Its status and body come back as given (200 {ok, reply_id, status, due_at}; 422
// {error} in plain English). Any other Todo → 400 "Only replies can be sent from here."; an unknown id → 404; a Todo
// that's no longer open (done or dismissed, e.g. Nik answered on the Replies page or his phone while this page was
// stale) → 409 "That's already been dealt with, so nothing was sent. Refresh the page." and nothing is sent (sendAsNik
// sends to any inbound message, as the thread's "Reply as me", so this route must check). The Todo is claimed first
// (open → done in one conditional UPDATE), so two presses of Send at once (two tabs, his phone and laptop, Send and
// Send edited) send once: the second gets the 409. When sendAsNik doesn't send (422, 404, 409, or an error before
// his reply was queued) the claim is undone and the Todo is open again, so nothing is lost; an error after his reply
// was queued keeps it closed (the tick's send step sends that reply), so a second press with other words gets the 409,
// never a second email. The claim and the send run as one promise handed to waitUntil, so Nik closing the tab or
// losing signal mid-send can't leave the Todo claimed with nothing sent. A freed "@…" dedupe isn't one sendAsNik
// closes, which the claim covers too. The reply goes straight away through the outbox in waitUntil, as on the
// Replies page; if that fails the tick's send step sends it. Behind the login (_middleware.js). Tested in
// tests/todo-api.test.mjs.
import { dispatchDue } from "../../../_lib/mail/outbox.js";
import { sendAsNik } from "../../../_lib/replies-db.js";
import { errorText } from "../../../_lib/tick.js";
import { messageIdFromDedupe } from "../../../_lib/todo.js";
import { bad, db, iso, json } from "../../../_lib/util.js";

const SENDABLE = new Set(["escalation", "call_time"]);
const DEALT_WITH = "That's already been dealt with, so nothing was sent. Refresh the page.";

// Undo this request's claim (only its own: the done_at it set), so the Todo shows again when nothing was sent.
async function unclaim(DB, id, stamp, env) {
  await DB.prepare("UPDATE todos SET status = 'open', done_at = NULL WHERE id = ? AND status = 'done' AND done_at = ?")
    .bind(id, stamp).run()
    .catch((err) => console.error(`Nik's reply wasn't sent and its Todo couldn't be reopened: ${errorText(err, env)}`));
}

// Nik's reply to this inbound message, saved by this request (from `stamp` on) or by an identical press in the last
// 10 minutes that sendAsNik answers with (its duplicate check). A failed lookup counts as queued: a closed Todo whose
// reply is still sent by the tick is safer than an open one Nik could send a second email from.
const QUEUED_SQL = `SELECT 1 AS hit FROM messages o JOIN messages i ON i.id = ?
  WHERE o.direction = 'out' AND o.kind = 'reply' AND o.author = 'nik' AND o.place_id IS i.place_id
    AND o.in_reply_to IS i.message_id AND o.created_at >= ? LIMIT 1`;
const DUPLICATE_MS = 10 * 60_000; // sendAsNik's NIK_DUPLICATE_MS
async function replyQueued(DB, messageId, at) {
  const since = iso(new Date(at).getTime() - DUPLICATE_MS); // the format created_at is saved in (no milliseconds)
  return DB.prepare(QUEUED_SQL).bind(messageId, since).first().then((row) => row != null, () => true);
}

// Claim the Todo (open → done), then send. Not sent → the claim is undone; an error → undone only when no reply of
// his was queued. → sendAsNik's {status, body}, or the 409 when another press or page got there first.
async function claimAndSend(DB, env, { id, messageId, body, at }) {
  const stamp = iso(at);
  const claim = await DB.prepare("UPDATE todos SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'")
    .bind(stamp, id).run();
  if (!(claim.meta?.changes > 0)) return { status: 409, body: { error: DEALT_WITH } };
  try {
    const r = await sendAsNik(DB, { message_id: messageId, body, now: at });
    // Not sent (empty words, no mailbox, a do-not-email address, Claude just answered): the Todo is open again.
    if (r.status !== 200) await unclaim(DB, id, stamp, env);
    return r;
  } catch (err) {
    if (!(await replyQueued(DB, messageId, at))) await unclaim(DB, id, stamp, env);
    throw err;
  }
}

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
    if (todo.status !== "open") return bad(DEALT_WITH, 409);
    const messageId = SENDABLE.has(todo.kind) ? messageIdFromDedupe(todo.dedupe) : null;
    if (!messageId) return bad("Only replies can be sent from here.");

    // Only one press gets past the claim: the other was here first, or Nik closed it elsewhere a moment ago. It runs
    // in waitUntil too, so the claim and its undo finish even when the page is closed before the answer comes back.
    const work = claimAndSend(DB, env, { id, messageId, body: input.body, at });
    if (typeof context.waitUntil === "function") context.waitUntil(work.catch(() => {}));
    result = await work;
  } catch (err) {
    // In plain English, with any secret hidden. A reply queued before the error is still sent by the tick's send
    // step, and its Todo stays closed, so pressing Send again (any words) gets the 409, never a second email.
    return bad(`Couldn't send: ${errorText(err, env)}`, 500);
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
