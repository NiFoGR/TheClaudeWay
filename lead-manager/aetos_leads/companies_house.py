"""Director lookup via the free Companies House API, so emails can open with "Hi Dave".

Docs: https://developer-specs.company-information.service.gov.uk/
Auth: the API key is the basic-auth username with an empty password. Limit: 600 requests / 5 minutes.
Sole traders aren't on the register, so many leads won't match; that's expected.
"""

import re
from difflib import SequenceMatcher

import httpx

from aetos_leads.models import Lead

BASE = "https://api.company-information.service.gov.uk"
MATCH_THRESHOLD = 0.85
_SUFFIXES = re.compile(r"\b(ltd|limited|llp|plc|co|company|uk|the)\b|[^a-z0-9 ]")


def normalise(name: str) -> str:
    return " ".join(_SUFFIXES.sub(" ", name.lower().replace("&", " and ")).split())


def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, normalise(a), normalise(b)).ratio()


def _first_name(officer_name: str) -> tuple[str, str]:
    """Companies House gives 'SURNAME, Firstname Middle' → ('Firstname', 'Firstname Surname')."""
    surname, _, rest = officer_name.partition(",")
    first = rest.strip().split(" ")[0].title() if rest.strip() else ""
    return first, f"{first} {surname.strip().title()}".strip()


def find_director(client: httpx.Client, api_key: str, lead: Lead) -> None:
    """Fill lead.company_number / director_* in place when there's a confident match. Never raises."""
    try:
        resp = client.get(f"{BASE}/search/companies", params={"q": lead.name, "items_per_page": 10}, auth=(api_key, ""))
        if resp.status_code != 200:
            return
        best, best_score = None, 0.0
        for item in resp.json().get("items", []):
            if item.get("company_status") != "active":
                continue
            score = similarity(lead.name, item.get("title", ""))
            if lead.postcode and lead.postcode.replace(" ", "").upper() in (item.get("address_snippet") or "").replace(" ", "").upper():
                score += 0.1
            if score > best_score:
                best, best_score = item, score
        if not best or best_score < MATCH_THRESHOLD:
            return
        lead.company_number = best["company_number"]
        resp = client.get(f"{BASE}/company/{lead.company_number}/officers", auth=(api_key, ""))
        if resp.status_code != 200:
            return
        for officer in resp.json().get("items", []):
            if officer.get("officer_role") == "director" and not officer.get("resigned_on"):
                lead.director_first_name, lead.director_name = _first_name(officer.get("name", ""))
                return
    except httpx.HTTPError:
        return
