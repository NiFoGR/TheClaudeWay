// GET /api/agent/research-queue?limit=8 (agent token) → {leads, remaining}: the next queued leads for Claude's research
// Routine (stage 2, 03-research-grade.md), each with everything the scraper already knows, claimed for 3 hours so two
// runs never research the same lead. Re-checks ("Research is wrong") come first, carrying the earlier research and
// Nik's note. Excluded, deleted and do-not-contact leads are skipped first. The rules live in _lib/research-db.js
// (claimQueue). `limit` is 1–8 (missing or 0 → 8). Tested in tests/research-queue.test.mjs.
import { requireAgent } from "../../_lib/agentAuth.js";
import { claimQueue, queueLimit } from "../../_lib/research-db.js";
import { db, json } from "../../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ request, env, now }) {
  const DB = await db(env);
  const denied = await requireAgent(request, env, DB);
  if (denied) return denied;
  const url = new URL(request.url);
  const limit = queueLimit(url.searchParams.get("limit"));
  return json(await claimQueue(DB, { limit, now: now ?? new Date(), origin: url.origin }));
}
