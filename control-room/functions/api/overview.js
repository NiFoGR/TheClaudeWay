// GET /api/overview → the Home page: who to contact next, pipeline counts, money headline, latest runs.
import { loadMoney } from "../_lib/money.js";
import { db, json, leadRow } from "../_lib/util.js";

// "Contact these next": leads.status is only ever moved to 'won' now (stage 3 removed the Status select), so status
// 'new' alone would list the same leads for good. Leave out what Nik or Claude already decided on: Not a fit
// (research skipped), too big, excluded, emailed (any stage after `ready`), and the do-not-contact list, tested on the
// address we'd write to, its domain and the company number (the same test as SUPPRESSED_SQL in _lib/shortlist-db.js).
const EMAIL_SQL = "COALESCE(NULLIF(p.email, ''), NULLIF(r.best_email, ''), NULLIF(l.email, ''))";
const NEXT_SQL = `SELECT l.*, m.scan_id AS map_scan_id FROM leads l
  LEFT JOIN lead_map_rank m ON m.place_id = l.place_id
  LEFT JOIN research r ON r.place_id = l.place_id
  LEFT JOIN prospects p ON p.place_id = l.place_id
  WHERE l.excluded = 0 AND l.status = 'new'
    AND COALESCE(r.status, '') <> 'skipped' AND COALESCE(r.too_big, 0) = 0
    AND (p.place_id IS NULL OR p.stage = 'ready')
    AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.value IN
      (lower(${EMAIL_SQL}), lower(substr(${EMAIL_SQL}, instr(${EMAIL_SQL}, '@') + 1)), COALESCE(l.company_number, '')))
  ORDER BY l.quality_score DESC, l.rating DESC LIMIT 6`;

export async function onRequestGet({ env }) {
  const DB = await db(env);
  const [counts, next, jobs] = await DB.batch([
    DB.prepare(
      // Won: a card payer is won on their prospect (stage 9 never writes leads), a client added by hand on Money on
      // leads.status. prospects is keyed by place_id, so the join adds no rows.
      `SELECT COUNT(*) AS total, SUM(l.status = 'new') AS fresh,
              SUM(l.status = 'new' AND l.email IS NOT NULL AND l.email != '') AS fresh_email,
              SUM(l.status = 'contacted') AS contacted, SUM(l.status = 'replied') AS replied,
              SUM(l.status = 'call booked') AS call_booked, SUM(l.status = 'won' OR COALESCE(p.stage, '') = 'won') AS won
       FROM leads l LEFT JOIN prospects p ON p.place_id = l.place_id WHERE l.excluded = 0`
    ),
    DB.prepare(NEXT_SQL),
    DB.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 4"),
  ]);
  const { summary } = await loadMoney(DB);
  return json({ counts: counts.results[0] || {}, next: next.results.map(leadRow), jobs: jobs.results, money: summary });
}
