# CLAUDE.md

Automation for **Aetos Websites** (aetoswebsites.com, on Cloudflare; formerly "GoldBar"), a UK business run by
Nikiforos as a sole trader trading as Aetos Websites (invoices in his name, not DAFNO LTD; payments via a personal
Stripe account; a limited company comes later, e.g. Aetos Ltd / Aetos Digital Ltd, with services as "Aetos Websites",
"Aetos Marketing"…). It finds local trade businesses
with weak online presence, shows them a demo site, sells a website + monthly retainer, and delivers it.
The owner (Nikiforos) does sales calls, relationships and approvals; the system does everything else.

Brand: logo `docs/brand/aetos-logo.png`, main theme white on Charcoal `#1A1C20`, gold accent only. Palette and rules in
[docs/brand.md](docs/brand.md).

## Rulebooks: read before writing copy, scripts, prompts or SEO work

- **General business rules** (offers, sales frame, qualifying, objections, follow-up, outreach and copy rules):
  [docs/playbooks/business-sales-marketing-notes.md](docs/playbooks/business-sales-marketing-notes.md)
- **How SEO is done** (benchmark, Google Business Profile, on-page, service/area pages, interlinking, citations,
  weekly routine, 12-week client emails): [docs/playbooks/local-seo-client-workflow.pdf](docs/playbooks/local-seo-client-workflow.pdf)

Copy rules in short: talk about results not us, sound human, no hype or "steroids", never insult their current
site ("Good reviews, but…"), one goal per message, make the next step obvious. Never call it "SEO" to clients:
say "front page of Google".

## The offer (decided)

| | Website Only (decoy) | Full Package |
| --- | --- | --- |
| Build | £1,750 one-off | £1,950 (anchored as "around £2,000") |
| Monthly | none | £249/month, first 60 days free |
| Weekend deal (every Sat–Sun) | none | £2,000 → £1,750 + 90 days free |
| Guarantees | Website live in 7 days, GUARANTEED | Live in 7 days (clock starts when onboarding form is complete) + front page of Google in 90 days or we work free until we are |

No contract, no cancellation fees: "If we're not making you money, we don't want your money." If they stop
paying they keep the site; everything else switches off. Payment reminder on day 61, 7 days to pay.
Targets: UK owner-operated trades (roofers, heating engineers, independent car dealers, removals, plumbers,
electricians, mechanics, locksmiths, pest control, driving schools, martial arts gyms). Never front-desk
businesses (dentists, clinics, solicitors) or chains.

## Repo layout

| Path | What |
| --- | --- |
| `control-room/` | The website the owner logs into (Cloudflare Pages + Functions + D1). Plain JS, no build step: one file per page in `public/js/`, one look in `public/style.css`. Setup guide in its README. |
| `lead-manager/` | Python engine: Google Places search → website audit → Companies House director → filter → quality score. Runs in GitHub Actions. |
| `lead-manager/schema.sql` | Single source of truth for the database. After changing it run `python scripts/sync_schema.py` (a test fails if you forget). |
| `.github/workflows/scrape-leads.yml` | Started by the Control Room's "Find leads" button; reports progress and status back to D1. |
| `.github/workflows/map-rank.yml` | Started by the Map Rank page's "Run scan" button. |
| `docs/` | Business playbooks (above). |

## Running things

```
cd lead-manager && pip install -r requirements-dev.txt && python -m pytest -q   # tests (must pass before pushing)
node --test control-room/tests/*.test.mjs                                         # Money, Stripe, Outreach engine
for f in control-room/public/js/*.js; do node --check "$f"; done                   # JS syntax
```
Local Control Room: `npx wrangler pages dev` in `control-room/` with a `wrangler.toml` binding a local D1 as `DB`
and `CONTROL_ROOM_PASSWORD` set (don't commit that wrangler.toml; Pages is configured in the Cloudflare dashboard).

## Deployment facts

- Branch `claude/confident-hawking-vi0lgk` is the only branch and Cloudflare's production branch; every push redeploys.
- Cloudflare Pages: root `control-room`, output `public`, D1 binding `DB` → database `goldbarwebsites` (named before the rename; leave it); variables
  `CONTROL_ROOM_PASSWORD`, `GITHUB_TOKEN`, `GITHUB_REPO=NiFoGR/TheClaudeWay`, `GITHUB_REF`. Variable/binding changes need a redeploy.
- GitHub Actions secrets: `GOOGLE_PLACES_API_KEY`, `COMPANIES_HOUSE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`.

## Conventions

- Everything shown to prospects must be true. Audit "issues" are quoted in outreach, so false alarms are bugs
  (e.g. a 403 is a firewall, not a broken site). Add a regression test for each one found in real data.
- Escape everything scraped before rendering (`esc()` / `safeUrl()` in app.js); scraped text is untrusted.
- Errors shown to the owner say what's wrong and how to fix it, in plain English.

## Working with the owner

- Discuss decisions step by step before building big things; build only what's needed to get to cash.
- No filler, no sugar-coating, plain English, short answers. Push back when something's wrong, once, then go with their call.
- Don't overcomplicate: prefer free, simple setups (Cloudflare + GitHub free tiers). Budget for leads + mailboxes: £100/month.
- The plans are the owner's claude.ai docs *GoldBar Websites — System Plan* and *Launch Action Plan* (read them before
  building a feature). Keep `control-room/public/js/roadmap.js` (Roadmap page) and the nav's "soon" items current.
- Built so far: Control Room (Home, Lead Scraper with live progress, Map Rank heatmaps, Leads with a details drawer,
  Outreach, Money, Setup); lead score = Website 45 + Local SEO 30 + Google Maps 25 (`lead-manager/aetos_leads/scoring.py`);
  email finding in `lead-manager/aetos_leads/contacts.py`; owner's first name in `owner.py` (website → Google reviews →
  email → business name, Companies House only as a fallback; never a word from the business name, the town or a famous person; only their own words or email count as confirmed (`owner_confident`), emails greet a guessed name with plain "Hi," and Claude checks guesses). Next: aetoswebsites.com, Demos, Outreach sending, Onboarding, client second brain.
- Money page: clients (build fee + retainer after the free days), costs you add, and Google API cost estimated from
  calls logged per run (`aetos_leads/usage.py` → `api_usage` table; prices and free allowances in
  `control-room/functions/_lib/money.js`). Forecasts count only what's committed.
- Outreach (design + review: `docs/outreach-experiments.md`): one test at a time on the first email (2–3 whole-email
  versions, Thompson sampling, Beta(1,49) prior, 10-day credit window, decide at 250 counted each or 8 weeks); follow-ups
  fixed. Engine `functions/_lib/outreach.js` (pure, tested), DB `outreach-db.js`, quality gate on every version rendered on
  real leads. Built around the demo (System Plan): every email's job is a look at their demo site, which sells (Order
  button); calls are only offered in replies when someone's unsure. A win = demo view, positive reply or order (prior
  Beta(1,19)); the first email's only link is `{demo_link}`. Nothing is sent until the owner presses **Start outreach**
  on a lead (status "in outreach"; `api/outreach/enrol.js`). Any lead with an email can be added (sole traders included;
  he accepts the PECR risk); no name/address footer, just a "reply no thanks" opt-out. Claude asks the owner questions
  (`owner_questions`, Outreach page); his answers are rules in the report. "Write it your way" briefs (owner's rough wording per step) are turned into versions by Claude. Claude's part runs on the owner's subscription as a daily Routine (full review weekly)
  (`docs/outreach-weekly-review.md`) via `/api/agent/*` with `OUTREACH_AGENT_TOKEN`; the owner approves every version.
  Sending (Gmail API + a cron Worker) is built when the mailboxes exist. **Replies must be fast: set up per inbox when
  the mailboxes are bought** (each inbox's new-mail check fires the reply Routine's API trigger, like Find leads does).
- AI lead research (80/20): the scraper does everything free first, then `aetos_leads/research.py` flags only leads
  worth pitching (score ≥ 35) with a to-do list (size / email / best email / owner / website / review). The scrape
  workflow fires a Claude Routine (API trigger, owner's subscription, Sonnet) once per Find-leads run if any are flagged;
  Claude does only those to-dos within a budget (`docs/lead-research-routine.md`) and posts to `/api/agent/leads/:id`
  (merge: `_lib/research.js`): emails/owner with source URLs, the decision maker's email, its website rating (replaces
  the automated Website /45), false alarms removed, big firms excluded. Research carries over on re-scrapes
  (`store.carry_over`). Email order (`contacts.rank_emails`): owner's → director@/owner@ → a named person in a small
  business → info@ → named staff of a bigger firm → departments.
- Stripe (`functions/_lib/stripe.js`, `stripe-events.js`): Setup's button creates products, payment links and the webhook
  from `STRIPE_SECRET_KEY` (Cloudflare secret); ids + webhook secret live in the `settings` table. Webhook payloads are
  pinned to API version 2024-06-20. Card clients' income = actual `payments`; their schedule is only the forecast.
