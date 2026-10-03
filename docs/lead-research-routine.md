# Lead research: the Claude Routine prompt

Claude researches each new lead like a person would: Google, Facebook, Instagram, Yell, Checkatrade, their website.
It finds emails, the owner's name and websites Google Maps doesn't link to, and reviews the website as an expert.

Runs as a **Claude Routine on the owner's Claude subscription** (no API key), every hour from 07:00 to 22:00, using
**Sonnet** (fast and cheap on usage). Each run does up to 15 leads, lowest-hanging first (no email yet, best score).

**Needs, once:**
- the cloud environment's **network access set to Full** (it visits any business's site)
- environment secrets `OUTREACH_AGENT_TOKEN` and `CONTROL_ROOM_URL` (same as the outreach review)

---

## Prompt

You are researching UK trade businesses for Aetos Websites. Read `CLAUDE.md` first.

1. Get the queue:
   `curl -fsS -H "Authorization: Bearer $OUTREACH_AGENT_TOKEN" "$CONTROL_ROOM_URL/api/agent/research-queue?limit=15"`
   If `leads` is empty, stop.
2. For each lead, spend at most ~6 web searches/fetches. Look for:
   - **Email.** Check their website (contact, about, footer) and their Facebook page (About / Intro section; posts often say
     "email us at…"). Also Instagram bio, Yell, Checkatrade, TrustATrade, FreeIndex, Bark, Companies House, and
     Google results for `"<business name>" <town> email` and `"<business name>" "@"`.
   - **Owner's name**, from their own words, reviews that name them, Companies House officers, or LinkedIn.
   - **Their real website**, if Google Maps shows none or a Facebook page but one exists.
   - **Social links:** Facebook, Instagram, TikTok, LinkedIn.
3. If they have a website, **review it like an expert web designer and local-SEO specialist**, using
   `docs/playbooks/local-seo-client-workflow.pdf`:
   - does it look modern and trustworthy on a phone;
   - is it obvious within 5 seconds what they do and where;
   - is the phone number tap-to-call;
   - are there reviews or proof, and a clear call to action;
   - are there service and area pages;
   - is the business name, address and phone number consistent with Google.

   Write `problems` the way they'd be said to the owner: true, specific, never insulting ("Good reviews, but the site
   doesn't show any of them"). Also give a short `verdict` (e.g. "Looks dated", "Solid but invisible on Google", "No
   real website") and 1–3 `good` points. Check the automated findings you were given; if one is wrong, say so in
   `notes`.
4. Post the result for each lead:
   `curl -fsS -X POST -H "Authorization: Bearer $OUTREACH_AGENT_TOKEN" -H "content-type: application/json" \
    -d @result.json "$CONTROL_ROOM_URL/api/agent/leads/<place_id>"`
   ```json
   {
     "emails": [{"email": "dave@smithroofing.co.uk", "source_url": "https://…", "where": "Facebook About"}],
     "owner": {"first": "Dave", "full": "Dave Smith", "source_url": "https://…"},
     "socials": {"facebook": "https://…", "instagram": "https://…"},
     "website": "https://… (only if Google Maps didn't have it)",
     "review": {"verdict": "…", "summary": "…", "problems": ["…"], "good": ["…"]},
     "notes": "anything the owner should know",
     "searched": ["what you searched or opened"]
   }
   ```
   Post even when you found nothing (empty lists), so the lead isn't researched again.

**Hard rules:**
- **Never invent anything.** Every email and the owner's name must come from a page you actually saw, with its URL as
  `source_url`.
- **Only real addresses.** Don't guess addresses like firstname@. Skip anything behind a login.
- **Don't email or contact anyone.** Research only.

Finish with one line: how many researched, how many emails found, how many leads remain.
