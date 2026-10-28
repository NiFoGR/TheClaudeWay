// POST /api/replies/send {message_id, body} → Nik's own reply to one of their emails ("Send as me" on an escalation,
// "Reply as me" on a thread; stage 7, docs/rebuild/07-replies-calls.md). His words, not checked, sent at once at any
// hour from the thread's mailbox (sendAsNik in _lib/replies-db.js): the message's Todos close and the stage goes back
// to replied when nothing else waits on him. 200 {ok, reply_id, status, due_at}; 422 {error} "Couldn't save: write
// something first." / "Couldn't send: …"; 404 an email that isn't there. The reply goes straight away through the
// outbox (dispatchDue, replies only, one email) in waitUntil. The answer never depends on the send: if this call never
// reached the row (it threw first), the tick's send step sends it while it is still queued; a send that fails is final
// (status failed, nothing retries it) and turns the Replies light red. Behind the login (_middleware.js). Tested in
// tests/escalate.test.mjs.
import { dispatchDue } from "../../_lib/mail/outbox.js";
import { sendAsNik } from "../../_lib/replies-db.js";
import { errorText } from "../../_lib/tick.js";
import { bad, db, iso, json } from "../../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestPost(context) {
  const { request, env } = context;
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad("Couldn't send: the request wasn't readable. Refresh the page and try again.");
  const DB = await db(env);
  const at = context.now ?? new Date();
  const result = await sendAsNik(DB, { message_id: input.message_id, body: input.body, now: at });

  const reply = result.body;
  if (result.status === 200 && reply.status === "queued" && reply.due_at && reply.due_at <= iso(at)
    && typeof context.waitUntil === "function") {
    context.waitUntil(dispatchDue(DB, env, at, { limit: 1, kinds: ["reply"] }).catch((err) => {
      console.error(`Nik's reply couldn't be sent straight away (the tick's send step sends it if it's still queued): ${errorText(err, env)}`);
    }));
  }
  return json(reply, result.status);
}
