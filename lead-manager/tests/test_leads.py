import asyncio
import json
import sqlite3
from datetime import date

import httpx
import respx

from conftest import FIXTURES
from goldbar_leads import audit, companies_house, pipeline, places, qualify, store
from goldbar_leads.models import Lead

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
        "nationalPhoneNumber": "0113 496 0000",
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


@respx.mock
def test_places_paginates_ranks_and_includes_service_area_businesses():
    route = respx.post(places.SEARCH_URL).mock(
        side_effect=[
            httpx.Response(200, json={"places": [place(1), place(2)], "nextPageToken": "t2"}),
            httpx.Response(200, json={"places": [place(3, websiteUri="https://r3.co.uk")]}),
        ]
    )
    with httpx.Client() as c:
        leads = places.search(c, "KEY", "roofer", "Leeds")
    assert [l.rank for l in leads] == [1, 2, 3]
    assert leads[0].town == "Leeds" and leads[0].postcode == "LS1 1AA"
    assert leads[2].website == "https://r3.co.uk"
    first, second = (json.loads(call.request.content) for call in route.calls)
    assert first["includePureServiceAreaBusinesses"] is True
    assert first["textQuery"] == "roofer in Leeds"
    assert second["pageToken"] == "t2"
    assert route.calls[0].request.headers["X-Goog-Api-Key"] == "KEY"


@respx.mock
def test_places_respects_max_results():
    respx.post(places.SEARCH_URL).mock(
        return_value=httpx.Response(200, json={"places": [place(i) for i in range(20)], "nextPageToken": "more"})
    )
    with httpx.Client() as c:
        assert len(places.search(c, "KEY", "roofer", "Leeds", max_results=25)) == 25


# ---------------------------------------------------------------- audit


def test_old_site_gets_every_relevant_issue():
    issues, facts = audit.analyse_html(OLD, "http://smithroofing.co.uk/", "Leeds", 4.2, today=date(2026, 10, 3))
    text = " | ".join(issues)
    for expected in ["Not secure", "Not mobile-friendly", "Slow to load", "Looks outdated (copyright 2016)",
                     "Town (Leeds) not in the page title", "No Google description", "No main heading",
                     "No contact or quote form", "tap-to-call", "No chat"]:
        assert expected in text, expected
    assert facts["copyright_year"] == 2016


def test_good_site_is_clean():
    issues, facts = audit.analyse_html(GOOD, "https://acmeroofing.co.uk/", "Leeds", 0.8, today=date(2026, 10, 3))
    assert issues == []
    assert facts["chat_widget"] == "tidio" and facts["contact_form"] is True


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
    assert run_audit(lead()).issues == ["No website"]
    assert "facebook.com" in run_audit(lead(website="https://facebook.com/smith")).issues[0]


@respx.mock
def test_audit_broken_and_unreachable_sites():
    respx.get("https://broken.co.uk/").mock(return_value=httpx.Response(500))
    respx.get("https://down.co.uk/").mock(side_effect=httpx.ConnectError("nope"))
    assert run_audit(lead(website="https://broken.co.uk/")).issues == ["Website is broken (error 500)"]
    assert run_audit(lead(website="https://down.co.uk/")).issues == ["Website is down or won't load"]


@respx.mock
def test_audit_finds_email_on_contact_page_and_socials():
    no_email_home = OLD.replace("info@smithroofing.co.uk", "")
    respx.get("http://smithroofing.co.uk/").mock(return_value=httpx.Response(200, text=no_email_home))
    respx.get("http://smithroofing.co.uk/contact-us.html").mock(
        return_value=httpx.Response(200, text="Write to dave@smithroofing.co.uk")
    )
    l = run_audit(lead(website="http://smithroofing.co.uk/"))
    assert l.email == "dave@smithroofing.co.uk"
    assert l.socials == {"facebook": "https://www.facebook.com/smithroofing"}
    assert l.audit["status"] == "ok"


# ---------------------------------------------------------------- qualify


def test_exclusions():
    leads = [
        lead(place_id="a", name="Closed Roofing", business_status="CLOSED_PERMANENTLY"),
        lead(place_id="b", name="Kwik Fit Leeds"),
        lead(place_id="c", name="Branch One", website="https://multi.co.uk"),
        lead(place_id="d", name="Branch Two", website="https://www.multi.co.uk/leeds"),
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


def test_quality_score():
    assert qualify.quality_score(["No website"]) == 100
    assert qualify.quality_score([]) == 0
    assert qualify.quality_score(["Not mobile-friendly (no mobile layout)", "Looks outdated (copyright 2016)"]) == 45
    many = ["Not mobile-friendly", '"Not secure"', "Looks outdated", "Built on a DIY builder (Wix)", "Slow to load",
            "No contact or quote form", "No page title", "No chat", "No main heading", "No Google description"]
    assert qualify.quality_score(many) == 100


# ---------------------------------------------------------------- companies house


@respx.mock
def test_companies_house_match_gets_director_first_name():
    respx.get(f"{companies_house.BASE}/search/companies").mock(
        return_value=httpx.Response(200, json={"items": [
            {"title": "SMITH ROOFING (LEEDS) LIMITED", "company_number": "999", "company_status": "dissolved"},
            {"title": "SMITH ROOFING LTD", "company_number": "123", "company_status": "active",
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
    store.save_sqlite(db, [lead(issues=["No website"], quality_score=100)])
    with sqlite3.connect(db) as c:
        c.execute("UPDATE leads SET status = 'contacted', warmth_score = 30, first_seen_at = '2026-01-01T00:00:00Z'")
    store.save_sqlite(db, [lead(name="Smith Roofing Ltd", quality_score=40)])
    with sqlite3.connect(db) as c:
        row = c.execute("SELECT name, quality_score, status, warmth_score, first_seen_at FROM leads").fetchone()
    assert row == ("Smith Roofing Ltd", 40, "contacted", 30, "2026-01-01T00:00:00Z")


def test_d1_schema_statements_are_clean():
    stmts = store.schema_statements()
    assert len(stmts) == 3 and all("--" not in s for s in stmts)


# ---------------------------------------------------------------- end to end


@respx.mock
def test_pipeline_end_to_end(tmp_path):
    respx.post(places.SEARCH_URL).mock(return_value=httpx.Response(200, json={"places": [
        place(1, displayName={"text": "Good Roofs"}, websiteUri="https://acmeroofing.co.uk/"),
        place(2, displayName={"text": "No Site Roofing"}),
        place(3, displayName={"text": "Old Roofs"}, websiteUri="http://smithroofing.co.uk/"),
        place(4, displayName={"text": "Gone Roofing"}, businessStatus="CLOSED_PERMANENTLY"),
    ]}))
    respx.get("https://acmeroofing.co.uk/").mock(return_value=httpx.Response(200, text=GOOD))
    respx.get("http://smithroofing.co.uk/").mock(return_value=httpx.Response(200, text=OLD))
    leads = pipeline.run("roofer", "Leeds", "KEY")
    assert [l.name for l in leads] == ["No Site Roofing", "Old Roofs", "Good Roofs", "Gone Roofing"]
    assert leads[1].email == "info@smithroofing.co.uk"
    assert leads[-1].excluded

    paths = pipeline.write_outputs(tmp_path, "roofer", "Leeds", leads)
    lead_rows = paths["leads"].read_text().splitlines()
    assert len(lead_rows) == 4 and lead_rows[1].startswith("100,No Site Roofing")
    assert "No Site Roofing" in paths["call_list"].read_text()
    assert "Gone Roofing" in paths["excluded"].read_text()
    assert "3 worth pitching" in pipeline.summary(leads)
