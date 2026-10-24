# Aetos rebuild: overview spec

This is the contract every stage file follows. If a stage file and this file disagree, this file wins. Decisions are
in [decisions.md](decisions.md); researched facts are in [research.md](research.md); the sales and copy rules are in
`docs/playbooks/`. Nik reads the "Plain English" boxes; the build reads everything.

> **Plain English:** One website you log into (the Control Room) runs the whole business. It finds businesses, Claude
> researches and grades them, you pick who to email and write the first email, and the system follows up, answers
> replies in your style within minutes, books calls into your 11am slots, takes payment, builds the site and looks
> after the client every month. A "Todo" page shows everything in one place, with red lights if anything breaks.

## 1. Stages and files

| # | Stage | Spec + plan file |
| --- | --- | --- |
| 0 | Foundations: setup page, email sending, receiving, the heartbeat ("tick"), health lights, landing page | [01-foundations.md](01-foundations.md) |
| 1 | Find (filter 1, automatic) | [02-find.md](02-find.md) |
| 2 | Research and grade A+ to D (filter 2, Claude) | [03-research-grade.md](03-research-grade.md) |
| 3 | Shortlist (all leads, grade filter) | [04-shortlist.md](04-shortlist.md) |
| 4 | Demo site per lead | [05-demo.md](05-demo.md) |
| 5–6 | First email (Nik) + automatic follow-ups | [06-email-followups.md](06-email-followups.md) |
| 7–8 | Replies (Claude, in Nik's style) + calls | [07-replies-calls.md](07-replies-calls.md) |
| 9 | Order and pay (Stripe) | [08-order-pay.md](08-order-pay.md) |
| 10 | Build the client's site (incl. chatbot, review booster setup) | [09-build.md](09-build.md) |
| 11 | Monthly care | [10-monthly-care.md](10-monthly-care.md) |
| — | Todo board, weekly KPIs, Money, Map Rank, navigation | [11-todo-kpis.md](11-todo-kpis.md) |

**Build order:** 0 → 1 → 2 → 3 → 4 → 5–6 → 7–8 → 9 → Todo/KPIs → 10 → 11. Each stage ends with its "Perfect when"
checks passing; the next stage doesn't start until they do. The Todo board is built incrementally: every stage adds
its own items to it (section 6), and file 11 adds the board page itself after stage 9.

**Navigation owner:** once file 11 ships, it owns navigation and hash routing (`public/js/nav.js`: `NAV` and
`routeFor`). Files 09 and 10 add their routes to `routeFor` (and `nav.test.mjs`), never to `PAGES` in `app.js`.
Before that, stages add `PAGES` entries in `app.js` (05's and 07's with `nav: false`: routable, not in the nav);
`app.js` routes any first hash segment through `PAGES.find`, unknown → home.

## 2. Architecture

Nothing that already exists in Cloudflare or GitHub changes (Nik's rule: same keys, same database, same project).

```
                       ┌──────────────────────────── Cloudflare ────────────────────────────┐
 Prospect's browser ──►│ Pages project (root control-room/, existing)                       │
 Nik's browser ───────►│   public/            Control Room UI (plain JS, no build step)      │
                       │   functions/         API + demo sites /d/:slug + landing page       │
                       │        │  D1 binding DB → database goldbarwebsites (existing)       │
                       │        ▼                                                           │
                       │   D1 ◄──────────── mail-relay Worker (NEW, folder mail-relay/)      │
                       │                     • cron every 5 min → POST {APP_URL}/api/tick    │
                       │                       ?reason=cron, then …/api/tick?reason=health   │
                       │                     • email() handler → saves raw mail to D1,       │
                       │                       then POST {APP_URL}/api/tick?reason=inbound   │
                       └────────────────────────────────────────────────────────────────────┘
 /api/tick (in Pages) does all timed work: send due emails (SMTP to Namecheap over cloudflare:sockets), process
 inbound mail, fire Claude Routines, start the daily scrape, mark stale jobs. Health (lights, health/setup todos)
 runs in its own invocation, /api/tick?reason=health, straight after each cron tick.

 GitHub Actions (existing): scrape-leads.yml, map-rank.yml (Python engine in lead-manager/, writes D1 over the
 Cloudflare API with the existing secrets). NEW: deploy-relay.yml deploys mail-relay/ with wrangler.

 Claude Routines (Nik's subscription): aetos-research, aetos-reply, aetos-weekly-kpis, aetos-build,
 aetos-monthly-care. Prompts live in routines/*.md. They read and write only through $CONTROL_ROOM_URL/api/agent/*
 with a bearer token held as an environment network secret (research.md → Routines).
```

Why this shape:
- **One codebase for logic.** All business logic lives in Pages Functions (`control-room/functions/_lib/`). The
  relay Worker is ~60 lines and only exists because Pages can't run cron or receive email.
- **No new Cloudflare keys for Nik to manage** (one exception: the client chatbot's Workers AI token, §10). The relay Worker binds the existing D1 by `D1_DATABASE_ID` (already a
  GitHub secret) and is deployed by GitHub Actions with the existing `CLOUDFLARE_API_TOKEN`. If that token lacks
  "Workers Scripts: Edit" and "Email Routing Rules: Edit", the deploy fails with a plain message telling Nik to add
  those two permissions to the same token (one-time).
- **Secrets the app needs are entered on the Setup page**, stored in the `settings` table under keys starting
  `secret:`, never sent back to the browser (write-only fields that show "saved ✓" and a Test button). This is the
  existing pattern for the Stripe webhook secret. Nik never edits Cloudflare variables.
- **`/api/tick` is public but harmless:** it only does work that is already due, takes a D1 lock (`settings`
  key `tick:lock`, 50 s lease), and returns `{ran: false}` if another tick holds it. Calls more than once per 20 s
  return early. It never accepts input except `?reason=`.
- **CPU:** Pages Functions on the free plan get 10 ms CPU per request. Each tick does a bounded amount of work
  (at most 2 SMTP sends, 10 inbound mails with at most ~100 KB of raw MIME parsed, 3 Routine fires) and at most 50 D1
  queries: `runTick` counts them, gives
  each step `ctx.budget` (an object; steps read `ctx.budget.left()`) and never starts a step with fewer than 10 left
  (it reports `"deferred"`); `inbound` stops at 30. `health` runs alone in the `?reason=health` invocation with the
  full 50 (its own gap and lease keys), and every other reason skips it, so nothing is reserved for it. Stage 0
  measures SMTP CPU on the live deploy; if it
  doesn't fit, Nik decides on the $5/month plan (decisions.md). Nothing else in the design changes either way.

## 3. Folder layout

The current code is copied once, untouched, to `legacy/` (stage 0, task 1) and tagged `old-system`. The rebuild then
happens in place, so Cloudflare's Pages root (`control-room`) and the workflows keep working.

```
control-room/
  functions/
    _middleware.js           login gate + public paths + host routing (landing page on the root domain)
    _lib/                    all logic; pure modules have no D1/env access and are unit-tested
      schema.js              generated from lead-manager/schema.sql by scripts/sync_schema.py
      util.js                db(), json(), bad(), now(), parseJson() (kept)
      ukTime.js              UK-time helpers (pure)
      settings.js            getSetting/setSetting/getSecret/setSecret (db)
      health.js              computeLights (pure) + registerLight + healthFromDb (db)
      tick.js                runTick(env, reason) (db)
      routines.js            fireRoutine(DB, name, text) (db + fetch)
      agentAuth.js           requireAgent(request, env, DB) (db)
      offer.js               prices, packages, guarantee wording (pure; owned by stage 0, later stages only add exports)
      mail/
        vendor/worker-mailer.js   vendored worker-mailer 1.3.0 (MIT), header kept
        smtp.js              sendViaSmtp(mailbox, password, message) (sockets)
        compose.js           composeEmail(...) (pure)
        capacity.js          rampCap/mailboxCap/pickMailbox (pure)
        inbound.js           parseHeaders/classifyInbound (pure)
        inbound-db.js        processInbound (db; the tick's inbound step)
        outbox.js            queueMessage/dispatchDue/sentToday (db)
      stages.js              prospect stage machine (pure)
      prospects.js           applyStageEvent, suppress, isSuppressed (db)
      grade.js               gradeFrom(points) (pure)
      followups.js           follow-up schedule + stop rules (pure) + db helpers
      calls.js               nextFreeSlots(...) (pure)
      demo/                  template engine + trade templates (pure)
      stripe.js, checkout.js, stripe-events.js
      kpis.js                weekly numbers (pure) + db query
      todo.js                todo items (db) + board grouping (pure)
    api/ ...                 one file per route (see each stage)
    d/[slug]/ ...            demo site, order page, view beacon, checkout
  public/                    index.html, login.html, style.css, js/<page>.js (one file per page), js/lib.js,
                             js/nav.js (NAV + routeFor; file 11 owns it)
  tests/                     node --test files; tests/helpers/fakeD1.mjs shared ({prepare, batch, exec, raw})
lead-manager/                Python engine (kept, extended for grade inputs)
mail-relay/                  NEW Worker: src/index.js, wrangler.toml
routines/                    NEW: one prompt file per Claude Routine + README (how to create each one)
legacy/                      untouched copy of the old system (not deployed, not tested)
docs/rebuild/                this spec
```

## 4. Data model

`lead-manager/schema.sql` stays the single source of truth; after editing it run `python scripts/sync_schema.py`.
Existing tables are kept as they are: `leads`, `jobs`, `job_progress`, `scans`, `scan_points`, `scan_businesses`,
`lead_map_rank`, `api_usage`, `clients`, `money`, `settings`, `payments`, `client_links`, `suppression`, `demos`,
`demo_events`. The old outreach tables (`outreach_*`, `owner_questions`) stay in the database untouched and unused.
`leads` stays owned by the Python scraper; everything the sales pipeline adds lives in new tables keyed by
`place_id`, so a re-scrape can never overwrite sales state.

New tables (exact columns; types are SQLite):

```sql
-- Claude's research and grade, one row per lead (stage 2).
CREATE TABLE IF NOT EXISTS research (
  place_id      TEXT PRIMARY KEY,
  status        TEXT NOT NULL,            -- queued | done | skipped
  grade         TEXT,                     -- A+ | A | B | C | D (computed by grade.js, never sent by Claude)
  points        TEXT,                     -- JSON {need, means, reach, fit} each 0–5
  grade_reason  TEXT,                     -- one or two sentences shown to Nik
  angle         TEXT,                     -- JSON [{fact, source_url}] 1–3 true, specific ways we can help
  opener        TEXT,                     -- suggested first two lines for Nik's email
  owner         TEXT,                     -- JSON {first, full, source_url, confident}
  best_email    TEXT,
  best_email_why TEXT,
  emails        TEXT,                     -- JSON [{email, source_url, where}]
  copy          TEXT,                     -- JSON demo copy {headline, intro, services[], areas[], about}
  site_review   TEXT,                     -- JSON {verdict, summary, problems[], good[]}
  too_big       INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT '',
  searched      TEXT,                     -- JSON [what Claude searched/opened]
  queued_at     TEXT,
  researched_at TEXT
);
CREATE INDEX IF NOT EXISTS research_status ON research (status, grade);

-- The sales pipeline, one row per lead Nik has emailed (or is about to).
CREATE TABLE IF NOT EXISTS prospects (
  place_id        TEXT PRIMARY KEY,
  stage           TEXT NOT NULL,          -- see stages.js
  stage_at        TEXT NOT NULL,
  email           TEXT NOT NULL,          -- the address we write to
  greet_name      TEXT,                   -- first name only when confident, else NULL ("Hi,")
  mailbox_id      TEXT,                   -- the mailbox that owns this thread (all messages use it)
  subject         TEXT,                   -- first email's subject; follow-ups use "Re: " + subject
  root_message_id TEXT,                   -- Message-ID of Nik's first email (threading)
  first_sent_at   TEXT,
  followup_step   INTEGER NOT NULL DEFAULT 0,  -- follow-ups sent so far (0–9)
  next_followup_at TEXT,                  -- NULL when the sequence is stopped or finished
  views           INTEGER NOT NULL DEFAULT 0,
  last_view_at    TEXT,
  last_inbound_at TEXT,
  lost_reason     TEXT,                   -- opt_out | bounce | sequence_done | not_now | not_interested | call
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prospects_stage ON prospects (stage);
CREATE INDEX IF NOT EXISTS prospects_followup ON prospects (next_followup_at);

-- Sending mailboxes (Namecheap Private Email). The password is in settings under secret:mailbox:<id>.
CREATE TABLE IF NOT EXISTS mailboxes (
  id            TEXT PRIMARY KEY,
  address       TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,            -- Nik's name as he wants it shown in the From line
  role          TEXT NOT NULL,            -- cold | system (system = onboarding/client mail, never cold)
  smtp_host     TEXT NOT NULL DEFAULT 'mail.privateemail.com',
  smtp_port     INTEGER NOT NULL DEFAULT 465,
  started_on    TEXT NOT NULL,            -- YYYY-MM-DD the mailbox was bought (warm-up clock)
  cap_override  INTEGER,                  -- NULL = follow the warm-up ramp
  status        TEXT NOT NULL DEFAULT 'active',  -- active | paused
  paused_reason TEXT,
  created_at    TEXT NOT NULL
);

-- Every email in or out, one row each.
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  place_id     TEXT,                      -- NULL for mail not tied to a lead (e.g. warm-up, client)
  client_id    TEXT,
  mailbox_id   TEXT,
  direction    TEXT NOT NULL,             -- out | in
  kind         TEXT NOT NULL,             -- first | followup | reply | system | inbound
  step         INTEGER,                   -- follow-up number 1–9
  author       TEXT NOT NULL,             -- nik | claude | system | them
  to_addr      TEXT,
  from_addr    TEXT,
  subject      TEXT,
  body         TEXT NOT NULL,
  message_id   TEXT,                      -- RFC 5322 Message-ID (ours for out, theirs for in)
  in_reply_to  TEXT,
  refs         TEXT,                      -- References header
  status       TEXT NOT NULL,             -- queued | sending | sent | failed | cancelled | received
  due_at       TEXT,
  sent_at      TEXT,
  received_at  TEXT,
  error        TEXT,
  class        TEXT,                      -- inbound only: bounce | auto | opt_out | human
  needs_reply  INTEGER NOT NULL DEFAULT 0,-- inbound human mail waiting for Claude
  handled_at   TEXT,                      -- when Claude replied or escalated
  intent       TEXT,                      -- inbound only: what they meant, set by the reply Routine (stage 7)
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_place ON messages (place_id, created_at);
CREATE INDEX IF NOT EXISTS messages_due ON messages (status, due_at);
CREATE INDEX IF NOT EXISTS messages_reply ON messages (needs_reply, received_at);
CREATE INDEX IF NOT EXISTS messages_msgid ON messages (message_id);

-- Raw inbound mail, written by the relay Worker, processed by the tick.
CREATE TABLE IF NOT EXISTS inbound_raw (
  id           TEXT PRIMARY KEY,
  received_at  TEXT NOT NULL,
  envelope_from TEXT,
  envelope_to  TEXT,
  headers      TEXT NOT NULL,             -- JSON object of lower-cased header → value
  raw          TEXT NOT NULL,             -- raw MIME, first 256 KB
  processed_at TEXT,
  outcome      TEXT
);
CREATE INDEX IF NOT EXISTS inbound_raw_todo ON inbound_raw (processed_at);

-- Follow-up wording (9 steps, fixed days), approved once by Nik.
CREATE TABLE IF NOT EXISTS followup_templates (
  step        INTEGER PRIMARY KEY,        -- 1–9
  day_offset  INTEGER NOT NULL,           -- 1, 2, 4, 7, 10, 17, 24, 30, 60
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',  -- draft | approved
  approved_at TEXT
);

-- Nik's voice: his real emails and his guidance, read by the reply Routine.
CREATE TABLE IF NOT EXISTS style_examples (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,               -- example | rule
  situation  TEXT NOT NULL,               -- e.g. "they ask the price"
  body       TEXT NOT NULL,
  source     TEXT NOT NULL,               -- nik_written | nik_sent
  created_at TEXT NOT NULL
);

-- Calls in Nik's 11am slots.
CREATE TABLE IF NOT EXISTS calls (
  id         TEXT PRIMARY KEY,
  place_id   TEXT NOT NULL,
  slot_at    TEXT NOT NULL,               -- ISO time of the slot (UK 11:00 → UTC)
  status     TEXT NOT NULL,               -- offered | confirmed | done | no_show | cancelled
  phone      TEXT,
  note       TEXT NOT NULL DEFAULT '',    -- what was said / agreed (stage 8)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_slot ON calls (slot_at, status);

-- Everything Nik has to do, in one list (the Todo page).
CREATE TABLE IF NOT EXISTS todos (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,               -- see section 6
  place_id   TEXT,
  client_id  TEXT,
  title      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  link       TEXT,                        -- in-app link, e.g. /#/lead/<place_id>
  draft      TEXT,                        -- a reply Claude drafted for Nik to send/edit
  due_at     TEXT,
  status     TEXT NOT NULL DEFAULT 'open',-- open | done | dismissed
  dedupe     TEXT UNIQUE,                 -- stops the same item being added twice
  created_at TEXT NOT NULL,
  done_at    TEXT
);
CREATE INDEX IF NOT EXISTS todos_open ON todos (status, due_at);

-- Health: last time each automatic part checked in.
CREATE TABLE IF NOT EXISTS heartbeats (
  name     TEXT PRIMARY KEY,              -- tick | health | relay | routine:research | routine:reply | ...
  last_at  TEXT NOT NULL,
  ok       INTEGER NOT NULL,
  detail   TEXT NOT NULL DEFAULT ''
);

-- Every attempt to wake a Claude Routine.
CREATE TABLE IF NOT EXISTS routine_fires (
  id         TEXT PRIMARY KEY,
  routine    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  http_status INTEGER,
  error      TEXT,
  session_url TEXT,
  at         TEXT NOT NULL
);

-- Weekly KPI report (numbers computed by code; analysis written by Claude).
CREATE TABLE IF NOT EXISTS kpi_reports (
  week       TEXT PRIMARY KEY,            -- ISO week, e.g. 2026-W44
  numbers    TEXT NOT NULL,               -- JSON from kpis.js
  analysis   TEXT NOT NULL DEFAULT '',    -- Claude's markdown
  created_at TEXT NOT NULL
);

-- After payment: the onboarding form and the 7-day build clock (stages 9–10).
CREATE TABLE IF NOT EXISTS onboarding (
  client_id    TEXT PRIMARY KEY,
  token        TEXT NOT NULL UNIQUE,      -- unguessable link /onboard/<token>
  status       TEXT NOT NULL,             -- sent | submitted | building | review | live
  form         TEXT,                      -- JSON answers
  submitted_at TEXT,                      -- the 7-day clock starts here
  due_live_at  TEXT,
  live_at      TEXT,
  site_url     TEXT,
  created_at   TEXT NOT NULL
);
```

`clients` gains nothing; the stage files that need client-level state use `onboarding` and `todos`.

Stage 0 creates every table above with all its columns, so no stage ever needs an `ALTER TABLE`. The schema test
asserts `len(stmts) >= 52` (not an exact count); each later stage adds its tables to `test_rebuild_tables_present`.

### Tables added by later stages

Exact columns are in the owning file's task.

| Table | Added by | Purpose |
| --- | --- | --- |
| `stripe_events` | 08 (stage 9) | Every Stripe webhook event seen, and what the handler did (dedupe + audit) |
| `client_sites` | 09 (stage 10) | One website per client, served by hostname from the same Pages project |
| `site_leads` | 09 (stage 10) | Enquiries from client sites (contact form and chat) |
| `chat_usage` | 09 (stage 10) | Chat messages per site per UK day (limits, monthly report, health) |
| `site_files` | 09 (stage 10) | Photos and logos copied into D1 so sites never hot-link their old host |
| `rate_hits` | 09 (stage 10) | Per-visitor counters for chat and contact-form limits; pruned after 48 h |
| `care` | 10 (stage 11) | One row per paying client once live: target keyword, Google access date (day 0), guarantee status |
| `care_tasks` | 10 (stage 11) | Every planned piece of care work; becomes a `care` todo on its due day |
| `care_scans` | 10 (stage 11) | Map Rank scans run for care (`scans.source = 'care'`) |
| `care_reviews` | 10 (stage 11) | Review count and rating, checked weekly (Places API) |

## 5. Prospect stages

One pure module, `control-room/functions/_lib/stages.js`, owns the pipeline with `nextStage(current, event)`;
anything not listed is a no-op (returns `current`). Every change of `prospects.stage` goes through stage 0's
`applyStageEvent(DB, placeId, event, now, {lost_reason, email, greet_name} = {}) → {from, to}|null` in
`_lib/prospects.js` (`email`/`greet_name` insert a new row); no stage writes `prospects.stage` directly.

| Stage | Meaning |
| --- | --- |
| `ready` | Graded, has an email and a demo; not emailed yet |
| `emailed` | Nik's first email sent; follow-ups running |
| `viewed` | Opened their demo at least once, no reply yet |
| `replied` | They wrote back; Claude is on it |
| `needs_nik` | Escalated: angry, legal, unclear, or a time outside the slots |
| `call_booked` | A slot is confirmed |
| `won` | Paid |
| `lost` | Said no, opted out, bounced, or sequence ended with no reply |

"Open stages" = every stage except `won` and `lost`.

| Event | From | To |
| --- | --- | --- |
| `demo_ready` | none (new row) or `ready` | `ready` |
| `first_sent` | `ready` | `emailed` |
| `demo_view` | `emailed` | `viewed` |
| `inbound_human` | `emailed`, `viewed`, `call_booked` | `replied` |
| `reopen` | `lost` (only when `lost_reason` is `not_now`, `not_interested`, `sequence_done` or `call`; fired by stage 7's `onHumanInbound`) | `replied` |
| `escalate` | open stages | `needs_nik` |
| `nik_handled` | `needs_nik` | `replied` |
| `call_confirmed` | open stages except `ready` | `call_booked` |
| `call_cancelled` | `call_booked` (also used for a no-show) | `replied` |
| `said_no`, `sequence_done` | open stages | `lost` |
| `paid` | any stage (including `lost`) | `won` |
| `opt_out`, `bounce` | any stage except `won` | `lost` |

**`lost_reason` vocabulary:** `opt_out`, `bounce`, `sequence_done`, `not_now`, `not_interested`, `call` (said no on
the call). `opt_out`, `bounce` and `sequence_done` set it to the event name; `said_no` carries `not_now`,
`not_interested` or `call` from the reply Routine.

`hot` is not a stage: it is a flag computed for the board by the one `isHot` in `_lib/shortlist.js` (stage `emailed`
or `viewed`, and views ≥ 2 or any view in the last 24 h). `opt_out` and `bounce` also add the address to
`suppression`. For a `won` prospect an `opt_out`-class email is handled as a human email (it goes to Nik), so a paying
client is never made `lost` and their client mail is never cancelled.

## 6. Todo items (shared by all stages)

`todo.js` exports `addTodo(DB, {kind, title, detail, link, place_id, client_id, draft, due_at, dedupe})` (insert OR
IGNORE on `dedupe`) and `closeTodos(DB, dedupe_prefix)`. Kinds used across stages:

| kind | Added by | Example title |
| --- | --- | --- |
| `setup` | Setup checks (stage 0) | "Add your mailbox password" |
| `pick` | Shortlist (3); Replies (7) with dedupe `checkback:<place_id>`, due +90 days | "8 A-grade leads ready: you can send 3 first emails today" / "Check back with Green Leaf Landscapes (they said not now on 20 Oct)" |
| `hot` | Demo views (4/6) and the payment page (9) | "Call now: Green Leaf Landscapes opened their site 3 times" |
| `escalation` | Replies (7) | "Angry reply from …: Claude's draft is ready" |
| `call` | Calls (8) | "Call Mark (Diamond Kickboxing) Tue 11:00 · 07969…" |
| `call_time` | Calls (8) | "Confirm a time with … by 6pm (they asked for Thu 3pm)" |
| `payment` | Stripe (9) | "Card failed: …" |
| `build` | Build (10) | "Approve …'s site (due live Fri)" |
| `care` | Monthly care (11) | "Approve …'s monthly report" |
| `kpi` | Weekly KPIs (file 11), dedupe `kpi:<week>`, due Monday 08:00 UK | "This week's numbers and Claude's suggestions are ready" |
| `health` | Health (0) and any stage | "Claude's research hasn't run for 2 days" |

Dedupe rules: demo-view `hot` todos use `hot:<place_id>:…` (stage 4 closes only those); the payment page's `hot`
todo uses `checkout:<place_id>`, so the demo step never closes it. `closeTodos` by prefix is only safe when no
other key starts with that prefix; setup todos are closed by exact key. Links use `/#/…`.

## 7. Claude Routines

Prompts live in `routines/<name>.md`; `routines/README.md` says, step by step, how Nik creates each one in the web UI
(name `aetos-<name>`, model, schedule/API trigger, the shared "Aetos" environment with the network secret and the
environment variable `CONTROL_ROOM_URL`). Every prompt starts with stage 0's preamble verbatim (it stops on "Test from
the Control Room…", so Setup's Test fire never does real work) and calls only `$CONTROL_ROOM_URL/api/agent/*`.
Routines never commit or push. Each one starts with `POST /api/agent/heartbeat {routine}` and ends with the same call
carrying `{ok, summary}`.

| Routine | Model | Trigger | Job |
| --- | --- | --- | --- |
| `aetos-research` | Sonnet | daily schedule 06:47 UK + API fire after each scrape | stage 2 |
| `aetos-reply` | Sonnet | API fire per inbound human email; schedule 07:03 UK daily (overnight catch-up) | stages 7–8 |
| `aetos-weekly-kpis` | Sonnet | schedule Sun 18:47 UK + API trigger (used by Setup's Test fire) | KPI analysis |
| `aetos-build` | Sonnet | API fire when an onboarding form is submitted | stage 10 |
| `aetos-monthly-care` | Sonnet | schedule 1st of month 08:47 UK + API trigger | stage 11 |

**API auth:** `/api/agent/*` requires `Authorization: Bearer <agent token>`. The token is generated on the Setup page
(random 32 bytes, base64url), stored as `secret:agent_token`, shown once, and Nik pastes it into the Claude
environment as a network secret for the Control Room host. `requireAgent` also accepts the legacy
`OUTREACH_AGENT_TOKEN` env var if set.

**Firing:** `fireRoutine(DB, name, text)` reads `secret:routine:<name>:url` (the full `/fire` URL) and
`secret:routine:<name>:token`, POSTs with the headers in research.md, logs a `routine_fires` row, and never retries
automatically (no idempotency key). A failed fire turns that routine's health light red and adds a `health` todo.
Payload text is short and factual (`"reply waiting: <n> message(s)"`, `"research queued: <n> leads"`); the prompt
tells Claude to act on `<routine-fire-payload>`. The URL and token are pasted on **Setup → Claude**.

## 8. Shared interfaces (built in stage 0, used by every stage)

Stage files consume these exactly as written. A stage that needs another shared helper defines it in its own task's
"Produces" block and lists it under "Cross-stage interfaces" at the end of its file.

```js
// _lib/ukTime.js (pure). Dates are JS Date; strings are UK local "YYYY-MM-DD" / "HH:MM".
ukParts(date) → {y, m, d, hh, mm, weekday}          // weekday 0 = Sunday, in Europe/London
ukDate(date) → "YYYY-MM-DD"
ukToUtc(ukDateStr, "HH:MM") → Date                  // handles BST/GMT
isWeekendUK(date) → boolean                         // Sat or Sun in UK time
inUkWindow(date, {start: "HH:MM", end: "HH:MM", days: [0..6]}) → boolean
nextUkWindowStart(date, window) → Date              // date itself if already inside
addUkDays(ukDateStr, n) → "YYYY-MM-DD"

// _lib/settings.js (db)
getSetting(DB, key, fallback = null) → Promise<string|null>
setSetting(DB, key, value) → Promise<void>
getSecret(DB, name) → Promise<string|null>          // key "secret:" + name
setSecret(DB, name, value) → Promise<void>
secretStatus(DB, names[]) → Promise<{[name]: boolean}>   // for Setup: set or not, never the value

// _lib/todo.js (db + pure)
addTodo(DB, {kind, title, detail?, link?, place_id?, client_id?, draft?, due_at?, dedupe?}) → Promise<id|null>
closeTodos(DB, dedupePrefix) → Promise<number>
groupBoard(rows, now) → {today: [], overdue: [], later: []}        // pure

// _lib/routines.js (db + fetch)
fireRoutine(DB, name, text, {fetchImpl} = {}) → Promise<{ok, status, error?, session_url?}>
beat(DB, name, ok, detail = "") → Promise<void>                    // writes heartbeats

// _lib/agentAuth.js
requireAgent(request, env, DB) → Promise<Response|null>            // null = allowed; else a 401 Response

// _lib/health.js. One light shape everywhere; grey = "not in use" and never adds a todo.
Light = {name, level: "green"|"amber"|"red"|"grey", detail, fix}
computeLights(facts, now) → Light[]                                 // pure, stage 0's 10 lights only
registerLight(fn)                                                   // fn(DB, env, now) → Promise<Light>; later stages
                                                                    // call it from their own module (imported by
                                                                    // tick.js), never edit health.js
healthFromDb(DB, env, now) → Promise<{lights: Light[], gaps}>       // lights = computeLights(...) ++ registered
// Light names are unique and none is a prefix of another (the health todo dedupe is "health:<name>").

// _lib/prospects.js (db)
applyStageEvent(DB, placeId, event, now, {lost_reason?, email?, greet_name?} = {}) → Promise<{from, to}|null>

// _lib/mail/compose.js (pure)
makeMessageId(domain) → "<uuid@domain>"
composeEmail({from: {name, address}, to, subject, body, messageId, inReplyTo?, references?}) → {headers, text}
coldFooter(nikName) → string                                       // name, "Aetos Websites", the "no thanks" line

// _lib/mail/capacity.js (pure)
rampCap(startedOn, ukToday) → number               // warm-up: 0 for days 0–13, then 3/5/8/10 by week 3/4/5/6+
mailboxCap(mailbox, ukToday) → number              // cap_override ?? rampCap; 0 if paused
pickMailbox(mailboxes, sentTodayById, ukToday) → mailbox|null   // most remaining capacity, cold role only

// _lib/mail/outbox.js (db)
queueMessage(DB, msg) → Promise<id>                // msg matches the messages table; status 'queued'
dispatchDue(DB, env, now, {limit = 2, send = sendViaSmtp, kinds = null}) → Promise<{sent, failed, held}>
  // order: CASE kind WHEN 'followup' THEN 0 WHEN 'first' THEN 1 ELSE 2 END, due_at
  // headers: the row's message_id / in_reply_to / refs when set; a message_id is generated only when null
  // paused mailbox: holds first/followup only; reply and system still go
  // suppression is checked for first/followup/reply only (client and system mail always go)
sentToday(DB, now) → Promise<{[mailbox_id]: number}>   // counts kind first + followup only (cold sends)

// _lib/tick.js
STEPS: [{name, everyMinutes, run: async (ctx) => summaryString}]   // ctx = {DB, env, now, reason, results, budget}
  // ctx.budget is an object, never a number: ctx.budget.left() → queries this step may still make (50 − used).
  // Step tests pass budget: {left: () => N}.
runTick(env, reason, now = new Date()) → Promise<{ran, steps: {[name]: string|error|"deferred"}}>
  // reason "health" runs only the health step (full 50-query budget, own gap/lease keys); every other reason
  // runs every step except health.
```

Tick step order, `everyMinutes` in brackets (each stage adds its step at the position shown, and stage 0's
`tick.js` has a comment marker for every slot; a step that throws is logged in the result and the heartbeat detail,
and the remaining steps still run):

1. `inbound` [0] (stage 0/7): parse new `inbound_raw` rows into `messages`, classify, apply stops.
2. `reply_fire` [0] (stage 7): fire the reply Routine for human mail waiting, inside reply hours.
3. `followups` [5] (stage 6): queue follow-ups that are due.
4. `send` [0] (stage 0): `dispatchDue` (respects caps and send windows).
5. `hot` [5] (stage 4/6): hot-lead todos.
6. `pick` [30] (stage 3): the daily "leads ready to email" todo.
7. `daily_find` [5] (stage 1): once a day from 06:00 UK, start the scrape if the pipeline is low.
8. `stale_jobs` [15] (stage 1): mark scrape/scan jobs running > 45 min as failed (care scans excluded).
9. `calls` [5] (stage 8): expire unconfirmed offers, add call-day todos.
10. `sites` [5] (stage 10): client-site DNS checks, go-live, countdown warnings, chat-lead emails.
11. `care` [10] (stage 11): monthly care checks.
12. `purge` [monthly] (file 11): delete non-clients' `prospects`/`messages` rows with no message in 12 months and
    blank their `research` rows to a data-free `skipped` row, never deleted, so stage 1's research queue never takes
    them again (`suppression` is kept).
13. `health` [0] (stage 0): only in the `?reason=health` invocation (the relay calls it after every cron tick):
    compute lights, add/close `health` and stage 0's `setup` todos in one batched sync, beat `health`. Every other
    tick skips it and beats `tick` itself.

## 9. Global rules (every stage)

- **Truth:** everything shown to a prospect must be true. No invented facts, clients, reviews or numbers. Audit
  claims quoted to prospects are regression-tested.
- **Escaping:** scraped and inbound text is untrusted: `esc()`/`safeUrl()` in the browser, the template engine's
  `h()` on the server. Inbound email bodies are shown as text, never HTML.
- **Copy rules** (CLAUDE.md): results not us, sound human, never insult their site, one goal per message, never
  say "SEO" to prospects (say "top 3 on Google" / "front page of Google").
- **Guarantee wording** wherever it appears: "Top 3 in Google search results in 90 days. GUARANTEED." with the
  section "The guarantee: we will work for FREE if you aren't in the top 3 of Google results within 90 days."
  Where the start day is explained (order page, welcome email, landing page): "Your 90 days start the day you give us
  access to your Google Business Profile." (Q-B default.)
- **Offer and prices** come from one module (`_lib/offer.js`, pure): Website Only £1,750 one-off; Full Package
  £1,950 + £249/month with the first 60 days free; weekend (Sat–Sun UK time) £1,750 + 90 days free. Nothing else
  hard-codes a price. Stage 0 creates `offer.js` and its test; later stages only add exports, in new test files.
- **Time:** all stored times are UTC ISO strings; every rule about days and hours uses UK time via `ukTime.js`.
- **Email:** plain text only, one link at most in Nik's first email (the demo), no tracking pixels, no link
  shorteners. Every cold email ends with Nik's name, "Aetos Websites", and the line
  `If you'd rather not hear from me, just reply "no thanks".` Every sign-off and footer takes Nik's name from the
  `business:sender_name` setting.
- **Errors shown to Nik** say what's wrong and how to fix it in plain English.
- **Tests:** pure modules get unit tests; routes get tests against `tests/helpers/fakeD1.mjs` (node:sqlite).
  Python changes get pytest. Commands (all must pass before any push):
  ```
  cd lead-manager && python -m pytest -q
  node --test control-room/tests/*.test.mjs mail-relay/tests/*.test.mjs
  for f in control-room/public/js/*.js; do node --check "$f"; done
  ```
- **Deploys:** every push to `claude/confident-hawking-vi0lgk` redeploys the Pages project; docs-only commits use
  `[CI Skip]`. Pull with rebase before pushing.

## 10. What Nik does (all of it, in order)

These appear as `setup` todos with a "Test" button where possible, so he never has to remember them.

1. Nothing during the build until the email test (stage 0, task "SMTP proof").
2. Buy one Namecheap Private Email mailbox on aetoswebsites.com (Launch plan, not the trial).
3. Paste its password into Setup → Mailboxes. Press Test.
4. Add the DNS records Setup shows (SPF, DKIM, DMARC) in Cloudflare. Press Test.
5. Receiving replies: decision Q-D (below), then the steps Setup shows for it.
6. Add two permissions to the existing Cloudflare API token if the relay deploy says so.
7. Create the five Routines (`aetos-<name>`) from `routines/README.md`, in the shared "Aetos" environment with
   `CONTROL_ROOM_URL` set. Create API triggers for research, reply, weekly-kpis, build and monthly-care, and paste
   each one's URL and token into Setup → Claude.
8. Approve the 9 follow-up emails and the landscaper template look.
9. Pay the ICO fee (£52) and put his name + an address in the website footer (legal requirement).
10. Stage 10 only, if the own-build chatbot is used: create a Cloudflare Workers AI token and paste it on Setup. This
    is the one exception to "no new Cloudflare keys" (§2); it is stored like every other secret.
11. Daily: open Todo, send first emails to the leads it shows, do the calls it lists.

## 11. Open decisions

All open questions, each with the default the build uses until Nik decides, are in the Questions table at the end of
[reconciliation.md](reconciliation.md) (Q-A to Q-AK). The earlier overview ids map as follows:

| Old id | Now | Topic |
| --- | --- | --- |
| D-1 | Q-D | How replies reach Cloudflare |
| D-2 | Q-E | Cloudflare $5/month plan |
| D-3 | Q-F | "How much is it?" in Nik's words |
| D-4 | Q-G | "Send me more info" link |
| D-5 | Q-H | Landscaper template look |
| D-6 | Q-I | Chatbot: own build or Elfsight |
| D-7 | Q-J | Business address in footers |
