// GET /api/leads?job=<id>  → leads found by one run
// GET /api/leads           → every lead (newest scrape first), for the Leads page
import { db, json, leadRow } from "../_lib/util.js";

const ORDER = "ORDER BY leads.excluded ASC, leads.quality_score DESC, leads.rating DESC, leads.review_count DESC";
// latest Map Rank scan per lead, for the "view heatmap" link
const SELECT = "SELECT leads.*, m.scan_id AS map_scan_id FROM leads LEFT JOIN lead_map_rank m ON m.place_id = leads.place_id";

export async function onRequestGet({ request, env }) {
  const DB = await db(env);
  const job = new URL(request.url).searchParams.get("job");
  const stmt = job
    ? DB.prepare(`${SELECT} WHERE leads.last_job_id = ? ${ORDER} LIMIT 1000`).bind(job)
    : DB.prepare(`${SELECT} ${ORDER} LIMIT 2000`);
  const { results } = await stmt.all();
  return json({ leads: results.map(leadRow) });
}
