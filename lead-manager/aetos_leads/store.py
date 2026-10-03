"""Save leads to SQLite (local) or Cloudflare D1 (online). Re-scraping updates a lead but keeps its
status, warmth and first-seen date, so outreach history is never lost."""

import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import httpx

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


def save_sqlite(path: str | Path, leads: list[Lead], job_id: str = "") -> None:
    now = _now()
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA)
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

    def save(self, leads: list[Lead], job_id: str = "") -> None:
        self.ensure_schema()
        now = _now()
        for lead in leads:
            self.query(UPSERT, row(lead, now, job_id))

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

    def save_scan(self, scan_id: str, scan: Scan) -> None:
        now = _now()
        for table, (columns, rows) in scan_rows(scan_id, scan, now).items():
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
