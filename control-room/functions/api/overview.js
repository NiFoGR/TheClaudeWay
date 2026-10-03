// GET /api/overview → the Home page: who to contact next, pipeline counts, money headline, latest runs.
import { loadMoney } from "../_lib/money.js";
import { db, json, leadRow } from "../_lib/util.js";

export async function onRequestGet({ env }) {
  const DB = await db(env);
  const [counts, next, jobs] = await DB.batch([
    DB.prepare(
      `SELECT COUNT(*) AS total, SUM(status = 'new') AS fresh, SUM(status = 'new' AND email IS NOT NULL AND email != '') AS fresh_email,
              SUM(status = 'contacted') AS contacted, SUM(status = 'replied') AS replied,
              SUM(status = 'call booked') AS call_booked, SUM(status = 'won') AS won
       FROM leads WHERE excluded = 0`
    ),
    DB.prepare(
      `SELECT leads.*, m.scan_id AS map_scan_id FROM leads LEFT JOIN lead_map_rank m ON m.place_id = leads.place_id
       WHERE leads.excluded = 0 AND leads.status = 'new' ORDER BY leads.quality_score DESC, leads.rating DESC LIMIT 6`
    ),
    DB.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 4"),
  ]);
  const { summary } = await loadMoney(DB);
  return json({ counts: counts.results[0] || {}, next: next.results.map(leadRow), jobs: jobs.results, money: summary });
}
