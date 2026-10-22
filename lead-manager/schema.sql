-- Lead store. Plain SQLite, so the same file works locally and on Cloudflare D1 (the Control Room's database).
CREATE TABLE IF NOT EXISTS leads (
  place_id            TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  trade               TEXT NOT NULL,
  search_town         TEXT NOT NULL,
  rank                INTEGER,
  address             TEXT,
  town                TEXT,
  postcode            TEXT,
  phone               TEXT,
  website             TEXT,
  maps_url            TEXT,
  rating              REAL,
  review_count        INTEGER,
  email               TEXT,
  emails              TEXT,   -- JSON array
  socials             TEXT,   -- JSON object
  issues              TEXT,   -- JSON array of plain-English problems
  audit               TEXT,   -- JSON object of raw audit facts
  director_first_name TEXT,
  director_name       TEXT,
  company_number      TEXT,
  excluded            INTEGER NOT NULL DEFAULT 0,
  exclude_reason      TEXT,
  quality_score       INTEGER NOT NULL DEFAULT 0,
  warmth_score        INTEGER NOT NULL DEFAULT 0,  -- filled later by outreach (opens, demo views, replies)
  status              TEXT NOT NULL DEFAULT 'new', -- new → contacted → replied → won / lost
  notes               TEXT NOT NULL DEFAULT '',
  last_job_id         TEXT,  -- the Lead Scraper run that last found this lead
  first_seen_at       TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_trade_town ON leads (trade, search_town);
CREATE INDEX IF NOT EXISTS leads_quality ON leads (excluded, quality_score DESC);
CREATE INDEX IF NOT EXISTS leads_job ON leads (last_job_id);

-- One row per Lead Scraper run started from the Control Room.
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  trade       TEXT NOT NULL,
  town        TEXT NOT NULL,
  max_results INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued', -- queued → running → done / failed
  found       INTEGER,
  pitchable   INTEGER,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Map Rank: one row per heatmap scan (started from the Control Room, or automatically after a lead scrape).
CREATE TABLE IF NOT EXISTS scans (
  id          TEXT PRIMARY KEY,
  keyword     TEXT NOT NULL,
  town        TEXT NOT NULL,
  grid        INTEGER NOT NULL,             -- 5 = 5x5 points
  spacing_m   INTEGER NOT NULL,             -- metres between points
  center_lat  REAL,
  center_lng  REAL,
  source      TEXT NOT NULL DEFAULT 'manual', -- manual | scrape
  status      TEXT NOT NULL DEFAULT 'queued', -- queued → running → done / failed
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_points (
  scan_id  TEXT NOT NULL,
  idx      INTEGER NOT NULL,
  row      INTEGER NOT NULL,
  col      INTEGER NOT NULL,
  lat      REAL NOT NULL,
  lng      REAL NOT NULL,
  ranking  TEXT NOT NULL,  -- JSON array of place ids, best first (top 20)
  PRIMARY KEY (scan_id, idx)
);
CREATE TABLE IF NOT EXISTS scan_businesses (
  scan_id      TEXT NOT NULL,
  place_id     TEXT NOT NULL,
  name         TEXT,
  rating       REAL,
  review_count INTEGER,
  avg_rank     REAL NOT NULL,   -- 21 = never in the top 20
  top3_pct     INTEGER NOT NULL,
  found_pct    INTEGER NOT NULL,
  ranks        TEXT NOT NULL,   -- JSON array, one rank per point (null = not in top 20)
  PRIMARY KEY (scan_id, place_id)
);
-- Latest map rank per business, shown on each lead.
CREATE TABLE IF NOT EXISTS lead_map_rank (
  place_id   TEXT PRIMARY KEY,
  scan_id    TEXT NOT NULL,
  keyword    TEXT NOT NULL,
  town       TEXT NOT NULL,
  avg_rank   REAL NOT NULL,
  top3_pct   INTEGER NOT NULL,
  found_pct  INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
-- Live progress of a Lead Scraper run, for the progress bar. stage: scouting → checking → directors → maps → saving
CREATE TABLE IF NOT EXISTS job_progress (
  job_id     TEXT PRIMARY KEY,
  stage      TEXT NOT NULL,
  done       INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  scouted    INTEGER NOT NULL DEFAULT 0,  -- businesses found so far, shown as "Scouted: N"
  updated_at TEXT NOT NULL
);

-- Money page. Paid Google calls per run; the Control Room turns them into pounds from Google's price list.
CREATE TABLE IF NOT EXISTS api_usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_kind   TEXT NOT NULL,  -- scrape | scan
  run_id     TEXT,
  sku        TEXT NOT NULL,  -- see lead-manager/aetos_leads/usage.py
  calls      INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_usage_date ON api_usage (created_at);
-- Paying clients. Retainer income is worked out from these: monthly_pence a month once free_days have passed.
CREATE TABLE IF NOT EXISTS clients (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  place_id        TEXT,            -- the lead they came from, if any
  package         TEXT NOT NULL,   -- full | weekend | website
  build_fee_pence INTEGER NOT NULL,
  monthly_pence   INTEGER NOT NULL,
  free_days       INTEGER NOT NULL,
  paid_on         TEXT NOT NULL,   -- YYYY-MM-DD the build fee was paid
  cancelled_on    TEXT,            -- YYYY-MM-DD they stopped the monthly
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);
-- Everything else in and out: mailboxes, domains, tools, one-off income. monthly = 1 repeats every month.
CREATE TABLE IF NOT EXISTS money (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,   -- in | out
  category     TEXT NOT NULL,
  label        TEXT NOT NULL,
  amount_pence INTEGER NOT NULL,
  on_date      TEXT NOT NULL,   -- YYYY-MM-DD (first payment, if monthly)
  monthly      INTEGER NOT NULL DEFAULT 0,
  ended_on     TEXT,            -- YYYY-MM-DD a monthly cost was cancelled
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Stripe. Every payment Stripe reports (build fees and retainers actually received), with Stripe's fee.
CREATE TABLE IF NOT EXISTS payments (
  id              TEXT PRIMARY KEY,  -- Stripe invoice/session id (+ ":build" / ":monthly" per part)
  stripe_customer TEXT,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,     -- Website builds | Monthly retainers
  amount_pence    INTEGER NOT NULL,
  fee_pence       INTEGER NOT NULL DEFAULT 0,
  paid_on         TEXT NOT NULL,     -- YYYY-MM-DD
  created_at      TEXT NOT NULL
);
-- Which clients pay through Stripe (their income then comes from payments, not the schedule).
CREATE TABLE IF NOT EXISTS client_links (
  client_id           TEXT PRIMARY KEY,
  stripe_customer     TEXT NOT NULL,
  stripe_subscription TEXT,
  email               TEXT,
  failed_on           TEXT  -- YYYY-MM-DD of the last failed monthly payment; cleared when one succeeds
);
-- Outreach (docs/outreach-experiments.md). A "test" compares 2–3 versions of the first email; follow-ups are fixed.
CREATE TABLE IF NOT EXISTS outreach_tests (
  id          TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  kept_id     TEXT,              -- the version kept when the test ended
  summary     TEXT NOT NULL DEFAULT '',  -- what was learned, for the past-tests log
  results     TEXT               -- JSON snapshot of each version's numbers at the end
);
CREATE TABLE IF NOT EXISTS outreach_versions (
  id             TEXT PRIMARY KEY,
  step           INTEGER NOT NULL,          -- 1 = first email (tested), 2–4 = follow-ups (fixed)
  test_id        TEXT,                      -- step 1 only
  name           TEXT NOT NULL,
  hypothesis     TEXT NOT NULL DEFAULT '',
  subject        TEXT NOT NULL DEFAULT '',  -- follow-ups reply in the same thread
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'proposed', -- proposed → live → kept / retired / paused; or rejected
  author         TEXT NOT NULL,             -- owner | claude | seed
  parent_id      TEXT,
  prior_a        REAL NOT NULL DEFAULT 1,
  prior_b        REAL NOT NULL DEFAULT 49,
  status_reason  TEXT,
  created_at     TEXT NOT NULL,
  approved_at    TEXT,
  decided_at     TEXT
);
CREATE TABLE IF NOT EXISTS outreach_sends (
  id            TEXT PRIMARY KEY,
  place_id      TEXT NOT NULL,
  email         TEXT NOT NULL,
  mailbox       TEXT,
  step          INTEGER NOT NULL,
  version_id    TEXT NOT NULL,
  test_id       TEXT,
  subject       TEXT,
  body          TEXT,
  features      TEXT,             -- JSON snapshot of the lead at send time (top finding, maps band, trade, email source…)
  gmail_msg_id  TEXT,
  thread_id     TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued → sent / bounced / cancelled
  due_at        TEXT,
  sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS outreach_sends_lead ON outreach_sends (place_id);
CREATE TABLE IF NOT EXISTS outreach_replies (
  id             TEXT PRIMARY KEY,
  place_id       TEXT NOT NULL,
  send_id        TEXT,
  received_at    TEXT NOT NULL,
  snippet        TEXT,
  auto_class     TEXT,   -- bounce | auto_reply | opt_out | complaint
  owner_class    TEXT,   -- interested | question | not_now | no | referral
  classified_by  TEXT    -- auto | owner
);
CREATE TABLE IF NOT EXISTS suppression (
  value       TEXT PRIMARY KEY,  -- an email, a domain, or a company number
  kind        TEXT NOT NULL,     -- email | domain | company
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
-- "Write it your way": the owner's rough wording for an email step. Claude turns each into proper versions.
CREATE TABLE IF NOT EXISTS outreach_briefs (
  id          TEXT PRIMARY KEY,
  step        INTEGER NOT NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'waiting',  -- waiting → done
  created_at  TEXT NOT NULL,
  done_at     TEXT
);

-- Claude asks the owner how he'd handle something (outreach style, replies, offers); his answers guide every later run.
CREATE TABLE IF NOT EXISTS owner_questions (
  id          TEXT PRIMARY KEY,
  topic       TEXT NOT NULL DEFAULT 'outreach',
  question    TEXT NOT NULL,
  why         TEXT NOT NULL DEFAULT '',          -- what Claude will do with the answer
  options     TEXT NOT NULL DEFAULT '[]',        -- JSON array of suggested answers (he can also type his own)
  answer      TEXT,
  asked_at    TEXT NOT NULL,
  answered_at TEXT
);

-- Demo sites: one link per lead (/d/<slug>), up until expires_at. Built when the lead is added to outreach.
CREATE TABLE IF NOT EXISTS demos (
  slug        TEXT PRIMARY KEY,
  place_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS demos_place ON demos (place_id);
-- What prospects do on their demo: view (a real person, counted after a few seconds on the page), order_page, ordered.
CREATE TABLE IF NOT EXISTS demo_events (
  slug        TEXT NOT NULL,
  place_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS demo_events_place ON demo_events (place_id, kind);

-- Rebuild (stage 0)
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
