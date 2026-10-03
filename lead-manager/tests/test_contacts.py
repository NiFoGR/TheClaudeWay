import asyncio

import httpx
import respx

from aetos_leads import audit, contacts

CF = "5a3e3b2c3f1a2937332e322835353c33343d743935742f31"  # dave@smithroofing.co.uk, Cloudflare-protected


def test_finds_hidden_emails_every_way_sites_hide_them():
    html = f"""
      <a href="mailto:office%40smithroofing.co.uk">Email us</a>
      <p>Write to sales [at] smithroofing [dot] co [dot] uk or bookings(at)smithroofing.co.uk</p>
      <a href="/cdn-cgi/l/email-protection" data-cfemail="{CF}">[email protected]</a>
      <script type="application/ld+json">{{"@type":"RoofingContractor","email":"hello@smithroofing.co.uk"}}</script>
      <img src="logo@2x.png"> example@mysite.com
    """
    found = contacts.emails_in(html)
    assert set(found) == {"office@smithroofing.co.uk", "sales@smithroofing.co.uk", "bookings@smithroofing.co.uk",
                          "dave@smithroofing.co.uk", "hello@smithroofing.co.uk"}


def test_cloudflare_decode():
    assert contacts.decode_cfemail(CF) == "dave@smithroofing.co.uk"
    assert contacts.decode_cfemail("zz") == ""


def test_ranking_prefers_own_domain_then_generic_inbox():
    ranked = contacts.rank_emails(["bob@gmail.com", "dave@smith.co.uk", "info@smith.co.uk"], "smith.co.uk")
    assert ranked == ["info@smith.co.uk", "dave@smith.co.uk", "bob@gmail.com"]


def test_contact_pages_best_first_same_site_only():
    from bs4 import BeautifulSoup
    soup = BeautifulSoup("""
      <a href="/privacy-policy">Privacy</a><a href="/about-us">About</a><a href="/contact">Contact us</a>
      <a href="https://facebook.com/contact">fb</a><a href="/gallery">Gallery</a><a href="/#top">Top</a>
    """, "html.parser")
    assert contacts.contact_pages(soup, "https://smith.co.uk/") == [
        "https://smith.co.uk/contact", "https://smith.co.uk/about-us", "https://smith.co.uk/privacy-policy"]


def run(coro):
    async def go():
        async with audit.make_client() as c:
            return await coro(c)
    return asyncio.run(go())


@respx.mock
def test_stops_as_soon_as_an_own_domain_email_is_found():
    home = '<a href="/contact">Contact</a><a href="/about">About</a><a href="https://instagram.com/smith">ig</a>'
    respx.get("https://smith.co.uk/contact").mock(return_value=httpx.Response(200, text="info@smith.co.uk"))
    about = respx.get("https://smith.co.uk/about").mock(return_value=httpx.Response(200, text="nothing"))
    found = run(lambda c: contacts.find(c, home, "https://smith.co.uk/"))
    assert found["emails"] == ["info@smith.co.uk"] and found["source"] == "website"
    assert found["socials"] == {"instagram": "https://instagram.com/smith"} and not about.called


@respx.mock
def test_guesses_info_only_when_the_domain_receives_email():
    respx.get(contacts.DNS_URL).mock(side_effect=lambda r: httpx.Response(200, json={
        "Answer": [{"type": 15, "data": "10 mx.smith.co.uk."}]} if r.url.params["name"] == "smith.co.uk" else {}))
    found = run(lambda c: contacts.find(c, "<p>call us</p>", "https://smith.co.uk/"))
    assert found.pop("htmls") and found == {"emails": ["info@smith.co.uk"], "source": "guessed", "socials": {}, "pages_checked": 1}
    none = run(lambda c: contacts.find(c, "<p>call us</p>", "https://nomail.co.uk/"))
    assert none["emails"] == [] and none["source"] == ""
