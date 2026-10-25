// DELETE /api/voice/examples/:id → {ok: true}: Nik pressed Delete on one of his examples or rules, or on a first email
// he sent (id "sent:<message id>", source nik_sent), on the Voice page (stage 5–6, docs/rebuild/06-email-followups.md
// Part A §A7, Task 12). A deleted row is gone for good: the reply Routine (stage 7) stops using it, and a sent first
// email is only saved once (when it went), so it never comes back. 404 when it isn't there (already deleted).
// The id is matched as it arrives and decoded ("sent%3Aabc" and "sent:abc"), so it's found whether or not the router
// decoded the path; no id is ever stored with a "%" in it. Behind the login (_middleware.js). D1: 1 statement.
// Tested in control-room/tests/voice.test.mjs.
import { bad, db, json } from "../../../_lib/util.js";

export const GONE = "That one isn't there any more. Refresh the page.";

function decoded(id) {
  try {
    return decodeURIComponent(id);
  } catch {
    return id; // a "%" that isn't an escape: there's nothing to decode
  }
}

export async function onRequestDelete({ env, params }) {
  const id = typeof params?.id === "string" ? params.id : "";
  if (!id) return bad(GONE, 404);
  const DB = await db(env);
  const { meta } = await DB.prepare("DELETE FROM style_examples WHERE id IN (?1, ?2)").bind(id, decoded(id)).run();
  if (!meta.changes) return bad(GONE, 404);
  return json({ ok: true });
}
