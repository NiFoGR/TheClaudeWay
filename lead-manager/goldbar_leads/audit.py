"""Website audit: what's wrong with a lead's online presence, in plain English.

Every issue string here can be quoted (politely) in outreach, so keep them factual.
"""

import re
import time
from datetime import date
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from goldbar_leads.models import Lead

# look like a normal browser: many small-business sites block anything that announces itself as a bot
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}
# these mean "a firewall stopped our checker", not "the site is broken": never pitch on them
BLOCKED_STATUSES = {401, 403, 406, 429, 503}
NOT_CHECKED = "Couldn't check the website automatically (it blocks checkers). Look at it yourself"
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
CONTACT_HINTS = ("contact", "get-in-touch", "about", "quote")

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
JUNK_EMAIL = re.compile(
    r"(example|sentry|wixpress|domain\.com|email\.com|yourdomain|mysite|yoursite|sitename|website\.com|"
    r"company\.com|\.(png|jpe?g|gif|svg|webp)$|@2x|godaddy|squarespace|wordpress|noreply|no-reply|"
    r"^(test|name|email|user|your|yourname|someone)@)",
    re.I,
)
COPYRIGHT_RE = re.compile(r"(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})", re.I)


def host_of(url: str) -> str:
    host = urlparse(url if "//" in url else f"//{url}").hostname or ""
    return host.lower().removeprefix("www.")


def is_real_website(url: str) -> bool:
    host = host_of(url)
    return bool(host) and not any(host == h or host.endswith("." + h) for h in NOT_A_WEBSITE)


def extract_emails(html: str, site_host: str = "") -> list[str]:
    found = []
    for m in EMAIL_RE.findall(html):
        e = m.lower().strip(".")
        if JUNK_EMAIL.search(e) or e in found:
            continue
        found.append(e)
    # same-domain addresses first, then generic inboxes like info@ / contact@
    def rank(e: str) -> tuple[int, int]:
        return (0 if site_host and e.endswith("@" + site_host) else 1, 0 if e.split("@")[0] in ("info", "contact", "hello", "enquiries", "office") else 1)

    return sorted(found, key=rank)


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
    "landscaper": ["landscap", "garden"],
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
    return stems + TRADE_SYNONYMS.get(trade.lower().strip(), [])


def mentions(text: str, terms: list[str]) -> bool:
    text = text.lower()
    return any(t in text for t in terms)


def phone_pattern(phone: str) -> re.Pattern | None:
    """UK number from Google ('01925 417597') → regex matching it on a page in any common format."""
    digits = re.sub(r"\D", "", phone)
    if len(digits) < 10:
        return None
    national = digits[1:] if digits.startswith("0") else digits.removeprefix("44")
    sep = r"[\s().-]*"
    return re.compile(r"(?:\+?44" + sep + r"(?:\(0\))?|0)" + sep + sep.join(national))


def analyse_html(html: str, final_url: str, town: str, load_seconds: float, today: date | None = None,
                 trade: str = "", phone: str = "", postcode: str = "") -> tuple[list[tuple[str, str]], dict]:
    """Return (findings, facts) for a fetched homepage. A finding is (key, plain-English line)."""
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
    has_form = any(f.find(["textarea", "input"]) for f in soup.find_all("form"))
    facts["contact_form"] = has_form
    if not has_form:
        found.append(("no_form", "No contact or quote form"))
    if not soup.find("a", href=re.compile(r"^tel:", re.I)):
        found.append(("no_tap_to_call", "Phone number isn't tap-to-call on mobile"))
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
        if town and town.lower() not in title.lower():
            found.append(("title_no_town", f"Town ({town}) not in the page title, so it's harder to find locally"))
    h1 = soup.find("h1")
    h1_text = h1.get_text(" ", strip=True) if h1 else ""
    facts["h1"] = h1_text[:200]
    if not h1:
        found.append(("no_h1", "No main heading"))
    elif (terms and not mentions(h1_text, terms)) or (town and town.lower() not in h1_text.lower()):
        found.append(("h1_weak", "Main heading doesn't say what they do and where"))
    ld = " ".join(s.get_text() for s in soup.find_all("script", type=re.compile("ld\\+json", re.I)))
    has_schema = bool(SCHEMA_TYPES.search(ld)) or "schema.org/localbusiness" in lower
    facts["schema"] = has_schema
    if not has_schema:
        found.append(("no_schema", "No business details for Google in the site's code (schema)"))
    pattern = phone_pattern(phone) if phone else None
    if pattern:
        tel_links = " ".join(a["href"] for a in soup.find_all("a", href=re.compile(r"^tel:", re.I)))
        on_site = bool(pattern.search(text) or pattern.search(tel_links))
        facts["phone_on_site"] = on_site
        if not on_site:
            found.append(("phone_not_on_site", "The phone number on Google isn't on the website"))
    if postcode:
        squash = lambda v: re.sub(r"\s", "", v).upper()  # noqa: E731
        on_site = squash(postcode) in squash(text)
        facts["address_on_site"] = on_site
        if not on_site:
            found.append(("address_not_on_site", "Address isn't on the website (Google checks it matches)"))
    has_map = any("google.com/maps" in (f.get("src") or "") or "maps.google" in (f.get("src") or "")
                  for f in soup.find_all("iframe"))
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


def _contact_links(soup: BeautifulSoup, base_url: str) -> list[str]:
    base_host = host_of(base_url)
    links = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"])
        if host_of(href) == base_host and any(h in href.lower() for h in CONTACT_HINTS) and href not in links:
            links.append(href)
    return links[:3]


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
    if resp.status_code in BLOCKED_STATUSES:
        return _set(lead, [("not_checked", NOT_CHECKED)], {"status": "blocked", "http_status": resp.status_code})
    if resp.status_code >= 400:
        return _set(lead, [("site_broken", f"Website is broken (error {resp.status_code})")],
                    {"status": "broken", "http_status": resp.status_code})

    final_url = str(resp.url)
    findings, facts = analyse_html(resp.text, final_url, lead.town or lead.search_town, elapsed,
                                   trade=lead.trade, phone=lead.phone, postcode=lead.postcode)
    pages = await count_pages(client, final_url)
    facts["pages"] = pages
    if pages is not None and pages < 10:
        findings.append(("few_pages", f"Only {pages} pages on the site (top-ranking sites usually have 30+)"))
    elif pages is not None and pages < 30:
        findings.append(("some_pages", f"Only {pages} pages on the site (top-ranking sites usually have 30+)"))
    _set(lead, findings, {"status": "ok", **facts})

    soup = BeautifulSoup(resp.text, "html.parser")
    lead.socials = extract_socials(soup)
    site_host = host_of(final_url)
    emails = extract_emails(resp.text, site_host)
    for link in _contact_links(soup, final_url):
        if emails and emails[0].endswith("@" + site_host):
            break
        try:
            page = await client.get(link)
            emails += [e for e in extract_emails(page.text, site_host) if e not in emails]
        except httpx.HTTPError:
            continue
    lead.emails = extract_emails(" ".join(emails), site_host)
    lead.email = lead.emails[0] if lead.emails else ""


def make_client(timeout: float = 15.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=timeout, follow_redirects=True, headers=HEADERS, verify=True
    )
