import json
from datetime import datetime, timezone

from conftest import FakeD1
from aetos_leads import autopilot


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


def test_sitrep_never_points_at_the_removed_outreach_or_roadmap_pages():
    # Stage 0 deleted both pages (an unknown route just reloads Home), so the SITREP states facts instead.
    d1 = FakeD1()
    d1.query("INSERT INTO leads (place_id, name, trade, search_town, email, status, quality_score, audit, first_seen_at, updated_at) "
             "VALUES ('p1', 'Biz', 'landscaper', 'X', 'a@b.co.uk', 'new', 60, '{}', 'x', 'x')")
    d1.query("INSERT INTO outreach_versions (id, step, name, body, status, author, created_at) "
             "VALUES ('v1', 1, 'A', 'b', 'proposed', 'claude', 'x')")
    d1.query("INSERT INTO owner_questions (id, question, asked_at) VALUES ('q1', 'q?', 'x')")
    assert d1.query("SELECT COUNT(*) AS n FROM outreach_versions WHERE status = 'proposed'")["result"][0]["results"][0]["n"] == 1
    assert d1.query("SELECT COUNT(*) AS n FROM owner_questions WHERE answer IS NULL")["result"][0]["results"][0]["n"] == 1
    md = autopilot.sitrep(d1, datetime(2026, 10, 19, 7, 0, tzinfo=timezone.utc))
    assert "**1 lead ready for outreach**" in md
    assert "Outreach page" not in md and "Roadmap" not in md
    # Stage 11 deleted Home and 'What to do' (#/home now opens Todo), so the SITREP names the Todo page.
    assert "Home" not in md and "What to do" not in md and "Todo page" in md


def test_sitrep_says_a_search_is_still_running():
    d1 = FakeD1()
    d1.query("INSERT INTO jobs (id, trade, town, max_results, status, created_at, updated_at) "
             "VALUES ('j', 'landscaper', 'Widnes', 60, 'queued', '2026-10-14T06:00:00Z', 'x')")
    md = autopilot.sitrep(d1, datetime(2026, 10, 14, 7, 0, tzinfo=timezone.utc))
    assert "landscaper in Widnes: still running" in md


def test_autopilot_pauses_when_enough_leads_are_ready():
    d1 = FakeD1()
    for i in range(autopilot.READY_CAP):
        d1.query("INSERT INTO leads (place_id, name, trade, search_town, email, status, quality_score, audit, first_seen_at, updated_at) "
                 "VALUES (?, 'B', 'landscaper', 'X', 'a@b.co.uk', 'new', 60, '{}', 'x', 'x')", [f"p{i}"])
    assert autopilot.next_run(d1) is None
    md = autopilot.sitrep(d1, datetime(2026, 10, 19, 7, 0, tzinfo=timezone.utc))
    assert "paused: 100 leads are ready" in md


def test_sitrep_puts_the_mailboxes_first_until_ticked():
    d1 = FakeD1()
    md = autopilot.sitrep(d1, datetime(2026, 10, 19, 7, 0, tzinfo=timezone.utc))
    assert "#1 priority: buy the mailboxes" in md
    d1.query("INSERT INTO settings (key, value) VALUES ('setup_done', ?)", [json.dumps({"mailboxes": True})])
    assert "buy the mailboxes" not in autopilot.sitrep(d1, datetime(2026, 10, 19, 7, 0, tzinfo=timezone.utc))


def test_sitrep_knows_the_mailboxes_exist_from_the_mailboxes_table():
    # Stage 11 deleted Home's tick (api/today.js was the only writer of setup_done), so a cold mailbox added on
    # Setup is what clears the line; a system-only mailbox can't send cold email, so it still shows.
    now = datetime(2026, 10, 19, 7, 0, tzinfo=timezone.utc)
    d1 = FakeD1()
    d1.query("INSERT INTO mailboxes (id, address, display_name, role, started_on, created_at) "
             "VALUES ('m0', 'hello@aetoswebsites.com', 'Nik', 'system', '2026-10-01', 'x')")
    md = autopilot.sitrep(d1, now)
    assert "#1 priority: buy the mailboxes" in md
    assert "Add them on Setup → Mailboxes when bought." in md and "Tick it on Home" not in md
    d1.query("INSERT INTO mailboxes (id, address, display_name, role, started_on, created_at) "
             "VALUES ('m1', 'nik@aetoswebsites.com', 'Nik', 'cold', '2026-10-01', 'x')")
    assert "buy the mailboxes" not in autopilot.sitrep(d1, now)


def test_sitrep_sends_a_stalled_research_queue_to_todo_and_health():
    d1 = FakeD1()
    d1.query("INSERT INTO research (place_id, status, queued_at) VALUES ('p1', 'queued', '2026-10-10T06:00:00Z')")
    md = autopilot.sitrep(d1, datetime(2026, 10, 19, 7, 0, tzinfo=timezone.utc))
    assert "**Claude isn't researching leads** (last run: never). See the Todo page and Setup → Health (research light)." in md
    assert "Home" not in md


def _research(d1, place_id, status, researched_at):
    d1.query("INSERT INTO research (place_id, status, queued_at, researched_at) VALUES (?, ?, '2026-10-22T06:00:00Z', ?)",
             [place_id, status, researched_at])


def test_sitrep_reads_claudes_research_from_the_research_table():
    # Stage 2: Claude's research lives in the research table; nothing writes leads.audit.ai_research any more, so
    # reading it said "Claude researched: 0 leads" and "Claude isn't researching" for ever (the old Routine's last run).
    d1 = FakeD1()
    now = datetime(2026, 10, 24, 7, 0, tzinfo=timezone.utc)
    d1.query("INSERT INTO leads (place_id, name, trade, search_town, email, status, quality_score, audit, first_seen_at, updated_at) "
             "VALUES ('old', 'Old Biz', 'landscaper', 'X', '', 'new', 60, ?, 'x', 'x')",
             [json.dumps({"ai_research": {"done_at": "2026-10-10T13:47:00Z"}, "ai_needs": ["email"]})])
    _research(d1, "a", "done", "2026-10-23T06:50:00Z")
    _research(d1, "b", "done", "2026-10-24T06:55:00Z")
    _research(d1, "c", "queued", None)
    md = autopilot.sitrep(d1, now)
    assert "Claude researched:** 2 leads" in md
    assert "1 still waiting" in md
    assert "- **Claude researched:** 2 leads (the best ones first, 8 a run); 1 still waiting" in md
    assert "lower-priority" not in md and "~15 a day" not in md
    assert "Claude isn't researching" not in md

    # Nothing researched for more than 2 days while a lead waits: the warning, with the research table's last date.
    d1 = FakeD1()
    d1.query("INSERT INTO leads (place_id, name, trade, search_town, email, status, quality_score, audit, first_seen_at, updated_at) "
             "VALUES ('old', 'Old Biz', 'landscaper', 'X', '', 'new', 60, ?, 'x', 'x')",
             [json.dumps({"ai_research": {"done_at": "2026-10-23T13:47:00Z"}})])
    _research(d1, "a", "done", "2026-10-21T06:50:00Z")
    _research(d1, "c", "queued", None)
    md = autopilot.sitrep(d1, now)
    assert "**Claude isn't researching leads** (last run: 2026-10-21)" in md
    assert "Claude researched:** 0 leads" in md and "1 still waiting" in md
