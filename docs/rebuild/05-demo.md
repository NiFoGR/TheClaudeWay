# Stage 4: Demo site

> **Plain English:** Before you email anyone, the system builds them their own website preview at
> `aetoswebsites.com/d/<their-name-xxxxxx>`. It uses their logo, their colour, their photos, their best Google reviews
> and a few lines Claude wrote about them during research, so it feels like *their* site from the first second. It
> costs nothing to make (no Claude time), and the site we build for them after they pay comes from the same template,
> so what they buy looks like what they saw. You approve each template's look once, on the Demo page, before any email
> can link to it. When someone opens their preview twice (or once today) and hasn't replied, Todo tells you to call them.

## Goal

Every lead graded A+, A or B that has an email gets a working, true, fast demo site and a `prospects` row in stage
`ready` before Nik writes the first email. The first email (stage 5) can only go out when the lead's demo is live and
its template look is approved.

## Trigger

- **Main:** stage 2's research route (`POST /api/agent/research/:place_id`, `api/agent/research/[id].js`) calls
  `ensureDemo(DB, place_id, now)` right after `saveResearch`. This stage wires that call (Task 8).
- **Safety net:** the tick step `hot` (every 5 minutes) makes up to 3 missing demos per run for eligible leads (covers
  the leads graded before this stage shipped, a failed call in stage 2, and expired demos of leads not yet emailed).
- **Views:** the prospect's browser calls the beacon `POST /d/<slug>/e` after 4 seconds on the page.

## Who does what

| Who | Does |
| --- | --- |
| System | Builds the demo data from the lead + research, renders the page on every request (nothing stored but the slug), counts views, adds `hot` todos, extends expiry, makes missing demos. |
| Claude | Nothing at build time. Its research (stage 2) already wrote `research.copy` {headline, intro, services[], areas[], about}. |
| Nik | Approves each template look once (Demo page), opens a lead's demo before writing the first email if he wants, calls hot leads. |

## Rules

### 1. Which leads get a demo

`ensureDemo` makes a demo only when **all** of these hold, else it returns `{ok: false, reason}` with the exact reason:

| Check | Reason when it fails |
| --- | --- |
| Lead exists in `leads` | `Lead not found` |
| `leads.excluded = 0` | `Excluded: <exclude_reason>` |
| `research.status = 'done'` | `Not researched yet` |
| `research.too_big = 0` | `Too big for us` |
| `research.grade` in A+, A, B | `Grade <C or D>: only A+, A and B get a demo` |
| `research.best_email` not empty | `No email found` |
| Email and its domain not in `suppression` | `On the do-not-contact list` |

On success it:
1. Reuses the lead's latest demo if it hasn't expired; otherwise inserts a new `demos` row with `slugFor(name)`
   (e.g. `green-leaf-landscapes-7k2p9q`), `created_at = now`, `expires_at = now + 180 days`.
2. Inserts the `prospects` row if none exists, through stage 0's
   `applyStageEvent(DB, place_id, "demo_ready", now, {email, greet_name})` (stage `ready`): `email` =
   `research.best_email` lower-cased, `greet_name` = `research.owner.first` only when `research.owner.confident` is
   true (else NULL).
3. If a `prospects` row already exists in stage `ready`, updates `email` and `greet_name` from the newest research
   (re-research found a better address; one UPDATE `WHERE stage = 'ready'`, no stage change). Any later stage is
   never touched.
4. If the lead's template look isn't approved, adds the `setup` todo "Approve the <Label> look on the Demo page"
   (dedupe `setup:demo-template:<id>:v<version>`).

### 2. Link and expiry

- Link: `https://aetoswebsites.com/d/<slug>` (our own domain, the only link in the first email). Slug: up to 40
  characters from the business name + `-` + 6 random characters from `abcdefghjkmnpqrstuvwxyz23456789`.
- Expires 180 days after creation, **extended to 180 days after the latest message we sent them**
  (`messages.direction = 'out'`, `status = 'sent'`). The `hot` tick step syncs this every 5 minutes.
- A prospect in stage `won` never sees the expired page.
- Expired → HTTP 410 page: heading "This preview has ended", text "The website we made for <name> is no longer on
  show. Reply to our email and we'll switch it back on.", plus "or email <mailbox address>" when their thread has a
  mailbox, and "Aetos Websites" at the bottom. Unknown slug → HTTP 404 "This page doesn't exist." (never says whose).
- When a lead's demo expires before any email was sent, the safety net makes a new one (new slug).

### 3. What's on the page (demo mode)

One long page, top to bottom:

1. **Preview bar** (Aetos look: Charcoal `#1A1C20`, white text, gold `#C9A13B` button with Charcoal text, sticky):
   "Preview made for **<name>** by Aetos Websites · Visits to this page are counted" and the button
   **"Order this site"** → `/d/<slug>/order` (stage 9's order page).
2. **Header:** their logo (or their name as a wordmark), their phone as a tap-to-call link.
3. **Hero:** `copy.headline`; `copy.intro` under it; rating badge "<4.8> ★ from <37> Google reviews" (only when both
   are known and review_count > 0); buttons **"Call <phone>"** (`tel:`) and **"Ask for a quote"** (jumps to the form).
   With photos: their first photo beside/below the text. Without photos: a photo-free panel in their colour with a CSS
   pattern and the template's line icon.
4. **Services:** "What we do": one card per `copy.services` item (max 8).
5. **Recent work** (only with 2+ photos): photos 2–6.
6. **Areas:** "Areas we cover": `copy.areas` as chips (max 12). Hidden when empty.
7. **Reviews:** "What customers say" / "Reviews from Google": up to 3 cards (stars, text, "Sarah K.").
8. **Guarantee strip** (demo mode only, Aetos look, addressed to the owner): label "For <name>, from Aetos Websites",
   **"Top 3 in Google search results in 90 days. GUARANTEED."**, then "The guarantee: we will work for FREE if you
   aren't in the top 3 of Google results within 90 days.", then the offer line, then the "Order this site" button.
   Both guarantee lines are `GUARANTEE.headline` and `GUARANTEE.section` from `_lib/offer.js`.
   Offer line: weekdays "First 60 days of the monthly plan free. No contract."; Sat–Sun UK "Weekend deal: first 90
   days of the monthly plan free. No contract." (from `offerFor(now)` in `offer.js`; no prices on the demo, they're
   on the order page).
9. **About:** "About <name>": `copy.about`. Hidden when empty.
10. **Contact:** heading "Ask for a quote"; name, phone, message fields and a button inside a **disabled** fieldset;
    note above it: "Preview only: on your live site, this form sends enquiries straight to your phone and inbox."
11. **Footer:** "© <year> <name> · <town>" and, in demo mode, "Preview by Aetos Websites" plus the link
    "How we use your information" → `https://aetoswebsites.com/privacy` (the privacy notice at first contact, Q-N).
12. **Mobile call bar:** fixed at the bottom under 900 px wide when a phone exists: "Call <name>".

Order of sections per template: landscaper puts **Recent work** straight after the hero (landscaping sells on photos);
generic follows the list above.

### 4. Truth rules (everything shown must come from their data)

- **Name:** `shortName(leads.name)` (drops " Ltd", " Limited", " LLP", " PLC", text after " - " / " | "; title-cases
  ALL CAPS). **Town:** `leads.town`, else `leads.search_town`. The street address is never shown (sole traders often
  work from home).
- **Phone:** `leads.phone` as Google gives it; tap-to-call only when it has 10–13 digits (leading `+` kept).
- **Services:** only `research.copy.services`. None → one dashed card "Your services will go here" with the label
  "Preview placeholder: we'll fill this in with you". Never a trade's default list.
- **Headline:** `copy.headline`; missing → "<Trade> in <Town>" (e.g. "Landscaping in Warrington"), or just the name
  when there's no town. **Intro / about:** `copy.intro` / `copy.about`; missing → left out.
- **Reviews:** only Google reviews from `leads.audit.reviews` with a numeric rating ≥ 4 and text of 8+ words; top 3 by
  length; author shortened to first name + initial ("Sarah K."), "Google reviewer" when the name is missing.
- **Rating/count:** `leads.rating` (1 decimal) and `leads.review_count`; shown only when both are > 0.
- **Photos:** only `leads.audit.brand.photos`, only `https://` URLs (http would be blocked on our https page), max 6,
  the logo removed from the list. No photos → photo-free layout. **Never stock photos, never someone else's.**
- **No invented numbers or claims:** the template's own wording never says "free quote", "fully insured", "years of
  experience", "24/7", "family run", "award", "No.1" or "best". Every number on the page appears in their data, the
  guarantee (3, 90), the offer line (60/90) or the © year. A test enforces this.
- **Clipping:** headline 90 characters, intro 300, about 700, each service 60, each area 40, review text 320
  (cut at a word, "…" added).

### 5. Their look

- **Colour:** `leads.audit.brand.colour` if it gives white text a contrast of at least **4.5:1** (WCAG). If not,
  darkened in steps of 10% (same hue) up to 50% until it passes. If it still fails: Charcoal `#1A1C20`. No colour
  found: landscaper `#2f6b3a`, generic `#1A1C20`. The colour is only used where white text sits on it (buttons, hero
  panel, footer) and for thin accent lines.
- **Logo:** `brand.logo` when it's `https://`; shown max 52 px high; if it fails to load, the name wordmark appears.
- Only system fonts (no web fonts) so nothing blocks the first paint.

### 6. Page rules

- Mobile-first, one HTML response, all CSS inline, no JS framework. The only script is the view beacon (demo mode).
- Under **100 KB** of HTML for the biggest lead (target < 40 KB).
- Every `<img>` has alt text ("<name> logo", "Work by <name>"), `width`/`height`, and `loading="lazy"` except the logo
  and the hero photo (`fetchpriority="high"`). Broken images hide themselves.
- `<meta name="robots" content="noindex,nofollow">` and the `X-Robots-Tag` header in demo mode; `referrer` no-referrer
  (their image hosts don't see where the page is).
- Headers: `content-security-policy: default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src
  'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`, plus the existing
  `page()` headers (no-store, DENY framing).
- Everything from the lead, research and reviews goes through `h()`; URLs through `safeHttps()`; colours must match
  `^#[0-9a-f]{6}$` before they reach CSS; no scraped value is ever put inside a CSS `url()`, a `<script>` or an event
  handler.

### 7. Template approval gate (decision D-5)

- Templates: `landscaper` (trades matching `landscap|garden|lawn|turf|paving|patio|fenc`) and `generic` (every other
  trade). Each has a `version` number; any change to how it looks bumps it.
- Setting `demo:template:<id>:approved` = `{"version": <n>, "at": "<ISO>"}`. A look is approved only when the stored
  version equals the current one, so a redesign needs a fresh OK.
- Until approved, the Demo page shows that template rendered for **3 real graded leads** (one with 2+ photos, one
  with none, one with the least data, filling up by best grade) and an **"Approve this look"** button.
- `demoReady(DB, place_id)` is what stage 5/6 calls before sending a first email; it returns `{ok: false, reason}`
  with one of: `No demo yet: <ensureDemo reason>`, `Their demo has expired: a new one is being made`,
  `Waiting for you to approve the <Label> look on the Demo page`. When `ok`, it also gives `url` and `slug`.

### 8. Counting views

- The page's script waits **4 seconds** with the tab visible, skips browsers that report `navigator.webdriver`, then
  sends `{kind: "view"}` to `/d/<slug>/e`. Clicks on "Order this site" send `order_page`.
- The server ignores (204, nothing stored) when: the body isn't one of `view`, `order_page`, `order_click`; the
  user-agent looks like a bot or link scanner (list in Task 11) or is empty; the request carries Nik's valid login
  cookie; the demo has expired; or the prospect is still in stage `ready` (no email sent yet, so it can only be Nik or
  a leak).
- Views are de-duplicated per demo: one per **30 minutes**.
- A counted view inserts `demo_events (kind 'view')`, adds 1 to `prospects.views`, sets `last_view_at`, and calls
  stage 0's `applyStageEvent(DB, place_id, "demo_view", now)` (emailed → viewed).

### 9. Hot leads (tick step `hot`, position 5)

- Hot = stage `emailed` or `viewed`, `last_inbound_at` is NULL, and (`views ≥ 2` or `last_view_at` within the last
  24 hours). There is one `isHot(prospect, now)` for the whole app, in stage 3's `_lib/shortlist.js`, with this rule;
  this stage imports it.
- For each hot prospect (max 3 per run, most recent view first) a `hot` todo: title
  "Call now: <name> opened their site <N> times" ("once" when N = 1), detail
  "Last opened <Tue 14:05>. Phone: <phone>. No reply yet." ("No phone number on file." when missing), link
  `/#/lead/<place_id>`, `due_at` now, dedupe `hot:<place_id>:<UK date>`. One per lead per UK day; the title is
  updated as N grows; yesterday's open one is closed when today's is added.
- Closed automatically (status `done`) as soon as the prospect has `last_inbound_at` or leaves `emailed`/`viewed`.
  Only todos whose dedupe starts `hot:<place_id>:` are closed this way (stage 9's payment-page todos use
  `checkout:<place_id>` and are never touched).

### 10. Live mode (used by stage 10)

`renderSite(data, {mode: "live"})` renders the same template with: no preview bar, no guarantee strip, no beacon, no
noindex, no "Preview by Aetos" line, the form enabled and posting to `data.live.form_action` (form hidden when that's
empty), and `<link rel="canonical">` to `data.live.canonical_url`. Stage 10 adds more pages; demo mode always renders
the home page.

## Edge cases

| Case | What happens |
| --- | --- |
| No photos, no logo, no services, no reviews, no rating | Photo-free hero, name wordmark, services placeholder card, reviews/areas/about hidden. Still passes all checks. |
| Their only photos are `http://` | Dropped; photo-free layout. |
| Brand colour too pale (e.g. `#a0ffff`) | Darkening can't reach 4.5:1 → Charcoal. |
| Hostile text (`</style><script>…`, `"><img onerror=…>`, bidi override characters) in name/reviews/copy | Escaped by `h()`; control and bidi characters removed. Tested. |
| Logo or photo host blocks hot-linking / 404 | The image removes itself; wordmark shows instead of the logo. |
| Research re-posted with a different best email while stage is `ready` | `prospects.email`/`greet_name` updated; demo kept. |
| Re-graded to C after the demo exists | Demo stays (link may already be out); stage 3 hides it from picks. |
| Two calls make a demo at once | Slug primary key prevents duplicates of the same slug; the latest live demo is the one used. Slug clash → one retry with a new slug. |
| Prospect opts out or is lost | Page keeps working until expiry; no hot todos (stage not emailed/viewed). |
| Prospect won | Page never shows "ended". |
| Nik opens his own demo logged in, or before the first email | Not counted. |
| Email security scanners (Safe Links, Mimecast…) open the link | Bot user-agents and `navigator.webdriver` aren't counted; a scanner that runs a full browser for 4 s may still count, which is why one view only makes a lead hot for 24 hours. |
| Weekend | Offer line switches to the 90-day weekend deal at UK midnight Saturday, back on Monday. |

## What Nik sees in the Control Room

**Demo page** (route `#/demo`, no nav item: reached from the "Approve the … look" todo and the lead drawer's
"Demo page" link):
- **Looks** card per template ("Landscaper look", "Everything else look"):
  - Not approved: badge "Needs your OK", text "<N> leads are waiting for this look before their first email can go."
    Three phone-sized previews (390 px wide, scrollable, each titled with the lead's name and town, sandboxed so
    nothing in them runs), any quality-check problems listed in red under each, then **"Approve this look"**.
  - Approved: badge "Approved <21 Oct>", "Leads can get their first email.", and "Look again" to show the previews.
  - Changed since approval: badge "Changed: look again", "This look changed since you approved version <n>."
  - No graded lead yet: "No graded leads for this look yet. Previews appear once research grades one."
- **Demo sites** table: Business (with grade), Stage, Views, Last viewed, Ends, and "Open" / "Copy link". Sorted by
  last viewed, then newest. Empty: "No demo sites yet. One is made automatically when Claude grades a lead A+, A or
  B and finds an email."

**Lead drawer:** a "Demo site" card, mounted into stage 3's empty `<div id="d-demo"></div>`. It owns the demo facts:
stage 3's "Demo site" section keeps only its heading, the **Preview** toggle and the slot (Task 14), so the link,
views and expiry show once, and a lead that won't get a demo never reads "made automatically":
- Ready: link text `aetoswebsites.com/d/<slug>`, badge "Viewed 3× · last Tue 14:05" or "Not viewed yet",
  "Ends 17 Apr 2027", buttons **"Open demo"** (new tab) and **"Copy link"** (copies the full
  `https://aetoswebsites.com/d/<slug>`). "Open demo" here and on the Demo page links to the relative `/d/<slug>` on
  the Control Room host, so Nik's login cookie is sent and his own views never count.
- Not ready: "No demo: <reason>" (e.g. "No demo: Grade C: only A+, A and B get a demo").
- Waiting for approval: "Demo made · waiting for you to approve the Landscaper look" with a link to the Demo page.

**Errors in plain English:**
- Approve after the look changed: "This look changed since you opened the page. Refresh and check it again before
  approving."
- Approve with nothing to preview: "There's no graded lead to preview this look with yet. Approve it once research
  grades one."
- Preview of a lead that's gone: "That lead isn't in the database any more."

## Todos added

| kind | Title | Dedupe | Closed when |
| --- | --- | --- | --- |
| `setup` | "Approve the Landscaper look on the Demo page" | `setup:demo-template:<id>:v<version>` | Nik approves that version |
| `hot` | "Call now: Green Leaf Landscapes opened their site 3 times" | `hot:<place_id>:<UK date>` | They reply, leave emailed/viewed, a newer day's item replaces it, or Nik ticks it |

## Health lights

No new light. The `hot` tick step's result (or its error) is part of the tick's heartbeat detail, so a broken step
shows on the existing "tick" light (stage 0).

## Perfect when

1. `node --test control-room/tests/demo-*.test.mjs` and `cd lead-manager && python -m pytest -q` pass; all JS passes
   `node --check`.
2. **XSS:** the 12 hostile inputs in `tests/fixtures/demo-fixtures.mjs` (`NASTY`) placed in every text field, URL
   and colour produce no unescaped `<script`, `onerror=`, `javascript:` or `</style>` in the HTML (test in Task 6).
3. **Quality checks:** `checkDemoHtml` returns `[]` for all 10 fixture leads in both templates (size < 100 KB,
   noindex, alt text, lazy images, no outside scripts/styles, every number traceable, no banned claims, bar + disabled
   form present).
4. **Truth:** with research copy empty, the page shows the services placeholder and no default services (test).
5. **Look locked:** changing a template's output without bumping its `version` fails the hash test (Task 7).
6. **Live, 10 real leads:** `GET /api/demo/check?limit=10` (logged in) returns 10 rows, each `problems: []` and
   `bytes < 100000`. Then open 3 of them (one with photos, one without, one generic) on a phone or Chrome DevTools
   iPhone 12 (390 px): no sideways scrolling, call button dials, form is visibly disabled.
7. **Live, speed:** PageSpeed Insights (mobile, simulated 4G) on those 3 demos: Performance ≥ 90 and LCP < 2.0 s;
   Accessibility ≥ 95.
8. **Live, every eligible lead has a demo** within 2 hours of deploy: this query returns 0 rows:
   `SELECT r.place_id FROM research r JOIN leads l USING (place_id) WHERE r.status='done' AND r.grade IN ('A+','A','B')
   AND r.too_big=0 AND COALESCE(r.best_email,'')<>'' AND l.excluded=0 AND (NOT EXISTS (SELECT 1 FROM demos d WHERE
   d.place_id=r.place_id AND d.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')) OR NOT EXISTS (SELECT 1 FROM
   prospects p WHERE p.place_id=r.place_id))` (minus suppressed addresses).
9. **Live, views:** on a test prospect set to `emailed`: a private window (not logged in) open for 5 s → `views` = 1;
   reload within 30 min → still 1; open while logged in → still 1; `curl -X POST -A "Googlebot" -d '{"kind":"view"}'
   https://aetoswebsites.com/d/<slug>/e` → still 1.
10. **Live, hot:** a second counted view 31+ minutes later → a `hot` todo "Call now: … opened their site 2 times"
    within 5 minutes; setting `last_inbound_at` on the test prospect closes it within 5 minutes.
11. **Live, gate:** before approving the landscaper look, `demoReady` for a landscaper prospect returns
    `Waiting for you to approve the Landscaper look on the Demo page`; after pressing "Approve this look", `ok: true`
    and the `setup` todo is closed.
12. **Live, expiry:** setting a test demo's `expires_at` to yesterday shows the 410 "This preview has ended" page.

---

# Demo Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every A+/A/B lead with an email gets a true, fast, branded demo site and a `ready` prospect before its first
email, with template approval, view counting and hot-lead todos.

**Architecture:** A pure template engine in `control-room/functions/_lib/demo/` turns `DemoData` (built from `leads`,
`research` and `offer.js`) into one HTML string per request; nothing but the slug is stored. `_lib/demo-db.js` owns the
D1 side (demos, prospects, approval, readiness, view counting); the `hot` tick step keeps expiry in sync, makes missing
demos and raises hot todos. The Control Room gets a Demo page and a demo card in the lead drawer.

**Tech Stack:** Cloudflare Pages Functions (plain JS ES modules, no deps), D1, `node --test` with
`tests/helpers/fakeD1.mjs`, Python 3 + pytest for `brand.py`.

**Spec:** Part A of this file + [00-overview.md](00-overview.md).

## Global Constraints

- Overview §9 rules apply: truth, escaping with `h()`, copy rules, exact guarantee wording, prices only from
  `_lib/offer.js`, UTC storage + UK rules via `ukTime.js`, plain-English errors, tests before push.
- No AI calls at demo build or render time; cost per demo £0.
- Demo lifetime `DEMO_DAYS = 180`; view dedupe 30 minutes; beacon delay 4000 ms; hot = views ≥ 2 or a view within 24 h.
- Demo link base `DEMO_BASE = "https://aetoswebsites.com"`.
- Contrast minimum 4.5:1 against `#ffffff`; fallback `CHARCOAL = "#1a1c20"`; landscaper default `#2f6b3a`.
- HTML < 100,000 bytes; max 6 photos, 8 services, 12 areas, 3 reviews.
- The `hot` tick step runs every 5 minutes and issues at most 25 D1 statements per run (free plan: 50 per invocation,
  shared with every tick step). Stage 0's `runTick` gives each step `ctx.budget`, an object: `ctx.budget.left()` is
  the queries this step may still make. When `ctx.budget.left()` is below 25, `hotStep` skips the missing-demo part
  (the only optional part) and says so in its summary. Tests pass `budget: {left: () => N}`, never a number.
- Every prospect stage change goes through stage 0's `applyStageEvent` (`_lib/prospects.js`), never a direct
  `nextStage` write.
- All times written by this stage use `now()` format `YYYY-MM-DDTHH:MM:SSZ` so string comparison works.
- Commit trailer (append to every commit): `TRAILER=$'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_017h4iwgwaGCvQ5f9mmF4rDY'`,
  used as `git commit -m "<message>" -m "$TRAILER"`.

## Review Focus

1. **Hostile scraped text** (names, reviews, copy, URLs, colours with HTML/CSS/JS, bidi override characters) —
   covered by the `NASTY` matrix test in Task 6 and `h()`/`safeHttps()` tests in Task 2.
2. **Thin data leads** (no photos, logo, services, reviews, rating, phone or town) rendering broken or padding with
   invented filler — Task 6 test "bare lead renders placeholder and hides empty sections" and the numbers/claims check
   in Task 5.
3. **Fake views** from link scanners, previews and Nik himself making leads look hot — Task 11 tests for bot UAs,
   empty UA, owner cookie, stage `ready`, expired demo, 30-minute dedupe.
4. **A changed template going out unapproved** — Task 7 hash-lock test and Task 9 test "approval of version 1 doesn't
   approve version 2".
5. **Tick budget blow-up** when many leads need demos or are hot at once — Task 12 test "50 eligible + 20 hot leads
   use at most 25 statements in one run".

---

### Task 1: Reviews on the demo are only real, rated Google reviews

**Files:** Modify `lead-manager/aetos_leads/brand.py`; Test `lead-manager/tests/test_owner.py`.

**Interfaces:** Produces `brand.top_reviews(reviews, n=3) -> list[{"author", "text", "rating"}]` where `rating` is
the review's own number (never defaulted).

- [ ] **Step 1: Write the failing test** — `test_top_reviews_need_a_real_rating`:
  ```python
  rs = [{"author": "Sarah Kent", "rating": None, "text": "one two three four five six seven eight nine"},
        {"author": "Tom Hill", "rating": 3, "text": "one two three four five six seven eight nine"},
        {"author": "Amy Lee", "rating": 5, "text": "Great patio, tidy team, finished early and on budget too"}]
  top = brand.top_reviews(rs)
  assert [r["author"] for r in top] == ["Amy L."]
  assert top[0]["rating"] == 5
  ```
- [ ] **Step 2: Run it to verify it fails** — `cd lead-manager && python -m pytest -q tests/test_owner.py -k real_rating`
  → FAIL (the unrated review is kept with rating 5).
- [ ] **Step 3: Implement `top_reviews` in `lead-manager/aetos_leads/brand.py`** — keep a review only when
  `isinstance(r.get("rating"), (int, float)) and r["rating"] >= 4`; output `rating` as given.
- [ ] **Step 4: Run tests to verify they pass** — `cd lead-manager && python -m pytest -q` → all PASS.
- [ ] **Step 5: Commit** — `git add lead-manager/aetos_leads/brand.py lead-manager/tests/test_owner.py && git commit -m "Demo reviews: only real rated Google reviews" -m "$TRAILER"`

### Task 2: Safe text helpers

**Files:** Create `control-room/functions/_lib/demo/text.js`; Modify `control-room/functions/_lib/demo.js`
(re-export `shortName`, `slugFor` from the new file; stage 9 deletes the old file); Test
`control-room/tests/demo-text.test.mjs`.

**Interfaces:** Produces (pure):
`h(v) → string` · `cleanText(v, max) → string` · `safeHttps(u) → string` · `telHref(phone) → string` ·
`shortName(name) → string` · `shortAuthor(author) → string` · `slugFor(name, rand = Math.random) → string`.

- [ ] **Step 1: Write the failing test** — `demo-text.test.mjs`:
  ```js
  assert.equal(h(`<a href="x">'&\``), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#96;");
  assert.equal(h("Smith‮ gnifooR\u0007"), "Smith gnifooR");          // bidi + control chars removed
  assert.equal(h(null), "");
  assert.equal(cleanText("  a   b\n c ", 100), "a b c");
  assert.equal(cleanText("one two three four", 9), "one two…");
  assert.equal(safeHttps("https://ex.co.uk/a.jpg"), "https://ex.co.uk/a.jpg");
  for (const bad of ["http://ex.co.uk/a.jpg", "javascript:alert(1)", 'https://x.co/a.jpg" onerror="x', "https://x.co/a(1).jpg", "//x.co/a.jpg", "https://x.co/" + "a".repeat(2050)])
    assert.equal(safeHttps(bad), "");
  assert.equal(telHref("07969 770905"), "07969770905");
  assert.equal(telHref("+44 7969 770905"), "+447969770905");
  assert.equal(telHref("<b>0800</b>"), "");
  assert.equal(shortName("DIAMOND KICKBOXING ACADEMY LTD"), "Diamond Kickboxing Academy");
  assert.equal(shortName("Green Leaf Landscapes - Garden Design | Leeds"), "Green Leaf Landscapes");
  assert.equal(shortAuthor("Sarah Jane Kent"), "Sarah K.");
  assert.equal(shortAuthor(""), "Google reviewer");
  assert.match(slugFor("Smith & Sons Roofing Ltd"), /^smith-and-sons-roofing-[a-hj-km-np-z2-9]{6}$/);
  ```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-text.test.mjs` → FAIL (module not
  found).
- [ ] **Step 3: Implement the helpers in `control-room/functions/_lib/demo/text.js`** — `h()` first strips
  `[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]` then escapes `& < > " ' \``;
  `safeHttps` accepts only `^https:\/\/[^\s"'<>()\\]+$` up to 2048 chars; `telHref` keeps a leading `+` and digits,
  valid at 10–13 digits; `shortName` and `slugFor` move here unchanged from `_lib/demo.js`.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/demo-text.test.mjs control-room/tests/demo.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/demo/text.js control-room/functions/_lib/demo.js control-room/tests/demo-text.test.mjs && git commit -m "Demo: safe text helpers" -m "$TRAILER"`

### Task 3: Brand colour with a contrast check

**Files:** Create `control-room/functions/_lib/demo/colour.js`; Test `control-room/tests/demo-colour.test.mjs`.

**Interfaces:** Produces (pure): `CHARCOAL = "#1a1c20"`, `MIN_CONTRAST = 4.5`,
`TRADE_DEFAULT = {landscaper: "#2f6b3a", generic: "#1a1c20"}`, `contrastRatio(hexA, hexB) → number`,
`pickColour(theirs, templateId) → {colour, source: "theirs"|"darkened"|"trade"|"charcoal"}`.

- [ ] **Step 1: Write the failing test**:
  ```js
  assert.equal(contrastRatio("#1a1c20", "#ffffff").toFixed(1), "17.1");
  assert.deepEqual(pickColour("#2E7D32", "landscaper"), { colour: "#2e7d32", source: "theirs" });
  const g = pickColour("#4caf50", "generic");
  assert.equal(g.source, "darkened");
  assert.ok(contrastRatio(g.colour, "#ffffff") >= 4.5);
  assert.deepEqual(pickColour("#a0ffff", "landscaper"), { colour: "#1a1c20", source: "charcoal" });
  assert.deepEqual(pickColour("", "landscaper"), { colour: "#2f6b3a", source: "trade" });
  assert.deepEqual(pickColour("red;}body{display:none", "generic"), { colour: "#1a1c20", source: "trade" });
  ```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-colour.test.mjs` → FAIL.
- [ ] **Step 3: Implement `contrastRatio` and `pickColour` in `control-room/functions/_lib/demo/colour.js`** — WCAG
  relative luminance; input must match `^#[0-9a-f]{6}$`i (lower-cased) or it counts as "no colour"; darken by
  multiplying each channel by 0.9, 0.8 … 0.5 and take the first that passes.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/demo/colour.js control-room/tests/demo-colour.test.mjs && git commit -m "Demo: brand colour with contrast fallback" -m "$TRAILER"`

### Task 4: DemoData from a lead and its research

**Files:** Create `control-room/functions/_lib/demo/data.js`, `control-room/tests/fixtures/demo-fixtures.mjs`;
Test `control-room/tests/demo-data.test.mjs`.

**Interfaces:**
Consumes: Task 2 helpers, Task 3 `pickColour`, `offerFor(date)` and `GUARANTEE` (`{headline, section}`) from stage
0's `_lib/offer.js` (see Cross-stage), `isWeekendUK` from `_lib/ukTime.js`. No local guarantee constant.
Produces (pure):
```js
templateIdFor(trade) → "landscaper" | "generic"     // /landscap|garden|lawn|turf|paving|patio|fenc/i → landscaper
buildDemoData({ lead, research, demo = null, offer, now = new Date(), live = null }) → DemoData
// DemoData (exact):
{
  template: "landscaper" | "generic",
  business: { name, trade, phone, phone_href, town, areas: string[], services: string[] },
  brand: { logo: string /* "" if none */, colour: "#rrggbb", colour_source, photos: string[] /* https, ≤ 6 */ },
  reviews: [{ author, rating, text }],          // 0–3, rating ≥ 4
  rating: number | null, review_count: number | null,
  copy: { headline, intro, about },             // headline never empty; intro/about "" when missing
  guarantee: GUARANTEE,                         // imported from offer.js: { headline, section }
  offer: { weekend: boolean, free_days: 60 | 90 },   // from offerFor(now): weekend, full.freeDays
  demo: { slug, order_url: "/d/<slug>/order", count_views: boolean } | null,   // null in live mode
  live: { form_action, canonical_url } | null                                    // stage 10
}
```
`lead` is a raw `leads` row (`audit` as JSON text or object); `research` is a raw `research` row (`copy`, `owner` JSON
text) or null.

- [ ] **Step 1: Write the failing test** — fixtures file exports `LEADS` (10 made-up leads with research: 5
  landscapers — full data, no photos, http-only photos, pale colour `#a0ffff`, bare (no copy/reviews/phone/town) — and
  5 others — kickboxing gym, roofer, plumber, locksmith with an 80-character name, electrician with long reviews) and
  `NASTY` (12 strings: `<script>alert(1)</script>`, `"><img src=x onerror=alert(1)>`, `</style><script>x()</script>`,
  `javascript:alert(1)`, `' onmouseover='x`, `{{7*7}}`, `‮evil`, `red;}body{display:none`,
  `https://x.co/a.jpg" onerror="x`, `<!--`, `]]>`, `&amp;lt;`). Tests:
  ```js
  const d = buildDemoData({ lead: LEADS.full, research: LEADS.full.research, demo: { slug: "green-leaf-landscapes-7k2p9q" }, offer: { weekend: false, full: { freeDays: 60 } }, now: new Date("2026-10-21T10:00:00Z") });
  assert.equal(d.template, "landscaper");
  assert.equal(d.business.name, "Green Leaf Landscapes");
  assert.deepEqual(d.business.services, LEADS.full.research.copy.services.slice(0, 8));
  assert.equal(d.demo.order_url, "/d/green-leaf-landscapes-7k2p9q/order");
  assert.ok(d.reviews.every((r) => r.rating >= 4) && d.reviews.length <= 3);
  assert.equal(d.reviews[0].author, "Sarah K.");
  assert.equal(d.offer.free_days, 60);
  assert.equal(d.guarantee, GUARANTEE);                       // the one from ../functions/_lib/offer.js
  assert.equal(buildDemoData({ lead: LEADS.full, research: LEADS.full.research, demo: DEMO, offer: offerFor(new Date("2026-10-24T10:00:00Z")) }).offer.free_days, 90);   // Saturday
  const bare = buildDemoData({ lead: LEADS.bare, research: null, offer: { weekend: true, full: { freeDays: 90 } }, now: new Date("2026-10-24T10:00:00Z"), demo: { slug: "x-abcdef" } });
  assert.deepEqual(bare.business.services, []);
  assert.equal(bare.copy.headline, bare.business.name);     // no copy.headline and no town → the business name
  assert.equal(bare.rating, null);
  const noCopy = buildDemoData({ lead: LEADS.full, research: { ...LEADS.full.research, copy: null }, offer: OFFER, demo: DEMO });
  assert.equal(noCopy.copy.headline, "Landscaping in Warrington");   // "<Trade> in <Town>"
  assert.deepEqual(buildDemoData({ lead: LEADS.httpPhotos, research: LEADS.httpPhotos.research, offer: OFFER, demo: DEMO }).brand.photos, []);
  assert.equal(buildDemoData({ lead: { ...LEADS.full, rating: 4.8, review_count: 0 }, research: LEADS.full.research, offer: OFFER, demo: DEMO }).rating, null);
  assert.equal(templateIdFor("Kickboxing"), "generic");
  assert.equal(templateIdFor("Garden maintenance"), "landscaper");
  ```
  (`OFFER = { weekend: false, full: { freeDays: 60 } }`, `DEMO = { slug: "green-leaf-landscapes-7k2p9q" }`;
  `LEADS.full` is in Warrington.)
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-data.test.mjs` → FAIL.
- [ ] **Step 3: Implement `buildDemoData` and `templateIdFor` in `control-room/functions/_lib/demo/data.js`** — parse
  JSON safely (`parseJson` from `util.js`), apply the Part A §4 truth rules and clip lengths with `cleanText`
  (headline 90, intro 300, about 700, service 60, area 40, review 320); trade label for the headline fallback is
  title-cased `leads.trade` with "Landscaper(s)" shown as "Landscaping"; `count_views` defaults to true when `demo` is
  given.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/demo/data.js control-room/tests/fixtures/demo-fixtures.mjs control-room/tests/demo-data.test.mjs && git commit -m "Demo: DemoData built only from their real data" -m "$TRAILER"`

### Task 5: Quality checks for a rendered page

**Files:** Create `control-room/functions/_lib/demo/check.js`; Test `control-room/tests/demo-check.test.mjs`.

**Interfaces:** Produces (pure): `BANNED_CLAIMS = ["free quote", "fully insured", "years of experience", "24/7",
"family run", "award", "no.1", "best"]`, `checkDemoHtml(html, data, {mode = "demo", now = new Date()} = {}) →
string[]` (plain-English problems; `[]` = pass).

Checks, each with its exact message:
`Page is <n> KB (limit 100 KB)` · `Loads an outside script or stylesheet` · `Missing noindex` (demo) ·
`Image without alt text` · `Image below the top isn't lazy-loaded` · `Number "<n>" isn't in their data` (every digit
run in visible text must appear in `JSON.stringify(data)`, the guarantee, the offer line or the year of `now`) ·
`Says "<claim>" but their data doesn't` · `Preview bar missing` (demo) · `Quote form isn't disabled` (demo) ·
`Unescaped text: <first 30 chars>` (any `data` string containing `<`, `>` or `"` found verbatim in the HTML) ·
`Missing mobile viewport`.

- [ ] **Step 1: Write the failing test** — hand-written minimal HTML strings:
  ```js
  const data = { business: { name: "A", phone: "07969 770905" }, rating: 4.8, review_count: 37, copy: { headline: "H" } };
  const ok = `<meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><div class="ae-bar">Preview made for A</div><p>4.8 from 37 Google reviews · 07969 770905 · 90 days · top 3</p><fieldset disabled></fieldset>`;
  assert.deepEqual(checkDemoHtml(ok, data, { now: new Date("2026-10-21") }), []);
  assert.deepEqual(checkDemoHtml(ok.replace("37", "250"), data), ['Number "250" isn\'t in their data']);
  assert.ok(checkDemoHtml(ok + "<p>Free quote</p>", data).includes('Says "free quote" but their data doesn\'t'));
  assert.ok(checkDemoHtml(ok + '<script src="https://cdn.x/y.js"></script>', data).includes("Loads an outside script or stylesheet"));
  assert.ok(checkDemoHtml(ok.replace("<fieldset disabled>", "<fieldset>"), data).includes("Quote form isn't disabled"));
  assert.ok(checkDemoHtml(ok + "<p><b>x</b></p>", { ...data, copy: { headline: "<b>x</b>" } }).some((p) => p.startsWith("Unescaped text")));
  assert.ok(checkDemoHtml(ok + "x".repeat(100001), data)[0].startsWith("Page is"));
  ```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-check.test.mjs` → FAIL.
- [ ] **Step 3: Implement `checkDemoHtml` in `control-room/functions/_lib/demo/check.js`** — visible text = HTML with
  `<style>`, `<script>` and tags removed and entities decoded; regex checks only, no DOM.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/demo/check.js control-room/tests/demo-check.test.mjs && git commit -m "Demo: page quality checks" -m "$TRAILER"`

### Task 6: Template engine and the generic template

**Files:** Create `control-room/functions/_lib/demo/render.js`, `control-room/functions/_lib/demo/templates/generic.js`;
Test `control-room/tests/demo-render.test.mjs`.

**Interfaces:**
Consumes: Tasks 2–5.
Produces:
```js
// templates/<id>.js
export const TEMPLATE = { id, version, label }          // generic: { id: "generic", version: 1, label: "Everything else" }
export function home(data, mode) → { css: string, body: string }   // sections only; the shell is render.js's
// render.js
TEMPLATES = { generic, landscaper }                     // landscaper added in Task 7
renderSite(data, { mode = "demo", page = "home" } = {}) → string   // demo mode always renders home
renderExpired({ name = "", contact_email = "" } = {}) → string
renderNotFound() → string
```
The shell (render.js) owns: `<head>` (charset, viewport, title "<name> · <town>", robots/referrer metas in demo mode,
canonical in live mode, base CSS with `--main`), the preview bar, the guarantee strip (`guaranteeStrip(data)`, demo
mode only, placed by each template), the footer, the mobile call bar and the beacon script. Exact copy is Part A §3.

Beacon script (exact, demo mode with `count_views` true; slug is already validated by `^[a-z0-9-]{3,60}$`):
```js
(function(){if(navigator.webdriver)return;var u="/d/SLUG/e";function s(k){try{navigator.sendBeacon(u,JSON.stringify({kind:k}))}catch(e){}}
setTimeout(function(){if(document.visibilityState==="visible")s("view")},4000);
document.querySelectorAll("[data-ev]").forEach(function(a){a.addEventListener("click",function(){s(a.getAttribute("data-ev"))})});})();
```

- [ ] **Step 1: Write the failing test** — using `LEADS`/`NASTY` from fixtures and `buildDemoData`:
  - `every fixture lead passes checkDemoHtml in demo mode`: for each of the 10 leads, `assert.deepEqual(checkDemoHtml(renderSite(d), d, { now }), [])`.
  - `demo mode shows the preview bar, guarantee and a disabled form`: `assert.match(html, /Preview made for <b>Green Leaf Landscapes<\/b> by Aetos Websites · Visits to this page are counted/)`, `/href="\/d\/green-leaf-landscapes-7k2p9q\/order"[^>]*>Order this site/`, `/Top 3 in Google search results in 90 days\. GUARANTEED\./`, `/The guarantee: we will work for FREE if you aren&#39;t in the top 3 of Google results within 90 days\./`, `/First 60 days of the monthly plan free\. No contract\./`, `/<fieldset disabled/`, `/Preview only: on your live site, this form sends enquiries straight to your phone and inbox\./`, `/href="tel:07969770905"/`.
  - `demo footer links the privacy notice`: demo mode matches `/<a href="https:\/\/aetoswebsites\.com\/privacy"[^>]*>How we use your information<\/a>/`; live mode doesn't contain `How we use your information`.
  - `weekend offer line`: with `offer.weekend` true → `/Weekend deal: first 90 days of the monthly plan free\. No contract\./`.
  - `live mode has no Aetos bits`: `renderSite(d, { mode: "live" })` doesn't match `/Preview made|GUARANTEED|noindex|sendBeacon|Preview by Aetos/`; with `live.form_action = "https://forms.example/x"` the form is enabled and posts there.
  - `bare lead renders placeholder and hides empty sections`: matches `/Your services will go here/` and `/Preview placeholder: we&#39;ll fill this in with you/`; doesn't match `/What customers say|Areas we cover|About |Recent work|<img[^>]+Work by/`; contains the photo-free hero class `hero-plain`.
  - `nasty input never escapes`: for each `n` of `NASTY`, put it in name, trade, town, phone, every copy field, every service/area, review author/text, logo, photos and colour; render; assert `!/<script>alert|onerror=alert|onmouseover=|<\/style><script|javascript:/i.test(html)` and that `checkDemoHtml` reports no `Unescaped text` problem.
  - `images are lazy except the top ones`: every `<img` after the first two has `loading="lazy"` and every `<img` has a non-empty `alt=`.
  - `size`: the largest fixture's HTML `Buffer.byteLength < 100000`.
  - `expired and not-found pages`: `renderExpired({ name: "Green Leaf Landscapes", contact_email: "nik@aetoswebsites.com" })` matches `/This preview has ended/`, `/The website we made for Green Leaf Landscapes is no longer on show\. Reply to our email and we&#39;ll switch it back on\./`, `/mailto:nik@aetoswebsites\.com/`; `renderNotFound()` matches `/This page doesn&#39;t exist\./`.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-render.test.mjs` → FAIL.
- [ ] **Step 3: Implement `renderSite`, `renderExpired`, `renderNotFound` in `render.js` and `home` in
  `templates/generic.js`** — the guarantee strip prints `data.guarantee.headline` and `data.guarantee.section`; the
  demo-mode footer adds the "How we use your information" link to `https://aetoswebsites.com/privacy`; section order generic: hero, services, guarantee strip, reviews, areas, about, recent
  work, contact; photo-free hero = `class="hero hero-plain"` with a `repeating-linear-gradient` pattern in `--main`
  and an inline SVG icon; mobile-first CSS with one `@media (min-width: 900px)` block; logo/hero `<img>` use
  `onerror` to remove themselves.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/demo-render.test.mjs` → PASS (the
  landscaper fixtures render with `generic` until Task 7: `TEMPLATES[data.template] ?? TEMPLATES.generic`).
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/demo/render.js control-room/functions/_lib/demo/templates/generic.js control-room/tests/demo-render.test.mjs && git commit -m "Demo: template engine and generic template" -m "$TRAILER"`

### Task 7: Landscaper template (v1) and the look lock

**Files:** Create `control-room/functions/_lib/demo/templates/landscaper.js`; Modify `render.js` (`TEMPLATES`);
Test `control-room/tests/demo-render.test.mjs` (add tests).

**Interfaces:** Produces `TEMPLATE = { id: "landscaper", version: 1, label: "Landscaper" }` and `home(data, mode)`;
section order: hero (photo right on desktop, below the buttons on mobile), recent work (2–6 photos, 2-column grid on
mobile), services (cards with a leaf icon), areas, reviews, guarantee strip, about, contact.

- [ ] **Step 1: Write the failing test** — add:
  - `landscaper fixtures use the landscaper look`: `/data-template="landscaper"/` on `<body>`; with photos the
    "Recent work" heading comes before "What we do" (`html.indexOf("Recent work") < html.indexOf("What we do")`).
  - `the look is locked to its version`:
    ```js
    const fix = buildDemoData({ lead: LEADS.full, research: LEADS.full.research, demo: DEMO, offer: OFFER, now: NOW });
    const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
    const LOCK = { landscaper: { version: 1, hash: "<fill in on first green run>" }, generic: { version: 1, hash: "<fill in>" } };
    for (const id of ["landscaper", "generic"]) {
      const html = renderSite({ ...fix, template: id });
      assert.equal(TEMPLATES[id].TEMPLATE.version, LOCK[id].version, `${id} version changed: update LOCK`);
      assert.equal(sha(html), LOCK[id].hash, `The ${id} look changed: bump TEMPLATE.version so Nik re-approves it, then update LOCK`);
    }
    ```
    The generic hash is recorded too, so a shell change in `render.js` forces a version bump on both.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-render.test.mjs` → FAIL.
- [ ] **Step 3: Implement `home` in `control-room/functions/_lib/demo/templates/landscaper.js`** and register it in
  `TEMPLATES`; then paste the two hashes from the failing message into `LOCK`.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/demo-render.test.mjs` → PASS (all
  10 fixtures still pass `checkDemoHtml`).
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/demo/templates/landscaper.js control-room/functions/_lib/demo/render.js control-room/tests/demo-render.test.mjs && git commit -m "Demo: landscaper look v1, locked to its version" -m "$TRAILER"`

### Task 8: Making demos and prospects (`ensureDemo`)

**Files:** Modify (rewrite) `control-room/functions/_lib/demo-db.js`; Modify
`control-room/functions/api/agent/research/[id].js` (stage 2's route: call `ensureDemo(DB, placeId, now)` after
`saveResearch`); Modify `control-room/functions/api/outreach/enrol.js` (only if it still exists: call
`ensureDemo(DB, l.place_id)`); Test `control-room/tests/demo-db.test.mjs`, `control-room/tests/research-post.test.mjs`
(add one test); Delete the old tests for `renderDemo`/`servicesFor`/14-day expiry/"Start outreach builds their demo"
in `control-room/tests/demo.test.mjs` (keep the order-page test until stage 9).

**Interfaces:**
Consumes: `slugFor` (Task 2), `templateIdFor` (Task 4), `applyStageEvent(DB, placeId, event, now, {email, greet_name})`
(stage 0's `prospects.js`; the `{email, greet_name}` option inserts a new prospect row), `addTodo` (todo.js), `now`
(util.js).
Produces:
```js
DEMO_DAYS = 180
DEMO_BASE = "https://aetoswebsites.com"
demoLink(slug) → "https://aetoswebsites.com/d/<slug>"
ensureDemo(DB, place_id, now = new Date()) → Promise<{ ok: boolean, reason: string, demo: {slug, place_id, created_at, expires_at} | null, created: boolean }>
demoBySlug(DB, slug, now = new Date()) → Promise<{ demo, lead, research, prospect, expired: boolean, contact_email: string } | null>
```
`ensureDemo` reads lead + research + latest demo + prospect + suppression in **one** SELECT, then inserts the demo
when needed (one statement; on a slug primary-key clash it retries once with a new slug), and then either creates the
prospect with `applyStageEvent(DB, place_id, "demo_ready", now, {email, greet_name})` when none exists, or updates
`email`/`greet_name` of a `ready` prospect with one UPDATE (`WHERE stage = 'ready'`, no stage change). `demoBySlug` returns null for slugs not matching `^[a-z0-9-]{3,60}$`; `expired` is
`demo.expires_at <= now` unless `prospect.stage = 'won'`; `contact_email` is the address of `prospect.mailbox_id`'s
mailbox, else "".

- [ ] **Step 1: Write the failing test** — seed with `fakeD1()` a lead + research row (grade A, best_email
  `Dave@GreenLeaf.co.uk`, owner `{"first":"Dave","confident":true}`):
  ```js
  const r = await ensureDemo(DB, "p1", AT);                        // AT = 2026-10-21T10:00:00Z
  assert.equal(r.ok, true); assert.equal(r.created, true);
  assert.equal(r.demo.expires_at, "2027-04-19T10:00:00Z");          // +180 days
  const p = DB.raw.prepare("SELECT * FROM prospects WHERE place_id='p1'").get();
  assert.equal(p.stage, "ready"); assert.equal(p.email, "dave@greenleaf.co.uk"); assert.equal(p.greet_name, "Dave");
  assert.equal((await ensureDemo(DB, "p1", AT)).demo.slug, r.demo.slug);     // reused
  // unconfident owner → greet_name NULL; better email on re-research updates a ready prospect only
  // reasons:
  for (const [setup, reason] of [[gradeC, "Grade C: only A+, A and B get a demo"], [noEmail, "No email found"],
       [tooBig, "Too big for us"], [notDone, "Not researched yet"], [excluded, "Excluded: Chain / national brand"],
       [suppressedDomain, "On the do-not-contact list"], [missing, "Lead not found"]])
    assert.deepEqual(await ensureDemo(await setup(), "p1", AT), { ok: false, reason, demo: null, created: false });
  // a prospect already 'emailed' is never changed
  // expired demo → a new slug; an unapproved template adds the setup todo once
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM todos WHERE dedupe='setup:demo-template:landscaper:v1'").get().n, 1);
  // demoBySlug: bad slug → null; expired → expired:true; won → expired:false
  ```
  And in `research-post.test.mjs`, `posting research makes the demo and the ready prospect`: post the file's valid
  A-grade payload (with a `best_email`) to `POST /api/agent/research/:place_id`, then assert one `demos` row for the
  lead and a `prospects` row in stage `ready`; a D-grade payload makes neither.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-db.test.mjs control-room/tests/research-post.test.mjs` → FAIL.
- [ ] **Step 3: Implement `ensureDemo`, `demoBySlug`, `demoLink` in `control-room/functions/_lib/demo-db.js`** —
  approval lookup for the setup todo uses `templateApproval` from Task 9 (write it as a stub returning
  `{approved: false}` here; Task 9 fills it). In `api/agent/research/[id].js`, call
  `await ensureDemo(DB, placeId, now)` right after `saveResearch`; its result never changes the route's response (a
  lead that doesn't qualify simply gets no demo).
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/demo-db.test.mjs control-room/tests/research-post.test.mjs control-room/tests/demo.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/demo-db.js "control-room/functions/api/agent/research/[id].js" control-room/functions/api/outreach/enrol.js control-room/tests/demo-db.test.mjs control-room/tests/research-post.test.mjs control-room/tests/demo.test.mjs && git commit -m "Demo: ensureDemo makes the demo and the ready prospect" -m "$TRAILER"`

### Task 9: Template approval and `demoReady`

**Files:** Modify `control-room/functions/_lib/demo-db.js`; Test `control-room/tests/demo-db.test.mjs` (add).

**Interfaces:**
Consumes: `getSetting`/`setSetting` (settings.js), `closeTodos` (todo.js), `TEMPLATES` (Task 6/7).
Produces:
```js
templateApproval(DB, id) → Promise<{ approved: boolean, version: number | null, at: string | null }>
approveTemplate(DB, id, version, now = new Date()) → Promise<void>   // throws Error("This look changed since you opened the page. Refresh and check it again before approving.") when version ≠ TEMPLATES[id].TEMPLATE.version
demoReady(DB, place_id, now = new Date()) → Promise<{ ok: boolean, reason: string, url: string | null, slug: string | null }>
```

- [ ] **Step 1: Write the failing test**:
  ```js
  assert.deepEqual(await demoReady(DB, "nope"), { ok: false, reason: "No demo yet: Lead not found", url: null, slug: null });
  await ensureDemo(DB, "p1", AT);
  assert.equal((await demoReady(DB, "p1", AT)).reason, "Waiting for you to approve the Landscaper look on the Demo page");
  await approveTemplate(DB, "landscaper", 1, AT);
  assert.deepEqual(await demoReady(DB, "p1", AT), { ok: true, reason: "", url: demoLink(slug), slug });
  assert.equal(DB.raw.prepare("SELECT status FROM todos WHERE dedupe='setup:demo-template:landscaper:v1'").get().status, "done");
  await assert.rejects(approveTemplate(DB, "landscaper", 0, AT), /This look changed/);
  // approval of version 1 doesn't approve version 2:
  DB.raw.prepare("UPDATE settings SET value='{\"version\":0,\"at\":\"x\"}' WHERE key='demo:template:landscaper:approved'").run();
  assert.equal((await templateApproval(DB, "landscaper")).approved, false);
  // expired demo:
  DB.raw.prepare("UPDATE demos SET expires_at='2026-01-01T00:00:00Z'").run();
  assert.equal((await demoReady(DB, "p1", AT)).reason, "Their demo has expired: a new one is being made");
  ```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-db.test.mjs` → FAIL.
- [ ] **Step 3: Implement the three functions in `demo-db.js`** — setting value JSON `{"version", "at"}`; approve
  closes todos with prefix `setup:demo-template:<id>:`.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/demo-db.js control-room/tests/demo-db.test.mjs && git commit -m "Demo: template approval gate and demoReady" -m "$TRAILER"`

### Task 10: The public demo page route

**Files:** Modify `control-room/functions/d/[slug]/index.js`; Modify `control-room/functions/_lib/page.js` (optional
`extraHeaders` argument); Delete `renderDemo`, `servicesFor`, `PREVIEW_DAYS` from `control-room/functions/_lib/demo.js`;
Test `control-room/tests/demo-routes.test.mjs`.

**Interfaces:**
Consumes: `demoBySlug` (Task 8), `buildDemoData` (Task 4), `renderSite`/`renderExpired`/`renderNotFound` (Task 6),
`offerFor` (offer.js).
Produces: `GET /d/:slug` → 200 demo HTML | 410 expired page | 404 not-found page; `page(html, status, extraHeaders = {})`.

- [ ] **Step 1: Write the failing test** — call `onRequestGet({ env: { DB }, params: { slug } })`:
  - live demo → 200, body matches `/Preview made for/`, header `content-security-policy` equals the Part A §6 value,
    `x-robots-tag` is `noindex, nofollow`;
  - unknown slug and `../etc` → 404 with `/This page doesn&#39;t exist/`;
  - expired → 410 with `/This preview has ended/`; same slug with prospect stage `won` → 200.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-routes.test.mjs` → FAIL.
- [ ] **Step 3: Implement `onRequestGet` in `control-room/functions/d/[slug]/index.js`** — `demoBySlug` → (null: 404)
  (expired: 410 with `{name, contact_email}`) else `renderSite(buildDemoData({lead, research, demo, offer:
  offerFor(now), now}))`.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/demo-routes.test.mjs control-room/tests/demo.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/d/[slug]/index.js control-room/functions/_lib/page.js control-room/functions/_lib/demo.js control-room/tests/demo-routes.test.mjs && git commit -m "Demo: public page renders from the template engine" -m "$TRAILER"`

### Task 11: Counting real views (beacon)

**Files:** Create `control-room/functions/_lib/session.js`, `control-room/functions/_lib/demo/bots.js`; Modify
`control-room/functions/_middleware.js` (import `SESSION_COOKIE`/`sessionToken` from `session.js` instead of its own
copies), `control-room/functions/d/[slug]/e.js`, `control-room/functions/_lib/demo-db.js`; Test
`control-room/tests/demo-routes.test.mjs` (add).

**Interfaces:**
Produces:
```js
// session.js
SESSION_COOKIE = "cr_session"
sessionToken(password) → Promise<string>
isOwnerRequest(request, env) → Promise<boolean>     // true when the cr_session cookie is valid
// bots.js (pure)
BOT_UA = /bot|crawl|spider|slurp|preview|scan|monitor|fetch|headless|lighthouse|pagespeed|python|curl|wget|go-http|java\/|okhttp|axios|node|facebookexternalhit|whatsapp|telegram|skype|slack|discord|outlook|microsoft office|safelinks|proofpoint|mimecast|barracuda|bitdefender/i
isBotUA(ua) → boolean                                // also true for empty/missing
// demo-db.js
EVENT_KINDS = ["view", "order_page", "order_click", "ordered"]          // kept for stage 9
recordEvent(DB, demo, kind, now = new Date()) → Promise<boolean>         // kept: 30-minute view dedupe
countView(DB, demo, now = new Date()) → Promise<boolean>                 // recordEvent + prospects views/last_view_at + applyStageEvent "demo_view"
```
`POST /d/:slug/e` always answers 204; it stores nothing when the body (max 200 bytes) isn't `view`/`order_page`/
`order_click`, `isBotUA`, `isOwnerRequest`, demo missing or expired, or the prospect is in stage `ready`.

- [ ] **Step 1: Write the failing test** — prospect `p1` in stage `emailed`, demo live:
  ```js
  const post = (ua, body = '{"kind":"view"}', cookie = "") => onRequestPost({ request: new Request("https://aetoswebsites.com/d/s/e", { method: "POST", body, headers: { "user-agent": ua, cookie } }), env: { DB, CONTROL_ROOM_PASSWORD: "pw" }, params: { slug } });
  const CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
  assert.equal((await post(CHROME)).status, 204);
  let p = DB.raw.prepare("SELECT views, stage, last_view_at FROM prospects").get();
  assert.equal(p.views, 1); assert.equal(p.stage, "viewed");
  await post(CHROME);                                                    // within 30 minutes
  for (const ua of ["", "Googlebot/2.1", "Mozilla/5.0 HeadlessChrome/120", "python-requests/2.31", "Microsoft Office/16.0 (Outlook)"]) await post(ua);
  await post(CHROME, '{"kind":"view"}', `cr_session=${await sessionToken("pw")}`);
  await post(CHROME, '{"kind":"hack"}');
  assert.equal(DB.raw.prepare("SELECT views FROM prospects").get().views, 1);
  // stage 'ready' → not counted; expired → not counted; order_page → demo_events row, views unchanged
  ```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-routes.test.mjs` → FAIL.
- [ ] **Step 3: Implement `session.js`, `bots.js`, `countView` and `onRequestPost` in `d/[slug]/e.js`** — `session.js`
  keeps stage 0's cookie name `cr_session` and its token derivation exactly (moved, not changed). `countView` reads the
  prospect, calls `recordEvent`, then one UPDATE with `views = views + 1`, `last_view_at`, `updated_at`, then
  `applyStageEvent(DB, place_id, "demo_view", now)` (stage 0's `prospects.js`; a no-op unless the stage is `emailed`).
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/*.test.mjs` → PASS (middleware
  login tests from stage 0 still pass).
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/session.js control-room/functions/_lib/demo/bots.js control-room/functions/_middleware.js control-room/functions/d/[slug]/e.js control-room/functions/_lib/demo-db.js control-room/tests/demo-routes.test.mjs && git commit -m "Demo: count only real prospect views" -m "$TRAILER"`

### Task 12: Tick step `hot` (expiry sync, missing demos, hot todos)

**Files:** Create `control-room/functions/_lib/hot.js`; Modify `control-room/functions/_lib/demo-db.js`,
`control-room/functions/_lib/tick.js` (add `{name: "hot", everyMinutes: 5, run: hotStep}` at position 5);
Test `control-room/tests/demo-hot.test.mjs`.

**Interfaces:**
Consumes: `ensureDemo` (Task 8), `isHot(prospect, now)` (stage 3's `_lib/shortlist.js`, the app's only `isHot`, with
the Part A §9 rule), `addTodo` (todo.js), `ukDate`, `ukParts` (ukTime.js), `shortName` (Task 2), `ctx.budget.left()` (stage
0's `runTick`; `ctx.budget` is an object, not a number), `countingDB(DB) → {DB, used}` (stage 0's `_lib/d1count.js`,
tests only).
Produces:
```js
// demo-db.js
syncDemoExpiry(DB) → Promise<number>          // one UPDATE: latest demo per lead → max(expires_at, last sent out message + 180 days)
missingDemos(DB, now, limit = 3) → Promise<string[]>   // eligible place_ids (Part A §1 checks in SQL) with no live demo or no prospect, prospect stage NULL or 'ready'
// hot.js
hotTitle(name, views) → string                 // pure: "Call now: <name> opened their site <N> times" / "… once"
hotStep({ DB, env, now, budget }) → Promise<string>    // budget = {left: () => number}; "expiry +<n> · demos made <n> · hot <n> · closed <n>" (+ " · demos skipped: low budget")
```
`hotStep` order: `syncDemoExpiry` (1 statement) → close open `hot` todos whose dedupe starts `hot:<place_id>:` for
prospects with `last_inbound_at` or stage not `emailed`/`viewed` (1 statement; no other dedupe is ever closed here) →
`missingDemos` + `ensureDemo` each (≤ 1 + 3×4; skipped when `budget.left() < 25`) → select hot
prospects with no open todo for today or a stale title, max 3 (1) → per prospect one `DB.batch` of insert-or-ignore
today's todo, update its title/detail, close older days of that lead's `hot:<place_id>:` todos (3 each).

- [ ] **Step 1: Write the failing test**:
  ```js
  const NOW = new Date("2026-10-21T13:05:00Z");
  // isHot is imported from ../functions/_lib/shortlist.js (stage 3); these lock the Part A §9 rule it must follow
  assert.equal(isHot({ stage: "emailed", views: 2, last_view_at: "2026-10-10T10:00:00Z", last_inbound_at: null }, NOW), true);
  assert.equal(isHot({ stage: "viewed", views: 1, last_view_at: "2026-10-20T14:00:00Z", last_inbound_at: null }, NOW), true);
  assert.equal(isHot({ stage: "viewed", views: 1, last_view_at: "2026-10-20T12:00:00Z", last_inbound_at: null }, NOW), false);
  assert.equal(isHot({ stage: "replied", views: 5, last_view_at: "2026-10-21T13:00:00Z", last_inbound_at: "x" }, NOW), false);
  assert.equal(hotTitle("Green Leaf Landscapes", 1), "Call now: Green Leaf Landscapes opened their site once");
  assert.equal(hotTitle("Green Leaf Landscapes", 3), "Call now: Green Leaf Landscapes opened their site 3 times");
  // hotStep: a hot prospect gets one todo "hot:p1:2026-10-21" with detail "Last opened Wed 14:00. Phone: 0113 496 0000. No reply yet."
  // running twice adds nothing; views 3 → title updated; next UK day → new todo, yesterday's closed
  // setting last_inbound_at closes it; an open todo with dedupe "checkout:p1" (stage 9) stays open
  // a sent message on day 170 extends expires_at to sent_at + 180 days (latest demo only)
  // 50 eligible leads without demos → 3 made per run, each prospect created through applyStageEvent (stage 'ready')
  // budget: with 50 eligible + 20 hot leads, one run uses ≤ 25 (each statement in a batch counts, as in stage 0):
  //   const c = countingDB(DB); await hotStep({ DB: c.DB, env: {}, now: NOW, budget: { left: () => 50 } }); assert.ok(c.used() <= 25)
  // budget: { left: () => 24 } → no demos made, summary ends "demos skipped: low budget"
  ```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-hot.test.mjs` → FAIL.
- [ ] **Step 3: Implement `syncDemoExpiry`, `missingDemos` in `demo-db.js` and `hotTitle`, `hotStep` in `hot.js`
  (importing `isHot` from `shortlist.js`, no copy); register the step in `tick.js`** — expiry SQL uses `strftime('%Y-%m-%dT%H:%M:%SZ', MAX(sent_at), '+180
  days')` and only touches the row with the latest `created_at` per `place_id`.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/*.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/hot.js control-room/functions/_lib/demo-db.js control-room/functions/_lib/tick.js control-room/tests/demo-hot.test.mjs && git commit -m "Demo: hot-lead todos, expiry sync and missing-demo safety net" -m "$TRAILER"`

### Task 13: Control Room API for demos

**Files:** Create `control-room/functions/api/demo/index.js`, `api/demo/preview.js`, `api/demo/approve.js`,
`api/demo/check.js`, `api/demo/lead/[id].js`; Delete `control-room/functions/api/demos.js`; Modify
`control-room/functions/api/leads.js` only to drop the old demo sub-selects if stage 3 hasn't already; Test
`control-room/tests/demo-api.test.mjs`.

**Interfaces:** Produces (all behind the login):
```
GET  /api/demo → { templates: [{ id, label, version, approved: bool, approved_at, approved_version, waiting: n,
                                 previews: [{ place_id, name, town, photos: n, problems: string[] }] }],
                   demos: [{ place_id, name, grade, stage, slug, url, views, last_view_at, expires_at }] }   // max 200 rows
GET  /api/demo/preview?template=<id>&place_id=<id> → text/html (renderSite with demo.count_views=false,
     header x-frame-options SAMEORIGIN, CSP frame-ancestors 'self'); 404 HTML "That lead isn't in the database any more."
POST /api/demo/approve { template, version } → { ok: true } | 409 { error: "This look changed since you opened the page. Refresh and check it again before approving." }
     | 400 { error: "There's no graded lead to preview this look with yet. Approve it once research grades one." }
GET  /api/demo/check?limit=10 → { rows: [{ place_id, name, template, bytes, problems: string[] }] }   // limit ≤ 10
GET  /api/demo/lead/:id → { demo: { slug, url, expires_at } | null, views, last_view_at, ready: demoReady(...) }
```
Preview picking (`pickPreviews(rows) → rows`, pure, exported from `index.js`): from graded A+/A/B researched leads
of that template, newest research first: first with ≥ 2 photos, first with 0 photos, the one with the fewest of
{services, reviews, photos, logo}; fill to 3 by best grade; no duplicates.

- [ ] **Step 1: Write the failing test** — seed 5 landscaper leads (varied data) + 2 generic:
  `pickPreviews` returns 3 distinct leads incl. one with photos and one without; `GET /api/demo` shows
  `waiting: 2` for landscaper when 2 ready prospects use it and `approved: false`; approve with version 1 → 200 then
  `approved: true`; approve with version 0 → 409 with the exact message; approve `generic` with no graded generic
  lead → 400; preview of a missing lead → 404; `check?limit=10` returns ≤ 10 rows with `problems: []` for clean
  fixtures; `lead/:id` returns `ready.reason` "No demo yet: Grade C: only A+, A and B get a demo" for a C lead.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-api.test.mjs` → FAIL.
- [ ] **Step 3: Implement the five routes** — `index.js` uses one query per template for previews and one for the
  demos list; `check.js` renders the newest eligible leads and runs `checkDemoHtml`.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/*.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/api/demo control-room/functions/api/demos.js control-room/functions/api/leads.js control-room/tests/demo-api.test.mjs && git commit -m "Demo: Control Room API (looks, previews, approve, checks)" -m "$TRAILER"`

### Task 14: Demo page and the lead drawer card

**Files:** Create `control-room/public/js/demo.js`; Modify `control-room/public/js/app.js` (add
`{route: "demo", label: "Demo", icon, render: demoPage, nav: false}` to `PAGES`: routed, no nav item; stage 3's
`parseRoute` passes any first hash segment through as `page` and `PAGES.find` resolves it, and stage 0's
`shell.test.mjs` only checks its 5 routes are present, so it still passes), `control-room/public/js/leads.js` (wiring
only: when the panel is drawn, fetch `GET /api/demo/lead/:id` and put `demoCardHtml` into stage 3's `#d-demo` mount
point), `control-room/public/js/leadview.js` (`demoHtml`: keep `<h3>Demo site</h3>`, the **Preview** toggle (only when
`demo.template` is set) and `<div id="d-demo"></div>`; drop its own link, "Ends …", "Viewed n×" / "Not viewed yet"
and its no-demo line, because `demoCardHtml` now shows them), `control-room/tests/leadview.test.mjs` (move its
demo link, ends, views and no-demo assertions to `demo-ui.test.mjs`; keep the Preview, relative-href (the Actions
row's **Open demo**) and mount-point tests), `control-room/public/style.css` (`.demo-look`, `.demo-frame` 390×700
with scroll, `.demo-card`); Test `control-room/tests/demo-ui.test.mjs`. The drawer's Actions row already has
**Open demo**, so the card's own one is optional.

**Interfaces:**
Consumes: Task 13 routes; `esc`, `safeUrl`, `api`, `toast`, `pageHead`, `fmtDate` from `lib.js`.
Produces: `demoPage()` (route `#/demo`), `demoCardHtml(info) → string` (pure, exported), `lookCardHtml(t) → string`
(pure, exported). Iframes: `<iframe sandbox="" loading="lazy" src="/api/demo/preview?template=…&place_id=…">`.
"Open demo" links (drawer card and Demo page) are the relative `/d/<slug>` (from `slug`, checked against
`^[a-z0-9-]{3,60}$`), never `demo.url`; "Copy link" copies `demo.url`. Copy exactly as Part A "What Nik sees".

- [ ] **Step 1: Write the failing test** — `demo-ui.test.mjs` imports the two pure functions (no DOM):
  ```js
  assert.match(demoCardHtml({ demo: { slug: "a-b", url: "https://aetoswebsites.com/d/a-b", expires_at: "2027-04-17T10:00:00Z" }, views: 3, last_view_at: "2026-10-20T13:05:00Z", ready: { ok: true } }), /Viewed 3×/);
  assert.match(demoCardHtml({ demo: null, views: 0, ready: { ok: false, reason: "No demo yet: Grade C: only A+, A and B get a demo" } }), /No demo: Grade C: only A\+, A and B get a demo/);
  assert.match(demoCardHtml({ demo: { slug: "a-b", url: "…", expires_at: "…" }, views: 0, ready: { ok: false, reason: "Waiting for you to approve the Landscaper look on the Demo page" } }), /waiting for you to approve the Landscaper look/);
  assert.match(lookCardHtml({ id: "landscaper", label: "Landscaper", version: 1, approved: false, waiting: 6, previews: [] }), /6 leads are waiting for this look before their first email can go\./);
  assert.match(lookCardHtml({ id: "landscaper", label: "Landscaper", version: 2, approved: false, approved_version: 1, waiting: 0, previews: [] }), /This look changed since you approved version 1\./);
  assert.doesNotMatch(demoCardHtml({ demo: { slug: "x", url: "javascript:alert(1)", expires_at: "x" }, views: 0, ready: { ok: true } }), /href="javascript/);
  const ready = demoCardHtml({ demo: { slug: "a-b-7k2p9q", url: "https://aetoswebsites.com/d/a-b-7k2p9q", expires_at: "2027-04-17T10:00:00Z" }, views: 0, ready: { ok: true } });
  assert.match(ready, /href="\/d\/a-b-7k2p9q"[^>]*>Open demo/);          // relative: Nik's cookie goes with it, so his views never count
  assert.doesNotMatch(ready, /href="https:\/\/aetoswebsites\.com\/d\/a-b-7k2p9q"[^>]*>Open demo/);
  ```
  (`demo.js` must import nothing that touches `document` at module load; DOM work happens inside `demoPage()`.)
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/demo-ui.test.mjs` → FAIL.
- [ ] **Step 3: Implement `demoPage`, `demoCardHtml`, `lookCardHtml` in `control-room/public/js/demo.js`** and wire
  the route (the `PAGES` entry with `nav: false`; if stage 0's nav builder doesn't already skip `nav: false` entries, add
  that one check to it here) and the drawer's `#d-demo` mount; "Approve this look" posts `{template, version}` and shows
  the API's error text in a toast.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/*.test.mjs && for f in control-room/public/js/*.js; do node --check "$f"; done` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/public/js/demo.js control-room/public/js/app.js control-room/public/js/leads.js control-room/public/js/leadview.js control-room/public/style.css control-room/tests/demo-ui.test.mjs control-room/tests/leadview.test.mjs && git commit -m "Demo page: approve looks, see demos and views; demo card in the lead drawer" -m "$TRAILER"`

Then run the Part A "Perfect when" live checks 6–12 on the deployed site.

## Cross-stage interfaces

**Produced here (others use):**
- `ensureDemo(DB, place_id, now = new Date()) → Promise<{ok, reason, demo, created}>` — `_lib/demo-db.js`. Stage 2's
  route `POST /api/agent/research/:place_id` (`api/agent/research/[id].js`) calls it right after `saveResearch`; this
  stage adds that call (Task 8). It also creates the `prospects` row (stage `ready`) through `applyStageEvent`.
  Signature changed from the old `ensureDemo(DB, lead, at)`.
- `demoReady(DB, place_id, now = new Date()) → Promise<{ok, reason, url, slug}>` — **stage 5/6** must refuse a first
  email when `ok` is false and show `reason`; the first email's only link is `url`. **Stage 3** can show `reason` on
  the shortlist.
- `demoLink(slug)`, `DEMO_BASE = "https://aetoswebsites.com"`, `DEMO_DAYS = 180`.
- `buildDemoData({lead, research, demo, offer, now, live})`, the `DemoData` contract, `renderSite(data, {mode, page})`,
  `TEMPLATES`, `templateIdFor(trade)` — **stage 10** renders the client's site with `mode: "live"` and fills
  `data.live = {form_action, canonical_url}`; it adds pages beyond `home` inside the same templates.
- `templateApproval(DB, id)` / setting key `demo:template:<id>:approved` = `{"version", "at"}`.
- `recordEvent(DB, demo, kind, now)` and `EVENT_KINDS` (kept) — **stage 9** records `ordered` and uses `order_page`/
  `order_click`; the preview bar's "Order this site" links to `/d/<slug>/order` (stage 9 owns that page;
  `renderOrder` stays in `_lib/demo.js` until then).
- `renderExpired({name, contact_email})`, `renderNotFound()` — stage 9's order page should use them too.
- `_lib/session.js`: `SESSION_COOKIE` (stays `cr_session`), `sessionToken(password)` (stage 0's derivation,
  unchanged), `isOwnerRequest(request, env)` — **stage 0's** middleware imports these instead of keeping its own copy.
- `GET /api/demo/preview?template=<id>&place_id=<id>` — **stage 3's** lead drawer frames this for its demo preview
  (it allows `frame-ancestors 'self'`; the public `/d/<slug>` page never can be framed and has no `?preview=1`).
- `demoCardHtml(info)` — mounted into stage 3's `<div id="d-demo"></div>` in the lead drawer; it takes over the demo
  facts there (stage 3's `demoHtml` keeps only the heading, **Preview** and the slot, Task 14).
- Tick step `hot` (position 5, every 5 minutes) is fully owned here, including what overview §8 lists as "stage 4/6";
  stage 6 doesn't add another hot step. It also runs `syncDemoExpiry` and the missing-demo safety net.
- `checkDemoHtml(html, data, {mode, now})` — stage 10 can reuse it as a pre-launch check for client sites.

**Needed from other stages (not defined in the overview):**
- Stage 0's `_lib/offer.js` (01 Task 6 owns it): `offerFor(date) → {weekend, full, website, banner}` where `full` is
  `PACKAGES.full` or `PACKAGES.weekend` (pence; `full.freeDays` 60 or 90), and `GUARANTEE = {headline, section}`.
  This stage defines no offer or guarantee constants of its own.
- Stage 0's `prospects.js`: `applyStageEvent(DB, placeId, event, now, {email, greet_name})` (the option inserts a
  new row); with `stages.js` giving `nextStage(null, "demo_ready") === "ready"`, `nextStage("ready", "demo_ready")
  === "ready"`, `nextStage("emailed", "demo_view") === "viewed"` and `nextStage(s, "demo_view") === s` for every
  other stage.
- Stage 3's `_lib/shortlist.js`: `isHot(prospect, now)` with the Part A §9 rule (only `emailed`/`viewed`).
- Stage 0's `runTick`: `ctx.budget`, an object whose `ctx.budget.left()` is the queries left in this invocation;
  stage 0's `countingDB(DB) → {DB, used}` for the budget test.
- **Stage 0 middleware host routing:** `/d/*` must be public and served on the root domain `aetoswebsites.com` (not
  replaced by the landing page), and `/robots.txt` should disallow `/d/`.
- **Stage 2:** `research.copy` is `{headline, intro, services: string[], areas: string[], about}`; `research.owner` is
  `{first, full, source_url, confident}`; `research.best_email` is a single address.
- **Stage 3 / file 11:** the lead drawer keeps the `#d-demo` mount point for `demoCardHtml`; stage 3's `parseRoute`
  returns the first hash segment as `page` for any route (so `#/demo` reaches `PAGES.find` instead of Home); file
  11's `routeFor` keeps the `demo` route (there is no nav item for it).
- **Stage 9:** its payment-page todos use dedupe `checkout:<place_id>` (never `hot:…`), so the `hot` step can't close
  them.
- **Stage 0 sending:** outbound rows in `messages` have `direction = 'out'`, `status = 'sent'`, `sent_at` and
  `place_id` (read by `syncDemoExpiry`).

## Questions for Nik

- **Q-H. Landscaper template look (D-5).** Send example sites you like, or let Claude design it? *Default: Claude
  designs v1; you approve it on the Demo page before any email can link to it.*
- **Q-V. Price on the demo?** The guarantee strip shows the free days and "No contract", and the "Order this site"
  button leads to the prices. *Default: no; prices only on the order page.*
- **Q-W. Approve each demo before its first email?** The look is approved once per template, and you see the demo
  link next to each lead when you write the first email. *Default: no; one approval per template.*
- **Q-X. Their colour is too pale for white text:** use a darker shade of their colour, or always switch to
  Charcoal? *Default: darker shade of their colour (up to 50% darker), then Charcoal if even that is unreadable.*

<!-- Self-review (writing-plans): spec coverage — Part A rules 1–10 map to Tasks 1–14 (truth/reviews 1,4; escaping 2,6;
colour 3; contract 4; checks 5; templates 6–7; ensureDemo/prospect 8; gate 9; route/expiry page 10; beacon 11; hot +
expiry + backfill 12; Control Room 13–14). Step scan: no TBD; LOCK hashes are filled from the first green run by design.
Types: DemoData fields, ensureDemo/demoReady returns, setting key and todo dedupes are identical across Part A, tasks and
cross-stage list. Review focus items each name their owning test. Proportion: code blocks only for the exact contract,
beacon script, BOT_UA and test assertions. -->
