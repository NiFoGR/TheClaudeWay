"""Save leads to SQLite (local) or Cloudflare D1 (online). Re-scraping updates a lead but keeps its
status, warmth and first-seen date, so outreach history is never lost."""

import hashlib
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import httpx

from aetos_leads import research, scoring
from aetos_leads.audit import town_key
from aetos_leads.maprank import Scan
from aetos_leads.models import Lead

SCHEMA = (Path(__file__).resolve().parent.parent / "schema.sql").read_text()

COLUMNS = [
    "place_id", "name", "trade", "search_town", "rank", "address", "town", "postcode", "phone", "website",
    "maps_url", "rating", "review_count", "email", "emails", "socials", "issues", "audit",
    "director_first_name", "director_name", "company_number", "excluded", "exclude_reason", "quality_score",
    "last_job_id", "first_seen_at", "updated_at",
]
_KEEP_ON_UPDATE = {"place_id", "first_seen_at"}
UPSERT = (
    f"INSERT INTO leads ({', '.join(COLUMNS)}) VALUES ({', '.join('?' for _ in COLUMNS)}) "
    f"ON CONFLICT(place_id) DO UPDATE SET "
    + ", ".join(f"{c} = excluded.{c}" for c in COLUMNS if c not in _KEEP_ON_UPDATE)
)


def schema_statements() -> list[str]:
    no_comments = re.sub(r"--[^\n]*", "", SCHEMA)
    return [s.strip() for s in no_comments.split(";") if s.strip()]


def schema_version() -> str:
    """SCHEMA_VERSION in control-room/functions/_lib/schema.js: the first 12 hex characters of the SHA-256 of the
    statements as JSON, worked out exactly as scripts/sync_schema.py does (a test checks the two agree)."""
    return hashlib.sha256(json.dumps(schema_statements()).encode()).hexdigest()[:12]


def row(lead: Lead, now: str, job_id: str = "") -> list:
    values = {
        **{c: getattr(lead, c) for c in COLUMNS if hasattr(lead, c)},
        "emails": json.dumps(lead.emails),
        "socials": json.dumps(lead.socials),
        "issues": json.dumps(lead.issues),
        # findings / score breakdown / map rank ride inside the audit JSON (no schema change for existing DBs)
        "audit": json.dumps({**lead.audit, "findings": lead.findings, "score": lead.score_parts, "map_rank": lead.map_rank}),
        "excluded": int(lead.excluded),
        "last_job_id": job_id or None,
        "first_seen_at": now,
        "updated_at": now,
    }
    return [values[c] for c in COLUMNS]


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


D1_MAX_PARAMS = 100  # D1 rejects statements with more bound parameters than this


def scan_rows(scan_id: str, scan: Scan, now: str) -> dict[str, tuple[list[str], list[list]]]:
    """Rows for the scan tables, as {table: (columns, rows)}."""
    return {
        "scan_points": (
            ["scan_id", "idx", "row", "col", "lat", "lng", "ranking"],
            [[scan_id, i, p.row, p.col, p.lat, p.lng, json.dumps(p.ranking)] for i, p in enumerate(scan.points)],
        ),
        "scan_businesses": (
            ["scan_id", "place_id", "name", "rating", "review_count", "avg_rank", "top3_pct", "found_pct", "ranks"],
            [[scan_id, b.place_id, b.name, b.rating, b.review_count, b.avg_rank, b.top3_pct, b.found_pct, json.dumps(b.ranks)]
             for b in scan.businesses],
        ),
        "lead_map_rank": (
            ["place_id", "scan_id", "keyword", "town", "avg_rank", "top3_pct", "found_pct", "updated_at"],
            [[b.place_id, scan_id, scan.keyword, scan.town, b.avg_rank, b.top3_pct, b.found_pct, now] for b in scan.businesses],
        ),
    }


def insert_sql(table: str, columns: list[str], n_rows: int) -> str:
    one = f"({', '.join('?' for _ in columns)})"
    return f"INSERT OR REPLACE INTO {table} ({', '.join(columns)}) VALUES {', '.join([one] * n_rows)}"


def prior_sql(n: int) -> str:
    """The saved rows of leads found again, to carry over their home-town Maps part and Claude's earlier research."""
    return ("SELECT place_id, email, emails, socials, director_first_name, director_name, audit FROM leads "
            f"WHERE place_id IN ({', '.join('?' for _ in range(n))})")


def keep_home_maps(lead: Lead, prev_audit: dict) -> None:
    """A lead found from a neighbouring town's search (map_rank home False: no Maps part from that scan) keeps the
    Maps part of the last scan of its own town, if it had one: that map_rank, its Maps line written again (the reviews
    line too, with today's review count), and the score worked out again. So does a lead whose run had no Map Rank
    scan (it failed: map_rank {}). Only a scan of its own town today replaces it. Excluded leads aren't scored."""
    prev = (prev_audit or {}).get("map_rank") or {}
    if lead.excluded or lead.map_rank.get("home") is True or prev.get("home") is False or not prev.get("scan_town"):
        return
    if any(prev.get(k) is None for k in ("avg_rank", "top3_pct", "found_pct")):
        return
    if town_key(prev["scan_town"]) != town_key(lead.town or lead.search_town):
        return
    lead.map_rank = {**prev, "home": True}
    extra = scoring.maps_findings(prev["avg_rank"], prev["top3_pct"], prev["found_pct"], prev["scan_town"])
    extra += scoring.reviews_finding(lead.review_count, prev.get("leader_reviews") or [])
    for key, text in extra:
        if key not in lead.findings:
            lead.findings.append(key)
            lead.issues.append(text)
    result = scoring.score(lead.findings)
    lead.quality_score, lead.score_parts = result.total, result.as_dict()
    if "ai_needs" in lead.audit:  # the score moved, so may what's worth Claude's look (research.finalise)
        lead.audit["ai_needs"] = research.needs(lead)


def _json(text, empty):
    """A saved JSON column, or empty when it's missing, not JSON or the wrong shape: one bad row never stops a save."""
    try:
        value = json.loads(text or "null")
    except (TypeError, ValueError):
        return empty
    return value if isinstance(value, type(empty)) else empty


def carry_over(leads: list[Lead], rows: list[dict]) -> None:
    by_id = {l.place_id: l for l in leads}
    for r in rows:
        if r["place_id"] in by_id:
            prev = {**r, "emails": _json(r["emails"], []), "socials": _json(r["socials"], {}), "audit": _json(r["audit"], {})}
            keep_home_maps(by_id[r["place_id"]], prev["audit"])
            research.carry_over(by_id[r["place_id"]], prev)


def save_sqlite(path: str | Path, leads: list[Lead], job_id: str = "") -> None:
    now = _now()
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA)
        db.row_factory = sqlite3.Row
        ids = [l.place_id for l in leads]
        for i in range(0, len(ids), D1_MAX_PARAMS):
            chunk = ids[i:i + D1_MAX_PARAMS]
            carry_over(leads, [dict(r) for r in db.execute(prior_sql(len(chunk)), chunk)])
        db.executemany(UPSERT, [row(l, now, job_id) for l in leads])


class D1:
    """Minimal Cloudflare D1 HTTP client (https://developers.cloudflare.com/api/resources/d1/)."""

    def __init__(self, account_id: str, database_id: str, api_token: str, client: httpx.Client | None = None):
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"
        self.headers = {"Authorization": f"Bearer {api_token}"}
        self.client = client or httpx.Client(timeout=30)

    def query(self, sql: str, params: list | None = None) -> dict:
        resp = self.client.post(self.url, json={"sql": sql, "params": params or []}, headers=self.headers)
        data = resp.json()
        if resp.status_code != 200 or not data.get("success"):
            raise RuntimeError(f"D1 query failed ({resp.status_code}): {data.get('errors')}")
        return data

    def ensure_schema(self) -> None:
        for statement in schema_statements():
            self.query(statement)
        # The Control Room's db() migrates only when this differs from its SCHEMA_VERSION, so it now runs nothing.
        self.query("INSERT INTO settings (key, value) VALUES ('schema:version', ?) "
                   "ON CONFLICT(key) DO UPDATE SET value = excluded.value", [schema_version()])

    def save(self, leads: list[Lead], job_id: str = "") -> None:
        self.ensure_schema()
        ids = [l.place_id for l in leads]
        for i in range(0, len(ids), D1_MAX_PARAMS):
            chunk = ids[i:i + D1_MAX_PARAMS]
            carry_over(leads, (self.query(prior_sql(len(chunk)), chunk).get("result") or [{}])[0].get("results", []))
        now = _now()
        for lead in leads:
            self.query(UPSERT, row(lead, now, job_id))

    def known_leads(self) -> list[dict]:
        """Saved leads still pitchable, for the next search to compare with (qualify.mark_exclusions)."""
        data = self.query("SELECT place_id, name, website, phone, town FROM leads WHERE excluded = 0")
        return (data.get("result") or [{}])[0].get("results", [])

    def known_branches(self) -> list[dict]:
        """Saved leads already set aside as a chain's branches (excluded = 1 on every row), compared with too: once a
        franchise's branches in two towns are set aside, its branch in the next town is still a branch."""
        data = self.query("SELECT place_id, name, website, phone, town, excluded FROM leads "
                          "WHERE excluded = 1 AND exclude_reason = 'Multiple branches (chain)'")
        return (data.get("result") or [{}])[0].get("results", [])

    def in_pipeline(self) -> set[str]:
        """Leads already in outreach (a prospects row): never set aside as a duplicate or a branch when a search finds
        them again (qualify.mark_exclusions), since this run's save would overwrite their row with excluded = 1."""
        data = self.query("SELECT place_id FROM prospects")
        return {r["place_id"] for r in (data.get("result") or [{}])[0].get("results", [])}

    def exclude_chains(self, place_ids: list[str]) -> None:
        """Earlier leads a new search showed are branches of one business. A lead already in outreach (a prospects
        row) keeps going: its conversation is never cut off."""
        for i in range(0, len(place_ids), D1_MAX_PARAMS):
            chunk = place_ids[i:i + D1_MAX_PARAMS]
            self.query("UPDATE leads SET excluded = 1, exclude_reason = 'Multiple branches (chain)' "
                       f"WHERE place_id IN ({', '.join('?' for _ in chunk)}) "
                       "AND place_id NOT IN (SELECT place_id FROM prospects)", chunk)

    def set_job(self, job_id: str, status: str, found: int | None = None, pitchable: int | None = None, error: str = "") -> None:
        self.query(
            "UPDATE jobs SET status = ?, found = COALESCE(?, found), pitchable = COALESCE(?, pitchable), "
            "error = ?, updated_at = ? WHERE id = ?",
            [status, found, pitchable, error[:500], _now(), job_id],
        )

    def insert_many(self, table: str, columns: list[str], rows: list[list]) -> None:
        per = max(1, D1_MAX_PARAMS // len(columns))
        for i in range(0, len(rows), per):
            chunk = rows[i:i + per]
            self.query(insert_sql(table, columns, len(chunk)), [v for r in chunk for v in r])

    def create_scan(self, scan_id: str, keyword: str, town: str, grid: int, spacing_m: int, source: str) -> None:
        now = _now()
        self.query(
            "INSERT OR IGNORE INTO scans (id, keyword, town, grid, spacing_m, source, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
            [scan_id, keyword, town, grid, spacing_m, source, now, now],
        )

    def set_scan(self, scan_id: str, status: str, error: str = "") -> None:
        self.query("UPDATE scans SET status = ?, error = ?, updated_at = ? WHERE id = ?", [status, error[:500], _now(), scan_id])

    def away_leads(self, place_ids: list[str], town: str) -> set[str]:
        """The saved leads among place_ids whose own postal town isn't town (audit.town_key; no postal town = the town
        they were searched in)."""
        away: set[str] = set()
        for i in range(0, len(place_ids), D1_MAX_PARAMS):
            chunk = place_ids[i:i + D1_MAX_PARAMS]
            data = self.query("SELECT place_id, town, search_town FROM leads "
                              f"WHERE place_id IN ({', '.join('?' for _ in chunk)})", chunk)
            away |= {r["place_id"] for r in (data.get("result") or [{}])[0].get("results", [])
                     if town_key(r.get("town") or r.get("search_town") or "") != town_key(town)}
        return away

    def save_scan(self, scan_id: str, scan: Scan) -> None:
        """The scan's heatmap rows, and lead_map_rank (each business's Maps row: the drawer's heatmap link, the research
        queue's map_rank, the competitor in emails) for everyone it saw except saved leads from another town: their row
        stays the last scan of their own town, as their Maps part does (qualify.score, keep_home_maps)."""
        now = _now()
        away = self.away_leads([b.place_id for b in scan.businesses], scan.town)
        for table, (columns, rows) in scan_rows(scan_id, scan, now).items():
            if table == "lead_map_rank":
                rows = [r for r in rows if r[0] not in away]
            self.insert_many(table, columns, rows)
        self.query(
            "UPDATE scans SET status = 'done', error = '', center_lat = ?, center_lng = ?, updated_at = ? WHERE id = ?",
            [scan.center_lat, scan.center_lng, now, scan_id],
        )

    def set_progress(self, job_id: str, stage: str, done: int, total: int, scouted: int = 0) -> None:
        self.query(
            "INSERT OR REPLACE INTO job_progress (job_id, stage, done, total, scouted, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            [job_id, stage, done, total, scouted, _now()],
        )

    def save_usage(self, run_kind: str, run_id: str, calls: dict[str, int]) -> None:
        """Paid Google calls made by one run, for the Money page."""
        rows = [[run_kind, run_id, sku, n, _now()] for sku, n in calls.items() if n]
        if rows:
            self.insert_many("api_usage", ["run_kind", "run_id", "sku", "calls", "created_at"], rows)

    def fail_job_if_unexplained(self, job_id: str, error: str) -> None:
        """Mark a run failed unless the scraper already recorded a clearer reason."""
        self.query(
            "UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status != 'failed'",
            [error[:500], _now(), job_id],
        )


def d1_from_env() -> "D1 | None":
    env = [os.environ.get(k, "") for k in ("CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN")]
    return D1(*env) if all(env) else None
