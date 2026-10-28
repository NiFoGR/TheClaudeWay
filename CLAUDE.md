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
| `.github/workflows/scrape-leads.yml` | Started by the Control Room's "Find leads" button and by the daily search (tick step `daily_find`); reports progress and status back to D1. |
| `.github/workflows/map-rank.yml` | Started by the Map Rank page's "Run scan" button. |
| `mail-relay/` | Cloudflare Worker `aetos-mail-relay`: every 5 min it calls `/api/tick?reason=cron`, then `?reason=health`; inbound email is saved raw to D1 `inbound_raw`, then it calls `/api/tick?reason=inbound`. Deployed only by `.github/workflows/deploy-relay.yml`, never by hand. |
| `routines/` | One prompt file per Claude Routine (`aetos-<name>`) plus `README.md`: how the owner creates each one, then pastes its URL and token on Setup → Claude. |
| `legacy/` | Untouched copy of the old system (git tag `old-system`). Not deployed, not tested; never import from it or edit it. |
| `docs/` | Business playbooks (above). The rebuild spec and plan: `docs/rebuild/`. |

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
- Escape everything scraped before rendering (`esc()` / `safeUrl()` in `public/js/lib.js`); scraped text is untrusted.
- Errors shown to the owner say what's wrong and how to fix it, in plain English.

## Working with the owner

- Discuss decisions step by step before building big things; build only what's needed to get to cash.
- No filler, no sugar-coating, plain English, short answers. Push back when something's wrong, once, then go with their call.
- Don't overcomplicate: prefer free, simple setups (Cloudflare + GitHub free tiers). Budget for leads + mailboxes: £100/month.
- **`docs/plan.md` is the money plan Claude drives** (phases, targets, levers); keep it current. The original plans are the owner's claude.ai docs *GoldBar Websites — System Plan* and *Launch Action Plan* (read them before
  building a feature). The nav lists built pages only, no "soon" items: `PAGES` in `control-room/public/js/app.js`
  (Home, Leads, Lead Scraper, Map Rank, Money, Voice, Replies, then Setup and Log out at the bottom; Demo and Call are routed but not in the nav); each stage adds its own page
  there. The Roadmap and Outreach pages are gone (kept in `legacy/`); file 11's Todo page replaces Home.
- Built so far: Control Room (Home, Lead Scraper with live progress, Map Rank heatmaps, Leads with a details drawer,
  Money, Setup: health lights, mailboxes and the SMTP test, DNS, receiving replies, Claude's access key and Routines,
  business details); lead score = Website 45 + Local SEO 30 + Google Maps 25 (`lead-manager/aetos_leads/scoring.py`);
  email finding in `lead-manager/aetos_leads/contacts.py`; owner's first name in `owner.py` (website → Google reviews →
  email → business name, Companies House only as a fallback; never a word from the business name, the town or a famous person; only their own words or email count as confirmed (`owner_confident`), emails greet a guessed name with plain "Hi," and Claude checks guesses). Demo sites + order page built (`functions/_lib/demo.js` + `demo-db.js`, routes `/d/:slug`, `/d/:slug/order`, beacon `/d/:slug/e`; tables `demos`, `demo_events`; one neutral template awaiting the owner's look/trade decision; views/orders count as outreach wins). Funnel draft in `docs/funnel.md` (7 decisions open). Demos use their own logo/colour/photos (`aetos_leads/brand.py`, free, from their site) and best Google reviews. Daily search: every morning from 6am, if fewer than 30 good leads are waiting, searches the next town on your list; new leads go to Claude's research queue (`control-room/functions/_lib/find.js`, tick step `daily_find`; territory on the Lead Scraper page's Automatic search card). Claude's lead research is the Routine `aetos-research` (daily 06:47 UK, plus an API fire when a search queues new leads; Routines have vanished before: if research stops, Setup → Health's research light goes red, recreate it from `routines/README.md`), researching 8 queued leads a run, re-checks first. "What to do" checklist on Home (`_lib/today.js`, `api/today.js`): daily steps from live numbers + one-time setup; add a step whenever a new feature needs the owner. Today's picks (Outreach page, `api/outreach/picks.js`): the owner approves who's emailed (final say). Decisions in `docs/funnel.md`: no phone pings (SITREP instead), replies: rules → Haiku → Sonnet, Namecheap mailboxes. Next: chasing hot leads, aetoswebsites.com, Outreach sending, Onboarding, client second brain. The rebuild plan (`docs/rebuild/`) is the to-do list.
- Call script per lead (`public/js/callscript.js`, pure + tested): playbook structure, only proven facts, today's price, objections; "I've built you a site" only once `demo_url` exists.
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
- AI lead research and grade A+ to D (stage 2, `docs/rebuild/03-research-grade.md`): the scraper does everything free
  first; every lead it keeps (score ≥ 35 or not checkable, not suppressed) is queued in `research` (`enqueueResearch` in
  `_lib/find.js`, tick step `daily_find`), which fires the Routine `aetos-research` (Sonnet, owner's subscription; also
  daily 06:47 UK; prompt `routines/research.md`, made by hand from `routines/README.md`). Claude takes 8 a run from
  `GET /api/agent/research-queue` (3-hour claim, re-checks first), does five minimum steps per lead (Facebook search,
  their contact/about pages, Companies House officers, an email search, Yell/Checkatrade) and posts one JSON per lead
  to `POST /api/agent/research/:place_id`: four points (need, means, reach, fit, 0–5) with reasons, owner and emails
  each with the source URL it was seen on, best email, 1–3 angle facts, the email opener, demo copy, a site review and
  everything it `searched`. The server checks every field (`validateResearch` in `_lib/research.js`; unknown fields are
  400s; the town as a first name is rejected, a word of the business name is saved not confident) and computes the
  grade itself (`gradeFrom` in `_lib/grade.js`; Claude never sends one); D1 reads/writes in `_lib/research-db.js`.
  The lead drawer's "Claude's research" card (`public/js/researchcard.js`) shows it; "Research is wrong" re-queues the
  lead with the owner's note (`POST /api/research/:place_id/wrong`). Health light `research`: red after 26 h without a
  post while leads wait, amber when under 40% get an email. `aetos_leads/research.py`'s `ai_needs` is only a hint list;
  Claude's research is saved only in the `research` table. Best email order (the scraper's `contacts.rank_emails`
  too): owner's → director@/owner@ → a named person in a small business → info@ → named staff of a bigger firm (the
  scraper ranks departments last; Claude never picks one).
- First email + automatic follow-ups (stages 5–6, `docs/rebuild/06-email-followups.md`): the owner writes every first
  email in the lead drawer's Email card (`public/js/compose.js`, routes `api/compose/:id`, `/preview`, `/send`, logic
  `_lib/first-email.js`, text checks `_lib/mail/rules.js`). To is picked from the sourced addresses only; the system adds
  "Hi Mark," (or "Hi,") and the cold footer under `business:sender_name`; one demo link, no other link, no "SEO", under
  150 words. Send queues it in one batch and the lead stays `ready` until it has really gone. Send is allowed only
  when the mailbox has room on the send day and on all 9 follow-up days (`roomForFirsts` in `_lib/followups.js`, the
  same number as the Leads banner). Tick step `followups` (every 5 min, at most 18 D1 queries and 3 queued a run):
  marks the lead emailed once sent, keeps the owner's words as a style example, and sends follow-ups 1–9 on days 1, 2,
  4, 7, 10, 17, 24, 30 and 60. They go at the first email's UK clock time (Sunday → Monday, never two a day), in the
  same thread from the same mailbox. They stop on a reply, opt-out or bounce or a stage past viewed (a demo view
  doesn't stop them). A failed one is retried the next morning (3 sends at most; an interrupted one never). The lead
  closes as lost 7 days after step 9. Follow-ups wait while any of the 9 templates is a draft (todo `setup:followups`)
  or the demo is down (todo `health:followup-demo:<id>`). Health light `followups`. Voice page (`#/voice`,
  `public/js/voice.js`, `api/voice/*`): approve the 9 follow-ups (any edit makes one a draft again) and add the owner's
  own example replies and rules for the reply Routine. The thread shows in the drawer (`_lib/thread.js`,
  `api/thread/:id`, Cancel/Try again via `api/messages/:id/cancel|retry`). `tests/email-e2e.test.mjs` simulates 75
  days with fake SMTP. It measured about 0.5 new businesses a day per mailbox at 10 emails a day, not 1: Sunday
  follow-ups move to Monday, so Monday fills first and blocks new first emails (a question for the owner).
- Replies + calls (stages 7–8, `docs/rebuild/07-replies-calls.md`): each human reply is answered by the Routine
  `aetos-reply` (Sonnet; prompt `routines/reply.md`, made by hand from `routines/README.md`; fired by tick step
  `reply_fire` 07:00–23:30 UK, at most every 2 min, plus daily 07:03) through `/api/agent/inbox`, `/reply`, `/escalate`
  (`_lib/replies-db.js`, rules `_lib/replies.js`, checks `_lib/replyGuard.js`). 14 intents; angry/legal/unclear/other
  go to Nik as an escalation Todo with Claude's draft (Send as me). Calls: 11am Tue/Wed/Fri/Sat/Sun, one a UK day
  (`_lib/calls.js`, `calls-db.js`, tick step `calls`, Call page `#/call/<id>`, call box in the drawer). Replies page
  (`#/replies`): conversations, pause switch, median reply time, Needs you, the reply drill (`POST/GET
  /api/replies/drill`, 14 practice emails on `drill:` leads, never sent; result in setting `replies:last_drill`,
  `_lib/replyDrill.js`) and Nik's own test lead (`test:nik`, `api/replies/test-prospect.js`). KPIs ignore `drill:`/`test:`.
- Stripe (`functions/_lib/stripe.js`, `stripe-events.js`): Setup's button creates products, payment links and the webhook
  from `STRIPE_SECRET_KEY` (Cloudflare secret); ids + webhook secret live in the `settings` table. Webhook payloads are
  pinned to API version 2024-06-20. Card clients' income = actual `payments`; their schedule is only the forecast.
