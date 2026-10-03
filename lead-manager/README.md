# GoldBar lead manager

Type a trade and a UK town; get back every local business Google Maps shows, with what's wrong with their
website, their email, the director's first name, and a quality score (how much we can help, 0–100).
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
python -m goldbar_leads --trade roofer --town Leeds --db leads.db
```

## How the score works

| Problem | Points |
| --- | --- |
| No website | 100 |
| Only a Facebook / Checkatrade / Yell page | 95 |
| Website down or broken | 90 |
| Not mobile-friendly | 25 |
| Looks outdated (copyright 3+ years old) | 20 |
| Not secure (no HTTPS) | 15 |
| Built on a DIY builder (Wix, GoDaddy…) | 15 |
| Slow (> 3 s), no contact form, no page title | 10 each |
| Town not in title, no description, no heading, not tap-to-call, no chat | 5 each |

Capped at 100. Ties are broken by Google rating, then review count: a well-reviewed business with a bad site
is the best lead, because they're proven good at the work and losing customers online.

## Costs

- Google Places: each search returns up to 20 businesses per request (about 60 per trade + town in 3 requests).
  These fields are billed at Google's "Enterprise" rate; check the current free monthly allowance on
  Google's pricing page before running in bulk.
- Companies House: free (600 requests per 5 minutes).
- GitHub Actions: free.

## Tests

```
pip install -r requirements-dev.txt && python -m pytest -q
```
