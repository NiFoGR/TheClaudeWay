// GET /api/scans/<id> → one scan with every grid point and every business's results, for the heatmap.
import { bad, db, json, parseJson } from "../../_lib/util.js";

export async function onRequestGet({ env, params }) {
  const DB = await db(env);
  const scan = await DB.prepare("SELECT * FROM scans WHERE id = ?").bind(params.id).first();
  if (!scan) return bad("Scan not found", 404);
  const [points, businesses, leads] = await Promise.all([
    DB.prepare("SELECT idx, row, col, lat, lng, ranking FROM scan_points WHERE scan_id = ? ORDER BY idx").bind(params.id).all(),
    DB.prepare("SELECT * FROM scan_businesses WHERE scan_id = ? ORDER BY avg_rank ASC, found_pct DESC").bind(params.id).all(),
    // which of these businesses are already leads (to link back and show their score)
    DB.prepare(
      "SELECT l.place_id, l.quality_score, l.status, l.website FROM leads l JOIN scan_businesses b ON b.place_id = l.place_id WHERE b.scan_id = ?"
    ).bind(params.id).all(),
  ]);
  const leadInfo = Object.fromEntries(leads.results.map((l) => [l.place_id, l]));
  return json({
    scan,
    points: points.results.map((p) => ({ ...p, ranking: parseJson(p.ranking, []) })),
    businesses: businesses.results.map((b) => ({ ...b, ranks: parseJson(b.ranks, []), lead: leadInfo[b.place_id] || null })),
  });
}
