// POST /api/outreach/versions {step, name, hypothesis, subject, body} → a new version written by the owner, as a proposal.
import { check } from "../../_lib/outreach-db.js";
import { bad, db, json, now } from "../../_lib/util.js";

export async function createVersion(DB, body, author) {
  const step = Number(body.step);
  const name = String(body.name || "").trim();
  const text = String(body.body || "").trim();
  const subject = String(body.subject || "").trim();
  if (![1, 2, 3, 4].includes(step)) return { error: "Step must be 1–4" };
  if (name.length < 3 || name.length > 80) return { error: "Give it a short name" };
  if (text.length < 20 || text.length > 2000) return { error: "Write the email body" };
  if (step === 1 && !subject) return { error: "The first email needs a subject" };
  const version = { id: crypto.randomUUID(), step, name, hypothesis: String(body.hypothesis || "").slice(0, 500), subject, body: text, author, parent_id: body.parent_id || null };
  await DB.prepare(
    "INSERT INTO outreach_versions (id, step, name, hypothesis, subject, body, status, author, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)"
  ).bind(version.id, step, name, version.hypothesis, subject, text, author, version.parent_id, now()).run();
  return { version, ...(await check(DB, version)) };
}

export async function onRequestPost({ request, env }) {
  const DB = await db(env);
  const out = await createVersion(DB, await request.json().catch(() => ({})), "owner");
  return out.error ? bad(out.error) : json(out, 201);
}
