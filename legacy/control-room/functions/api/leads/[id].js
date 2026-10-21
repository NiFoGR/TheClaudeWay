// PATCH /api/leads/<place_id> {status?, notes?} → update what you've done with a lead.
import { LEAD_STATUSES, bad, db, json, leadRow, now } from "../../_lib/util.js";

export async function onRequestPatch({ request, env, params }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad("Send JSON");
  }
  const sets = [];
  const values = [];
  if (body.status !== undefined) {
    if (!LEAD_STATUSES.includes(body.status)) return bad(`Status must be one of: ${LEAD_STATUSES.join(", ")}`);
    sets.push("status = ?");
    values.push(body.status);
  }
  if (body.notes !== undefined) {
    sets.push("notes = ?");
    values.push(String(body.notes).slice(0, 5000));
  }
  if (!sets.length) return bad("Nothing to update");

  const DB = await db(env);
  const result = await DB.prepare(`UPDATE leads SET ${sets.join(", ")}, updated_at = ? WHERE place_id = ?`)
    .bind(...values, now(), params.id)
    .run();
  if (!result.meta.changes) return bad("Lead not found", 404);
  const row = await DB.prepare("SELECT * FROM leads WHERE place_id = ?").bind(params.id).first();
  return json({ lead: leadRow(row) });
}
