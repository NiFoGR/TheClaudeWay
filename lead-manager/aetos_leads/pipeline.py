"""Find → audit → director lookup → filter → score. One call does a whole trade + town."""

import asyncio
import csv
import json
import logging
from pathlib import Path

from collections.abc import Callable
from dataclasses import dataclass

import httpx

from aetos_leads import audit, companies_house, maprank, owner, places, qualify, research
from aetos_leads.maprank import Scan
from aetos_leads.models import Lead

log = logging.getLogger(__name__)
AUDIT_CONCURRENCY = 8


AUTO_SCAN_GRID = 5
AUTO_SCAN_SPACING_M = 1600  # about a mile between points

Progress = Callable[[str, int, int], None]  # (stage, done, total)


def _quiet(stage: str, done: int, total: int) -> None:
    log.info("%s %d/%d", stage, done, total)


async def _audit_all(leads: list[Lead], progress: Progress) -> None:
    sem = asyncio.Semaphore(AUDIT_CONCURRENCY)
    done = 0
    async with audit.make_client() as client:

        async def one(lead: Lead) -> None:
            nonlocal done
            async with sem:
                await audit.audit_lead(client, lead)
            done += 1
            progress("checking", done, len(leads))

        await asyncio.gather(*(one(l) for l in leads))


@dataclass
class Result:
    leads: list[Lead]
    scan: Scan | None


def run(trade: str, town: str, places_key: str, companies_house_key: str = "", max_results: int = 60,
        progress: Progress = _quiet, map_scan: bool = True) -> Result:
    """Scout → check websites → directors → Google Maps heatmap → score. progress() is called as it goes."""
    with httpx.Client(timeout=30) as client:
        leads = places.search(client, places_key, trade, town, max_results)
        progress("scouting", len(leads), max_results)
        qualify.mark_exclusions(leads)
        keep = [l for l in leads if not l.excluded]
        progress("checking", 0, len(keep))
        asyncio.run(_audit_all(keep, progress))
        for lead in keep:  # who runs it: their website, their reviews, their email, the business name
            found = owner.find_owner(lead.pages_html, lead.emails, audit.host_of(lead.website or ""), lead.name, lead.reviews,
                                     towns=[town, lead.town])
            if found["first"]:
                lead.director_first_name, lead.director_name = found["first"], found["full"]
                lead.audit["owner_source"] = found["source"]
                lead.audit["owner_confident"] = found["confident"]
            lead.pages_html = []  # done with them; don't hold every page in memory
        if companies_house_key:
            for i, lead in enumerate(keep, 1):
                companies_house.find_director(client, companies_house_key, lead)
                if i % 5 == 0 or i == len(keep):
                    progress("directors", i, len(keep))
        scan = None
        if map_scan:  # free (IDs-only searches); a failure here only means no Maps part in the score
            progress("maps", 0, AUTO_SCAN_GRID ** 2)
            known = {l.place_id: {"name": l.name, "rating": l.rating, "review_count": l.review_count} for l in leads}
            try:
                scan = maprank.run(places_key, trade, town, AUTO_SCAN_GRID, AUTO_SCAN_SPACING_M, known=known, client=client)
            except (places.PlacesError, KeyError, httpx.HTTPError) as e:
                log.warning("map rank scan skipped: %s", e)
            progress("maps", AUTO_SCAN_GRID ** 2, AUTO_SCAN_GRID ** 2)
    qualify.score(keep, scan)
    for lead in keep:  # decision maker's email first; what's left for Claude (research.py)
        research.finalise(lead)
    return Result(sorted(leads, key=sort_key), scan)


def sort_key(lead: Lead) -> tuple:
    # pitchable first, then most-help-needed, then best reputation (proven good at the work)
    return (lead.excluded, -lead.quality_score, -(lead.rating or 0), -lead.review_count, lead.rank or 999)


CSV_COLUMNS = [
    ("Quality score", lambda l: l.quality_score),
    ("Website /45", lambda l: l.score_parts.get("website", "")),
    ("Local SEO /30", lambda l: l.score_parts.get("seo", "")),
    ("Google Maps /25", lambda l: l.score_parts.get("maps", "")),
    ("Maps avg rank", lambda l: l.map_rank.get("avg_rank", "")),
    ("Maps top-3 %", lambda l: l.map_rank.get("top3_pct", "")),
    ("Business", lambda l: l.name),
    ("Owner", lambda l: l.director_name),
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


NO_SITE_KEYS = {"no_website", "profile_only", "site_down", "site_broken", "bad_certificate"}


def has_no_working_site(lead: Lead) -> bool:
    return bool(NO_SITE_KEYS & set(lead.findings))


def summary(leads: list[Lead]) -> str:
    pitchable = [l for l in leads if not l.excluded]
    no_site = sum(1 for l in pitchable if has_no_working_site(l))
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
