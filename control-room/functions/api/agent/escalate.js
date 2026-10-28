// POST /api/agent/escalate (agent token) {message_id, intent, reason, draft} → the reply Routine (aetos-reply, stage 7,
// docs/rebuild/07-replies-calls.md) hands an angry, legal, unclear or other message to Nik instead of answering it.
// escalateMessage in _lib/replies-db.js adds the `escalation` Todo with Claude's draft, marks the thread's waiting
// messages handled and moves the stage to needs_nik; nothing is sent. 200 {ok, todo_id}, 404 unknown message, 409
// already handled / a newer message waiting, 422 {error, reasons} for anything Claude must fix. Tested in
// tests/escalate.test.mjs.
import { requireAgent } from "../../_lib/agentAuth.js";
import { escalateMessage } from "../../_lib/replies-db.js";
import { db, json } from "../../_lib/util.js";

const NOT_OBJECT = "Body must be a JSON object.";

/** `context.now` (tests) or the time now. */
export async function onRequestPost(context) {
  const { request, env } = context;
  const DB = await db(env);
  const denied = await requireAgent(request, env, DB);
  if (denied) return denied;

  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: NOT_OBJECT, reasons: [NOT_OBJECT] }, 400);
  const { message_id, intent, reason, draft } = input;
  const result = await escalateMessage(DB, { message_id, intent, reason, draft, now: context.now ?? new Date() });
  return json(result.body, result.status);
}
