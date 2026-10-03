"""The lead score: how much GoldBar can help this business, 0-100. Higher = better lead.

Three parts, matching what we sell (rules from docs/playbooks/local-seo-client-workflow.pdf plus design checks):

  Website    45  is the site itself losing them customers? (mobile, security, age, build, speed, contact)
  Local SEO  30  does the site tell Google what they do and where? (title, heading, schema, NAP, map, pages)
  Google Maps 25 where do they actually show up across town, and are they behind on reviews?

No website / broken website = Website and Local SEO maxed (75). Invisible on Maps on top of that = 100.
Every point comes from a finding with a plain-English line that can be quoted (politely) in outreach.
"""

from dataclasses import dataclass

PILLAR_MAX = {"website": 45, "seo": 30, "maps": 25}

# finding key → (pillar, points)
RULES: dict[str, tuple[str, int]] = {
    # no usable website: both site pillars maxed
    "no_website": ("site_missing", 75),
    "profile_only": ("site_missing", 75),
    "site_down": ("site_missing", 75),
    "site_broken": ("site_missing", 75),
    "bad_certificate": ("site_missing", 70),
    "not_checked": ("site_missing", 0),  # firewall blocked our checker: unknown, never pitch on it
    # Website (45)
    "not_mobile": ("website", 14),
    "not_secure": ("website", 8),
    "outdated": ("website", 6),
    "old_build": ("website", 5),
    "very_slow": ("website", 6),
    "slow": ("website", 4),
    "no_form": ("website", 4),
    "no_tap_to_call": ("website", 2),
    "diy_builder": ("website", 0),  # information only: Wix sites can be fine
    "no_chat": ("website", 0),      # information only: nearly everyone lacks one; it's a pitch line, not a flaw
    # Local SEO (30), from the playbook
    "no_title": ("seo", 11),
    "title_no_trade": ("seo", 6),
    "title_no_town": ("seo", 5),
    "no_h1": ("seo", 4),
    "h1_weak": ("seo", 2),
    "no_schema": ("seo", 4),
    "phone_not_on_site": ("seo", 3),
    "address_not_on_site": ("seo", 2),
    "no_map": ("seo", 2),
    "few_pages": ("seo", 4),
    "some_pages": ("seo", 2),
    "no_description": ("seo", 2),
    # Google Maps (25)
    "maps_invisible": ("maps", 22),
    "maps_rarely_found": ("maps", 18),
    "maps_no_top3": ("maps", 12),
    "maps_some_top3": ("maps", 6),
    "reviews_behind": ("maps", 3),
}


@dataclass
class Score:
    total: int
    website: int
    seo: int
    maps: int

    def as_dict(self) -> dict:
        return {"total": self.total, "website": self.website, "seo": self.seo, "maps": self.maps}


def score(findings: list[str]) -> Score:
    parts = {"website": 0, "seo": 0, "maps": 0}
    missing = 0
    for key in findings:
        pillar, points = RULES.get(key, ("website", 0))
        if pillar == "site_missing":
            missing = max(missing, points)
        else:
            parts[pillar] += points
    if missing:  # nothing to audit on the site itself: split the site points across Website and SEO
        parts["website"] = round(missing * PILLAR_MAX["website"] / 75)
        parts["seo"] = missing - parts["website"]
    parts = {k: min(v, PILLAR_MAX[k]) for k, v in parts.items()}
    return Score(total=min(100, sum(parts.values())), **parts)


def maps_findings(avg_rank: float, top3_pct: int, found_pct: int, town: str) -> list[tuple[str, str]]:
    """Map Rank results → findings (one at most)."""
    if found_pct == 0:
        return [("maps_invisible", f"Not in Google Maps' top 20 anywhere we checked across {town}")]
    if found_pct < 50:
        return [("maps_rarely_found", f"Shows up in Google Maps' top 20 in only {found_pct}% of {town}")]
    if top3_pct == 0:
        return [("maps_no_top3", f"Never in Google Maps' top 3 across {town} (average position #{avg_rank:.0f})")]
    if top3_pct < 50:
        return [("maps_some_top3", f"In Google Maps' top 3 in only {top3_pct}% of {town}")]
    return []


def reviews_finding(review_count: int, leader_reviews: list[int]) -> list[tuple[str, str]]:
    """Behind the top 3 on reviews (the playbook: 'tell them to get their butts in gear')."""
    if not leader_reviews:
        return []
    typical = sorted(leader_reviews)[len(leader_reviews) // 2]
    if typical >= 10 and review_count < typical / 2:
        return [("reviews_behind", f"Fewer Google reviews than the top 3 nearby ({review_count} vs about {typical})")]
    return []
