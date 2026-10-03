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
  sku        TEXT NOT NULL,  -- see lead-manager/goldbar_leads/usage.py
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
