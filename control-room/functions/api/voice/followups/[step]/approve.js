// POST /api/voice/followups/:step/approve [{body}] → {template, approved, all}: Nik pressed Approve on a follow-up card
// on the Voice page (stage 5–6, docs/rebuild/06-email-followups.md Part A §A7 and §A10, Task 12). The stored text must
// pass checkFollowup, else 400 {error: its first issue, issues}. Approved keeps the date of the first approval of this
// text (re-approving changes nothing; any save makes it a draft, so the next approval is a new date). `approved` and
// `all` are followupsApproved's count afterwards; once all 9 are approved the "Approve your 9 follow-up emails" todo
// (setup:followups) is closed. Follow-ups use the wording at the moment each one is queued (Task 8's queueDue).
// Optional `body`: the text the page showed. When it isn't the stored one (he edited the box without pressing Save, or
// another tab saved since), 409 and nothing changes, so Nik only ever approves the words he read; the same 409 if a
// save lands between the check and the write. The message covers both causes, so it's true whichever it was.
// Seeds the templates first (ensureTemplates), so a step can be approved on a fresh database.
// Refusals: 404 for a step that isn't 1 to 9. Behind the login (_middleware.js).
// D1: 5 statements (ensureTemplates; one batch of 2: the template, the preview lead; the approval; the count), plus 1
// to close the todo when all 9 are approved. Tested in control-room/tests/voice.test.mjs.
import { checkFollowup, ensureTemplates, followupsApproved } from "../../../../_lib/followups.js";
import { closeTodos } from "../../../../_lib/todo.js";
import { bad, db, iso, json } from "../../../../_lib/util.js";
import { NO_STEP, lf, previewFrom, previewRead, stepOf, templateView } from "../../index.js";

export const CHANGED = "This text isn't the one that's saved. Press Save first (or refresh the page if it was changed somewhere else), then approve.";
/** The todo the followups tick step adds while any template is a draft (Part A §A10). */
export const SETUP_DEDUPE = "setup:followups";

const READ_SQL = "SELECT step, day_offset, body, status, approved_at FROM followup_templates WHERE step = ?1";
// Only the text that was checked (?3) is approved. SET reads the row as it was, so an approved row keeps its date.
const APPROVE_SQL = `UPDATE followup_templates SET status = 'approved',
    approved_at = CASE WHEN status = 'approved' AND approved_at IS NOT NULL THEN approved_at ELSE ?1 END
  WHERE step = ?2 AND body = ?3
  RETURNING step, day_offset, body, status, approved_at`;

/** `context.now` (tests) or the time now. */
export async function onRequestPost({ request, env, params, now }) {
  const step = stepOf(params);
  if (!step) return bad(NO_STEP, 404);
  const input = await request.json().catch(() => null); // no body is fine
  const shown = input !== null && typeof input === "object" && typeof input.body === "string" ? lf(input.body) : null;

  const DB = await db(env);
  const at = now ?? new Date();
  await ensureTemplates(DB);
  const [found, lead] = await DB.batch([DB.prepare(READ_SQL).bind(step), previewRead(DB, at)]);
  const row = found.results?.[0];
  if (!row) return bad(NO_STEP, 404); // ensureTemplates has just written every step: only if it was deleted since
  if (shown !== null && shown !== row.body) return bad(CHANGED, 409);
  const issues = checkFollowup(typeof row.body === "string" ? row.body : String(row.body ?? ""));
  if (issues.length) return json({ error: issues[0], issues }, 400);

  const approvedRow = await DB.prepare(APPROVE_SQL).bind(iso(at), step, row.body).first();
  if (!approvedRow) return bad(CHANGED, 409);
  const { approved, all } = await followupsApproved(DB);
  if (all) await closeTodos(DB, SETUP_DEDUPE);
  return json({ template: templateView(approvedRow, previewFrom(lead.results)), approved, all });
}
