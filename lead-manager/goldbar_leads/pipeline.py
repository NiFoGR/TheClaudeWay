"""Find → audit → director lookup → filter → score. One call does a whole trade + town."""

import asyncio
import csv
import json
import logging
from pathlib import Path

import httpx

from goldbar_leads import audit, companies_house, places, qualify
from goldbar_leads.models import Lead

log = logging.getLogger(__name__)
AUDIT_CONCURRENCY = 8


async def _audit_all(leads: list[Lead]) -> None:
    sem = asyncio.Semaphore(AUDIT_CONCURRENCY)
    async with audit.make_client() as client:

        async def one(lead: Lead) -> None:
            async with sem:
                await audit.audit_lead(client, lead)

        await asyncio.gather(*(one(l) for l in leads))


def run(trade: str, town: str, places_key: str, companies_house_key: str = "", max_results: int = 60) -> list[Lead]:
    with httpx.Client(timeout=30) as client:
        leads = places.search(client, places_key, trade, town, max_results)
        log.info("found %d businesses for %r in %r", len(leads), trade, town)
        qualify.mark_exclusions(leads)
        keep = [l for l in leads if not l.excluded]
        asyncio.run(_audit_all(keep))
        if companies_house_key:
            for lead in keep:
                companies_house.find_director(client, companies_house_key, lead)
    qualify.score(keep)
    return sorted(leads, key=sort_key)


def sort_key(lead: Lead) -> tuple:
    # pitchable first, then most-help-needed, then best reputation (proven good at the work)
    return (lead.excluded, -lead.quality_score, -(lead.rating or 0), -lead.review_count, lead.rank or 999)


CSV_COLUMNS = [
    ("Quality score", lambda l: l.quality_score),
    ("Business", lambda l: l.name),
    ("Director", lambda l: l.director_name),
    ("Phone", lambda l: l.phone),
    ("Email", lambda l: l.email),
    ("Website", lambda l: l.website),
    ("Problems", lambda l: "; ".join(l.issues)),
    ("Google rank", lambda l: l.rank or ""),
    ("Rating", lambda l: l.rating if l.rating is not None else ""),
    ("Reviews", lambda l: l.review_count),
    ("Town", lambda l: l.town),
    ("Address", lambda l: l.address),
    ("Other emails", lambda l: "; ".join(l.emails[1:])),
    ("Socials", lambda l: "; ".join(l.socials.values())),
    ("Company number", lambda l: l.company_number),
    ("Google Maps", lambda l: l.maps_url),
    ("Excluded", lambda l: l.exclude_reason),
]


def write_csv(path: Path, leads: list[Lead]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([h for h, _ in CSV_COLUMNS])
        for lead in leads:
            w.writerow([get(lead) for _, get in CSV_COLUMNS])


def write_outputs(out_dir: Path, trade: str, town: str, leads: list[Lead]) -> dict[str, Path]:
    """leads.csv = everyone pitchable; call-list.csv = pitchable with no email; excluded.csv = skipped and why."""
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = f"{trade}-{town}".lower().replace(" ", "-")
    pitchable = [l for l in leads if not l.excluded]
    paths = {
        "leads": out_dir / f"{slug}-leads.csv",
        "call_list": out_dir / f"{slug}-call-list.csv",
        "excluded": out_dir / f"{slug}-excluded.csv",
        "json": out_dir / f"{slug}.json",
    }
    write_csv(paths["leads"], pitchable)
    write_csv(paths["call_list"], [l for l in pitchable if not l.email])
    write_csv(paths["excluded"], [l for l in leads if l.excluded])
    paths["json"].write_text(json.dumps([l.__dict__ for l in leads], indent=2, default=str))
    return paths


def summary(leads: list[Lead]) -> str:
    pitchable = [l for l in leads if not l.excluded]
    no_site = sum(1 for l in pitchable if l.quality_score >= 90)
    with_email = sum(1 for l in pitchable if l.email)
    lines = [
        f"{len(leads)} businesses found, {len(pitchable)} worth pitching, {len(leads) - len(pitchable)} excluded",
        f"{no_site} with no working website, {with_email} with an email, {len(pitchable) - with_email} for the call list",
        "",
        "Top 10:",
    ]
    for l in pitchable[:10]:
        lines.append(f"  {l.quality_score:>3}  {l.name}  ({l.rating or '-'}★, {l.review_count} reviews)  {l.issues[0] if l.issues else ''}")
    return "\n".join(lines)
