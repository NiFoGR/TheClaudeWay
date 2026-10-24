// POST /api/leads/<place_id>/not-a-fit {reason} → {ok: true}: the lead panel's "Not a fit" (stage 3,
// docs/rebuild/04-shortlist.md Part A). Research status 'skipped' (out of Ready to email, and Claude never researches it
// again), the line "[Nik <UK date>] Not a fit: <reason>" on top of the research notes (stage 2's research card shows it
// as the reason), and a `ready` prospect row deleted; markNotFit in _lib/shortlist-db.js. 400 when the reason isn't 3 to
// 200 characters, 404 when the lead is gone, 409 once it's been emailed; nothing changes on a refusal, and the panel
// shows the {error}. Bringing a lead back is stage 2's "Research is wrong" (POST /api/research/<place_id>/wrong), not a
// route here. Behind the login (_middleware.js). Tested in tests/leads-api.test.mjs.
import { markNotFit } from "../../../_lib/shortlist-db.js";
import { bad, db, json } from "../../../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestPost({ request, env, params, now }) {
  const body = await request.json().catch(() => null);
  const reason = body && typeof body === "object" && !Array.isArray(body) ? body.reason : null;
  const DB = await db(env);
  const result = await markNotFit(DB, typeof params?.id === "string" ? params.id : "", reason, now ?? new Date());
  return result.ok ? json({ ok: true }) : bad(result.error, result.status);
}
