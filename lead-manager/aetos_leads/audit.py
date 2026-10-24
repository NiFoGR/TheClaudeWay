"""Website audit: what's wrong with a lead's online presence, in plain English.

Every issue string here can be quoted (politely) in outreach, so keep them factual.
"""

import re
import time
import unicodedata
from datetime import date
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from aetos_leads import contacts
from aetos_leads.models import Lead

# look like a normal browser: many small-business sites block anything that announces itself as a bot
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}
# only these errors mean "the site is broken". Every other 4xx/5xx (firewalls answer 401/403/406/429/503; 409, 415,
# 451…), a 202, a bot-check page and an answer with no page in it (204, a redirect with nowhere to go, a blank body)
# mean "something stopped our checker": "not checked", never pitched on.
BROKEN_STATUSES = {404, 410, 500, 502, 504, 520, 521, 522, 523, 524, 525, 526, 530}
CHALLENGE_RE = re.compile(r"/\.well-known/sgcaptcha|<title>\s*(Just a moment|Attention Required|Access denied|"
                          r"Checking your browser|One moment, please)", re.I)
NOT_CHECKED = "Couldn't check the website automatically (it blocks checkers). Look at it yourself"
NOT_READABLE = "Couldn't check the website automatically (it only loads in a browser). Look at it yourself"
APP_ROOT_ID = re.compile(r"^(root|app|__next|__nuxt)$", re.I)
SHELL_TEXT_CHARS = 200  # a page showing fewer characters than this has nothing of its own to judge
# checked on every page read (the contact page usually has them), not just the homepage; their facts, same order
SITE_WIDE = ("no_form", "no_map", "phone_not_on_site", "address_not_on_site")
SITE_WIDE_FACTS = ("contact_form", "google_map", "phone_on_site", "address_on_site")
TEL_HREF = re.compile(r"^\s*tel:", re.I)  # browsers trim spaces round a link, so " tel:…" still dials
# a form a visitor sees that isn't a <form> in the page's HTML: a form builder's iframe or script (Jotform, Google Forms,
# Microsoft Forms, Typeform, HubSpot, Cognito, Wufoo, Zoho, Formstack, Paperform, 123FormBuilder, Tally, Fillout) or
# Ninja Forms' placeholder (its form is drawn from a script template). Errs toward not claiming "no form"
FORM_EMBED = re.compile(
    r"docs\.google\.com/forms|forms\.gle/|forms\.office\.com|jotform\.com|jotfor\.ms|typeform\.com|"
    r"data-tf-(?:widget|live|popup|slider|sidetab)|hsforms\.(?:net|com)|hbspt\.forms|cognitoforms\.com|wufoo\.com|"
    r"zohopublic\.|zfrmz\.|formstack\.com|paperform\.co|123formbuilder\.com|tally\.so/|fillout\.com|nf-form-cont",
    re.I,
)
# a Google map: an embed's address (google.com/maps/embed…, maps.google.co.uk/maps?…&output=embed), or Google's Maps
# JavaScript drawing one
GOOGLE_MAP_URL = re.compile(r"google\.(?:com|co\.uk)/maps|maps\.google(?:apis)?\.", re.I)
GOOGLE_MAPS_JS = re.compile(r"maps\.googleapis\.com/maps/api/js", re.I)
SLOW_SECONDS = 3.0
OUTDATED_YEARS = 4  # copyright this many years old or more = looks abandoned (2023 in 2026 isn't enough)

SOCIAL_HOSTS = {
    "facebook.com": "facebook",
    "instagram.com": "instagram",
    "linkedin.com": "linkedin",
    "tiktok.com": "tiktok",
    "x.com": "x",
    "twitter.com": "x",
    "youtube.com": "youtube",
}
# a "website" that's really a profile or directory listing counts as no website
NOT_A_WEBSITE = set(SOCIAL_HOSTS) | {
    "checkatrade.com", "yell.com", "mybuilder.com", "ratedpeople.com", "trustatrader.com",
    "bark.com", "linktr.ee", "business.site", "google.com", "g.page",
}
DIY_BUILDERS = {
    "wix": "Wix", "weebly": "Weebly", "godaddy": "GoDaddy builder", "jimdo": "Jimdo",
    "site123": "SITE123", "webnode": "Webnode", "yola": "Yola", "mozello": "Mozello",
}
CHAT_WIDGETS = [
    "tidio", "intercom", "drift.com", "crisp.chat", "livechatinc", "tawk.to", "zendesk", "hs-scripts",
    "olark", "freshchat", "chatra", "smartsupp", "jivosite", "chatbot", "elfsight", "getbutton",
    "wa.me", "whatsapp", "messenger", "botpress", "voiceflow", "manychat",
]
COPYRIGHT_RE = re.compile(r"(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})", re.I)


def host_of(url: str) -> str:
    host = urlparse(url if "//" in url else f"//{url}").hostname or ""
    return host.lower().removeprefix("www.")


def is_real_website(url: str) -> bool:
    host = host_of(url)
    return bool(host) and not any(host == h or host.endswith("." + h) for h in NOT_A_WEBSITE)


def extract_emails(html: str, site_host: str = "") -> list[str]:
    """Every real email in a page (hidden ones too), own-domain and generic inboxes first."""
    return contacts.rank_emails(contacts.emails_in(html, site_host), site_host)


def extract_socials(soup: BeautifulSoup) -> dict[str, str]:
    socials: dict[str, str] = {}
    for a in soup.find_all("a", href=True):
        host = host_of(a["href"])
        for social_host, label in SOCIAL_HOSTS.items():
            if (host == social_host or host.endswith("." + social_host)) and label not in socials:
                socials[label] = a["href"]
    return socials


# words that count as "the trade" in a title or heading, beyond the trade's own word stems
TRADE_SYNONYMS = {
    "heating engineer": ["heating", "boiler", "gas"],
    "hvac": ["heating", "boiler", "air con"],
    "mechanic": ["garage", "car repair", "mot", "servic"],
    "car dealer": ["cars", "car sales", "used car", "motors"],
    "removals": ["removal", "moving", "movers"],
    "cleaner": ["clean"],
    "landscaper": ["landscap", "garden", "lawn", "patio", "paving", "driveway", "fenc", "deck", "turf",
                   "artificial grass", "tree", "hedge", "groundwork", "outdoor"],
    "painter and decorator": ["paint", "decorat"],
    "builder": ["build", "extension", "construction"],
    "driving school": ["driving", "lesson", "instructor"],
    "martial arts gym": ["martial", "karate", "bjj", "jiu", "kickbox", "mma", "taekwondo", "judo", "boxing"],
}
STOPWORDS = {"and", "the", "of", "for", "in", "services", "service"}
# schema.org types that mean "local business info for Google"
SCHEMA_TYPES = re.compile(
    r"LocalBusiness|HomeAndConstructionBusiness|RoofingContractor|Plumber|Electrician|HVACBusiness|"
    r"GeneralContractor|HousePainter|Locksmith|MovingCompany|AutoRepair|AutoDealer|AutomotiveBusiness|"
    r"ProfessionalService|ExerciseGym|SportsActivityLocation|DrivingSchool|EmergencyService",
    re.I,
)
OLD_BUILD = re.compile(r"<font[\s>]|<center>|<marquee|\.swf[\"']|<frameset|jquery[-.]1\.\d", re.I)


def trade_terms(trade: str) -> list[str]:
    words = [w for w in re.findall(r"[a-z]+", trade.lower()) if w not in STOPWORDS]
    stems = [w[:4] if len(w) > 4 else w for w in words]
    key = " ".join(trade.lower().split())  # "Landscapers" gets the same synonyms as "landscaper"
    return stems + TRADE_SYNONYMS.get(key, TRADE_SYNONYMS.get(key.removesuffix("s"), []))


def mentions(text: str, terms: list[str]) -> bool:
    text = text.lower()
    spaced = re.sub(r"[\W_]+", " ", text)  # "Artificial-Grass", "Air-Con" count as "artificial grass", "air con"
    return any(t in text or t in spaced for t in terms)


def town_key(name: str) -> str:
    """A town written any common way, as one comparable string: 'St. Helens', 'Saint Helens' and 'st helens' are all
    'st helens'; 'Newton-le-Willows' is 'newton le willows'; "King's Lynn" is 'kings lynn'; 'Ynys Môn' is 'ynys mon';
    'Brighton & Hove' is 'brighton and hove'."""
    name = unicodedata.normalize("NFKD", (name or "").lower())
    name = "".join(c for c in name if not unicodedata.combining(c))  # Môn = Mon
    name = re.sub(r"['‘’`]", "", name).replace("&", " and ")  # King's = Kings; & = and
    name = re.sub(r"[\W_]+", " ", name).strip()  # dots, commas, hyphens, '|'… are spaces; spaces collapsed
    return re.sub(r"\bsaint\b", "st", name)


def phone_pattern(phone: str) -> re.Pattern | None:
    """UK number from Google ('01925 417597') → regex matching it on a page in any common format."""
    digits = re.sub(r"\D", "", phone)
    if len(digits) < 10:
        return None
    national = digits[1:] if digits.startswith("0") else digits.removeprefix("44")
    sep = r"[\s().-]*"
    return re.compile(r"(?:\+?44" + sep + r"(?:\(0\))?|0)" + sep + sep.join(national))


def _visible_text(soup: BeautifulSoup) -> str:
    """The page's words once script, style and noscript are removed (removes them from the soup)."""
    for tag in soup.find_all(["script", "style", "noscript"]):
        tag.decompose()
    return soup.get_text(" ", strip=True)


def browser_only(html: str) -> bool:
    """A page that only shows anything once a browser runs its scripts (an empty app shell): auditing its HTML would
    report a missing heading, form, phone… that the visitor actually sees."""
    soup = BeautifulSoup(html, "html.parser")
    has_script = bool(soup.find("script", src=True))
    has_noscript = bool(soup.find("noscript"))
    if len(_visible_text(soup)) >= SHELL_TEXT_CHARS or not has_script:
        return False
    empty_root = any(not el.get_text(strip=True) for el in soup.find_all(id=APP_ROOT_ID))
    return has_noscript or empty_root


def redirect_stub(html: str) -> bool:
    """A page that only sends the browser on (<meta http-equiv="refresh" content="0;url=…">) with next to nothing on
    it: the checker doesn't follow it, so auditing the stub would make claims about a page no visitor sees."""
    soup = BeautifulSoup(html, "html.parser")
    refresh = soup.find("meta", attrs={"http-equiv": re.compile(r"^\s*refresh\s*$", re.I)})
    if not refresh or not re.search(r"url\s*=", refresh.get("content") or "", re.I):
        return False
    return len(_visible_text(soup)) < SHELL_TEXT_CHARS


def _is_map_iframe(iframe) -> bool:
    """A Google map embed, also when a lazy-load or cookie plugin moved its address out of src
    (data-lazy-src, data-litespeed-src, data-src, data-src-cmplz, data-cookieblock-src...)."""
    return any(isinstance(v, str) and GOOGLE_MAP_URL.search(v) for v in iframe.attrs.values())


def analyse_html(html: str, final_url: str, town: str, load_seconds: float, today: date | None = None,
                 trade: str = "", phone: str = "", postcode: str = "",
                 extra_pages: list[str] = ()) -> tuple[list[tuple[str, str]], dict]:
    """Return (findings, facts) for a fetched homepage. A finding is (key, plain-English line).

    extra_pages are the site's other pages already read (contact page first, from contacts.find): the form, Google
    map, phone and address usually live on the Contact page, so those four pass if any page has them. Everything
    else (title, heading, schema, mobile layout, description, tap-to-call…) is about the homepage only."""
    today = today or date.today()
    soup = BeautifulSoup(html, "html.parser")
    lower = html.lower()
    text = soup.get_text(" ", strip=True)
    found: list[tuple[str, str]] = []
    facts: dict = {"final_url": final_url, "load_seconds": round(load_seconds, 2)}
    terms = trade_terms(trade) if trade else []

    # ---- Website
    if not soup.find("meta", attrs={"name": re.compile("^viewport$", re.I)}):
        found.append(("not_mobile", "Not mobile-friendly (no mobile layout)"))
    if not final_url.startswith("https://"):
        found.append(("not_secure", 'Site shows as "Not secure" (no HTTPS)'))
    years = [int(y) for y in COPYRIGHT_RE.findall(html) if 1995 <= int(y) <= today.year]
    if years:
        facts["copyright_year"] = max(years)
        if today.year - max(years) >= OUTDATED_YEARS:
            found.append(("outdated", f"Looks outdated (copyright {max(years)})"))
    if OLD_BUILD.search(html):
        found.append(("old_build", "Built with old website technology"))
    if load_seconds > 2 * SLOW_SECONDS:
        found.append(("very_slow", f"Very slow to load ({load_seconds:.1f}s)"))
    elif load_seconds > SLOW_SECONDS:
        found.append(("slow", f"Slow to load ({load_seconds:.1f}s)"))
    site = [soup, *(BeautifulSoup(page, "html.parser") for page in extra_pages)]  # homepage first
    site_texts = [text, *(s.get_text(" ", strip=True) for s in site[1:])]
    has_form = any(f.find(["textarea", "input"]) for s in site for f in s.find_all("form")) \
        or any(FORM_EMBED.search(p) for p in (html, *extra_pages))
    facts["contact_form"] = has_form
    if not has_form:
        found.append(("no_form", "No contact or quote form"))
    if not soup.find("a", href=TEL_HREF):
        # iPhones turn a typed number into a link themselves, so the claim is only about the link in the page
        found.append(("no_tap_to_call", "No tap-to-call phone link on the home page"))
    builder = next((name for key, name in DIY_BUILDERS.items() if key in lower), None)
    if builder:
        facts["builder"] = builder
        found.append(("diy_builder", f"Built on a DIY builder ({builder})"))
    chat = next((w for w in CHAT_WIDGETS if w in lower), None)
    facts["chat_widget"] = chat
    if not chat:
        found.append(("no_chat", "No chat or instant enquiry option"))

    # ---- Local SEO (playbook: title + H1 = category + city, schema, NAP matching Google, embedded map)
    title = soup.title.get_text(strip=True) if soup.title else ""
    facts["title"] = title
    if not title:
        found.append(("no_title", "No page title for Google to show"))
    else:
        if terms and not mentions(title, terms):
            found.append(("title_no_trade", f"Page title doesn't say what they do ({trade})"))
        if town and town_key(town) not in town_key(title):
            found.append(("title_no_town", f"Town ({town}) not in the page title, so it's harder to find locally"))
    h1 = soup.find("h1")
    h1_text = h1.get_text(" ", strip=True) if h1 else ""
    facts["h1"] = h1_text[:200]
    if not h1:
        found.append(("no_h1", "No main heading"))
    elif (terms and not mentions(h1_text, terms)) or (town and town_key(town) not in town_key(h1_text)):
        found.append(("h1_weak", "Main heading doesn't say what they do and where"))
    ld = " ".join(s.get_text() for s in soup.find_all("script", type=re.compile("ld\\+json", re.I)))
    has_schema = bool(SCHEMA_TYPES.search(ld)) or "schema.org/localbusiness" in lower
    facts["schema"] = has_schema
    if not has_schema:
        found.append(("no_schema", "No business details for Google in the site's code (schema)"))
    pattern = phone_pattern(phone) if phone else None
    if pattern:
        tel_links = " ".join(a["href"] for s in site for a in s.find_all("a", href=TEL_HREF))
        on_site = any(pattern.search(t) for t in site_texts) or bool(pattern.search(tel_links))
        facts["phone_on_site"] = on_site
        if not on_site:
            found.append(("phone_not_on_site", "The phone number on Google isn't on the website"))
    if postcode:
        squash = lambda v: re.sub(r"\s", "", v).upper()  # noqa: E731
        on_site = any(squash(postcode) in squash(t) for t in site_texts)
        facts["address_on_site"] = on_site
        if not on_site:
            found.append(("address_not_on_site", "Address isn't on the website (Google checks it matches)"))
    has_map = any(_is_map_iframe(f) for s in site for f in s.find_all("iframe")) \
        or any(GOOGLE_MAPS_JS.search(str(t)) for s in site for t in s.find_all("script", src=True))
    facts["google_map"] = has_map
    if not has_map:
        found.append(("no_map", "No Google map on the website"))
    if not soup.find("meta", attrs={"name": re.compile("^description$", re.I)}):
        found.append(("no_description", "No Google description"))
    return found, facts


async def count_pages(client: httpx.AsyncClient, site_url: str) -> int | None:
    """Pages listed in the site's sitemap (the playbook wants 30+). None = no sitemap found."""
    base = f"{urlparse(site_url).scheme}://{urlparse(site_url).netloc}"
    loc = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.I)
    for path in ("/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"):
        try:
            resp = await client.get(base + path, timeout=10)
        except httpx.HTTPError:
            continue
        if resp.status_code != 200 or "<loc>" not in resp.text.lower():
            continue
        urls = loc.findall(resp.text)
        if "<sitemapindex" not in resp.text.lower():
            return len(urls)
        total = 0
        for child in urls[:10]:  # an index lists sub-sitemaps; count the pages inside them
            try:
                total += len(loc.findall((await client.get(child, timeout=10)).text))
            except httpx.HTTPError:
                continue
        return total
    return None


def _set(lead: Lead, findings: list[tuple[str, str]], audit: dict) -> None:
    lead.findings = [k for k, _ in findings]
    lead.issues = [t for _, t in findings]
    lead.audit = audit


async def audit_lead(client: httpx.AsyncClient, lead: Lead) -> None:
    """Fill lead.findings / issues / audit / emails / socials in place. Never raises."""
    if not lead.website:
        return _set(lead, [("no_website", "No website")], {"status": "none"})
    if not is_real_website(lead.website):
        return _set(lead, [("profile_only", f"No proper website, only a {host_of(lead.website)} page")],
                    {"status": "profile_only", "url": lead.website})

    resp, elapsed, error = None, 0.0, None
    for attempt in range(2):  # one retry: small sites are often just slow to wake up
        start = time.monotonic()
        try:
            resp = await client.get(lead.website, timeout=15 if attempt == 0 else 30)
            elapsed = time.monotonic() - start
            break
        except httpx.HTTPError as e:
            error = e
    if resp is None:
        if "CERTIFICATE" in str(error).upper():
            return _set(lead, [("bad_certificate", "Browsers show a security warning on their website (broken certificate)")],
                        {"status": "bad_certificate"})
        return _set(lead, [("site_down", "Website is down or won't load")],
                    {"status": "unreachable", "error": type(error).__name__})
    code = resp.status_code
    no_page = not 200 <= code < 300 or not resp.text.strip()
    if code == 202 or CHALLENGE_RE.search(resp.text) or (no_page and code not in BROKEN_STATUSES):
        return _set(lead, [("not_checked", NOT_CHECKED)], {"status": "blocked", "http_status": code})
    if code in BROKEN_STATUSES:
        return _set(lead, [("site_broken", f"Website is broken (error {code})")],
                    {"status": "broken", "http_status": code})
    final_url = str(resp.url)
    if browser_only(resp.text) or redirect_stub(resp.text):
        return _set(lead, [("not_checked", NOT_READABLE)],
                    {"status": "browser_only", "http_status": code, "final_url": final_url})

    # read the contact page (and the other pages worth reading) first: form, map, phone and address count there too
    found = await contacts.find(client, resp.text, final_url)
    findings, facts = analyse_html(resp.text, final_url, lead.town or lead.search_town, elapsed,
                                   trade=lead.trade, phone=lead.phone, postcode=lead.postcode,
                                   extra_pages=found["htmls"][1:])
    if found["contact_unread"]:  # their contact page wouldn't load for us: what's on it is unknown, so claim none of it
        findings = [f for f in findings if f[0] not in SITE_WIDE]
        facts.update({k: None for k in SITE_WIDE_FACTS if facts.get(k) is False}, contact_unread=True)
    pages = await count_pages(client, final_url)
    facts["pages"] = pages
    if pages is not None and pages < 10:
        findings.append(("few_pages", f"Only {pages} pages on the site (top-ranking sites usually have 30+)"))
    elif pages is not None and pages < 30:
        findings.append(("some_pages", f"Only {pages} pages on the site (top-ranking sites usually have 30+)"))
    _set(lead, findings, {"status": "ok", **facts})
    lead.socials = found["socials"]
    lead.emails = found["emails"]
    lead.email = lead.emails[0] if lead.emails else ""
    lead.audit.update(email_source=found["source"], pages_checked=found["pages_checked"], final_url=final_url)
    lead.pages_html = found["htmls"]


def make_client(timeout: float = 15.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=timeout, follow_redirects=True, headers=HEADERS, verify=True
    )
