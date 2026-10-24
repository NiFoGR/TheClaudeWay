"""The daily autopilot (no AI, free): pick the next town to search, and write the SITREP the owner reads each day.

Territory lives in the Control Room's settings table ("territory": {on, trade, towns, next, max}), edited on the
Lead Scraper page. Each morning `.github/workflows/daily.yml` runs:
  python -m aetos_leads autopilot   → records a run for the next town and prints trade/town/job_id for the scrape
  python -m aetos_leads sitrep      → writes SITREP.md from the database
A town searched in the last 30 days is skipped, so the list can be cycled forever without repeats.
"""

import json
import uuid
from datetime import datetime, timedelta, timezone

DEFAULT_TERRITORY = {
    "on": True,
    "trade": "landscaper",
    # around Warrington first (where the owner has been testing), then outwards
    "towns": ["Warrington", "Widnes", "Runcorn", "St Helens", "Wigan", "Leigh", "Northwich", "Altrincham", "Sale",
              "Stockport", "Chester", "Crewe", "Bolton", "Bury", "Salford", "Knutsford", "Macclesfield", "Ellesmere Port"],
    "next": 0,
    "max": 60,
}
RECENT_DAYS = 30
# Don't search more than we can email: with ~12 new leads a day, 100 ready leads is 2 weeks of sending.
# Searching beyond that only burns Google allowance on leads that go stale before anyone emails them.
READY_CAP = 100


def _rows(data: dict) -> list[dict]:
    return (data.get("result") or [{}])[0].get("results", []) or []


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def territory(d1) -> dict:
    rows = _rows(d1.query("SELECT value FROM settings WHERE key = 'territory'"))
    if rows:
        try:
            return {**DEFAULT_TERRITORY, **json.loads(rows[0]["value"])}
        except (ValueError, TypeError):
            pass
    d1.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('territory', ?)", [json.dumps(DEFAULT_TERRITORY)])
    return dict(DEFAULT_TERRITORY)


def choose_town(t: dict, recent: set[str]) -> tuple[str, int] | None:
    """The next town on the list not searched for this trade in the last 30 days, and the pointer after it."""
    towns = [x for x in t.get("towns", []) if str(x).strip()]
    for step in range(len(towns)):
        i = (int(t.get("next", 0)) + step) % len(towns)
        if towns[i].strip().lower() not in recent:
            return towns[i].strip(), (i + 1) % len(towns)
    return None


def next_run(d1) -> dict | None:
    """Record today's run (a jobs row, so it shows on the Lead Scraper page) and return it, or None to skip today."""
    t = territory(d1)
    if not t.get("on") or ready_count(d1) >= READY_CAP:
        return None
    since = _iso(_now() - timedelta(days=RECENT_DAYS))
    recent = {str(r["town"]).strip().lower() for r in _rows(d1.query(
        "SELECT town FROM jobs WHERE lower(trade) = lower(?) AND created_at > ? AND status != 'failed'", [t["trade"], since]))}
    picked = choose_town(t, recent)
    if not picked:
        return None
    town, nxt = picked
    job = {"id": str(uuid.uuid4()), "trade": t["trade"], "town": town, "max": int(t.get("max") or 60)}
    ts = _iso(_now())
    d1.query("INSERT INTO jobs (id, trade, town, max_results, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
             [job["id"], job["trade"], town, job["max"], ts, ts])
    d1.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('territory', ?)", [json.dumps({**t, "next": nxt})])
    return job


# ---------------------------------------------------------------- SITREP

def ready_count(d1) -> int:
    return _one(d1, PICK_SQL) or 0


PICK_SQL = """SELECT COUNT(*) AS n FROM leads WHERE excluded = 0 AND status = 'new' AND email IS NOT NULL AND email != ''
  AND COALESCE(json_extract(audit, '$.email_source'), '') != 'guessed' AND quality_score >= 35"""


def _one(d1, sql: str, params: list | None = None, key: str = "n"):
    rows = _rows(d1.query(sql, params or []))
    return rows[0].get(key) if rows else None


def sitrep(d1, now: datetime | None = None) -> str:
    """The daily situation report: what happened in the last 24 hours, what's waiting on the owner, what's next."""
    now = now or _now()
    day = _iso(now - timedelta(hours=30))  # GitHub's schedule drifts by hours: never miss yesterday's search
    week = _iso(now - timedelta(days=7))
    n = lambda sql, p=None: _one(d1, sql, p) or 0  # noqa: E731
    t = territory(d1)
    runs = _rows(d1.query("SELECT trade, town, status, found, pitchable, error FROM jobs WHERE created_at > ? ORDER BY created_at", [day]))
    stats = {
        "leads": n("SELECT COUNT(*) AS n FROM leads WHERE excluded = 0"),
        "new_leads": n("SELECT COUNT(*) AS n FROM leads WHERE first_seen_at > ? AND excluded = 0", [day]),
        "researched": n("SELECT COUNT(*) AS n FROM leads WHERE json_extract(audit, '$.ai_research.done_at') > ?", [day]),
        "waiting_claude": n("SELECT COUNT(*) AS n FROM leads WHERE excluded = 0 AND json_extract(audit, '$.ai_research') IS NULL "
                            "AND json_array_length(COALESCE(json_extract(audit, '$.ai_needs'), '[]')) > 0"),
        "picks": n(PICK_SQL),
        "in_outreach": n("SELECT COUNT(*) AS n FROM leads WHERE status = 'in outreach'"),
        "sent": n("SELECT COUNT(*) AS n FROM outreach_sends WHERE status = 'sent' AND sent_at > ?", [day]),
        "views": n("SELECT COUNT(*) AS n FROM demo_events WHERE kind = 'view' AND at > ?", [day]),
        "order_pages": n("SELECT COUNT(*) AS n FROM demo_events WHERE kind = 'order_page' AND at > ?", [day]),
        "orders": n("SELECT COUNT(*) AS n FROM demo_events WHERE kind = 'ordered' AND at > ?", [week]),
        "replies": n("SELECT COUNT(*) AS n FROM outreach_replies WHERE received_at > ?", [day]),
        "clients": n("SELECT COUNT(*) AS n FROM clients WHERE cancelled_on IS NULL"),
    }
    hot = _rows(d1.query(
        """SELECT l.name, l.phone, COUNT(*) AS views FROM demo_events e JOIN leads l ON l.place_id = e.place_id
           WHERE e.kind IN ('view', 'order_page') AND e.at > ? GROUP BY e.place_id HAVING COUNT(*) >= 2 ORDER BY views DESC LIMIT 5""", [week]))
    towns = [x for x in t.get("towns", []) if str(x).strip()]
    upcoming = towns[int(t.get("next", 0)) % len(towns)] if towns else "nothing set"

    L = [f"# SITREP · {now.strftime('%A %-d %B %Y')}", "",
         "Written automatically every morning from the Control Room's database. No AI, no cost.", ""]
    L += ["## Last 24 hours", "",
          f"- **Lead search:** " + ("; ".join(
              f"{r['trade']} in {r['town']}: " + (
                  "still running (results in tomorrow's SITREP)" if r.get("status") in ("queued", "running")
                  else f"FAILED: {r.get('error') or 'see the Lead Scraper page'}" if r.get("status") == "failed"
                  else f"{r.get('found') or 0} found, {r.get('pitchable') or 0} worth pitching")
              for r in runs) or "no search ran"),
          f"- **New leads:** {stats['new_leads']} (total worth pitching: {stats['leads']})",
          f"- **Claude researched:** {stats['researched']} leads (the best ones first, ~15 a day)"
          + (f"; {stats['waiting_claude']} lower-priority still waiting" if stats["waiting_claude"] else ""),
          f"- **Emails sent:** {stats['sent']} · **replies:** {stats['replies']}",
          f"- **Demo views:** {stats['views']} · **order page opened:** {stats['order_pages']} · **orders this week:** {stats['orders']}",
          f"- **Clients paying:** {stats['clients']}", ""]
    if hot:
        L += ["## Hot right now (looked at their demo 2+ times this week)", ""]
        for r in hot:
            phone = f" · {r['phone']}" if r.get("phone") else ""
            L.append(f"- {r['name']} · {r['views']} visits{phone}")
        L += [""]
    needs = []
    done = {}
    rows = _rows(d1.query("SELECT value FROM settings WHERE key = 'setup_done'"))
    if rows:
        try:
            done = json.loads(rows[0]["value"]) or {}
        except (ValueError, TypeError):
            done = {}
    if not done.get("mailboxes"):
        needs.append("**#1 priority: buy the mailboxes** (Namecheap Private Email on aetoswebsites.com). Nothing can be "
                     "emailed until they exist, so no money comes in. Tick it on Home when done; Claude then connects them.")
    last_ai = _one(d1, "SELECT MAX(json_extract(audit, '$.ai_research.done_at')) AS at FROM leads", key="at")
    if stats["waiting_claude"] and (not last_ai or last_ai < _iso(now - timedelta(days=2))):
        needs.append("**Claude isn't researching leads** (last run: " + (str(last_ai)[:10] if last_ai else "never")
                     + "). See 'What to do' on the Control Room's Home page.")
    if stats["picks"]:  # a fact, no page: the Outreach page is gone until sending is rebuilt
        needs.append(f"**{stats['picks']} lead{'s' if stats['picks'] != 1 else ''} ready for outreach** "
                     "(sending is being rebuilt; nothing to approve yet)")
    if not needs:
        needs.append("Nothing urgent.")
    L += ["## Needs you", "", *[f"- {x}" for x in needs], ""]
    paused = stats["picks"] >= READY_CAP
    L += ["## Next", "",
          f"- **Tomorrow's search:** " + (f"paused: {stats['picks']} leads are ready, enough for about {stats['picks'] // 12} days of emails"
                                          if paused and t.get("on") else f"{t['trade']} in {upcoming}")
          + ("" if t.get("on") else " (automatic search is OFF: Lead Scraper page)"),
          "- Full to-do list: 'What to do' on the Control Room's Home page.", ""]
    return "\n".join(L)
