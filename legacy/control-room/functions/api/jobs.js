// GET /api/jobs → the 30 most recent Lead Scraper runs, with live progress for the progress bar.
import { db, json } from "../_lib/util.js";

export async function onRequestGet({ env }) {
  const DB = await db(env);
  const { results } = await DB.prepare(
    `SELECT jobs.*, p.stage AS progress_stage, p.done AS progress_done, p.total AS progress_total, p.scouted AS progress_scouted
     FROM jobs LEFT JOIN job_progress p ON p.job_id = jobs.id
     ORDER BY jobs.created_at DESC LIMIT 30`
  ).all();
  return json({ jobs: results });
}
