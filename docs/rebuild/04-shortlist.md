# Stage 3: Shortlist

> **Plain English:** The Leads page shows every business we've found, with Claude's grade (A+ to D) as the main
> filter. It opens on "Ready to email": only A+ and A leads that have an email, a demo site, and haven't been emailed
> (B leads join when you have spare room). A banner says how many first emails you can send today, counting the
> follow-ups already due. Click a lead and one panel shows why it got its grade, what to say, who the owner is, their
> demo, and a call script. Every morning at 7am a Todo tells you how many are waiting.

## Goal

Nik picks today's first emails in under 5 minutes, from leads that are all safe and worth emailing, without
overfilling the mailbox's daily cap.

## Trigger

- Nik opens **Leads** (nav), or a link `/#/leads?view=ready` (the `pick` todo), or `/#/lead/<place_id>` (any todo
  from any stage).
- The tick's `pick` step runs every 30 minutes and acts from 07:00 UK.

## Who does what

| Who | Does |
| --- | --- |
| System | Lists and filters leads; works out today's room for first emails; adds and updates the morning `pick` todo; hides leads Nik marks "Not a fit". |
| Claude | Nothing new here. Its stage 2 research (grade, angle, opener, owner, emails, site review) is what the page shows, through stage 2's research card. Stage 2's "Research is wrong" re-queues a lead and wakes the research Routine. |
| Nik | Opens Ready to email, reads the research card and opener, presses **Write first email** (stage 6), or **Not a fit**. |

## Rules (exact)

### Filters

| Filter | Values | Query param (`GET /api/leads`) | Matches |
| --- | --- | --- | --- |
| View | Ready to email (default), All leads | `view=ready` / `view=all` | Ready rule below / everything |
| Grade (multi-select chips) | A+, A, B, C, D, Not graded | `grade=ap,a,b,c,d,none` | `research.grade`; `none` = no research row or grade NULL |
| Trade | from the data | `trade=<text>` | `leads.trade` exactly |
| Town | from the data ("Town searched") | `town=<text>` | `leads.search_town` exactly |
| Has email | Any / Has email / No email | `email=1` / `email=0` | `COALESCE(NULLIF(prospects.email,''), NULLIF(research.best_email,''), NULLIF(leads.email,''))` present |
| Stage (multi-select chips, All view only) | Ready to email, Emailed, Opened demo, Replied, Needs you, Call booked, Won, Lost, Not contacted | `stage=ready,emailed,viewed,replied,needs_nik,call_booked,won,lost,none` | `prospects.stage`; `none` = no prospects row |
| Researched | Any / Researched / Not researched | `researched=1` / `researched=0` | `research.status IN ('done','skipped')` / no row or `queued` |
| Search | text, max 100 characters | `q=<text>` | name, trade, town, search_town, phone, any email, owner's full name (case-insensitive substring) |
| Show excluded | checkbox, default off | `excluded=1` | include `leads.excluded = 1` (scraper exclusions) |
| From a scrape run | (link from the Lead Scraper page) | `job=<id>` | `leads.last_job_id` |
| Page | 50 rows a page | `page=<n>` (1-based) | |

Grade tokens are `ap a b c d none` in URLs, never `A+` (a raw `+` in a query string reads as a space). Unknown tokens
are dropped; an empty set means "no grade filter".

**Sort (every view):** grade A+ → A → B → C → D → not graded, then `quality_score` high → low, then `rating` high →
low, then `place_id` (stable paging).

### "Ready to email" (the default view)

A lead is ready when **all** hold:
1. `leads.excluded = 0`;
2. `research.status = 'done'`, `research.too_big = 0`, grade in the ready grades (below);
3. a `prospects` row with `stage = 'ready'` (stage 4 creates it when the demo is ready) and a non-empty `email`;
4. a live demo: a `demos` row for the lead with `expires_at > now`;
5. not suppressed: none of the email (lower-cased), its domain, or `leads.company_number` is in `suppression.value`.

**Ready grades:** A+ and A always. B joins only when today's room for first emails is larger than the number of
ready A+/A leads (`room > top`). C and D never appear in Ready.

Grade chips in Ready show only A+, A, B (B greyed with "Spare room only" when it isn't included). Trade, town and
search still narrow Ready. Stage, has-email, researched and excluded filters only show in All leads.

### Today's room for first emails (capacity banner)

```
cap          = Σ mailboxCap(m, ukToday) over mailboxes with role 'cold'   (paused → 0)
sent         = Σ sentToday(DB, now)                                       (first + followup, sent today or 'sending')
followupsDue = followupsDueToday(DB, now)                                 (due by end of UK today, still 'queued' or not queued yet)
firstQueued  = messages with kind 'first' and status 'queued'             ('sending' ones are already in sent)
room         = max(0, cap − sent − followupsDue − firstQueued)
```

From stage 6, `room` is also capped by the composer's own rule (it reserves room on every future follow-up day):
`room = min(the formula above, (await roomForFirsts(DB, now)).total)`. Stage 6 makes that change inside
`capacityNow`, so the banner and the composer's Send button always agree. The banner text below is unchanged.

Banner (first matching row wins; `{details}` = `"{cap} a day"` then, only when non-zero, `"{n} follow-up(s) already
due"`, `"{n} already sent"`, `"{n} first email(s) waiting to go"`, joined with ", "):

| Situation | Tone | Exact text | Link |
| --- | --- | --- | --- |
| No cold mailbox | warn | `Add your mailbox on Setup to start emailing.` | "Open Setup" → `#/setup` |
| Every cold mailbox paused | warn | `Sending is paused: {paused_reason of the first one}. Fix it on Setup.` | "Open Setup" → `#/setup` |
| cap = 0 (warming up) | info | `Your mailbox is warming up. First emails can go from {Tue 3 Nov}.` | none |
| room = 0 | info | `No room for more first emails today ({details}). The next ones can go tomorrow.` | none |
| otherwise | ok | `You can send {room} first email(s) today ({details}).` | none |

Example: one mailbox past week 6 (10 a day), 7 follow-ups due, nothing sent → "You can send 3 first emails today (10
a day, 7 follow-ups already due)."

"Warming up from" = the first UK day, scanning today + 0…60 days with `addUkDays`, on which any active cold mailbox
has `mailboxCap > 0`.

### The lead panel (drawer)

Opens from a row click or `/#/lead/<place_id>`. Loads with one request (`GET /api/leads/:id`). Sections, top to
bottom:

1. **Head:** name, "trade · town", grade badge, stage badge (+ "Hot" when hot), "Do not email" tag when suppressed,
   close ×.
2. **Actions:**
   - **Write first email** (primary): only when the stage is `ready`. Disabled with "No room left today" when room = 0,
     or "Add a mailbox first" when there's no mailbox. Opens stage 6's composer in the `#d-email` slot (section 6)
     and scrolls to it.
   - **Call** (tel link, when a phone exists), **Website**, **Google** (maps), **Open demo** (when a live demo exists;
     the relative link `/d/<slug>` on the Control Room host, so Nik's own visits are never counted).
   - **Not a fit**: only when there's no prospect row or the stage is `ready`.
3. **Claude's research:** stage 2's research card (`researchCard` from `public/js/researchcard.js`), unchanged: grade,
   `grade_reason`, the four points out of 5 with their one-line reasons (`points.reasons`), angle facts with source
   links, the opener with **Copy**, owner (greets by first name only when confident, else "not confirmed: emails say
   \"Hi,\""), best email and the others, Claude's review of their website, and the **Research is wrong** button
   with its note box. Its empty states ("Not queued for research", "Waiting for Claude") are stage 2's.
4. **Demo:** link, expiry date, views; **Preview** toggle that loads stage 4's preview
   (`/api/demo/preview?template=<id>&place_id=<id>`) in a small frame only when pressed; then the `#d-demo` slot
   that stage 4 fills with its demo card. No live demo: "No demo yet. It's made automatically once the trade's
   template is approved."
5. **Google Maps:** average rank, top-3 % of town, found %, "Heatmap" link. None: "Not scanned yet."
6. **Email:** the empty `#d-email` slot (stage 6 mounts the composer or the thread here), then the read-only
   **Conversation**: every message, oldest first, plain text (who, when, subject, body). None: "Nothing sent yet."
7. **Top reviews:** up to 3 (stars, author, text).
8. **Call script** (collapsed; open by default when there's no email), then the empty `#d-call` slot (stage 8 mounts
   its call box here).
9. **Business facts:** phone, address, website, company number, rating, "Found searching {trade} in {town},
   {date}".
10. **Notes** (saves on blur, as now).

**Not a fit:** a small dialog "Why isn't it a fit?" with choices "Too big (not owner-run)", "Front-desk business",
"Wrong trade", "Already doing well online", "Other" + a text box; button **Hide this lead**. Sets
`research.status = 'skipped'`, puts the line `[Nik YYYY-MM-DD] Not a fit: {reason}` (UK date) on top of
`research.notes` (the same `[Nik …]` format stage 2's `mergeNotes` keeps), deletes a `ready` prospects row. Toast:
"Marked not a fit. It won't show in Ready to email." Refused once emailed (409: "Already emailed. Stop the
follow-ups from the conversation instead.").

**Research is wrong** (stage 2's button and route, `POST /api/research/:place_id/wrong {note}`): re-queues the lead
(old findings stay visible until Claude re-posts; the lead leaves Ready meanwhile) and wakes the research Routine at
most once per 30 minutes. Stage 2's route returns the message the drawer toasts:
- fired: "Queued. Claude has been asked to research it now. Check back in 15 minutes."
- recent fire: "Queued. Claude will pick it up on its current or next run."
- fire failed: "Queued, but Claude couldn't be started ({error}). It will be researched at 06:47 tomorrow."

### Call script

`public/js/callscript.js` stays (pure, tested). Changes: prices and the weekend deal come from stage 0's
`offerFor(now)` (sent in the drawer payload as `offer`, shape `{weekend, full: {label, build, monthly, freeDays,
wasBuild?}, website, banner}`, money in pence); the guarantee comes from stage 0's `GUARANTEE` (sent in the payload
as `guarantee`), said with the exact wording from overview §9; the owner's first name is used only when research
marked it confident; the first angle fact appears in "Before you dial". Pitch line:

> "We build it, and it's live in 7 days, guaranteed. {guarantee.headline} {guarantee.section}"

The objection answers that quoted the old guarantee ("front page of Google in 90 days or we work for free until you
are") say `{guarantee.section}` instead. On a weekend the spoken anchor is "around £2,000": `offer.full.wasBuild`
(£1,950) rounded to the nearest £100. That is true of £1,950, and only ever said, never written (Q-A).

### Morning `pick` todo

Tick step `pick`, every 30 minutes. From 07:00 UK, when room > 0 and ready leads exist:
- title `"{top} A-grade lead(s) ready: you can send {room} first email(s) today"`; when top = 0 but B leads are
  in Ready: `"{b} B-grade lead(s) ready: you can send {room} first email(s) today"`;
- detail `Open Leads → Ready to email, and write each first email from the lead's panel.`;
- link `/#/leads?view=ready`, `due_at` = 07:00 UK today, `dedupe` = `pick:YYYY-MM-DD` (UK date).
- First run of a new UK day closes every older `pick:` todo. Later runs that day update the open todo's title so the
  numbers stay true; when room reaches 0 or nothing is ready, today's todo is closed (done). A dismissed or closed
  todo is not reopened that day.

### Edge cases

- Lead with a research row but `grade` NULL → "Not graded".
- Lead with two demos (one expired) or several messages/calls → appears once in the list.
- Graded A with an email but no demo yet → not in Ready; counted in "waiting for their demo site".
- Suppressed address or whole domain (any case) → never in Ready; "Do not email" tag in All leads and the drawer.
- Search text with `%`, `_`, `\` or quotes matches literally.
- A website or source URL that isn't http(s) (`javascript:`) is shown as text, never a link.
- Lead deleted between list and drawer → 404 "That lead isn't in the database any more. Close this panel and refresh."
- Before stage 4/6 ship: Ready is empty (no `ready` prospects); **Write first email** says "Writing emails arrives
  with the next stage." if stage 6's `compose.js` isn't there; the `#d-demo`, `#d-email` and `#d-call` slots stay
  empty, and the demo has no **Preview** until stage 4's preview route exists.

## What Nik sees

**Leads page:** title "Leads", subtitle "Pick today's first emails. Best first." Then the capacity banner; tabs
"Ready to email (n)" | "All leads (n)"; grade chips with counts; filters; search; the table (Grade | Business |
Why | Email | Stage | Score); "Showing 1–50 of 213" with Previous / Next.

Empty states:
- Ready, some A+/A waiting on demos: "No leads are ready to email yet. {n} A-grade lead(s) are waiting for their demo
  site."
- Ready, none graded A+/A: "No A-grade leads yet. Claude grades new leads every morning at 06:47." + "See all leads".
- All leads, filters match nothing: "No leads match these filters." + "Clear filters".
- API error: the error's own plain-English text in red, with "Open Setup to see what's connected."

**Lead Scraper page:** finished runs show "See these {n} leads" → `#/leads?view=all&job=<id>` instead of their own
table. **Home:** its "next leads" open the new drawer.

## Todos added

`pick` (above). No other kinds.

## Health lights fed

None new. A throwing `pick` step shows in the tick result and the `tick` heartbeat detail (stage 0).

## Perfect when

1. `node --test control-room/tests/*.test.mjs` passes, including the new files `shortlist`,
   `followups-due`, `shortlist-db`, `leads-api`, `pick`, `leadview` and the updated `callscript` tests; `for f in
   control-room/public/js/*.js; do node --check "$f"; done` is clean.
2. **Grade filter on real data:** after deploy, the chip counts in All leads (Show excluded on) add up to the total,
   and equal the output of `npx wrangler d1 execute goldbarwebsites --remote --command "SELECT COALESCE(r.grade,'none') g,
   COUNT(*) FROM leads l LEFT JOIN research r ON r.place_id = l.place_id GROUP BY g"`. Ticking only A+ shows only
   A+ badges.
3. **Default view only shows emailable leads:** test `shortlist-db › ready view` (12 seeded leads, exactly the 3
   qualifying ones returned). Live: the Ready count equals `SELECT COUNT(*)` with the same rule run through
   wrangler; every row has an email and its demo opens.
4. **Capacity matches the outbox:** test `shortlist-db › capacity` gives room 3 for cap 10 / 7 follow-ups due /
   nothing sent, and room 0 after 2 sends and 1 queued first email (10 − 2 − 7 − 1). Live: with no mailbox the banner shows the Setup
   text; after stage 0's mailbox exists the number equals cap − sent − due − queued from SQL (from stage 6, the
   smaller of that and `roomForFirsts(...).total`).
5. **Drawer under 1 second:** test `leadDetail` runs ≤ 4 statements with 40 messages seeded (no N+1). Live: DevTools
   → Network, `GET /api/leads/<id>` under 1,000 ms for 5 random leads.
6. **List under D1 limits:** test `listLeads` runs ≤ 12 statements for a 50-row page. Live: `GET /api/leads` under
   1,000 ms with all real leads.
7. **No raw HTML or audit blobs leave the API:** test: neither response has an `audit` key or the text `<html`.
8. **Escaping:** test `leadview` renders a name `<img src=x onerror=alert(1)>`, a `javascript:` website and a review
   containing `</p><script>` as inert text.
9. **Pick todo:** tests at 06:59 / 07:00 UK in BST (20 Oct) and GMT (26 Oct). Live: the morning after deploy, the
   `todos` table has `pick:<date>` only if room > 0 and Ready isn't empty.
10. **Actions:** tests: Not a fit removes the lead from Ready, writes `[Nik <date>] Not a fit: <reason>` on top of the
    notes, and is refused once emailed. (Research is wrong and its 30-minute fire guard are stage 2's tests.)
11. **Call script:** contains the exact §9 guarantee lines, weekday £1,950 / 60 days, weekend around £2,000 → £1,750 /
    90 days by UK time, and `callscript.js` has no `£` followed by a digit.
12. Live: `/#/lead/<place_id>` opened in a fresh tab shows the Leads page with that lead's panel open.

---

# Shortlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Leads page and its API so Nik filters by grade, sees only emailable leads by default, knows
today's first-email room, and gets everything about a lead in one fast panel.

**Architecture:** Pure logic (filter parsing, room maths, banner text, pick title, hot flag) lives in
`_lib/shortlist.js`; prices and guarantee wording come from stage 0's `_lib/offer.js` (not changed here); D1 access in `_lib/shortlist-db.js` (one list query with correlated
subqueries, one batched detail read). Thin routes under `functions/api/leads/`. The browser splits into a pure,
tested renderer (`public/js/leadview.js`) and a DOM/binding file (`public/js/leads.js`).

**Tech Stack:** Cloudflare Pages Functions (plain ES modules), D1 (SQLite), node:test with `tests/helpers/fakeD1.mjs`,
plain browser JS.

**Spec:** Part A of this file + docs/rebuild/00-overview.md

## Global Constraints

- Overview §9 applies: truth, escaping (`esc`/`safeUrl`), copy rules, guarantee wording, prices only from `offer.js`,
  UTC storage with UK-time rules via `ukTime.js`, plain-English errors, tests before push.
- Page size 50; search `q` capped at 100 characters; LIKE patterns escape `\ % _` with `ESCAPE '\'`.
- Grade URL tokens `ap a b c d none`; stage tokens `ready emailed viewed replied needs_nik call_booked won lost none`.
- `GET /api/leads` ≤ 12 D1 statements; `GET /api/leads/:id` ≤ 4 statements in one `DB.batch` after the lead lookup.
  No new indexes (overview §4's `research_status`, `prospects_stage`, `demos_place`, `messages_place` cover it).
  Grade counts and facets run only when `page = 1`.
- API responses never include `leads.audit` or any HTML; message bodies cut to 5,000 characters, review text to 600.
- `pick` step: `everyMinutes: 30`, acts from 07:00 UK, dedupe `pick:YYYY-MM-DD`.
- Re-queuing research is stage 2's "Research is wrong" route (it holds the 30-minute fire guard); this stage adds no
  research button or route of its own.
- Stored timestamps and todo `due_at` use the shared `iso(date)` format (`YYYY-MM-DDTHH:MM:SSZ`, no milliseconds),
  never `.toISOString()`. In-app links use `/#/…`.
- Commits: `TRAILER=$'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_017h4iwgwaGCvQ5f9mmF4rDY'`
  then `git commit -m "<subject>" -m "$TRAILER"`. No push until all of Perfect when 1 passes.

## Review Focus

1. **`A+` in URLs:** a raw `+` decodes to a space, so `grade=A+` silently becomes `A`. Test in Task 1
   (`parseLeadFilters` maps `ap`→`A+`, drops `A ` and unknown tokens).
2. **Search input with SQL wildcards/quotes** (`100%`, `o'neill`, `a_b`, 500 chars): Task 1 tests `likePattern`;
   Task 3 tests that `q=100%` matches only names containing "100%".
3. **Duplicate rows from joins** (two demos, many messages, two calls per lead): Task 3 test "a lead with two demos
   and three messages appears once"; total stays correct.
4. **Scraped/inbound text as HTML** (names, review text, message bodies, `javascript:` URLs, quotes in attributes):
   Task 7 escaping tests.
5. **UK clock boundaries** (weekend price at 00:30 Saturday BST = Friday UTC, which stage 0's `offer.test.mjs`
   covers and Task 7's call-script tests rely on; 07:00 pick across the 25 Oct 2026 clock change): Task 6 tests.

---

Prices, `GUARANTEE` and `offerFor` are stage 0's `_lib/offer.js` (01 Task 6). This file never creates or edits
`offer.js` or `offer.test.mjs`; it only imports `offerFor`, `GUARANTEE` and `formatPounds`.

### Task 1: Pure shortlist rules (`shortlist.js`)

**Files:** Create `control-room/functions/_lib/shortlist.js`; Test `control-room/tests/shortlist.test.mjs`.

**Interfaces:**
- Consumes: `addUkDays(ukDateStr, n)` from `_lib/ukTime.js`; `mailboxCap(mailbox, ukToday)` from `_lib/mail/capacity.js`.
- Produces:
  - `GRADES = ["A+","A","B","C","D"]`, `GRADE_TOKENS = {ap:"A+", a:"A", b:"B", c:"C", d:"D", none:null}`
  - `STAGE_TOKENS = ["ready","emailed","viewed","replied","needs_nik","call_booked","won","lost","none"]`
  - `STAGE_LABELS = {ready:"Ready to email", emailed:"Emailed", viewed:"Opened demo", replied:"Replied", needs_nik:"Needs you", call_booked:"Call booked", won:"Won", lost:"Lost", none:"Not contacted"}`
  - `PAGE_SIZE = 50`
  - `parseLeadFilters(searchParams) → {view: "ready"|"all", grades: string[]|null, trade: string|null, town: string|null, email: boolean|null, stages: string[]|null, researched: boolean|null, q: string, excluded: boolean, job: string|null, page: number}` (grades hold grade values, `"none"` for not graded)
  - `likePattern(q) → string` (`%…%` with `\ % _` escaped)
  - `firstEmailRoom({cap, sent, followupsDue, firstQueued}) → number`
  - `warmupFrom(mailboxes, ukToday) → "YYYY-MM-DD"|null`
  - `readyGrades(room, top) → ["A+","A"] | ["A+","A","B"]`
  - `capacityBanner(c) → {tone: "warn"|"info"|"ok", text: string, link: {href, label}|null}` where
    `c = {mailboxes, paused: [{address, reason}], cap, sent, followupsDue, firstQueued, room, warmupFrom}`
  - `pickTitle({top, b, room, bIncluded}) → string|null`
  - `isHot(prospect, now) → boolean`: the one hot rule for every stage (stage 4's `hotStep` imports it): stage is
    `emailed` or `viewed`, no `last_inbound_at`, and views ≥ 2 or a view in the last 24 h

- [ ] **Step 1: Write the failing test** — `shortlist.test.mjs`:
  ```js
  const P = (s) => parseLeadFilters(new URLSearchParams(s));
  test("filters parse safely", () => {
    assert.equal(P("").view, "ready");
    assert.deepEqual(P("view=all&grade=ap,a,none,zz").grades, ["A+", "A", "none"]);
    assert.equal(P("grade=A+").grades, null);                   // raw + is a space: dropped, not "A"
    assert.deepEqual(P("stage=ready,none,hot").stages, ["ready", "none"]);
    assert.equal(P("q=" + "x".repeat(500)).q.length, 100);
    assert.deepEqual([P("email=1").email, P("email=0").email, P("email=x").email], [true, false, null]);
    assert.deepEqual([P("page=0").page, P("page=abc").page, P("page=3").page], [1, 1, 3]);
  });
  test("like patterns are literal", () => {
    assert.equal(likePattern("100%_a\\b"), "%100\\%\\_a\\\\b%");
  });
  test("room and banner", () => {
    const c = { mailboxes: 1, paused: [], cap: 10, sent: 0, followupsDue: 7, firstQueued: 0, warmupFrom: null };
    c.room = firstEmailRoom(c);
    assert.equal(c.room, 3);
    assert.deepEqual(capacityBanner(c), { tone: "ok", text: "You can send 3 first emails today (10 a day, 7 follow-ups already due).", link: null });
    const full = { ...c, sent: 2, firstQueued: 1 }; full.room = firstEmailRoom(full);   // 10 − 2 − 7 − 1 = 0
    assert.equal(capacityBanner(full).text,
      "No room for more first emails today (10 a day, 7 follow-ups already due, 2 already sent, 1 first email waiting to go). The next ones can go tomorrow.");
    assert.equal(firstEmailRoom({ cap: 5, sent: 0, followupsDue: 9, firstQueued: 0 }), 0);
    assert.equal(capacityBanner({ ...c, cap: 10, sent: 3, followupsDue: 7, room: 0 }).text,
      "No room for more first emails today (10 a day, 7 follow-ups already due, 3 already sent). The next ones can go tomorrow.");
    assert.deepEqual(capacityBanner({ mailboxes: 0, paused: [], cap: 0, sent: 0, followupsDue: 0, firstQueued: 0, room: 0, warmupFrom: null }),
      { tone: "warn", text: "Add your mailbox on Setup to start emailing.", link: { href: "#/setup", label: "Open Setup" } });
    assert.equal(capacityBanner({ ...c, paused: [{ address: "nik@aetoswebsites.com", reason: "2 hard bounces in 7 days" }], cap: 0, room: 0 }).text,
      "Sending is paused: 2 hard bounces in 7 days. Fix it on Setup.");
    assert.equal(capacityBanner({ ...c, cap: 0, room: 0, warmupFrom: "2026-11-03" }).text,
      "Your mailbox is warming up. First emails can go from Tue 3 Nov.");
    assert.equal(capacityBanner({ ...c, cap: 10, followupsDue: 0, sent: 0, firstQueued: 1, room: 9 }).text,
      "You can send 9 first emails today (10 a day, 1 first email waiting to go).");
  });
  test("warm-up date", () => {
    assert.equal(warmupFrom([{ role: "cold", status: "active", started_on: "2026-10-20", cap_override: null }], "2026-10-21"), "2026-11-03");
    assert.equal(warmupFrom([], "2026-10-21"), null);
  });
  test("B joins only with spare room", () => {
    assert.deepEqual(readyGrades(3, 8), ["A+", "A"]);
    assert.deepEqual(readyGrades(3, 3), ["A+", "A"]);
    assert.deepEqual(readyGrades(4, 3), ["A+", "A", "B"]);
  });
  test("pick title", () => {
    assert.equal(pickTitle({ top: 8, b: 5, room: 3, bIncluded: false }), "8 A-grade leads ready: you can send 3 first emails today");
    assert.equal(pickTitle({ top: 1, b: 0, room: 1, bIncluded: false }), "1 A-grade lead ready: you can send 1 first email today");
    assert.equal(pickTitle({ top: 0, b: 4, room: 3, bIncluded: true }), "4 B-grade leads ready: you can send 3 first emails today");
    assert.equal(pickTitle({ top: 0, b: 4, room: 0, bIncluded: false }), null);
    assert.equal(pickTitle({ top: 0, b: 0, room: 5, bIncluded: true }), null);
  });
  test("hot flag", () => {
    const now = new Date("2026-10-21T12:00:00Z");
    assert.equal(isHot({ stage: "viewed", views: 2, last_view_at: "2026-10-10T00:00:00Z" }, now), true);
    assert.equal(isHot({ stage: "viewed", views: 1, last_view_at: "2026-10-21T02:00:00Z" }, now), true);
    assert.equal(isHot({ stage: "viewed", views: 1, last_view_at: "2026-10-19T02:00:00Z" }, now), false);
    assert.equal(isHot({ stage: "replied", views: 5, last_view_at: "2026-10-21T02:00:00Z", last_inbound_at: "2026-10-21T03:00:00Z" }, now), false);
    assert.equal(isHot({ stage: "won", views: 5, last_view_at: "2026-10-21T02:00:00Z" }, now), false);
    assert.equal(isHot({ stage: "emailed", views: 2, last_view_at: "2026-10-10T00:00:00Z" }, now), true);
    assert.equal(isHot({ stage: "call_booked", views: 5, last_view_at: "2026-10-21T02:00:00Z" }, now), false);
    assert.equal(isHot({ stage: "needs_nik", views: 5, last_view_at: "2026-10-21T02:00:00Z" }, now), false);
  });
  ```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/shortlist.test.mjs` → fails: cannot
  find module `../functions/_lib/shortlist.js`.
- [ ] **Step 3: Implement the exports in `control-room/functions/_lib/shortlist.js`** — tokens match exactly (no
  trimming or case folding, so `A ` is dropped, not read as `A`); `warmupFrom` scans offsets
  0…60 with `addUkDays` and returns the first day where any `role = 'cold'` mailbox has `mailboxCap > 0`; banner rows
  checked in the spec's order; dates formatted with `toLocaleDateString("en-GB", {weekday:"short", day:"numeric",
  month:"short", timeZone:"UTC"})` on `YYYY-MM-DDT12:00:00Z`; plurals by `n === 1`.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/shortlist.test.mjs` → PASS (7 tests).
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/shortlist.js control-room/tests/shortlist.test.mjs` +
  `git commit -m "Shortlist: filter parsing, first-email room, banner and pick wording" -m "$TRAILER"`.

### Task 2: Follow-ups due today (`followupsDueToday`)

**Files:** Create `control-room/functions/_lib/followups.js` (stage 6 modifies this file and keeps this export and
its test); Test `control-room/tests/followups-due.test.mjs`.

**Interfaces:**
- Consumes: `ukDate`, `addUkDays`, `ukToUtc` from `_lib/ukTime.js`; `fakeD1()` from `tests/helpers/fakeD1.mjs`.
- Produces: `followupsDueToday(DB, now) → Promise<number>` = follow-up messages with status `queued` (a `sending` one
  is already counted by stage 0's `sentToday`) + prospects whose `next_followup_at` is before the end of today (UK) —
  i.e. `< ukToUtc(addUkDays(ukDate(now), 1), "00:00")`. (Prospects with `next_followup_at` NULL are stopped/finished
  and never count.)

- [ ] **Step 1: Write the failing test** — `followups-due.test.mjs`: seed (now = `2026-10-21T08:00:00Z`) prospects
  with `next_followup_at` `2026-10-21T06:00:00Z`, `2026-10-21T22:30:00Z` (23:30 BST, still today),
  `2026-10-21T23:30:00Z` (00:30 BST tomorrow), NULL; one `messages` row kind `followup` status `queued`, one kind
  `followup` status `sending` (counted in `sentToday`, not here), one kind `followup` status `sent`, one kind `first`
  status `queued`. `assert.equal(await followupsDueToday(DB, now), 3)`.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/followups-due.test.mjs` → fails: cannot
  find module `../functions/_lib/followups.js`.
- [ ] **Step 3: Implement `followupsDueToday(DB, now)` in `control-room/functions/_lib/followups.js`** — two COUNT
  queries in one `DB.batch`, summed. File header comment: "Stage 6 adds the schedule and stop rules here; keep this
  export and its test."
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/followups-due.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/followups.js control-room/tests/followups-due.test.mjs`
  + `git commit -m "Shortlist: count follow-ups due today" -m "$TRAILER"`.

### Task 3: List query, capacity and ready counts (`shortlist-db.js`)

**Files:** Create `control-room/functions/_lib/shortlist-db.js`, `control-room/tests/helpers/shortlistSeed.mjs`;
Test `control-room/tests/shortlist-db.test.mjs`.

**Interfaces:**
- Consumes: Task 1 exports; `followupsDueToday` (Task 2); `sentToday(DB, now)` from `_lib/mail/outbox.js` (counts
  `sent` today plus any `sending`); `mailboxCap`; `ukDate`; `fakeD1()`.
- Produces:
  - `capacityNow(DB, now) → Promise<{mailboxes, paused, cap, sent, followupsDue, firstQueued, room, warmupFrom, banner}>`
    (stage 6 Task 6 later caps `room` with `roomForFirsts(DB, now).total` inside this function)
  - `readyCounts(DB, now, room) → Promise<{top, b, b_included, grades, waiting_demo}>`
  - `listLeads(DB, filters, now) → Promise<{rows, total, page, pages, grade_counts: {"A+","A","B","C","D","none"} | null, view_counts: {ready, all} | null, facets: {trades: [{value, n}], towns: [{value, n}]} | null, capacity, ready}>`
  - Row shape: `{place_id, name, trade, town, phone, website, rating, review_count, quality_score, excluded, grade, grade_reason, research_status, email, suppressed, stage, stage_label, views, last_view_at, hot, demo_slug, top_issue, owner_first}` (`owner_first` only when `research.owner.confident`; `top_issue` = `json_extract(leads.issues,'$[0]')`)
  - `READY_SQL` (string fragment, binds `:now` as `?1`) for reuse by stage 6.
  - Seed helpers in `shortlistSeed.mjs`: `seedLead(DB, o)`, `seedResearch(DB, o)`, `seedProspect(DB, o)`,
    `seedDemo(DB, o)`, `seedMailbox(DB, o)`, `seedMessage(DB, o)`, `seedSuppression(DB, value, kind)`; each fills
    required columns with defaults and returns the row.

The ready rule and sort, exactly:
```sql
-- READY_SQL (aliases: l = leads, r = research, p = prospects)
l.excluded = 0 AND r.status = 'done' AND r.too_big = 0
AND p.stage = 'ready' AND COALESCE(p.email, '') <> ''
AND EXISTS (SELECT 1 FROM demos d WHERE d.place_id = l.place_id AND d.expires_at > ?1)
AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.value IN
    (lower(p.email), lower(substr(p.email, instr(p.email, '@') + 1)), COALESCE(l.company_number, '')))
-- plus: AND r.grade IN (<readyGrades(room, top)>)
ORDER BY CASE r.grade WHEN 'A+' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 5 END,
         l.quality_score DESC, l.rating DESC, l.place_id
```
Rows come from one `SELECT … FROM leads l LEFT JOIN research r ON r.place_id = l.place_id LEFT JOIN prospects p ON
p.place_id = l.place_id`, with `demo_slug` as a correlated `(SELECT slug FROM demos … expires_at > ?1 ORDER BY
created_at DESC LIMIT 1)`, `suppressed` as the NOT EXISTS above inverted, `COUNT(*) OVER () AS total`, `LIMIT 50
OFFSET (page−1)×50`.

- [ ] **Step 1: Write the failing test** — `shortlist-db.test.mjs` (now = `2026-10-21T08:00:00Z`; mailbox
  `started_on: "2026-08-01"` → cap 10):
  - `test("ready view")`: seed 12 leads — qualifying A+ (score 60), A (score 80), A (score 50); and nine that each
    break exactly one rule (all else qualifying): grade C; grade B (room 3 ≤ top 3); excluded = 1; `too_big = 1`; research `queued`; prospect stage `emailed`; no
    prospect row; expired demo only; email suppressed as domain `EXAMPLE.co.uk` stored lower-case `example.co.uk`
    with prospect email `Joe@Example.co.uk`. Stub follow-ups so room = 3 (7 queued follow-up messages).
    `assert.deepEqual(rows.map(r => r.grade + ":" + r.quality_score), ["A+:60", "A:80", "A:50"])`;
    `assert.equal(ready.top, 3)`; `assert.equal(ready.b_included, false)`.
  - `test("B joins with spare room")`: same data with 0 follow-ups due (room 10) → B row appears 4th;
    `ready.b_included === true`.
  - `test("waiting for demo")`: an A lead, research done, best_email set, no prospect → `ready.waiting_demo === 1`.
  - `test("all view filters")`: `grades: ["A+"]` returns only A+; `grades: ["none"]` returns ungraded (no research
    row and research with NULL grade); `stages: ["none"]` returns leads with no prospect; `email: false` returns
    leads with no address anywhere; `researched: true` includes `skipped`; `q: "100%"` matches "100% Roofing" and
    not "1000 Roofs"; `q: "o'neill"` matches "O'Neill Plumbing".
  - `test("a lead with two demos and three messages appears once")`: `rows.length === 1`, `total === 1`, `demo_slug`
    is the live one.
  - `test("grade counts")`: page 1 `grade_counts` sums to the total with excluded on; page 2 returns
    `grade_counts === null`.
  - `test("capacity")`: cap 10, 7 queued follow-ups → `room 3`, banner text as Task 1; after seeding 2 `sent` first
    messages today and 1 `queued` first → `room` 0 (10 − 2 − 7 − 1); no mailboxes → `banner.link.href === "#/setup"`.
  - `test("statement budget")`: wrap `DB.prepare` to count; 60 seeded leads; `listLeads(DB, parseLeadFilters(new
    URLSearchParams("view=all")), now)` → count ≤ 12 and `rows.length === 50`, `pages === 2`.
  - `test("no audit or html")`: a lead whose `audit` holds `{"pages_html":"<html>…"}` → `JSON.stringify(result)`
    has no `"audit"` and no `<html`.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/shortlist-db.test.mjs` → fails: cannot
  find module `../functions/_lib/shortlist-db.js`.
- [ ] **Step 3: Implement `capacityNow`, `readyCounts`, `listLeads`, `READY_SQL` in
  `control-room/functions/_lib/shortlist-db.js`** — `capacityNow` reads `mailboxes WHERE role = 'cold'`, calls
  `sentToday`, `followupsDueToday`, counts queued first messages, then `firstEmailRoom`, `warmupFrom`,
  `capacityBanner`; `readyCounts` is one grouped query over `READY_SQL` without the grade clause (A+/A → `top`, B →
  `b`) plus the waiting-demo count; `listLeads` builds the WHERE from filters (Ready adds `READY_SQL` + grade IN
  `readyGrades`), runs rows, and on page 1 grade counts (all filters except grade), view counts and facets
  (`SELECT trade, COUNT(*) … GROUP BY trade`, same for `search_town`).
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/shortlist-db.test.mjs` → PASS (9 tests).
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/shortlist-db.js control-room/tests/helpers/shortlistSeed.mjs control-room/tests/shortlist-db.test.mjs`
  + `git commit -m "Shortlist: lead list, ready rule and today's sending room" -m "$TRAILER"`.

### Task 4: Drawer payload (`leadDetail`)

**Files:** Modify `control-room/functions/_lib/shortlist-db.js`; Test `control-room/tests/shortlist-db.test.mjs`
(add tests).

**Interfaces:**
- Consumes: `offerFor(now)` and `GUARANTEE` from stage 0's `_lib/offer.js`; `isHot`, `STAGE_LABELS` (Task 1);
  `parseResearch(row)` from stage 2's `_lib/research.js`; `parseJson` from `_lib/util.js`.
- Produces: `leadDetail(DB, placeId, now) → Promise<Detail|null>`:
  ```
  { lead: {place_id, name, trade, town, search_town, address, postcode, phone, website, maps_url, rating, review_count,
           quality_score, company_number, excluded, exclude_reason, issues[], findings[], socials{}, reviews[≤3 {author, rating, text}],
           notes, first_seen_at},
    research: null | parseResearch(row)   // stage 2's parsed shape: {status, grade, points: {need, means, reach, fit,
                                          //   total, capped, reasons}, grade_reason, angle[], opener, owner, best_email,
                                          //   best_email_why, emails[], site_review, too_big, notes, researched_at, …}
    research_waiting: number,             // research rows with status 'queued' (the card's "N leads waiting")
    prospect: null | {stage, stage_label, stage_at, email, greet_name, first_sent_at, followup_step, next_followup_at,
                      views, last_view_at, last_inbound_at, lost_reason, hot},
    demo: null | {slug, url: "/d/<slug>", expires_at, template: string|null},
    map_rank: null | {scan_id, keyword, avg_rank, top3_pct, found_pct, updated_at},
    messages: [{id, direction, kind, step, author, from_addr, to_addr, subject, body, status, sent_at, received_at, created_at, class}],
    calls: [{slot_at, status}],
    suppressed: boolean,
    offer: offerFor(now),                 // {weekend, full: {label, build, monthly, freeDays, wasBuild?}, website, banner}
    guarantee: GUARANTEE }                // {headline, section}
  ```
  The research row goes through `parseResearch` (bad JSON → `null`/`[]`, never a throw); other JSON columns through
  `parseJson`. `findings` and `reviews` come from `json_extract(l.audit, '$.findings')` / `'$.reviews'`; `audit`
  itself is never selected. `demo.url` is relative (`/d/<slug>`), so Nik's own visits from the Control Room host
  never count. `demo.template` is stage 4's `templateIdFor(lead.trade)`, loaded only when a live demo exists with
  `await import("./demo/data.js").then(m => m.templateIdFor(trade)).catch(() => null)` (null before stage 4 ships,
  which hides the Preview toggle).

- [ ] **Step 1: Write the failing test** — add to `shortlist-db.test.mjs`:
  - `test("lead detail")`: seed lead + research (`points: {"need":4,"means":3,"reach":5,"fit":4,"total":16,
    "capped":null,"reasons":{"need":"No website","means":"61 reviews","reach":"Owner's own email","fit":"Landscaper"}}`,
    owner `{"first":"Mark","full":"Mark Dean","source_url":"https://x.co.uk/about","confident":true}`) + 2 more
    `queued` research rows + prospect `ready` + live demo `green-leaf` + map rank + 5 reviews in audit + 40 messages.
    Assert `d.research.points.reach === 5`, `d.research.points.reasons.reach === "Owner's own email"`,
    `d.research_waiting === 2`, `d.demo.url === "/d/green-leaf"`, `d.lead.reviews.length === 3`,
    `d.messages.length === 40` and oldest first, `d.offer.full.monthly === 24900`,
    `d.guarantee.headline === "Top 3 in Google search results in 90 days. GUARANTEED."`, `"audit" in d.lead === false`.
  - `test("detail budget")`: counting wrapper → ≤ 4 statements for that lead (lead row, with `research_waiting` as a
    scalar subquery, + one batch of demo, messages, calls counted as 3 statements → total ≤ 4).
  - `test("bad json and missing lead")`: research `angle = "not json"` → `d.research.angle` deep-equals `[]`;
    `leadDetail(DB, "nope", now)` → `null`.
  - `test("long bodies are cut")`: a 9,000-character body → returned length ≤ 5,000 + `"…"`.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/shortlist-db.test.mjs` → fails:
  `leadDetail` is not exported.
- [ ] **Step 3: Implement `leadDetail(DB, placeId, now)` in `control-room/functions/_lib/shortlist-db.js`** — first
  statement joins leads/research/prospects/lead_map_rank with the suppression EXISTS and
  `(SELECT COUNT(*) FROM research WHERE status = 'queued') AS research_waiting`; if found, one `DB.batch` of live
  demo, messages (`ORDER BY created_at LIMIT 100`), calls (`ORDER BY slot_at DESC LIMIT 5`).
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/shortlist-db.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/shortlist-db.js control-room/tests/shortlist-db.test.mjs`
  + `git commit -m "Shortlist: one-request lead panel data" -m "$TRAILER"`.

### Task 5: Routes and Not a fit

**Files:** Modify `control-room/functions/api/leads.js`; Move `control-room/functions/api/leads/[id].js` →
`control-room/functions/api/leads/[id]/index.js`; Create `control-room/functions/api/leads/[id]/not-a-fit.js`;
Modify `control-room/functions/_lib/shortlist-db.js`; Test `control-room/tests/leads-api.test.mjs`.

**Interfaces:**
- Consumes: `listLeads`, `leadDetail`, `parseLeadFilters`; `db`, `json`, `bad`, `now` from `_lib/util.js`; `ukDate`
  from `_lib/ukTime.js`.
- Produces:
  - `GET /api/leads?<filters>` → `listLeads` result; `GET /api/leads/:id` → `{detail}` or 404
    `{error: "That lead isn't in the database any more. Close this panel and refresh."}`.
  - `PATCH /api/leads/:id {notes}` → `{notes}` (status editing removed; any other field → 400 "Only notes can be
    changed here.").
  - `POST /api/leads/:id/not-a-fit {reason}` → `{ok: true}`; 400 "Say why in a few words (3 to 200 characters)."; 409
    "Already emailed. Stop the follow-ups from the conversation instead." when `prospects.stage` is set and not `ready`.
  - `POST /api/leads/:id/research-again` → `{queued: true, fired: boolean, message}` (messages exactly as the spec).
  - In `shortlist-db.js`: `markNotFit(DB, placeId, reason, now) → Promise<{ok: true} | {error, status}>` and
    `researchAgain(DB, placeId, now, {fire = fireRoutine} = {}) → Promise<{queued, fired, message}>`.

- [ ] **Step 1: Write the failing test** — `leads-api.test.mjs`, calling each handler with
  `{request: new Request(url, init), env: {DB}, params: {id}}`:
  - `GET /api/leads?view=all&grade=ap` → 200, every row `grade === "A+"`.
  - `GET /api/leads/<id>` → 200 with `detail.lead.place_id`; unknown id → 404 with the exact message.
  - `PATCH {notes: "Call Friday"}` → 200; `PATCH {status: "won"}` → 400 "Only notes can be changed here."
  - Not a fit on a `ready` A lead with `{reason: "Wrong trade"}` → 200; afterwards `listLeads(view ready)` excludes
    it, `research.status === "skipped"`, `research.notes` starts with `"Not a fit (Nik): Wrong trade\n"`, prospects
    row gone. `{reason: "x"}` → 400 exact message. On an `emailed` lead → 409 exact message.
  - Research again with a `fire` stub returning `{ok: true}` → `fired === true`, message "Queued. Claude has been
    asked to research it now. Check back in 15 minutes.", `research.status === "queued"`, old `grade` still stored.
    Second call within 30 min (a `routine_fires` row for `research` exists) → `fired === false`, message "Queued.
    Claude will pick it up on its current or next run.", stub not called. Stub returning `{ok: false, error: "HTTP
    400"}` → message "Queued, but Claude couldn't be started (HTTP 400). It will be researched at 06:47 tomorrow."
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/leads-api.test.mjs` → fails:
  `markNotFit` not exported / `not-a-fit.js` missing.
- [ ] **Step 3: Implement the routes and `markNotFit` / `researchAgain`** — handlers parse with
  `parseLeadFilters(new URL(request.url).searchParams)` and pass `new Date()`; `markNotFit` upserts research
  (`INSERT … ON CONFLICT(place_id) DO UPDATE`) and deletes a `ready` prospect in one `DB.batch`; `researchAgain`
  upserts `status='queued', queued_at`, checks `routine_fires` for `routine = 'research' AND at > now − 30 min`, then
  calls `fire(DB, "research", "research queued: 1 lead (Nik asked)")`.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/leads-api.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/api/leads.js control-room/functions/api/leads control-room/functions/_lib/shortlist-db.js control-room/tests/leads-api.test.mjs`
  + `git commit -m "Shortlist: leads API, Not a fit and Research again" -m "$TRAILER"`.

### Task 7: Morning `pick` todo (tick step)

**Files:** Modify `control-room/functions/_lib/shortlist-db.js`, `control-room/functions/_lib/tick.js`; Test
`control-room/tests/pick.test.mjs`.

**Interfaces:**
- Consumes: `capacityNow`, `readyCounts` (Task 4); `pickTitle` (Task 2); `ukParts`, `ukDate`, `ukToUtc`;
  `addTodo`, `closeTodos` from `_lib/todo.js`; `getSetting`, `setSetting` from `_lib/settings.js`.
- Produces: `pickStep({DB, env, now}) → Promise<string>` and the STEPS entry `{name: "pick", everyMinutes: 30, run: pickStep}`
  placed immediately before `daily_find`.

Algorithm (order matters):
```
if ukParts(now).hh < 7 → return "before 07:00"
today = ukDate(now); cap = capacityNow(DB, now); counts = readyCounts(DB, now, cap.room)
title = pickTitle({top: counts.top, b: counts.b, room: cap.room, bIncluded: counts.b_included})
if getSetting(DB, "pick:last") !== today → closeTodos(DB, "pick:"); setSetting(DB, "pick:last", today); fresh = true
if !title → closeTodos(DB, "pick:" + today); return "nothing to pick"
if fresh → addTodo(DB, {kind: "pick", title, detail: "Open Leads → Ready to email, and write each first email from the lead's panel.",
                        link: "/#/leads?view=ready", due_at: ukToUtc(today, "07:00").toISOString(), dedupe: "pick:" + today})
else    → UPDATE todos SET title = ? WHERE dedupe = ? AND status = 'open'
return title
```

- [ ] **Step 1: Write the failing test** — `pick.test.mjs` (A ready leads seeded ×8, mailbox cap 10, 7 queued
  follow-ups):
  - BST: `pickStep` at `2026-10-20T05:59:00Z` → `"before 07:00"`, no todos; at `2026-10-20T06:00:00Z` → one open
    todo `{kind: "pick", title: "8 A-grade leads ready: you can send 3 first emails today", link: "/#/leads?view=ready",
    due_at: "2026-10-20T06:00:00.000Z", dedupe: "pick:2026-10-20"}`.
  - Same day at 10:00 UK: 2 ready prospects moved to `emailed` with 2 `sent` first messages → title updates to
    "6 A-grade leads ready: you can send 1 first email today"; one more the same way → room 0 → the todo's status is
    no longer `open`.
  - GMT: at `2026-10-26T06:59:00Z` → `"before 07:00"`; at `2026-10-26T07:00:00Z` → the earlier `pick:2026-10-20`
    todo is closed and `pick:2026-10-26` is open with `due_at "2026-10-26T07:00:00.000Z"` (re-seed today's room).
  - `STEPS.map(s => s.name)` has `"pick"` directly before `"daily_find"`.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/pick.test.mjs` → fails: `pickStep` is
  not exported.
- [ ] **Step 3: Implement `pickStep` in `control-room/functions/_lib/shortlist-db.js` and register it in
  `control-room/functions/_lib/tick.js`** — the algorithm above.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/pick.test.mjs` → PASS; full suite
  `node --test control-room/tests/*.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/shortlist-db.js control-room/functions/_lib/tick.js control-room/tests/pick.test.mjs`
  + `git commit -m "Shortlist: morning pick todo" -m "$TRAILER"`.

### Task 8: Call script update and the pure panel renderer

**Files:** Create `control-room/public/js/html.js`, `control-room/public/js/leadview.js`; Modify
`control-room/public/js/lib.js` (re-export from `html.js`), `control-room/public/js/callscript.js`; Test
`control-room/tests/callscript.test.mjs` (update), `control-room/tests/leadview.test.mjs`.

**Interfaces:**
- Consumes: the `Detail` and row shapes (Tasks 4–5); `offer` object shape (Task 1); `STAGE_LABELS` values (copied as
  data in the payload: `stage_label`).
- Produces:
  - `html.js`: `esc(v)`, `safeUrl(u)`, `icon(name)` (moved verbatim from `lib.js`; `lib.js` does
    `export { esc, safeUrl, icon } from "./html.js"`).
  - `callscript.js`: `callScript(lead, {sender = "Nik", offer, today = new Date()}) → [{title, lines, objection?}]`
    where `lead = {name, trade, town, rating, review_count, findings, map_rank, owner_first, email, demo_url, angle}`;
    throws `Error("callScript needs opts.offer from /api/leads/:id")` without `offer`. `shortName` unchanged.
  - `leadview.js`: `POINT_LABELS = {need: "Needs help online", means: "Can afford it", reach: "We can reach the owner", fit: "Our kind of business"}`,
    `gradeBadge(grade) → html`, `leadRowHtml(row, {selected}) → html`, `bannerHtml(banner) → html`,
    `filterBarHtml(query, data) → html`, `scriptLead(detail, origin) → object`,
    `drawerHtml(detail, {capacity, sender, origin, now}) → html`, `threadHtml(messages) → html`.

- [ ] **Step 1: Write the failing tests**
  - `callscript.test.mjs` (update): `LEAD` gains `owner_first: "Mark"`, drops `director_first_name`/`audit`; every
    call passes `offer: offerFor(day)` (import from `../functions/_lib/offer.js`); the old `/front page of Google/` assertion is removed.
    - name: `owner_first: null` → no "Mark", has "whoever runs".
    - weekday (`2026-10-07T10:00:00Z`): `/£1,950/`, `/first 60 days free/`, `/£249/`.
    - weekend (`2026-10-10T10:00:00Z`): `/around £2,000/`, `/£1,750/`, `/90 days free/`.
    - guarantee: text contains `GUARANTEE.headline` and `GUARANTEE.section` verbatim; doesNotMatch
      `/(keep working|work) for free until you are|\bSEO\b/i` (pitch and objections both updated).
    - angle: `angle: [{fact: "No photos of their work on Google", source_url: "https://g.co/x"}]` → "Before you dial"
      contains that fact.
    - demo rule unchanged; objections test unchanged; `assert.throws(() => callScript(LEAD, {}), /needs opts.offer/)`.
    - `assert.doesNotMatch(readFileSync(new URL("../public/js/callscript.js", import.meta.url), "utf8"), /£\s?\d/)`.
  - `leadview.test.mjs`:
    - escaping: `leadRowHtml({...row, name: "<img src=x onerror=alert(1)>"})` contains `&lt;img` and no `<img`;
      `drawerHtml` with `lead.website: "javascript:alert(1)"` contains no `href="javascript:`; a review text
      `"</p><script>x</script>"` and a message body `"<b>hi</b>"` appear escaped.
    - buttons: stage `ready` + `capacity.room 3` → contains `Write first email` and `Not a fit`; stage `emailed` →
      neither; stage `ready` + room 0 → `No room left today` and the button is `disabled`; `capacity.mailboxes 0` →
      `Add a mailbox first`.
    - grade card: `points {need:4, means:3, reach:5, fit:4}` → contains `Needs help online` and `5/5`; `research
      null` → `Not graded yet. Claude researches new leads every morning at 06:47.`
    - owner: `confident: false` → `Name not confirmed: emails say "Hi,"` (escaped quotes) and `scriptLead(d).owner_first === null`.
    - `bannerHtml({tone: "warn", text: "Add your mailbox on Setup to start emailing.", link: {href: "#/setup", label: "Open Setup"}})`
      contains `href="#/setup"`.
    - chips: `filterBarHtml({view: "ready", grades: ["A+","A"]}, {grade_counts: {"A+": 4, "A": 12, "B": 30, "C": 0, "D": 0, none: 171},
      ready: {b_included: false}})` contains `A+ <span class="n">4</span>`, marks B with `Spare room only`, and has no
      C, D or Not graded chip; with `view: "all"` all six chips and the stage chips appear.
- [ ] **Step 2: Run them to verify they fail** — `node --test control-room/tests/callscript.test.mjs
  control-room/tests/leadview.test.mjs` → callscript fails on the guarantee/offer assertions; leadview fails: cannot
  find module `../public/js/leadview.js`.
- [ ] **Step 3: Implement** — move `esc`/`safeUrl`/`icon` into `html.js`; in `callscript.js` replace hard-coded prices
  with `gbp`-style formatting of `opts.offer` pence (local `pounds(pence)` helper), weekend from `offer.weekend`, the
  pitch line from the spec, objection answers quoting `offer.guarantee.section`, the "Before you dial" weekend line `Today's a weekend: the weekend deal is on (around
  {anchor} → {build} and {free_days} days free).`, the first-name rule from `lead.owner_first`, and `Angle: {fact}`
  in "Before you dial"; write `leadview.js` render functions using only `esc`/`safeUrl` for any data value (links
  only through `safeUrl`, the demo preview `<iframe>` only built on demand with `src="/d/<slug>?preview=1"` and
  `loading="lazy"`), messages as `<pre class="msg-body">`.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/callscript.test.mjs
  control-room/tests/leadview.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/public/js/html.js control-room/public/js/leadview.js control-room/public/js/lib.js control-room/public/js/callscript.js control-room/tests/callscript.test.mjs control-room/tests/leadview.test.mjs`
  + `git commit -m "Shortlist: call script from offer.js and the lead panel renderer" -m "$TRAILER"`.

### Task 9: Leads page wiring, routes and styles

**Files:** Modify (rewrite) `control-room/public/js/leads.js`; Modify `control-room/public/js/leadview.js`,
`control-room/public/js/app.js`, `control-room/public/js/scraper.js`, `control-room/public/js/home.js`,
`control-room/public/style.css`; Test `control-room/tests/leadview.test.mjs`.

**Interfaces:**
- Consumes: `GET /api/leads`, `GET /api/leads/:id`, `PATCH /api/leads/:id`, `POST …/not-a-fit`,
  `POST …/research-again` (Task 6); `leadview.js` (Task 8); `api`, `state`, `view`, `toast`, `modal`, `pageHead`
  from `lib.js`; stage 6's `openComposer(detail, {onSent})` from `./composer.js` (dynamic import).
- Produces: `leadsPage(params)` and `openLeadDrawer(placeId)` exported from `leads.js`; app routes `#/leads?view=…&job=…`
  and `#/lead/<place_id>`; `state.leadsQuery = {view, grades, trade, town, email, stages, researched, q, excluded, job, page}`
  and `state.capacity`. Pure helpers added to `leadview.js`: `parseRoute(hash) → {page, params: URLSearchParams, leadId: string|null}`
  and `leadsQueryString(query) → string`.

- [ ] **Step 1: Write the failing test** — add to `leadview.test.mjs`:
  ```js
  test("routes", () => {
    assert.deepEqual({ ...parseRoute("#/lead/ChIJ123"), params: undefined }, { page: "leads", leadId: "ChIJ123", params: undefined });
    assert.equal(parseRoute("#/leads?view=all&job=j1").params.get("job"), "j1");
    assert.equal(parseRoute("#/nope").page, "home");
  });
  test("client query string round-trips through the server parser", () => {
    const q = { view: "all", grades: ["A+", "A", "none"], trade: "landscaper", town: null, email: true, stages: ["none"],
      researched: null, q: "o'neill 100%", excluded: false, job: null, page: 2 };
    const back = parseLeadFilters(new URLSearchParams(leadsQueryString(q)));   // from ../functions/_lib/shortlist.js
    assert.deepEqual(back, { ...q });
  });
  ```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/leadview.test.mjs` → fails:
  `parseRoute` / `leadsQueryString` are not exported.
- [ ] **Step 3: Implement** —
  - `leadview.js`: `parseRoute` (known pages as in today's `app.js`, plus `lead/<id>` → `leads`); `leadsQueryString`
    writes only non-default fields, grades as tokens (`A+` → `ap`, `none` → `none`).
  - `leads.js`: builds the URL with `leadsQueryString(state.leadsQuery)`, fetches `/api/leads`, renders banner, tabs, chips, filters, table, pager; search debounced
    300 ms; filter change resets `page` to 1; row click → `openLeadDrawer(id)`; drawer actions call the APIs and
    toast the returned message; **Write first email** does `import("./composer.js").then(m => m.openComposer(detail,
    {onSent: refresh})).catch(() => toast("Writing emails arrives with the next stage."))`; Not a fit dialog via
    `modal()`; Escape closes the drawer (kept).
  - `app.js`: route via `parseRoute(location.hash)`; `leadId` set → `leadsPage(params)` then `openLeadDrawer(leadId)`;
    nav "Leads" stays.
  - `scraper.js`: drop the `leadsTable`/`bindTable` import; a finished run shows "See these {found} leads" →
    `#/leads?view=all&job=<id>`.
  - `home.js`: `openDrawer(lead, …)` → `openLeadDrawer(lead.place_id)`.
  - `style.css`: `.chips`, `.chip.on`, `.chip.off`, `.grade` (A+ gold fill `#C9A13B` on charcoal, A gold outline,
    B/C/D greys), `.banner.ok|info|warn`, `.grade-card`, `.msg`, `.msg-body { white-space: pre-wrap }`, `.pager`;
    gold only as accent (docs/brand.md).
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/leadview.test.mjs` → PASS; full
  `node --test control-room/tests/*.test.mjs` → PASS; `for f in control-room/public/js/*.js; do node --check "$f"; done`
  → no output. Then a local run (`npx wrangler pages dev` in
  `control-room/` with a local D1 seeded by `shortlistSeed.mjs` data): Ready view, chip toggles, paging, drawer from
  a row and from `#/lead/<id>`, Not a fit, Research again, banner with and without a mailbox.
- [ ] **Step 5: Commit** — `git add control-room/public/js/leads.js control-room/public/js/leadview.js control-room/public/js/app.js control-room/public/js/scraper.js control-room/public/js/home.js control-room/public/style.css control-room/tests/leadview.test.mjs`
  + `git commit -m "Shortlist: new Leads page with grade filter, Ready view and lead panel" -m "$TRAILER"`.
  Then `git pull --rebase`, push, and run the live Perfect-when checks 2–6, 9 and 12.

## Cross-stage interfaces

**Produced here (other stages use them):**
- `_lib/offer.js`: `offerFor(date)`, `gbp(pence)`, the price constants and `GUARANTEE {headline, section}` (Task 1).
  Stage 3 is the first in build order to need prices; stages 0 (landing page), 4 (demo/order page), 6, 7, 9 import
  these and must not hard-code prices.
- `_lib/followups.js`: `followupsDueToday(DB, now) → Promise<number>` (Task 3). Stage 6 extends this file and keeps
  the export, its meaning (unsent follow-ups due by the end of UK today) and its test.
- `_lib/shortlist.js`: `isHot(prospect, now)` (stage 4/6 `hot` step should use it), `STAGE_LABELS` (Todo board,
  stage 11 file), `capacityBanner(c)`.
- `_lib/shortlist-db.js`: `capacityNow(DB, now)` (stage 6 composer can show the same room), `READY_SQL`, `leadDetail`
  (the stage 6 composer receives this `Detail` object).
- Tick step `pick` (`everyMinutes: 30`) sits immediately before `daily_find` in overview §8's order.
- Routes `#/lead/<place_id>` (opens the Leads page with that panel) and `#/leads?view=ready|all&job=<id>`; all todo
  links from stages 4–8 use `/#/lead/<place_id>`.
- `public/js/html.js`: `esc`, `safeUrl`, `icon` (importable in node tests); `lib.js` re-exports them.
- `research.status = 'skipped'` with notes starting `Not a fit (Nik): ` means Nik rejected it; stage 2's queue must
  never re-queue a `skipped` lead on its own.

**Assumed from other stages (exact shapes this file relies on):**
- Stage 0: `fakeD1()` from `control-room/tests/helpers/fakeD1.mjs` returns a D1-compatible DB (`prepare/bind/first/
  all/run/batch`) with the full schema (all overview §4 tables) applied; `_lib/tick.js` exports a mutable `STEPS`
  array; `todo.js`, `settings.js`, `ukTime.js`, `mail/capacity.js`, `mail/outbox.js` exactly as overview §8;
  `sentToday` counts only messages with `status = 'sent'`; `suppression.value` is always stored lower-case.
- Stage 2: `research` rows as overview §4; `points` = `{need, means, reach, fit}` integers 0–5, optionally with
  `why: {need, means, reach, fit}` one-line strings (shown when present); `owner.first` set only from a confident
  source when `confident: true`.
- Stage 4: when a lead's demo is ready, it upserts `prospects` to stage `ready` via `nextStage(…, 'demo_ready')` with
  `email` = the address to write to and `greet_name`; the live demo is the newest `demos` row with `expires_at > now`;
  `/d/<slug>?preview=1` renders without recording a view, and views from a logged-in Control Room session never count.
- Stage 6: `control-room/public/js/composer.js` exports `openComposer(detail, {onSent})` where `detail` is the
  `GET /api/leads/:id` payload; first emails are `messages` rows with `kind = 'first'`, `status 'queued'` until sent.

## Questions for Nik

1. **When today's room is used up, can you still write first emails for tomorrow?** Default: no. The button says "No
   room left today", so nothing piles up and every email goes out the morning you write it.
2. **CSV download on the Leads page:** the old page had one; the new flow doesn't need it. Default: dropped (about 20
   lines to bring back if you use it).
