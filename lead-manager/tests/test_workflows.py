"""The GitHub workflows: GitHub holds no Claude tokens (only the Control Room fires Routines) and the daily cron stays off."""

from pathlib import Path
import re

WF = Path(__file__).resolve().parents[2] / ".github" / "workflows"


def test_scrape_workflow_never_calls_claude():
    text = (WF / "scrape-leads.yml").read_text()
    assert "CLAUDE_ROUTINE" not in text and "routines/" not in text


def test_daily_workflow_stays_paused():
    assert not re.search(r"^\s*schedule:", (WF / "daily.yml").read_text(), re.M)


def test_reset_clears_the_research_queue():
    """Reset leads deleted the leads but left Claude's research queue: the daily search was skipped for 'leads to
    research' that no longer existed, the Routine kept firing for them, and a lead found again was never queued."""
    text = (WF / "reset-leads.yml").read_text()
    loop = re.search(r"for table in \(([^)]*)\):", text)
    assert loop, "reset-leads.yml: the loop over the tables it deletes from has moved"
    tables = re.findall(r'"(\w+)"', loop[1])
    assert {"leads", "research", "jobs", "job_progress", "lead_map_rank"} <= set(tables)
    # who has been emailed or has opted out is kept: losing it could mean emailing someone twice
    assert not {"prospects", "suppression"} & set(tables)


def test_scrape_no_longer_tells_the_workflow_to_wake_claude(monkeypatch, tmp_path, capsys):
    """The engine stops writing for_claude: the Control Room queues the leads for research and fires the Routine."""
    import argparse

    from aetos_leads import __main__ as cli
    from aetos_leads import pipeline
    from aetos_leads.models import Lead

    needs_claude = Lead(place_id="p1", name="Smith Landscapes", trade="landscaper", search_town="Widnes", rank=1,
                        audit={"ai_needs": ["email", "owner"]})
    monkeypatch.setattr(pipeline, "run", lambda *a, **k: pipeline.Result([needs_claude], None))
    out = tmp_path / "github_output"
    out.write_text("")
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    args = argparse.Namespace(trade="landscaper", town="Widnes", max=60, out=str(tmp_path / "csv"), db="", job_id="")
    assert cli.scrape(args, None, "KEY", lambda message: 2) == 0
    assert out.read_text() == ""
    assert "Claude" not in capsys.readouterr().out
