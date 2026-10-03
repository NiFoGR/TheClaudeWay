"""Discovery via Google Places API (New) Text Search.

Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
Each call returns up to 20 places; Google caps a query at about 60 results (3 pages).
Results come back in Google's relevance order, which we record as the business's rank.
"""

import httpx

from aetos_leads import usage
from aetos_leads.models import Lead

SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"

FIELDS = ",".join(
    [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.addressComponents",
        "places.nationalPhoneNumber",
        "places.websiteUri",
        "places.googleMapsUri",
        "places.rating",
        "places.userRatingCount",
        "places.businessStatus",
        "places.types",
        "places.reviews",  # up to 5; customers often name the owner ("Dave was brilliant")
        "nextPageToken",
    ]
)


class PlacesError(RuntimeError):
    pass


def _component(place: dict, kind: str) -> str:
    for c in place.get("addressComponents", []):
        if kind in c.get("types", []):
            return c.get("longText", "")
    return ""


def to_lead(place: dict, trade: str, town: str, rank: int | None) -> Lead:
    return Lead(
        place_id=place["id"],
        name=place.get("displayName", {}).get("text", ""),
        trade=trade,
        search_town=town,
        rank=rank,
        address=place.get("formattedAddress", ""),
        town=_component(place, "postal_town") or _component(place, "locality") or town,
        postcode=_component(place, "postal_code"),
        phone=place.get("nationalPhoneNumber", ""),
        website=place.get("websiteUri", ""),
        maps_url=place.get("googleMapsUri", ""),
        rating=place.get("rating"),
        review_count=place.get("userRatingCount", 0),
        business_status=place.get("businessStatus", ""),
        types=place.get("types", []),
        reviews=[{"author": r.get("authorAttribution", {}).get("displayName", ""), "text": (r.get("text") or r.get("originalText") or {}).get("text", "")}
                 for r in place.get("reviews", [])],
    )


# Google caps one query at ~60 results, so bigger targets add these variations and de-duplicate.
QUERY_VARIANTS = [
    "{trade} in {town}",
    "{trade} near {town}",
    "{trade} services in {town}",
    "local {trade} {town}",
    "emergency {trade} {town}",
    "best {trade} in {town}",
]
MAX_PER_QUERY = 60


def _query(client: httpx.Client, api_key: str, text_query: str) -> list[dict]:
    body = {
        "textQuery": text_query,
        "pageSize": 20,
        "regionCode": "GB",
        "languageCode": "en-GB",
        # trades are mostly service-area businesses with no shopfront; without this Google drops them
        "includePureServiceAreaBusinesses": True,
    }
    headers = {"X-Goog-Api-Key": api_key, "X-Goog-FieldMask": FIELDS}
    found: list[dict] = []
    while len(found) < MAX_PER_QUERY:
        resp = client.post(SEARCH_URL, json=body, headers=headers)
        usage.count(usage.TEXT_SEARCH_ATMOSPHERE)
        if resp.status_code != 200:
            raise PlacesError(f"Places API {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        found += data.get("places", [])
        token = data.get("nextPageToken")
        if not token:
            break
        body["pageToken"] = token
    return found


def search(client: httpx.Client, api_key: str, trade: str, town: str, max_results: int = 60) -> list[Lead]:
    """Up to max_results distinct businesses. Rank = position in the main '<trade> in <town>' search
    (what a customer sees); businesses only found by the extra variations get no rank."""
    leads: list[Lead] = []
    seen: set[str] = set()
    for i, template in enumerate(QUERY_VARIANTS):
        for pos, place in enumerate(_query(client, api_key, template.format(trade=trade, town=town)), start=1):
            if place["id"] in seen:
                continue
            seen.add(place["id"])
            leads.append(to_lead(place, trade, town, rank=pos if i == 0 else None))
            if len(leads) >= max_results:
                return leads
    return leads
