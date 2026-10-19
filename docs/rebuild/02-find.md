# Stage 1: Find (filter 1, automatic)

> **Plain English:** Every morning from 6am the Control Room decides whether you need more leads. If fewer than 30
> good, graded leads are waiting to be emailed and Claude isn't already behind on research, it searches the next town
> on your list (landscapers first) and checks every business it finds. Chains, front-desk businesses and duplicates
> are set aside; the rest get a score out of 100 for how much we can help them. Anything scoring 35 or more goes
> straight into Claude's research queue. You don't have to do anything; the Lead Scraper page shows what it did today
> in one line, and you can still press Find leads yourself.

## Part A: Spec

### Goal

A steady, cheap supply of owner-operated trade businesses with weak online presence, found without Nik, with no
false claims about their websites, and handed to Claude's research (stage 2) the moment they're saved.

The Python engine in `lead-manager/` (Google Places → website audit → owner/emails → Companies House → Map Rank →
exclusions → score) is kept. This stage fixes the false alarms and gaps listed under "Engine fixes", moves the daily
decision from GitHub's cron into the tick, and connects finished searches to the research queue.

### Trigger

| What | When |
| --- | --- |
| Automatic search decision | The first tick at or after 06:00 UK each day (tick step `daily_find`, position 7 in overview §8, after `pick`). Exactly once per UK day. |
| Manual search | Nik presses **Find leads** on the Lead Scraper page (any time). |
| Research enqueue | In `daily_find`: whenever a search has finished since the last enqueue, and once a day with the morning decision. |
| Research Routine fire | Right after an enqueue, if the queue is non-empty and the research Routine wasn't fired in the last 6 hours. |
| Stale runs | Tick step `stale_jobs` (position 8), every 15 minutes. |

### Who does what

- **System:** decides, starts `scrape-leads.yml` through `_lib/github.js` `startWorkflow`, runs the engine on GitHub
  Actions, saves leads to D1, logs Google calls to `api_usage`, queues research, fires the research Routine, marks
  stuck runs failed, adds `health` todos.
- **Claude:** nothing in this stage. The research Routine it fires is stage 2. GitHub holds no Claude tokens any more.
- **Nik:** nothing required. Optional: edit the territory (trade, towns, on/off, leads per search), press Find leads.

### What filter 1 lets through (exact rules, as built after this stage)

**Who is searched.** One trade in one UK town per search, from Google Places Text Search (`"{trade} in {town}"`,
then the variants in `places.QUERY_VARIANTS` until `max` distinct businesses), service-area businesses included,
`max` 10–300 (territory default 60). Targets are UK owner-operated trades (CLAUDE.md): landscapers first, then
roofers, heating engineers, independent car dealers, removals, plumbers, electricians, mechanics, locksmiths, pest
control, driving schools, martial arts gyms. Never front-desk businesses or chains.

**Set aside (kept in the Leads list with a reason, never audited, never researched, never pitched)**, first match
wins (`qualify.mark_exclusions`):

| Reason shown | Rule |
| --- | --- |
| `Closed` | Google `businessStatus` is set and isn't `OPERATIONAL`. |
| `Duplicate listing of {name}` | Same phone (last 10 digits) as another listing in this run or an earlier lead; keep the earlier lead, else the listing with a real website, else the most reviews. Also: same real website and same town as another listing (different phones). |
| `Chain / national brand` | Name matches the `CHAINS` brand list (unambiguous national brands only). |
| `Multiple branches (chain)` | Same real website host on listings in **different** towns (this run or earlier leads). The earlier lead is excluded too, unless it already has a `prospects` row. |
| `Front desk / gatekeeper` | Google types include one of `FRONT_DESK_TYPES` (dentist, doctor, hospital, lawyer, bank, school, supermarket, …), or the name contains dental, dentist(s), doctor(s), medical, NHS, veterinary, vets, physio…, solicitor(s), council, optician(s), pharmacy, chemist. "Tree Surgery", "Lawn Clinic", "Driveway Clinic" are trades and stay. |

**Score (0–100) = Website 45 + Local SEO 30 + Google Maps 25** (`scoring.RULES`, unchanged values):

- No usable site (`no_website`, `profile_only` = only a Facebook/Checkatrade/Yell… page, `site_down`, `site_broken`):
  Website + SEO = 75. `bad_certificate`: 70.
- `not_checked` (a firewall, bot check or browser-only page stopped the checker): 0 points, never quoted, but the lead
  still goes to Claude's research so a person-level look happens.
- Website (cap 45): not_mobile 14, not_secure 8, outdated (copyright 4+ years old) 6, old_build 5, very_slow 6 /
  slow 4, no_form 4, no_tap_to_call 2; diy_builder and no_chat 0 (information only).
- Local SEO (cap 30): no_title 11, title_no_trade 6, title_no_town 5, no_h1 4, h1_weak 2, no_schema 4,
  phone_not_on_site 3, address_not_on_site 2, no_map 2, few_pages (<10) 4, some_pages (10–29) 2, no_description 2.
- Google Maps (cap 25), from the free 5×5 Map Rank scan of the searched town, **only for leads whose own postal town
  is the searched town**: maps_invisible 22, maps_rarely_found 18, maps_no_top3 12, maps_some_top3 6,
  reviews_behind 3. A lead found from a neighbouring town keeps the Maps part from its own town's scan, if there was
  one; otherwise its Maps part is 0.

**Owner's first name** (`owner.find_owner`, unchanged): their own words on their site or schema (confident) → a
person's address on their own domain (confident) → a site guess → 2+ different Google reviewers naming the same
person → a known first name at the start of the business name. Companies House director only replaces a guess, and is
confident only when the registered postcode matches. Never a word from the business name (unless it's a known first
name like "Dave's"), the town, an acronym, or a famous person. Emails greet only a confident name; otherwise "Hi,".

**Emails** (`contacts`, unchanged order): owner's own → director@/owner@ → a named person in a small business →
info@/enquiries@ → named staff of a bigger firm → departments; off-domain addresses last unless they carry the
business's name. Font credits and (new) web-designer credits are never taken as the business's address. A guessed
`info@` (domain has MX, nothing on the site) is marked `guessed`.

**Handed to research (filter 2):** `excluded = 0` AND (`quality_score ≥ 35` OR findings include `not_checked`)
AND not suppressed (email, email domain, website host or company number in `suppression`). Same threshold as
`research.MIN_SCORE`.

### Engine fixes (code wrong or missing a regression test)

Reviewed `qualify`, `scoring`, `audit`, `contacts`, `owner`, `research`, `pipeline`, `store` and all tests against
the real runs (Warrington roofers, kickboxing, Eddie Stobart, Bennies Boxing, the landscaper runs 14–19 Oct, where
Runcorn returned 60 found but only 36 new because 24 were already found from Widnes/Warrington).

| # | Problem (false claim or wrong exclusion) | Fix | Task |
| --- | --- | --- | --- |
| 1 | Bot checks that answer 200/202 (SiteGround `sgcaptcha`, "Just a moment…", "Attention Required") are audited as if they were the homepage: "No page title", "Not mobile-friendly"… all false. Any 4xx other than 404/410 (e.g. 409, 415, 451) is called "Website is broken". | 202, challenge pages and 4xx except 404/410 → `not_checked`. Broken only for 404, 410, 500, 502, 504, 520–526, 530. | 1 |
| 2 | A browser-only page (empty `<div id="root">` + scripts) gets "No main heading", "No contact form", "Phone number isn't on the website"… | Detect it → `not_checked` with its own line. | 1 |
| 3 | Form, map, phone and address are checked on the homepage only, but usually live on the Contact page: "No contact or quote form", "No Google map", "The phone number on Google isn't on the website" are false. The contact page isn't even fetched when the homepage has an email. | Always fetch the best contact page; check those four across every fetched page. | 2 |
| 4 | "St Helens" vs "St. Helens"/"Saint Helens", "Newton-le-Willows" vs "Newton le Willows" → false "Town not in the page title". A landscaper titled "Patios & Driveways" → false "Page title doesn't say what they do". "Phone number isn't tap-to-call on mobile" is false on iPhones (they auto-link numbers). | `town_key()` normalising; landscaper synonyms; reword to "No tap-to-call phone link on the home page". | 3 |
| 5 | "Tree Surgery", "The Lawn Clinic", "Driveway Clinic" excluded as front desk (name words `surgery`, `clinic`, `practice`). Two listings of one sole trader with the same website (different phones, same town) both excluded as a chain. | Medical/legal name words only; same site + same town = duplicate. | 4 |
| 6 | Duplicates and franchise branches across runs aren't caught (only within one run), so one business can be researched and emailed twice. | Compare with earlier leads. | 5 |
| 7 | A Warrington business found from a Runcorn search gets "Not in Google Maps' top 20 anywhere we checked across Runcorn" (+22 points), and every re-scrape from another town rewrites its Maps score. | Maps findings only in the lead's own town; keep home-town Maps on re-scrape. | 6 |
| 8 | A "Website by Pixel Studio · hello@pixelstudio.co.uk" footer becomes the lead's only email: we'd email their web designer. | Off-domain addresses next to designer-credit words are dropped. | 7 |

Checked and left as is: copyright-year rule (has a 2023-in-2026 test), firewall 401/403/406/429/503, retry on slow
first load, certificate errors, placeholder emails, glued addresses, font credits, phone formats, owner-name
exclusions (business words, town, famous names), Companies House match basis, D1 parameter chunking, usage counting.

Existing rows keep their old issue lines until their town is searched again; stage 2 must not quote a Maps line for
a lead whose `audit.map_rank.scan_town` isn't its own town (cross-stage interface).

### Daily automatic search

Ported from `autopilot.py` to `control-room/functions/_lib/territory.js` (pure) and `_lib/find.js` (db). The setting
stays `settings.territory` = JSON `{on, trade, towns, next, max}` (same shape Python reads), edited on the Lead Scraper
page. Default: `{on: true, trade: "landscaper", towns: [Warrington, Widnes, Runcorn, St Helens, Wigan, Leigh,
Northwich, Altrincham, Sale, Stockport, Chester, Crewe, Bolton, Bury, Salford, Knutsford, Macclesfield, Ellesmere
Port], next: 0, max: 60}`.

At the first tick at or after 06:00 UK, the step claims the day (`settings` key `find:day` = UK date, compare-and-set,
so two ticks can't both search) and decides, in this order:

1. Territory `on` is false → skip, reason `off`.
2. A search (any, including Nik's) is `queued` or `running` → skip, reason `running`.
3. **Pipeline not low:** graded-but-not-emailed A+/A/B leads ≥ **30** → skip, reason `good`. (Graded = `research.status
   = 'done'` and `grade IN ('A+','A','B')`, `too_big = 0`, lead not excluded, and no `prospects` row with
   `first_sent_at` set.)
4. Queued research ≥ **40** → skip, reason `research`.
5. No town on the list that wasn't searched for this trade in the last 30 days (failed searches don't count) → skip,
   reason `towns`, plus a `health` todo "Add more towns to your automatic search".
6. Otherwise: create a `jobs` row (`queued`) and start `scrape-leads.yml` with `{trade, town, max, job_id}`; move
   `territory.next` past that town.

Why 30 and 40: with 9 follow-ups per lead at about 10 sends a day, one mailbox takes about 1 new business a day, so 30
good leads waiting is about a month of first emails for one mailbox; 40 queued is 2–3 days of Claude research. The
287 existing landscapers alone put about 200 into the queue on day one, so automatic searching pauses until Claude
catches up. Revisit the numbers when more than 3 mailboxes are active.

The decision is stored in `settings` key `find:today` = JSON `{day, at, search, town?, job_id?, reason?, n?, error?}`.
GitHub's cron stays off: `daily.yml` keeps its schedule commented out and gets a header line saying the Control Room
does this now.

### Research queue

In `daily_find`, an enqueue runs when a `jobs` row became `done` after `settings.research:enqueued_at`, and with the
morning decision. It inserts `research (place_id, status 'queued', queued_at)` with INSERT OR IGNORE for every lead
handed to research (rule above), so a lead already queued, done or skipped is never touched. On the first run this
queues the existing landscapers that qualify (about 200 of the 287), including leads the old Routine looked at (its
research quality was too low to keep, decisions.md). After an enqueue, if `research` has any `queued` row and no
`routine_fires` row for `research` in the last 6 hours (failed attempts count, so a broken Routine isn't hammered),
it calls `fireRoutine(DB, "research", "research queued: {n} leads")`. The Routine's own 06:47 schedule is the daily
catch-up.

`scrape-leads.yml` loses its "Hand the hard cases to Claude" step and the engine stops writing `for_claude`; the
`CLAUDE_ROUTINE_URL`/`CLAUDE_ROUTINE_TOKEN` GitHub secrets become unused (Nik may delete them; nothing breaks if not).

### Stale runs

`stale_jobs`: a `jobs` row `queued`/`running` whose newest of `jobs.updated_at` and `job_progress.updated_at` is more
than **45 minutes** old → `status 'failed'`, error **"Stopped: no progress for 45 minutes. Press Find leads to try
again."** A `scans` row `queued`/`running` with `updated_at` older than 45 minutes and `source` not `'care'` → failed,
error **"Stopped: no progress for 45 minutes. Press Run scan to try again."** (the Map Rank page's button). Care scans
(`source = 'care'`) are never touched here: stage 11 owns them and its `care_scans` light fails them with its own
text. Each adds one `health` todo.
The workflow's own timeout is 30 minutes, so a healthy run never hits 45. The page's old client-side "Stuck" badge
(40 minutes) is removed; the server's status is the truth.

### Edge cases

- **Clocks change** (25 Oct 2026): the 06:00 rule uses `ukTime.js`; 05:00 UTC is 06:00 in BST, 06:00 UTC in GMT.
- **Tick down at 06:00:** the decision happens at the first tick after; a tick at 23:00 still decides for that day.
- **GitHub refuses the start** (token expired, Actions off): the job is saved as `failed` with `startWorkflow`'s
  message, `find:today.error` is set, a `health` todo is added, the day stays decided (no retry storm). The town isn't
  "recent" (failed), so tomorrow picks it again. Nik can press Find leads.
- **Today's automatic search fails later** (Google refused, crash): a `health` todo "Today's lead search failed".
- **Territory edited:** towns are trimmed, de-duplicated, max 200; changing the trade or the list resets `next` to 0;
  `next` beyond the list wraps. Searches for another trade don't make a town "recent".
- **Nik searches a list town by hand:** that town counts as recent for 30 days (same trade).
- **Lead in a village outside the searched town** (Lymm in a Warrington search): no Maps points from that scan.
- **Suppressed lead** (opted out, bounced, or company blocked): never queued; already-queued rows are left for stage 2
  to skip.
- **Pipeline numbers before stage 2 exists:** no graded leads, so rule 3 never blocks; rule 4 does.

### What Nik sees (Lead Scraper page, `#/scraper`)

- **Find leads** form (unchanged): Niche, Town, How many leads (10–300, chips 20/60/100/200/300). Errors: "Type a
  niche, e.g. roofer", "Type a UK town, e.g. Leeds", "Number of leads must be between 10 and 300". GitHub refusal shows
  `startWorkflow`'s message ("GitHub refused to start the run (401): …" / "GitHub isn't connected yet (GITHUB_TOKEN /
  GITHUB_REPO not set).").
- **Live progress** (unchanged stages: Scouting / Checking every website / Checking Companies House / Mapping Google
  Maps rankings / Saving), refreshing every 3 s.
- **Automatic search card** (replaces "Autopilot"): title "Automatic search" with badge **On**/**Off**; line
  "**Today:** {line}"; rule line "Every morning from 6am it searches {trade} in the next town on your list, when fewer
  than 30 good leads are waiting and Claude has fewer than 40 to research. Next town: {upcoming}." (Off: "Switched off:
  nothing is searched automatically."); **Edit** opens "Automatic search" with "Search one town every morning",
  "Niche", "Towns, in order (one per line). A town searched in the last 30 days is skipped.", "Leads per search",
  **Save** → toast "Saved." Errors: "Type the niche to search, e.g. landscaper", "Add at least one town (one per
  line)", "Leads per search must be between 10 and 300".
- **Today line** (exact, from `todayLine`; times are UK HH:MM):

  | State | Line |
  | --- | --- |
  | Not decided yet today | `Decided after 6am` |
  | Off | `Off. Nothing is searched automatically` |
  | Started, queued/running | `Searching Widnes (started 06:02)` |
  | Done | `Searched Widnes at 06:02 — 41 found` |
  | Failed | `Searched Widnes at 06:02 — it failed: {job error}` |
  | Couldn't start | `Couldn't start the search for Widnes: {error}` |
  | Skipped, good leads | `Skipped: 34 good leads waiting` |
  | Skipped, research | `Skipped: Claude has 41 leads to research first` |
  | Skipped, running | `Skipped: a search was already running` |
  | Skipped, towns | `Skipped: every town on your list was searched in the last 30 days. Add more towns` |

- **Your searches** list: a stopped run shows badge **Failed** and its error. Empty state: the existing "How it works"
  card.
- Money page: Google cost per run (unchanged, from `api_usage`).

### Todos added (kind `health`)

| dedupe | title | detail | link |
| --- | --- | --- | --- |
| `health:stale:job:{id}` | `Lead search stopped: {trade} in {town}` | `It made no progress for 45 minutes, so it was marked failed. Press Find leads to try again. If it happens twice, open GitHub → Actions → Scrape leads and look at the red run.` | `/#/scraper` |
| `health:stale:scan:{id}` | `Map Rank scan stopped: {keyword} in {town}` | `It made no progress for 45 minutes, so it was marked failed. Press Run scan to try again.` | `/#/maprank` |
| `health:find:{YYYY-MM-DD}` | `Today's lead search didn't start` | `{startWorkflow error} Check GITHUB_TOKEN in Cloudflare (Pages → Settings → Variables and Secrets) is still valid, then press Find leads.` | `/#/scraper` |
| `health:find:failed:{job_id}` | `Today's lead search failed: {town}` | `{job error} Press Find leads to try again.` | `/#/scraper` |
| `health:find:towns` | `Add more towns to your automatic search` | `Every town on your list was searched in the last 30 days, so nothing new is being found. Add towns on the Lead Scraper page.` | `/#/scraper` |

`health:find:towns` is closed (`closeTodos`) when an automatic search starts.

### Health lights fed

- **`lead_search`** (registered by Task 12 with stage 0's `registerLight`; stage 0's `computeLights` is not edited).
  Fed by heartbeat `find`, written by `daily_find` with `beat(DB, "find", ok, line)` after each decision and when
  today's job fails. Shape `{name: "lead_search", level, detail, fix}`:

  | level | When | detail | fix |
  | --- | --- | --- | --- |
  | `grey` | No `find` beat yet (not in use; never adds a todo) | `No automatic search has run yet` | `""` |
  | `red` | Latest beat `ok = 0` | `Today's lead search went wrong: {beat detail}` | `Open the Lead Scraper page and press Find leads. If it fails again, check GITHUB_TOKEN in Cloudflare (Pages → Settings → Variables and Secrets) is still valid.` |
  | `red` | Latest beat older than 26 hours | `The automatic lead search hasn't run for {h} hours` | `The daily search runs from the tick: check the tick light. If that is green, press Find leads on the Lead Scraper page.` |
  | `green` | Otherwise | `{beat detail}` (today's line) | `""` |

  The name is `lead_search`, not `find`, so its `health:lead_search` todo can never close this stage's
  `health:find:*` todos by prefix.
- **Research** (heartbeat/fires `routine:research`): fed by `fireRoutine` (stage 0 rules). The research queue light
  is stage 2's `research` light.

### Perfect when

1. `cd lead-manager && python -m pytest -q` passes, including the new regression tests of tasks 1–9.
2. `node --test control-room/tests/*.test.mjs` passes, including `territory`, `find`, `daily-find`, `stale-jobs`,
   `territory-api` tests; `for f in control-room/public/js/*.js; do node --check "$f"; done` is clean.
3. `grep -c CLAUDE_ROUTINE .github/workflows/scrape-leads.yml` prints 0 and `daily.yml` has no active `schedule:`
   (both are pytest assertions in task 8).
4. **Live, run one town:** press Find leads for `landscaper` in `Northwich` (60). It reaches Done within 30 minutes;
   `SELECT sku, calls FROM api_usage WHERE run_id = '<job id>'` returns at least one row.
5. **Live, 10 random pitchable leads** from that run (`SELECT … FROM leads WHERE last_job_id = '<job id>' AND
   excluded = 0 AND quality_score >= 35 ORDER BY random() LIMIT 10`): open each one's website and Google listing.
   Every issue line is true; none is a chain, franchise branch or front-desk business; every owner name marked
   confident appears in their own words or email; no name is a word of the business name (except a first name),
   the town or a famous person. Result: 10 of 10, written into the stage notes. Any failure → a regression test and
   fix (task 16) and a fresh sample of 10.
6. **Live, every excluded lead** of that run has a correct reason (none of them a sole trader wrongly called a chain
   or front desk).
7. **Live, enqueue:** within 10 minutes of deploy, `SELECT COUNT(*) FROM research WHERE status = 'queued'` equals the
   count from the handed-to-research SQL in task 11; `routine_fires` has one `research` row (or, if the Routine isn't
   set up yet, a `health` todo from `fireRoutine`).
8. **Live, daily decision:** on three consecutive mornings the Scraper page shows a today line by 06:10 UK; each
   matches the counts (`pipelineCounts`) at that time; at most one automatic job per day; no town repeated within
   30 days.
9. **Live, stale:** insert `jobs` row `('stale-test','landscaper','Test',60,'running', …)` with `updated_at` 2 hours
   ago; within 15 minutes it is `failed` with the exact error text and one `health` todo exists; then delete both.
10. A finished search (manual or automatic) has its qualifying leads in `research` as `queued` within 10 minutes of
    the job showing Done.

---

# Find Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make lead finding fully automatic from the tick, free of false claims, and feeding stage 2's research queue.

**Architecture:** The Python engine stays on GitHub Actions and gets eight small fixes with regression tests. The
daily decision moves into the Pages tick: `_lib/territory.js` (pure) chooses and explains, `_lib/find.js` (db) starts
runs, queues research, fires the Routine and marks stale runs; tick steps `daily_find` and `stale_jobs` call it.

**Tech Stack:** Python 3.11 + httpx + BeautifulSoup + pytest/respx; Cloudflare Pages Functions (plain JS ES modules),
D1, `node --test` with `tests/helpers/fakeD1.mjs`; plain-JS front end.

**Spec:** Part A of this file + docs/rebuild/00-overview.md

## Global Constraints

- Overview §9 rules apply (truth, escaping, plain-English errors, UTC storage, UK rules via `ukTime.js`, tests).
- Commands that must pass before any push: `cd lead-manager && python -m pytest -q`; `node --test control-room/tests/*.test.mjs mail-relay/tests/*.test.mjs`; `for f in control-room/public/js/*.js; do node --check "$f"; done`.
- Every commit: `git commit -m "<message>" -m "$TRAILER"` where `TRAILER` is the two lines `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_017h4iwgwaGCvQ5f9mmF4rDY`.
- Decision time: first tick with UK time ≥ `06:00`; one decision per UK day, claimed by compare-and-set on `settings.find:day`.
- `GOOD_WAITING_MIN = 30`, `RESEARCH_QUEUE_MAX = 40`, `RECENT_DAYS = 30`, `MIN_RESEARCH_SCORE = 35` (equals `research.MIN_SCORE`), `STALE_MINUTES = 45`, `RESEARCH_FIRE_GAP_HOURS = 6`.
- Territory setting key `territory`, JSON `{on, trade, towns, next, max}`, same shape and defaults in JS and Python.
- Timestamps written by this stage use util `now()` format `YYYY-MM-DDTHH:MM:SSZ` (no milliseconds), so string comparison with Python's `_now()` is exact.
- `daily_find` uses at most 14 D1 statements per run; `stale_jobs` at most 6 (D1 free plan: 50 per invocation). Stage 0's `runTick` counts queries tick-wide (`ctx.budget`) and defers a step (result `"deferred"`) when fewer than 10 are left; both steps are idempotent, so a deferred run simply happens on a later tick.
- GitHub holds no Claude tokens; only the app fires Routines (`fireRoutine`).
- Every issue line quoted to prospects needs a regression test; any new false alarm from real data → a test first.
- Scraped text is rendered with `esc()` only.

## Review Focus

1. **Pages that aren't the real homepage** (bot checks answering 200/202, browser-only shells, cookie walls): false
   claims to prospects. Tests in Task 1 (sgcaptcha 202, "Just a moment…" 200, empty `#root` shell, 415, 404/521).
2. **Clock edges:** 05:59 vs 06:00 UK, BST vs GMT on 25 Oct 2026, two ticks in the same minute. Tests in Task 12
   (`before 06:00 nothing`, `GMT after clocks go back`, `second tick same day starts nothing`).
3. **Territory edits:** blank/duplicate towns, `next` past the end, trade change, other-trade jobs. Tests in Task 9.
4. **Runs that look alive but aren't, or look dead but aren't:** progress row newer than the job row; queued for 44
   vs 46 minutes; running twice marks once. Tests in Task 13.
5. **Leads that must never be queued or counted:** excluded, suppressed by domain via website host, score 34,
   already researched, emailed A-grade. Tests in Tasks 10 and 11.

---

### Task 1: Audit: bot checks and browser-only pages are "not checked"

**Files:** Modify `lead-manager/aetos_leads/audit.py`; Test `lead-manager/tests/test_leads.py`.

**Interfaces:** Produces `audit.BROKEN_STATUSES: set[int]`, `audit.CHALLENGE_RE: re.Pattern`, `audit.NOT_READABLE: str`, `audit.browser_only(html: str) -> bool`.

- [ ] **Step 1: Write the failing tests** in `test_leads.py`:
  ```python
  @respx.mock
  def test_bot_check_pages_are_not_checked():
      sg = '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F"></head></html>'
      respx.get("https://sg.co.uk/").mock(return_value=httpx.Response(202, text=sg))
      respx.get("https://cf.co.uk/").mock(return_value=httpx.Response(200, text="<title>Just a moment...</title>"))
      respx.get("https://odd.co.uk/").mock(return_value=httpx.Response(415))
      for site in ("https://sg.co.uk/", "https://cf.co.uk/", "https://odd.co.uk/"):
          l = run_audit(lead(website=site))
          assert l.findings == ["not_checked"] and l.issues == [audit.NOT_CHECKED] and l.audit["status"] == "blocked", site

  @respx.mock
  def test_real_errors_are_still_broken():
      respx.get("https://gone.co.uk/").mock(return_value=httpx.Response(404))
      respx.get("https://origin.co.uk/").mock(return_value=httpx.Response(521))
      assert run_audit(lead(website="https://gone.co.uk/")).issues == ["Website is broken (error 404)"]
      assert run_audit(lead(website="https://origin.co.uk/")).issues == ["Website is broken (error 521)"]

  @respx.mock
  def test_browser_only_page_is_not_checked():
      shell = '<html><head><title>Smith</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
      respx.get("https://spa.co.uk/").mock(return_value=httpx.Response(200, text=shell))
      l = run_audit(lead(website="https://spa.co.uk/"))
      assert l.findings == ["not_checked"] and l.issues == [audit.NOT_READABLE] and l.audit["status"] == "browser_only"
      assert not audit.browser_only(OLD) and not audit.browser_only(GOOD)
  ```
- [ ] **Step 2: Run to verify they fail** — `cd lead-manager && python -m pytest -q tests/test_leads.py -k "bot_check or real_errors or browser_only"` → FAIL (`AttributeError: NOT_READABLE`, 202 page audited as ok).
- [ ] **Step 3: Implement in `audit.py`** — in `audit_lead`, after the fetch: status 202, `CHALLENGE_RE.search(resp.text)` or a status ≥ 400 not in `BROKEN_STATUSES` → `not_checked` (status `blocked`); a status in `BROKEN_STATUSES` → `site_broken`; `browser_only(resp.text)` → `[("not_checked", NOT_READABLE)]`, status `browser_only`. Exact values:
  ```python
  BROKEN_STATUSES = {404, 410, 500, 502, 504, 520, 521, 522, 523, 524, 525, 526, 530}
  CHALLENGE_RE = re.compile(r"/\.well-known/sgcaptcha|<title>\s*(Just a moment|Attention Required|Access denied|"
                            r"Checking your browser|One moment, please)", re.I)
  NOT_READABLE = "Couldn't check the website automatically (it only loads in a browser). Look at it yourself"
  # browser_only: visible text (script/style/noscript removed) under 200 characters AND a <script src=…> AND
  # (a <noscript> element OR an empty element with id root|app|__next|__nuxt)
  ```
- [ ] **Step 4: Run tests** — `cd lead-manager && python -m pytest -q` → PASS (existing firewall/403 test unchanged).
- [ ] **Step 5: Commit** — `git add lead-manager/aetos_leads/audit.py lead-manager/tests/test_leads.py && git commit -m "Audit: bot checks and browser-only pages are 'not checked', not broken" -m "$TRAILER"`

### Task 2: Audit: the contact page counts for form, map, phone and address

**Files:** Modify `lead-manager/aetos_leads/audit.py`, `lead-manager/aetos_leads/contacts.py`; Test `lead-manager/tests/test_leads.py`, `lead-manager/tests/test_contacts.py`.

**Interfaces:** Produces `audit.analyse_html(html, final_url, town, load_seconds, today=None, trade="", phone="", postcode="", extra_pages: list[str] = ()) -> tuple[list[tuple[str, str]], dict]`; `contacts.find` always fetches the first link whose hint is one of `contact`, `get-in-touch`, `enquir`, `quote`.

- [ ] **Step 1: Write the failing tests:**
  ```python
  def test_site_wide_checks_read_the_contact_page():   # test_leads.py
      home = GOOD.replace('<form><input name="email"><textarea name="msg"></textarea></form>', "") \
                 .replace('<iframe src="https://www.google.com/maps/embed?pb=abc"></iframe>', "") \
                 .replace("Acme Roofing, 1 High St, Leeds LS1 1AA · ", "").replace("Call 0113 496 0001", "Call us")
      contact = ('<form><textarea></textarea></form><iframe src="https://www.google.com/maps/embed?pb=x"></iframe>'
                 "<p>0113 496 0001 · 1 High St, Leeds LS1 1AA</p>")
      found, facts = audit.analyse_html(home, "https://acmeroofing.co.uk/", "Leeds", 0.8, today=date(2026, 10, 3),
                                        trade="roofer", phone="0113 496 0001", postcode="LS1 1AA", extra_pages=[contact])
      assert not {"no_form", "no_map", "phone_not_on_site", "address_not_on_site"} & set(keys(found))
      assert facts["contact_form"] is True and facts["google_map"] is True

  @respx.mock
  def test_contact_page_is_fetched_even_when_home_has_an_email():   # test_contacts.py
      home = '<p>info@smith.co.uk</p><a href="/contact">Contact</a><a href="/about">About</a>'
      contact = respx.get("https://smith.co.uk/contact").mock(return_value=httpx.Response(200, text="<form><input></form>"))
      respx.get("https://smith.co.uk/about").mock(return_value=httpx.Response(200, text="nothing"))
      found = run(lambda c: contacts.find(c, home, "https://smith.co.uk/"))
      assert contact.called and len(found["htmls"]) >= 2
  ```
  Also update `test_pipeline_end_to_end`: `respx.get("http://smithroofing.co.uk/contact-us.html").mock(return_value=httpx.Response(404))`.
- [ ] **Step 2: Run to verify they fail** — `cd lead-manager && python -m pytest -q -k "site_wide or contact_page_is_fetched"` → FAIL (`unexpected keyword argument 'extra_pages'`; contact route not called).
- [ ] **Step 3: Implement** — in `contacts.find`, never skip the first contact-hint link; in `audit.audit_lead`, call `contacts.find` before `analyse_html` and pass `extra_pages=found["htmls"][1:]`; in `analyse_html`, the form, map iframe, phone (text or `tel:`) and postcode checks pass if any of homepage + `extra_pages` passes. Title, H1, schema, viewport, description and tap-to-call stay homepage-only.
- [ ] **Step 4: Run tests** — `cd lead-manager && python -m pytest -q` → PASS.
- [ ] **Step 5: Commit** — `git add lead-manager/aetos_leads/audit.py lead-manager/aetos_leads/contacts.py lead-manager/tests && git commit -m "Audit: form, map, phone and address are checked on the contact page too" -m "$TRAILER"`

### Task 3: Audit: town and trade wording variants

**Files:** Modify `lead-manager/aetos_leads/audit.py`; Test `lead-manager/tests/test_leads.py`.

**Interfaces:** Produces `audit.town_key(name: str) -> str` (lower case, "saint" → "st", punctuation removed, hyphens → spaces, spaces collapsed); `TRADE_SYNONYMS["landscaper"]` extended; tap-to-call line `"No tap-to-call phone link on the home page"`.

- [ ] **Step 1: Write the failing test:**
  ```python
  def test_town_and_trade_wording_variants():
      assert audit.town_key("St. Helens") == audit.town_key("Saint Helens") == audit.town_key("st helens") == "st helens"
      assert audit.town_key("Newton-le-Willows") == "newton le willows"
      html = ('<html><head><title>Patios, Driveways &amp; Lawns | St. Helens</title></head>'
              '<body><h1>Garden Landscaping in Saint Helens</h1><a href="tel:01744000000">Call</a></body></html>')
      found, _ = audit.analyse_html(html, "https://x.co.uk/", "St Helens", 1, today=date(2026, 10, 3), trade="landscaper")
      assert not {"title_no_trade", "title_no_town", "h1_weak", "no_tap_to_call"} & set(keys(found))
      for title in ["Fencing & Decking", "Turf and Artificial Grass", "Tree and Hedge Care", "Groundworks"]:
          assert audit.mentions(title, audit.trade_terms("landscaper")), title
      no_tel, _ = audit.analyse_html(OLD, "https://x.co.uk/", "Leeds", 1, today=date(2026, 10, 3))
      assert ("no_tap_to_call", "No tap-to-call phone link on the home page") in no_tel
  ```
- [ ] **Step 2: Run to verify it fails** — `cd lead-manager && python -m pytest -q -k town_and_trade` → FAIL (`AttributeError: town_key`).
- [ ] **Step 3: Implement** — `title_no_town` and `h1_weak` compare `town_key(town) in town_key(text)`; landscaper synonyms become `["landscap", "garden", "lawn", "patio", "paving", "driveway", "fenc", "deck", "turf", "artificial grass", "tree", "hedge", "groundwork", "outdoor"]`; change the tap-to-call line.
- [ ] **Step 4: Run tests** — `cd lead-manager && python -m pytest -q` → PASS.
- [ ] **Step 5: Commit** — `git add lead-manager/aetos_leads/audit.py lead-manager/tests/test_leads.py && git commit -m "Audit: St./Saint and hyphenated towns, landscaper wording, true tap-to-call line" -m "$TRAILER"`

### Task 4: Qualify: trade names aren't front desks; one site in one town is one business

**Files:** Modify `lead-manager/aetos_leads/qualify.py`; Test `lead-manager/tests/test_leads.py`.

**Interfaces:** Consumes `audit.town_key`. Produces new `qualify.FRONT_DESK_WORDS`.

- [ ] **Step 1: Write the failing tests** (and in `test_exclusions` give lead `d` `town="Bradford"` so it stays a chain):
  ```python
  def test_trade_names_with_clinic_or_surgery_are_not_front_desk():
      leads = [lead(place_id="a", name="Smith Tree Surgery"), lead(place_id="b", name="The Lawn Clinic"),
               lead(place_id="c", name="Driveway Clinic Warrington"), lead(place_id="d", name="Warrington Dental Clinic"),
               lead(place_id="e", name="Bridge St Solicitors"), lead(place_id="f", name="Bridge Street Surgery", types=["doctor"])]
      qualify.mark_exclusions(leads)
      assert [l.exclude_reason for l in leads] == ["", "", "", "Front desk / gatekeeper", "Front desk / gatekeeper",
                                                   "Front desk / gatekeeper"]

  def test_same_website_same_town_is_a_duplicate_not_a_chain():
      leads = [lead(place_id="a", name="Green Leaf", phone="01925 111111", website="https://greenleaf.co.uk", review_count=40),
               lead(place_id="b", name="Green Leaf Gardens", phone="07700 900000", website="https://www.greenleaf.co.uk/", review_count=3)]
      qualify.mark_exclusions(leads)
      assert [l.exclude_reason for l in leads] == ["", "Duplicate listing of Green Leaf"]
  ```
- [ ] **Step 2: Run to verify they fail** — `cd lead-manager && python -m pytest -q -k "clinic_or_surgery or same_town_is_a_duplicate or test_exclusions"` → FAIL (Tree Surgery excluded; both Green Leaf listings "Multiple branches (chain)").
- [ ] **Step 3: Implement** — `FRONT_DESK_WORDS = re.compile(r"\b(dental|dentists?|doctors?|medical|nhs|veterinary|vets|physio\w*|solicitors?|council|opticians?|pharmacy|chemist)\b", re.I)`; group real-website listings by host: all in one `town_key` → keep the most reviewed, the rest `Duplicate listing of {kept name}`; more than one town → all `Multiple branches (chain)`.
- [ ] **Step 4: Run tests** — `cd lead-manager && python -m pytest -q` → PASS.
- [ ] **Step 5: Commit** — `git add lead-manager/aetos_leads/qualify.py lead-manager/tests/test_leads.py && git commit -m "Exclusions: Tree Surgery and Lawn Clinic are trades; one site in one town is a duplicate" -m "$TRAILER"`

### Task 5: Duplicates and branches across runs

**Files:** Modify `lead-manager/aetos_leads/qualify.py`, `pipeline.py`, `store.py`, `__main__.py`; Test `lead-manager/tests/test_leads.py`; move `FakeD1` from `tests/test_autopilot.py` to `tests/conftest.py`.

**Interfaces:** Produces `qualify.mark_exclusions(leads, known: list[dict] = ()) -> list[str]` (known = `{place_id, name, website, phone, town}` of saved, non-excluded leads; returns known place_ids that are now branches); `pipeline.run(..., known: list[dict] = ())` and `Result.chain_ids: list[str]`; `store.D1.known_leads() -> list[dict]` (`SELECT place_id, name, website, phone, town FROM leads WHERE excluded = 0`); `store.D1.exclude_chains(place_ids: list[str]) -> None` (`UPDATE leads SET excluded = 1, exclude_reason = 'Multiple branches (chain)' WHERE place_id IN (…) AND place_id NOT IN (SELECT place_id FROM prospects)`).

- [ ] **Step 1: Write the failing tests:**
  ```python
  def test_earlier_leads_catch_duplicates_and_branches():
      known = [{"place_id": "old1", "name": "Magic Roofing", "phone": "07907 928806", "website": "", "town": "Warrington"},
               {"place_id": "old2", "name": "Lawn Pro Warrington", "phone": "01925 000001",
                "website": "https://lawnpro.co.uk/warrington", "town": "Warrington"},
               {"place_id": "same", "name": "Same Biz", "phone": "01925 000002", "website": "", "town": "Wigan"}]
      leads = [lead(place_id="n1", name="Magic Roofing Ltd", phone="+44 7907 928806", town="Wigan"),
               lead(place_id="n2", name="Lawn Pro Wigan", phone="01942 000003", website="https://www.lawnpro.co.uk/wigan", town="Wigan"),
               lead(place_id="same", name="Same Biz", phone="01925 000002", town="Wigan")]
      assert qualify.mark_exclusions(leads, known) == ["old2"]
      assert [l.exclude_reason for l in leads] == ["Duplicate listing of Magic Roofing", "Multiple branches (chain)", ""]

  def test_exclude_chains_spares_leads_already_in_the_pipeline():
      d1 = FakeD1()
      for pid in ("a", "b"):
          d1.query("INSERT INTO leads (place_id, name, trade, search_town, first_seen_at, updated_at) VALUES (?, 'X', 't', 'T', 'x', 'x')", [pid])
      d1.query("INSERT INTO prospects (place_id, stage, stage_at, email, created_at, updated_at) VALUES ('b', 'emailed', 'x', 'b@x.co.uk', 'x', 'x')")
      store.D1.exclude_chains(d1, ["a", "b"])
      rows = d1.query("SELECT place_id, excluded FROM leads ORDER BY place_id")["result"][0]["results"]
      assert [(r["place_id"], r["excluded"]) for r in rows] == [("a", 1), ("b", 0)]
  ```
- [ ] **Step 2: Run to verify they fail** — `cd lead-manager && python -m pytest -q -k "earlier_leads or exclude_chains"` → FAIL (`unexpected argument known`; no `exclude_chains`).
- [ ] **Step 3: Implement** — known leads join the phone and host groups (a known place_id equal to a run lead's is ignored); a known lead always wins as the kept listing; `__main__.scrape` passes `known=d1.known_leads()` and calls `d1.exclude_chains(result.chain_ids)` after `d1.save`.
- [ ] **Step 4: Run tests** — `cd lead-manager && python -m pytest -q` → PASS.
- [ ] **Step 5: Commit** — `git add lead-manager && git commit -m "Exclusions: catch duplicates and franchise branches across earlier searches" -m "$TRAILER"`

### Task 6: Maps findings only in the lead's own town

**Files:** Modify `lead-manager/aetos_leads/qualify.py`, `lead-manager/aetos_leads/store.py`; Test `lead-manager/tests/test_leads.py`.

**Interfaces:** Consumes `audit.town_key`. Produces `lead.map_rank["home"]: bool`; `store.keep_home_maps(lead: Lead, prev_audit: dict) -> None`; `store.prior_sql(n)` selects every saved row among the ids (no `ai_research` filter).

- [ ] **Step 1: Write the failing tests:**
  ```python
  def test_maps_findings_only_in_the_leads_own_town():
      scan = maprank.Scan("landscaper", "Runcorn", 3, 1000, 0, 0, [], [maprank.BusinessResult("top", review_count=90, avg_rank=1, top3_pct=100, found_pct=100)])
      away, home = lead(place_id="w", town="Warrington"), lead(place_id="r", town="Runcorn")
      qualify.score([away, home], scan)
      assert away.findings == [] and away.map_rank["home"] is False and away.score_parts["maps"] == 0
      assert home.findings[0] == "maps_invisible" and home.map_rank["home"] is True

  def test_rescrape_from_another_town_keeps_home_maps(tmp_path):
      db = tmp_path / "leads.db"
      first = lead(town="Warrington", findings=["no_website", "maps_invisible"],
                   issues=["No website", "Not in Google Maps' top 20 anywhere we checked across Warrington"],
                   map_rank={"avg_rank": 21.0, "top3_pct": 0, "found_pct": 0, "scan_town": "Warrington", "home": True},
                   quality_score=97, score_parts={"total": 97, "website": 45, "seo": 30, "maps": 22})
      store.save_sqlite(db, [first])
      again = lead(town="Warrington", findings=["no_website"], issues=["No website"],
                   map_rank={"avg_rank": 21.0, "top3_pct": 0, "found_pct": 0, "scan_town": "Runcorn", "home": False},
                   quality_score=75, score_parts={"total": 75, "website": 45, "seo": 30, "maps": 0})
      store.save_sqlite(db, [again])
      assert again.quality_score == 97 and "maps_invisible" in again.findings
      assert again.map_rank["scan_town"] == "Warrington" and again.issues[-1].endswith("across Warrington")
  ```
- [ ] **Step 2: Run to verify they fail** — `cd lead-manager && python -m pytest -q -k "own_town or keeps_home_maps"` → FAIL (`KeyError: 'home'`; score 75).
- [ ] **Step 3: Implement** — in `qualify.score`, maps and reviews findings only when `town_key(lead.town or lead.search_town) == town_key(scan.town)`; `map_rank` always records `scan_town` and `home`. In `store.carry_over`, for every prior row call `keep_home_maps` before `research.carry_over`: when the new `map_rank.home` is False and the prior `map_rank.scan_town` is the lead's town, restore the prior `map_rank`, regenerate its line with `scoring.maps_findings(...)`, and rescore with `scoring.score(lead.findings)`.
- [ ] **Step 4: Run tests** — `cd lead-manager && python -m pytest -q` → PASS (`test_rescrape_keeps_claudes_work` still passes).
- [ ] **Step 5: Commit** — `git add lead-manager && git commit -m "Maps score only from the lead's own town; keep it when found from a neighbour" -m "$TRAILER"`

### Task 7: Contacts: never take the web designer's email

**Files:** Modify `lead-manager/aetos_leads/contacts.py`, `lead-manager/aetos_leads/audit.py`; Test `lead-manager/tests/test_contacts.py`.

**Interfaces:** Produces `contacts.emails_in(html: str, site_host: str = "") -> list[str]`; `contacts.DESIGNER_WORDS: re.Pattern`.

- [ ] **Step 1: Write the failing test:**
  ```python
  def test_web_designer_credit_emails_are_ignored():
      footer = "<footer>Website designed by Pixel Studio · hello@pixelstudio.co.uk</footer>"
      assert contacts.emails_in(footer, "smithlandscapes.co.uk") == []
      own = "<footer>info@smithlandscapes.co.uk · Website by Pixel Studio</footer>"
      assert contacts.emails_in(own, "smithlandscapes.co.uk") == ["info@smithlandscapes.co.uk"]
  ```
- [ ] **Step 2: Run to verify it fails** — `cd lead-manager && python -m pytest -q -k designer` → FAIL (`hello@pixelstudio.co.uk` returned).
- [ ] **Step 3: Implement** — `DESIGNER_WORDS = re.compile(r"web\s*design|designed by|website by|site by|built by|developed by|powered by|hosted by", re.I)`; an address not on `site_host` with `DESIGNER_WORDS` in the 80 characters before or 40 after it is dropped; `contacts.find` and `audit.extract_emails` pass `site_host`.
- [ ] **Step 4: Run tests** — `cd lead-manager && python -m pytest -q` → PASS.
- [ ] **Step 5: Commit** — `git add lead-manager && git commit -m "Emails: ignore the web designer's address in site credits" -m "$TRAILER"`

### Task 8: Workflows: no Claude hand-off from GitHub, daily cron stays off

**Files:** Modify `.github/workflows/scrape-leads.yml` (delete step "Hand the hard cases to Claude"), `.github/workflows/daily.yml` (header line: `# Replaced by the Control Room's daily_find tick step (docs/rebuild/02-find.md). Keep the schedule commented out.`), `lead-manager/aetos_leads/__main__.py` (delete the `for_claude` print and `GITHUB_OUTPUT` write); Create `lead-manager/tests/test_workflows.py`.

**Interfaces:** None new.

- [ ] **Step 1: Write the failing tests:**
  ```python
  from pathlib import Path
  import re
  WF = Path(__file__).resolve().parents[2] / ".github" / "workflows"

  def test_scrape_workflow_never_calls_claude():
      text = (WF / "scrape-leads.yml").read_text()
      assert "CLAUDE_ROUTINE" not in text and "routines/" not in text

  def test_daily_workflow_stays_paused():
      assert not re.search(r"^\s*schedule:", (WF / "daily.yml").read_text(), re.M)
  ```
- [ ] **Step 2: Run to verify it fails** — `cd lead-manager && python -m pytest -q tests/test_workflows.py` → FAIL on `CLAUDE_ROUTINE`.
- [ ] **Step 3: Implement** — the three edits above.
- [ ] **Step 4: Run tests** — `cd lead-manager && python -m pytest -q` → PASS.
- [ ] **Step 5: Commit** — `git add .github/workflows lead-manager && git commit -m "Scrape workflow: the Control Room fires Claude, GitHub holds no Claude tokens" -m "$TRAILER"`

### Task 9: `_lib/territory.js`: choose the town, decide, explain

**Files:** Create `control-room/functions/_lib/territory.js`, `control-room/tests/territory.test.mjs`, `lead-manager/tests/test_territory_sync.py`.

**Interfaces:** Consumes `ukDate`, `ukParts`, `addUkDays` from `_lib/ukTime.js`. Produces (pure):
```js
DEFAULT_TERRITORY, RECENT_DAYS = 30, GOOD_WAITING_MIN = 30, RESEARCH_QUEUE_MAX = 40, MIN_RESEARCH_SCORE = 35, FIND_FROM = "06:00"
parseTerritory(raw: string|null) → territory                       // JSON merged over defaults; bad JSON → defaults
cleanTerritory(body, old) → {territory} | {error}                   // the PUT validation and `next` rule
chooseTown(territory, recentJobs, ukToday) → {town, next} | null    // recentJobs: [{trade, town, status, created_at}]
decideFind({territory, goodWaiting, researchQueued, activeJobs, recentJobs, ukToday})
  → {search: true, town, next} | {search: false, reason: "off"|"running"|"good"|"research"|"towns", n?}
todayLine(decision, job, now) → string                              // exact lines of Part A's table
```

- [ ] **Step 1: Write the failing tests** (`territory.test.mjs`):
  ```js
  const T = { ...DEFAULT_TERRITORY, towns: ["Warrington", "Widnes", "Runcorn"], next: 0 };
  const job = (town, created_at, extra = {}) => ({ trade: "landscaper", town, status: "done", created_at, ...extra });
  test("skips towns searched in the last 30 days for this trade", () => {
    assert.deepEqual(chooseTown(T, [job(" warrington ", "2026-10-10T06:00:00Z")], "2026-10-19"), { town: "Widnes", next: 2 });
    assert.deepEqual(chooseTown(T, [job("Warrington", "2026-09-19T08:00:00Z")], "2026-10-19"), { town: "Warrington", next: 1 });
    assert.deepEqual(chooseTown(T, [job("Warrington", "2026-09-20T08:00:00Z")], "2026-10-19"), { town: "Widnes", next: 2 });
    assert.deepEqual(chooseTown(T, [job("Warrington", "2026-10-18T06:00:00Z", { status: "failed" })], "2026-10-19").town, "Warrington");
    assert.deepEqual(chooseTown(T, [job("Warrington", "2026-10-18T06:00:00Z", { trade: "Roofer" })], "2026-10-19").town, "Warrington");
    assert.equal(chooseTown(T, ["Warrington", "Widnes", "Runcorn"].map((t) => job(t, "2026-10-18T06:00:00Z")), "2026-10-19"), null);
    assert.equal(chooseTown({ ...T, next: 7 }, [], "2026-10-19").town, "Widnes");
  });
  test("decides in order: off, running, good, research, towns", () => {
    const base = { territory: T, goodWaiting: 29, researchQueued: 39, activeJobs: 0, recentJobs: [], ukToday: "2026-10-19" };
    assert.deepEqual(decideFind(base), { search: true, town: "Warrington", next: 1 });
    assert.deepEqual(decideFind({ ...base, territory: { ...T, on: false }, activeJobs: 1 }), { search: false, reason: "off" });
    assert.deepEqual(decideFind({ ...base, activeJobs: 1, goodWaiting: 99 }), { search: false, reason: "running" });
    assert.deepEqual(decideFind({ ...base, goodWaiting: 30 }), { search: false, reason: "good", n: 30 });
    assert.deepEqual(decideFind({ ...base, researchQueued: 40 }), { search: false, reason: "research", n: 40 });
  });
  test("today line", () => {
    const now = new Date("2026-10-19T09:00:00Z");
    const d = { day: "2026-10-19", at: "2026-10-19T05:02:00Z", search: true, town: "Widnes", job_id: "j" };
    assert.equal(todayLine(d, { status: "done", found: 41 }, now), "Searched Widnes at 06:02 — 41 found");
    assert.equal(todayLine(d, { status: "running" }, now), "Searching Widnes (started 06:02)");
    assert.equal(todayLine({ day: "2026-10-19", search: false, reason: "good", n: 34 }, null, now), "Skipped: 34 good leads waiting");
    assert.equal(todayLine({ day: "2026-10-18", search: false, reason: "good", n: 34 }, null, now), "Decided after 6am");
  });
  test("territory edits", () => {
    const old = { ...T, next: 2 };
    assert.equal(cleanTerritory({ on: true, trade: "landscaper", towns: "Warrington\n\nwidnes\nWidnes \nRuncorn", max: 60 }, old).territory.towns.length, 3);
    assert.equal(cleanTerritory({ on: true, trade: "landscaper", towns: ["Warrington", "Widnes", "Runcorn"], max: 60 }, old).territory.next, 2);
    assert.equal(cleanTerritory({ on: true, trade: "roofer", towns: ["Warrington", "Widnes", "Runcorn"], max: 60 }, old).territory.next, 0);
    assert.deepEqual(cleanTerritory({ trade: "landscaper", towns: " ", max: 60 }, old), { error: "Add at least one town (one per line)" });
    assert.deepEqual(cleanTerritory({ trade: "landscaper", towns: "Leigh", max: 5 }, old), { error: "Leads per search must be between 10 and 300" });
    assert.deepEqual(parseTerritory("{bad"), DEFAULT_TERRITORY);
  });
  ```
  And `test_territory_sync.py`: read `control-room/functions/_lib/territory.js`, assert the `towns: [...]` list equals `autopilot.DEFAULT_TERRITORY["towns"]`, `trade: "landscaper"`, `max: 60`, and `MIN_RESEARCH_SCORE = 35` equals `research.MIN_SCORE`.
- [ ] **Step 2: Run to verify they fail** — `node --test control-room/tests/territory.test.mjs` → FAIL (module not found); `cd lead-manager && python -m pytest -q tests/test_territory_sync.py` → FAIL (file not found).
- [ ] **Step 3: Implement `control-room/functions/_lib/territory.js`** — towns de-duplicated case-insensitively keeping first spelling; a job is recent when same trade (case-insensitive), `status !== "failed"` and `ukDate(new Date(created_at)) > addUkDays(ukToday, -RECENT_DAYS)`; `todayLine` formats times with `ukParts`, returns `"Decided after 6am"` when `decision?.day !== ukDate(now)`. `cleanTerritory` keeps the old errors: `"Type the niche to search, e.g. landscaper"`, `"Add at least one town (one per line)"`, `"Leads per search must be between 10 and 300"`.
- [ ] **Step 4: Run tests** — `node --test control-room/tests/territory.test.mjs` and `cd lead-manager && python -m pytest -q` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/territory.js control-room/tests/territory.test.mjs lead-manager/tests/test_territory_sync.py && git commit -m "Territory: pick the town, decide today's search, explain it in one line" -m "$TRAILER"`

### Task 10: `_lib/find.js`: start a search, pipeline counts

**Files:** Create `control-room/functions/_lib/find.js`, `control-room/tests/find.test.mjs`; Modify `control-room/functions/api/scrape.js` (use `startScrape`, same 201/502 responses).

**Interfaces:** Consumes `getSetting`, `setSetting` (`_lib/settings.js`), `startWorkflow(env, workflow, inputs) → Promise<""|string>` (`_lib/github.js`), `parseTerritory` (Task 9), `fakeD1()` (stage 0 test helper). Produces:
```js
iso(date) → "YYYY-MM-DDTHH:MM:SSZ"
loadTerritory(DB) → Promise<territory>;  saveTerritory(DB, territory) → Promise<void>
startScrape(DB, env, {trade, town, max}, {start = startWorkflow, now = new Date()} = {}) → Promise<{job, error}>
pipelineCounts(DB) → Promise<{goodWaiting, researchQueued, activeJobs}>
recentJobs(DB, now) → Promise<[{trade, town, status, created_at}]>   // created in the last 31 days
```

- [ ] **Step 1: Write the failing tests** (`find.test.mjs`):
  ```js
  test("startScrape records the run and starts the workflow", async () => {
    const DB = fakeD1(); const calls = [];
    const { job, error } = await startScrape(DB, {}, { trade: "landscaper", town: "Widnes", max: 60 },
      { start: async (env, wf, inputs) => { calls.push([wf, inputs]); return ""; } });
    assert.equal(error, ""); assert.equal(job.status, "queued");
    assert.deepEqual(calls, [["scrape-leads.yml", { trade: "landscaper", town: "Widnes", max: "60", job_id: job.id }]]);
  });
  test("a refused start is saved as failed with GitHub's reason", async () => {
    const DB = fakeD1();
    const { job, error } = await startScrape(DB, {}, { trade: "landscaper", town: "Widnes", max: 60 },
      { start: async () => "GitHub refused to start the run (401): Bad credentials" });
    assert.equal(job.status, "failed"); assert.equal(job.error, error);
  });
  test("pipeline counts only graded, unemailed, pitchable A+/A/B", async () => {
    const DB = fakeD1();
    // leads g1..g6 (excluded = 0 except g5); research: g1 A+, g2 A, g3 B, g4 C (done); g5 A but lead excluded;
    // g6 A with prospects.first_sent_at set; q1, q2 queued; one jobs row 'running', one 'done'
    assert.deepEqual(await pipelineCounts(DB), { goodWaiting: 3, researchQueued: 2, activeJobs: 1 });
  });
  ```
- [ ] **Step 2: Run to verify they fail** — `node --test control-room/tests/find.test.mjs` → FAIL (module not found).
- [ ] **Step 3: Implement `control-room/functions/_lib/find.js`** — `startScrape` inserts the `jobs` row exactly as `api/scrape.js` does today and marks it failed on an error; `pipelineCounts` uses the Part A SQL (`research` ⨝ `leads`, `grade IN ('A+','A','B')`, `too_big = 0`, `excluded = 0`, `NOT EXISTS prospects with first_sent_at`). Move `api/scrape.js`'s insert/start/fail lines into `startScrape`.
- [ ] **Step 4: Run tests** — `node --test control-room/tests/*.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/find.js control-room/functions/api/scrape.js control-room/tests/find.test.mjs && git commit -m "Find: one way to start a search; pipeline counts" -m "$TRAILER"`

### Task 11: Research queue and Routine fire

**Files:** Modify `control-room/functions/_lib/find.js`; Test `control-room/tests/find.test.mjs`.

**Interfaces:** Consumes `fireRoutine(DB, name, text) → Promise<{ok, status, error?}>` (`_lib/routines.js`). Produces:
```js
leadSuppressed({email, website, company_number}, suppressionRows) → boolean   // pure; email, email domain, website host (no www.), company
                                                                              // (named apart from stage 0's prospects.js isSuppressed(DB, email))
enqueueResearch(DB, now) → Promise<number>                                  // rows inserted
maybeFireResearch(DB, now, {fire = fireRoutine} = {}) → Promise<"fired"|"empty"|"recent"|"failed">
```

- [ ] **Step 1: Write the failing tests:**
  ```js
  test("queues every pitchable lead scoring 35+ or not checked, once", async () => {
    const DB = fakeD1();
    // a: score 60 → yes; b: 34 → no; c: 10 with audit.findings ["not_checked"] → yes; d: 90 excluded → no;
    // e: 70, email in suppression (kind email) → no; f: 70, website https://www.blocked.co.uk, suppression domain blocked.co.uk → no;
    // g: 80 with research row status 'done' → unchanged
    assert.equal(await enqueueResearch(DB, new Date("2026-10-19T05:00:00Z")), 2);
    assert.deepEqual(await ids(DB, "SELECT place_id FROM research WHERE status = 'queued' ORDER BY place_id"), ["a", "c"]);
    assert.equal(await enqueueResearch(DB, new Date("2026-10-19T06:00:00Z")), 0);
  });
  test("fires the research Routine at most every 6 hours, only with a queue", async () => {
    const DB = fakeD1(); const fired = [];
    const fire = async (db, name, text) => { fired.push([name, text]); return { ok: true, status: 200 }; };
    assert.equal(await maybeFireResearch(DB, new Date("2026-10-19T05:00:00Z"), { fire }), "empty");
    // insert 2 queued research rows
    assert.equal(await maybeFireResearch(DB, new Date("2026-10-19T05:00:00Z"), { fire }), "fired");
    assert.deepEqual(fired, [["research", "research queued: 2 leads"]]);
    // insert routine_fires row (routine 'research', at '2026-10-19T00:30:00Z', http_status 500)
    assert.equal(await maybeFireResearch(DB, new Date("2026-10-19T06:00:00Z"), { fire }), "recent");
  });
  ```
- [ ] **Step 2: Run to verify they fail** — `node --test control-room/tests/find.test.mjs` → FAIL (`enqueueResearch is not a function`).
- [ ] **Step 3: Implement** — select candidates `place_id, email, website, company_number` from `leads l` with `l.excluded = 0 AND (l.quality_score >= 35 OR EXISTS (SELECT 1 FROM json_each(l.audit, '$.findings') WHERE value = 'not_checked')) AND l.place_id NOT IN (SELECT place_id FROM research)`, filter with `leadSuppressed`, then one statement `INSERT OR IGNORE INTO research (place_id, status, queued_at) SELECT value, 'queued', ? FROM json_each(?)`. Fire guard: `SELECT 1 FROM routine_fires WHERE routine = 'research' AND at > ?` (now − 6 h); `fireRoutine` returning `ok: false` → `"failed"`.
- [ ] **Step 4: Run tests** — `node --test control-room/tests/*.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/find.js control-room/tests/find.test.mjs && git commit -m "Research queue: every pitchable lead goes to Claude once; fire at most every 6 hours" -m "$TRAILER"`

### Task 12: Tick step `daily_find`

**Files:** Modify `control-room/functions/_lib/find.js`, `control-room/functions/_lib/tick.js` (append step); Create `control-room/tests/daily-find.test.mjs`.

**Interfaces:** Consumes `decideFind`, `todayLine` (Task 9), `startScrape`, `pipelineCounts`, `recentJobs`, `loadTerritory`, `saveTerritory`, `enqueueResearch`, `maybeFireResearch` (Tasks 10–11), `addTodo`, `closeTodos` (`_lib/todo.js`), `beat` (`_lib/routines.js`), `registerLight(fn)` and (tests only) `healthFromDb(DB, env, now) → {lights, gaps}` (`_lib/health.js`, stage 0), `ukParts`, `ukDate`. Produces:
```js
claimDay(DB, ukToday) → Promise<boolean>        // INSERT … ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value != excluded.value; changes === 1
runDailyFind(DB, env, now, {start, fire} = {}) → Promise<string>
STEPS entry {name: "daily_find", everyMinutes: 5, run: (ctx) => runDailyFind(ctx.DB, ctx.env, ctx.now)}   // slot 7: after "pick", before "stale_jobs"
leadSearchLight(beatRow|null, now) → {name: "lead_search", level: "green"|"red"|"grey", detail, fix}   // pure; Part A's table
registerLight(async (DB, env, now) => leadSearchLight(await DB.prepare("SELECT ok, last_at, detail FROM heartbeats WHERE name = 'find'").first(), now))
settings: "find:day", "find:today" (JSON {day, at, search, town?, job_id?, reason?, n?, error?}), "research:enqueued_at"
```

- [ ] **Step 1: Write the failing tests** (`daily-find.test.mjs`; `start` stub records calls and returns `""`):
  ```js
  test("before 06:00 UK nothing is decided", async () => {
    const DB = fakeD1(); await runDailyFind(DB, {}, new Date("2026-10-19T04:59:00Z"), { start, fire });
    assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM jobs"), 0);
    assert.equal(await getSetting(DB, "find:today"), null);
  });
  test("06:00 BST: searches the next town once, and moves the pointer", async () => {
    const DB = fakeD1();
    await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
    await runDailyFind(DB, {}, new Date("2026-10-19T05:05:00Z"), { start, fire });
    assert.equal(starts.length, 1); assert.equal(starts[0][1].town, "Warrington");
    assert.equal((await loadTerritory(DB)).next, 1);
    assert.equal(JSON.parse(await getSetting(DB, "find:today")).town, "Warrington");
  });
  test("GMT after the clocks go back", async () => {
    const DB = fakeD1();
    await runDailyFind(DB, {}, new Date("2026-10-25T05:30:00Z"), { start, fire }); assert.equal(starts.length, 0);
    await runDailyFind(DB, {}, new Date("2026-10-25T06:00:00Z"), { start, fire }); assert.equal(starts.length, 1);
  });
  test("skips with 30 good leads waiting and says so", async () => {
    // seed 30 leads + research rows done grade 'A', not emailed
    await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
    assert.equal(starts.length, 0);
    assert.equal(todayLine(JSON.parse(await getSetting(DB, "find:today")), null, new Date("2026-10-19T09:00:00Z")), "Skipped: 30 good leads waiting");
  });
  test("a refused start adds a health todo and doesn't retry today", async () => {
    const refuse = async () => "GitHub refused to start the run (401): Bad credentials";
    await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start: refuse, fire });
    await runDailyFind(DB, {}, new Date("2026-10-19T05:05:00Z"), { start: refuse, fire });
    assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'"), 1);
    assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:2026-10-19' AND kind = 'health'"), 1);
  });
  test("every town recent → 'Add more towns' todo; a later search closes it", async () => {
    // jobs: one 'done' landscaper job per DEFAULT_TERRITORY town, created 2026-10-10T06:00:00Z
    await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
    assert.equal(starts.length, 0);
    assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:towns' AND status = 'open'"), 1);
    await runDailyFind(DB, {}, new Date("2026-11-10T06:00:00Z"), { start, fire });   // 31 days later
    assert.equal(starts.length, 1);
    assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:find:towns' AND status = 'open'"), 0);
  });
  test("a job finished since the last enqueue queues research at 14:00", async () => {
    // research:enqueued_at = 2026-10-19T05:00:00Z; jobs row done updated_at 2026-10-19T05:40:00Z; lead score 60
    await runDailyFind(DB, {}, new Date("2026-10-19T13:00:00Z"), { start, fire });
    assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM research WHERE status = 'queued'"), 1);
  });
  test("today's automatic job failing adds a health todo", async () => {
    await runDailyFind(DB, {}, new Date("2026-10-19T05:00:00Z"), { start, fire });
    const { job_id } = JSON.parse(await getSetting(DB, "find:today"));
    await DB.prepare("UPDATE jobs SET status = 'failed', error = 'Google refused the search.' WHERE id = ?").bind(job_id).run();
    await runDailyFind(DB, {}, new Date("2026-10-19T05:30:00Z"), { start, fire });
    assert.equal((await row(DB, `SELECT title FROM todos WHERE dedupe = 'health:find:failed:${job_id}'`)).title, "Today's lead search failed: Warrington");
  });
  test("tick order", () => {
    const names = STEPS.map((s) => s.name);
    assert.ok(names.indexOf("send") < names.indexOf("daily_find") && names.indexOf("daily_find") < names.indexOf("health"));
    assert.ok(names.indexOf("pick") < names.indexOf("daily_find") && names.indexOf("daily_find") < names.indexOf("stale_jobs"));
  });
  test("lead_search light", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    assert.equal(leadSearchLight(null, now).level, "grey");
    assert.deepEqual(leadSearchLight({ ok: 1, last_at: "2026-10-19T05:00:00Z", detail: "Skipped: 34 good leads waiting" }, now),
      { name: "lead_search", level: "green", detail: "Skipped: 34 good leads waiting", fix: "" });
    assert.equal(leadSearchLight({ ok: 0, last_at: "2026-10-19T05:00:00Z", detail: "x" }, now).level, "red");
    assert.equal(leadSearchLight({ ok: 1, last_at: "2026-10-18T09:59:00Z", detail: "x" }, now).level, "red");   // 26 h 1 min
    assert.equal(leadSearchLight({ ok: 1, last_at: "2026-10-18T10:01:00Z", detail: "x" }, now).level, "green");
  });
  test("lead_search is registered with healthFromDb", async () => {
    const DB = fakeD1();
    await beat(DB, "find", false, "Couldn't start the search for Widnes: GitHub refused");
    const { lights } = await healthFromDb(DB, {}, new Date());
    assert.equal(lights.find((l) => l.name === "lead_search").level, "red");
  });
  ```
- [ ] **Step 2: Run to verify they fail** — `node --test control-room/tests/daily-find.test.mjs` → FAIL (`runDailyFind is not a function`, `leadSearchLight is not a function`).
- [ ] **Step 3: Implement `runDailyFind`** — order: (1) enqueue + `maybeFireResearch` when a job became done after `research:enqueued_at`, or when it's ≥ 06:00 UK and `research:enqueued_at` is from an earlier UK day; (2) if UK time ≥ `FIND_FROM` and `claimDay` wins: decide, start or skip, save `find:today`, todos and `beat(DB, "find", ok, todayLine(...))` as in Part A; `closeTodos(DB, "health:find:towns")` when a search starts; (3) if `find:today.job_id`'s job is `failed`, add the `health:find:failed:<id>` todo and beat `find` not ok. Return a short summary, e.g. `"searched Warrington; queued 12; fired research"`. Add the pure `leadSearchLight` per Part A's light table (levels only `green`/`red`/`grey`), and call `registerLight(...)` once at module load of `find.js` (the tick imports `find.js`, so the light is registered whenever `/api/tick` or `/api/health` runs; `api/health.js` imports `_lib/find.js` for the side effect if it doesn't already).
- [ ] **Step 4: Run tests** — `node --test control-room/tests/*.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib control-room/functions/api control-room/tests/daily-find.test.mjs && git commit -m "Tick: daily lead search when the pipeline is low; queue research after every search; lead_search light" -m "$TRAILER"`

### Task 13: Tick step `stale_jobs`

**Files:** Modify `control-room/functions/_lib/find.js`, `control-room/functions/_lib/tick.js`; Create `control-room/tests/stale-jobs.test.mjs`.

**Interfaces:** Consumes `addTodo`. Produces:
```js
STALE_MINUTES = 45
STALE_JOB_ERROR = "Stopped: no progress for 45 minutes. Press Find leads to try again."
STALE_SCAN_ERROR = "Stopped: no progress for 45 minutes. Press Run scan to try again."
markStale(DB, now) → Promise<{jobs: number, scans: number}>
STEPS entry {name: "stale_jobs", everyMinutes: 15, run: (ctx) => markStale(ctx.DB, ctx.now).then((r) => `${r.jobs} searches, ${r.scans} scans stopped`)}   // slot 8: right after daily_find, before "calls"
```
Scans with `source = 'care'` are skipped (stage 11 owns them).

- [ ] **Step 1: Write the failing tests:**
  ```js
  test("marks runs with no progress for 45 minutes as failed, once", async () => {
    const DB = fakeD1(); const now = new Date("2026-10-19T12:00:00Z");
    // jobs: old (running, updated 11:14) → failed; alive (running, jobs.updated 10:00, job_progress.updated 11:50) → untouched;
    // fresh (queued, updated 11:16) → untouched; finished (done, updated 08:00) → untouched
    // scans: s1 (running, updated 11:10) → failed; c1 (running, source 'care', updated 09:00) → untouched
    assert.deepEqual(await markStale(DB, now), { jobs: 1, scans: 1 });
    assert.equal((await row(DB, "SELECT status FROM scans WHERE id = 'c1'")).status, "running");
    assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:stale:scan:c1'"), 0);
    assert.equal((await row(DB, "SELECT status, error FROM jobs WHERE id = 'old'")).error, STALE_JOB_ERROR);
    assert.equal((await row(DB, "SELECT error FROM scans WHERE id = 's1'")).error, STALE_SCAN_ERROR);
    assert.deepEqual(await markStale(DB, now), { jobs: 0, scans: 0 });
    assert.equal(await count(DB, "SELECT COUNT(*) AS n FROM todos WHERE dedupe = 'health:stale:job:old'"), 1);
    assert.equal((await row(DB, "SELECT title FROM todos WHERE dedupe = 'health:stale:job:old'")).title, "Lead search stopped: landscaper in Leigh");
  });
  ```
- [ ] **Step 2: Run to verify it fails** — `node --test control-room/tests/stale-jobs.test.mjs` → FAIL (`markStale is not a function`).
- [ ] **Step 3: Implement** — jobs: `status IN ('queued','running') AND max(j.updated_at, COALESCE(p.updated_at, '')) < ?` (cutoff `iso(now − 45 min)`), one `UPDATE … WHERE id IN (…)`; scans: `status IN ('queued','running') AND updated_at < ? AND COALESCE(source, '') != 'care'`; todos per Part A's table.
- [ ] **Step 4: Run tests** — `node --test control-room/tests/*.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib control-room/tests/stale-jobs.test.mjs && git commit -m "Tick: stop searches and scans with no progress for 45 minutes" -m "$TRAILER"`

### Task 14: `api/territory.js` (replaces `api/autopilot.js`)

**Files:** Create `control-room/functions/api/territory.js`, `control-room/tests/territory-api.test.mjs`; Delete `control-room/functions/api/autopilot.js`.

**Interfaces:** Consumes `cleanTerritory`, `chooseTown`, `todayLine`, `loadTerritory`, `saveTerritory`, `pipelineCounts`, `recentJobs`, `getSetting`. Produces:
```
GET  /api/territory → {territory, upcoming: string, today: string, counts: {goodWaiting, researchQueued}}   // context.now ?? new Date()
PUT  /api/territory {on, trade, towns, max} → {territory} | 400 {error}
```
`upcoming` = `chooseTown(...)?.town` or `"none (every town searched in the last 30 days)"`.

- [ ] **Step 1: Write the failing tests:**
  ```js
  test("GET explains today and the next town", async () => {
    const DB = fakeD1(); const now = new Date("2026-10-19T09:00:00Z");
    // find:today = {day: "2026-10-19", search: false, reason: "good", n: 34}
    const body = await (await onRequestGet({ env: { DB }, now })).json();
    assert.equal(body.today, "Skipped: 34 good leads waiting");
    assert.equal(body.upcoming, "Warrington");
  });
  test("PUT validates and keeps the place in the list", async () => {
    const bad = await onRequestPut({ env: { DB }, request: jsonRequest({ trade: "landscaper", towns: "", max: 60 }) });
    assert.equal(bad.status, 400); assert.equal((await bad.json()).error, "Add at least one town (one per line)");
  });
  ```
- [ ] **Step 2: Run to verify they fail** — `node --test control-room/tests/territory-api.test.mjs` → FAIL (module not found).
- [ ] **Step 3: Implement** — thin route over the Task 9–10 functions; no logic of its own.
- [ ] **Step 4: Run tests** — `node --test control-room/tests/*.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add -A control-room/functions/api control-room/tests/territory-api.test.mjs && git commit -m "API: /api/territory with today's decision; /api/autopilot removed" -m "$TRAILER"`

### Task 15: Lead Scraper page: Automatic search card

**Files:** Modify `control-room/public/js/scraper.js`, `CLAUDE.md` (the "Daily autopilot" sentence → "Daily search: every morning from 6am, if fewer than 30 good leads are waiting, searches the next town on your list; new leads go to Claude's research queue.", pointing at `_lib/find.js` and tick step `daily_find`). (The Roadmap page was deleted in stage 0, so there is nothing to update there.)

**Interfaces:** Consumes `GET/PUT /api/territory` (Task 14). Keeps `export runRow` (used by `home.js`); `isStuck` and `STUCK_MINUTES` removed; `inProgress(j)` = `queued`/`running`.

- [ ] **Step 1: Write the check** — list in the task notes what `npx wrangler pages dev` must show: the card with badge On, "**Today:** Decided after 6am" on an empty DB, the rule line with "Next town: Warrington", Edit → modal with the four labels, saving an empty town list shows "Add at least one town (one per line)", a `failed` run shows its error text.
- [ ] **Step 2: Run it to see it fail** — `npx wrangler pages dev` in `control-room/` → the card still says "Autopilot" and calls `/api/autopilot` (404).
- [ ] **Step 3: Implement `automaticCard()` in `scraper.js`** — rename `autopilotCard`, call `/api/territory`, render with `esc()` the exact Part A copy; drop the client "Stuck" badge and text.
- [ ] **Step 4: Verify** — `for f in control-room/public/js/*.js; do node --check "$f"; done` clean; the Step 1 list passes in `wrangler pages dev`; `node --test control-room/tests/*.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/public/js CLAUDE.md && git commit -m "Lead Scraper: Automatic search card with today's decision" -m "$TRAILER"`

### Task 16: Real-data acceptance run

**Files:** Test `lead-manager/tests/test_leads.py` (only if a false claim is found); notes in the pull request description.

**Interfaces:** None.

- [ ] **Step 1: Run one town** — after deploy, press Find leads for `landscaper` in `Northwich` (60); wait for Done; check `api_usage` has rows for the job (Perfect when 4).
- [ ] **Step 2: Sample** — run the Perfect-when 5 SQL (Cloudflare → D1 → goldbarwebsites → Console, or `npx wrangler d1 execute goldbarwebsites --remote --command "…"`), open each of the 10 leads' websites and Google listings, and record per lead: every issue true (y/n), chain/front desk (y/n), owner rule held (y/n). Then check every excluded lead's reason (Perfect when 6).
- [ ] **Step 3: For each failure, write the failing regression test** with the real HTML (trimmed) or listing as the fixture, named after the business type, e.g. `test_<what>_real_data_<town>`; run `cd lead-manager && python -m pytest -q -k real_data` → FAIL.
- [ ] **Step 4: Fix, run all tests** → PASS; redeploy, take a fresh sample of 10 until 10/10.
- [ ] **Step 5: Commit** — `git add lead-manager && git commit -m "Fix false alarms found in the Northwich acceptance run" -m "$TRAILER"`; then verify Perfect when 7–10 on the live deploy over the next three mornings.

## Cross-stage interfaces

- **Needs from stage 0:** tables `research`, `prospects`, `todos`, `heartbeats`, `routine_fires` in `schema.sql`;
  `_lib/settings.js`, `_lib/todo.js` (`addTodo`, `closeTodos`), `_lib/routines.js` (`fireRoutine`, `beat`),
  `_lib/ukTime.js`, `_lib/tick.js` `STEPS`; `tests/helpers/fakeD1.mjs` exporting `fakeD1()` → a synchronous-to-create
  D1-compatible object with the full schema, supporting `prepare/bind/first/all/run` (with `meta.changes`) and `batch`.
  `_lib/health.js` `registerLight(fn)` and `healthFromDb(DB, env, now) → {lights, gaps}`, lights shaped
  `{name, level: "green"|"amber"|"red"|"grey", detail, fix}`; tick slots `pick` (stage 3) before `daily_find` and
  `calls` after `stale_jobs` (overview §8); `runTick`'s `ctx.budget`.
- **Produces for the health step:** the `lead_search` light (Task 12, registered; heartbeat `find`; red if `ok = 0`
  or older than 26 h, grey before the first beat). Its todo dedupe is `health:lead_search`, which is no prefix of
  this stage's `health:find:*` todos.
- **Produces for stage 2 (research):** `research` rows `status 'queued'` with `queued_at` for every handed-to-research
  lead; `fireRoutine(DB, "research", "research queued: {n} leads")` payload (this text is the agreed one). Stage 2
  must mark `skipped` the queued rows whose lead is now excluded or matches `leadSuppressed`, must drop
  `maps_*`/`reviews_behind` findings and pass `map_rank: null` when `audit.map_rank.home === false` or
  `audit.map_rank.scan_town` isn't the lead's town (older rows). `audit.ai_needs` stays as a hint list only. Stage 2
  stores "too big" only in `research.too_big`; this stage has no "too big" exclusion, and `research.carry_over` stays
  for maps carry-over only.
- **Produces for stages 2, 3, 6 and the Todo board:** `leadSuppressed(lead, suppressionRows)` (pure, `_lib/find.js`);
  `pipelineCounts(DB)` (`goodWaiting` is the shortlist's "A+/A/B not emailed" count); `health` todo dedupe prefixes
  `health:stale:`, `health:find:` (no light covers them, so the Todo board shows them).
- **Produces for Map Rank:** stale scans are failed with `STALE_SCAN_ERROR`; care scans (`source = 'care'`) are left to
  stage 11.
- **Settings keys introduced:** `find:day`, `find:today`, `research:enqueued_at` (`territory` kept).
- **Python:** `qualify.mark_exclusions(leads, known=())` returns chain place_ids; `store.D1.known_leads()`,
  `store.D1.exclude_chains(ids)`; `audit.town_key(name)`; `lead.map_rank["home"]`.

## Questions for Nik

- **Q-Q. When the 18 towns are used up** (each searched in the last 30 days), do you want the next ring of towns
  (e.g. Liverpool suburbs, Lymm, Culcheth, Manchester suburbs) or a second trade (roofers)? Default: pause plus "Add
  more towns" todo (searching pauses and the todo "Add more towns to your automatic search" appears; you add towns or
  change the trade on the Lead Scraper page).
