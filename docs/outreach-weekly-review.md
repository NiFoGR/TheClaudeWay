# Weekly outreach review: the Claude Routine prompt

Runs as a **Claude Routine on the owner's Claude subscription** (no API key), every morning (08:45 UK time). Daily so
the owner's own wording ("Write it your way") becomes proper versions by the next morning; the full review is weekly.
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
2. **Every run:** turn each brief in "The owner's own wording" into 1–2 versions for that step: keep his voice and idea,
   add placeholders so it fits every lead, follow the rules, and POST each with `"brief_id"` set. Then, **only on
   Mondays**, do steps 3 and 4.
3. Write a short plain-English summary to `docs/outreach-reports/<today YYYY-MM-DD>.md`:
   - what's winning, and the honest uncertainty (counts are small; say so);
   - what the reply texts suggest prospects care about;
   - which kinds of lead reply most (the feature table), and one suggestion for the Lead Scraper's targeting or score
     if the pattern holds across 20+ positive replies;
   - anything worrying (negative replies, a paused version).
4. **Only if the current test has fewer than 2 live versions** (a test just ended, or one was retired), propose **one**
   challenger, and at most two if none are waiting for approval:
   - change exactly ONE named idea versus the current champion (angle, ask type, hook, or length) and write it as the
     hypothesis, e.g. "Same Maps angle, but asks a yes/no question about getting more calls instead of offering the map";
   - follow every rule in the report's "Rules" section; never retest an idea from "Past tests";
   - POST it:
     `curl -fsS -X POST -H "Authorization: Bearer $OUTREACH_AGENT_TOKEN" -H "content-type: application/json"
      -d '{"step":1,"name":"…","hypothesis":"…","subject":"…","body":"…"}' "$CONTROL_ROOM_URL/api/agent/versions"`
   - if the response lists `issues`, fix them and post a corrected version. Never post more than 2 challengers (briefs don't count towards that).
5. **Ask the owner when it's his call, not a guess.** If a decision depends on his taste or judgement (how blunt to be,
   which angle he'd never use, how he'd answer a kind of reply), POST at most 2 questions per run, each with 2–4
   suggested answers and why you're asking:
   `curl -fsS -X POST -H "Authorization: Bearer $OUTREACH_AGENT_TOKEN" -H "content-type: application/json"
    -d '{"question":"…","why":"…","options":["…","…"]}' "$CONTROL_ROOM_URL/api/agent/questions"`
   Never re-ask anything in "Questions still waiting"; follow every answer in "The owner's answers" as a rule.
6. Commit the summary file (if one was written) and push to the current branch. Finish with a 3-line summary: what's winning, what you
   proposed (if anything), what the owner should do (usually "approve or reject the proposal on the Outreach page").

Never send email, never change live versions, never approve your own proposals. The owner approves everything.
