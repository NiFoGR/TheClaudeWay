// POST /api/setup/routines/<name>/test → the fireRoutine result {ok, status, error?, session_url?} (Setup → Claude →
// Test fire). The payload is the standard test text, which every Routine's preamble (routines/README.md) answers by
// posting its heartbeat and stopping, so a Test fire never does real work. Like every fire it's logged in
// routine_fires and never retried. A failed fire is still a 200: the result's ok and error say what happened.
import { fireRoutine } from "../../../../_lib/routines.js";
import { bad, db, json } from "../../../../_lib/util.js";
import { ROUTINE_ERRORS, routineNamed } from "../[name].js";

export const TEST_FIRE_TEXT = "Test from the Control Room Setup page: post your heartbeat and stop.";

export async function onRequestPost({ env, params }) {
  const routine = routineNamed(params?.name);
  if (!routine) return bad(ROUTINE_ERRORS.unknown, 404);
  const DB = await db(env);
  // env.__fetch stands in for Claude in tests only; live it's undefined, so fireRoutine uses fetch.
  return json(await fireRoutine(DB, routine.name, TEST_FIRE_TEXT, { fetchImpl: env.__fetch }));
}
