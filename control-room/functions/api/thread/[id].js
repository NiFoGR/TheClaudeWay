// GET /api/thread/<place_id> → {summary, messages} (stage 5–6, docs/rebuild/06-email-followups.md Part A §A8, Task 11):
// the lead drawer's email thread once a first email exists: the summary line ("Follow-up 3 of 9: Mon 26 Oct 09:15",
// "Follow-ups stopped: they replied", …) and every message oldest first, each {id, direction, kind, step, author,
// subject, body, status, due_at, sent_at, received_at, error, class}. Bodies are untrusted text: the drawer shows them
// through esc(). Always 200: a lead with no prospect or no messages answers {summary: "", messages}. Stage 7 and 8
// todos link to this thread. The logic is _lib/thread.js. Behind the login (_middleware.js).
// Tested in tests/thread.test.mjs.
import { loadThread } from "../../_lib/thread.js";
import { db, json } from "../../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ env, params, now }) {
  const DB = await db(env);
  return json(await loadThread(DB, typeof params?.id === "string" ? params.id : "", now ?? new Date()));
}
