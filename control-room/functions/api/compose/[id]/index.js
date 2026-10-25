// GET /api/compose/<place_id> → composeContext's answer (stage 5–6, docs/rebuild/06-email-followups.md Part A §A3,
// Task 10): everything the composer in the lead drawer shows: the To options, the greeting, Claude's angle facts and
// opener, the demo, the mailbox that will send it and when (due_at), the db-side checks (blocking), whether the 9
// follow-ups are approved, and the lead's stage and first email. Always 200: a lead with no prospect (or one deleted
// since the drawer opened) answers with blocking [no_prospect]. The live preview is ./preview.js, Send ./send.js; the
// logic is _lib/first-email.js. Behind the login (_middleware.js). Tested in tests/compose-routes.test.mjs.
import { composeContext } from "../../../_lib/first-email.js";
import { db, json } from "../../../_lib/util.js";

const idOf = (params) => (typeof params?.id === "string" ? params.id : "");

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ env, params, now }) {
  const DB = await db(env);
  return json(await composeContext(DB, idOf(params), now ?? new Date()));
}
