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


def mark_exclusions(leads: list[Lead]) -> None:
    """Set excluded/exclude_reason in place. Excluded leads are kept (for transparency) but never pitched."""
    # the same website across several listings = a chain or multi-branch business
    site_counts = Counter(host_of(l.website) for l in leads if l.website and is_real_website(l.website))
    for lead in leads:
        reason = ""
        if lead.business_status and lead.business_status != "OPERATIONAL":
            reason = "Closed"
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
