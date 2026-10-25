// PUT /api/voice/followups/:step {body} → {template}: Nik pressed Save on a follow-up card on the Voice page (stage
// 5–6, docs/rebuild/06-email-followups.md Part A §A7, Task 12). The text is saved as he wrote it (line endings as \n)
// and the step is a draft again, whatever changed: status 'draft', approved_at NULL, so no follow-up is queued until
// he approves it (and all 9) again. A text that fails checkFollowup is still saved; its issues come back in
// `template` (the same shape as GET /api/voice's templates, with its preview) and Approve stays off.
// Refusals, nothing saved: 404 for a step that isn't 1 to 9, 400 when `body` isn't text or is over 2,000 characters.
// Works before the templates are seeded (the step is written with its day; ensureTemplates adds the rest).
// Behind the login (_middleware.js). D1: one batch of 2 (the save, the preview lead).
// Tested in control-room/tests/voice.test.mjs.
import { FOLLOWUP_DAYS } from "../../../../_lib/followups.js";
import { bad, db, json } from "../../../../_lib/util.js";
import { NO_STEP, lf, previewFrom, previewRead, stepOf, templateView, tooLong } from "../../index.js";

export const NO_TEXT = "The follow-up's text didn't arrive. Refresh the page and try again.";

const SAVE_SQL = `INSERT INTO followup_templates (step, day_offset, body, status, approved_at) VALUES (?1, ?2, ?3, 'draft', NULL)
  ON CONFLICT (step) DO UPDATE SET body = excluded.body, status = 'draft', approved_at = NULL
  RETURNING step, day_offset, body, status, approved_at`;

/** `context.now` (tests) or the time now. */
export async function onRequestPut({ request, env, params, now }) {
  const step = stepOf(params);
  if (!step) return bad(NO_STEP, 404);
  const input = await request.json().catch(() => null);
  const text = input !== null && typeof input === "object" && !Array.isArray(input) ? input.body : undefined;
  if (typeof text !== "string") return bad(NO_TEXT);
  const body = lf(text);
  const long = tooLong(body);
  if (long) return bad(long);

  const DB = await db(env);
  const [saved, lead] = await DB.batch([
    DB.prepare(SAVE_SQL).bind(step, FOLLOWUP_DAYS[step - 1], body),
    previewRead(DB, now ?? new Date()),
  ]);
  return json({ template: templateView(saved.results[0], previewFrom(lead.results)) });
}
