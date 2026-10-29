// The 12-month data purge (db): the tick step `purge` (file 11, Part A "Data clean-up"). The privacy notice promises:
// "If we contacted you and you didn't become a customer, we delete your details 12 months after our last contact."
//
// Who: a place_id with no `clients` row whose last contact (the newest of its messages.created_at,
// prospects.updated_at and research.researched_at, or queued_at when not researched) is before the cutoff. A lead with
// no dated row at all is never touched.
// What goes: its prospects, messages and calls rows, the `sent:<message id>` style examples made from its first emails,
// and every Todo with its place_id; its research row is blanked to a data-free `skipped` row (made when it has none),
// never deleted (stage 1's research queue treats any research row as handled, so the lead is never researched, demoed
// or emailed again on its own). Also stage 8's `calls-day:` Todos created before the cutoff (in every round, and again
// when the month is finished, so a month with no lead due still removes them) and, once the month is finished, processed
// inbound_raw rows received before it (always keeping the newest row: Setup's "Last email received" reads it by rowid).
// Also, once the month is finished, client-site enquiries (stage 10's site_leads, contact form and chat) received
// before the cutoff, with the enquiry emails sent to the business about them: every client site's privacy page says
// "Enquiries are kept for 12 months." (docs/rebuild/09-build.md section 8). These are the only client rows it deletes.
// What stays: suppression, clients, client_links, the scraped leads row, and every other Todo with no place_id.
//
// Once a month: the step does nothing until the first tick of a new UK month, works through everything due over the
// following ticks, and sets purge:month = YYYY-MM when nothing is left.
import { getSetting } from "./settings.js";
import { ukDate, ukToUtc } from "./ukTime.js";
import { iso } from "./util.js";

export const PURGE_BATCH = 90; // leads per round
const MAX_ROUNDS = 5;
const ROUND_QUERIES = 7; // 1 select + a batch of 6
const RUN_OVERHEAD = 2; // Part B's formula: the finishing write, and the tick's beat after this step
const FINISH_QUERIES = 5; // the finishing batch: old day lists, old inbound mail, old enquiry emails, old enquiries, purge:month
const BEAT_QUERIES = 1; // the runner's tick beat, the query it always makes after the last step
const NOTES = "Skipped: details deleted 12 months after last contact.";

const CANDIDATES_SQL = `SELECT place_id, MAX(at) AS last FROM (
  SELECT place_id, created_at AS at FROM messages WHERE place_id IS NOT NULL
  UNION ALL SELECT place_id, updated_at FROM prospects
  UNION ALL SELECT place_id, COALESCE(researched_at, queued_at) FROM research
) GROUP BY place_id
HAVING last IS NOT NULL AND last < ?1
   AND place_id NOT IN (SELECT place_id FROM clients WHERE place_id IS NOT NULL)
ORDER BY last LIMIT ?2`;

// The round's ids are bound as one JSON list (?1): D1 allows only 100 bound values a statement.
const IDS = "(SELECT j.value FROM json_each(?1) AS j)";
const ROUND_SQL = [
  // First: once the messages are deleted this subquery finds nothing.
  `DELETE FROM style_examples WHERE id IN (SELECT 'sent:' || id FROM messages WHERE place_id IN ${IDS} AND kind = 'first')`,
  `DELETE FROM prospects WHERE place_id IN ${IDS}`,
  `DELETE FROM messages WHERE place_id IN ${IDS}`,
  `DELETE FROM calls WHERE place_id IN ${IDS}`,
  // ?2 = the cutoff. No other Todo with a NULL place_id is ever touched.
  `DELETE FROM todos WHERE place_id IN ${IDS} OR (place_id IS NULL AND substr(dedupe, 1, 10) = 'calls-day:' AND created_at < ?2)`,
  // The research blanking: Part B's UPDATE, as an upsert so a lead that never had a research row (a prospect or
  // messages only) gets the data-free `skipped` row too. Stage 1's queue (enqueueResearch) takes any lead with no
  // research row, so without one a purged lead whose score later reaches 35 would be researched and emailed again.
  // SQLite needs the WHERE before ON CONFLICT when an upsert takes its rows from a SELECT.
  `INSERT INTO research (place_id, status, too_big, notes) SELECT j.value, 'skipped', 0, '${NOTES}' FROM json_each(?1) AS j WHERE 1 ON CONFLICT (place_id) DO UPDATE SET status = 'skipped', grade = NULL, points = NULL, grade_reason = NULL, angle = NULL, opener = NULL, owner = NULL, best_email = NULL, best_email_why = NULL, emails = NULL, copy = NULL, site_review = NULL, searched = NULL, too_big = 0, notes = '${NOTES}', queued_at = NULL, researched_at = NULL`,
];

// The month's finishing batch: old day lists, old processed inbound mail (never the newest row), old enquiries, then
// purge:month. The day lists go here too because a round only runs when some lead is due: without this, a month with
// nobody to purge would keep a day list naming leads that were purged earlier (their last contact can be before it).
const CALLS_DAY_SQL = "DELETE FROM todos WHERE place_id IS NULL AND substr(dedupe, 1, 10) = 'calls-day:' AND created_at < ?1";
const INBOUND_SQL =
  "DELETE FROM inbound_raw WHERE processed_at IS NOT NULL AND received_at < ?1 AND rowid <> (SELECT MAX(rowid) FROM inbound_raw)";
// Old client-site enquiries: their emails first (once the site_leads rows go, this subquery finds nothing). The email's
// id is `enquiry:<lead id>` (sites/notify.js) and is also kept in site_leads.message_id.
const ENQUIRY_MAIL_SQL = `DELETE FROM messages WHERE id IN (
  SELECT message_id FROM site_leads WHERE created_at < ?1 AND message_id IS NOT NULL
  UNION SELECT 'enquiry:' || id FROM site_leads WHERE created_at < ?1)`;
const ENQUIRIES_SQL = "DELETE FROM site_leads WHERE created_at < ?1";
const MONTH_SQL = "INSERT INTO settings (key, value) VALUES ('purge:month', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/** UK midnight at the start of the same UK calendar date one year earlier (29 Feb → 28 Feb), as UTC ISO. */
export function purgeCutoff(now) {
  const [y, m, d] = ukDate(new Date(now)).split("-").map(Number);
  const day = m === 2 && d === 29 ? 28 : d;
  const date = `${String(y - 1).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return iso(ukToUtc(date, "00:00"));
}

/**
 * Purge up to `maxRounds` rounds of PURGE_BATCH leads, each 1 select + 1 DB.batch of 6 (7 queries; a select that finds
 * nobody costs only itself). → {purged, done}: done when the last select returned fewer than PURGE_BATCH ids.
 */
export async function purgeOld(DB, now, { maxRounds = 1 } = {}) {
  const cutoff = purgeCutoff(now);
  let purged = 0;
  let done = false;
  for (let round = 0; round < maxRounds; round++) {
    const { results } = await DB.prepare(CANDIDATES_SQL).bind(cutoff, PURGE_BATCH).all();
    const ids = results.map((row) => row.place_id).filter((id) => typeof id === "string" && id);
    if (ids.length) {
      const list = JSON.stringify(ids);
      await DB.batch(ROUND_SQL.map((sql, i) => (i === 4 ? DB.prepare(sql).bind(list, cutoff) : DB.prepare(sql).bind(list))));
      purged += ids.length;
    }
    if (results.length < PURGE_BATCH) {
      done = true;
      break;
    }
  }
  return { purged, done };
}

async function run(ctx) {
  const { DB, now } = ctx;
  const month = ukDate(new Date(now)).slice(0, 7);
  if ((await getSetting(DB, "purge:month")) === month) return "done this month";
  const maxRounds = Math.min(MAX_ROUNDS, Math.floor((ctx.budget.left() - RUN_OVERHEAD) / ROUND_QUERIES));
  if (!(maxRounds > 0)) return "deferred";
  const { purged, done } = await purgeOld(DB, now, { maxRounds });
  // The finishing batch is 5 statements, and the tick's beat must still fit after it (the free plan's 50 queries).
  // When the last round used that room, the month is finished on the next tick (a select that finds nobody, then
  // this batch).
  if (done && ctx.budget.left() >= FINISH_QUERIES + BEAT_QUERIES) {
    const cutoff = purgeCutoff(now);
    await DB.batch([
      DB.prepare(CALLS_DAY_SQL).bind(cutoff),
      DB.prepare(INBOUND_SQL).bind(cutoff),
      DB.prepare(ENQUIRY_MAIL_SQL).bind(cutoff),
      DB.prepare(ENQUIRIES_SQL).bind(cutoff),
      DB.prepare(MONTH_SQL).bind(month),
    ]);
    return purged ? `purged ${purged} leads` : "nothing to purge";
  }
  return purged ? `purged ${purged} leads, more next tick` : "deferred";
}

/** The tick step purge (slot 12 of overview §8: after care, before health). */
export const purgeStep = { name: "purge", everyMinutes: 60, run };
