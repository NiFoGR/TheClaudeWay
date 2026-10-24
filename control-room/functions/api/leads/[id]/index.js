// GET /api/leads/<place_id> → {detail, capacity}: everything the lead panel shows, in one request (stage 3,
// docs/rebuild/04-shortlist.md; leadDetail in _lib/shortlist-db.js, at most 4 D1 statements, never the audit or raw
// HTML). `capacity` is today's room for first emails (capacityNow, 4 more statements) when the lead is `ready`, the
// only stage with Write first email, else null: so the button is right however the panel was opened (from Home, or
// hours after the list loaded), and it agrees with the banner and stage 6's Send. PATCH /api/leads/<place_id> {notes} → {notes}: the panel's Notes box (it saves on blur). Notes are the only
// field: a lead's stage moves only through stage 0's applyStageEvent, and the old status field is gone. Both answer
// 404 {error} when the lead was deleted after the list loaded. Behind the login (_middleware.js).
// Not a fit is ./not-a-fit.js. Tested in tests/leads-api.test.mjs.
import { LEAD_GONE, capacityNow, leadDetail } from "../../../_lib/shortlist-db.js";
import { bad, db, iso, json } from "../../../_lib/util.js";

const NOTES_MAX = 5000; // characters
const ONLY_NOTES = "Only notes can be changed here.";
const NOTES_TEXT = "Notes must be text. Type them in the Notes box and click away to save.";

const idOf = (params) => (typeof params?.id === "string" ? params.id : "");

// At most NOTES_MAX characters (code points, so an emoji is never cut in half).
function cutNotes(text) {
  return text.length <= NOTES_MAX ? text : Array.from(text.slice(0, NOTES_MAX * 2)).slice(0, NOTES_MAX).join("");
}

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ env, params, now }) {
  const DB = await db(env);
  const at = now ?? new Date();
  const detail = await leadDetail(DB, idOf(params), at);
  if (!detail) return bad(LEAD_GONE, 404);
  const capacity = detail.prospect?.stage === "ready" ? await capacityNow(DB, at) : null;
  return json({ detail, capacity });
}

/** {notes: text} (null clears them) → {notes} as saved; any other field → 400 and nothing changes. */
export async function onRequestPatch({ request, env, params, now }) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(ONLY_NOTES);
  const keys = Object.keys(body);
  if (!keys.includes("notes") || keys.some((k) => k !== "notes")) return bad(ONLY_NOTES);
  if (body.notes !== null && typeof body.notes !== "string") return bad(NOTES_TEXT);
  const notes = cutNotes(body.notes ?? "");

  const DB = await db(env);
  const result = await DB.prepare("UPDATE leads SET notes = ?1, updated_at = ?2 WHERE place_id = ?3")
    .bind(notes, iso(now ?? new Date()), idOf(params))
    .run();
  if (!result.meta.changes) return bad(LEAD_GONE, 404);
  return json({ notes });
}
