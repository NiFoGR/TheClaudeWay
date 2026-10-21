// POST /api/demos {place_id} → make (or return) the lead's demo site. Used by the lead drawer's "Make demo" button.
import { ensureDemo } from "../_lib/demo-db.js";
import { bad, db, json } from "../_lib/util.js";

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  const DB = await db(env);
  const lead = await DB.prepare("SELECT place_id, name, excluded FROM leads WHERE place_id = ?").bind(String(b.place_id || "")).first();
  if (!lead) return bad("Lead not found", 404);
  if (lead.excluded) return bad("This lead is excluded, so it doesn't get a demo");
  const demo = await ensureDemo(DB, lead);
  return json({ demo, url: `/d/${demo.slug}` });
}
