# Aetos Control Room

The website you log into to run everything:

| Page | What it's for |
| --- | --- |
| **Home** | The numbers that matter today, your pipeline, and the best leads to contact next |
| **Lead Scraper** | Type a niche, a town and how many leads, press *Find leads*, watch it work |
| **Map Rank** | LeadSnap-style Google Maps heatmaps |
| **Leads** | Every lead; click one for everything we know (score breakdown, problems, emails, socials, notes) |
| **Money** | Profit, monthly recurring income, clients, costs (Google tracked automatically), 6-month forecast |
| **Setup** | Green ticks show what's connected |

Demos, Outreach and Onboarding come next.

It runs entirely online and free, so your PC can be off:

| Part | Runs on |
| --- | --- |
| The website + its small API (`public/`, `functions/`) | Cloudflare Pages |
| The database (leads, runs, clients, money) | Cloudflare D1 |
| The heavy scraping (Google, website checks, Companies House) | GitHub Actions (`.github/workflows/scrape-leads.yml`) |
| Map Rank heatmap scans | GitHub Actions (`.github/workflows/map-rank.yml`) |
| The street map behind the heatmap | Leaflet + OpenStreetMap (free) |

Pressing *Find leads* records a run and starts the GitHub workflow. The page fills in by itself when it's done, usually in 2–6 minutes.

## One-time setup (about 20 minutes)

### 1. Cloudflare: database and website
1. Create a free account at cloudflare.com.
2. **Storage & Databases → D1 → Create** a database called `aetos`. Copy its **Database ID**.
3. **Workers & Pages → Create → Pages → Connect to Git**, pick `NiFoGR/TheClaudeWay`, then:
   - Production branch: the branch this code is on
   - Framework preset: *None*, build command: *empty*
   - Root directory: `control-room`, build output directory: `public`
4. In the new project: **Settings → Bindings → Add → D1 database**: variable name `DB`, database `aetos`.
5. **Settings → Variables and Secrets**, add:
   - `CONTROL_ROOM_PASSWORD`: the password you'll log in with (type: Secret)
   - `GITHUB_TOKEN`: see step 2 (type: Secret)
   - `GITHUB_REPO`: `NiFoGR/TheClaudeWay`
   - `GITHUB_REF`: the branch name from step 3
6. **Deployments → Retry deployment** so the settings take effect. Your Control Room is at `https://<project>.pages.dev`.
   You can point your own domain (e.g. `control.aetoswebsites.com`) at it later under *Custom domains*.

### 2. GitHub token (lets the Control Room press "Run" for you)
GitHub → your profile picture → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate**:
repository access *Only select repositories → TheClaudeWay*, permission **Actions: Read and write**. Paste it as `GITHUB_TOKEN` above.

### 3. Keys the scraper needs (GitHub repo → Settings → Secrets and variables → Actions)
| Secret | Where to get it |
| --- | --- |
| `GOOGLE_PLACES_API_KEY` | Google Cloud console → enable **Places API (New)** → Credentials → API key |
| `COMPANIES_HOUSE_API_KEY` (optional, free) | developer.company-information.service.gov.uk → register an application → REST key |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard, right-hand side of the account home page |
| `D1_DATABASE_ID` | The Database ID from step 1.2 |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create token → *Custom*: permission **Account → D1 → Edit** |

### 4. Stripe (card payments, optional but recommended)
Stripe → Developers → API keys → copy the **Secret key** (`sk_test_…` to try it, `sk_live_…` for real money).
Cloudflare → Settings → Variables and Secrets → add `STRIPE_SECRET_KEY` (type Secret) → retry the deployment.
On **Setup**, press **Set up Stripe**: it creates the three packages, a payment link for each (with the 60/90 free days
built in) and a webhook. Paid links then add the client, their payments and Stripe's fees to the Money page by
themselves; failed payments and cancellations show there too. In Stripe → Settings → Billing → Subscriptions and
emails, turn on trial-ending reminders and Smart Retries.

Then open the Control Room's **Setup** page: every line should be green. Log in, type *roofer* / *Leeds* / *60*,
and press **Find leads**. If a run fails, the reason shows on the run (e.g. "Google key missing") with what to fix.

## Developing locally
From `control-room/`, run `npx wrangler pages dev` with a `wrangler.toml` that binds a local D1 database as `DB`
and sets `CONTROL_ROOM_PASSWORD`. The database layout lives in `lead-manager/schema.sql`; after changing it,
run `python scripts/sync_schema.py`.
