# Aetos lead manager

Type a trade and a UK town; get back every local business Google Maps shows, with what's wrong with their
website, their email, the owner's first name, and a quality score (how much we can help, 0–100).
Chains, franchises, closed businesses and front-desk businesses (dentists, clinics, solicitors) are filtered out.

## What you get per run

| File | What's in it |
| --- | --- |
| `*-leads.csv` | Everyone worth pitching, best first: quality score, business, director, phone, email, website, problems, Google rank, rating, reviews |
| `*-call-list.csv` | The same leads with no email found: phone them |
| `*-excluded.csv` | Who was skipped and why |
| `*.json` | Everything, for the Control Room |

The "Problems" column is written to be quoted politely in outreach, e.g. *Not mobile-friendly*,
*Looks outdated (copyright 2016)*, *Phone number isn't tap-to-call on mobile*, *No website*.

## Run it from GitHub (PC can be off)

1. **One-time:** add these in the repo under *Settings → Secrets and variables → Actions → New repository secret*:
   - `GOOGLE_PLACES_API_KEY` (required): Google Cloud console → enable **Places API (New)** → create an API key.
   - `COMPANIES_HOUSE_API_KEY` (optional, free): developer.company-information.service.gov.uk → register an application → REST API key.
   - `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN` (optional, for the Control Room later).
2. **Each time:** *Actions → Scrape leads → Run workflow*, type the trade and town, press Run.
3. When it finishes (a few minutes), the top 10 show on the run page and the CSVs are under *Artifacts*.

## Run it locally

```
cd lead-manager
pip install -r requirements.txt
export GOOGLE_PLACES_API_KEY=...        # COMPANIES_HOUSE_API_KEY optional
python -m aetos_leads --trade roofer --town Leeds --db leads.db
```

## How the score works

Score = how much Aetos can help this business, out of 100 (rules in `aetos_leads/scoring.py`, based on
`docs/playbooks/local-seo-client-workflow.pdf`). Three parts, matching what we sell:

| Part | Max | Points |
| --- | --- | --- |
| **Website** | 45 | Not mobile-friendly 14 · "Not secure" 8 · Outdated (copyright 4+ years) 6 · Old website technology 5 · Slow 4 (>3 s) / 6 (>6 s) · No contact form 4 · Phone not tap-to-call 2 |
| **Local SEO** | 30 | No page title 11, else trade missing 6 + town missing 5 · No main heading 4 / heading without trade + town 2 · No schema 4 · Google's phone not on site 3 · Address not on site 2 · No Google map 2 · Under 10 pages 4 / under 30 pages 2 · No Google description 2 |
| **Google Maps** | 25 | From the free 5×5 heatmap: not in top 20 anywhere 22 · top 20 in under half of town 18 · never top 3 12 · top 3 in under half of town 6 · reviews under half the top 3's +3 |

No website, a Facebook/Checkatrade page only, or a broken site maxes Website + Local SEO (75). A site that blocks
our checker scores 0 there (unknown, look yourself). "No chat" and "DIY builder" are listed but worth 0 points.
Ties are broken by Google rating, then review count.

## How emails are found (`aetos_leads/contacts.py`)

1. The homepage, then up to 6 pages most likely to list contacts (contact, quote, about, team, privacy, terms),
   best first. Stops as soon as an address on the business's own domain turns up.
2. Every page is read for hidden emails too: `mailto:` links, "info [at] site [dot] co.uk", Cloudflare email
   protection, and emails inside schema.
3. Nothing on the site: if the domain has mail servers (free MX lookup), it suggests `info@domain`, plus
   `firstname@domain` when Companies House gives the director. These are marked **guessed**.

Facebook/Instagram aren't scraped (login walls, against their terms). Their links are collected so you can check them in one click.

## Map Rank (heatmap)

Every scrape also runs a 5×5 grid (1 mile apart) of Google searches for the trade, each as if standing at that point,
and records the top 20 at each. Grid searches request place IDs only: Google's free "Text Search Essentials (IDs Only)".
Custom scans (3×3 to 13×13) run from the Control Room's Map Rank page (`.github/workflows/map-rank.yml`), or:

```
python -m aetos_leads map-rank --keyword roofer --town Warrington --grid 7 --spacing 1600
```

## Costs

- Google Places: each search returns up to 20 businesses per request (about 60 per trade + town in 3 requests).
  These are "Text Search Enterprise" calls: the first 1,000 a month are free, then about $35 per 1,000.
  Heatmap grid searches ask for IDs only, which is free. Every run logs its calls (`aetos_leads/usage.py`)
  and the Control Room's Money page shows the cost.
- Companies House: free (600 requests per 5 minutes).
- GitHub Actions: free.

## Tests

```
pip install -r requirements-dev.txt && python -m pytest -q
```
