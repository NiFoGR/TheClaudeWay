"""Filtering (who we never pitch) and the quality score (how much we can help)."""

import re

from aetos_leads import maprank, scoring
from aetos_leads.audit import host_of, is_real_website, town_key
from aetos_leads.maprank import Scan
from aetos_leads.models import Lead

# Front-desk / gatekeeper businesses: the owner won't read our email.
FRONT_DESK_TYPES = {
    "dentist", "dental_clinic", "doctor", "hospital", "medical_lab", "physiotherapist", "pharmacy", "drugstore",
    "veterinary_care", "lawyer", "bank", "insurance_agency", "real_estate_agency",
    "school", "university", "local_government_office", "supermarket", "department_store", "shopping_mall",
}
# medical and legal name words only: "Tree Surgery", "The Lawn Clinic" and "Driveway Clinic" are trades
FRONT_DESK_WORDS = re.compile(r"\b(dental|dentists?|doctors?|medical|nhs|veterinary|vets|physio\w*|solicitors?|council|opticians?|pharmacy|chemist)\b", re.I)

# National brands and franchises that show up in local results. Extend as you meet them.
CHAINS = re.compile(
    # only unambiguous brand names: a local "Everest Roofing" or "Bark & Bath" must not be caught
    r"\b(british gas|homeserve|pimlico plumbers|dyno[- ]?(rod|locks|pest|plumbing|electrics)|rentokil|"
    r"kwik ?fit|halfords|national tyres|ats euromaster|timpson|mr\.? ?electric|fantastic services|"
    r"anglian home|safestyle|stannah|aspect maintenance|arnold clark|evans halshaw|bristol street motors|"
    r"stoneacre|motorpoint|carshop|lookers|sytner|vertu motors|jardine motors|marshall motor|"
    r"pendragon)\b",
    re.I,
)

# Hosts many unrelated businesses have a page on (directories, marketplaces, chat/booking links): sharing one says
# nothing about being one business, so listings on them are never grouped by website (a phone match still counts).
SHARED_HOSTS = {
    "houzz.co.uk", "houzz.com", "freeindex.co.uk", "hotfrog.co.uk", "thomsonlocal.com", "cylex-uk.co.uk", "192.com",
    "yelp.co.uk", "yelp.com", "nextdoor.co.uk", "nextdoor.com", "trustpilot.com", "which.co.uk", "trustmark.org.uk",
    "fmb.org.uk", "gassaferegister.co.uk", "niceic.com", "autotrader.co.uk", "motors.co.uk", "pistonheads.com",
    "gumtree.com", "ebay.co.uk", "wa.me", "whatsapp.com", "m.me", "fb.com", "fb.me", "bit.ly", "tinyurl.com", "goo.gl",
    "google.co.uk", "calendly.com", "beacons.ai", "linkin.bio", "taplink.cc", "pinterest.co.uk", "pinterest.com",
    "mindbodyonline.com", "glofox.com", "goteamup.com",
}


def _own_host(url: str) -> str:
    """The website's host when it's the business's own (a real website, not a shared platform), else ""."""
    host = host_of(url) if url and is_real_website(url) else ""
    return "" if any(host == h or host.endswith("." + h) for h in SHARED_HOSTS) else host


def _phone_key(phone: str) -> str:
    digits = re.sub(r"\D", "", phone)
    return digits[-10:] if len(digits) >= 10 else ""


def _closed(lead: Lead) -> bool:
    return bool(lead.business_status and lead.business_status != "OPERATIONAL")


def _earlier(leads: list[Lead], known: list[dict]) -> list[Lead]:
    """Saved leads from earlier searches ({place_id, name, website, phone, town} rows, any of them NULL but place_id;
    `excluded` set on the ones already set aside as a chain's branches, store.D1.known_branches()) as listings to
    compare this run's with. A saved lead this run found again is left out: this run's listing of it is the fresh one,
    and a business is never its own duplicate."""
    in_run = {l.place_id for l in leads}
    return [Lead(place_id=k["place_id"], name=k.get("name") or "", trade="", search_town="", rank=None,
                 phone=k.get("phone") or "", website=k.get("website") or "", town=k.get("town") or "",
                 excluded=bool(k.get("excluded")))
            for k in known if k.get("place_id") and k["place_id"] not in in_run]


def _ranks(earlier: list[Lead], known: list[dict], in_pipeline=frozenset()) -> dict[str, int]:
    """Who a group keeps first: a lead already in outreach (4: a prospects row; its conversation is never cut off),
    then a saved lead this run didn't find again (3; only this run's listings are updated, so keeping it leaves exactly
    one pitchable listing), then a branch already set aside (2), then a saved lead this run found again (1: it may
    already be researched), then a new listing (0)."""
    ranks = {k["place_id"]: 1 for k in known if k.get("place_id")}
    return ranks | {l.place_id: 2 if l.excluded else 3 for l in earlier} | {p: 4 for p in in_pipeline}


def _keep(group: list[Lead], ranks: dict[str, int], key) -> Lead:
    """The listing a group keeps: a saved lead always (_ranks), else the best by key; on a tie the first one."""
    return max(group, key=lambda l: (ranks.get(l.place_id, 0), key(l)))


def _groups(listings: list[Lead], key, old: set[str]) -> list[list[Lead]]:
    """Listings grouped by key(listing) (skipped when falsy). Only groups with two or more listings, at least one of
    them from this run: earlier leads matching only each other aren't this run's business."""
    groups: dict[str, list[Lead]] = {}
    for listing in listings:
        if k := key(listing):
            groups.setdefault(k, []).append(listing)
    return [g for g in groups.values() if len(g) > 1 and any(l.place_id not in old for l in g)]


def _duplicates(leads: list[Lead], earlier: list[Lead], ranks: dict[str, int]) -> dict[str, str]:
    """Same phone number = same business listed twice. Keep the saved lead (_ranks), else the listing with a real
    website, else the most reviewed; return {place_id: name of the listing we kept} for the others. A closed listing is
    only ever "Closed": the open listing is never called a duplicate of it."""
    old = {l.place_id for l in earlier}
    dupes: dict[str, str] = {}
    for group in _groups([*earlier, *leads], lambda l: not _closed(l) and _phone_key(l.phone), old):
        keep = _keep(group, ranks, lambda l: (bool(l.website and is_real_website(l.website)), l.review_count))
        for lead in group:
            if lead is not keep:
                dupes[lead.place_id] = keep.name
    return dupes


def _same_site(leads: list[Lead], dupes: dict[str, str], earlier: list[Lead],
               ranks: dict[str, int]) -> tuple[dict[str, str], set[str]]:
    """Listings sharing one real website host (this run's and earlier leads). All in one town = one business listed
    twice: keep the saved lead (_ranks), else the most reviewed; the rest are duplicates ({place_id: name of the listing
    we kept}). In more than one town = a chain or multi-branch business: every one of them goes in the second result,
    earlier leads too. A branch already set aside only ever shows a second town here (it keeps a franchise's next town
    a branch, but nothing is a duplicate of it by website). Closed listings don't count (a sole trader's old listing in the
    town they moved from doesn't make them a chain), and a saved lead with no town can't show a second town."""
    old = {l.place_id for l in earlier}
    set_aside = {l.place_id for l in earlier if l.excluded}
    same: dict[str, str] = {}
    branches: set[str] = set()

    def site(l: Lead) -> str:
        return "" if _closed(l) or l.place_id in dupes else _own_host(l.website)

    for group in _groups([*earlier, *leads], site, old):
        if len({town_key(l.town or l.search_town) for l in group} - {""}) > 1:
            branches |= {l.place_id for l in group}
            continue
        group = [l for l in group if l.place_id not in set_aside]
        if len(group) < 2:
            continue
        keep = _keep(group, ranks, lambda l: l.review_count)
        for lead in group:
            if lead is not keep:
                same[lead.place_id] = keep.name
    return same, branches


def mark_exclusions(leads: list[Lead], known: list[dict] = (), in_pipeline=frozenset()) -> list[str]:
    """Set excluded/exclude_reason in place. Excluded leads are kept (for transparency) but never pitched.
    known = {place_id, name, website, phone, town} of saved, not-excluded leads (store.D1.known_leads()), so a business
    found again from another search is a duplicate of the saved lead and a franchise's branches are caught across
    searches; plus the branches already set aside (store.D1.known_branches(), `excluded` set), so a franchise's next
    town is a branch too. in_pipeline = place_ids with a prospects row (store.D1.in_pipeline()): already in outreach,
    so never a duplicate or a branch (a group holding one keeps it; its other listings are still set aside), or this
    run's save would set it aside mid-conversation. Returns the not-excluded known place_ids, none in outreach, that
    are now branches (store.D1.exclude_chains() sets them aside)."""
    earlier = _earlier(leads, known)
    ranks = _ranks(earlier, known, in_pipeline)
    dupes = _duplicates(leads, earlier, ranks)
    # the same website on several listings: one town = a duplicate listing, several towns = a chain or branches
    same_site, branches = _same_site(leads, dupes, earlier, ranks)
    dupes |= same_site
    for lead in leads:
        reason = ""
        if _closed(lead):
            reason = "Closed"
        elif lead.place_id in dupes and lead.place_id not in in_pipeline:
            reason = f"Duplicate listing of {dupes[lead.place_id]}"
        elif CHAINS.search(lead.name):
            reason = "Chain / national brand"
        elif lead.place_id in branches and lead.place_id not in in_pipeline:
            reason = "Multiple branches (chain)"
        elif FRONT_DESK_TYPES & set(lead.types) or FRONT_DESK_WORDS.search(lead.name):
            reason = "Front desk / gatekeeper"
        lead.excluded, lead.exclude_reason = bool(reason), reason
    return [l.place_id for l in earlier if l.place_id in branches and not l.excluded and l.place_id not in in_pipeline]


def score(leads: list[Lead], scan: "Scan | None" = None) -> None:
    """Add Google Maps findings from the scan (if any), then score every lead (scoring.py).
    The scan covers the searched town only, so it says something only about leads whose own postal town that is
    (map_rank["home"] True). A lead found from a neighbouring town gets no Maps findings and none of the scan's
    numbers (outreach and the call script read them as "of {their town}"), only scan_town and home False; its Maps
    part from a scan of its own town is kept when it's saved (store.keep_home_maps)."""
    by_id = {b.place_id: b for b in scan.businesses} if scan else {}
    leaders = [b.review_count for b in (scan.businesses[:3] if scan else []) if b.review_count]
    for lead in leads:
        extra: list[tuple[str, str]] = []
        if scan and town_key(lead.town or lead.search_town) != town_key(scan.town):
            lead.map_rank = {"scan_town": scan.town, "home": False}
        elif scan:
            b = by_id.get(lead.place_id)
            avg, top3, found = (b.avg_rank, b.top3_pct, b.found_pct) if b else (float(maprank.NOT_FOUND), 0, 0)
            # leader_reviews: so the reviews line can be written again with a later review count (store.keep_home_maps)
            lead.map_rank = {"avg_rank": avg, "top3_pct": top3, "found_pct": found, "scan_town": scan.town, "home": True,
                             "leader_reviews": leaders}
            extra += scoring.maps_findings(avg, top3, found, scan.town)
            extra += scoring.reviews_finding(lead.review_count, leaders)
        for key, text in extra:
            if key not in lead.findings:
                lead.findings.append(key)
                lead.issues.append(text)
        result = scoring.score(lead.findings)
        lead.quality_score, lead.score_parts = result.total, result.as_dict()
