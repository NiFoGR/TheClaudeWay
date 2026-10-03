"""What Claude still needs to do for a lead, after the free automated checks (the 80/20 split).

The scraper does everything it can for free. Claude (a Routine on the owner's subscription, fired once when a
Find-leads run finishes) only gets leads worth pitching, and only the jobs the automation couldn't do:

  size     looks like a big company, not owner-operated (3+ named staff emails, or 400+ reviews): check, exclude if so
  email    no email, or only a guessed one: find a real one
  best     several addresses and none is clearly the decision maker's: pick the one that reaches the owner/director
  owner    no owner's name, or only a weak guess (business name, Companies House): find who runs it
  website  Google Maps has no website (or only a Facebook page): find their real one, if any
  review   they have a website: rate it as an expert would, how much we can help, and correct false alarms

Leads below MIN_SCORE (their site and Maps are already decent) are skipped: not worth the tokens.
Claude's earlier research is carried over when a town is scraped again, so it's never paid for twice.
"""

from aetos_leads import contacts, scoring
from aetos_leads.audit import host_of, is_real_website
from aetos_leads.models import Lead

MIN_SCORE = 35          # below this, they don't need us much; Claude doesn't look
BIG_REVIEW_COUNT = 400  # a sole trader rarely has this many
WEAK_OWNER = {"", "business name", "Companies House"}
NO_SITE = {"no_website", "profile_only"}


def needs(lead: Lead) -> list[str]:
    if lead.excluded or lead.audit.get("ai_research"):
        return []
    worth = lead.quality_score >= MIN_SCORE or "not_checked" in lead.findings
    if not worth:
        return []
    host = host_of(lead.website or "")
    todo = []
    if contacts.staff_count(lead.emails, host) >= 3 or lead.review_count >= BIG_REVIEW_COUNT:
        todo.append("size")
    if not lead.email or lead.audit.get("email_source") == "guessed":
        todo.append("email")
    elif len([e for e in lead.emails if contacts.is_own(e, host)]) >= 2 and not owner_email(lead):
        todo.append("best")
    if not lead.director_first_name or lead.audit.get("owner_source", "") in WEAK_OWNER:
        todo.append("owner")
    if not lead.website or not is_real_website(lead.website) or NO_SITE & set(lead.findings):
        todo.append("website")
    elif not {"site_down", "site_broken"} & set(lead.findings):
        todo.append("review")
    return todo


def owner_email(lead: Lead) -> bool:
    """Is the chosen email already the owner's or a decision maker's?"""
    first = lead.email.split("@")[0].split(".")[0]
    return (bool(lead.director_first_name) and first == lead.director_first_name.lower()) or first in contacts.DECISION_ROLES


def finalise(lead: Lead) -> None:
    """Once the owner is known: put the decision maker's address first, and note what Claude should do."""
    if lead.emails and lead.audit.get("email_source") != "guessed":
        last = lead.director_name.split()[-1] if len(lead.director_name.split()) > 1 else ""
        lead.emails = contacts.rank_emails(lead.emails, host_of(lead.website or ""), lead.director_first_name, last)
        lead.email = lead.emails[0]
    lead.audit["ai_needs"] = needs(lead)


def carry_over(lead: Lead, prev: dict) -> None:
    """Keep Claude's earlier research when the same business is scraped again. prev = the saved row
    (email, emails, socials, director_first_name, director_name, audit already parsed from JSON)."""
    audit = prev.get("audit") or {}
    r = audit.get("ai_research")
    if not r:
        return
    lead.audit["ai_research"] = r
    lead.audit["ai_needs"] = []
    if audit.get("email_source") == "ai" or audit.get("email_choice") == "ai":
        lead.emails = [*prev.get("emails", []), *[e for e in lead.emails if e not in prev.get("emails", [])]]
        lead.email = prev.get("email") or lead.email
        for k in ("email_source", "email_choice"):
            if audit.get(k):
                lead.audit[k] = audit[k]
    if audit.get("owner_source") == "AI research":
        lead.director_first_name, lead.director_name = prev.get("director_first_name", ""), prev.get("director_name", "")
        lead.audit["owner_source"] = "AI research"
    lead.socials = {**lead.socials, **(r.get("socials") or {})}
    wrong = set(r.get("wrong_findings") or [])
    lead.issues = [i for i in lead.issues if i not in wrong]
    if isinstance(r.get("website_score"), int):
        apply_website_score(lead, r["website_score"])
    if r.get("too_big"):
        lead.excluded, lead.exclude_reason = True, f"Too big for us (Claude: {r.get('too_big_reason') or 'not owner-operated'})"


def apply_website_score(lead: Lead, points: int) -> None:
    parts = dict(lead.score_parts or {})
    parts["website"] = max(0, min(scoring.PILLAR_MAX["website"], points))
    parts["website_by"] = "claude"
    parts["total"] = min(100, parts["website"] + parts.get("seo", 0) + parts.get("maps", 0))
    lead.score_parts, lead.quality_score = parts, parts["total"]
