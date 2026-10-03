"""Who runs the business, so emails open with "Hi Dave," instead of "Hi,".

Names are recognised dynamically with spaCy's English name recogniser (it reads the sentence, so it finds Kasia,
Rajesh or Grant without any list). The small built-in first-name list is only a fallback if spaCy isn't installed.

Sources, most trusted first:
  1. website   their own words: "I'm Dave", "my name is…", "Meet Dave", "Dave Smith, owner", "run by…",
               schema.org founder; or the one person their about/team page keeps naming
  2. reviews   customers naming the same person in 2+ Google reviews: "Dave was brilliant", "thanks to Kasia"
  3. email     a person's address on their own domain: dave@, dave.smith@
  4. business  the name says it: "Dave's Plumbing", "Rajesh Patel Electrical"
  (5. Companies House director: added later by the pipeline, only if none of the above found anyone)
"""

import re
from collections import Counter
from functools import lru_cache

from bs4 import BeautifulSoup

from aetos_leads.first_names import is_first_name

MAX_TEXT = 30_000  # characters per page given to the name recogniser
OWNER_CUES = re.compile(
    r"\b(i'm|i am|my name|owner|founder|founded|director|proprietor|run by|owned by|started by|established by|"
    r"set up by|meet|myself|managing|ceo|boss|family[- ]run|sole trader|head engineer|lead engineer)\b", re.I)
# words the name recogniser sometimes mistakes for people in trade text
NOT_NAMES = {
    "google", "facebook", "instagram", "checkatrade", "trustatrade", "which", "gas", "safe", "nice", "great", "thanks",
    "thank", "cheers", "excellent", "brilliant", "highly", "would", "very", "the", "team", "lads", "boss", "sir",
    "madam", "mr", "mrs", "ms", "miss", "dr", "hi", "hello", "dear", "roofing", "plumbing", "heating", "electrical",
    "roofer", "plumber", "electrician", "builder", "locksmith", "mechanic", "removals", "gutter", "boiler", "about",
    "contact", "home", "services", "quote", "free", "call", "ltd", "limited", "uk", "england", "london", "five", "star",
    # mailbox names that aren't people
    "info", "enquiries", "enquiry", "sales", "admin", "office", "hello", "mail", "accounts", "bookings", "booking",
    "support", "service", "quotes", "jobs", "reception", "help", "web", "design", "marketing", "noreply", "post",
    "customer", "customers", "orders", "repairs", "work", "hq", "general", "manager", "owner",
    # words that start a sentence about someone, which the recogniser can glue onto the name ("Meet Grant")
    "meet", "owner", "founder", "director", "contact", "ask", "call", "speak", "message", "email",
}
NOT_SURNAMES = {"our", "the", "and", "from", "at", "of", "your", "we", "is", "has", "here", "who", "with", "for", "in", "on",
                "and", "said", "was", "were", "came", "did", "does"}
_PATTERNS = [
    re.compile(r"\b(?:my name is|my name's|i'm|i am|hi,? i'm|hello,? i'm)\s+([A-Za-z][a-z'’-]{1,20})(?:\s+([A-Z][a-z'’-]{1,20}))?", re.I),
    re.compile(r"\b[Mm]eet\s+([A-Z][a-z'’-]{1,20})(?:\s+([A-Z][a-z'’-]{1,20}))?"),
    re.compile(r"\b(?:founded|owned|run|started|established|set up)\s+by\s+([A-Z][a-z'’-]{1,20})(?:\s+([A-Z][a-z'’-]{1,20}))?"),
    re.compile(r"\b(?:owner|founder|director|proprietor|managing director)[,:\s-]+([A-Z][a-z'’-]{1,20})(?:\s+([A-Z][a-z'’-]{1,20}))?", re.I),
    re.compile(r"([A-Z][a-z'’-]{1,20})(?:\s+([A-Z][a-z'’-]{1,20}))?\s*[,–-]\s*(?:owner|founder|director|proprietor|managing director)\b", re.I),
]


@lru_cache(maxsize=1)
def _nlp():
    try:
        import spacy

        return spacy.load("en_core_web_sm", exclude=["lemmatizer"])
    except Exception:  # not installed (e.g. a minimal test run): fall back to the first-name list
        return None


def _clean(word: str) -> str:
    return re.sub(r"['’]s$", "", word.strip(".,'’!?:;()\"")).strip()


@lru_cache(maxsize=4096)
def looks_like_name(word: str, strict: bool = False) -> bool:
    """Is this word someone's first name? Checked by how the recogniser reads it in neutral sentences
    (strict: all three must agree, used for lone words like an email's "dave@")."""
    w = _clean(word)
    if len(w) < 2 or not w[0].isalpha() or w.lower() in NOT_NAMES:
        return False
    if is_first_name(w):
        return True
    nlp = _nlp()
    if not nlp:
        return False
    w = w[0].upper() + w[1:].lower()
    hits = 0
    for template in ("My friend {} came round yesterday.", "I spoke to {} on the phone.", "Thanks {}, see you soon."):
        doc = nlp(template.format(w))
        hits += any(e.label_ == "PERSON" and w in e.text.split() for e in doc.ents)
    return hits >= (3 if strict else 2)


@lru_cache(maxsize=4096)
def looks_like_full_name(first: str, last: str) -> bool:
    """"Grant Wilkinson" reads as a person even when "Grant" alone could be a word."""
    nlp = _nlp()
    if not nlp or not last or last.lower() in NOT_NAMES or last.lower() in NOT_SURNAMES:
        return False
    full = f"{_clean(first)} {_clean(last)}"
    hits = sum(any(e.label_ == "PERSON" and e.text == full for e in nlp(t.format(full)).ents)
               for t in ("I spoke to {} on the phone.", "My friend {} came round yesterday.", "Thanks {}, see you soon."))
    return hits >= 2


def _person(first: str, last: str | None = None) -> tuple[str, str]:
    first = _clean(first)
    first = first[0].upper() + first[1:].lower()
    last = _clean(last) if last else ""
    ok = len(last) > 1 and last[0].isupper() and last.lower() not in NOT_NAMES and last.lower() not in NOT_SURNAMES
    return (first, f"{first} {last}") if ok else (first, first)


def _people(text: str, nlp) -> list[tuple[str, str | None]]:
    """(first, last) for every person the recogniser finds in the text."""
    out = []
    for ent in nlp(text[:MAX_TEXT]).ents:
        if ent.label_ != "PERSON":
            continue
        parts = [_clean(p) for p in ent.text.split() if _clean(p)]
        while parts and parts[0].lower() in NOT_NAMES:
            parts = parts[1:]
        if parts and parts[0][0].isupper() and parts[0].lower() not in NOT_NAMES and len(parts) <= 3:
            out.append((parts[0], parts[-1] if len(parts) > 1 else None))
    return out


def from_website(texts: list[str], htmls: list[str] = ()) -> tuple[str, str] | None:
    for html in htmls:  # schema.org: {"founder": {"name": "Dave Smith"}}
        for block in re.findall(r"<script[^>]+ld\+json[^>]*>(.*?)</script>", html, re.S | re.I):
            for name in re.findall(r'"(?:founder|employee|author)"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]{3,40})"', block):
                parts = name.split()
                if parts and looks_like_name(parts[0]):
                    return _person(parts[0], parts[1] if len(parts) > 1 else None)
    for text in texts:  # explicit self-introductions / owner labels
        for pattern in _PATTERNS:
            for m in pattern.finditer(text):
                word = m.group(1)
                # a capitalised word the recogniser reads as a name, or a known first name in any case ("i'm dave")
                last = m.group(2)
                if (word[0].isupper() and (looks_like_name(word) or (last and looks_like_full_name(word, last)))) or is_first_name(word):
                    return _person(word, last)
    nlp = _nlp()
    if not nlp:
        return None
    # a person named in a sentence about who runs the place
    for text in texts:
        for sent in nlp(text[:MAX_TEXT]).sents:
            if OWNER_CUES.search(sent.text):
                found = _people(sent.text, nlp)
                if found:
                    return _person(*found[0])
    # the one person the site keeps naming (e.g. an about page all about "Dave")
    counts = Counter(first for text in texts for first, _ in _people(text, nlp))
    if counts:
        (name, n), *rest = counts.most_common(2)
        if n >= 3 and (not rest or rest[0][1] < n / 2):
            return _person(name)
    return None


def from_reviews(reviews: list[dict]) -> tuple[str, str] | None:
    """A first name that 2+ different reviewers mention (not their own name)."""
    nlp = _nlp()
    counts: Counter[str] = Counter()
    for r in reviews:
        author = {w.lower() for w in str(r.get("author", "")).split()}
        text = str(r.get("text", ""))
        if nlp:
            names = {first for first, _ in _people(text, nlp)}
        else:
            names = {w for w in re.findall(r"\b([A-Z][a-z]{1,14})\b", text) if is_first_name(w)}
        counts.update({n for n in names if n.lower() not in author})
    if counts:
        name, n = counts.most_common(1)[0]
        if n >= 2:
            return _person(name)
    return None


def from_email(emails: list[str], site_host: str, known: set[str] = frozenset()) -> tuple[str, str] | None:
    for e in emails:
        local, _, domain = e.lower().partition("@")
        if site_host and not (domain == site_host or domain.endswith("." + site_host)):
            continue
        parts = re.split(r"[._-]", local)
        if parts and len(parts[0]) > 1 and (parts[0] in known or looks_like_name(parts[0], strict=True)):
            return _person(parts[0], parts[1].title() if len(parts) > 1 and len(parts[1]) > 2 else None)
    return None


def from_business_name(name: str) -> tuple[str, str] | None:
    m = re.match(r"^\s*([A-Z][a-z]+)(?:['’]s\b|\s+([A-Z][a-z]+)\s+(?:&|and\s+)?\w)", name)
    if m and looks_like_name(m.group(1)) and not (m.group(2) and m.group(2).lower() in NOT_NAMES):
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
