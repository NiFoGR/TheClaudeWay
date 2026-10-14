// GET /api/outreach/picks → today's suggested leads for outreach: worth pitching, a real (not guessed) email, never
// contacted, best first, as many as the day's sending capacity. The owner approves them (Start outreach) or unticks.
import { getSetting } from "../../_lib/stripe.js";
import { db, json, leadRow } from "../../_lib/util.js";

export const DAILY_NEW = 12; // new leads a day: 3 mailboxes × ~14 emails, leaving room for follow-ups

export async function onRequestGet({ env }) {
  const DB = await db(env);
  const n = Number((await getSetting(DB, "outreach_daily_new")) || DAILY_NEW);
  const { results } = await DB.prepare(
    `SELECT * FROM leads WHERE excluded = 0 AND status = 'new' AND email IS NOT NULL AND email != ''
       AND COALESCE(json_extract(audit, '$.email_source'), '') != 'guessed' AND quality_score >= 35
     ORDER BY (json_extract(audit, '$.ai_research') IS NOT NULL) DESC, quality_score DESC, review_count DESC LIMIT ?`
  ).bind(n).all();
  const waiting = await DB.prepare(
    `SELECT COUNT(*) AS n FROM leads WHERE excluded = 0 AND status = 'new' AND email IS NOT NULL AND email != ''
       AND COALESCE(json_extract(audit, '$.email_source'), '') != 'guessed' AND quality_score >= 35`).first();
  return json({ picks: results.map(leadRow), daily: n, waiting: waiting.n });
}
