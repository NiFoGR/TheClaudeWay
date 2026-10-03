import asyncio
import json
import sqlite3
from datetime import date

import httpx
import respx

from conftest import FIXTURES
from goldbar_leads import audit, companies_house, maprank, pipeline, places, qualify, scoring, store, usage
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


def test_trade_words_match_their_variants_and_synonyms():
    assert audit.mentions("Roofing Contractors Warrington", audit.trade_terms("roofer"))
    assert audit.mentions("Boiler repairs & installs", audit.trade_terms("heating engineer"))
    assert audit.mentions("Smith's Garage - MOT and servicing", audit.trade_terms("mechanic"))
    assert not audit.mentions("Welcome to Smith & Co", audit.trade_terms("plumber"))


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
    assert len(stmts) == 17 and all("--" not in s for s in stmts)


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

    from goldbar_leads.__main__ import progress_reporter
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
    sent = [json.loads(c.request.content) for c in d1.calls]
    failed = [q for q in sent if q["sql"].startswith("UPDATE jobs") and q["params"][0] == "failed"][-1]
    assert "Google refused the search" in failed["params"][3]
    # the refused call is still recorded for the Money page: Google may bill it
    assert "INTO api_usage" in sent[-1]["sql"] and sent[-1]["params"][:4] == ["scrape", "j1", "text_search_enterprise", 1]


# ---------------------------------------------------------------- fixes from the first real run (Warrington roofers)


@respx.mock
def test_firewall_block_is_not_reported_as_broken():
    respx.get("https://guarded.co.uk/").mock(return_value=httpx.Response(403))
    l = run_audit(lead(website="https://guarded.co.uk/"))
    assert l.issues == [audit.NOT_CHECKED] and l.audit["status"] == "blocked"
    assert scoring.score(l.findings).total == 0


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
