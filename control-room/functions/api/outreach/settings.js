// PUT /api/outreach/settings {name, first, address} → who the emails are from (the footer the law requires).
import { putSetting } from "../../_lib/outreach-db.js";
import { bad, db, json } from "../../_lib/util.js";

export async function onRequestPut({ request, env }) {
  const b = await request.json().catch(() => ({}));
  const name = String(b.name || "").trim();
  const first = String(b.first || "").trim();
  const address = String(b.address || "").trim();
  if (name.length < 3 || name.length > 80) return bad("Your name as the law needs it, e.g. N. Surname");
  if (first.length < 2 || first.length > 30) return bad("The first name you sign emails with");
  if (address.length < 8 || address.length > 160) return bad("A business address (a virtual office is fine)");
  const DB = await db(env);
  await putSetting(DB, "outreach_sender", { name, first, address });
  return json({ ok: true });
}
