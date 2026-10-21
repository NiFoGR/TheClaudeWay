import json

from aetos_leads import research, store
from aetos_leads.models import Lead


def lead(**kw) -> Lead:
    base = dict(place_id="p1", name="Smith Roofing", trade="roofer", search_town="Leeds", rank=1)
    return Lead(**{**base, **kw})


def test_only_what_automation_missed_goes_to_claude():
    done = lead(website="https://smith.co.uk", email="dave@smith.co.uk", emails=["dave@smith.co.uk"], quality_score=60,
                director_first_name="Dave", director_name="Dave Smith", audit={"email_source": "website", "owner_source": "website", "owner_confident": True})
    assert research.needs(done) == ["review"]  # found everything for free; Claude only judges the site
    bare = lead(quality_score=80, findings=["no_website"], audit={})
    assert research.needs(bare) == ["email", "owner", "website"]
    assert research.needs(lead(quality_score=20, audit={})) == []          # decent already: not worth tokens
    assert research.needs(lead(quality_score=90, excluded=True)) == []      # chains etc.
    blocked = lead(website="https://x.co.uk", quality_score=10, findings=["not_checked"], email="info@x.co.uk",
                   emails=["info@x.co.uk"], director_first_name="Al", audit={"email_source": "website", "owner_source": "website", "owner_confident": True})
    assert research.needs(blocked) == ["review"]  # our checker was blocked: Claude looks instead


def test_big_team_and_unclear_best_email_flagged():
    emails = ["enquiries@eddiestobart.com", "jack.quayle@eddiestobart.com", "qamar.zamir@eddiestobart.com", "sean.french@eddiestobart.com"]
    l = lead(website="https://eddiestobart.com", email=emails[0], emails=emails, quality_score=50, review_count=900,
             audit={"email_source": "website", "owner_source": "website", "owner_confident": True}, director_first_name="Jack")
    assert research.needs(l)[:2] == ["size", "best"]


def test_finalise_puts_the_owners_email_first():
    l = lead(website="https://smith.co.uk", email="info@smith.co.uk", emails=["info@smith.co.uk", "dave@smith.co.uk"],
             director_first_name="Dave", director_name="Dave Smith", quality_score=50, audit={"email_source": "website", "owner_source": "website", "owner_confident": True})
    research.finalise(l)
    assert l.email == "dave@smith.co.uk"
    assert l.audit["ai_needs"] == ["review"]


def test_rescrape_keeps_claudes_work(tmp_path):
    db = tmp_path / "leads.db"
    first = lead(quality_score=70, findings=["no_website"], issues=["No website", "Not on Google Maps' top 3"],
                 score_parts={"total": 70, "website": 45, "seo": 13, "maps": 12}, audit={"ai_needs": ["email"]})
    store.save_sqlite(db, [first])
    import sqlite3
    with sqlite3.connect(db) as c:
        audit = json.loads(c.execute("SELECT audit FROM leads").fetchone()[0])
        audit.update(email_source="ai", owner_source="AI research", ai_needs=[],
                     ai_research={"done_at": "x", "website_score": 30, "wrong_findings": ["Not on Google Maps' top 3"]})
        c.execute("UPDATE leads SET email = 'dave@gmail.com', emails = '[\"dave@gmail.com\"]', director_first_name = 'Dave', "
                  "director_name = 'Dave Smith', audit = ?", [json.dumps(audit)])
    again = lead(quality_score=70, findings=["no_website"], issues=["No website", "Not on Google Maps' top 3"],
                 score_parts={"total": 70, "website": 45, "seo": 13, "maps": 12}, audit={"ai_needs": ["email", "owner"]})
    store.save_sqlite(db, [again])
    assert again.email == "dave@gmail.com" and again.director_name == "Dave Smith"
    assert again.audit["ai_needs"] == [] and again.audit["ai_research"]["website_score"] == 30
    assert again.quality_score == 55 and again.issues == ["No website"]
