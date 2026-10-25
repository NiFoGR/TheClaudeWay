// POST /api/messages/<id>/retry → 200 {ok: true, id, due_at} | 400/404/409 {error} (stage 5–6,
// docs/rebuild/06-email-followups.md Part A §A3 and §A8, Task 11): Try again on a first email that didn't send. Every
// check Send makes on the lead and the address runs again (the lead still ready, nothing else waiting, the demo, the
// address still one of theirs, the do-not-email list, an address another lead is being emailed at, a mailbox with room
// on the send day and all 9 follow-up days), and the text must still link to their demo as it is now; then a copy is
// queued with a new Message-ID (id = the copy's, due_at = when it goes: now inside Mon–Sat 07:00–19:00 UK, else the
// next window start); the failed email stays in the thread with its error. A copy already waiting (a second press)
// gets 409, any other check 400, an email that isn't there 404, each with its plain-English {error}. The next tick
// sends it (within 5 minutes). The logic is retryFirst in _lib/thread.js. Behind the login (_middleware.js).
// Tested in tests/thread.test.mjs.
import { retryFirst } from "../../../_lib/thread.js";
import { bad, db, json } from "../../../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestPost({ env, params, now }) {
  const DB = await db(env);
  const result = await retryFirst(DB, typeof params?.id === "string" ? params.id : "", now ?? new Date());
  return result.ok ? json({ ok: true, id: result.id, due_at: result.due_at }) : bad(result.error, result.status);
}
