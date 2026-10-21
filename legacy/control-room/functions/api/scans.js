// GET  /api/scans → recent Map Rank scans
// POST /api/scans {keyword, town, grid, spacing} → record a scan and start the "Map rank scan" GitHub workflow
import { startWorkflow } from "../_lib/github.js";
import { bad, db, json, now } from "../_lib/util.js";

const GRIDS = [3, 5, 7, 9, 11, 13];
const SPACINGS = [400, 800, 1600, 3200]; // metres: quarter mile, half mile, 1 mile, 2 miles

export async function onRequestGet({ env }) {
  const DB = await db(env);
  const { results } = await DB.prepare("SELECT * FROM scans ORDER BY created_at DESC LIMIT 40").all();
  return json({ scans: results });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad("Send JSON");
  }
  const keyword = String(body.keyword || "").trim();
  const town = String(body.town || "").trim();
  const grid = Number(body.grid);
  const spacing = Number(body.spacing);
  if (keyword.length < 2 || keyword.length > 60) return bad("Type a keyword, e.g. roofer");
  if (town.length < 2 || town.length > 60) return bad("Type a UK town, e.g. Warrington");
  if (!GRIDS.includes(grid)) return bad(`Grid must be one of ${GRIDS.join(", ")}`);
  if (!SPACINGS.includes(spacing)) return bad("Pick a distance between points from the list");

  const DB = await db(env);
  const id = crypto.randomUUID();
  const ts = now();
  await DB.prepare(
    "INSERT INTO scans (id, keyword, town, grid, spacing_m, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'manual', 'queued', ?, ?)"
  ).bind(id, keyword, town, grid, spacing, ts, ts).run();
  const error = await startWorkflow(env, "map-rank.yml", { keyword, town, grid: String(grid), spacing: String(spacing), scan_id: id });
  if (error) {
    await DB.prepare("UPDATE scans SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(error, now(), id).run();
  }
  const scan = await DB.prepare("SELECT * FROM scans WHERE id = ?").bind(id).first();
  return json({ scan }, error ? 502 : 201);
}
