# Weekly outreach review: the Claude Routine prompt

Runs as a **Claude Routine on the owner's Claude subscription** (no API key), weekly (Mondays at 08:45 UK time).
Switch it on once real emails are going out. It needs:

- **Environment secrets:** `OUTREACH_AGENT_TOKEN` (the same value as the Cloudflare secret) and `CONTROL_ROOM_URL`
  (e.g. `https://control.aetoswebsites.com`).
- **Network access** to the Control Room's domain (environment network settings).
- **This repository** attached.

---

## Prompt

You are reviewing Aetos Websites' cold-email test. Work in this repository; read `CLAUDE.md`,
`docs/outreach-experiments.md` and §6 "Outreach Mastery" of `docs/playbooks/business-sales-marketing-notes.md` first.

1. Fetch the report:
   `curl -fsS -H "Authorization: Bearer $OUTREACH_AGENT_TOKEN" "$CONTROL_ROOM_URL/api/agent/outreach-report"`
2. Write a short plain-English summary to `docs/outreach-reports/<today YYYY-MM-DD>.md`:
   - what's winning, and the honest uncertainty (counts are small; say so);
   - what the reply texts suggest prospects care about;
   - which kinds of lead reply most (the feature table), and one suggestion for the Lead Scraper's targeting or score
     if the pattern holds across 20+ positive replies;
   - anything worrying (negative replies, a paused version).
3. **Only if the current test has fewer than 2 live versions** (a test just ended, or one was retired), propose **one**
   challenger, and at most two if none are waiting for approval:
   - change exactly ONE named idea versus the current champion (angle, ask type, hook, or length) and write it as the
     hypothesis, e.g. "Same Maps angle, but asks a yes/no question about getting more calls instead of offering the map";
   - follow every rule in the report's "Rules" section; never retest an idea from "Past tests";
   - POST it:
     `curl -fsS -X POST -H "Authorization: Bearer $OUTREACH_AGENT_TOKEN" -H "content-type: application/json"
      -d '{"step":1,"name":"…","hypothesis":"…","subject":"…","body":"…"}' "$CONTROL_ROOM_URL/api/agent/versions"`
   - if the response lists `issues`, fix them and post a corrected version. Never post more than 2.
4. Commit the summary file and push to the current branch. Finish with a 3-line summary: what's winning, what you
   proposed (if anything), what the owner should do (usually "approve or reject the proposal on the Outreach page").

Never send email, never change live versions, never approve your own proposals. The owner approves everything.
