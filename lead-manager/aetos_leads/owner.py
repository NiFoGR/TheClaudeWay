"""Who runs the business, so emails open with "Hi Dave," instead of "Hi,".

Sources, most trusted first:
  1. website   their own words: "I'm Dave", "my name is Dave", "Meet Dave", "Dave Smith, owner", schema.org founder/Person
  2. reviews   customers naming the same person in 2+ Google reviews: "Dave was brilliant", "thanks to Dave"
  3. email     a person's address on their own domain: dave@, dave.smith@
  4. business  the name says it: "Dave's Plumbing", "Dave Smith Roofing"
  (5. Companies House director: added later by the pipeline, only if none of the above found anyone)

Only names in the first-name list count, so "Meet the team" or "Roofing was great" never become "Hi Team,".
"""

import re
from collections import Counter

from bs4 import BeautifulSoup

from aetos_leads.first_names import is_first_name

_WORD = r"([A-Z][a-z]{1,14})"
_SURNAME = r"(?:\s+([A-Z][a-z'’-]{1,20}))?"
# explicit self-introductions and "owner" labels on their own website
WEBSITE_PATTERNS = [
    re.compile(r"\b(?:my name is|my name's|i'm|i am|hi,? i'm|hello,? i'm)\s+" + _WORD + _SURNAME, re.I),
    re.compile(r"\b[Mm]eet\s+" + _WORD + _SURNAME),
    re.compile(r"\b(?:founded|owned|run|started|established)\s+by\s+" + _WORD + _SURNAME),
    re.compile(r"\b(?:owner|founder|director|proprietor|managing director|md)[,:\s-]+" + _WORD + _SURNAME, re.I),
    re.compile(_WORD + _SURNAME + r"\s*[,–-]\s*(?:owner|founder|director|proprietor|managing director)\b", re.I),
]
_REVIEW_NAME = re.compile(r"\b([A-Z][a-z]{1,14})\b")


_NOT_SURNAMES = {"our", "the", "and", "from", "at", "of", "your", "we", "is", "has", "here", "who", "with", "for", "in", "on"}


def _person(first: str, last: str | None = None) -> tuple[str, str]:
    first = first.strip().title()
    ok = last and not is_first_name(last) and last.strip().lower() not in _NOT_SURNAMES
    return first, f"{first} {last.strip().title()}" if ok else first


def from_website(texts: list[str], htmls: list[str] = ()) -> tuple[str, str] | None:
    for html in htmls:  # schema.org: {"founder": {"name": "Dave Smith"}} or a Person
        for block in re.findall(r'<script[^>]+ld\+json[^>]*>(.*?)</script>', html, re.S | re.I):
            for name in re.findall(r'"(?:founder|employee|author)"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]{3,40})"', block):
                parts = name.split()
                if parts and is_first_name(parts[0]):
                    return _person(parts[0], parts[1] if len(parts) > 1 else None)
    for text in texts:
        for pattern in WEBSITE_PATTERNS:
            for m in pattern.finditer(text):
                first, last = m.group(1), m.group(2) if m.lastindex and m.lastindex >= 2 else None
                if is_first_name(first):
                    return _person(first, last)
    return None


def from_reviews(reviews: list[dict]) -> tuple[str, str] | None:
    """A first name that 2+ different reviewers mention (not the reviewer's own name)."""
    counts: Counter[str] = Counter()
    for r in reviews:
        author = {w.lower() for w in str(r.get("author", "")).split()}
        names = {w for w in _REVIEW_NAME.findall(str(r.get("text", ""))) if is_first_name(w) and w.lower() not in author}
        counts.update(names)
    if counts:
        name, n = counts.most_common(1)[0]
        if n >= 2:
            return _person(name)
    return None


def from_email(emails: list[str], site_host: str) -> tuple[str, str] | None:
    for e in emails:
        local, _, domain = e.lower().partition("@")
        if site_host and not (domain == site_host or domain.endswith("." + site_host)):
            continue
        parts = re.split(r"[._-]", local)
        if parts and is_first_name(parts[0]):
            return _person(parts[0], parts[1] if len(parts) > 1 and len(parts[1]) > 2 else None)
    return None


def from_business_name(name: str) -> tuple[str, str] | None:
    m = re.match(r"^\s*([A-Z][a-z]+)(?:['’]s\b|\s+([A-Z][a-z]+)\s+(?:&|and\s+)?\w)", name)
    if m and is_first_name(m.group(1)):
        return _person(m.group(1), m.group(2))
    return None


def visible_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    return " ".join(soup.get_text(" ").split())


def find_owner(htmls: list[str], emails: list[str], site_host: str, business_name: str, reviews: list[dict]) -> dict:
    """Returns {"first", "full", "source"}; empty strings if nobody was found."""
    texts = [visible_text(h) for h in htmls]
    for source, found in (
        ("website", lambda: from_website(texts, htmls)),
        ("reviews", lambda: from_reviews(reviews)),
        ("email", lambda: from_email(emails, site_host)),
        ("business name", lambda: from_business_name(business_name)),
    ):
        hit = found()
        if hit:
            return {"first": hit[0], "full": hit[1], "source": source}
    return {"first": "", "full": "", "source": ""}

