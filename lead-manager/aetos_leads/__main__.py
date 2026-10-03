"""Usage:
  python -m aetos_leads --trade roofer --town Leeds [--max 60] [--out output] [--db leads.db] [--job-id ID]
      find and qualify leads; with D1 configured it also runs a free 5x5 Map Rank scan for the same search
  python -m aetos_leads map-rank --keyword roofer --town Leeds [--grid 7] [--spacing 1600] [--scan-id ID]
      Map Rank heatmap scan only
  python -m aetos_leads --fail-job ID "reason"  /  python -m aetos_leads --fail-scan ID "reason"
      mark a Control Room run as failed (used by the workflows)

Keys come from the environment: GOOGLE_PLACES_API_KEY (required), COMPANIES_HOUSE_API_KEY (optional),
and CLOUDFLARE_ACCOUNT_ID + D1_DATABASE_ID + CLOUDFLARE_API_TOKEN to save into the Control Room's database.
"""

import argparse
import logging
import os
import sys
import time
import uuid
from pathlib import Path

from aetos_leads import maprank, pipeline, store, usage
from aetos_leads.places import PlacesError

PROGRESS_EVERY_S = 2.0  # how often to push the progress bar to the Control Room


def progress_reporter(d1, job_id: str):
    """Progress callback that writes to D1 on stage changes and at most every couple of seconds."""
    last = {"stage": None, "at": 0.0, "scouted": 0}

    def report(stage: str, done: int, total: int) -> None:
        if stage == "scouting":
            last["scouted"] = done
        print(f"{stage}: {done}/{total}", flush=True)
        if not (d1 and job_id):
            return
        now = time.monotonic()
        if stage != last["stage"] or now - last["at"] >= PROGRESS_EVERY_S or done >= total:
            last.update(stage=stage, at=now)
            try:
                d1.set_progress(job_id, stage, done, total, last["scouted"])
            except RuntimeError:
                pass  # a missed progress tick must never fail the run

    return report


def run_scan(d1, api_key: str, scan_id: str, keyword: str, town: str, grid: int, spacing_m: int,
             known: dict[str, dict] | None = None) -> int:
    """Run one Map Rank scan and save it. Returns an exit code; never raises for Google errors."""
    if d1:
        d1.set_scan(scan_id, "running")
    try:
        scan = maprank.run(api_key, keyword, town, grid, spacing_m, known=known)
    except PlacesError as e:
        message = f"Google refused the map search ({e})"
        print(message, file=sys.stderr)
        if d1:
            d1.set_scan(scan_id, "failed", message)
        return 2
    if d1:
        d1.save_scan(scan_id, scan)
    top = scan.businesses[:5]
    print(f"Map Rank '{keyword}' in {town}: {grid}x{grid} grid, {len(scan.businesses)} businesses seen")
    for b in top:
        print(f"  avg #{b.avg_rank:<5} top-3 in {b.top3_pct:>3}% of town  {b.name}")
    return 0


def save_usage(d1, run_kind: str, run_id: str) -> None:
    """Record the run's paid Google calls (even if it failed half way: Google still bills them)."""
    print("Google calls:", dict(usage.calls) or "none", flush=True)
    if d1 and usage.calls:
        try:
            d1.save_usage(run_kind, run_id, dict(usage.calls))
        except RuntimeError as e:
            print(f"Couldn't record Google usage: {e}", file=sys.stderr)


def map_rank_main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="aetos_leads map-rank", description="Map Rank heatmap scan")
    p.add_argument("--keyword", required=True)
    p.add_argument("--town", required=True)
    p.add_argument("--grid", type=int, default=7, choices=maprank.GRID_SIZES)
    p.add_argument("--spacing", type=int, default=1600, help="metres between grid points")
    p.add_argument("--scan-id", default="")
    args = p.parse_args(argv)
    d1 = store.d1_from_env()
    api_key = os.environ.get("GOOGLE_PLACES_API_KEY", "")
    scan_id = args.scan_id or str(uuid.uuid4())
    if not api_key:
        message = "Google key missing: add GOOGLE_PLACES_API_KEY in GitHub → Settings → Secrets and variables → Actions."
        if d1 and args.scan_id:
            d1.set_scan(scan_id, "failed", message)
        print(message, file=sys.stderr)
        return 2
    if d1:
        d1.ensure_schema()
        d1.create_scan(scan_id, args.keyword, args.town, args.grid, args.spacing, "manual")
    usage.reset()
    try:
        return run_scan(d1, api_key, scan_id, args.keyword, args.town, args.grid, args.spacing)
    finally:
        save_usage(d1, "scan", scan_id)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] in (["--fail-job"], ["--fail-scan"]):
        d1 = store.d1_from_env()
        if d1 and len(argv) >= 2:
            reason = " ".join(argv[2:]) or "The run failed"
            if argv[0] == "--fail-job":
                d1.fail_job_if_unexplained(argv[1], reason)
            else:
                d1.query("UPDATE scans SET status = 'failed', error = ? WHERE id = ? AND status != 'failed'", [reason, argv[1]])
        return 0
    if argv[:1] == ["map-rank"]:
        logging.basicConfig(level=logging.INFO, format="%(message)s")
        return map_rank_main(argv[1:])

    p = argparse.ArgumentParser(prog="aetos_leads", description="Find and qualify local UK leads")
    p.add_argument("--trade", required=True, help='e.g. "roofer"')
    p.add_argument("--town", required=True, help='e.g. "Leeds"')
    p.add_argument("--max", type=int, default=60, help="how many businesses to find (up to 300)")
    p.add_argument("--out", default="output", help="folder for the CSV files")
    p.add_argument("--db", default="", help="also save to this local SQLite file")
    p.add_argument("--job-id", default="", help="Control Room run to report progress to")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    d1 = store.d1_from_env()

    def fail(message: str) -> int:
        print(message, file=sys.stderr)
        if d1 and args.job_id:
            d1.set_job(args.job_id, "failed", error=message)
        return 2

    if d1 and args.job_id:
        d1.ensure_schema()
        d1.set_job(args.job_id, "running")

    places_key = os.environ.get("GOOGLE_PLACES_API_KEY", "")
    if not places_key:
        return fail("Google key missing: add GOOGLE_PLACES_API_KEY in GitHub → Settings → Secrets and variables → Actions.")
    usage.reset()
    try:
        return scrape(args, d1, places_key, fail)
    finally:
        save_usage(d1, "scrape", args.job_id)


def scrape(args, d1, places_key: str, fail) -> int:
    target = max(1, min(args.max, 300))
    progress = progress_reporter(d1, args.job_id)
    progress("scouting", 0, target)
    try:
        result = pipeline.run(
            args.trade, args.town, places_key, os.environ.get("COMPANIES_HOUSE_API_KEY", ""), target, progress=progress
        )
    except PlacesError as e:
        return fail(f"Google refused the search. Check the key and that Places API (New) is enabled. ({e})")
    leads = result.leads
    if not leads:
        return fail(f"Google found no {args.trade} businesses in {args.town}. Check the spelling or try a bigger town.")
    paths = pipeline.write_outputs(Path(args.out), args.trade, args.town, leads)
    if args.db:
        store.save_sqlite(args.db, leads, args.job_id)
    if d1:
        progress("saving", 0, len(leads))
        d1.save(leads, args.job_id)
        if result.scan:  # the free 5x5 Map Rank heatmap made during the run, viewable on the Map Rank page
            scan = result.scan
            scan_id = str(uuid.uuid4())
            d1.create_scan(scan_id, scan.keyword, scan.town, scan.grid, scan.spacing_m, "scrape")
            d1.save_scan(scan_id, scan)
        progress("saving", len(leads), len(leads))
        if args.job_id:
            d1.set_job(args.job_id, "done", found=len(leads), pitchable=sum(1 for l in leads if not l.excluded))
        print("Saved to the Control Room database (D1)")

    print(pipeline.summary(leads))
    print("\nFiles:", *[str(v) for v in paths.values()], sep="\n  ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
