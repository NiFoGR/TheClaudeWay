// GET /api/research/<place_id> → {research: the parsed research row | null, waiting: leads queued for research}: what
// the lead drawer's "Claude's research" card shows (stage 2, 03-research-grade.md; public/js/researchcard.js renders
// it). Behind the login like every owner route (_middleware.js). Read-only; "Research is wrong" is
// POST /api/research/<place_id>/wrong. Tested in tests/research-owner.test.mjs.
import { getResearch } from "../../_lib/research-db.js";
import { db, json } from "../../_lib/util.js";

export async function onRequestGet({ env, params }) {
  const DB = await db(env);
  return json(await getResearch(DB, typeof params?.id === "string" ? params.id : ""));
}
