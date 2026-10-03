# Outreach that improves itself: design

How Aetos outreach finds the most effective emails on its own, safely, at about 30 emails a day.

## 1. What "most effective" means

We optimise for **positive replies** (interested, asks a question, asks for the demo or a call). That's what leads to calls,
and calls lead to sales.

| Measure | Used for | Why |
| --- | --- | --- |
| **Positive reply rate** (per email delivered) | Picking winners | The closest signal to money that's frequent enough to learn from |
| Calls booked, clients won | Reported, and used as a tie-break | Too rare at our volume to decide on alone |
| Negative replies, unsubscribes, bounces | Safety limits (guardrails) | A variant that annoys people or bounces gets paused, whatever its reply rate |
| ~~Opens~~ | Not used | Apple Mail fakes opens, and tracking pixels push emails towards spam. We don't track opens. |

## 2. The honest maths at 30 emails a day

About 650 first emails a month. Cold email to trades typically gets a 1–5% positive reply rate, so roughly **7–30 positive
replies a month**. That shapes everything:

- **Only test big differences.** Different angles (problem-led vs Google-Maps-rank-led vs demo-led), not swapping one word.
  A 2% vs 2.5% difference would take thousands of emails to detect; 2% vs 5% shows up within a few hundred.
- **At most 3 live versions per slot**, so each gets enough traffic.
- **Don't wait for "statistical significance".** We use **Thompson sampling**: every email picks a version in proportion
  to how likely it is to be the best, given the results so far. Winners automatically get more traffic, losers fade out,
  and new ideas still get tried. It's the standard method when every email counts.
- **Replies arrive late.** An email only counts towards the rates once it's **5 days old** (or has been replied to).
  Otherwise new versions look bad just because their replies haven't arrived yet.

## 3. What gets tested: slots

An email is built from interchangeable parts. Each part is a **slot**, and each slot has its own experiment:

| Step | Sent on | Slots |
| --- | --- | --- |
| 1. First email | day 0 | **subject**, **opener** (first line), **pitch** (the WIIFM and offer), **ask** (call to action) |
| 2. Follow-up | day 3 | **angle** (e.g. "made you a demo", "where you show up on Google Maps") |
| 3. Follow-up | day 7 | **angle** (e.g. seasonal demand, the heatmap vs the top competitor) |
| 4. Follow-up | day 14 | **angle** (e.g. "reminded me of you" or a new idea, never "just following up") |
| 5. Last email | day 21 | **angle** (a polite close: "should I stop emailing?") |

Each slot's version is chosen independently, so one email teaches us about its subject, its opener, its pitch and its ask
at the same time.

**Who gets credit:**
- A reply is credited to the **step it replied to**.
- Step 1's slots are credited for replies to step 1.
- Each follow-up's angle is credited for replies to that follow-up.
- A positive reply at any step also counts towards step 1's subject (it got the thread opened). That's tracked as a secondary measure, not used for picking.

Results are **pooled across all trades** to start, because there isn't enough data to split. Per-trade breakdowns show in
the report, and a trade gets its own experiments once it has 300 or more step-1 emails.

## 4. Templates are formulas filled with each lead's real data

Versions are written with placeholders. The Control Room fills them in from the lead:

`{first_name}` (director, if known), `{business}`, `{town}`, `{trade}`, `{problem}` (the top audit issue, written softly),
`{maps_line}` (their Map Rank result), `{competitor}` (the top-ranked rival), `{reviews}`, `{rating}`, `{demo_link}`,
`{report_link}`, `{sender_name}`.

- If a version needs data the lead doesn't have (e.g. `{competitor}` but no heatmap), that version is skipped for that
  lead and another eligible one is chosen.
- **Nothing untrue:** every fact comes from the audit, which is already held to "no false alarms".

## 5. Quality gate: every version must pass before it can go live

Run automatically on every version, whoever wrote it (owner, Claude or seed). A failure blocks it, with the reason.
These come straight from the playbook:

| Rule | Check |
| --- | --- |
| Not waffle | Step 1 total under 120 words; follow-ups under 90; sentences under 25 words |
| Sounds human | No robot phrases ("I hope this email finds you well", "I am reaching out", "leverage", "synergy"…) |
| No hype or "steroids" | No hype words ("revolutionary", "skyrocket", "guaranteed results" outside the real guarantees, "!!!") |
| Never insults their site | No "outdated", "terrible", "bad", "ugly", "sucks", "old-fashioned" aimed at them |
| Never says "SEO" | Say "front page of Google" |
| One goal | Exactly one question or ask per email |
| Plain subject | Under 6 words, no clickbait, no emoji, no ALL CAPS, no "Re:" or "Fwd:" tricks |
| Honest placeholders | Only known placeholders; no made-up numbers |
| Unsubscribe line | Added automatically to every email; a version can't remove it |

## 6. How the system adapts on its own

**Every email (instant, in the Control Room):** Thompson sampling picks the version for each slot from the live ones.

**Every day (automatic):** each live version is checked:
- **Retire:** after at least 150 counted emails, if its chance of being the best is under 5%.
- **Champion:** after at least 150 counted emails, if its chance of being the best is over 95%. It stays live and becomes
  the one new challengers are measured against.
- **Pause at once (guardrail):** negative replies plus unsubscribes over 3% (after 40 emails), or bounces over 5%.
  Sending stops entirely if any mailbox's bounce rate passes 3%: a bounce problem is a list problem, not a copy problem.

**Every week (Claude, on your subscription):** a scheduled Claude session (a Routine on your Claude account; no API key)
reads the experiment report and:
1. Says in plain English what's working and why.
2. For each slot with a retired loser or no clear winner, writes **one or two new challengers**. They're bold variations in
   the direction of what's winning, following the playbook, and each comes with a one-line hypothesis ("shorter opener
   that leads with their Maps rank, because rank-led openers are winning").
3. Submits them to the Control Room as **proposed**.

**You approve.** New versions only go live when you press Approve in the Outreach page, with the quality gate passed and a
live preview on a real lead. You can also write your own. This keeps a human on everything that goes out under your name.

**Exploration floor:** a newly approved challenger gets a fair start: its prior (starting assumption) matches the slot's
average, so it isn't drowned out before it's had about 50 emails.

## 7. Safety and the law (UK)

- **Who we cold email.** Under PECR, unsolicited marketing email to **sole traders and partnerships** needs their prior
  consent. To **limited companies and LLPs** it's allowed, with a clear opt-out. So outreach only emails leads with a
  **Companies House company number**. Sole traders go on the **call list** (calls to businesses are allowed if they're
  not on the TPS/CTPS do-not-call registers; check before calling).
- **Opt-out:** every email has a one-click unsubscribe. Unsubscribes go on a permanent suppression list, checked before
  every send.
- **Sending limits:** each mailbox ramps up 2 → 4 → 6 → 10 → 14 emails a day (the playbook's schedule), with a hard
  cap of 14. Emails go out at random times in working hours.
- **Stop rules:** a "not interested" stops the sequence for that lead. Any reply pauses the automatic follow-ups and
  hands over to you (or to the auto-reply once built).
- **Sender:** real name, real business, real address in the footer.

## 8. What gets built now vs when mailboxes exist

**Now:**
- the database tables
- the experiment engine (Thompson sampling, counting rules, retire/champion/guardrails)
- template filling and the quality gate
- the eligibility and suppression rules
- the Outreach page (experiments, results, approval queue, preview on a real lead, marking reply outcomes)
- the endpoints the weekly Claude review uses
- seed versions written from the playbook
- the weekly review prompt
- tests

**When mailboxes exist (Monday + warm-up):** the sending connection (Gmail API from Google Workspace), the reply
inbox, and switching the weekly Claude Routine on.
