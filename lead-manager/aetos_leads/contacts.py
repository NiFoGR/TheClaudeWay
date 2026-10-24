"""Find a business's email the way Hunter-style tools do, as efficiently as possible.

1. Read every page we fetch for emails, including the ways sites hide them from bots: mailto links,
   "info [at] site [dot] co.uk" text, Cloudflare email protection, and emails inside the page's schema.
2. Visit the pages most likely to list contact details (contact, about, team, privacy, terms…), best first,
   and stop the moment we have an address on the business's own domain. The contact pages, up to 3 (contact,
   get-a-quote, enquiries…), are always read: the audit checks the contact form, Google map, phone and address on
   them too, and the form is often on its own quote page.
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
# the contact pages: links with one of these are always read (audit.analyse_html checks form, map, phone and address
# on them), even when the homepage already has the email
CONTACT_HINTS = ("contact", "get-in-touch", "enquir", "quote")
MAX_CONTACT_PAGES = 3  # contact, get-a-quote, enquiries: the form is often on its own page
# pages most likely to hold contact details, in the order worth trying
PAGE_HINTS = CONTACT_HINTS + ("about", "team", "meet", "privacy", "terms", "legal", "imprint")
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


def emails_in(html: str, site_host: str = "") -> list[str]:
    """Every email on a page, including hidden ones, in page order, de-duplicated, junk removed. Never a web font's
    credit, and never the web designer's: an address off the business's own domain (site_host) next to a site credit
    ("Website by Pixel Studio · hello@pixelstudio.co.uk") would have us emailing their web designer."""
    found: list[str] = []
    site_host = site_host.lower().removeprefix("www.")
    text = unescape(unquote(html))
    # every address with where it sits on the page; a Cloudflare-protected one sits where its element is
    spans = _spans(text)
    for cf in (r'data-cfemail="([0-9a-fA-F]+)"', r"/cdn-cgi/l/email-protection#([0-9a-fA-F]+)"):
        spans += [(decode_cfemail(m[1]), *_element_span(text, m.start(), m.end())) for m in re.finditer(cf, text)]
    credits = {m.lower() for m in EMAIL_RE.findall(text) if _is_credit(text, m)}
    designers = {_clean(e) for e, start, end in spans if _is_designer_credit(text, _clean(e), start, end, site_host)}
    # and as the page reads, the credit then the address: a credit link's markup ('Website by <a href="…" target="…"
    # rel="…">Red Kite</a> · studio@redkite.co.uk') doesn't move them apart. Only a credit before it there: a platform's
    # "Powered by WordPress" a line under their own address isn't their designer's
    read = _as_read(text)
    designers |= {_clean(e) for e, start, end in _spans(read)
                  if _is_designer_credit(read, _clean(e), start, end, site_host, after=0)}
    for e, _, _ in spans:
        e = _clean(e)
        if e and EMAIL_RE.fullmatch(e) and not JUNK_EMAIL.search(e) and e not in credits and e not in designers \
                and e not in found:
            found.append(e)
    return found


def _clean(email: str) -> str:
    return email.lower().strip(".").removeprefix("mailto:")


def _spans(text: str) -> list[tuple[str, int, int]]:
    """Every address written out in text, plainly or as 'info [at] site [dot] co.uk', with where it starts and ends."""
    spans = [(m.group(), m.start(), m.end()) for m in EMAIL_RE.finditer(text)]
    return spans + [(f"{m[1]}@{DOT_RE.sub('.', m[2])}", m.start(), m.end()) for m in OBFUSCATED_RE.finditer(text)]


CREDIT_WORDS = re.compile(r"font|typeface|glyph|\bOFL\b", re.I)
CODE_BLOCKS = re.compile(r"<style\b.*?</style>|/\*.*?\*/", re.S | re.I)
# a site credit: the address next to it is the web designer's (or their host's), not the business's
DESIGNER_WORDS = re.compile(r"web\s*design|designed by|website by|site by|built by|developed by|powered by|hosted by", re.I)
# what a visitor doesn't see as text on the page, and a Cloudflare-protected address's whole element
NOT_SHOWN = re.compile(r"<(script|style|template)\b.*?</\1\s*>|<!--.*?-->", re.S | re.I)
CF_ELEMENT = re.compile(r'<(\w+)\b[^>]*?(?:data-cfemail="|/cdn-cgi/l/email-protection#)([0-9a-fA-F]+)[^>]*>.*?</\1\s*>',
                        re.S | re.I)
TAG = re.compile(r"<[^>]*>")


def _as_read(text: str) -> str:
    """The page as a visitor reads it: scripts, styles and comments out, Cloudflare-protected addresses written out,
    markup gone, white space squeezed. 'Designed by <a href="https://…" target="_blank" rel="…">Red Kite</a> ·
    studio@redkite.co.uk' reads 'Designed by Red Kite · studio@redkite.co.uk'."""
    text = CF_ELEMENT.sub(lambda m: f" {decode_cfemail(m[2])} ", NOT_SHOWN.sub(" ", text))
    return " ".join(TAG.sub(" ", text).split())


def _element_span(text: str, start: int, end: int) -> tuple[int, int]:
    """A Cloudflare-protected address ('<a href="/cdn-cgi/l/email-protection" data-cfemail="…">[email protected]</a>')
    sits where its element is: from the start of its tag to the end of the element, so a credit right before or after
    it is as near as it looks on the page."""
    opened = text.rfind("<", 0, start)
    if opened != -1 and ">" not in text[opened:start]:
        start = opened
    closing = text.find("</", end, end + 80)
    if closing != -1:
        end = text.find(">", closing) + 1 or end
    return start, end


def _is_designer_credit(text: str, email: str, start: int, end: int, site_host: str, after: int = 40) -> bool:
    """'Website by Pixel Studio · hello@pixelstudio.co.uk': an address not on the business's domain with a site-credit
    word in the 80 characters before it or the 40 after. One that carries the site's name (smithlandscapes@gmail.com
    on smithlandscapes.co.uk) is still theirs, as rank_emails treats it."""
    if is_own(email, site_host):
        return False
    brand = re.sub(r"[^a-z0-9]", "", site_host.split(".")[0])
    if len(brand) > 3 and brand in re.sub(r"[^a-z0-9]", "", email.split("@")[0]):
        return False
    return bool(DESIGNER_WORDS.search(text[max(0, start - 80): end + after]))


def _is_credit(text: str, email: str) -> bool:
    """An address in a web font's or a stylesheet's credits (e.g. 'Copyright (c) Pablo Impallari
    (impallari@gmail.com), with Reserved Font Name…'), not the business's. Real data: Bennies Boxing Gym."""
    blocks = [(m.start(), m.end()) for m in CODE_BLOCKS.finditer(text)]
    for m in re.finditer(re.escape(email), text):
        if any(a <= m.start() < b for a, b in blocks) or CREDIT_WORDS.search(text[max(0, m.start() - 80): m.end() + 40]):
            return True
    return False


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


def rank_emails(emails: list[str], site_host: str, owner_first: str = "", owner_last: str = "", business: str = "") -> list[str]:
    """Best address to reach whoever makes the decision, first:
    the owner's own address → a decision-maker role (director@, owner@) → in a small business, a named person
    (it's usually the owner or a partner) → the general inbox (info@, enquiries@) → named staff of a bigger company
    → anything on another domain. Departments (accounts@, careers@) come last on the domain."""
    emails = drop_glued(emails)
    first, last = owner_first.lower(), owner_last.lower()
    words = [w for w in re.findall(r"[a-z]+", business.lower()) if w not in ("the", "and", "ltd", "limited")]
    small = staff_count(emails, site_host) <= 2

    def tier(e: str) -> int:
        if not is_own(e, site_host):  # gmail/icloud etc.: theirs if it carries their name ("benniesboxing@icloud.com")
            local = re.sub(r"[^a-z]", "", e.split("@")[0])
            mine = any(len(w) > 3 and w in local for w in words) or (first and first in local)
            return 6 if mine else 7
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
    return [u for _, u in _ranked_pages(soup, base_url)]


def _page_of(url: str) -> str:
    """The part of a link that names the page (path and query), lower case. Not the domain: in 'contactroofing.co.uk'
    or 'steamclean.co.uk' every link would look like a contact or team page."""
    parts = urlparse(url)
    return f"{parts.path}?{parts.query}".lower()


def _site_of(url: str) -> str:
    return (urlparse(url).hostname or "").removeprefix("www.")  # www.smith.co.uk and smith.co.uk are one site


def _ranked_pages(soup: BeautifulSoup, base_url: str) -> list[tuple[int, str]]:
    """contact_pages with each link's rank: the index of the first PAGE_HINTS word in its path or its words. Equal
    ranks keep the page's own order (the menu comes first, so /contact-us beats a blog post called a-contact-guide)."""
    host, home = _site_of(base_url), _page_of(base_url).rstrip("?").rstrip("/")
    scored: list[tuple[int, str]] = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"]).split("#")[0]
        if _site_of(href) != host or _page_of(href).rstrip("?").rstrip("/") == home:
            continue
        haystack = _page_of(href) + " " + "-".join(a.get_text(" ", strip=True).lower().split())  # "Get in touch"
        rank = next((i for i, hint in enumerate(PAGE_HINTS) if hint in haystack), None)
        if rank is not None and href not in [u for _, u in scored]:
            scored.append((rank, href))
    return sorted(scored, key=lambda s: s[0])[:MAX_EXTRA_PAGES]


async def receives_email(client: httpx.AsyncClient, domain: str) -> bool:
    """Does the domain have mail servers (an MX record)? Free DNS lookup."""
    try:
        resp = await client.get(DNS_URL, params={"name": domain, "type": "MX"}, headers={"accept": "application/dns-json"}, timeout=8)
        return any(a.get("type") == 15 for a in resp.json().get("Answer", []))
    except (httpx.HTTPError, ValueError):
        return False


async def find(client: httpx.AsyncClient, first_html: str, final_url: str) -> dict:
    """Search the site for emails and socials. Returns {"emails", "source", "socials", "pages_checked", "htmls",
    "contact_unread"}: htmls is the homepage then every other page read with a 200 (the contact pages, up to
    MAX_CONTACT_PAGES, always tried; bot-check pages left out); contact_unread is True when one of those contact pages
    wouldn't load for us (an error other than 404/410, a timeout or a bot check), so nothing may be claimed about
    what's on them."""
    from aetos_leads.audit import CHALLENGE_RE, extract_socials, host_of  # local import: audit imports this module

    site_host = host_of(final_url)
    soup = BeautifulSoup(first_html, "html.parser")
    emails = emails_in(first_html, site_host)
    socials = extract_socials(soup)
    checked = 1

    def has_own(es: list[str]) -> bool:
        return any(e.endswith("@" + site_host) or e.endswith("." + site_host) for e in es)

    htmls = [first_html]
    ranked = _ranked_pages(soup, final_url)
    links = [u for _, u in ranked]
    contact_links = [u for rank, u in ranked if rank < len(CONTACT_HINTS)][:MAX_CONTACT_PAGES]
    about = [u for u in links if any(h in _page_of(u) for h in ABOUT_HINTS)]
    home_has_own = has_own(emails)
    contact_unread = False
    for url in links:
        # efficient: stop once we have an own-domain address, but always read the contact pages (the audit checks their
        # form, map, phone and address) and, when the homepage had the address, one about/team page for the owner's name
        if url not in contact_links and has_own(emails) and not (home_has_own and url in about[:1]):
            continue
        try:
            resp = await client.get(url, timeout=12)
            checked += 1
        except httpx.HTTPError:
            resp = None
        readable = resp is not None and resp.status_code == 200 and not CHALLENGE_RE.search(resp.text)
        # a dead link (404/410) is what visitors get too; anything else: we never saw the page
        if url in contact_links and not readable and (resp is None or resp.status_code not in (404, 410)):
            contact_unread = True
        if not readable:
            continue
        htmls.append(resp.text)
        emails += [e for e in emails_in(resp.text, site_host) if e not in emails]
        for k, v in extract_socials(BeautifulSoup(resp.text, "html.parser")).items():
            socials.setdefault(k, v)

    if emails:
        return {"emails": rank_emails(emails, site_host), "source": "website", "socials": socials, "pages_checked": checked, "htmls": htmls,
                "contact_unread": contact_unread}
    if site_host and await receives_email(client, site_host):
        return {"emails": [f"info@{site_host}"], "source": "guessed", "socials": socials, "pages_checked": checked, "htmls": htmls,
                "contact_unread": contact_unread}
    return {"emails": [], "source": "", "socials": socials, "pages_checked": checked, "htmls": htmls,
            "contact_unread": contact_unread}
