// POST /api/messages/<id>/cancel → 200 {ok: true} | 404/409 {error} (stage 5–6, docs/rebuild/06-email-followups.md
// Part A §A8, Task 11): Cancel on a queued outgoing email in the lead drawer's thread (the drawer asks "Cancel this
// email? It won't be sent." first). A first email leaves the lead `ready`, so Nik can write it again; a follow-up skips
// that step and the next one is booked as normal (after step 9, the close time 7 days on). Refused in plain English
// once it has gone ("This email has already gone, so it can't be cancelled."), while it's being sent, when it didn't
// send, for an email they sent, and 404 for one that isn't there; nothing changes on a refusal. Cancelling one already
// cancelled answers {ok: true}. The logic is cancelMessage in _lib/thread.js. Behind the login (_middleware.js).
// Tested in tests/thread.test.mjs.
import { cancelMessage } from "../../../_lib/thread.js";
import { bad, db, json } from "../../../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestPost({ env, params, now }) {
  const DB = await db(env);
  const result = await cancelMessage(DB, typeof params?.id === "string" ? params.id : "", now ?? new Date());
  return result.ok ? json({ ok: true }) : bad(result.error, result.status);
}
