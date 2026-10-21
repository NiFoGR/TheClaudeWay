// PUT /api/money/goal {goal: "5000"} → the monthly recurring income you're aiming for.
import { toPence } from "../../_lib/money.js";
import { bad, db, json } from "../../_lib/util.js";

export async function onRequestPut({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const goal = toPence(body.goal);
  if (!(goal >= 10000)) return bad("Goal must be at least £100 a month");
  const DB = await db(env);
  await DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('mrr_goal_pence', ?)").bind(String(goal)).run();
  return json({ goal });
}
