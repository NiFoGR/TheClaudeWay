// POST /api/scrape {trade, town, max} → records a run and starts the "Scrape leads" GitHub workflow,
// which does the heavy work (Google search, website audits, Companies House) and writes results back to D1.
// The run is started by _lib/find.js startScrape, the same way the daily automatic search starts one.
import { startScrape } from "../_lib/find.js";
import { bad, db, json } from "../_lib/util.js";

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad("Send JSON");
  }
  body ??= {}; // a JSON null names no niche either (it used to crash with a 500)
  const trade = String(body.trade || "").trim();
  const town = String(body.town || "").trim();
  const max = Number(body.max);
  if (trade.length < 2 || trade.length > 60) return bad("Type a niche, e.g. roofer");
  if (town.length < 2 || town.length > 60) return bad("Type a UK town, e.g. Leeds");
  if (!Number.isInteger(max) || max < 10 || max > 300) return bad("Number of leads must be between 10 and 300");

  const DB = await db(env);
  const { job, error } = await startScrape(DB, env, { trade, town, max });
  return json({ job }, error ? 502 : 201);
}
