// GET /api/leads?job=<id>  → leads found by one run
// GET /api/leads           → every lead (newest scrape first), for the Leads page
import { db, json, leadRow } from "../_lib/util.js";

const ORDER = "ORDER BY leads.excluded ASC, leads.quality_score DESC, leads.rating DESC, leads.review_count DESC";
// latest Map Rank scan per lead, for the "view heatmap" link
// plus their latest demo site and how often they've looked at it
const SELECT = `SELECT leads.*, m.scan_id AS map_scan_id,
  (SELECT slug FROM demos d WHERE d.place_id = leads.place_id ORDER BY created_at DESC LIMIT 1) AS demo_slug,
  (SELECT expires_at FROM demos d WHERE d.place_id = leads.place_id ORDER BY created_at DESC LIMIT 1) AS demo_expires,
  (SELECT COUNT(*) FROM demo_events e WHERE e.place_id = leads.place_id AND e.kind = 'view') AS demo_views,
  (SELECT COUNT(*) FROM demo_events e WHERE e.place_id = leads.place_id AND e.kind = 'order_page') AS demo_order_views
  FROM leads LEFT JOIN lead_map_rank m ON m.place_id = leads.place_id`;

export async function onRequestGet({ request, env }) {
  const DB = await db(env);
  const job = new URL(request.url).searchParams.get("job");
  const stmt = job
    ? DB.prepare(`${SELECT} WHERE leads.last_job_id = ? ${ORDER} LIMIT 1000`).bind(job)
    : DB.prepare(`${SELECT} ${ORDER} LIMIT 2000`);
  const { results } = await stmt.all();
  return json({ leads: results.map(leadRow) });
}
