// GET /api/outreach → the current test (versions + numbers), proposals, follow-ups, past tests, who can be emailed.
import { eligibilitySummary, loadOutreach } from "../_lib/outreach-db.js";
import { db, json } from "../_lib/util.js";

export async function onRequestGet({ env }) {
  const DB = await db(env);
  const data = await loadOutreach(DB);
  return json({ ...data, eligibility: await eligibilitySummary(DB, data.guessedAllowed), sendingConnected: false });
}
