// GET /api/kpis?week=2026-W43 (login required) → the KPIs page's payload (_lib/kpis-db.js kpiPayload): the week's
// numbers, the last 4 weeks and Claude's saved review. With no week: the latest week with a review, else the current
// UK week. 400 "Week should look like 2026-W43." / "That week hasn't started yet.". Nothing is written.
// Tested in tests/kpis-api.test.mjs.
import { checkWeek, defaultWeek, kpiPayload } from "../_lib/kpis-db.js";
import { bad, db, json } from "../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ request, env, now }) {
  const DB = await db(env);
  const at = now ?? new Date();
  const asked = new URL(request.url).searchParams.get("week");
  const checked = checkWeek(asked ? asked : await defaultWeek(DB, at), at);
  if (checked.error) return bad(checked.error);
  return json(await kpiPayload(DB, checked.week, at));
}
