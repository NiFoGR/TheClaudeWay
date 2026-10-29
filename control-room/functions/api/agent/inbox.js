// GET /api/agent/inbox (agent token) → everything the reply Routine (aetos-reply, stage 7,
// docs/rebuild/07-replies-calls.md) needs in one request: {paused, now_uk, inside_hours, send_at, offer, voice,
// conversations}. Claude never reads the database another way. Nik's two example replies are added first if they
// never were (seedVoice; GET /api/voice does the same, whichever runs first). The rules live in _lib/replies-db.js
// (buildInbox). Reads only, apart from that one-time seed and buildInbox's sweep (mail still waiting in a client's or an
// opted-out thread is handed to Nik, at most 20 D1 statements a read). Tested in tests/agent-inbox.test.mjs.
import { requireAgent } from "../../_lib/agentAuth.js";
import { buildInbox, seedVoice } from "../../_lib/replies-db.js";
import { db, json } from "../../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ request, env, now }) {
  const DB = await db(env);
  const denied = await requireAgent(request, env, DB);
  if (denied) return denied;
  const at = now ?? new Date();
  await seedVoice(DB, at);
  return json(await buildInbox(DB, at));
}
