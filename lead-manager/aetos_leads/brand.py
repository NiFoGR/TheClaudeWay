"""Their look, for the demo site: logo, brand colour and real photos, taken from their own website (free).

The demo should feel like THEIR site from the first second: their logo at the top, their colour on the buttons, their
own photos of their work. Anything we can't find is simply left out (the demo falls back to a clean design), never
replaced with someone else's photos.
"""

import re
from collections import Counter
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

MAX_PHOTOS = 6
SKIP_IMG = re.compile(r"logo|icon|favicon|sprite|avatar|badge|banner-ad|pixel|spacer|blank|placeholder|loader|"
                      r"payment|visa|mastercard|paypal|trustpilot|checkatrade|google|facebook|instagram|twitter|"
                      r"whatsapp|wix|godaddy|cookie|flag|arrow|star|rating|map|\.svg|\.gif|data:", re.I)
HEX = re.compile(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b")


def _abs(base: str, src: str) -> str:
    url = urljoin(base, src.strip())
    return url if urlparse(url).scheme in ("http", "https") else ""


def _px(v) -> int:
    digits = re.sub(r"\D", "", str(v or ""))[:5]
    return int(digits) if digits else 0


def _hex6(h: str) -> str:
    h = h.lstrip("#").lower()
    return "#" + ("".join(c * 2 for c in h) if len(h) == 3 else h)


def _usable(colour: str) -> bool:
    """A real brand colour: not white/black/grey (which every site uses), not too pale to read white text on."""
    r, g, b = (int(colour[i:i + 2], 16) for i in (1, 3, 5))
    spread = max(r, g, b) - min(r, g, b)
    luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return spread > 40 and 25 < luminance < 200


def logo(soup: BeautifulSoup, base: str) -> str:
    for img in soup.find_all("img"):
        hint = " ".join([img.get("src", ""), img.get("alt", ""), " ".join(img.get("class", [])), img.get("id", "")])
        if re.search(r"logo", hint, re.I) and img.get("src") and not img["src"].startswith("data:"):
            return _abs(base, img["src"])
    for rel in ("apple-touch-icon", "icon"):
        link = soup.find("link", rel=lambda v, r=rel: v and r in " ".join(v if isinstance(v, list) else [v]).lower())
        if link and link.get("href") and not link["href"].endswith(".ico"):
            return _abs(base, link["href"])
    return ""


def colour(soup: BeautifulSoup, html: str) -> str:
    meta = soup.find("meta", attrs={"name": "theme-color"})
    if meta and HEX.fullmatch(meta.get("content", "").strip() or "-") and _usable(_hex6(meta["content"].strip())):
        return _hex6(meta["content"].strip())
    counts = Counter(_hex6(m.group(0)) for m in HEX.finditer(html))
    for c, _ in counts.most_common(30):
        if _usable(c):
            return c
    return ""


def photos(soup: BeautifulSoup, base: str) -> list[str]:
    out: list[str] = []
    meta = soup.find("meta", property="og:image")
    candidates = [meta.get("content", "")] if meta else []
    for img in soup.find_all("img"):
        src = img.get("data-src") or img.get("src") or ""
        if not any(0 < _px(img.get(a)) < 200 for a in ("width", "height")):  # skip icons and thumbnails
            candidates.append(src)
    for src in candidates:
        if not src or SKIP_IMG.search(src) or not re.search(r"\.(jpe?g|png|webp)(\?|$)", src, re.I):
            continue
        url = _abs(base, src)
        if url and url not in out:
            out.append(url)
        if len(out) >= MAX_PHOTOS:
            break
    return out


def extract(htmls: list[str], base: str) -> dict:
    """{"logo", "colour", "photos"} from the pages fetched during the audit (empty values when not found)."""
    found = {"logo": "", "colour": "", "photos": []}
    for html in htmls:
        soup = BeautifulSoup(html, "html.parser")
        found["logo"] = found["logo"] or logo(soup, base)
        found["colour"] = found["colour"] or colour(soup, html)
        for p in photos(soup, base):
            if p not in found["photos"] and len(found["photos"]) < MAX_PHOTOS:
                found["photos"].append(p)
    if found["logo"] in found["photos"]:
        found["photos"].remove(found["logo"])
    return found


def _rated(r) -> bool:
    """Only a review with its own numeric Google rating of 4 or 5 counts: a missing rating is never assumed to be
    5 stars, and anything outside Google's 1–5 (or NaN/infinity, which would also break the saved JSON) isn't real."""
    rating = r.get("rating") if isinstance(r, dict) else None
    return isinstance(rating, (int, float)) and not isinstance(rating, bool) and 4 <= rating <= 5


def top_reviews(reviews: list[dict], n: int = 3) -> list[dict]:
    """The best real Google reviews to show on their demo: rated 4–5 stars, with enough words to mean something.
    Names shortened to first name + initial ("Sarah K."); the rating is the review's own number."""
    good = [r for r in reviews or [] if _rated(r) and len(str(r.get("text") or "").split()) >= 8]
    out = []
    for r in sorted(good, key=lambda r: -len(str(r.get("text") or ""))):
        parts = str(r.get("author") or "").split()
        name = f"{parts[0]} {parts[-1][0]}." if len(parts) > 1 else (parts[0] if parts else "Google reviewer")
        text = " ".join(str(r["text"]).split())
        out.append({"author": name, "text": text if len(text) <= 320 else text[:317].rsplit(" ", 1)[0] + "…", "rating": r["rating"]})
        if len(out) >= n:
            break
    return out
