// Stage 6 adds the schedule and stop rules here; keep this export and its test.
//
// Follow-ups (db helpers). followupsDueToday feeds the Shortlist's room for first emails: every follow-up that will
// go out today takes a place in the mailboxes' daily cap before any new first email does.
import { addUkDays, ukDate, ukToUtc } from "./ukTime.js";
import { iso } from "./util.js";

/**
 * How many follow-ups go out by the end of UK today and aren't counted in sentToday yet: follow-up messages still
 * `queued` (a `sending` one is already in sentToday), plus prospects whose next follow-up isn't queued yet and is due
 * before UK midnight tonight. A prospect with next_followup_at NULL is stopped or finished and never counts. Nor does
 * one with all 9 follow-ups sent (its next_followup_at is then the close time, when it's marked lost, not an email)
 * or one whose stage stops the sequence (replied and on: only `emailed` and `viewed` leads get follow-ups).
 * `now` is a Date (or UTC ISO text, as sentToday takes). Stored times are UTC ISO text, so the boundary is compared
 * as text in the same format (iso, no milliseconds). 2 D1 queries, in one batch.
 */
export async function followupsDueToday(DB, now) {
  const date = typeof now === "string" ? new Date(now) : now; // ukDate refuses anything that isn't a valid date
  const endOfToday = iso(ukToUtc(addUkDays(ukDate(date), 1), "00:00"));
  const [queued, pending] = await DB.batch([
    DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'followup' AND status = 'queued'"),
    DB.prepare(
      `SELECT COUNT(*) AS n FROM prospects
       WHERE next_followup_at < ? AND followup_step < 9 AND stage IN ('emailed', 'viewed')`,
    ).bind(endOfToday),
  ]);
  return Number(queued.results[0]?.n ?? 0) + Number(pending.results[0]?.n ?? 0);
}
