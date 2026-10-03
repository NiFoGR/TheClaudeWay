"""Usage: python -m goldbar_leads --trade roofer --town Leeds [--max 60] [--out output] [--db leads.db] [--job-id ID]
       python -m goldbar_leads --fail-job ID "reason"     (mark a Control Room run as failed)

Keys come from the environment: GOOGLE_PLACES_API_KEY (required), COMPANIES_HOUSE_API_KEY (optional),
and CLOUDFLARE_ACCOUNT_ID + D1_DATABASE_ID + CLOUDFLARE_API_TOKEN to save into the Control Room's database.
"""

import argparse
import logging
import os
import sys
from pathlib import Path

from goldbar_leads import pipeline, store


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["--fail-job"]:
        d1 = store.d1_from_env()
        if d1 and len(argv) >= 2:
            d1.set_job(argv[1], "failed", error=" ".join(argv[2:]) or "The run failed")
        return 0

    p = argparse.ArgumentParser(prog="goldbar_leads", description="Find and qualify local UK leads")
    p.add_argument("--trade", required=True, help='e.g. "roofer"')
    p.add_argument("--town", required=True, help='e.g. "Leeds"')
    p.add_argument("--max", type=int, default=60, help="how many businesses to find (up to 300)")
    p.add_argument("--out", default="output", help="folder for the CSV files")
    p.add_argument("--db", default="", help="also save to this local SQLite file")
    p.add_argument("--job-id", default="", help="Control Room run to report progress to")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    places_key = os.environ.get("GOOGLE_PLACES_API_KEY", "")
    if not places_key:
        print("GOOGLE_PLACES_API_KEY is not set", file=sys.stderr)
        return 2

    d1 = store.d1_from_env()
    if d1 and args.job_id:
        d1.ensure_schema()
        d1.set_job(args.job_id, "running")

    leads = pipeline.run(
        args.trade, args.town, places_key, os.environ.get("COMPANIES_HOUSE_API_KEY", ""), min(args.max, 300)
    )
    paths = pipeline.write_outputs(Path(args.out), args.trade, args.town, leads)
    if args.db:
        store.save_sqlite(args.db, leads, args.job_id)
    if d1:
        d1.save(leads, args.job_id)
        if args.job_id:
            d1.set_job(args.job_id, "done", found=len(leads), pitchable=sum(1 for l in leads if not l.excluded))
        print("Saved to the Control Room database (D1)")

    print(pipeline.summary(leads))
    print("\nFiles:", *[str(v) for v in paths.values()], sep="\n  ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
