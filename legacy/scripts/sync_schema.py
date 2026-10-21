"""Regenerate control-room/functions/_lib/schema.js from lead-manager/schema.sql (the single source of truth)."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = ROOT / "lead-manager" / "schema.sql"
JS = ROOT / "control-room" / "functions" / "_lib" / "schema.js"


def render() -> str:
    statements = [s.strip() for s in re.sub(r"--[^\n]*", "", SQL.read_text()).split(";") if s.strip()]
    return (
        "// GENERATED from lead-manager/schema.sql by scripts/sync_schema.py: do not edit by hand.\n"
        f"export const SCHEMA = {json.dumps(statements, indent=2)};\n"
    )


if __name__ == "__main__":
    JS.write_text(render())
    print(f"wrote {JS.relative_to(ROOT)}")
