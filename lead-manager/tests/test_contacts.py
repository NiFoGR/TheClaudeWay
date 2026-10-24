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
def test_contact_page_is_fetched_even_when_home_has_an_email():
    home = '<p>info@smith.co.uk</p><a href="/contact">Contact</a><a href="/about">About</a>'
    contact = respx.get("https://smith.co.uk/contact").mock(return_value=httpx.Response(200, text="<form><input></form>"))
    respx.get("https://smith.co.uk/about").mock(return_value=httpx.Response(200, text="nothing"))
    found = run(lambda c: contacts.find(c, home, "https://smith.co.uk/"))
    assert contact.called and len(found["htmls"]) >= 2


@respx.mock
def test_quote_page_is_the_contact_page_and_the_about_page_is_still_read_for_the_owner():
    # the audit checks form, map, phone and address on the contact page, so it's read even with an email on the
    # homepage; one about page is still read for the owner's name, and nothing else once there's an own address
    home = ('<p>info@smith.co.uk</p><a href="/privacy">Privacy</a><a href="/about-us">About</a>'
            '<a href="/free-quote">Get a quote</a><a href="/gallery">Gallery</a>')
    form = "<form><textarea></textarea></form>"
    quote = respx.get("https://smith.co.uk/free-quote").mock(return_value=httpx.Response(200, text=form))
    about = respx.get("https://smith.co.uk/about-us").mock(return_value=httpx.Response(200, text="Dave Smith runs it"))
    privacy = respx.get("https://smith.co.uk/privacy").mock(return_value=httpx.Response(200, text="nothing"))
    found = run(lambda c: contacts.find(c, home, "https://smith.co.uk/"))
    assert quote.call_count == 1 and about.call_count == 1 and not privacy.called
    assert found["htmls"][1:] == [form, "Dave Smith runs it"] and found["pages_checked"] == 3
    assert found["emails"] == ["info@smith.co.uk"] and found["source"] == "website"


def test_the_contact_page_is_their_real_contact_link():
    # the hint words are looked for in the link's path and words, not the business's domain ("contactroofing" made
    # /about the "contact page"; "steamclean" made every link a "team" page); ties keep the page's own order (menu
    # first, so a blog post's slug doesn't beat /contact-us); www. or not is the same site
    from bs4 import BeautifulSoup

    def pages(html, base):
        return contacts.contact_pages(BeautifulSoup(html, "html.parser"), base)

    assert pages('<a href="/about">About</a><a href="/gallery">Gallery</a><a href="/contact">Contact</a>',
                 "https://contactroofing.co.uk/") == ["https://contactroofing.co.uk/contact", "https://contactroofing.co.uk/about"]
    assert pages('<a href="/gallery">Gallery</a><a href="/services">Services</a>', "https://steamclean.co.uk/") == []
    assert pages('<a href="/contact-us">Contact</a><a href="/blog/a-contact-checklist">Blog</a>',
                 "https://smith.co.uk/") == ["https://smith.co.uk/contact-us", "https://smith.co.uk/blog/a-contact-checklist"]
    assert pages('<a href="https://www.smith.co.uk/contact">Contact</a><a href="https://www.smith.co.uk/">Home</a>',
                 "https://smith.co.uk/") == ["https://www.smith.co.uk/contact"]
    assert pages('<a href="/index.php?page=contact">Info</a>', "https://smith.co.uk/") == [
        "https://smith.co.uk/index.php?page=contact"]
    assert pages('<a href="/gallery">Gallery</a><a href="/reach-us">Get  in\ntouch</a>', "https://smith.co.uk/") == [
        "https://smith.co.uk/reach-us"]


@respx.mock
def test_a_contact_page_that_wont_load_is_reported_unread():
    # a rate limit, a bot check or a timeout on the contact page: we never saw it, so the audit mustn't claim its form,
    # map, phone or address are missing. A dead link (404) is what visitors get too, so that page counts as read.
    home = '<p>info@smith.co.uk</p><a href="/contact">Contact</a>'
    respx.get("https://smith.co.uk/contact").mock(side_effect=[
        httpx.Response(429), httpx.Response(200, text="<title>Just a moment...</title>"), httpx.ReadTimeout("slow"),
        httpx.Response(404), httpx.Response(200, text="<form><input></form>")])
    form = "<form><input></form>"
    for unread, htmls in ((True, [home]), (True, [home]), (True, [home]), (False, [home]), (False, [home, form])):
        found = run(lambda c: contacts.find(c, home, "https://smith.co.uk/"))
        # a bot check isn't one of their pages: not kept for the owner's name or the demo's look either
        assert found["contact_unread"] is unread and found["htmls"] == htmls and found["emails"] == ["info@smith.co.uk"]
    assert run(lambda c: contacts.find(c, "<p>info@smith.co.uk</p>", "https://smith.co.uk/"))["contact_unread"] is False


@respx.mock
def test_every_contact_type_page_is_read_not_just_the_first():
    # real sites: /contact has the phone, email and address, the form lives on /get-a-quote. Only the first was read
    # once an own-domain address turned up, so "No contact or quote form" was quoted to a business that has one
    home = '<p>info@smith.co.uk</p><a href="/contact">Contact</a><a href="/get-a-quote">Get a quote</a>'
    contact_html = "<p>Call 0113 496 0000 or email info@smith.co.uk</p>"
    quote_html = '<form action="/send"><input name="name"><textarea name="msg"></textarea></form>'
    respx.get("https://smith.co.uk/contact").mock(return_value=httpx.Response(200, text=contact_html))
    quote = respx.get("https://smith.co.uk/get-a-quote").mock(return_value=httpx.Response(200, text=quote_html))
    found = run(lambda c: contacts.find(c, home, "https://smith.co.uk/"))
    assert quote.called and quote_html in found["htmls"] and contact_html in found["htmls"]
    assert found["contact_unread"] is False and found["emails"] == ["info@smith.co.uk"]


@respx.mock
def test_a_quote_page_that_wont_load_is_reported_unread():
    # the form may be on the quote page we couldn't see: nothing may be claimed about it
    home = '<p>info@smith.co.uk</p><a href="/contact">Contact</a><a href="/get-a-quote">Get a quote</a>'
    respx.get("https://smith.co.uk/contact").mock(return_value=httpx.Response(200, text="<p>info@smith.co.uk</p>"))
    quote = respx.get("https://smith.co.uk/get-a-quote").mock(return_value=httpx.Response(403))
    found = run(lambda c: contacts.find(c, home, "https://smith.co.uk/"))
    assert quote.called and found["contact_unread"] is True


@respx.mock
def test_at_most_three_contact_type_pages_are_read():
    links = ["/contact", "/contact-us", "/get-in-touch", "/enquiries", "/quote"]
    home = "<p>info@smith.co.uk</p>" + "".join(f'<a href="{u}">x</a>' for u in links)
    routes = [respx.get(f"https://smith.co.uk{u}").mock(return_value=httpx.Response(200, text="<p>hi</p>")) for u in links]
    found = run(lambda c: contacts.find(c, home, "https://smith.co.uk/"))
    assert [r.called for r in routes] == [True, True, True, False, False] and found["pages_checked"] == 4


@respx.mock
def test_guesses_info_only_when_the_domain_receives_email():
    respx.get(contacts.DNS_URL).mock(side_effect=lambda r: httpx.Response(200, json={
        "Answer": [{"type": 15, "data": "10 mx.smith.co.uk."}]} if r.url.params["name"] == "smith.co.uk" else {}))
    found = run(lambda c: contacts.find(c, "<p>call us</p>", "https://smith.co.uk/"))
    assert found.pop("htmls") and found.pop("contact_unread") is False
    assert found == {"emails": ["info@smith.co.uk"], "source": "guessed", "socials": {}, "pages_checked": 1}
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


def test_web_designer_credit_emails_are_ignored():
    footer = "<footer>Website designed by Pixel Studio · hello@pixelstudio.co.uk</footer>"
    assert contacts.emails_in(footer, "smithlandscapes.co.uk") == []
    own = "<footer>info@smithlandscapes.co.uk · Website by Pixel Studio</footer>"
    assert contacts.emails_in(own, "smithlandscapes.co.uk") == ["info@smithlandscapes.co.uk"]


def cf(email: str, key: int = 0x5A) -> str:
    """How Cloudflare's email protection writes an address: the key byte, then every character XOR'd with it."""
    return f"{key:02x}" + "".join(f"{ord(ch) ^ key:02x}" for ch in email)


def test_web_designer_credit_emails_are_ignored_however_they_are_written():
    host = "smithlandscapes.co.uk"
    protected = (f'<footer>Website by Pixel Studio · <a href="/cdn-cgi/l/email-protection" class="__cf_email__" '
                 f'data-cfemail="{cf("hello@pixelstudio.co.uk")}">[email&#160;protected]</a></footer>')
    mailto = (f'<p>Site by <a href="/cdn-cgi/l/email-protection#{cf("hi@webcraft.uk")}">'
              f'<span class="__cf_email__" data-cfemail="{cf("hi@webcraft.uk")}">[email&#160;protected]</span></a></p>')
    hidden = "<p>Designed by Pixel Studio, hello [at] pixelstudio [dot] co [dot] uk</p>"
    after = '<p><a href="mailto:studio@redkite.co.uk">studio@redkite.co.uk</a> - web design &amp; hosting</p>'
    for html in (protected, mailto, hidden, after):
        assert contacts.emails_in(html, host) == [], html
    # the address next to the credit is dropped, the business's own ones elsewhere on the page are kept
    page = ("<p>Call Dave on 07700 900000 or email dave.smith1975@gmail.com</p>" + "<p>We cover all of Cheshire.</p>" * 3
            + protected)
    assert contacts.emails_in(page, host) == ["dave.smith1975@gmail.com"]


def test_a_credit_counts_as_it_reads_on_the_page_not_by_its_markup():
    # a credit link's long address, target and rel attributes put 80+ characters of markup between "Designed by" and
    # the designer's address, but on the page they sit side by side
    host = "smithlandscapes.co.uk"
    link = ('<a href="https://www.redkite-websites.co.uk/?utm_source=client-footer" target="_blank" '
            'rel="noopener noreferrer">Red Kite Websites</a>')
    plain = (f'<div class="site-credit"><span>Designed &amp; hosted by</span>\n        {link} |\n        '
             '<a href="mailto:studio@redkite-websites.co.uk">studio@redkite-websites.co.uk</a></div>')
    protected = (f'<p class="credit">Website designed by {link} · <a href="/cdn-cgi/l/email-protection" '
                 f'class="__cf_email__" data-cfemail="{cf("studio@redkite-websites.co.uk")}">[email&#160;protected]</a></p>')
    for html in (plain, protected):
        assert contacts.emails_in(html, host) == [], html
    # the business's own address above the credit is still theirs: a WordPress theme's footer reads "Email
    # dave.smith1975@gmail.com © 2026 Smith Landscapes Powered by WordPress", but in its code they're far apart
    footer = ('<aside class="widget-area"><div class="widget"><p>Email dave.smith1975@gmail.com</p></div></aside>\n'
              '<footer id="site-footer" class="header-footer-group"><div class="section-inner"><div class="footer-credits">'
              '<p class="footer-copyright">&copy; 2026 <a href="https://smithlandscapes.co.uk/">Smith Landscapes</a></p>'
              '<p class="powered-by-wordpress"><a href="https://en-gb.wordpress.org/">Powered by WordPress</a></p>'
              '</div></div></footer>')
    assert contacts.emails_in(footer, host) == ["dave.smith1975@gmail.com"]


def test_their_own_address_next_to_a_site_credit_is_kept():
    # a sole trader's own iCloud/Gmail carrying the site's name is theirs, credit or not (GoDaddy and WordPress
    # footers say "Powered by…"); their own domain always is
    html = "<footer>© 2026 Bennies Boxing · benniesboxing@icloud.com · Powered by GoDaddy</footer>"
    assert contacts.emails_in(html, "www.benniesboxing.co.uk") == ["benniesboxing@icloud.com"]
    assert contacts.emails_in("<p>Built by us: hello@studio.smithlandscapes.co.uk</p>", "smithlandscapes.co.uk") == [
        "hello@studio.smithlandscapes.co.uk"]
    # without the site's domain nothing can count as theirs, so a credited address is never taken
    assert contacts.emails_in("<footer>Website by Pixel Studio · hello@pixelstudio.co.uk</footer>") == []


@respx.mock
def test_the_site_search_and_the_audit_never_take_the_designers_address():
    home = ('<a href="/contact">Contact</a>'
            "<footer>Website designed by Pixel Studio · hello@pixelstudio.co.uk</footer>")
    respx.get("https://www.smithlandscapes.co.uk/contact").mock(return_value=httpx.Response(
        200, text="<p>Email smithgardens@gmail.com</p>" + "<p>We cover all of Cheshire.</p>" * 2
        + "<footer>Website by Pixel Studio · hello@pixelstudio.co.uk</footer>"))
    found = run(lambda c: contacts.find(c, home, "https://www.smithlandscapes.co.uk/"))
    assert found["emails"] == ["smithgardens@gmail.com"] and found["source"] == "website"
    assert audit.extract_emails(home, "smithlandscapes.co.uk") == []
