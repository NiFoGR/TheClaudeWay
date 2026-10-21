"""Who runs the business, so emails open with "Hi Dave," instead of "Hi,".

Names are recognised dynamically with spaCy's English name recogniser (it reads the sentence, so it finds Kasia,
Rajesh or Grant without any list). The small built-in first-name list is only a fallback if spaCy isn't installed.

Sources, most trusted first:
  1. website   their own words: "I'm Dave", "my name is…", "Meet Dave", "Dave Smith, owner", "run by…",
               schema.org founder; or the one person their about/team page keeps naming
  2. reviews   customers naming the same person in 2+ Google reviews: "Dave was brilliant", "thanks to Kasia"
  3. email     a person's address on their own domain: dave@, dave.smith@
  4. business  the name says it, only with a known first name: "Dave's Plumbing", "Steve Brown Roofing"
  (5. Companies House director: added later by the pipeline, unless a confident name was already found)

A name is never taken from the business's own name words ("Diamond Kickboxing", "Gracie Barra", "The Forge"), the
town ("BJJ Warrington"), an acronym, or a famous person their site quotes ("Bruce Lee"). Only their own words
("I'm Dave", "Owner: Dave Smith", "led by Mark Matthews") or their own email count as confident; everything else is a
guess that Claude checks, and emails don't use a guessed name.
"""

import re
from collections import Counter
from functools import lru_cache

from bs4 import BeautifulSoup

from aetos_leads.first_names import is_first_name

MAX_TEXT = 30_000  # characters per page given to the name recogniser
OWNER_CUES = re.compile(
    r"\b(i'm|i am|my name|owner|founder|founded|director|proprietor|run by|owned by|started by|established by|"
    r"set up by|led by|coached by|meet|myself|managing|ceo|boss|family[- ]run|sole trader|head engineer|lead engineer|"
    r"head coach|head instructor|chief instructor)\b", re.I)
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
    # gym / martial arts / business words
    "bjj", "mma", "muay", "thai", "boxing", "kickboxing", "kick", "jiu", "jitsu", "jujitsu", "karate", "judo",
    "taekwondo", "krav", "maga", "gym", "fitness", "academy", "studio", "fight", "fighting", "combat", "sensei",
    "coach", "martial", "arts", "warrior", "warriors", "forge", "club", "centre", "center", "school", "dojo",
    "training", "nation", "elite", "pro", "premier", "brazilian", "self", "defence", "defense", "head",
}
# famous people a site might quote or name its style after; never the owner
FAMOUS = {"bruce lee", "muhammad ali", "mike tyson", "conor mcgregor", "anderson silva", "royce gracie", "helio gracie",
          "rickson gracie", "carlos gracie", "chuck norris", "jackie chan", "floyd mayweather", "tyson fury",
          "anthony joshua", "jon jones", "khabib nurmagomedov", "ronda rousey", "joe rogan", "georges st-pierre",
          "jean-claude van damme", "ip man", "buakaw banchamek", "ramon dekkers", "mark zuckerberg", "elon musk"}
NOT_SURNAMES = {"our", "the", "and", "from", "at", "of", "your", "we", "is", "has", "here", "who", "with", "for", "in", "on",
                "and", "said", "was", "were", "came", "did", "does"}
_PATTERNS = [
    re.compile(r"\b(?:my name is|my name's|i'm|i am|hi,? i'm|hello,? i'm)\s+([A-Za-z][a-z'’-]{1,20})(?:\s+([A-Z][a-z'’-]{1,20}))?", re.I),
    re.compile(r"\b[Mm]eet\s+([A-Z][a-z'’-]{1,20})(?:\s+([A-Z][a-z'’-]{1,20}))?"),
    re.compile(r"\b(?:founded|owned|run|started|established|set up|led|coached|headed)\s+by\s+([A-Z][a-z'’-]{1,20})(?:\s+([A-Z][a-z'’-]{1,20}))?"),
    re.compile(r"\b(?:owner|founder|director|proprietor|managing director|head coach|head instructor|chief instructor)[,:\s-]+([A-Z][a-z'’-]{1,20})(?:\s+([A-Z][a-z'’-]{1,20}))?", re.I),
    re.compile(r"([A-Z][a-z'’-]{1,20})(?:\s+([A-Z][a-z'’-]{1,20}))?\s*[,–-]\s*(?:owner|founder|director|proprietor|managing director|head coach|head instructor|chief instructor)\b", re.I),
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
    """(first, last) for every person the recogniser finds in the text (acronyms like "BJJ" are never people)."""
    out = []
    for ent in nlp(text[:MAX_TEXT]).ents:
        if ent.label_ != "PERSON":
            continue
        parts = [_clean(p) for p in ent.text.split() if _clean(p) and not (_clean(p).isupper() and len(_clean(p)) > 1)]
        while parts and parts[0].lower() in NOT_NAMES:
            parts = parts[1:]
        if parts and parts[0][0].isupper() and parts[0].lower() not in NOT_NAMES and len(parts) <= 3:
            out.append((parts[0], parts[-1] if len(parts) > 1 else None))
    return out


def _always(first: str, last: str | None) -> bool:
    return True


Check = type(_always)


def plausible(business_name: str, towns: list[str]) -> Check:
    """Rejects names that are really the business, the town or a famous person: "Diamond Kickboxing",
    "Gracie Barra", "The Forge", "BJJ Warrington", "Bruce Lee"."""
    biz = {w.lower() for w in re.findall(r"[A-Za-z]+", business_name)}
    places = {w.lower() for t in towns for w in re.findall(r"[A-Za-z]+", t or "")}

    def ok(first: str, last: str | None) -> bool:
        f, l = _clean(first).lower(), _clean(last or "").lower()
        if not f or f in places or (l and l in places) or f"{f} {l}" in FAMOUS:
            return False
        # a word from the business's own name is only a person if it's a known first name ("Dave" of Dave's Roofing),
        # never "Diamond" of Diamond Kickboxing or "Gracie" of Gracie Barra
        return not (f in biz and not is_first_name(f))

    return ok


def from_website(texts: list[str], htmls: list[str] = (), ok: Check = _always) -> tuple[str, str, bool] | None:
    """(first, full, confident). Confident = their own words or schema; a recogniser guess is not."""
    for html in htmls:  # schema.org: {"founder": {"name": "Dave Smith"}}
        for block in re.findall(r"<script[^>]+ld\+json[^>]*>(.*?)</script>", html, re.S | re.I):
            for name in re.findall(r'"(?:founder|employee|author)"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]{3,40})"', block):
                parts = name.split()
                last = parts[1] if len(parts) > 1 else None
                if parts and looks_like_name(parts[0]) and ok(parts[0], last):
                    return (*_person(parts[0], last), True)
    for text in texts:  # explicit self-introductions / owner labels
        for pattern in _PATTERNS:
            for m in pattern.finditer(text):
                word, last = m.group(1), m.group(2)
                # a capitalised word the recogniser reads as a name, or a known first name in any case ("i'm dave")
                named = (word[0].isupper() and (looks_like_name(word) or (last and looks_like_full_name(word, last)))) or is_first_name(word)
                if named and ok(word, last):
                    return (*_person(word, last), True)
    nlp = _nlp()
    if not nlp:
        return None
    # a person named in a sentence about who runs the place (a guess: could be a quoted hero or a member)
    for text in texts:
        for sent in nlp(text[:MAX_TEXT]).sents:
            if OWNER_CUES.search(sent.text):
                found = [p for p in _people(sent.text, nlp) if ok(*p)]
                if found:
                    return (*_person(*found[0]), False)
    # the one person the site keeps naming (e.g. an about page all about "Dave")
    counts = Counter(first for text in texts for first, last in _people(text, nlp) if ok(first, last))
    if counts:
        (name, n), *rest = counts.most_common(2)
        if n >= 3 and (not rest or rest[0][1] < n / 2):
            return (*_person(name), False)
    return None


def from_reviews(reviews: list[dict], ok: Check = _always) -> tuple[str, str] | None:
    """A first name that 2+ different reviewers mention (not their own name)."""
    nlp = _nlp()
    counts: Counter[str] = Counter()
    for r in reviews:
        author = {w.lower() for w in str(r.get("author", "")).split()}
        text = str(r.get("text", ""))
        if nlp:
            names = {first for first, last in _people(text, nlp) if ok(first, last)}
        else:
            names = {w for w in re.findall(r"\b([A-Z][a-z]{1,14})\b", text) if is_first_name(w) and ok(w, None)}
        counts.update({n for n in names if n.lower() not in author})
    if counts:
        name, n = counts.most_common(1)[0]
        if n >= 2:
            return _person(name)
    return None


def from_email(emails: list[str], site_host: str, known: set[str] = frozenset(), ok: Check = _always) -> tuple[str, str] | None:
    for e in emails:
        local, _, domain = e.lower().partition("@")
        if site_host and not (domain == site_host or domain.endswith("." + site_host)):
            continue
        parts = re.split(r"[._-]", local)
        last = parts[1].title() if len(parts) > 1 and len(parts[1]) > 2 else None
        if parts and len(parts[0]) > 1 and (parts[0] in known or looks_like_name(parts[0], strict=True)) and ok(parts[0], last):
            return _person(parts[0], last)
    return None


def from_business_name(name: str) -> tuple[str, str] | None:
    """Only with a known first name: "Dave's Plumbing", "Steve Brown Roofing". Never "Diamond Kickboxing"."""
    m = re.match(r"^\s*([A-Z][a-z]+)(?:['’]s\b|\s+([A-Z][a-z]+)\s+(?:&|and\s+)?\w)", name)
    if m and is_first_name(m.group(1)) and not (m.group(2) and m.group(2).lower() in NOT_NAMES):
        return _person(m.group(1), m.group(2))
    return None


def visible_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    return " ".join(soup.get_text(" ").split())


def find_owner(htmls: list[str], emails: list[str], site_host: str, business_name: str, reviews: list[dict],
               towns: list[str] = ()) -> dict:
    """Returns {"first", "full", "source", "confident"}; empty strings if nobody was found.
    confident = their own words or their own email; anything else is a guess for Claude to check."""
    texts = [visible_text(h) for h in htmls]
    ok = plausible(business_name, list(towns))
    site = from_website(texts, htmls, ok)
    if site and site[2]:
        return {"first": site[0], "full": site[1], "source": "website", "confident": True}
    hit = from_email(emails, site_host, ok=ok)
    if hit:
        return {"first": hit[0], "full": hit[1], "source": "email", "confident": True}
    if site:
        return {"first": site[0], "full": site[1], "source": "website", "confident": False}
    for source, found in (("reviews", lambda: from_reviews(reviews, ok)), ("business name", lambda: from_business_name(business_name))):
        hit = found()
        if hit:
            return {"first": hit[0], "full": hit[1], "source": source, "confident": False}
    return {"first": "", "full": "", "source": "", "confident": False}
