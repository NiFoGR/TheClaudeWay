// GET /api/leads?<filters> → the Leads page (stage 3, docs/rebuild/04-shortlist.md): listLeads' {rows (50 a page),
// total, page, pages, grade_counts, view_counts, facets, capacity, ready}, in at most 12 D1 statements; never the audit
// or raw HTML. Filters as parseLeadFilters reads them: view=ready (the default) | all, grade=ap,a,b,c,d,none, trade,
// town, email=1|0, stage=ready,emailed,…,none, researched=1|0, q (search, 100 characters), excluded=1, job=<scrape run
// id> (the Lead Scraper's "See these leads"), page. Behind the login (_middleware.js). The lead panel is
// ./leads/[id]/index.js. Tested in tests/leads-api.test.mjs.
import { parseLeadFilters } from "../_lib/shortlist.js";
import { listLeads } from "../_lib/shortlist-db.js";
import { db, json } from "../_lib/util.js";

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ request, env, now }) {
  const DB = await db(env);
  const filters = parseLeadFilters(new URL(request.url).searchParams);
  return json(await listLeads(DB, filters, now ?? new Date()));
}
