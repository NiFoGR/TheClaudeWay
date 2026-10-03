"""Discovery via Google Places API (New) Text Search.

Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
Each call returns up to 20 places; Google caps a query at about 60 results (3 pages).
Results come back in Google's relevance order, which we record as the business's rank.
"""

import httpx

from goldbar_leads.models import Lead

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


def to_lead(place: dict, trade: str, town: str, rank: int) -> Lead:
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
    )


def search(client: httpx.Client, api_key: str, trade: str, town: str, max_results: int = 60) -> list[Lead]:
    """Return up to max_results businesses for '<trade> in <town>', in Google's order."""
    body = {
        "textQuery": f"{trade} in {town}",
        "pageSize": 20,
        "regionCode": "GB",
        "languageCode": "en-GB",
        # trades are mostly service-area businesses with no shopfront; without this Google drops them
        "includePureServiceAreaBusinesses": True,
    }
    headers = {"X-Goog-Api-Key": api_key, "X-Goog-FieldMask": FIELDS}
    leads: list[Lead] = []
    while len(leads) < max_results:
        resp = client.post(SEARCH_URL, json=body, headers=headers)
        if resp.status_code != 200:
            raise PlacesError(f"Places API {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        for place in data.get("places", []):
            leads.append(to_lead(place, trade, town, rank=len(leads) + 1))
        token = data.get("nextPageToken")
        if not token:
            break
        body["pageToken"] = token
    return leads[:max_results]
