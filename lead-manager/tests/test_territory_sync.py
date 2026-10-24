"""The Control Room's daily search (control-room/functions/_lib/territory.js) and the Python engine share one territory
setting, so its defaults and the research threshold must be the same in both. The JS file is read as text."""

import json
import re
from pathlib import Path

from aetos_leads import autopilot, research

TERRITORY_JS = Path(__file__).resolve().parents[2] / "control-room" / "functions" / "_lib" / "territory.js"


def _default_block() -> str:
    text = TERRITORY_JS.read_text(encoding="utf-8")
    m = re.search(r"export const DEFAULT_TERRITORY = (?:Object\.freeze\()?\{(.*?)\}\)?;", text, re.S)
    assert m, "territory.js must define `export const DEFAULT_TERRITORY = Object.freeze({ ... });`"
    return m.group(1)


def test_default_towns_match_autopilot():
    m = re.search(r"\btowns:\s*\[(.*?)\]", _default_block(), re.S)
    assert m, "DEFAULT_TERRITORY needs a literal `towns: [\"Warrington\", ...]`"
    towns = json.loads("[" + m.group(1).strip().rstrip(",") + "]")
    assert towns == autopilot.DEFAULT_TERRITORY["towns"]


def test_default_trade_size_and_switches_match_autopilot():
    block = _default_block()
    assert 'trade: "landscaper"' in block
    assert autopilot.DEFAULT_TERRITORY["trade"] == "landscaper"
    assert re.search(r"\bmax:\s*60\b", block)
    assert autopilot.DEFAULT_TERRITORY["max"] == 60
    assert re.search(r"\bon:\s*true\b", block) and autopilot.DEFAULT_TERRITORY["on"] is True
    assert re.search(r"\bnext:\s*0\b", block) and autopilot.DEFAULT_TERRITORY["next"] == 0
    # same keys in both: the setting is one JSON object read by JS and Python
    keys = set(re.findall(r"\b(on|trade|towns|next|max):", block))
    assert keys == set(autopilot.DEFAULT_TERRITORY)


def test_research_threshold_and_recent_days_match():
    text = TERRITORY_JS.read_text(encoding="utf-8")
    m = re.search(r"\bMIN_RESEARCH_SCORE = (\d+)\b", text)
    assert m, "territory.js must export `MIN_RESEARCH_SCORE = 35`"
    assert int(m.group(1)) == 35 == research.MIN_SCORE
    m = re.search(r"\bRECENT_DAYS = (\d+)\b", text)
    assert m and int(m.group(1)) == autopilot.RECENT_DAYS == 30
