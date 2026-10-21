// POST /api/outreach/briefs {step, text} → the owner's own wording for a step. Claude's next run turns it into proper
// versions (placeholders filled per lead, playbook rules applied); they come back here as proposals to approve.
import { bad, db, json, now } from "../../_lib/util.js";

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  const step = Number(b.step);
  const text = String(b.text || "").trim();
  if (![1, 2, 3, 4].includes(step)) return bad("Pick which email this is for");
  if (text.length < 10 || text.length > 4000) return bad("Write how you'd say it (a few lines is enough)");
  const DB = await db(env);
  const id = crypto.randomUUID();
  await DB.prepare("INSERT INTO outreach_briefs (id, step, text, created_at) VALUES (?, ?, ?, ?)").bind(id, step, text, now()).run();
  return json({ id }, 201);
}
