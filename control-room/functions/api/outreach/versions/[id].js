// GET   /api/outreach/versions/:id → the version rendered on real leads, with quality-gate results.
// PATCH /api/outreach/versions/:id {action: approve | reject | pause | resume | retire}
import { approve, check } from "../../../_lib/outreach-db.js";
import { bad, db, json, now } from "../../../_lib/util.js";

async function load(DB, id) {
  return DB.prepare("SELECT * FROM outreach_versions WHERE id = ?").bind(id).first();
}

export async function onRequestGet({ env, params }) {
  const DB = await db(env);
  const version = await load(DB, params.id);
  if (!version) return bad("Version not found", 404);
  return json({ version, ...(await check(DB, version)) });
}

export async function onRequestPatch({ request, env, params }) {
  const DB = await db(env);
  const version = await load(DB, params.id);
  if (!version) return bad("Version not found", 404);
  const { action } = await request.json().catch(() => ({}));
  const set = (status, reason = null) => DB.prepare("UPDATE outreach_versions SET status = ?, status_reason = ?, decided_at = ? WHERE id = ?").bind(status, reason, now(), version.id).run();
  if (action === "approve" || action === "resume") {
    if (!["proposed", "paused"].includes(version.status)) return bad("Only a proposed or paused version can go live");
    const { issues } = await approve(DB, version);
    if (issues.length) return json({ error: "It doesn't pass the quality gate yet", issues }, 400);
  } else if (action === "reject") {
    if (version.status !== "proposed") return bad("Only proposals can be rejected");
    await set("rejected", "Rejected by owner");
  } else if (action === "pause") {
    if (version.status !== "live") return bad("Only a live version can be paused");
    await set("paused", "Paused by owner");
  } else if (action === "retire") {
    if (!["live", "paused"].includes(version.status)) return bad("Only a live or paused version can be retired");
    await set("retired", "Retired by owner");
  } else {
    return bad("Unknown action");
  }
  return json({ version: await load(DB, version.id) });
}
