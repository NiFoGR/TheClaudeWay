// POST /api/research/<place_id>/wrong {note} → {ok: true, fired, message}: Nik's "Research is wrong" on the research
// card (stage 2, 03-research-grade.md). His note goes on top of the lead's research notes as "[Nik <UK date>] <note>",
// the lead goes back to the front of the research queue (its old research stays visible until Claude posts again),
// and the research Routine is woken unless a research fire was logged in the last 30 minutes (_lib/research-db.js
// requeueResearch). `message` is the toast the card shows. 400 when the note isn't 5 to 500 characters, 404 when the
// lead has no research row or no longer exists, 409 when Claude may not research it now (the scraper excluded it, or
// it's on the do-not-contact list): nothing changes and nothing fires, and the card shows the {error} under the box.
// Behind the login (_middleware.js). Tested in tests/research-owner.test.mjs.
import { RECHECK_ERRORS, recheckNote, requeueResearch } from "../../../_lib/research-db.js";
import { bad, db, json } from "../../../_lib/util.js";

/** `context.now` (tests) or the time now; the default fireRoutine wakes the Routine. */
export async function onRequestPost({ request, env, params, now }) {
  const body = await request.json().catch(() => null);
  const note = recheckNote(body && typeof body === "object" && !Array.isArray(body) ? body.note : null);
  if (note === null) return bad(RECHECK_ERRORS.note);

  const DB = await db(env);
  const placeId = typeof params?.id === "string" ? params.id : "";
  const result = await requeueResearch(DB, placeId, note, now ?? new Date());
  if (!result) return bad(RECHECK_ERRORS.none, 404);
  if (result.refused) return bad(result.error, result.refused === "missing" ? 404 : 409);
  return json({ ok: true, fired: result.fired, message: result.message });
}
