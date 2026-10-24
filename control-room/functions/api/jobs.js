// GET /api/jobs → the 30 most recent Lead Scraper runs, with live progress for the progress bar, and `leads_now`: the
// leads whose last run is this one, which is what its "See these leads" link (#/leads?view=all&job=<id>&excluded=1)
// lists. `found` stays the run's history: a later run that finds a lead again moves it there (store.py's upsert sets
// last_job_id), so leads_now can be smaller. Counted on the leads_job index. Tested in tests/leadview.test.mjs.
import { db, json } from "../_lib/util.js";

export async function onRequestGet({ env }) {
  const DB = await db(env);
  const { results } = await DB.prepare(
    `SELECT jobs.*, p.stage AS progress_stage, p.done AS progress_done, p.total AS progress_total, p.scouted AS progress_scouted,
       (SELECT COUNT(*) FROM leads l WHERE l.last_job_id = jobs.id) AS leads_now
     FROM jobs LEFT JOIN job_progress p ON p.job_id = jobs.id
     ORDER BY jobs.created_at DESC LIMIT 30`
  ).all();
  return json({ jobs: results });
}
