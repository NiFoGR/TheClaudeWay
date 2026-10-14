import json
import sqlite3
from datetime import datetime, timezone

from aetos_leads import autopilot, store


class FakeD1:
    """The D1 HTTP client's query() over an in-memory SQLite with the real schema."""

    def __init__(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(store.SCHEMA)

    def query(self, sql, params=None):
        cur = self.db.execute(sql, params or [])
        self.db.commit()
        return {"success": True, "result": [{"results": [dict(r) for r in cur.fetchall()]}]}

    def ensure_schema(self):
        pass


def test_next_town_skips_recent_searches_and_advances():
    d1 = FakeD1()
    t = {**autopilot.DEFAULT_TERRITORY, "towns": ["Warrington", "Widnes", "Runcorn"], "next": 0}
    assert autopilot.choose_town(t, {"warrington"}) == ("Widnes", 2)
    assert autopilot.choose_town(t, {"warrington", "widnes", "runcorn"}) is None
    d1.query("INSERT INTO settings (key, value) VALUES ('territory', ?)", [json.dumps(t)])
    job = autopilot.next_run(d1)
    assert (job["trade"], job["town"]) == ("landscaper", "Warrington")
    assert autopilot.next_run(d1)["town"] == "Widnes"  # Warrington was just searched
    assert json.loads(d1.query("SELECT value FROM settings WHERE key='territory'")["result"][0]["results"][0]["value"])["next"] == 2
    assert d1.query("SELECT COUNT(*) AS n FROM jobs")["result"][0]["results"][0]["n"] == 2


def test_autopilot_off_does_nothing():
    d1 = FakeD1()
    d1.query("INSERT INTO settings (key, value) VALUES ('territory', ?)", [json.dumps({**autopilot.DEFAULT_TERRITORY, "on": False})])
    assert autopilot.next_run(d1) is None


def test_sitrep_reports_the_day_and_what_needs_the_owner():
    d1 = FakeD1()
    now = datetime(2026, 10, 14, 7, 0, tzinfo=timezone.utc)
    d1.query("INSERT INTO jobs (id, trade, town, max_results, status, found, pitchable, created_at, updated_at) "
             "VALUES ('j', 'landscaper', 'Warrington', 60, 'done', 20, 14, '2026-10-14T06:00:00Z', 'x')")
    for i, (email, status) in enumerate([("a@x.co.uk", "new"), ("", "new"), ("b@y.co.uk", "in outreach")]):
        d1.query("INSERT INTO leads (place_id, name, trade, search_town, email, status, quality_score, audit, first_seen_at, updated_at) "
                 "VALUES (?, ?, 'landscaper', 'Warrington', ?, ?, 60, '{}', '2026-10-14T06:10:00Z', 'x')", [f"p{i}", f"Biz {i}", email, status])
    d1.query("INSERT INTO demo_events (slug, place_id, kind, at) VALUES ('s', 'p2', 'view', '2026-10-13T20:00:00Z'), "
             "('s', 'p2', 'order_page', '2026-10-13T20:05:00Z')")
    md = autopilot.sitrep(d1, now)
    assert "# SITREP · Wednesday 14 October 2026" in md
    assert "landscaper in Warrington: 20 found, 14 worth pitching" in md
    assert "**1 lead ready for outreach**" in md          # only the one with a real email and status new
    assert "Biz 2 · 2 visits" in md                        # hot lead
    assert "Tomorrow's search:** landscaper in" in md


def test_sitrep_says_a_search_is_still_running():
    d1 = FakeD1()
    d1.query("INSERT INTO jobs (id, trade, town, max_results, status, created_at, updated_at) "
             "VALUES ('j', 'landscaper', 'Widnes', 60, 'queued', '2026-10-14T06:00:00Z', 'x')")
    md = autopilot.sitrep(d1, datetime(2026, 10, 14, 7, 0, tzinfo=timezone.utc))
    assert "landscaper in Widnes: still running" in md
