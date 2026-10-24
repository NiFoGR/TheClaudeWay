// GET/PUT /api/territory → the Lead Scraper page's Automatic search card (02-find Task 14; replaces the old autopilot route).
// The territory setting is {on, trade, towns, next, max}; each morning the tick step daily_find searches the next
// town on it when the pipeline is low (_lib/find.js). This route only reads and saves: the rules live in
// _lib/territory.js (pure) and _lib/find.js (db).
import { loadTerritory, pipelineCounts, recentJobs, saveTerritory } from "../_lib/find.js";
import { getSetting } from "../_lib/settings.js";
import { chooseTown, cleanTerritory, todayLine } from "../_lib/territory.js";
import { ukDate } from "../_lib/ukTime.js";
import { bad, db, json, parseJson } from "../_lib/util.js";

const NO_TOWN_LEFT = "none (every town searched in the last 30 days)";

/** → {territory, upcoming, today, counts: {goodWaiting, researchQueued}}. `context.now` (tests) or the time now. */
export async function onRequestGet(context) {
  const now = context.now ?? new Date();
  const DB = await db(context.env);
  const [territory, counts, jobs, saved] = await Promise.all([
    loadTerritory(DB), pipelineCounts(DB), recentJobs(DB, now), getSetting(DB, "find:today"),
  ]);
  // The jobs row of today's automatic search, for its status, found count or error.
  const jobId = parseJson(saved, null)?.job_id;
  const job = typeof jobId === "string" && jobId
    ? await DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first()
    : null;
  return json({
    territory,
    upcoming: chooseTown(territory, jobs, ukDate(now))?.town ?? NO_TOWN_LEFT,
    today: todayLine(saved, job, now),
    counts: { goodWaiting: counts.goodWaiting, researchQueued: counts.researchQueued },
  });
}

/** {on, trade, towns, max} → {territory} | 400 {error}. The place in the list is kept unless the trade or list changed. */
export async function onRequestPut({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const DB = await db(env);
  const { territory, error } = cleanTerritory(body, await loadTerritory(DB));
  if (error) return bad(error);
  await saveTerritory(DB, territory);
  return json({ territory });
}
