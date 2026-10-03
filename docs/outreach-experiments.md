# Outreach that improves itself: design (v2, after review)

How Aetos outreach finds the most effective first email on its own, safely, at about 30 emails a day.
v1 was reviewed independently. The main corrections: the volume maths, testing one whole email at a time, timeboxed
decisions, a real scheduler, and the law section.

## 1. The honest volume

- 3 mailboxes × at most 10 a day = **30 emails a day**, including follow-ups.
- Each lead gets up to 4 emails, about 3.3 on average, so that's **about 9 new leads a day, about 200 a month**.
- At a realistic 1–2% positive reply rate: **2–4 positive replies a month** from copy alone.

Copy tests are therefore slow. The biggest wins come from **better leads** (§8) and **speed of reply** (§7).

## 2. What we measure

| Measure | Used for |
| --- | --- |
| **Positive replies** (Interested, or a genuine Question) **per delivered first email**, counting any positive reply from that lead within **10 days** | Deciding tests |
| Calls booked, clients won, revenue per version | Reported (too rare to decide on) |
| Negative replies, unsubscribes, spam complaints | Guardrails |
| ~~Opens~~ | Never tracked: no pixels, no link tracking |

A first email only counts once it's 10 days old (or the lead has replied), so new versions aren't penalised for replies
that haven't arrived yet.

## 3. What gets tested: one whole first email at a time

- **The unit is a complete first email** (subject + opener + pitch + ask, written together and approved as one).
  Mixing parts could create combinations nobody approved, and subject lines barely move reply rates.
- **One test at a time, 2 versions (3 at most).** Every new lead is randomly assigned one.
- **Follow-ups are fixed** (same for everyone), so they add equal noise to every version and credit stays simple. They
  only become a test after step 1 has had 2 decided tests.
- **Sequence: 4 emails.** Day 0, 3, 7 and 14 (a polite close). Follow-ups go in the same Gmail thread.

## 4. How it decides (numbers from the review's simulation)

- **Starting assumption (prior):** Beta(1, 49), i.e. "about 2%, worth 50 emails of evidence". Every version starts equal.
- **Allocation:** Thompson sampling, with an **exploration floor**: any version with under 150 counted emails gets at
  least 25% of new leads.
- **When the test ends:** when every version has **250 counted emails, or after 8 weeks**, whichever is first. Keep the
  version with the highest expected rate. It becomes the **kept** version and carries into the next test.
- **Early retire:** a version is dropped mid-test only if its chance of being best is under 2% with 250+ counted emails.
- **Guardrails (pause, owner reviews):** 4+ negatives or unsubscribes **and** over 4% after 60+ emails; or any spam
  complaint.
- **Mailbox stop:** hard bounces over 3% of the last 100 sends stops that mailbox. Bounces are a list problem, not a copy
  problem, so they never count against a version (except content blocks, 5.7.x).

## 5. Templates and the quality gate

Versions use placeholders filled only from audit facts: `{greeting}`, `{business}`, `{town}`, `{trade}`, `{problem}`,
`{top3}`, `{competitor}`, `{competitor_top3}`, `{rating}`, `{reviews}`, `{sender_first}`. If a lead lacks the data a version
needs, that version is skipped for that lead.

The gate runs on the template **and on the version rendered for 5 real leads**. It blocks anything that fails:

| Rule | Check |
| --- | --- |
| Short | First email ≤ 90 words, follow-ups ≤ 60, sentences ≤ 25 words (footer not counted) |
| Human, not hype | No robot phrases ("I hope this finds you well", "reaching out", "leverage"…); no hype words; no "!!" |
| Never insults | No "outdated / terrible / ugly / old-fashioned…" about them; never runs a competitor down |
| Never "SEO" | Say "front page of Google" |
| One ask | At most one question mark |
| First email | No links, no prices, no "free", no guarantee claims; a lead-specific fact in the first 2 lines |
| Subject | ≤ 6 words, no emoji, no ALL CAPS, no fake "Re:" (real thread replies are exempt) |
| Rendered check | No empty or unknown placeholders, no "Ltd Ltd", no SHOUTING names |
| Truthful | No claims about work not yet done ("I've mocked up…" only once demos exist) |

Every email gets a fixed footer that versions can't change: sender identity, privacy link, opt-out line.

## 6. The law and deliverability

> **Owner's decision (overrides this section's eligibility and footer rules):** email every lead that has an email
> address, sole traders included, accepting the PECR risk. Emails end with only the opt-out line, no name/address footer.

**Who gets emailed (UK PECR and UK GDPR):**
- Only leads matched to Companies House as **ltd, llp, plc or a Scottish partnership**, and only when the match is
  backed by the **postcode or town** of the registered address (a name-only match isn't trusted).
- **Sole traders and other partnerships** need prior consent, so they go on the **call list** instead. Check TPS/CTPS
  before calling.
- **Free webmail** (gmail, hotmail, btinternet…) is treated as personal and never emailed.
- **Suppression:** an opt-out suppresses the email, its domain and the company number, permanently.

**Paperwork the owner needs before sending:**
- ICO data protection fee (about £52 a year)
- a written legitimate-interests assessment
- a privacy page at aetoswebsites.com/privacy (the footer links to it)

**Footer:** "Nikiforos [Surname], trading as Aetos Websites, [business address]. How I got your details:
aetoswebsites.com/privacy. Reply 'no thanks' and I won't email again." The real List-Unsubscribe header (one-click) is
added at send time.

**Guarantees in ads:** the "front page in 90 days" guarantee is never put in a first email; it only goes where its terms
can be linked.

**Deliverability on one domain:**
- SPF `include:_spf.google.com -all`, DKIM 2048-bit, DMARC `p=none` (reports to Cloudflare's free DMARC Management) and
  then `p=quarantine` after 4 clean weeks. Google Postmaster Tools.
- **Ramp:** 2 weeks of normal manual email first, then 3 → 5 → 8 → **10 a day per mailbox (hard cap)**, raised weekly.
- **Format:** plain text, no images, no attachments.
- **Sending window:** Mon–Thu, 07:00–09:30 and 12:00–13:30 UK time, at least 8 minutes apart, no bank holidays.
- **Guessed info@ addresses:** none in the first 4 weeks, then at most 25% of daily volume, tracked separately. Never
  guess firstname@.

## 7. Replies (built with the mailboxes)

- **Classified automatically:**
  - bounces → suppress;
  - auto-replies/out-of-office → reschedule;
  - opt-outs ("unsubscribe / remove / stop / not interested") → suppress at once, sequence stops.
- **Everything else, the owner taps once:** Interested · Question · Not now (snooze 120 days) · No · Referral. Any reply
  stops the automatic follow-ups. Unclassified after 72 hours → left out of the stats and flagged.
- **Speed:** a phone alert for every human reply. The playbook's 5-minute rule: call them back.

## 8. The bigger self-improvement loop: better leads

Each send stores a snapshot of the lead's features: top finding, Maps-rank band, trade, email source, whether a first
name was known. The monthly report breaks positive replies down by these, so the **lead score** and the targeting can be
adjusted towards the kinds of business that actually reply. This matters more than copy tweaks.

## 9. Claude's part, on the owner's subscription

A scheduled Claude Routine on the owner's Claude account (no API key) reads `/api/agent/outreach-report`, using a
Control Room token stored as an environment secret.

- **Weekly:** writes a plain-English summary.
- **When a test ends (about monthly):** proposes 1–2 challengers. Each changes **one named idea** (angle, ask type, hook
  or length), comes with a hypothesis, and is checked against the playbook and the past-test log so old ideas aren't
  retested.

The report includes:
- per-version counts, expected rates with 90% ranges and chance-of-best;
- the anonymised text of positive and negative replies;
- the feature breakdowns (§8);
- the full log of past tests;
- the playbook rules.

Proposals land as **proposed**. The owner sees each one rendered on real leads, with the gate results, and approves
or rejects it. Nothing goes out under his name without approval.

## 10. Build order

**Now:**
- database tables
- the decision engine (§4)
- placeholders + the quality gate (§5)
- eligibility + suppression (§6)
- the Outreach page: the test, versions and stats, the approval queue, previews on real leads, a write-your-own form,
  and sender details
- the agent report and proposal endpoints
- seed versions
- the weekly Routine prompt
- the Companies House company-type fix
- tests

**With the mailboxes:**
- a separate free **Cloudflare Worker with a cron trigger** (Pages has no cron, and GitHub Actions every few minutes
  would blow the free minutes), bound to the same database, every 5 minutes: sends due emails in the window, reads
  replies and bounces from Gmail, runs the decisions
- Gmail API connection
- List-Unsubscribe
- the reply inbox
- phone alerts
