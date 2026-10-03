// GET /api/setup → which parts of the Control Room are connected, in plain English. Never returns secret values.
import { json } from "../_lib/util.js";

async function checkDatabase(env) {
  if (!env.DB) return { ok: false, fix: "In Cloudflare: your Pages project → Settings → Bindings → add a D1 database called DB." };
  try {
    await env.DB.prepare("SELECT 1").first();
    return { ok: true };
  } catch (e) {
    return { ok: false, fix: `The database is bound but not answering: ${e.message}` };
  }
}

async function checkGitHub(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return { ok: false, fix: "In Cloudflare: Settings → Variables and Secrets → add GITHUB_TOKEN and GITHUB_REPO (see control-room/README.md, step 2)." };
  }
  const resp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/scrape-leads.yml`, {
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "goldbar-control-room",
    },
  });
  if (resp.ok) return { ok: true };
  if (resp.status === 401) return { ok: false, fix: "GitHub rejected the token. Create a new one and paste it as GITHUB_TOKEN." };
  if (resp.status === 404) return { ok: false, fix: `Can't see the scraper in ${env.GITHUB_REPO}. Check GITHUB_REPO and that the token can access that repository.` };
  return { ok: false, fix: `GitHub answered ${resp.status}. Try again in a minute.` };
}

export async function onRequestGet({ env }) {
  const [database, github] = await Promise.all([checkDatabase(env), checkGitHub(env)]);
  return json({
    checks: [
      { name: "Password", ok: true, detail: "You're logged in." },
      { name: "Database (Cloudflare D1)", ...database, detail: "Stores your leads and runs." },
      { name: "Scraper connection (GitHub)", ...github, detail: "Lets the Find leads button start the scraper." },
    ],
    note: "Google Places and Companies House keys live in GitHub (repo → Settings → Secrets and variables → Actions). If they're missing, a run will show as failed with the reason.",
  });
}
