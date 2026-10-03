// POST /api/agent/questions {question, why, options?: [..], topic?} → Claude asks the owner how he'd handle something
// (an email's tone, a kind of reply, an offer). It shows on the Outreach page; his answer guides every later run.
import { agentDenied } from "../../_lib/agent.js";
import { bad, db, json, now } from "../../_lib/util.js";

const MAX_OPEN = 3;

export async function onRequestPost({ request, env }) {
  const denied = agentDenied(request, env);
  if (denied) return denied;
  const b = await request.json().catch(() => ({}));
  const question = String(b.question || "").trim().slice(0, 500);
  if (question.length < 10) return bad("Write the question in full");
  const options = (Array.isArray(b.options) ? b.options : []).map((o) => String(o).trim().slice(0, 200)).filter(Boolean).slice(0, 4);
  const DB = await db(env);
  const open = await DB.prepare("SELECT COUNT(*) AS n FROM owner_questions WHERE answer IS NULL").first();
  if (open.n >= MAX_OPEN) return bad(`${MAX_OPEN} questions are already waiting for the owner. Ask again once he's answered.`, 429);
  const id = crypto.randomUUID();
  await DB.prepare("INSERT INTO owner_questions (id, topic, question, why, options, asked_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, String(b.topic || "outreach").slice(0, 40), question, String(b.why || "").slice(0, 300), JSON.stringify(options), now()).run();
  return json({ id }, 201);
}
