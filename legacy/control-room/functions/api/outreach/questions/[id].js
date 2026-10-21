// PATCH /api/outreach/questions/:id {answer} → the owner answers one of Claude's questions (or changes his answer).
import { bad, db, json, now } from "../../../_lib/util.js";

export async function onRequestPatch({ request, env, params }) {
  const b = await request.json().catch(() => ({}));
  const answer = String(b.answer || "").trim().slice(0, 2000);
  if (!answer) return bad("Write your answer (a few words is fine)");
  const DB = await db(env);
  const r = await DB.prepare("UPDATE owner_questions SET answer = ?, answered_at = ? WHERE id = ?").bind(answer, now(), params.id).run();
  if (!r.meta?.changes) return bad("Question not found", 404);
  return json({ ok: true });
}
