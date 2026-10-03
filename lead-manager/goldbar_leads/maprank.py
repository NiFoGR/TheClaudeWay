"""Map Rank: where businesses appear on Google Maps across a town, LeadSnap-style.

A grid of points is laid over the town. At each point we ask Google for "<keyword>" as if the searcher were
standing there (a location bias around the point) and record the order of the top 20 businesses.
Asking only for place IDs is Google's "Text Search Essentials (IDs Only)" SKU: $0 with no cap.
Names, ratings and reviews come from leads we've already scraped, or one paid details call for the few
top competitors we don't know yet.

Approximation caveat: real phones personalise results, so this mirrors what rank-grid tools show, not one
exact phone. Good enough for "you're invisible in the north of town" and for before/after comparisons.
"""

import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import httpx

from goldbar_leads import usage
from goldbar_leads.places import SEARCH_URL, PlacesError

NOT_FOUND = 21  # rank used for averages when a business isn't in the top 20 at a point
MAX_RANK = 20
DETAILS_URL = "https://places.googleapis.com/v1/places/{id}"
GRID_SIZES = (3, 5, 7, 9, 11, 13)


@dataclass
class Point:
    row: int
    col: int
    lat: float
    lng: float
    ranking: list[str] = field(default_factory=list)  # place ids, best first


@dataclass
class BusinessResult:
    place_id: str
    name: str = ""
    rating: float | None = None
    review_count: int = 0
    avg_rank: float = NOT_FOUND
    top3_pct: int = 0
    found_pct: int = 0
    ranks: list[int | None] = field(default_factory=list)  # one per point, None = not in top 20


@dataclass
class Scan:
    keyword: str
    town: str
    grid: int
    spacing_m: int
    center_lat: float
    center_lng: float
    points: list[Point]
    businesses: list[BusinessResult]


def locate_town(client: httpx.Client, api_key: str, town: str) -> tuple[float, float]:
    resp = client.post(
        SEARCH_URL,
        json={"textQuery": f"{town}, UK", "regionCode": "GB", "pageSize": 1},
        headers={"X-Goog-Api-Key": api_key, "X-Goog-FieldMask": "places.location"},
    )
    usage.count(usage.TEXT_SEARCH_PRO)
    if resp.status_code != 200:
        raise PlacesError(f"Places API {resp.status_code}: {resp.text[:300]}")
    places = resp.json().get("places", [])
    if not places:
        raise PlacesError(f"Couldn't find the town {town!r} on Google Maps")
    loc = places[0]["location"]
    return loc["latitude"], loc["longitude"]


def grid_points(lat: float, lng: float, size: int, spacing_m: int) -> list[Point]:
    """size x size points centred on (lat, lng), spacing_m metres apart."""
    half = (size - 1) / 2
    points = []
    for row in range(size):
        for col in range(size):
            dy = (half - row) * spacing_m  # row 0 = north
            dx = (col - half) * spacing_m
            points.append(Point(
                row=row,
                col=col,
                lat=round(lat + dy / 111_320, 6),
                lng=round(lng + dx / (111_320 * math.cos(math.radians(lat))), 6),
            ))
    return points


def ranking_at(client: httpx.Client, api_key: str, keyword: str, lat: float, lng: float, radius_m: int) -> list[str]:
    resp = client.post(
        SEARCH_URL,
        json={
            "textQuery": keyword,
            "pageSize": MAX_RANK,
            "regionCode": "GB",
            "includePureServiceAreaBusinesses": True,
            "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": radius_m}},
        },
        headers={"X-Goog-Api-Key": api_key, "X-Goog-FieldMask": "places.id"},  # IDs only = free
    )
    usage.count(usage.TEXT_SEARCH_IDS)
    if resp.status_code != 200:
        raise PlacesError(f"Places API {resp.status_code}: {resp.text[:300]}")
    return [p["id"] for p in resp.json().get("places", [])][:MAX_RANK]


def summarise(points: list[Point]) -> list[BusinessResult]:
    """Per business: rank at every point, average rank, share of the town where top 3 / found at all."""
    ids: list[str] = []
    for p in points:
        ids += [i for i in p.ranking if i not in ids]
    results = []
    for place_id in ids:
        ranks = [p.ranking.index(place_id) + 1 if place_id in p.ranking else None for p in points]
        n = len(points)
        results.append(BusinessResult(
            place_id=place_id,
            avg_rank=round(sum(r or NOT_FOUND for r in ranks) / n, 2),
            top3_pct=round(100 * sum(1 for r in ranks if r and r <= 3) / n),
            found_pct=round(100 * sum(1 for r in ranks if r) / n),
            ranks=ranks,
        ))
    return sorted(results, key=lambda b: (b.avg_rank, -b.found_pct))


def fill_names(client: httpx.Client, api_key: str, businesses: list[BusinessResult], known: dict[str, dict], limit: int = 15) -> None:
    """Names/ratings from leads we already have; one details call each for the top unknown competitors."""
    for b in businesses:
        if info := known.get(b.place_id):
            b.name, b.rating, b.review_count = info.get("name", ""), info.get("rating"), info.get("review_count") or 0
    for b in [b for b in businesses if not b.name][:limit]:
        try:
            resp = client.get(
                DETAILS_URL.format(id=b.place_id),
                headers={"X-Goog-Api-Key": api_key, "X-Goog-FieldMask": "displayName,rating,userRatingCount"},
            )
            usage.count(usage.PLACE_DETAILS_ENTERPRISE)
            if resp.status_code == 200:
                data = resp.json()
                b.name = data.get("displayName", {}).get("text", "")
                b.rating, b.review_count = data.get("rating"), data.get("userRatingCount", 0)
        except httpx.HTTPError:
            continue


def run(api_key: str, keyword: str, town: str, grid: int = 5, spacing_m: int = 1600,
        known: dict[str, dict] | None = None, client: httpx.Client | None = None) -> Scan:
    if grid not in GRID_SIZES:
        raise ValueError(f"grid must be one of {GRID_SIZES}")
    own = client is None
    client = client or httpx.Client(timeout=30)
    try:
        lat, lng = locate_town(client, api_key, town)
        points = grid_points(lat, lng, grid, spacing_m)
        radius = max(500, spacing_m // 2)
        with ThreadPoolExecutor(max_workers=8) as pool:
            rankings = list(pool.map(lambda p: ranking_at(client, api_key, keyword, p.lat, p.lng, radius), points))
        for p, r in zip(points, rankings):
            p.ranking = r
        businesses = summarise(points)
        fill_names(client, api_key, businesses, known or {})
        return Scan(keyword, town, grid, spacing_m, lat, lng, points, businesses)
    finally:
        if own:
            client.close()
