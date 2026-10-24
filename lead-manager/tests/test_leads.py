import asyncio
import json
import re
import sqlite3
from datetime import date

import httpx
import respx

from conftest import FIXTURES, FakeD1
from aetos_leads import audit, companies_house, maprank, pipeline, places, qualify, scoring, store, usage
from aetos_leads.models import Lead

OLD = (FIXTURES / "old_site.html").read_text()
GOOD = (FIXTURES / "good_site.html").read_text()


def place(i: int, **over) -> dict:
    p = {
        "id": f"p{i}",
        "displayName": {"text": f"Roofer {i}"},
        "formattedAddress": f"{i} High St, Leeds LS1 1AA, UK",
        "addressComponents": [
            {"longText": "Leeds", "types": ["postal_town"]},
            {"longText": "LS1 1AA", "types": ["postal_code"]},
        ],
        "nationalPhoneNumber": f"0113 496 {i:04d}",
        "rating": 4.8,
        "userRatingCount": 40,
        "businessStatus": "OPERATIONAL",
        "types": ["roofing_contractor"],
    }
    p.update(over)
    return p


def lead(**over) -> Lead:
    base = dict(place_id="x", name="Smith Roofing", trade="roofer", search_town="Leeds", rank=1, town="Leeds")
    base.update(over)
    return Lead(**base)


# ---------------------------------------------------------------- discovery


def places_api(pages_by_query: dict[str, list[dict]]):
    """respx side effect: serve pages per textQuery, following pageToken like Google does."""

    def handler(request):
        body = json.loads(request.content)
        pages = pages_by_query.get(body["textQuery"], [{"places": []}])
        page = pages[int(body.get("pageToken", 0))]
        return httpx.Response(200, json=page)

    return handler


@respx.mock
def test_places_paginates_ranks_and_includes_service_area_businesses():
    route = respx.post(places.SEARCH_URL).mock(side_effect=places_api({
        "roofer in Leeds": [
            {"places": [place(1), place(2)], "nextPageToken": "1"},
            {"places": [place(3, websiteUri="https://r3.co.uk")]},
        ],
    }))
    with httpx.Client() as c:
        leads = places.search(c, "KEY", "roofer", "Leeds")
    assert [l.rank for l in leads] == [1, 2, 3]
    assert leads[0].town == "Leeds" and leads[0].postcode == "LS1 1AA"
    assert leads[2].website == "https://r3.co.uk"
    first, second = (json.loads(call.request.content) for call in route.calls[:2])
    assert first["includePureServiceAreaBusinesses"] is True
    assert first["textQuery"] == "roofer in Leeds"
    assert second["pageToken"] == "1"
    assert route.calls[0].request.headers["X-Goog-Api-Key"] == "KEY"


@respx.mock
def test_places_respects_max_results():
    respx.post(places.SEARCH_URL).mock(side_effect=places_api({
        "roofer in Leeds": [{"places": [place(i) for i in range(20)], "nextPageToken": "1"},
                            {"places": [place(i) for i in range(20, 40)]}],
    }))
    with httpx.Client() as c:
        assert len(places.search(c, "KEY", "roofer", "Leeds", max_results=25)) == 25


@respx.mock
def test_places_goes_past_60_with_variations_and_dedupes():
    main = [{"places": [place(i) for i in range(p * 20, p * 20 + 20)], **({"nextPageToken": str(p + 1)} if p < 2 else {})}
            for p in range(3)]
    respx.post(places.SEARCH_URL).mock(side_effect=places_api({
        "roofer in Leeds": main,
        "roofer near Leeds": [{"places": [place(5), place(100), place(101)]}],  # p5 is a duplicate
    }))
    with httpx.Client() as c:
        leads = places.search(c, "KEY", "roofer", "Leeds", max_results=200)
    assert len(leads) == 62
    assert leads[59].rank == 60 and leads[60].place_id == "p100" and leads[60].rank is None


# ---------------------------------------------------------------- audit

SITEMAP_35 = "<urlset>" + "".join(f"<url><loc>https://acmeroofing.co.uk/p{i}</loc></url>" for i in range(35)) + "</urlset>"


def no_sitemaps():
    respx.get(url__regex=r".*sitemap.*").mock(return_value=httpx.Response(404))


def keys(findings):
    return [k for k, _ in findings]


def test_old_site_gets_every_relevant_finding():
    old = OLD.replace("<table>", "<table><font>")
    findings, facts = audit.analyse_html(old, "http://smithroofing.co.uk/", "Leeds", 4.2, today=date(2026, 10, 3),
                                         trade="roofer", phone="0113 496 0000", postcode="LS1 1AA")
    assert set(keys(findings)) == {
        "not_mobile", "not_secure", "outdated", "old_build", "slow", "no_form", "no_tap_to_call", "no_chat",
        "title_no_town", "no_h1", "no_schema", "address_not_on_site", "no_map", "no_description",
    }  # trade IS in the title ("Smith Roofing") and the phone IS in the text
    assert facts["copyright_year"] == 2016 and facts["phone_on_site"] is True


def test_perfect_site_has_no_findings():
    findings, facts = audit.analyse_html(GOOD, "https://acmeroofing.co.uk/", "Leeds", 0.8, today=date(2026, 10, 3),
                                         trade="roofer", phone="0113 496 0001", postcode="LS1 1AA")
    assert findings == []
    assert facts["schema"] and facts["google_map"] and facts["chat_widget"] == "tidio"


def test_site_wide_checks_read_the_contact_page():
    home = GOOD.replace('<form><input name="email"><textarea name="msg"></textarea></form>', "") \
               .replace('<iframe src="https://www.google.com/maps/embed?pb=abc"></iframe>', "") \
               .replace("Acme Roofing, 1 High St, Leeds LS1 1AA · ", "").replace("Call 0113 496 0001", "Call us")
    contact = ('<form><textarea></textarea></form><iframe src="https://www.google.com/maps/embed?pb=x"></iframe>'
               "<p>0113 496 0001 · 1 High St, Leeds LS1 1AA</p>")
    found, facts = audit.analyse_html(home, "https://acmeroofing.co.uk/", "Leeds", 0.8, today=date(2026, 10, 3),
                                      trade="roofer", phone="0113 496 0001", postcode="LS1 1AA", extra_pages=[contact])
    assert not {"no_form", "no_map", "phone_not_on_site", "address_not_on_site"} & set(keys(found))
    assert facts["contact_form"] is True and facts["google_map"] is True


@respx.mock
def test_audit_reads_the_contact_page_once_for_form_map_phone_and_address():
    # real runs: form, map, phone and address usually live on the Contact page, which wasn't even fetched when the
    # homepage had an email, so "No contact or quote form", "No Google map"… were false
    home = OLD.replace("Call us on 0113 496 0000.", "Call us.")  # an email, but no form, map, phone or postcode
    contact = respx.get("http://smithroofing.co.uk/contact-us.html").mock(return_value=httpx.Response(200, text=(
        '<form><input name="email"></form><iframe src="https://maps.google.com/maps?q=LS1+1AA&output=embed"></iframe>'
        '<a href="tel:+441134960000">Phone us</a> 1 High St, Leeds LS1 1AA')))
    respx.get("http://smithroofing.co.uk/").mock(return_value=httpx.Response(200, text=home))
    no_sitemaps()
    l = run_audit(lead(website="http://smithroofing.co.uk/", phone="0113 496 0000", postcode="LS1 1AA"))
    assert not {"no_form", "no_map", "phone_not_on_site", "address_not_on_site"} & set(l.findings)
    assert l.audit["contact_form"] and l.audit["google_map"] and l.audit["phone_on_site"] and l.audit["address_on_site"]
    assert contact.call_count == 1 and l.email == "info@smithroofing.co.uk" and len(l.pages_html) == 2
    # homepage-only checks still judge the homepage: the contact page's tel: link doesn't make the homepage tap-to-call
    assert {"no_tap_to_call", "not_mobile", "no_h1", "no_schema", "no_description"} <= set(l.findings)


@respx.mock
def test_no_claims_about_a_contact_page_we_couldnt_read():
    # the contact page answered 429 (rate limit), a bot check, or timed out: what's on it is unknown, so none of the
    # four site-wide lines is claimed (the homepage-only checks still are). A 404 is a dead link: the claims stand.
    home = OLD.replace("Call us on 0113 496 0000.", "Call us.")
    respx.get("http://smithroofing.co.uk/").mock(return_value=httpx.Response(200, text=home))
    respx.get("http://smithroofing.co.uk/contact-us.html").mock(side_effect=[
        httpx.Response(429), httpx.Response(200, text="<title>Just a moment...</title>"), httpx.ReadTimeout("slow"),
        httpx.Response(404)])
    no_sitemaps()
    site_wide = {"no_form", "no_map", "phone_not_on_site", "address_not_on_site"}
    for _ in range(3):
        l = run_audit(lead(website="http://smithroofing.co.uk/", phone="0113 496 0000", postcode="LS1 1AA"))
        assert not site_wide & set(l.findings) and l.audit["contact_unread"] is True
        assert [l.audit[k] for k in ("contact_form", "google_map", "phone_on_site", "address_on_site")] == [None] * 4
        assert {"no_tap_to_call", "not_mobile", "no_h1", "no_schema", "no_description"} <= set(l.findings)
        assert l.email == "info@smithroofing.co.uk" and l.pages_html == [home]
    l = run_audit(lead(website="http://smithroofing.co.uk/", phone="0113 496 0000", postcode="LS1 1AA"))
    assert site_wide <= set(l.findings) and "contact_unread" not in l.audit and l.audit["contact_form"] is False


def test_phone_and_postcode_in_the_contact_page_text_count():
    # the spec's contact-page test keeps the homepage's tel: link; here the number is only typed on the contact page
    home = OLD.replace("Call us on 0113 496 0000.", "Call us.")
    found, facts = audit.analyse_html(home, "http://smithroofing.co.uk/", "Leeds", 1, today=date(2026, 10, 3),
                                      trade="roofer", phone="0113 496 0000", postcode="LS1 1AA",
                                      extra_pages=["<p>Ring (0113) 496-0000 · Unit 2, 1 High St, Leeds ls11aa</p>"])
    assert not {"phone_not_on_site", "address_not_on_site"} & set(keys(found))
    assert facts["phone_on_site"] is True and facts["address_on_site"] is True
    assert "no_tap_to_call" in keys(found)  # typed text on another page doesn't make the homepage tap-to-call
    alone, _ = audit.analyse_html(home, "http://smithroofing.co.uk/", "Leeds", 1, today=date(2026, 10, 3),
                                  trade="roofer", phone="0113 496 0000", postcode="LS1 1AA")
    assert {"phone_not_on_site", "address_not_on_site"} <= set(keys(alone))


def test_site_wide_checks_still_report_what_no_page_has():
    found, facts = audit.analyse_html(OLD, "http://smithroofing.co.uk/", "Leeds", 1, today=date(2026, 10, 3),
                                      trade="roofer", phone="0113 496 0999", postcode="LS1 1AA",
                                      extra_pages=["<p>About us: family roofers since 1990</p>", "<p>Privacy policy</p>"])
    assert {"no_form", "no_map", "phone_not_on_site", "address_not_on_site"} <= set(keys(found))
    assert facts["contact_form"] is False and facts["google_map"] is False
    assert facts["phone_on_site"] is False and facts["address_on_site"] is False


CONTACT_NO_FORM_HOME = OLD.replace("Call us on 0113 496 0000.", "Call us.")  # no form, no map of its own


def test_an_embedded_form_is_a_form():
    # Jotform, Google Forms, HubSpot and Ninja Forms (its form sits in a script template) on the contact page: the
    # visitor sees a form, so "No contact or quote form" would be false
    embeds = [
        "<iframe id='JotFormIFrame-1' src='https://form.jotform.com/231234567890' title='Get a quote'></iframe>",
        '<iframe src="https://docs.google.com/forms/d/e/1FAIpQLSe/viewform?embedded=true" width="640"></iframe>',
        '<script charset="utf-8" src="//js.hsforms.net/forms/embed/v2.js"></script>'
        '<script>hbspt.forms.create({region: "eu1", portalId: "1", formId: "x"});</script>',
        '<div id="nf-form-3-cont" class="nf-form-cont"><div class="nf-loading-spinner"></div></div>'
        '<script id="tmpl-nf-layout" type="text/template"><form><input type="text"></form></script>',
    ]
    for embed in embeds:
        found, facts = audit.analyse_html(CONTACT_NO_FORM_HOME, "http://smithroofing.co.uk/", "Leeds", 1,
                                          today=date(2026, 10, 3), trade="roofer", phone="0113 496 0000",
                                          postcode="LS1 1AA", extra_pages=[f"<h1>Contact us</h1>{embed}"])
        assert "no_form" not in keys(found) and facts["contact_form"] is True, embed


def test_a_lazy_loaded_or_consent_blocked_map_is_a_map():
    # WordPress speed and cookie plugins move the map's address out of src, and some themes draw it with Google's
    # Maps JavaScript: every visitor sees a map, so "No Google map on the website" would be false
    maps = [
        '<iframe data-lazyloaded="1" src="about:blank" data-litespeed-src="https://www.google.com/maps/embed?pb=x"></iframe>',
        '<iframe data-cookieblock-src="https://www.google.com/maps/embed?pb=x" data-cookieconsent="marketing"></iframe>',
        '<script src="https://maps.googleapis.com/maps/api/js?key=k"></script><div class="et_pb_map"></div>',
    ]
    for embed in maps:
        found, facts = audit.analyse_html(CONTACT_NO_FORM_HOME, "http://smithroofing.co.uk/", "Leeds", 1,
                                          today=date(2026, 10, 3), trade="roofer", phone="0113 496 0000",
                                          postcode="LS1 1AA", extra_pages=[f"<h1>Contact us</h1>{embed}"])
        assert "no_map" not in keys(found) and facts["google_map"] is True, embed


@respx.mock
def test_the_form_on_a_quote_page_counts_even_when_the_contact_page_has_none():
    # real sites: /contact has the email and address, the form is on /get-a-quote. Only the first contact-type page was
    # read once an own-domain address turned up, so the call script told them "there's no quick way to ask for a quote"
    home = OLD.replace('<a href="/contact-us.html">Contact</a>',
                       '<a href="/contact-us.html">Contact</a> <a href="/get-a-quote.html">Get a quote</a>')
    assert home != OLD
    respx.get("http://smithroofing.co.uk/").mock(return_value=httpx.Response(200, text=home))
    respx.get("http://smithroofing.co.uk/contact-us.html").mock(return_value=httpx.Response(200, text=(
        "<p>Email info@smithroofing.co.uk · 1 High St, Leeds LS1 1AA</p>")))
    quote = respx.get("http://smithroofing.co.uk/get-a-quote.html").mock(return_value=httpx.Response(200, text=(
        '<h1>Free quote</h1><form action="/send"><input name="name"><textarea name="msg"></textarea></form>')))
    no_sitemaps()
    l = run_audit(lead(website="http://smithroofing.co.uk/", phone="0113 496 0000", postcode="LS1 1AA"))
    assert quote.called and "no_form" not in l.findings and l.audit["contact_form"] is True
    assert "no_map" in l.findings  # no page has a map: that line is still true


def test_trade_words_match_their_variants_and_synonyms():
    assert audit.mentions("Roofing Contractors Warrington", audit.trade_terms("roofer"))
    assert audit.mentions("Boiler repairs & installs", audit.trade_terms("heating engineer"))
    assert audit.mentions("Smith's Garage - MOT and servicing", audit.trade_terms("mechanic"))
    assert not audit.mentions("Welcome to Smith & Co", audit.trade_terms("plumber"))


def test_town_and_trade_wording_variants():
    assert audit.town_key("St. Helens") == audit.town_key("Saint Helens") == audit.town_key("st helens") == "st helens"
    assert audit.town_key("Newton-le-Willows") == "newton le willows"
    html = ('<html><head><title>Patios, Driveways &amp; Lawns | St. Helens</title></head>'
            '<body><h1>Garden Landscaping in Saint Helens</h1><a href="tel:01744000000">Call</a></body></html>')
    found, _ = audit.analyse_html(html, "https://x.co.uk/", "St Helens", 1, today=date(2026, 10, 3), trade="landscaper")
    assert not {"title_no_trade", "title_no_town", "h1_weak", "no_tap_to_call"} & set(keys(found))
    for title in ["Fencing & Decking", "Turf and Artificial Grass", "Tree and Hedge Care", "Groundworks"]:
        assert audit.mentions(title, audit.trade_terms("landscaper")), title
    no_tel, _ = audit.analyse_html(OLD, "https://x.co.uk/", "Leeds", 1, today=date(2026, 10, 3))
    assert ("no_tap_to_call", "No tap-to-call phone link on the home page") in no_tel


def test_town_key_handles_glued_dots_apostrophes_and_still_reports_a_missing_town():
    # "St.Helens" (no space) and "King's Lynn" vs "Kings Lynn" are the same town; another town is still missing
    assert audit.town_key("St.Helens") == "st helens" and audit.town_key("  ST   HELENS ") == "st helens"
    assert audit.town_key("King's Lynn") == audit.town_key("Kings Lynn") == audit.town_key("King’s Lynn") == "kings lynn"
    assert audit.town_key("Stoke-on-Trent") == "stoke on trent" and audit.town_key("") == ""
    html = ('<html><head><title>Fencing &amp; Gates, Newton le Willows</title></head>'
            '<body><h1>Fencing in Newton le Willows</h1></body></html>')
    found, _ = audit.analyse_html(html, "https://x.co.uk/", "Newton-le-Willows", 1, today=date(2026, 10, 3),
                                  trade="landscaper")
    assert not {"title_no_trade", "title_no_town", "h1_weak"} & set(keys(found))
    elsewhere, _ = audit.analyse_html(html, "https://x.co.uk/", "Saint Helens", 1, today=date(2026, 10, 3),
                                      trade="landscaper")
    assert ("title_no_town", "Town (Saint Helens) not in the page title, so it's harder to find locally") in elsewhere
    assert "h1_weak" in keys(elsewhere) and "title_no_trade" not in keys(elsewhere)


def test_hyphenated_trade_words_still_count():
    assert audit.mentions("Artificial-Grass Installers", audit.trade_terms("landscaper"))
    assert audit.mentions("Air-Con Installers", audit.trade_terms("hvac"))
    assert not audit.mentions("Welcome to Smith & Co", audit.trade_terms("landscaper"))


def test_town_key_folds_accents_and_ampersands_and_plural_trades_keep_their_synonyms():
    # "Ynys Mon" for "Ynys Môn", "and" for "&", and a niche typed as "Landscapers" must not bring back false claims
    assert audit.town_key("Ynys Môn") == audit.town_key("Ynys Mon") == "ynys mon"
    assert audit.town_key("Brighton & Hove") == audit.town_key("Brighton and Hove") == "brighton and hove"
    assert audit.town_key("King‘s Lynn") == "kings lynn" and audit.town_key(None) == ""
    assert audit.mentions("Patios & Driveways", audit.trade_terms("Landscapers"))
    assert audit.mentions("Combi boiler installs", audit.trade_terms(" heating  engineers "))
    assert not audit.mentions("Welcome to Smith & Co", audit.trade_terms("landscapers"))
    html = ('<html><head><title>Patios &amp; Driveways in Brighton and Hove</title></head>'
            '<body><h1>Driveways, Brighton &amp; Hove</h1></body></html>')
    found, _ = audit.analyse_html(html, "https://x.co.uk/", "Brighton & Hove", 1, today=date(2026, 10, 3),
                                  trade="landscapers")
    assert not {"title_no_trade", "title_no_town", "h1_weak"} & set(keys(found))


def test_a_tel_link_with_stray_spaces_is_still_tap_to_call():
    # browsers trim the spaces, so the link works on a phone: claiming "No tap-to-call phone link" would be false
    html = '<html><head><title>x</title></head><body><a href=" tel:01744 000000 ">Call us</a></body></html>'
    found, facts = audit.analyse_html(html, "https://x.co.uk/", "", 1, today=date(2026, 10, 3), phone="01744 000000")
    assert "no_tap_to_call" not in keys(found) and facts["phone_on_site"] is True


def test_phone_matches_whatever_format_the_site_uses():
    pattern = audit.phone_pattern("01925 417597")
    for shown in ["01925 417597", "01925-417-597", "+44 1925 417597", "+44 (0)1925 417 597", "(01925) 417597"]:
        assert pattern.search(shown), shown
    assert not pattern.search("01925 417598")


def test_email_extraction_filters_junk_and_prefers_own_domain():
    html = "a@example.com x@sentry.wixpress.com logo@2x.png bob@gmail.com info@smith.co.uk"
    assert audit.extract_emails(html, "smith.co.uk") == ["info@smith.co.uk", "bob@gmail.com"]


def test_profile_pages_are_not_websites():
    assert not audit.is_real_website("https://www.facebook.com/smithroofing")
    assert not audit.is_real_website("https://www.checkatrade.com/trades/smith")
    assert audit.is_real_website("https://smithroofing.co.uk")


def run_audit(l: Lead) -> Lead:
    async def go():
        async with audit.make_client() as c:
            await audit.audit_lead(c, l)

    asyncio.run(go())
    return l


def test_audit_no_website_and_profile_only():
    assert run_audit(lead()).findings == ["no_website"]
    profile = run_audit(lead(website="https://facebook.com/smith"))
    assert profile.findings == ["profile_only"] and "facebook.com" in profile.issues[0]


@respx.mock
def test_audit_broken_and_unreachable_sites():
    respx.get("https://broken.co.uk/").mock(return_value=httpx.Response(500))
    respx.get("https://down.co.uk/").mock(side_effect=httpx.ConnectError("nope"))
    assert run_audit(lead(website="https://broken.co.uk/")).issues == ["Website is broken (error 500)"]
    assert run_audit(lead(website="https://down.co.uk/")).issues == ["Website is down or won't load"]


@respx.mock
def test_audit_finds_email_on_contact_page_socials_and_page_count():
    no_email_home = OLD.replace("info@smithroofing.co.uk", "")
    respx.get("http://smithroofing.co.uk/").mock(return_value=httpx.Response(200, text=no_email_home))
    respx.get("http://smithroofing.co.uk/contact-us.html").mock(
        return_value=httpx.Response(200, text="Write to dave@smithroofing.co.uk")
    )
    respx.get("http://smithroofing.co.uk/sitemap.xml").mock(
        return_value=httpx.Response(200, text="<urlset><url><loc>http://smithroofing.co.uk/</loc></url></urlset>")
    )
    l = run_audit(lead(website="http://smithroofing.co.uk/"))
    assert l.email == "dave@smithroofing.co.uk"
    assert l.socials == {"facebook": "https://www.facebook.com/smithroofing"}
    assert l.audit["status"] == "ok" and l.audit["pages"] == 1 and "few_pages" in l.findings


@respx.mock
def test_sitemap_index_counts_pages_in_child_sitemaps():
    respx.get("https://acmeroofing.co.uk/sitemap.xml").mock(return_value=httpx.Response(404))
    respx.get("https://acmeroofing.co.uk/sitemap_index.xml").mock(return_value=httpx.Response(200, text=(
        "<sitemapindex><sitemap><loc>https://acmeroofing.co.uk/a.xml</loc></sitemap>"
        "<sitemap><loc>https://acmeroofing.co.uk/b.xml</loc></sitemap></sitemapindex>")))
    respx.get("https://acmeroofing.co.uk/a.xml").mock(return_value=httpx.Response(200, text=SITEMAP_35))
    respx.get("https://acmeroofing.co.uk/b.xml").mock(return_value=httpx.Response(200, text=SITEMAP_35))

    async def go():
        async with audit.make_client() as c:
            return await audit.count_pages(c, "https://acmeroofing.co.uk/anything")

    assert asyncio.run(go()) == 70


# ---------------------------------------------------------------- qualify + scoring


def test_exclusions():
    leads = [
        lead(place_id="a", name="Closed Roofing", business_status="CLOSED_PERMANENTLY"),
        lead(place_id="b", name="Kwik Fit Leeds"),
        lead(place_id="c", name="Branch One", website="https://multi.co.uk"),
        lead(place_id="d", name="Branch Two", website="https://www.multi.co.uk/leeds", town="Bradford"),
        lead(place_id="e", name="Smile Dental", types=["dentist"]),
        lead(place_id="f", name="Everest Roofing"),  # local name that looks like a brand: must stay
        lead(place_id="g", name="Bob's Plumbing", website="https://facebook.com/bob"),
    ]
    qualify.mark_exclusions(leads)
    reasons = {l.place_id: l.exclude_reason for l in leads}
    assert reasons == {
        "a": "Closed", "b": "Chain / national brand", "c": "Multiple branches (chain)",
        "d": "Multiple branches (chain)", "e": "Front desk / gatekeeper", "f": "", "g": "",
    }


def test_trade_names_with_clinic_or_surgery_are_not_front_desk():
    leads = [lead(place_id="a", name="Smith Tree Surgery"), lead(place_id="b", name="The Lawn Clinic"),
             lead(place_id="c", name="Driveway Clinic Warrington"), lead(place_id="d", name="Warrington Dental Clinic"),
             lead(place_id="e", name="Bridge St Solicitors"), lead(place_id="f", name="Bridge Street Surgery", types=["doctor"])]
    qualify.mark_exclusions(leads)
    assert [l.exclude_reason for l in leads] == ["", "", "", "Front desk / gatekeeper", "Front desk / gatekeeper",
                                                 "Front desk / gatekeeper"]


def test_same_website_same_town_is_a_duplicate_not_a_chain():
    leads = [lead(place_id="a", name="Green Leaf", phone="01925 111111", website="https://greenleaf.co.uk", review_count=40),
             lead(place_id="b", name="Green Leaf Gardens", phone="07700 900000", website="https://www.greenleaf.co.uk/", review_count=3)]
    qualify.mark_exclusions(leads)
    assert [l.exclude_reason for l in leads] == ["", "Duplicate listing of Green Leaf"]


def test_same_site_duplicates_keep_the_most_reviewed_and_compare_towns_written_any_way():
    leads = [lead(place_id="a", name="Green Leaf Gardens", phone="07700 900000", website="https://www.greenleaf.co.uk/",
                  review_count=3, town="St. Helens"),
             lead(place_id="b", name="Green Leaf", phone="01744 111111", website="https://greenleaf.co.uk/contact",
                  review_count=40, town="Saint Helens"),
             lead(place_id="c", name="Green Leaf Lawns", phone="07700 900001", website="http://greenleaf.co.uk",
                  town="", search_town="st helens")]
    qualify.mark_exclusions(leads)
    assert [l.exclude_reason for l in leads] == ["Duplicate listing of Green Leaf", "", "Duplicate listing of Green Leaf"]


def test_one_site_in_two_towns_makes_every_listing_a_branch():
    leads = [lead(place_id="a", name="Lawn Pro", phone="01925 000001", website="https://lawnpro.co.uk", town="Warrington"),
             lead(place_id="b", name="Lawn Pro Lymm", phone="01925 000002", website="https://lawnpro.co.uk/lymm",
                  town="Warrington", review_count=90),
             lead(place_id="c", name="Lawn Pro Wigan", phone="01942 000003", website="https://www.lawnpro.co.uk/wigan",
                  town="Wigan")]
    qualify.mark_exclusions(leads)
    assert [l.exclude_reason for l in leads] == ["Multiple branches (chain)"] * 3


def test_a_closed_listing_never_makes_the_open_one_a_duplicate_or_a_branch():
    # a sole trader who moved or relisted: the old listing is closed, the open one is the business and is pitched
    leads = [lead(place_id="a", name="Green Leaf", phone="01925 111111", website="https://greenleaf.co.uk",
                  review_count=60, town="Lymm", business_status="CLOSED_PERMANENTLY"),
             lead(place_id="b", name="Green Leaf Gardens", phone="07700 900000", website="https://greenleaf.co.uk",
                  review_count=3, town="Warrington"),
             lead(place_id="c", name="Tidy Gardens", phone="0113 496 0001", website="https://tidygardens.co.uk",
                  review_count=30, business_status="CLOSED_TEMPORARILY"),
             lead(place_id="d", name="Tidy Gardens Leeds", phone="0113 496 0002", website="https://www.tidygardens.co.uk/",
                  review_count=1),
             lead(place_id="e", name="Magic Roofing", phone="07907 928806", website="https://magicroofing.co.uk",
                  review_count=50, business_status="CLOSED_PERMANENTLY"),
             lead(place_id="f", name="Magic Roofing Ltd", phone="+44 7907 928806", review_count=2)]
    qualify.mark_exclusions(leads)
    assert [l.exclude_reason for l in leads] == ["Closed", "", "Closed", "", "Closed", ""]


def test_earlier_leads_catch_duplicates_and_branches():
    known = [{"place_id": "old1", "name": "Magic Roofing", "phone": "07907 928806", "website": "", "town": "Warrington"},
             {"place_id": "old2", "name": "Lawn Pro Warrington", "phone": "01925 000001",
              "website": "https://lawnpro.co.uk/warrington", "town": "Warrington"},
             {"place_id": "same", "name": "Same Biz", "phone": "01925 000002", "website": "", "town": "Wigan"}]
    leads = [lead(place_id="n1", name="Magic Roofing Ltd", phone="+44 7907 928806", town="Wigan"),
             lead(place_id="n2", name="Lawn Pro Wigan", phone="01942 000003", website="https://www.lawnpro.co.uk/wigan", town="Wigan"),
             lead(place_id="same", name="Same Biz", phone="01925 000002", town="Wigan")]
    assert qualify.mark_exclusions(leads, known) == ["old2"]
    assert [l.exclude_reason for l in leads] == ["Duplicate listing of Magic Roofing", "Multiple branches (chain)", ""]


def test_an_earlier_lead_is_always_the_listing_kept():
    # the saved lead may already be researched or emailed: the new listing is the duplicate, never the other way round,
    # even when the new one has more reviews or the earlier one has no website
    known = [{"place_id": "old", "name": "Green Leaf", "phone": "01925 111111", "website": "https://greenleaf.co.uk",
              "town": "Warrington"},
             {"place_id": "old3", "name": "Tidy Gardens", "phone": "0113 496 0001", "website": None, "town": "Leeds"}]
    leads = [lead(place_id="n1", name="Green Leaf Gardens", phone="07700 900000", website="https://www.greenleaf.co.uk/",
                  review_count=200, town="Warrington"),
             lead(place_id="n2", name="Green Leaf Ltd", phone="+44 1925 111111", website="https://greenleaf.co.uk/contact",
                  review_count=90, town="Warrington"),
             lead(place_id="n3", name="Tidy Gardens Leeds", phone="01134960001", website="https://tidygardens.co.uk",
                  review_count=80)]
    assert qualify.mark_exclusions(leads, known) == []
    assert [l.exclude_reason for l in leads] == ["Duplicate listing of Green Leaf", "Duplicate listing of Green Leaf",
                                                 "Duplicate listing of Tidy Gardens"]


def test_earlier_leads_only_count_against_open_listings_of_this_run():
    # saved rows can have NULL phone/website/town; a saved lead with no town can't prove a second town; a closed listing
    # is only "Closed" and never makes the earlier lead a branch; earlier leads matching only each other are left alone
    known = [{"place_id": "old1", "name": "Green Leaf", "phone": None, "website": "https://greenleaf.co.uk", "town": None},
             {"place_id": "old2", "name": "Lawn Pro", "phone": "01925 000001", "website": "https://lawnpro.co.uk", "town": "Warrington"},
             {"place_id": "old3", "name": "Lawn Pro Wigan", "phone": "01942 000003", "website": "https://lawnpro.co.uk/wigan", "town": "Wigan"},
             {"place_id": "old4", "name": "Smith Roofing", "phone": "0113 496 0009", "website": "https://smithroofs.co.uk", "town": "Leeds"}]
    leads = [lead(place_id="n1", name="Green Leaf Gardens", phone="01942 111111", website="https://greenleaf.co.uk", town="Wigan"),
             lead(place_id="n2", name="Smith Roofing", phone="0161 000 0000", website="https://smithroofs.co.uk", town="Bolton",
                  business_status="CLOSED_PERMANENTLY"),
             lead(place_id="n3", name="Bolton Roofs", town="Bolton")]
    assert qualify.mark_exclusions(leads, known) == []
    assert [l.exclude_reason for l in leads] == ["Duplicate listing of Green Leaf", "Closed", ""]


def test_a_saved_lead_found_again_is_kept_over_a_new_listing_of_it():
    # Runcorn found 24 businesses already saved from Widnes/Warrington: a saved lead found again may already be
    # researched or emailed, so a new second listing of it is the duplicate, even with a website or more reviews. Between
    # two saved leads, the one this search didn't find again is kept (only this search's listings can be updated).
    known = [{"place_id": "old", "name": "Green Leaf", "phone": "01925 111111", "website": "", "town": "Warrington"},
             {"place_id": "tidy", "name": "Tidy Gardens", "phone": "0113 496 0001", "website": "https://tidygardens.co.uk",
              "town": "Leeds"},
             {"place_id": "a", "name": "Magic Roofing", "phone": "07907 928806", "website": "", "town": "Wigan"},
             {"place_id": "b", "name": "Magic Roofing Wigan", "phone": "07907 928806", "website": "", "town": "Wigan"}]
    leads = [lead(place_id="old", name="Green Leaf", phone="01925 111111", review_count=2, town="Warrington"),
             lead(place_id="n1", name="Green Leaf Gardens", phone="+44 1925 111111", website="https://greenleaf.co.uk",
                  review_count=90, town="Warrington"),
             lead(place_id="tidy", name="Tidy Gardens", phone="0113 496 0001", website="https://tidygardens.co.uk",
                  review_count=1),
             lead(place_id="n2", name="Tidy Gardens Leeds", phone="0113 496 0002", website="https://www.tidygardens.co.uk/",
                  review_count=50),
             lead(place_id="b", name="Magic Roofing Wigan", phone="07907 928806", website="https://magicroofing.co.uk",
                  review_count=80, town="Wigan")]
    assert qualify.mark_exclusions(leads, known) == []
    assert [l.exclude_reason for l in leads] == ["", "Duplicate listing of Green Leaf", "", "Duplicate listing of Tidy Gardens",
                                                 "Duplicate listing of Magic Roofing"]


def test_a_franchise_stays_a_chain_in_every_later_search():
    # day 1 Warrington, day 2 Widnes (both branches set aside), day 3 Runcorn: the branches already set aside still show
    # the website is a chain's, or every other town's branch would be researched and emailed (and a re-search of
    # Warrington would make its branch pitchable again)
    d1 = FakeD1()

    def search(*found):
        leads = list(found)
        chain_ids = qualify.mark_exclusions(leads, [*store.D1.known_leads(d1), *store.D1.known_branches(d1)])
        for l in leads:
            d1.query(store.UPSERT, store.row(l, "2026-10-24T06:00:00Z", "j"))
        store.D1.exclude_chains(d1, chain_ids)
        return chain_ids, [l.exclude_reason for l in leads]

    def branch(pid, town, phone):
        return lead(place_id=pid, name=f"Greenthumb {town}", phone=phone, town=town,
                    website=f"https://www.greenthumb.co.uk/{town.lower()}")

    assert search(branch("w", "Warrington", "01925 000001")) == ([], [""])
    assert search(branch("i", "Widnes", "0151 000 0002")) == (["w"], ["Multiple branches (chain)"])
    assert search(branch("r", "Runcorn", "01928 000003"), lead(place_id="n", name="Runcorn Lawns", phone="01928 000004",
                                                             town="Runcorn")) == ([], ["Multiple branches (chain)", ""])
    assert search(branch("w", "Warrington", "01925 000001")) == ([], ["Multiple branches (chain)"])
    rows = d1.query("SELECT place_id, excluded, exclude_reason FROM leads ORDER BY place_id")["result"][0]["results"]
    assert [(r["place_id"], r["excluded"]) for r in rows] == [("i", 1), ("n", 0), ("r", 1), ("w", 1)]
    # another listing of a branch already set aside (same phone, no website) is set aside too
    assert search(lead(place_id="w2", name="Greenthumb Lawn Care", phone="+44 1925 000001", town="Warrington")) == (
        [], ["Duplicate listing of Greenthumb Warrington"])


def test_a_branch_set_aside_only_ever_shows_a_second_town():
    # the old rule called two listings of one sole trader in one town a chain: a third listing in that town is not made
    # a duplicate of a lead that is itself set aside (searching that town again fixes the pair, task 4); a listing in
    # another town is still a branch
    known = [{"place_id": "a", "name": "Green Leaf", "phone": "01925 111111", "website": "https://greenleaf.co.uk",
              "town": "Warrington", "excluded": 1},
             {"place_id": "b", "name": "Green Leaf Gardens", "phone": "01925 111112", "website": "https://greenleaf.co.uk/",
              "town": "Warrington", "excluded": 1}]
    same_town = [lead(place_id="n", name="Green Leaf Landscapes", phone="01925 111113", town="Warrington",
                      website="https://www.greenleaf.co.uk/landscapes")]
    assert qualify.mark_exclusions(same_town, known) == [] and same_town[0].exclude_reason == ""
    elsewhere = [lead(place_id="m", name="Green Leaf Lymm", phone="01925 111114", town="Lymm",
                      website="https://greenleaf.co.uk/lymm")]
    assert qualify.mark_exclusions(elsewhere, known) == [] and elsewhere[0].exclude_reason == "Multiple branches (chain)"


def test_a_page_on_a_shared_platform_never_makes_a_chain_or_a_duplicate():
    # a Houzz or Autotrader page or a WhatsApp link as the "website": unrelated businesses share that host, so across
    # every saved lead it would call sole traders a chain (and set the saved one aside too)
    known = [{"place_id": "old", "name": "Green Leaf Gardens", "phone": "01925 111111", "town": "Warrington",
              "website": "https://www.houzz.co.uk/professionals/landscape-contractors/green-leaf-pfvwgb-pf~1"}]
    leads = [lead(place_id="n1", name="Tidy Lawns", phone="0151 000 0001", town="Widnes",
                  website="https://www.houzz.co.uk/professionals/landscape-contractors/tidy-lawns-pfvwgb-pf~2"),
             lead(place_id="n2", name="Smith Gardens", phone="01925 000002", town="Warrington",
                  website="https://houzz.co.uk/professionals/garden-designers/smith-pf~3"),
             lead(place_id="n3", name="Wigan Car Sales", phone="01942 000003", town="Wigan",
                  website="https://www.autotrader.co.uk/dealers/wigan-car-sales-1"),
             lead(place_id="n4", name="Leigh Motors", phone="01942 000004", town="Leigh",
                  website="https://www.autotrader.co.uk/dealers/leigh-motors-2"),
             lead(place_id="n5", name="Bolton Lawns", phone="01204 000005", town="Bolton", website="https://wa.me/447700900005"),
             lead(place_id="n6", name="Bury Gardens", phone="0161 000 0006", town="Bury", website="https://wa.me/447700900006")]
    assert qualify.mark_exclusions(leads, known) == []
    assert [l.exclude_reason for l in leads] == [""] * 6
    # the same phone is still the same business
    again = [lead(place_id="n7", name="Green Leaf", phone="+44 1925 111111", town="Warrington",
                  website="https://www.houzz.co.uk/professionals/landscape-contractors/green-leaf-pfvwgb-pf~1")]
    assert qualify.mark_exclusions(again, known) == []
    assert again[0].exclude_reason == "Duplicate listing of Green Leaf Gardens"


def test_a_lead_already_in_outreach_is_never_set_aside_as_a_branch_or_a_duplicate():
    # Part A: a lead with a prospects row keeps going. exclude_chains spared it only when this search didn't find it
    # again; found again, this run marked it and its own save wrote excluded = 1 over it, mid-conversation
    known = [{"place_id": "A", "name": "Lawn Pro", "phone": "01925 000001", "website": "https://lawnpro.co.uk",
              "town": "Warrington"}]
    leads = [lead(place_id="A", name="Lawn Pro", phone="01925 000001", website="https://lawnpro.co.uk", town="Warrington"),
             lead(place_id="C", name="Lawn Pro Wigan", phone="01942 000003", website="https://lawnpro.co.uk/wigan",
                  town="Wigan")]
    assert qualify.mark_exclusions(leads, known, in_pipeline={"A"}) == []
    assert [l.exclude_reason for l in leads] == ["", "Multiple branches (chain)"] and not leads[0].excluded
    # not found again: still one of the chain's listings, but it isn't handed back to be set aside
    leads = [lead(place_id="C", name="Lawn Pro Wigan", phone="01942 000003", website="https://lawnpro.co.uk/wigan",
                  town="Wigan")]
    assert qualify.mark_exclusions(leads, known, in_pipeline={"A"}) == []
    assert leads[0].exclude_reason == "Multiple branches (chain)"
    assert qualify.mark_exclusions([lead(place_id="C", name="Lawn Pro Wigan", website="https://lawnpro.co.uk/wigan",
                                         town="Wigan")], known) == ["A"]
    # saved A (in outreach) and saved B share a phone; this search finds only A: A is the listing kept
    known = [{"place_id": "A", "name": "Magic Roofing Wigan", "phone": "07907 928806", "website": "", "town": "Wigan"},
             {"place_id": "B", "name": "Magic Roofing", "phone": "07907 928806", "website": "", "town": "Wigan"}]
    leads = [lead(place_id="A", name="Magic Roofing Wigan", phone="07907 928806", town="Wigan")]
    assert qualify.mark_exclusions(leads, known, in_pipeline={"A"}) == []
    assert leads[0].exclude_reason == "" and not leads[0].excluded
    # a new listing of it (or one found after a reset, with no saved row) is the duplicate, never the other way round
    leads = [lead(place_id="N", name="Magic Roofing Ltd", phone="+44 7907 928806", website="https://magicroofing.co.uk",
                  review_count=90, town="Wigan"),
             lead(place_id="A", name="Magic Roofing Wigan", phone="07907 928806", town="Wigan")]
    assert qualify.mark_exclusions(leads, (), in_pipeline={"A"}) == []
    assert [l.exclude_reason for l in leads] == ["Duplicate listing of Magic Roofing Wigan", ""]
    # without a prospects row the old rule stands: the saved listing this search didn't find again is kept
    leads = [lead(place_id="A", name="Magic Roofing Wigan", phone="07907 928806", town="Wigan")]
    qualify.mark_exclusions(leads, known)
    assert leads[0].exclude_reason == "Duplicate listing of Magic Roofing"
    # Closed and a national brand's name are still set aside: they're true whoever we've talked to
    leads = [lead(place_id="A", name="Kwik Fit Wigan", phone="07907 928806", town="Wigan")]
    qualify.mark_exclusions(leads, known, in_pipeline={"A"})
    assert leads[0].exclude_reason == "Chain / national brand"


def test_a_lead_in_outreach_found_again_stays_pitchable_in_the_database():
    # end to end through the saved rows: known leads → mark_exclusions → save (the UPSERT writes excluded) → exclude_chains
    def found_again(saved, run):
        d1 = FakeD1()
        store.D1.save(d1, saved, "old-job")
        d1.query("INSERT INTO prospects (place_id, stage, stage_at, email, first_sent_at, created_at, updated_at) "
                 "VALUES ('A', 'emailed', 'x', 'a@x.co.uk', '2026-10-20T08:00:00Z', 'x', 'x')")
        assert store.D1.in_pipeline(d1) == {"A"}
        chain_ids = qualify.mark_exclusions(run, [*store.D1.known_leads(d1), *store.D1.known_branches(d1)],
                                            in_pipeline=store.D1.in_pipeline(d1))
        store.D1.save(d1, run, "new-job")
        store.D1.exclude_chains(d1, chain_ids)
        rows = d1.query("SELECT place_id, excluded, exclude_reason FROM leads ORDER BY place_id")["result"][0]["results"]
        return {r["place_id"]: (r["excluded"], r["exclude_reason"]) for r in rows}

    lawn = dict(name="Lawn Pro", phone="01925 000001", website="https://lawnpro.co.uk", town="Warrington",
                search_town="Warrington")
    assert found_again([lead(place_id="A", **lawn)], [
        lead(place_id="A", **lawn),
        lead(place_id="C", name="Lawn Pro Wigan", phone="01942 000003", website="https://lawnpro.co.uk/wigan", town="Wigan")
    ]) == {"A": (0, ""), "C": (1, "Multiple branches (chain)")}
    magic = dict(phone="07907 928806", town="Wigan")
    assert found_again([lead(place_id="A", name="Magic Roofing Wigan", **magic),
                        lead(place_id="B", name="Magic Roofing", search_town="Leigh", **magic)],
                       [lead(place_id="A", name="Magic Roofing Wigan", **magic)])["A"] == (0, "")


def test_in_pipeline_is_every_lead_with_a_prospects_row():
    d1 = FakeD1()
    assert store.D1.in_pipeline(d1) == set()
    for pid in ("a", "b"):
        d1.query("INSERT INTO prospects (place_id, stage, stage_at, email, created_at, updated_at) "
                 "VALUES (?, 'emailed', 'x', 'p@x.co.uk', 'x', 'x')", [pid])
    assert store.D1.in_pipeline(d1) == {"a", "b"}


def test_score_parts_and_caps():
    assert scoring.score([]).as_dict() == {"total": 0, "website": 0, "seo": 0, "maps": 0}
    assert scoring.score(["no_website"]).as_dict() == {"total": 75, "website": 45, "seo": 30, "maps": 0}
    assert scoring.score(["no_website", "maps_invisible", "reviews_behind"]).total == 100
    assert scoring.score(["not_checked"]).total == 0
    everything = [k for k, (p, _) in scoring.RULES.items() if p in ("website", "seo")]
    s = scoring.score(everything)
    assert (s.website, s.seo) == (45, 30)  # each part is capped at its maximum
    assert scoring.score(["not_mobile", "not_secure"]).website == 22


def test_maps_findings_ladder():
    assert scoring.maps_findings(21, 0, 0, "Leeds")[0][0] == "maps_invisible"
    assert scoring.maps_findings(15, 0, 30, "Leeds")[0][0] == "maps_rarely_found"
    assert scoring.maps_findings(7.4, 0, 100, "Leeds")[0] == ("maps_no_top3", "Never in Google Maps' top 3 across Leeds (average position #7)")
    assert scoring.maps_findings(4, 20, 100, "Leeds")[0][0] == "maps_some_top3"
    assert scoring.maps_findings(2, 80, 100, "Leeds") == []


def test_reviews_behind_only_when_clearly_behind():
    assert scoring.reviews_finding(12, [130, 90, 40])[0][0] == "reviews_behind"
    assert scoring.reviews_finding(60, [130, 90, 40]) == []
    assert scoring.reviews_finding(1, [5, 3, 2]) == []  # leaders with few reviews: nobody is "behind"


def test_score_uses_the_map_scan():
    scan = maprank.Scan("roofer", "Leeds", 3, 1000, 0, 0, [], [
        maprank.BusinessResult("top", review_count=120, avg_rank=1.5, top3_pct=90, found_pct=100),
        maprank.BusinessResult("mid", review_count=80, avg_rank=6, top3_pct=0, found_pct=100),
    ])
    leads = [lead(place_id="top", review_count=120, findings=["no_website"], issues=["No website"]),
             lead(place_id="mid", review_count=10), lead(place_id="ghost", review_count=0)]
    qualify.score(leads, scan)
    top, mid, ghost = leads
    assert top.quality_score == 75 and top.score_parts["maps"] == 0
    assert mid.findings == ["maps_no_top3", "reviews_behind"] and mid.score_parts["maps"] == 15
    assert ghost.findings[0] == "maps_invisible" and ghost.map_rank["found_pct"] == 0


def test_maps_findings_only_in_the_leads_own_town():
    scan = maprank.Scan("landscaper", "Runcorn", 3, 1000, 0, 0, [], [maprank.BusinessResult("top", review_count=90, avg_rank=1, top3_pct=100, found_pct=100)])
    away, home = lead(place_id="w", town="Warrington"), lead(place_id="r", town="Runcorn")
    qualify.score([away, home], scan)
    assert away.findings == [] and away.map_rank["home"] is False and away.score_parts["maps"] == 0
    assert home.findings[0] == "maps_invisible" and home.map_rank["home"] is True


def test_home_town_written_any_way_and_no_maps_numbers_from_another_town():
    # outreach ({top3}), the call script and the Leads drawer read map_rank's numbers as "of {their town}": a lead from
    # a neighbouring town must carry none of the searched town's, only where the scan was and that it wasn't theirs
    scan = maprank.Scan("landscaper", "St. Helens", 3, 1000, 0, 0, [], [maprank.BusinessResult("top", review_count=90, avg_rank=1, top3_pct=100, found_pct=100)])
    home, blank = lead(place_id="h", town="Saint Helens"), lead(place_id="b", town="", search_town="St Helens")
    away = lead(place_id="w", town="Warrington", review_count=1, findings=["no_website"], issues=["No website"])
    qualify.score([home, blank, away], scan)
    assert home.map_rank["home"] is True and home.findings == ["maps_invisible", "reviews_behind"]
    assert home.issues[0] == "Not in Google Maps' top 20 anywhere we checked across St. Helens"
    assert home.map_rank["scan_town"] == "St. Helens" and home.map_rank["leader_reviews"] == [90]
    assert blank.map_rank["home"] is True and blank.findings[0] == "maps_invisible"  # no postal town: the searched one
    assert away.map_rank == {"scan_town": "St. Helens", "home": False}
    assert away.findings == ["no_website"] and away.issues == ["No website"] and away.quality_score == 75


# ---------------------------------------------------------------- map rank


def test_grid_is_square_centred_and_north_up():
    pts = maprank.grid_points(53.39, -2.59, 3, 1000)
    assert len(pts) == 9 and pts[4].lat == 53.39 and pts[4].lng == -2.59
    assert pts[0].lat > pts[4].lat > pts[8].lat and pts[0].lng < pts[4].lng < pts[8].lng
    assert abs((pts[0].lat - pts[4].lat) * 111_320 - 1000) < 1


def test_summarise_ranks_average_and_shares():
    pts = [maprank.Point(0, 0, 0, 0, ["a", "b", "c", "d"]), maprank.Point(0, 1, 0, 0, ["b", "a"]),
           maprank.Point(1, 0, 0, 0, ["c"]), maprank.Point(1, 1, 0, 0, [])]
    res = {b.place_id: b for b in maprank.summarise(pts)}
    assert res["a"].ranks == [1, 2, None, None] and res["a"].avg_rank == 11.25
    assert res["a"].top3_pct == 50 and res["a"].found_pct == 50
    assert res["d"].top3_pct == 0 and res["d"].found_pct == 25


@respx.mock
def test_map_rank_scan_uses_free_ids_only_searches():
    def handler(request):
        body = json.loads(request.content)
        if body["textQuery"] == "Leeds, UK":
            return httpx.Response(200, json={"places": [{"location": {"latitude": 53.8, "longitude": -1.55}}]})
        lat = body["locationBias"]["circle"]["center"]["latitude"]
        order = ["north", "south"] if lat > 53.8 else ["south", "north"]
        return httpx.Response(200, json={"places": [{"id": i} for i in order]})

    route = respx.post(places.SEARCH_URL).mock(side_effect=handler)
    respx.get(url__regex=r".*/places/south").mock(return_value=httpx.Response(200, json={
        "displayName": {"text": "South Roofing"}, "rating": 4.6, "userRatingCount": 30}))
    scan = maprank.run("KEY", "roofer", "Leeds", grid=3, spacing_m=1000, known={"north": {"name": "North Roofs", "review_count": 9}})
    grid_calls = [c for c in route.calls if json.loads(c.request.content)["textQuery"] == "roofer"]
    assert len(grid_calls) == 9
    assert all(c.request.headers["X-Goog-FieldMask"] == "places.id" for c in grid_calls)
    names = {b.place_id: b.name for b in scan.businesses}
    assert names == {"north": "North Roofs", "south": "South Roofing"}
    north = next(b for b in scan.businesses if b.place_id == "north")
    assert north.ranks[:3] == [1, 1, 1] and north.ranks[-3:] == [2, 2, 2]


@respx.mock
def test_paid_google_calls_are_counted_per_sku():
    usage.reset()
    test_map_rank_scan_uses_free_ids_only_searches()
    assert dict(usage.calls) == {"text_search_pro": 1, "text_search_ids": 9, "place_details_enterprise": 1}


@respx.mock
def test_companies_house_match_gets_director_first_name():
    respx.get(f"{companies_house.BASE}/search/companies").mock(
        return_value=httpx.Response(200, json={"items": [
            {"title": "SMITH ROOFING (LEEDS) LIMITED", "company_number": "999", "company_status": "dissolved"},
            {"title": "SMITH ROOFING LTD", "company_number": "123", "company_status": "active", "company_type": "ltd",
             "address_snippet": "1 High St, Leeds, LS1 1AA"},
        ]})
    )
    respx.get(f"{companies_house.BASE}/company/123/officers").mock(
        return_value=httpx.Response(200, json={"items": [
            {"name": "SMITH, Jane", "officer_role": "secretary"},
            {"name": "SMITH, David John", "officer_role": "director", "resigned_on": "2020-01-01"},
            {"name": "SMITH, Peter Alan", "officer_role": "director"},
        ]})
    )
    l = lead(postcode="LS1 1AA")
    with httpx.Client() as c:
        companies_house.find_director(c, "KEY", l)
    assert (l.company_number, l.director_first_name, l.director_name) == ("123", "Peter", "Peter Smith")
    # outreach eligibility needs the company type and a match backed by the address
    assert l.audit["company"]["type"] == "ltd" and l.audit["company"]["match_basis"] == "postcode"


def test_company_match_basis_ranks_postcode_over_town_over_name():
    l = lead(postcode="LS1 1AA")
    l.town = "Leeds"
    assert companies_house.match_basis(l, "1 High St, Leeds, LS1 1AA") == "postcode"
    assert companies_house.match_basis(l, "2 Mill Rd, Leeds, LS9 9ZZ") == "town"
    assert companies_house.match_basis(l, "3 Park Ln, York, YO1 1AA") == "name"


@respx.mock
def test_companies_house_weak_match_is_ignored():
    respx.get(f"{companies_house.BASE}/search/companies").mock(
        return_value=httpx.Response(200, json={"items": [
            {"title": "TOTALLY DIFFERENT HOLDINGS LTD", "company_number": "5", "company_status": "active"}]})
    )
    l = lead()
    with httpx.Client() as c:
        companies_house.find_director(c, "KEY", l)
    assert l.company_number == "" and l.director_first_name == ""


# ---------------------------------------------------------------- store


def test_sqlite_upsert_keeps_outreach_state(tmp_path):
    db = tmp_path / "leads.db"
    store.save_sqlite(db, [lead(issues=["No website"], quality_score=100)], job_id="job1")
    with sqlite3.connect(db) as c:
        c.execute("UPDATE leads SET status = 'contacted', warmth_score = 30, first_seen_at = '2026-01-01T00:00:00Z'")
    store.save_sqlite(db, [lead(name="Smith Roofing Ltd", quality_score=40)])
    with sqlite3.connect(db) as c:
        row = c.execute("SELECT name, quality_score, status, warmth_score, first_seen_at, last_job_id FROM leads").fetchone()
    assert row == ("Smith Roofing Ltd", 40, "contacted", 30, "2026-01-01T00:00:00Z", None)


def test_rescrape_from_another_town_keeps_home_maps(tmp_path):
    db = tmp_path / "leads.db"
    first = lead(town="Warrington", findings=["no_website", "maps_invisible"],
                 issues=["No website", "Not in Google Maps' top 20 anywhere we checked across Warrington"],
                 map_rank={"avg_rank": 21.0, "top3_pct": 0, "found_pct": 0, "scan_town": "Warrington", "home": True},
                 quality_score=97, score_parts={"total": 97, "website": 45, "seo": 30, "maps": 22})
    store.save_sqlite(db, [first])
    again = lead(town="Warrington", findings=["no_website"], issues=["No website"],
                 map_rank={"avg_rank": 21.0, "top3_pct": 0, "found_pct": 0, "scan_town": "Runcorn", "home": False},
                 quality_score=75, score_parts={"total": 75, "website": 45, "seo": 30, "maps": 0})
    store.save_sqlite(db, [again])
    assert again.quality_score == 97 and "maps_invisible" in again.findings
    assert again.map_rank["scan_town"] == "Warrington" and again.issues[-1].endswith("across Warrington")


def test_kept_home_maps_get_todays_review_count_and_a_research_hint(tmp_path):
    db = tmp_path / "leads.db"
    site = dict(place_id="g", town="Warrington", website="https://greenleaf.co.uk")
    home_scan = {"avg_rank": 8.0, "top3_pct": 0, "found_pct": 100, "scan_town": "Warrington", "home": True,
                 "leader_reviews": [120, 90, 40]}
    first = lead(**site, review_count=5, findings=["not_mobile", "not_secure", "title_no_town", "no_schema", "maps_no_top3", "reviews_behind"],
                 issues=["Not mobile-friendly", "Not secure", "Town not in the page title", "No business info for Google",
                         "Never in Google Maps' top 3 across Warrington (average position #8)",
                         "Fewer Google reviews than the top 3 nearby (5 vs about 90)"],
                 map_rank=home_scan, quality_score=46)
    store.save_sqlite(db, [first])
    again = lead(**site, review_count=7, findings=["not_mobile", "not_secure", "title_no_town", "no_schema"],
                 issues=["Not mobile-friendly", "Not secure", "Town not in the page title", "No business info for Google"],
                 map_rank={"scan_town": "Widnes", "home": False}, quality_score=31,
                 score_parts={"total": 31, "website": 22, "seo": 9, "maps": 0}, audit={"ai_needs": []})
    store.save_sqlite(db, [again])
    assert again.map_rank == home_scan and again.findings[-2:] == ["maps_no_top3", "reviews_behind"]
    assert again.issues[-2:] == ["Never in Google Maps' top 3 across Warrington (average position #8)",
                                 "Fewer Google reviews than the top 3 nearby (7 vs about 90)"]  # today's count
    assert again.quality_score == 46 and again.score_parts == {"total": 46, "website": 22, "seo": 9, "maps": 15}
    assert again.audit["ai_needs"] == ["email", "owner", "review"]  # 46 is worth Claude's look; 31 wasn't
    with sqlite3.connect(db) as c:
        saved = c.execute("SELECT quality_score, issues, audit FROM leads").fetchone()
    assert saved[0] == 46 and json.loads(saved[1])[-1].startswith("Fewer Google reviews")
    assert json.loads(saved[2])["map_rank"]["scan_town"] == "Warrington"


def test_home_maps_are_only_kept_from_a_scan_of_the_leads_own_town(tmp_path):
    db = tmp_path / "leads.db"
    invisible = {"avg_rank": 21.0, "top3_pct": 0, "found_pct": 0, "scan_town": "Warrington", "home": True}
    store.save_sqlite(db, [
        lead(place_id="a", town="Warrington", findings=["no_website", "maps_invisible"], map_rank=invisible, quality_score=97),
        lead(place_id="b", town="Lymm", findings=["no_website"], map_rank={"scan_town": "Warrington", "home": False}, quality_score=75),
        lead(place_id="c", town="Widnes", findings=["no_website"], map_rank={"scan_town": "Runcorn", "home": False}, quality_score=75),
        lead(place_id="d", town="Warrington", findings=["no_website", "maps_invisible"], map_rank=invisible, quality_score=97),
    ])
    rescan = lead(place_id="a", town="Warrington", findings=["no_website", "maps_some_top3"],
                  map_rank={"avg_rank": 4.0, "top3_pct": 20, "found_pct": 100, "scan_town": "Warrington", "home": True},
                  quality_score=81, score_parts={"total": 81, "website": 45, "seo": 30, "maps": 6})
    village = lead(place_id="b", town="Lymm", findings=["no_website"], map_rank={"scan_town": "Runcorn", "home": False},
                   quality_score=75, score_parts={"total": 75, "website": 45, "seo": 30, "maps": 0})
    moved = lead(place_id="c", town="Runcorn", findings=["no_website"], map_rank={"scan_town": "Warrington", "home": False},
                 quality_score=75, score_parts={"total": 75, "website": 45, "seo": 30, "maps": 0})
    no_scan = lead(place_id="d", town="Warrington", findings=["no_website"], quality_score=75,
                   score_parts={"total": 75, "website": 45, "seo": 30, "maps": 0})
    store.save_sqlite(db, [rescan, village, moved, no_scan])
    assert rescan.quality_score == 81 and rescan.findings == ["no_website", "maps_some_top3"]  # today's scan of their town wins
    assert village.quality_score == 75 and village.map_rank == {"scan_town": "Runcorn", "home": False}  # never scanned at home
    assert moved.quality_score == 75 and moved.map_rank["scan_town"] == "Warrington"  # Runcorn's scan wasn't of their town then
    # the Map Rank scan failed this run (map_rank {}): the last scan of their own town still stands
    assert no_scan.quality_score == 97 and no_scan.map_rank == {**invisible, "home": True}
    assert no_scan.findings == ["no_website", "maps_invisible"]


def test_home_maps_kept_when_the_scan_fails_but_never_on_an_excluded_lead(tmp_path):
    db = tmp_path / "leads.db"
    invisible = {"avg_rank": 21.0, "top3_pct": 0, "found_pct": 0, "scan_town": "Warrington", "home": True}
    store.save_sqlite(db, [lead(place_id=p, town="Warrington", findings=["no_website", "maps_invisible"], map_rank=invisible,
                                quality_score=97) for p in ("away", "gone")])
    # a Runcorn run whose Map Rank scan failed: the Warrington lead is still one found from a neighbouring town
    away = lead(place_id="away", town="Warrington", search_town="Runcorn", findings=["no_website"], quality_score=75)
    gone = lead(place_id="gone", town="Warrington", search_town="Runcorn", excluded=True, exclude_reason="Closed")
    store.save_sqlite(db, [away, gone])
    assert away.quality_score == 97 and away.issues[-1] == "Not in Google Maps' top 20 anywhere we checked across Warrington"
    assert gone.quality_score == 0 and gone.findings == [] and gone.map_rank == {}  # excluded: never scored, nothing added


def test_bad_json_in_a_saved_row_never_stops_the_save(tmp_path):
    db = tmp_path / "leads.db"
    store.save_sqlite(db, [lead()])
    with sqlite3.connect(db) as c:
        c.execute("UPDATE leads SET audit = '{not json', emails = 'nope', socials = NULL")
    again = lead(findings=["no_website"], issues=["No website"], quality_score=75)
    store.save_sqlite(db, [again])
    assert again.quality_score == 75 and again.issues == ["No website"]


def test_a_scan_of_another_town_never_replaces_a_leads_own_town_map_rank():
    # lead_map_rank is each lead's Maps row (the drawer's heatmap link, the research queue's map_rank, the competitor in
    # emails): a Runcorn scan seeing Warrington businesses must not write Runcorn's numbers on them
    class DB(FakeD1, store.D1):  # the real D1 client's methods over the in-memory database
        pass

    d1 = DB()
    d1.save([lead(place_id="w", town="Warrington"), lead(place_id="v", town="", search_town="St. Helens"),
             lead(place_id="r", town="Runcorn")])
    def scan(town, top3):
        return maprank.Scan("landscaper", town, 3, 1000, 0, 0, [], [
            maprank.BusinessResult(p, review_count=5, avg_rank=4, top3_pct=top3, found_pct=100) for p in ("w", "v", "r", "rival")])
    for scan_id, town, top3 in (("warr", "Warrington", 10), ("sth", "Saint Helens", 20), ("run", "Runcorn", 30)):
        d1.create_scan(scan_id, "landscaper", town, 3, 1000, "scrape")
        d1.save_scan(scan_id, scan(town, top3))
    rows = d1.query("SELECT place_id, scan_id, town, top3_pct FROM lead_map_rank ORDER BY place_id")["result"][0]["results"]
    assert [(r["place_id"], r["scan_id"], r["top3_pct"]) for r in rows] == [
        ("r", "run", 30), ("rival", "run", 30), ("v", "sth", 20), ("w", "warr", 10)]
    seen = d1.query("SELECT COUNT(*) AS n FROM scan_businesses WHERE scan_id = 'run'")["result"][0]["results"][0]["n"]
    assert seen == 4  # the heatmap itself still shows everyone the scan saw


def test_d1_save_keeps_home_maps_too():
    d1 = FakeD1()
    first = lead(town="Warrington", findings=["no_website", "maps_invisible"],
                 issues=["No website", "Not in Google Maps' top 20 anywhere we checked across Warrington"],
                 map_rank={"avg_rank": 21.0, "top3_pct": 0, "found_pct": 0, "scan_town": "Warrington", "home": True}, quality_score=97)
    store.D1.save(d1, [first])
    again = lead(town="Warrington", findings=["no_website"], issues=["No website"],
                 map_rank={"scan_town": "Runcorn", "home": False}, quality_score=75)
    store.D1.save(d1, [again])
    saved = d1.query("SELECT quality_score, audit FROM leads")["result"][0]["results"][0]
    assert again.quality_score == 97 and saved["quality_score"] == 97
    assert json.loads(saved["audit"])["map_rank"]["scan_town"] == "Warrington"
    assert "ai_research" not in store.prior_sql(3)  # every saved row among the ids comes back, researched or not


def test_exclude_chains_spares_leads_already_in_the_pipeline():
    d1 = FakeD1()
    for pid in ("a", "b"):
        d1.query("INSERT INTO leads (place_id, name, trade, search_town, first_seen_at, updated_at) VALUES (?, 'X', 't', 'T', 'x', 'x')", [pid])
    d1.query("INSERT INTO prospects (place_id, stage, stage_at, email, created_at, updated_at) VALUES ('b', 'emailed', 'x', 'b@x.co.uk', 'x', 'x')")
    store.D1.exclude_chains(d1, ["a", "b"])
    rows = d1.query("SELECT place_id, excluded FROM leads ORDER BY place_id")["result"][0]["results"]
    assert [(r["place_id"], r["excluded"]) for r in rows] == [("a", 1), ("b", 0)]


def test_exclude_chains_chunks_under_the_parameter_limit():
    class Counting(FakeD1):
        def __init__(self):
            super().__init__()
            self.sent = []

        def query(self, sql, params=None):
            self.sent.append(len(params or []))
            return super().query(sql, params)

    d1 = Counting()
    ids = [f"p{i}" for i in range(150)]
    for pid in ids:
        d1.query("INSERT INTO leads (place_id, name, trade, search_town, first_seen_at, updated_at) VALUES (?, 'X', 't', 'T', 'x', 'x')", [pid])
    d1.sent.clear()
    store.D1.exclude_chains(d1, ids)
    assert d1.sent == [100, 50]
    rows = d1.query("SELECT excluded, exclude_reason FROM leads")["result"][0]["results"]
    assert len(rows) == 150 and all((r["excluded"], r["exclude_reason"]) == (1, "Multiple branches (chain)") for r in rows)
    d1.sent.clear()
    store.D1.exclude_chains(d1, [])
    assert d1.sent == []


def test_known_leads_are_the_saved_leads_still_pitchable():
    d1 = FakeD1()
    d1.query("INSERT INTO leads (place_id, name, trade, search_town, town, phone, website, excluded, first_seen_at, updated_at) "
             "VALUES ('a', 'A', 't', 'T', 'Wigan', '01942 000001', 'https://a.co.uk', 0, 'x', 'x'), "
             "('b', 'B', 't', 'T', 'Wigan', '01942 000002', '', 1, 'x', 'x')")
    assert store.D1.known_leads(d1) == [{"place_id": "a", "name": "A", "website": "https://a.co.uk",
                                         "phone": "01942 000001", "town": "Wigan"}]


def test_known_branches_are_the_saved_leads_set_aside_as_a_chains_branches():
    d1 = FakeD1()
    d1.query("INSERT INTO leads (place_id, name, trade, search_town, town, phone, website, excluded, exclude_reason, "
             "first_seen_at, updated_at) VALUES "
             "('a', 'A', 't', 'T', 'Wigan', '01942 000001', 'https://a.co.uk/wigan', 1, 'Multiple branches (chain)', 'x', 'x'), "
             "('b', 'B', 't', 'T', 'Wigan', '01942 000002', 'https://b.co.uk', 1, 'Front desk / gatekeeper', 'x', 'x'), "
             "('c', 'C', 't', 'T', 'Wigan', '01942 000003', 'https://c.co.uk', 0, '', 'x', 'x')")
    assert store.D1.known_branches(d1) == [{"place_id": "a", "name": "A", "website": "https://a.co.uk/wigan",
                                            "phone": "01942 000001", "town": "Wigan", "excluded": 1}]


def test_d1_schema_statements_are_clean():
    stmts = store.schema_statements()
    assert len(stmts) >= 52 and all("--" not in s for s in stmts)


@respx.mock
def test_d1_save_and_job_updates():
    d1 = store.D1("acc", "db", "tok")
    route = respx.post(d1.url).mock(return_value=httpx.Response(200, json={"success": True, "result": []}))
    d1.save([lead(quality_score=100, issues=["No website"])], job_id="job9")
    d1.set_job("job9", "done", found=1, pitchable=1)
    sqls = [json.loads(c.request.content) for c in route.calls]
    assert sqls[-2]["sql"].startswith("INSERT INTO leads") and "job9" in sqls[-2]["params"]
    assert sqls[-1]["params"][:3] == ["done", 1, 1] and sqls[-1]["params"][-1] == "job9"
    assert route.calls[0].request.headers["Authorization"] == "Bearer tok"


@respx.mock
def test_d1_ensure_schema_writes_the_control_rooms_schema_version():
    # The Control Room's db() migrates whenever schema:version differs from SCHEMA_VERSION in schema.js, so once the
    # lead manager has applied the schema it says so, with the very same value: the Control Room then runs nothing.
    js = (store.Path(store.__file__).resolve().parents[2] / "control-room" / "functions" / "_lib" / "schema.js").read_text()
    version = re.search(r'export const SCHEMA_VERSION = "([0-9a-f]{12})";', js).group(1)
    assert store.schema_version() == version
    d1 = store.D1("acc", "db", "tok")
    route = respx.post(d1.url).mock(return_value=httpx.Response(200, json={"success": True, "result": []}))
    d1.ensure_schema()
    bodies = [json.loads(c.request.content) for c in route.calls]
    assert [b["sql"] for b in bodies[:-1]] == store.schema_statements()
    assert bodies[-1]["sql"].startswith("INSERT INTO settings (key, value) VALUES ('schema:version', ?)")
    assert "ON CONFLICT" in bodies[-1]["sql"] and bodies[-1]["params"] == [version]


@respx.mock
def test_d1_scan_save_chunks_under_the_parameter_limit():
    d1 = store.D1("acc", "db", "tok")
    route = respx.post(d1.url).mock(return_value=httpx.Response(200, json={"success": True, "result": []}))
    points = [maprank.Point(r, c, 53.0, -2.0, ["a", "b"]) for r in range(5) for c in range(5)]
    scan = maprank.Scan("roofer", "Leeds", 5, 1600, 53.0, -2.0, points, maprank.summarise(points))
    d1.save_scan("s1", scan)
    bodies = [json.loads(c.request.content) for c in route.calls]
    assert all(len(b["params"]) <= store.D1_MAX_PARAMS for b in bodies)
    inserted = sum(b["sql"].count("(?") for b in bodies if "INTO scan_points" in b["sql"])
    assert inserted == 25 and bodies[-1]["sql"].startswith("UPDATE scans SET status = 'done'")


def test_progress_reporter_throttles_but_always_reports_stage_changes_and_finish():
    calls = []

    class FakeD1:
        def set_progress(self, *a):
            calls.append(a)

    from aetos_leads.__main__ import progress_reporter
    report = progress_reporter(FakeD1(), "j1")
    report("scouting", 0, 60)
    for i in range(1, 30):
        report("checking", i, 60)  # same stage, rapid: throttled
    report("checking", 60, 60)  # finished stage: always sent
    report("maps", 0, 25)
    assert [c[1] for c in calls] == ["scouting", "checking", "checking", "maps"]


# ---------------------------------------------------------------- end to end


@respx.mock
def test_pipeline_end_to_end(tmp_path):
    def search(request):
        body = json.loads(request.content)
        if body["textQuery"] == "Leeds, UK":
            return httpx.Response(200, json={"places": [{"location": {"latitude": 53.8, "longitude": -1.55}}]})
        if "locationBias" in body:  # map grid: Good Roofs always top, Old Roofs 2nd, the rest invisible
            return httpx.Response(200, json={"places": [{"id": "p1"}, {"id": "p3"}]})
        return httpx.Response(200, json={"places": [
            place(1, displayName={"text": "Good Roofs"}, websiteUri="https://acmeroofing.co.uk/",
                  addressComponents=[{"longText": "Leeds", "types": ["postal_town"]}, {"longText": "LS1 1AA", "types": ["postal_code"]}],
                  nationalPhoneNumber="0113 496 0001"),
            place(2, displayName={"text": "No Site Roofing"}),
            place(3, displayName={"text": "Old Roofs"}, websiteUri="http://smithroofing.co.uk/"),
            place(4, displayName={"text": "Gone Roofing"}, businessStatus="CLOSED_PERMANENTLY"),
        ]})

    respx.post(places.SEARCH_URL).mock(side_effect=search)
    respx.get("https://acmeroofing.co.uk/").mock(return_value=httpx.Response(200, text=GOOD))
    respx.get("https://acmeroofing.co.uk/sitemap.xml").mock(return_value=httpx.Response(200, text=SITEMAP_35))
    respx.get("http://smithroofing.co.uk/").mock(return_value=httpx.Response(200, text=OLD))
    respx.get("http://smithroofing.co.uk/contact-us.html").mock(return_value=httpx.Response(404))
    no_sitemaps()
    stages = []
    result = pipeline.run("roofer", "Leeds", "KEY", progress=lambda st, d, t: stages.append(st))
    leads = result.leads
    assert [l.name for l in leads] == ["No Site Roofing", "Old Roofs", "Good Roofs", "Gone Roofing"]
    no_site, old, good, gone = leads
    assert no_site.quality_score == 97 and no_site.score_parts == {"total": 97, "website": 45, "seo": 30, "maps": 22}
    assert old.email == "info@smithroofing.co.uk" and old.map_rank["top3_pct"] == 100
    assert good.quality_score == 0 and good.findings == []  # perfect site, top of Maps everywhere: not a lead
    assert gone.excluded and result.scan.grid == 5
    assert stages[0] == "scouting" and "checking" in stages and stages[-1] == "maps"

    paths = pipeline.write_outputs(tmp_path, "roofer", "Leeds", leads)
    lead_rows = paths["leads"].read_text().splitlines()
    assert len(lead_rows) == 4 and lead_rows[1].startswith("97,45,30,22,21.0,0,No Site Roofing")
    assert "No Site Roofing" in paths["call_list"].read_text()
    assert "Gone Roofing" in paths["excluded"].read_text()
    assert "3 worth pitching" in pipeline.summary(leads) and "1 with no working website" in pipeline.summary(leads)


def test_pipeline_compares_with_earlier_leads(monkeypatch):
    found = [lead(place_id="n1", name="Magic Roofing Ltd", phone="+44 7907 928806", town="Wigan"),
             lead(place_id="n2", name="Lawn Pro Wigan", phone="01942 000003", website="https://www.lawnpro.co.uk/wigan", town="Wigan"),
             lead(place_id="n3", name="Wigan Roofs", phone="01942 000004", town="Wigan")]
    known = [{"place_id": "old1", "name": "Magic Roofing", "phone": "07907 928806", "website": "", "town": "Warrington"},
             {"place_id": "old2", "name": "Lawn Pro", "phone": "01925 000001", "website": "https://lawnpro.co.uk", "town": "Warrington"}]
    monkeypatch.setattr(places, "search", lambda *a, **k: [*found])
    result = pipeline.run("roofer", "Wigan", "KEY", map_scan=False, known=known)
    assert result.chain_ids == ["old2"]
    assert {l.place_id: l.exclude_reason for l in result.leads} == {
        "n1": "Duplicate listing of Magic Roofing", "n2": "Multiple branches (chain)", "n3": ""}
    assert found[2].findings == ["no_website"] and found[1].findings == []  # only the pitchable one is checked
    monkeypatch.setattr(places, "search", lambda *a, **k: [lead(place_id="n4", name="Ince Roofs", town="Wigan")])
    assert pipeline.run("roofer", "Wigan", "KEY", map_scan=False).chain_ids == []
    # two saved listings of one business found again: the one already in outreach is kept (and audited)
    again = [{"place_id": p, "name": n, "phone": "07907 928806", "website": "", "town": "Wigan"}
             for p, n in (("b", "Magic Roofing"), ("a", "Magic Roofing Wigan"))]
    monkeypatch.setattr(places, "search", lambda *a, **k: [lead(place_id=r["place_id"], name=r["name"],
                                                                phone=r["phone"], town="Wigan") for r in again])
    reasons = {l.place_id: (l.exclude_reason, l.findings) for l in
               pipeline.run("roofer", "Wigan", "KEY", map_scan=False, known=again, in_pipeline={"a"}).leads}
    assert reasons == {"a": ("", ["no_website"]), "b": ("Duplicate listing of Magic Roofing Wigan", [])}


# ---------------------------------------------------------------- command line


def test_scrape_checks_earlier_leads_and_excludes_new_branches_after_saving(monkeypatch, tmp_path):
    import argparse

    from aetos_leads import __main__ as cli

    known = [{"place_id": "old2", "name": "Lawn Pro", "phone": "01925 000001", "website": "https://lawnpro.co.uk",
              "town": "Warrington"}]
    branches = [{"place_id": "old3", "name": "Lawn Pro Leigh", "phone": "01942 000009", "website": "https://lawnpro.co.uk/leigh",
                 "town": "Leigh", "excluded": 1}]
    calls = []

    class D1Spy:
        def known_leads(self):
            calls.append("known_leads")
            return known

        def known_branches(self):
            calls.append("known_branches")
            return branches

        def in_pipeline(self):
            calls.append("in_pipeline")
            return {"old9"}

        def save(self, leads, job_id=""):
            calls.append("save")

        def exclude_chains(self, place_ids):
            calls.append(("exclude_chains", place_ids))

        def set_job(self, *a, **k):
            calls.append("set_job")

        def set_progress(self, *a):
            pass

    seen = []
    protected = []

    def fake_run(*a, known=(), in_pipeline=None, **k):
        seen.append(known)
        protected.append(in_pipeline)
        branch = lead(place_id="n2", name="Lawn Pro Wigan", excluded=True, exclude_reason="Multiple branches (chain)")
        return pipeline.Result([branch], None, chain_ids=["old2"])

    monkeypatch.setattr(pipeline, "run", fake_run)
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    args = argparse.Namespace(trade="roofer", town="Wigan", max=60, out=str(tmp_path), db="", job_id="j1")
    assert cli.scrape(args, D1Spy(), "KEY", lambda message: 2) == 0
    assert seen == [known + branches] and protected == [{"old9"}]  # leads in outreach are never set aside
    assert calls == ["known_leads", "known_branches", "in_pipeline", "save", ("exclude_chains", ["old2"]), "set_job"]
    assert cli.scrape(args, None, "KEY", lambda message: 2) == 0  # no database: nothing earlier to compare with
    assert seen[-1] == [] and protected[-1] == set()


@respx.mock
def test_cli_reports_clear_failures_to_the_control_room(monkeypatch, tmp_path):
    from aetos_leads.__main__ import main

    for k, v in {"CLOUDFLARE_ACCOUNT_ID": "a", "D1_DATABASE_ID": "d", "CLOUDFLARE_API_TOKEN": "t"}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("GOOGLE_PLACES_API_KEY", raising=False)
    d1 = respx.post(store.D1("a", "d", "t").url).mock(return_value=httpx.Response(200, json={"success": True, "result": []}))
    assert main(["--trade", "roofer", "--town", "Leeds", "--job-id", "j1", "--out", str(tmp_path)]) == 2
    last = json.loads(d1.calls[-1].request.content)
    assert last["params"][0] == "failed" and "GOOGLE_PLACES_API_KEY" in last["params"][3]

    monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "bad")
    respx.post(places.SEARCH_URL).mock(return_value=httpx.Response(403, text="API not enabled"))
    assert main(["--trade", "roofer", "--town", "Leeds", "--job-id", "j1", "--out", str(tmp_path)]) == 2
    sent = [json.loads(c.request.content) for c in d1.calls]
    failed = [q for q in sent if q["sql"].startswith("UPDATE jobs") and q["params"][0] == "failed"][-1]
    assert "Google refused the search" in failed["params"][3]
    # the refused call is still recorded for the Money page: Google may bill it
    assert "INTO api_usage" in sent[-1]["sql"] and sent[-1]["params"][:4] == ["scrape", "j1", "text_search_enterprise_atmosphere", 1]


# ---------------------------------------------------------------- fixes from the first real run (Warrington roofers)


@respx.mock
def test_firewall_block_is_not_reported_as_broken():
    respx.get("https://guarded.co.uk/").mock(return_value=httpx.Response(403))
    l = run_audit(lead(website="https://guarded.co.uk/"))
    assert l.issues == [audit.NOT_CHECKED] and l.audit["status"] == "blocked"
    assert scoring.score(l.findings).total == 0


@respx.mock
def test_bot_check_pages_are_not_checked():
    sg = '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F"></head></html>'
    respx.get("https://sg.co.uk/").mock(return_value=httpx.Response(202, text=sg))
    respx.get("https://cf.co.uk/").mock(return_value=httpx.Response(200, text="<title>Just a moment...</title>"))
    respx.get("https://odd.co.uk/").mock(return_value=httpx.Response(415))
    for site in ("https://sg.co.uk/", "https://cf.co.uk/", "https://odd.co.uk/"):
        l = run_audit(lead(website=site))
        assert l.findings == ["not_checked"] and l.issues == [audit.NOT_CHECKED] and l.audit["status"] == "blocked", site


@respx.mock
def test_real_errors_are_still_broken():
    respx.get("https://gone.co.uk/").mock(return_value=httpx.Response(404))
    respx.get("https://origin.co.uk/").mock(return_value=httpx.Response(521))
    assert run_audit(lead(website="https://gone.co.uk/")).issues == ["Website is broken (error 404)"]
    assert run_audit(lead(website="https://origin.co.uk/")).issues == ["Website is broken (error 521)"]


@respx.mock
def test_browser_only_page_is_not_checked():
    shell = '<html><head><title>Smith</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
    respx.get("https://spa.co.uk/").mock(return_value=httpx.Response(200, text=shell))
    l = run_audit(lead(website="https://spa.co.uk/"))
    assert l.findings == ["not_checked"] and l.issues == [audit.NOT_READABLE] and l.audit["status"] == "browser_only"
    assert not audit.browser_only(OLD) and not audit.browser_only(GOOD)


@respx.mock
def test_every_other_error_and_an_empty_answer_are_not_checked():
    # a 202 whatever it says (AWS WAF's challenge), other 4xx/5xx, a challenge served with a "broken" code, and answers
    # with no page at all (204, a redirect with nowhere to go, a blank body): no claims and no sitemap fetch
    blocked = {
        "https://aws.co.uk/": httpx.Response(202, text="<html><head><title>Acme</title></head><body>Please wait</body></html>"),
        "https://conflict.co.uk/": httpx.Response(409, text="<title>Conflict</title>"),
        "https://legal.co.uk/": httpx.Response(451),
        "https://nope.co.uk/": httpx.Response(501),
        "https://cfgone.co.uk/": httpx.Response(404, text="<title>Attention Required! | Cloudflare</title>"),
        "https://wait.co.uk/": httpx.Response(200, text="<html><head><TITLE> One moment, please... </TITLE></head></html>"),
        "https://blank.co.uk/": httpx.Response(204),
        "https://loop.co.uk/": httpx.Response(302),
        "https://empty.co.uk/": httpx.Response(200, text="  \n "),
    }
    for site, resp in blocked.items():
        respx.get(site).mock(return_value=resp)
        l = run_audit(lead(website=site))
        assert l.findings == ["not_checked"] and l.issues == [audit.NOT_CHECKED] and l.audit["status"] == "blocked", site
        assert l.audit["http_status"] == resp.status_code and scoring.score(l.findings).total == 0, site
    for code in sorted(audit.BROKEN_STATUSES):
        respx.get(f"https://e{code}.co.uk/").mock(return_value=httpx.Response(code))
        l = run_audit(lead(website=f"https://e{code}.co.uk/"))
        assert l.issues == [f"Website is broken (error {code})"] and l.audit == {"status": "broken", "http_status": code}


def test_browser_only_shapes():
    cra = ('<html><head><title>React App</title><script defer src="/static/js/main.js"></script></head>'
           "<body><noscript>You need to enable JavaScript to run this app.</noscript><div id=\"root\"></div></body></html>")
    vue = '<html><body><div id="app"><div class="spinner"></div></div><script src="/js/app.js"></script></body></html>'
    nuxt = '<html><body><div id="__nuxt"></div><script type="module" src="/_nuxt/entry.js"></script></body></html>'
    for shell in (cra, vue, nuxt):
        assert audit.browser_only(shell), shell
    text = "Smith Landscaping: patios, driveways, fencing and garden design across Warrington. " * 4
    ssr = f'<html><body><div id="__next"><h1>Smith</h1><p>{text}</p></div><script src="/_next/main.js"></script></body></html>'
    gtm = ('<html><head><script src="https://www.googletagmanager.com/gtm.js"></script></head><body><noscript><iframe '
           f'src="https://www.googletagmanager.com/ns.html"></iframe></noscript><div id="app"><p>{text}</p></div></body></html>')
    no_script = '<html><body><div id="root"></div><p>Call 01925 000000</p></body></html>'
    for page in (ssr, gtm, no_script):
        assert not audit.browser_only(page), page[:60]


@respx.mock
def test_meta_refresh_stub_is_not_checked():
    # old sites often forward the listed address with a meta refresh: a browser follows it, the checker doesn't, so
    # auditing the stub would claim "no title, no form, phone not on site…" about a site we never saw
    stub = '<html><head><meta content="0; URL=\'/home.html\'" http-equiv="Refresh"></head><body>Redirecting</body></html>'
    respx.get("https://meta.co.uk/").mock(return_value=httpx.Response(200, text=stub))
    l = run_audit(lead(website="https://meta.co.uk/"))
    assert l.findings == ["not_checked"] and l.issues == [audit.NOT_READABLE] and l.audit["status"] == "browser_only"
    assert audit.redirect_stub(stub)
    # a page that only refreshes itself, or a real page with plenty on it, is still audited
    assert not audit.redirect_stub(GOOD.replace("<head>", '<head><meta http-equiv="refresh" content="300">'))
    text = "Smith Landscaping: patios, driveways, fencing and garden design across Warrington. " * 4
    assert not audit.redirect_stub(f'<html><head><meta http-equiv="refresh" content="5;url=/news"></head><p>{text}</p></html>')
    assert not audit.redirect_stub(OLD) and not audit.redirect_stub(GOOD)


@respx.mock
def test_slow_site_gets_a_retry_before_being_called_down():
    respx.get("https://sleepy.co.uk/").mock(side_effect=[httpx.ReadTimeout("slow"), httpx.Response(200, text=GOOD)])
    no_sitemaps()
    l = run_audit(lead(website="https://sleepy.co.uk/"))
    assert l.audit["status"] == "ok"


@respx.mock
def test_broken_certificate_is_its_own_issue():
    respx.get("https://badcert.co.uk/").mock(side_effect=httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] expired"))
    l = run_audit(lead(website="https://badcert.co.uk/"))
    assert "security warning" in l.issues[0] and scoring.score(l.findings).total == 70


def test_template_placeholder_emails_are_ignored():
    html = "example@mysite.com info@yoursite.com test@roofing.co.uk john@realroofing.co.uk"
    assert audit.extract_emails(html, "realroofing.co.uk") == ["john@realroofing.co.uk"]


def test_copyright_2023_is_not_outdated_in_2026():
    found, _ = audit.analyse_html(OLD.replace("2016", "2023"), "https://x.co.uk/", "Leeds", 1, today=date(2026, 10, 3))
    assert "outdated" not in keys(found)
    found, _ = audit.analyse_html(OLD.replace("2016", "2022"), "https://x.co.uk/", "Leeds", 1, today=date(2026, 10, 3))
    assert "outdated" in keys(found)


def test_same_phone_twice_is_one_business_and_keeps_the_listing_with_a_website():
    leads = [
        lead(place_id="a", name="Magic Roofing Warrington Ltd", phone="07907 928806"),
        lead(place_id="b", name="Magic Roofing", phone="+44 7907 928806", website="https://magicroofing.co.uk"),
        lead(place_id="c", name="Other Roofing", phone="07000 000000"),
    ]
    qualify.mark_exclusions(leads)
    assert [l.exclude_reason for l in leads] == ["Duplicate listing of Magic Roofing", "", ""]


def test_duplicate_listings_sharing_a_website_are_not_called_a_chain():
    leads = [
        lead(place_id="a", name="Magic Roofing", phone="07907 928806", website="https://magicroofing.co.uk"),
        lead(place_id="b", name="Magic Roofing Ltd", phone="07907928806", website="https://www.magicroofing.co.uk/"),
    ]
    qualify.mark_exclusions(leads)
    assert sorted(l.exclude_reason for l in leads) == ["", "Duplicate listing of Magic Roofing"]
