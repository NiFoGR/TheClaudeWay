// POST /api/replies/test-prospect {email} → Nik's own address as a lead (stage 7, docs/rebuild/07-replies-calls.md
// Task 17; "Add my email as a test lead" on the Replies page), so he can email his Aetos mailbox and see Claude's
// replies arrive for real. The prospect is test:nik: stage emailed, greet_name "Nik", the first active cold mailbox
// (oldest first), no leads row (Claude is shown DRILL_LEAD for it). Adding it again starts it afresh (stage emailed,
// no lost reason) with the address given: its offered or booked test call is cancelled (so it frees Nik's day) and its
// open Todos are dismissed. Unlike the drill its replies really go, so it needs a mailbox, and these are refused: an
// address on the do-not-email list (the outbox would cancel every reply to it), one of our own mailboxes (Claude's
// reply to it would come back in as a new email from the lead, and be answered again, forever) and a real lead's
// address (its mail would link to two prospects). KPIs leave test: out.
// 200 {ok, place_id, email, mailbox}; 422 {error} in plain English; 400 when the body isn't JSON. Behind the login
// (_middleware.js). Tested in tests/reply-drill.test.mjs.
import { isSuppressed } from "../../_lib/prospects.js";
import { bad, db, iso, json } from "../../_lib/util.js";

const PLACE_ID = "test:nik";
const EMAIL_RE = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[A-Za-z]{2,}$/;
const EMAIL_MAX = 254;

const UNREADABLE = "Couldn't add it: the request wasn't readable. Refresh the page and try again.";
const BAD_EMAIL = "Couldn't add it: type the email address you'll send the test emails from.";
const NO_MAILBOX = "Couldn't add it: there's no cold mailbox to answer from yet. Add one on Setup → Mailboxes, then try again.";
const suppressed = (email) => `Couldn't add it: ${email} is on the do-not-email list, so no reply would reach it. Use another address.`;
const OWN_MAILBOX = "Couldn't add it: that's one of your Aetos mailboxes. Use the address you'll send the test emails from, e.g. your Gmail.";
const REAL_LEAD = "Couldn't add it: that address belongs to one of your leads. Use your own address, e.g. your Gmail.";

const MAILBOX_SQL = `SELECT id, address FROM mailboxes WHERE role = 'cold' AND status = 'active'
  ORDER BY created_at, id LIMIT 1`;
// Is the address one of our mailboxes (any role or status), or a real prospect's? One statement.
const CLASH_SQL = `SELECT
    EXISTS (SELECT 1 FROM mailboxes WHERE lower(address) = ?1) AS own,
    EXISTS (SELECT 1 FROM prospects WHERE lower(email) = ?1 AND place_id <> ?2) AS lead`;
const UPSERT_SQL = `INSERT INTO prospects (place_id, stage, stage_at, email, greet_name, mailbox_id, subject, created_at, updated_at)
  VALUES (?1, 'emailed', ?2, ?3, 'Nik', ?4, 'Your new website', ?2, ?2)
  ON CONFLICT (place_id) DO UPDATE SET stage = 'emailed', stage_at = ?2, email = ?3, greet_name = 'Nik', mailbox_id = ?4,
    lost_reason = NULL, updated_at = ?2`;
const CANCEL_CALLS_SQL = `UPDATE calls SET status = 'cancelled', updated_at = ?2
  WHERE place_id = ?1 AND status IN ('offered', 'confirmed')`;
const DISMISS_TODOS_SQL = "UPDATE todos SET status = 'dismissed', done_at = ?2 WHERE place_id = ?1 AND status = 'open'";

/** `context.now` (tests) or the time now. */
export async function onRequestPost(context) {
  const { request, env } = context;
  const input = await request.json().catch(() => undefined);
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad(UNREADABLE);
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return json({ error: BAD_EMAIL }, 422);

  const DB = await db(env);
  const mailbox = await DB.prepare(MAILBOX_SQL).first();
  if (!mailbox) return json({ error: NO_MAILBOX }, 422);
  const clash = await DB.prepare(CLASH_SQL).bind(email, PLACE_ID).first();
  if (Number(clash?.own) === 1) return json({ error: OWN_MAILBOX }, 422);
  if (Number(clash?.lead) === 1) return json({ error: REAL_LEAD }, 422);
  if (await isSuppressed(DB, email)) return json({ error: suppressed(email) }, 422);

  const stamp = iso(context.now ?? new Date());
  await DB.batch([
    DB.prepare(UPSERT_SQL).bind(PLACE_ID, stamp, email, mailbox.id),
    DB.prepare(CANCEL_CALLS_SQL).bind(PLACE_ID, stamp),
    DB.prepare(DISMISS_TODOS_SQL).bind(PLACE_ID, stamp),
  ]);
  return json({ ok: true, place_id: PLACE_ID, email, mailbox: mailbox.address });
}
