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
    store.save_sqlite(db, [lead(issues=["No website"], quality_score=100)], job_id="job1")
    with sqlite3.connect(db) as c:
        c.execute("UPDATE leads SET status = 'contacted', warmth_score = 30, first_seen_at = '2026-01-01T00:00:00Z'")
    store.save_sqlite(db, [lead(name="Smith Roofing Ltd", quality_score=40)])
    with sqlite3.connect(db) as c:
        row = c.execute("SELECT name, quality_score, status, warmth_score, first_seen_at, last_job_id FROM leads").fetchone()
    assert row == ("Smith Roofing Ltd", 40, "contacted", 30, "2026-01-01T00:00:00Z", None)


def test_d1_schema_statements_are_clean():
    stmts = store.schema_statements()
    assert len(stmts) == 5 and all("--" not in s for s in stmts)


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


# ---------------------------------------------------------------- command line


@respx.mock
def test_cli_reports_clear_failures_to_the_control_room(monkeypatch, tmp_path):
    from goldbar_leads.__main__ import main

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
    last = json.loads(d1.calls[-1].request.content)
    assert "Google refused the search" in last["params"][3]


# ---------------------------------------------------------------- fixes from the first real run (Warrington roofers)


@respx.mock
def test_firewall_block_is_not_reported_as_broken():
    respx.get("https://guarded.co.uk/").mock(return_value=httpx.Response(403))
    l = run_audit(lead(website="https://guarded.co.uk/"))
    assert l.issues == [audit.NOT_CHECKED] and l.audit["status"] == "blocked"
    assert qualify.quality_score(l.issues) == 0


@respx.mock
def test_slow_site_gets_a_retry_before_being_called_down():
    respx.get("https://sleepy.co.uk/").mock(side_effect=[httpx.ReadTimeout("slow"), httpx.Response(200, text=GOOD)])
    l = run_audit(lead(website="https://sleepy.co.uk/"))
    assert l.audit["status"] == "ok"


@respx.mock
def test_broken_certificate_is_its_own_issue():
    respx.get("https://badcert.co.uk/").mock(side_effect=httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] expired"))
    l = run_audit(lead(website="https://badcert.co.uk/"))
    assert "security warning" in l.issues[0] and qualify.quality_score(l.issues) == 60


def test_template_placeholder_emails_are_ignored():
    html = "example@mysite.com info@yoursite.com test@roofing.co.uk john@realroofing.co.uk"
    assert audit.extract_emails(html, "realroofing.co.uk") == ["john@realroofing.co.uk"]


def test_copyright_2023_is_not_outdated_in_2026():
    issues, _ = audit.analyse_html(OLD.replace("2016", "2023"), "https://x.co.uk/", "Leeds", 1, today=date(2026, 10, 3))
    assert not any("outdated" in i for i in issues)
    issues, _ = audit.analyse_html(OLD.replace("2016", "2022"), "https://x.co.uk/", "Leeds", 1, today=date(2026, 10, 3))
    assert any("outdated" in i for i in issues)


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
