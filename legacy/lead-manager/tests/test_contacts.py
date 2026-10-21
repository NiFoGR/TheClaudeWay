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


def test_ranking_small_business_person_before_inbox():
    ranked = contacts.rank_emails(["bob@gmail.com", "info@smith.co.uk", "accounts@smith.co.uk", "dave@smith.co.uk"], "smith.co.uk")
    assert ranked == ["dave@smith.co.uk", "info@smith.co.uk", "accounts@smith.co.uk", "bob@gmail.com"]


def test_ranking_owner_then_decision_role_first():
    emails = ["info@smith.co.uk", "director@smith.co.uk", "kasia@smith.co.uk", "d.smith@smith.co.uk"]
    assert contacts.rank_emails(emails, "smith.co.uk", "dave", "smith")[0] == "d.smith@smith.co.uk"
    assert contacts.rank_emails(emails, "smith.co.uk")[0] == "director@smith.co.uk"


def test_eddie_stobart_real_data():
    # real run (transport, Widnes): the glued address is a scraping artefact; four named staff = a staffed company,
    # so the general inbox leads (Claude then decides who the decision maker is, or excludes it as too big)
    emails = ["enquiries@eddiestobart.com", "enquiries.eddiestobart@eddiestobart.com", "jack.quayle@eddiestobart.com",
              "qamar.zamir@eddiestobart.com", "sean.french@eddiestobart.com", "sarah.rayment@eddiestobart.com"]
    ranked = contacts.rank_emails(emails, "eddiestobart.com")
    assert "enquiries.eddiestobart@eddiestobart.com" not in ranked
    assert ranked[0] == "enquiries@eddiestobart.com"
    assert contacts.staff_count(ranked, "eddiestobart.com") == 4


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


def test_font_credit_emails_ignored_and_their_own_gmail_preferred():
    # real data: Bennies Boxing Gym (GoDaddy site) got impallari@gmail.com, a web font designer's address
    html = ("<style>/* Copyright (c) 2010, Pablo Impallari (www.impallari.com|impallari@gmail.com), "
            "with Reserved Font Name Libre Baskerville. Rodrigo Fuenzalida (hello@rfuenzalida.com) */</style>"
            "<p>Email us: benniesboxing@icloud.com</p>")
    assert contacts.emails_in(html) == ["benniesboxing@icloud.com"]
    ranked = contacts.rank_emails(["coach123@gmail.com", "benniesboxing@icloud.com"], "benniesboxing.co.uk", business="Bennies Boxing Gym")
    assert ranked[0] == "benniesboxing@icloud.com"
