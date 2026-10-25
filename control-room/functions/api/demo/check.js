// GET /api/demo/check?limit=10 → {rows: [{place_id, name, template, bytes, problems}]}: the quality check on real
// leads (stage 4, docs/rebuild/05-demo.md "Perfect when" 6). The newest leads that qualify for a demo (Part A §1:
// researched, graded A+, A or B, not too big, an email that isn't on the do-not-contact list, not excluded), newest
// research first, each drawn exactly as its prospect sees GET /d/<slug> (their own look, their latest demo's Order
// button and view beacon; a lead still waiting for its demo is drawn without those) and run through checkDemoHtml.
// bytes is the page's UTF-8 size (the limit is 100,000). limit is 1 to 10 (10 when missing or unreadable). A page that
// can't be drawn is a plain-English problem on its row, never a failed request. Nothing is written.
// Behind the login (_middleware.js). D1: 2 statements (the leads, then the do-not-contact list).
// Tested in control-room/tests/demo-api.test.mjs.
import { checkDemoHtml } from "../../_lib/demo/check.js";
import { buildDemoData, templateIdFor } from "../../_lib/demo/data.js";
import { renderSite } from "../../_lib/demo/render.js";
import { offerFor } from "../../_lib/offer.js";
import { suppressionReasons } from "../../_lib/prospects.js";
import { db, json } from "../../_lib/util.js";
import { PREVIEW_COLUMNS, demoSources, shownName } from "./index.js";

const LIMIT_MAX = 10;
// Leads read beyond the limit, for those the do-not-contact list then rules out.
const SPARE = 20;

// Part A §1 except the do-not-contact list (suppressionReasons, the outbox's own rule, reads that next).
const ELIGIBLE_SQL = `SELECT ${PREVIEW_COLUMNS}, r.best_email
  FROM research r
  JOIN leads l ON l.place_id = r.place_id
  WHERE r.status = 'done' AND r.grade IN ('A+', 'A', 'B') AND r.too_big = 0 AND l.excluded = 0
    AND trim(COALESCE(r.best_email, '')) <> ''
  ORDER BY r.researched_at DESC, l.place_id
  LIMIT ?1`;

/** ?limit as a whole number from 1 to 10; 10 when it's missing, not a whole number or below 1. */
export function checkLimit(value) {
  const n = /^\d{1,6}$/.test(String(value ?? "")) ? Number(value) : 0;
  return n >= 1 ? Math.min(n, LIMIT_MAX) : LIMIT_MAX;
}

const message = (err) => String(err?.message ?? err).split("\n")[0].slice(0, 300);

/** One lead's page as its prospect sees it, checked: a row of the response. */
function checkRow(row, now) {
  try {
    const { lead, research } = demoSources(row);
    const demo = row.demo_slug ? { slug: row.demo_slug } : null;
    const data = buildDemoData({ lead, research, demo, offer: offerFor(now), now });
    const html = renderSite(data, { now });
    return {
      place_id: row.place_id, name: data.business.name, template: data.template,
      bytes: new TextEncoder().encode(html).length, problems: checkDemoHtml(html, data, { now }),
    };
  } catch (err) {
    return {
      place_id: row.place_id, name: shownName(row.name), template: templateIdFor(row.trade), bytes: 0,
      problems: [`Couldn't draw this page: ${message(err)}`],
    };
  }
}

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ request, env, now }) {
  const at = now ?? new Date();
  const limit = checkLimit(new URL(request.url).searchParams.get("limit"));
  const DB = await db(env);
  const { results } = await DB.prepare(ELIGIBLE_SQL).bind(limit + SPARE).all();
  const leads = results ?? [];
  const blocked = await suppressionReasons(DB, leads.map((r) => r.best_email));
  const rows = leads.filter((r) => !blocked.has(r.best_email)).slice(0, limit).map((r) => checkRow(r, at));
  return json({ rows });
}
