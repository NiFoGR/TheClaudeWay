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


def analyse_html(html: str, final_url: str, town: str, load_seconds: float, today: date | None = None) -> tuple[list[str], dict]:
    """Return (issues, facts) for a fetched homepage."""
    today = today or date.today()
    soup = BeautifulSoup(html, "html.parser")
    lower = html.lower()
    issues: list[str] = []
    facts: dict = {"final_url": final_url, "load_seconds": round(load_seconds, 2)}

    if not final_url.startswith("https://"):
        issues.append('Site shows as "Not secure" (no HTTPS)')
    if not soup.find("meta", attrs={"name": re.compile("^viewport$", re.I)}):
        issues.append("Not mobile-friendly (no mobile layout)")
    if load_seconds > SLOW_SECONDS:
        issues.append(f"Slow to load ({load_seconds:.1f}s)")

    years = [int(y) for y in COPYRIGHT_RE.findall(html) if 1995 <= int(y) <= today.year]
    if years:
        facts["copyright_year"] = max(years)
        if today.year - max(years) >= OUTDATED_YEARS:
            issues.append(f"Looks outdated (copyright {max(years)})")

    title = (soup.title.string or "").strip() if soup.title and soup.title.string else ""
    facts["title"] = title
    if not title:
        issues.append("No page title for Google to show")
    elif town and town.lower() not in title.lower():
        issues.append(f"Town ({town}) not in the page title, so it's harder to find locally")
    if not soup.find("meta", attrs={"name": re.compile("^description$", re.I)}):
        issues.append("No Google description")
    if not soup.find("h1"):
        issues.append("No main heading")

    has_form = any(f.find(["textarea", "input"]) for f in soup.find_all("form"))
    facts["contact_form"] = has_form
    if not has_form:
        issues.append("No contact or quote form")
    if not soup.find("a", href=re.compile(r"^tel:", re.I)):
        issues.append("Phone number isn't tap-to-call on mobile")
    chat = next((w for w in CHAT_WIDGETS if w in lower), None)
    facts["chat_widget"] = chat
    if not chat:
        issues.append("No chat or instant enquiry option")

    builder = next((name for key, name in DIY_BUILDERS.items() if key in lower), None)
    if builder:
        facts["builder"] = builder
        issues.append(f"Built on a DIY builder ({builder})")
    return issues, facts


def _contact_links(soup: BeautifulSoup, base_url: str) -> list[str]:
    base_host = host_of(base_url)
    links = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"])
        if host_of(href) == base_host and any(h in href.lower() for h in CONTACT_HINTS) and href not in links:
            links.append(href)
    return links[:3]


async def audit_lead(client: httpx.AsyncClient, lead: Lead) -> None:
    """Fill lead.issues / audit / emails / socials in place. Never raises."""
    if not lead.website:
        lead.issues = ["No website"]
        lead.audit = {"status": "none"}
        return
    if not is_real_website(lead.website):
        lead.issues = [f"No proper website, only a {host_of(lead.website)} page"]
        lead.audit = {"status": "profile_only", "url": lead.website}
        return

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
            lead.issues = ["Browsers show a security warning on their website (broken certificate)"]
            lead.audit = {"status": "bad_certificate"}
        else:
            lead.issues = ["Website is down or won't load"]
            lead.audit = {"status": "unreachable", "error": type(error).__name__}
        return
    if resp.status_code in BLOCKED_STATUSES:
        lead.issues = [NOT_CHECKED]
        lead.audit = {"status": "blocked", "http_status": resp.status_code}
        return
    if resp.status_code >= 400:
        lead.issues = [f"Website is broken (error {resp.status_code})"]
        lead.audit = {"status": "broken", "http_status": resp.status_code}
        return

    final_url = str(resp.url)
    issues, facts = analyse_html(resp.text, final_url, lead.town or lead.search_town, elapsed)
    lead.issues, lead.audit = issues, {"status": "ok", **facts}

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
