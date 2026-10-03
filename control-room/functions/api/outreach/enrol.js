// POST /api/outreach/enrol {place_ids: [...], action: "start" | "stop"} → add leads to outreach (the owner's click starts
// the sequence; nothing is emailed before it) or take them back out before anything was sent.
import { bad, db, json, now } from "../../_lib/util.js";

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  const ids = [...new Set(Array.isArray(b.place_ids) ? b.place_ids.map(String) : [])].slice(0, 500);
  if (!ids.length) return bad("Pick at least one lead");
  const start = b.action !== "stop";
  const DB = await db(env);
  const added = [];
  const skipped = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await DB.prepare(
      `SELECT place_id, name, email, status, excluded, exclude_reason FROM leads WHERE place_id IN (${chunk.map(() => "?").join(",")})`
    ).bind(...chunk).all();
    for (const l of results) {
      const why = !start ? (l.status === "in outreach" ? "" : "Not in outreach")
        : l.excluded ? `Excluded: ${l.exclude_reason || "not a fit"}`
        : !l.email ? "No email: call them instead"
        : l.status === "in outreach" ? "Already in outreach"
        : l.status !== "new" ? `Already ${l.status}`
        : "";
      (why ? skipped : added).push({ place_id: l.place_id, name: l.name, reason: why });
    }
  }
  if (added.length) {
    const ts = now();
    await DB.batch(added.map((l) => DB.prepare("UPDATE leads SET status = ?, updated_at = ? WHERE place_id = ?")
      .bind(start ? "in outreach" : "new", ts, l.place_id)));
  }
  return json({ added: added.length, skipped, status: start ? "in outreach" : "new" });
}
