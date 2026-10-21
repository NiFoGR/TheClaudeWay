// PUT /api/outreach/settings {first} → the name emails are signed with.
import { putSetting } from "../../_lib/outreach-db.js";
import { bad, db, json } from "../../_lib/util.js";

export async function onRequestPut({ request, env }) {
  const b = await request.json().catch(() => ({}));
  const first = String(b.first || "").trim();
  if (first.length < 2 || first.length > 30) return bad("The name you sign emails with, e.g. Nik");
  const DB = await db(env);
  await putSetting(DB, "outreach_sender", { first });
  return json({ ok: true });
}
