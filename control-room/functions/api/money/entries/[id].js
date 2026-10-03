// PATCH /api/money/entries/:id {ended_on: "YYYY-MM-DD" | null} → stop (or restart) a monthly cost.
// DELETE /api/money/entries/:id → remove an entry added by mistake.
import { isDate } from "../../../_lib/money.js";
import { bad, db, json } from "../../../_lib/util.js";

export async function onRequestPatch({ request, env, params }) {
  const body = await request.json().catch(() => ({}));
  if (body.ended_on !== null && !isDate(body.ended_on)) return bad("Pick the date it stopped");
  const DB = await db(env);
  await DB.prepare("UPDATE money SET ended_on = ? WHERE id = ?").bind(body.ended_on, params.id).run();
  return json({ entry: await DB.prepare("SELECT * FROM money WHERE id = ?").bind(params.id).first() });
}

export async function onRequestDelete({ env, params }) {
  const DB = await db(env);
  await DB.prepare("DELETE FROM money WHERE id = ?").bind(params.id).run();
  return json({ ok: true });
}
