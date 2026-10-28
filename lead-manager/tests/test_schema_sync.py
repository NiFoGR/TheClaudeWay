import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import sync_schema  # noqa: E402


def test_control_room_schema_matches_lead_manager():
    assert sync_schema.JS.read_text() == sync_schema.render(), "run: python scripts/sync_schema.py"


def test_rebuild_tables_present():
    js = sync_schema.render()
    for t in ["research","prospects","mailboxes","messages","inbound_raw","followup_templates","style_examples",
              "calls","todos","heartbeats","routine_fires","kpi_reports","onboarding","stripe_events"]:
        assert f"CREATE TABLE IF NOT EXISTS {t} (" in js
    assert re.search(r'export const SCHEMA_VERSION = "[0-9a-f]{12}";', js)


def _statements(sql):
    # Comments stripped and whitespace collapsed, so only the SQL itself is compared.
    return [" ".join(s.split()) for s in re.sub(r"--[^\n]*", "", sql).split(";") if s.strip()]


def test_stage0_tables_are_exactly_overview_section_4():
    # Part A: every table and index of overview §4 is in schema.sql exactly as written. CREATE TABLE IF NOT EXISTS
    # never changes a table the live database already has, so an edit to one of these would pass on a fresh test
    # database and never reach the live one. They are created with every column up front: never edit them.
    overview = (ROOT / "docs" / "rebuild" / "00-overview.md").read_text(encoding="utf-8")
    block = re.search(r"```sql\n(.*?)```", overview.split("## 4. Data model", 1)[1], re.S).group(1)
    wanted = _statements(block)
    assert len(wanted) == 23
    have = _statements(sync_schema.SQL.read_text(encoding="utf-8"))
    for statement in wanted:
        assert statement in have, statement
    start = have.index(wanted[0])
    assert have[start:start + 23] == wanted  # together, in overview order (later stages append after them)


def _version(monkeypatch, tmp_path, sql):
    path = tmp_path / "schema.sql"
    path.write_text(sql)
    monkeypatch.setattr(sync_schema, "SQL", path)
    return re.search(r'export const SCHEMA_VERSION = "([0-9a-f]{12})";', sync_schema.render()).group(1)


def test_schema_version_is_the_hash_of_the_statements(monkeypatch, tmp_path):
    # db() reruns the schema batch only when SCHEMA_VERSION changes, so it must follow the statements, not the file.
    base = "-- a table\nCREATE TABLE IF NOT EXISTS t (\n  a TEXT  -- first\n);\nCREATE INDEX IF NOT EXISTS t_a ON t (a);\n"
    v = _version(monkeypatch, tmp_path, base)
    statements = ["CREATE TABLE IF NOT EXISTS t (\n  a TEXT  \n)", "CREATE INDEX IF NOT EXISTS t_a ON t (a)"]
    assert v == hashlib.sha256(json.dumps(statements).encode()).hexdigest()[:12]
    assert _version(monkeypatch, tmp_path, base.replace("-- first", "-- reworded comment")) == v
    assert _version(monkeypatch, tmp_path, "-- new heading\n" + base) == v
    assert _version(monkeypatch, tmp_path, base.replace("a TEXT", "a TEXT, b TEXT")) != v
    assert _version(monkeypatch, tmp_path, base + "CREATE TABLE IF NOT EXISTS u (b TEXT);\n") != v
