// GET /api/jobs → the 30 most recent Lead Scraper runs.
import { db, json } from "../_lib/util.js";

export async function onRequestGet({ env }) {
  const DB = await db(env);
  const { results } = await DB.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 30").all();
  return json({ jobs: results });
}
