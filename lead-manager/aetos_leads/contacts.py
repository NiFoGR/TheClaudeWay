"""Find a business's email the way Hunter-style tools do, as efficiently as possible.

1. Read every page we fetch for emails, including the ways sites hide them from bots: mailto links,
   "info [at] site [dot] co.uk" text, Cloudflare email protection, and emails inside the page's schema.
2. Visit the pages most likely to list contact details (contact, about, team, privacy, terms…), best first,
   and stop the moment we have an address on the business's own domain.
3. Nothing on the site? Check the domain actually receives email (its MX record, free via DNS-over-HTTPS)
   and suggest info@, clearly marked "guessed".

Facebook and Instagram are deliberately not scraped: contact details there sit behind a login and automated
scraping breaks their terms. Their links are collected from every page so the owner can check them in one click.
"""

import re
from html import unescape
from urllib.parse import unquote, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# "info [at] smithroofing [dot] co [dot] uk", "info(at)smithroofing.co.uk", "info AT smithroofing DOT co DOT uk"
OBFUSCATED_RE = re.compile(
    r"([A-Za-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\{at\}|\sat\s)\s*([A-Za-z0-9-]+(?:\s*(?:\[dot\]|\(dot\)|\{dot\}|\sdot\s|\.)\s*[A-Za-z0-9-]+)+)",
    re.I,
)
DOT_RE = re.compile(r"\s*(?:\[dot\]|\(dot\)|\{dot\}|\sdot\s|\.)\s*", re.I)
JUNK_EMAIL = re.compile(
    r"(example|sentry|wixpress|domain\.com|email\.com|yourdomain|mysite|yoursite|sitename|website\.com|"
    r"company\.com|\.(png|jpe?g|gif|svg|webp|css|js)$|@2x|godaddy|squarespace|wordpress|noreply|no-reply|"
    r"^(test|name|email|user|your|yourname|someone)@)",
    re.I,
)
GENERIC_INBOXES = ("info", "contact", "hello", "enquiries", "enquiry", "office", "admin", "sales", "bookings", "mail",
                   "contactus", "general", "reception", "team", "studio", "quotes", "booking")
# addresses that reach whoever makes the decisions, even without a name
DECISION_ROLES = ("owner", "director", "directors", "md", "ceo", "founder", "boss", "proprietor", "managingdirector")
# inboxes that reach a department, not the decision maker
DEPARTMENTS = ("accounts", "finance", "invoices", "billing", "payroll", "hr", "careers", "jobs", "recruitment", "marketing",
               "press", "media", "support", "service", "parts", "workshop", "orders", "customerservice", "customer",
               "customers", "web", "webmaster", "privacy", "dpo", "gdpr", "complaints", "help", "accountspayable",
               "purchasing", "procurement", "dispatch", "transport", "operations", "ops", "it", "noreply", "news",
               "newsletter")
# pages most likely to hold contact details, in the order worth trying
PAGE_HINTS = ("contact", "get-in-touch", "enquir", "quote", "about", "team", "meet", "privacy", "terms", "legal", "imprint")
MAX_EXTRA_PAGES = 6
ABOUT_HINTS = ("about", "team", "meet", "who-we-are", "our-story")
DNS_URL = "https://cloudflare-dns.com/dns-query"


def decode_cfemail(hexstr: str) -> str:
    """Cloudflare 'email protection' scrambles addresses as hex XOR'd with the first byte."""
    try:
        key = int(hexstr[:2], 16)
        return "".join(chr(int(hexstr[i:i + 2], 16) ^ key) for i in range(2, len(hexstr), 2))
    except ValueError:
        return ""


def emails_in(html: str) -> list[str]:
    """Every email on a page, including hidden ones, in page order, de-duplicated, junk removed."""
    found: list[str] = []
    text = unescape(unquote(html))
    candidates = EMAIL_RE.findall(text)
    candidates += [f"{user}@{DOT_RE.sub('.', domain)}" for user, domain in OBFUSCATED_RE.findall(text)]
    candidates += [decode_cfemail(h) for h in re.findall(r'data-cfemail="([0-9a-fA-F]+)"', html)]
    candidates += [decode_cfemail(h) for h in re.findall(r"/cdn-cgi/l/email-protection#([0-9a-fA-F]+)", html)]
    for e in candidates:
        e = e.lower().strip(".").removeprefix("mailto:")
        if e and EMAIL_RE.fullmatch(e) and not JUNK_EMAIL.search(e) and e not in found:
            found.append(e)
    return found


def is_own(email: str, site_host: str) -> bool:
    return bool(site_host) and (email.endswith("@" + site_host) or email.endswith("." + site_host))


def is_personal(email: str) -> bool:
    """dave@, dave.smith@, j.smith@: a person, not a department inbox."""
    first = re.split(r"[._-]", email.split("@")[0])[0]
    return first not in GENERIC_INBOXES and first not in DEPARTMENTS and first not in DECISION_ROLES and not first.isdigit()


def staff_count(emails: list[str], site_host: str) -> int:
    """How many different people have an address on the business's own domain (3+ = a staffed company)."""
    return sum(1 for e in emails if is_own(e, site_host) and is_personal(e))


def drop_glued(emails: list[str]) -> list[str]:
    """'enquiries.eddiestobart@eddiestobart.com' next to 'enquiries@eddiestobart.com' is a scraping artefact
    (the site's name glued onto a real address), not a real inbox."""
    out = []
    for e in emails:
        local, _, domain = e.partition("@")
        brand = domain.split(".")[0]
        bare = re.sub(rf"(^{re.escape(brand)}[._-]|[._-]{re.escape(brand)}$)", "", local)
        if bare != local and f"{bare}@{domain}" in emails:
            continue
        out.append(e)
    return out


def rank_emails(emails: list[str], site_host: str, owner_first: str = "", owner_last: str = "") -> list[str]:
    """Best address to reach whoever makes the decision, first:
    the owner's own address → a decision-maker role (director@, owner@) → in a small business, a named person
    (it's usually the owner or a partner) → the general inbox (info@, enquiries@) → named staff of a bigger company
    → anything on another domain. Departments (accounts@, careers@) come last on the domain."""
    emails = drop_glued(emails)
    first, last = owner_first.lower(), owner_last.lower()
    small = staff_count(emails, site_host) <= 2

    def tier(e: str) -> int:
        if not is_own(e, site_host):
            return 7
        parts = re.split(r"[._-]", e.split("@")[0])
        if first and (parts[0] == first or (len(parts) > 1 and last and parts[0][:1] == first[:1] and parts[1] == last)):
            return 0
        if parts[0] in DECISION_ROLES:
            return 1
        if is_personal(e):
            return 2 if small else 4
        if parts[0] in GENERIC_INBOXES:
            return 3
        return 5  # departments

    return sorted(emails, key=tier)


def contact_pages(soup: BeautifulSoup, base_url: str) -> list[str]:
    """Same-site links worth visiting for contact details, best first."""
    host = urlparse(base_url).hostname
    scored: list[tuple[int, str]] = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"]).split("#")[0]
        if urlparse(href).hostname != host or href.rstrip("/") == base_url.rstrip("/"):
            continue
        haystack = (href + " " + a.get_text(" ", strip=True)).lower()
        rank = next((i for i, hint in enumerate(PAGE_HINTS) if hint in haystack), None)
        if rank is not None and href not in [u for _, u in scored]:
            scored.append((rank, href))
    return [u for _, u in sorted(scored)][:MAX_EXTRA_PAGES]


async def receives_email(client: httpx.AsyncClient, domain: str) -> bool:
    """Does the domain have mail servers (an MX record)? Free DNS lookup."""
    try:
        resp = await client.get(DNS_URL, params={"name": domain, "type": "MX"}, headers={"accept": "application/dns-json"}, timeout=8)
        return any(a.get("type") == 15 for a in resp.json().get("Answer", []))
    except (httpx.HTTPError, ValueError):
        return False


async def find(client: httpx.AsyncClient, first_html: str, final_url: str) -> dict:
    """Search the site for emails and socials. Returns {"emails", "source", "socials", "pages_checked"}."""
    from aetos_leads.audit import extract_socials, host_of  # local import: audit imports this module

    site_host = host_of(final_url)
    soup = BeautifulSoup(first_html, "html.parser")
    emails = emails_in(first_html)
    socials = extract_socials(soup)
    checked = 1

    def has_own(es: list[str]) -> bool:
        return any(e.endswith("@" + site_host) or e.endswith("." + site_host) for e in es)

    htmls = [first_html]
    links = contact_pages(soup, final_url)
    about = [u for u in links if any(h in u.lower() for h in ABOUT_HINTS)]
    for url in links:
        # efficient: stop once we have an own-domain address, but still read one about/team page for the owner's name
        if has_own(emails) and (url not in about[:1] or len(htmls) > 1):
            continue
        try:
            resp = await client.get(url, timeout=12)
        except httpx.HTTPError:
            continue
        checked += 1
        if resp.status_code != 200:
            continue
        htmls.append(resp.text)
        emails += [e for e in emails_in(resp.text) if e not in emails]
        for k, v in extract_socials(BeautifulSoup(resp.text, "html.parser")).items():
            socials.setdefault(k, v)

    if emails:
        return {"emails": rank_emails(emails, site_host), "source": "website", "socials": socials, "pages_checked": checked, "htmls": htmls}
    if site_host and await receives_email(client, site_host):
        return {"emails": [f"info@{site_host}"], "source": "guessed", "socials": socials, "pages_checked": checked, "htmls": htmls}
    return {"emails": [], "source": "", "socials": socials, "pages_checked": checked, "htmls": htmls}
