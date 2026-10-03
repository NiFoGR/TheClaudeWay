"""Filtering (who we never pitch) and the quality score (how much we can help)."""

import re
from collections import Counter

from goldbar_leads.audit import host_of, is_real_website
from goldbar_leads.models import Lead

# Front-desk / gatekeeper businesses: the owner won't read our email.
FRONT_DESK_TYPES = {
    "dentist", "dental_clinic", "doctor", "hospital", "medical_lab", "physiotherapist", "pharmacy", "drugstore",
    "veterinary_care", "lawyer", "bank", "insurance_agency", "real_estate_agency",
    "school", "university", "local_government_office", "supermarket", "department_store", "shopping_mall",
}
FRONT_DESK_WORDS = re.compile(r"\b(clinic|surgery|hospital|practice|solicitors|nhs|council)\b", re.I)

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

# Issue weights: how much each problem means we can help. "No website" maxes out on its own.
WEIGHTS = [
    ("No website", 100),
    ("No proper website", 95),
    ("Website is down", 90),
    ("Website is broken", 90),
    ("security warning", 60),
    ("Couldn't check", 0),
    ("Not mobile-friendly", 25),
    ('"Not secure"', 15),
    ("Looks outdated", 20),
    ("Built on a DIY builder", 15),
    ("Slow to load", 10),
    ("No contact or quote form", 10),
    ("tap-to-call", 5),
    ("No chat", 5),
    ("No page title", 10),
    ("not in the page title", 5),
    ("No Google description", 5),
    ("No main heading", 5),
]


def _phone_key(phone: str) -> str:
    digits = re.sub(r"\D", "", phone)
    return digits[-10:] if len(digits) >= 10 else ""


def _duplicates(leads: list[Lead]) -> dict[str, str]:
    """Same phone number = same business listed twice. Keep the listing with a real website (else the most
    reviewed); return {place_id: name of the listing we kept} for the others."""
    groups: dict[str, list[Lead]] = {}
    for lead in leads:
        if key := _phone_key(lead.phone):
            groups.setdefault(key, []).append(lead)
    dupes: dict[str, str] = {}
    for group in groups.values():
        if len(group) < 2:
            continue
        keep = max(group, key=lambda l: (bool(l.website and is_real_website(l.website)), l.review_count))
        for lead in group:
            if lead is not keep:
                dupes[lead.place_id] = keep.name
    return dupes


def mark_exclusions(leads: list[Lead]) -> None:
    """Set excluded/exclude_reason in place. Excluded leads are kept (for transparency) but never pitched."""
    dupes = _duplicates(leads)
    # the same website across several listings = a chain or multi-branch business
    site_counts = Counter(
        host_of(l.website) for l in leads if l.place_id not in dupes and l.website and is_real_website(l.website)
    )
    for lead in leads:
        reason = ""
        if lead.business_status and lead.business_status != "OPERATIONAL":
            reason = "Closed"
        elif lead.place_id in dupes:
            reason = f"Duplicate listing of {dupes[lead.place_id]}"
        elif CHAINS.search(lead.name):
            reason = "Chain / national brand"
        elif lead.website and is_real_website(lead.website) and site_counts[host_of(lead.website)] > 1:
            reason = "Multiple branches (chain)"
        elif FRONT_DESK_TYPES & set(lead.types) or FRONT_DESK_WORDS.search(lead.name):
            reason = "Front desk / gatekeeper"
        lead.excluded, lead.exclude_reason = bool(reason), reason


def quality_score(issues: list[str]) -> int:
    total = 0
    for issue in issues:
        total += next((w for key, w in WEIGHTS if key in issue), 0)
    return min(total, 100)


def score(leads: list[Lead]) -> None:
    for lead in leads:
        lead.quality_score = quality_score(lead.issues)
