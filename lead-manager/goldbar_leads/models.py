from dataclasses import dataclass, field


@dataclass
class Lead:
    """One business, from Google Maps discovery through qualification."""

    place_id: str
    name: str
    trade: str
    search_town: str
    rank: int | None  # position in Google results for "<trade> in <town>", 1 = top; None = found via a wider search
    address: str = ""
    town: str = ""
    postcode: str = ""
    phone: str = ""
    website: str = ""
    maps_url: str = ""
    rating: float | None = None
    review_count: int = 0
    business_status: str = ""
    types: list[str] = field(default_factory=list)

    # enrichment
    email: str = ""
    emails: list[str] = field(default_factory=list)
    socials: dict[str, str] = field(default_factory=dict)
    findings: list[str] = field(default_factory=list)  # finding keys (see scoring.RULES)
    issues: list[str] = field(default_factory=list)  # plain-English line per finding, quotable in outreach
    audit: dict = field(default_factory=dict)  # raw audit facts
    director_first_name: str = ""
    director_name: str = ""
    company_number: str = ""

    # qualification
    excluded: bool = False
    exclude_reason: str = ""
    quality_score: int = 0  # 0-100, how much we can help: higher = better lead (see scoring.py)
    score_parts: dict = field(default_factory=dict)  # {"website": .., "seo": .., "maps": ..}
    map_rank: dict = field(default_factory=dict)  # {"avg_rank", "top3_pct", "found_pct"} from the Map Rank scan
