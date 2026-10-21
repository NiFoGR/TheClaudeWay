import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import sync_schema  # noqa: E402


def test_control_room_schema_matches_lead_manager():
    assert sync_schema.JS.read_text() == sync_schema.render(), "run: python scripts/sync_schema.py"
