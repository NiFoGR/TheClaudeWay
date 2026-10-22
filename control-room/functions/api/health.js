// GET /api/health → {lights, gaps} (login required, like every /api/ path but /api/tick): stage 0's 10 health lights
// followed by every light a later stage registered, and what's still to set up. Importing tick.js also registers
// those lights: it imports every stage's tick step, and each of those modules calls registerLight when it loads.
import { healthFromDb } from "../_lib/health.js";
import { errorText } from "../_lib/tick.js";
import { bad, db, json } from "../_lib/util.js";

export async function onRequestGet({ env }) {
  try {
    const DB = await db(env);
    return json(await healthFromDb(DB, env, new Date()));
  } catch (err) {
    // In plain English (db() says how to bind the database), with any secret hidden.
    return bad(errorText(err, env), 500);
  }
}
