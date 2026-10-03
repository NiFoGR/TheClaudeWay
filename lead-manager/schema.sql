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
