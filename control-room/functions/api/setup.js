// GET /api/setup → which parts of the Control Room are connected, in plain English, plus the Setup page's status
// (mailboxes, Claude, DNS, business details, receiving: loadSetupStatus) and what's still to set up (setupGaps).
// Never returns secret values: the status only says whether each secret is set.
import { loadSetupStatus, setupGaps } from "../_lib/setupStatus.js";
import { paymentsLight, stripeStatus } from "../_lib/stripe.js";
import { db, json } from "../_lib/util.js";

// The Payments row: the same answer as the payments health light (paymentsLight), and the mode from stripeStatus.
async function checkStripe(env) {
  try {
    const DB = env.DB ? await db(env) : null; // db() first: stripe_events may be new since the last deploy
    const status = DB ? await stripeStatus(DB, env) : null;
    if (!status?.key) {
      if (!DB && env.STRIPE_SECRET_KEY) return { ok: false, mode: null, fix: "Couldn't check Stripe: the database isn't connected yet." };
      return { ok: false, mode: null, fix: "Not connected yet: paste your Stripe key on Setup and press Connect Stripe." };
    }
    const light = await paymentsLight(DB, env, new Date());
    if (light.level === "green") return { ok: true, mode: status.mode };
    const fix = [light.detail, light.fix].filter(Boolean).map((t) => t.replace(/\.?$/, ".")).join(" ");
    return { ok: false, mode: status.mode, fix };
  } catch {
    return { ok: false, mode: null, fix: "Couldn't check Stripe: the database isn't answering yet." };
  }
}

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
      "user-agent": "aetos-control-room",
    },
  });
  if (resp.ok) return { ok: true };
  if (resp.status === 401) return { ok: false, fix: "GitHub rejected the token. Create a new one and paste it as GITHUB_TOKEN." };
  if (resp.status === 404) return { ok: false, fix: `Can't see the scraper in ${env.GITHUB_REPO}. Check GITHUB_REPO and that the token can access that repository.` };
  return { ok: false, fix: `GitHub answered ${resp.status}. Try again in a minute.` };
}

// The status and gaps, or {status: null, gaps: [], status_error} when the database can't be read, so the checks above
// still show (the Database check says how to fix it).
async function readStatus(env) {
  try {
    const status = await loadSetupStatus(await db(env), env, new Date());
    return { status, gaps: setupGaps(status) };
  } catch (err) {
    const why = String(err?.message ?? err).split("\n")[0].slice(0, 300);
    return { status: null, gaps: [], status_error: `Couldn't read the setup status: ${why}` };
  }
}

export async function onRequestGet({ env }) {
  const [database, github, stripe, setup] = await Promise.all([checkDatabase(env), checkGitHub(env), checkStripe(env), readStatus(env)]);
  const { mode, ...payments } = stripe;
  return json({
    checks: [
      { name: "Password", ok: true, detail: "You're logged in." },
      { name: "Database (Cloudflare D1)", ...database, detail: "Stores your leads and runs." },
      { name: "Scraper connection (GitHub)", ...github, detail: "Lets the Find leads button start the scraper." },
      { name: `Payments (Stripe${mode ? `, ${mode} mode` : ""})`, ...payments, detail: "Clients pay by card; payments land on the Money page by themselves." },
    ],
    note: "Google Places and Companies House keys live in GitHub (repo → Settings → Secrets and variables → Actions). If they're missing, a run will show as failed with the reason.",
    ...setup,
  });
}
