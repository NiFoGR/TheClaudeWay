// GET /api/leads?job=<id>  → leads found by one run
// GET /api/leads           → every lead (newest scrape first), for the Leads page
import { db, json, leadRow } from "../_lib/util.js";

const ORDER = "ORDER BY excluded ASC, quality_score DESC, rating DESC, review_count DESC";

export async function onRequestGet({ request, env }) {
  const DB = await db(env);
  const job = new URL(request.url).searchParams.get("job");
  const stmt = job
    ? DB.prepare(`SELECT * FROM leads WHERE last_job_id = ? ${ORDER} LIMIT 1000`).bind(job)
    : DB.prepare(`SELECT * FROM leads ${ORDER} LIMIT 2000`);
  const { results } = await stmt.all();
  return json({ leads: results.map(leadRow) });
}
