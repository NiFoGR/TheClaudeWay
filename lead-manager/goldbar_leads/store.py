"""Save leads to SQLite (local) or Cloudflare D1 (online). Re-scraping updates a lead but keeps its
status, warmth and first-seen date, so outreach history is never lost."""

import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import httpx

from goldbar_leads.models import Lead

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
        "audit": json.dumps(lead.audit),
        "excluded": int(lead.excluded),
        "last_job_id": job_id or None,
        "first_seen_at": now,
        "updated_at": now,
    }
    return [values[c] for c in COLUMNS]


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


def d1_from_env() -> "D1 | None":
    env = [os.environ.get(k, "") for k in ("CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN")]
    return D1(*env) if all(env) else None
