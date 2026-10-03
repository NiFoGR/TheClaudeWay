// POST /api/scrape {trade, town, max} → records a run and starts the "Scrape leads" GitHub workflow,
// which does the heavy work (Google search, website audits, Companies House) and writes results back to D1.
import { bad, db, json, now } from "../_lib/util.js";

const WORKFLOW = "scrape-leads.yml";

async function startWorkflow(env, inputs) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return "GitHub isn't connected yet (GITHUB_TOKEN / GITHUB_REPO not set).";
  const resp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "goldbar-control-room",
    },
    body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs }),
  });
  if (resp.ok) return "";
  return `GitHub refused to start the run (${resp.status}): ${(await resp.text()).slice(0, 200)}`;
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad("Send JSON");
  }
  const trade = String(body.trade || "").trim();
  const town = String(body.town || "").trim();
  const max = Number(body.max);
  if (trade.length < 2 || trade.length > 60) return bad("Type a niche, e.g. roofer");
  if (town.length < 2 || town.length > 60) return bad("Type a UK town, e.g. Leeds");
  if (!Number.isInteger(max) || max < 10 || max > 300) return bad("Number of leads must be between 10 and 300");

  const DB = await db(env);
  const id = crypto.randomUUID();
  const ts = now();
  await DB.prepare(
    "INSERT INTO jobs (id, trade, town, max_results, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)"
  ).bind(id, trade, town, max, ts, ts).run();

  const error = await startWorkflow(env, { trade, town, max: String(max), job_id: id });
  if (error) {
    await DB.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(error, now(), id).run();
  }
  const job = await DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first();
  return json({ job }, error ? 502 : 201);
}
