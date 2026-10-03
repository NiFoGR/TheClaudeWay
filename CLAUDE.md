# CLAUDE.md

Automation for **GoldBar Websites**, a UK business (run by Nikiforos as a sole trader trading as GoldBar Websites;
invoices in his name, not DAFNO LTD; payments via a personal Stripe account) that finds local trade businesses
with weak online presence, shows them a demo site, sells a website + monthly retainer, and delivers it.
The owner (Nikiforos) does sales calls, relationships and approvals; the system does everything else.

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
node --test control-room/tests/money.test.mjs control-room/tests/stripe.test.mjs  # Money maths + Stripe webhooks
for f in control-room/public/js/*.js; do node --check "$f"; done                   # JS syntax
```
Local Control Room: `npx wrangler pages dev` in `control-room/` with a `wrangler.toml` binding a local D1 as `DB`
and `CONTROL_ROOM_PASSWORD` set (don't commit that wrangler.toml; Pages is configured in the Cloudflare dashboard).

## Deployment facts

- Branch `claude/confident-hawking-vi0lgk` is the only branch and Cloudflare's production branch; every push redeploys.
- Cloudflare Pages: root `control-room`, output `public`, D1 binding `DB` → database `goldbarwebsites`; variables
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
- Built so far: Control Room (Home, Lead Scraper with live progress, Map Rank heatmaps, Leads with a details drawer,
  Money, Setup); lead score = Website 45 + Local SEO 30 + Google Maps 25 (`lead-manager/goldbar_leads/scoring.py`);
  email finding in `lead-manager/goldbar_leads/contacts.py`. Next: Demos, Outreach, Onboarding.
- Money page: clients (build fee + retainer after the free days), costs you add, and Google API cost estimated from
  calls logged per run (`goldbar_leads/usage.py` → `api_usage` table; prices and free allowances in
  `control-room/functions/_lib/money.js`). Forecasts count only what's committed.
- Stripe (`functions/_lib/stripe.js`, `stripe-events.js`): Setup's button creates products, payment links and the webhook
  from `STRIPE_SECRET_KEY` (Cloudflare secret); ids + webhook secret live in the `settings` table. Webhook payloads are
  pinned to API version 2024-06-20. Card clients' income = actual `payments`; their schedule is only the forecast.
