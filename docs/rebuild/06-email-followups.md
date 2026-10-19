# Stage 5–6: First email (Nik) + automatic follow-ups

> **Plain English:** You write every first email yourself, in the lead's drawer, with Claude's facts and suggested
> opener beside you and a live preview of exactly what they'll get. Press Send and it goes from your mailbox in the
> sending hours (Mon–Sat, 7am–7pm UK). After that the system sends up to 9 short follow-ups in the same email thread,
> on days 1, 2, 4, 7, 10, 17, 24, 30 and 60, at the same time of day as your email. The moment they reply, opt out or
> bounce, the follow-ups stop. You approve the 9 follow-up emails once, on the Voice page, before any of them go out.

**Goal:** turn a `ready` lead into an `emailed` one with a first email Nik wrote, then keep the thread going on a
fixed schedule until they reply, book, buy, opt out, or the sequence ends.

**Trigger:** Nik opens a lead whose prospect stage is `ready` (stage 4 has built and approved its demo) and presses
**Send**. Follow-ups are driven by the tick step `followups` (every 5 minutes).

## A1. Who does what

| Who | Does |
| --- | --- |
| Nik | Writes the subject and body of every first email. Picks the address. Approves the 9 follow-up emails once (and again after any edit). Adds his own example replies and rules on the Voice page. |
| Claude | Nothing new at send time. Its research (stage 2) supplies the angle facts, the suggested opener, the best email and the owner's first name. The reply Routine (stage 7) reads the first emails Nik sent as style examples. |
| System | Checks the email, picks the mailbox, queues it, sends it in the window, marks the lead `emailed` when it actually went, schedules and sends the follow-ups, stops them on the stop rules, closes the lead as `lost` 7 days after the 9th follow-up with no reply. |

## A2. The volume (say it plainly)

Each mailbox sends at most **about 10 cold emails a day, follow-ups included** (the warm-up ramp from stage 0:
3, 5, 8, then 10 a day). One business gets up to **10 emails** (your first + 9 follow-ups) over 60 days. So at full
speed **one mailbox can start about 1 new business a day (about 6 a week, Mon–Sat)**. One mailbox → ~6 new businesses
a week; 12 mailboxes (3 domains × 4) → ~12 a day. The Control Room enforces this: it only lets you send a first email
if your mailboxes have room for it today **and** on every day its 9 follow-ups will go out. The Leads page's "you can
send N first emails today" banner uses the same number, so the banner and Send never disagree.

## A3. The first email (composer)

Shown in the lead drawer under **Email**, only while the prospect is `ready` and no first email is queued or sent.
(After that the drawer shows the thread, A8.)

**Layout**
- **To:** a dropdown of the lead's sourced addresses (`research.emails`, plus `research.best_email`), the best one
  preselected and labelled "best", each with where it was found. No free typing.
- **Subject:** one line, placeholder "Short and plain, e.g. Your website".
- **Body:** large textarea, placeholder "Write it your way. 'Hi Mark,' and your sign-off are added for you."
- **Helpers (beside the body):**
  - **Why them:** the 1–3 angle facts from `research.angle`, each with its source link (opens in a new tab).
  - **Claude's suggested opener:** `research.opener` with an **Insert** button (inserts at the cursor).
  - **Insert demo link** button: inserts `{demo_link}` at the cursor.
- **Preview ("What they'll see"):** From `display_name <address>` of the mailbox that will send it, To, Subject, then
  the exact plain text: greeting line, Nik's body with `{demo_link}` replaced by the real URL, and the cold footer
  (`coldFooter(<the business:sender_name setting>)`: his name, "Aetos Websites", `If you'd rather not hear from me,
  just reply "no thanks".`). Every sign-off and cold footer in this stage uses `business:sender_name`, never the
  mailbox's `display_name` (that is only the From line).
  Updates 300 ms after he stops typing.
- **Checks:** a list under the preview, each a green tick or a red line in plain English. **Send** is disabled until
  all pass; its label is "Send now" inside the window, or "Send Mon 07:00" (the next window start) outside it.
- If the 9 follow-ups aren't all approved: a yellow note (not a block) "Your follow-ups aren't approved yet, so this
  lead won't get any until you approve them on the Voice page."

**Greeting rule:** `Hi <First>,` only when `research.owner.confident` is true and `research.owner.first` is set
(first name title-cased); otherwise `Hi,`. Stored as `prospects.greet_name` (NULL for "Hi,"). Follow-ups use the same.

**Checks before Send (exact messages):**

| Code | Fails when | Message Nik sees |
| --- | --- | --- |
| `subject_missing` | subject blank | Add a subject. |
| `subject_re` | subject starts with "Re:" / "Fwd:" / "Fw:" | The subject can't start with "Re:" or "Fwd:". |
| `body_missing` | body blank | Write the email first. |
| `greeting` | body's first line starts with Hi / Hello / Hey / Dear / Morning / Good morning | Leave out the greeting: "Hi Mark," is added for you. *(uses "Hi," when no confident name)* |
| `demo_missing` | `{demo_link}` and the demo URL appear 0 times | Add the demo link: press Insert demo link. |
| `demo_twice` | they appear more than once in total | The demo link is in there more than once. Keep it once. |
| `other_link` | any other link or web address (http(s)://, www., or a bare domain like greenleaf.co.uk, incl. email addresses) | Only the demo link is allowed. Remove: `<what was found>`. |
| `seo` | "SEO" as a word in subject or body (any case) | Don't say "SEO". Say "front page of Google" instead. |
| `too_long` | body ≥ 150 words (`{demo_link}` counts as 1, greeting and footer not counted) | Too long: `<n>` words. Keep it under 150. |
| `placeholder` | any `{word}` other than `{demo_link}` | `{<word>}` isn't filled in for you. Only {demo_link} is. |
| `demo_not_ready` | stage 4 `demoReady(DB, place_id).ok` is false | Their demo isn't ready: `<stage 4's reason>`. Fix it on the Demo card first. |
| `no_mailbox` | no cold mailbox is active | No mailbox is set up for cold email yet. Add one on Setup → Mailboxes. |
| `warming_up` | every active cold mailbox has cap 0 that day | Your mailbox is still warming up: cold emails can start on `<Tue 3 Nov>`. |
| `no_room` | no mailbox has room on the send day and on all 9 follow-up days | Your mailboxes are full on `<Mon 9 Nov>` (follow-ups already booked that day). Send this one tomorrow. |
| `not_in_list` | To isn't one of the lead's sourced addresses | Pick an address from the list. |
| `suppressed` | the address, or its domain, is in `suppression` | `<address>` is on your do-not-email list (`<opted out / bounced / reason>` on `<3 Nov>`). You can't email it. |
| `shared_address` | another prospect not in `ready`/`lost` already uses this address | `<address>` is already being emailed as `<other business>`. |
| `already_emailed` | prospect stage isn't `ready` (or `first_sent_at` set) | You've already emailed `<business>` on `<22 Oct>`. The thread is below. |
| `queued_already` | a first email for this lead is `queued` or `sending` | A first email to `<business>` is already waiting to go out. Cancel it below to write a new one. |
| `no_prospect` | no `prospects` row | This lead isn't ready to email yet: it needs a grade, an email and a demo first. |

**Send** → `queueMessage(DB, {place_id, mailbox_id, direction: "out", kind: "first", step: null, author: "nik",
to_addr, from_addr, subject, body: <full text as previewed>, message_id: makeMessageId(<mailbox domain>), status:
"queued", due_at})`, where `due_at` = now if `inUkWindow(now, COLD_WINDOW)`, else `nextUkWindowStart(now, COLD_WINDOW)`.
The mailbox is `pickMailbox(<mailboxes with room>, <today's load by mailbox>, ukDate(due_at))`. The prospect row gets
`email`, `greet_name`, `mailbox_id`, `subject` at once; its **stage stays `ready`** until the send succeeds. Toast:
"Queued. It goes out within 5 minutes." or "Queued for Mon 07:00." The route nudges the tick (`waitUntil(runTick(env,
"compose"))`) so it usually goes within seconds.

**When it has actually gone** (message `sent`), the next `followups` step: calls `applyStageEvent(DB, place_id,
"first_sent", now)` (stage 0's `_lib/prospects.js`) → `emailed`, sets `first_sent_at` = the message's `sent_at`, `root_message_id` = its `message_id`, `followup_step` 0,
`next_followup_at` = `schedule(first_sent_at, 1)`, and saves a `style_examples` row (`id` "sent:" + message id, `kind`
"example", `situation` "first email", `source` "nik_sent", `body` = the text without the footer). If a human reply,
opt-out or bounce already arrived for that lead after `sent_at`, the stop rules apply at once instead (A5).

**If it fails** (status `failed`): the prospect stays `ready`; the thread shows the error and a **Try again** button
(re-runs the room/suppression checks and queues a copy with a new Message-ID).

## A4. Follow-up schedule

Window: **`COLD_WINDOW = {start: "07:00", end: "19:00", days: [1, 2, 3, 4, 5, 6]}`** (Mon–Sat, UK time).

| Step | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Days after the first email | 1 | 2 | 4 | 7 | 10 | 17 | 24 | 30 | 60 |

- **Time of day:** the UK clock time the first email was actually sent, kept across clock changes (09:15 BST stays
  09:15 GMT). Clamped into 07:00–18:59.
- **Sunday → Monday**, same time.
- **Never two on one UK day:** if a step lands on or before the UK day the previous follow-up went out (e.g. a
  Saturday first email: day 1 Sunday → Monday, day 2 Monday), it moves to the next sending day after it.
- **Bank holidays** are ordinary days (no skip).
- `prospects.followup_step` = follow-ups sent (or skipped by Nik) so far; `next_followup_at` = when the next one is due.
  After step 9 is sent, `next_followup_at` = step 9's `sent_at` + 7 days, the **close time**: if nothing stopped the
  sequence by then, `applyStageEvent(DB, place_id, "sequence_done", now, {lost_reason: "sequence_done"})` → `lost`,
  `next_followup_at` NULL.

Worked example (the test uses it): first email Thu 22 Oct 2026 09:15 BST (08:15Z). Follow-ups: Fri 23 Oct 08:15Z,
Sat 24 Oct 08:15Z, Mon 26 Oct 09:15Z (now GMT), Thu 29 Oct 09:15Z, Mon 2 Nov 09:15Z (Sun → Mon), Mon 9 Nov 09:15Z,
Mon 16 Nov 09:15Z, Sat 21 Nov 09:15Z, Mon 21 Dec 09:15Z; lost on Mon 28 Dec 09:15Z if no reply.

**Threading:** every follow-up uses the same mailbox as the first email, subject `"Re: " + prospects.subject`,
`In-Reply-To` = `root_message_id`, `References` = root id followed by the Message-IDs of the follow-ups already sent,
in order, space-separated. Author `system`, kind `followup`, `step` 1–9.

**Capacity and priority:** the daily cap counts first emails and follow-ups (`sentToday`). The composer reserves room
on every future follow-up day (A2), so the cap is normally never hit. If it is (cap lowered, mailbox paused, sends
failed), **follow-ups go before first emails** (stage 0's `dispatchDue` orders `followup` before `first`, then by
`due_at`); a follow-up that can't go today stays queued and goes first in the next window. It is never skipped, and the next step is only scheduled after it has gone, so later steps shift with it.

**Templates gate:** no follow-up is queued until all 9 `followup_templates` rows are `approved`. Waiting follow-ups
then go one step at a time from the next tick (no catch-up bursts).

**Demo gate:** a follow-up is only queued if `demoReady(DB, place_id).ok`; otherwise it waits and a `health` todo says
why (truth rule: never send a dead link).

## A5. Stop rules

The sequence stops (`next_followup_at` NULL, queued follow-ups for that lead → `cancelled`) when any of these is true:
- an inbound message for the lead with `class` `human`, `opt_out` or `bounce`, received after `first_sent_at`;
- prospect stage is `replied`, `needs_nik`, `call_booked`, `won` or `lost`.

**Do not stop on:** demo views (`viewed` keeps going), auto-replies / out-of-office (`class` `auto`). Follow-ups never
restart on their own once stopped. Stage 7's inbound step calls `stopFollowups` the moment it classifies a message;
the `followups` step re-checks every lead with a pending follow-up on every run as the safety net.

## A6. Follow-up wording (seeded as `draft`; Nik approves on the Voice page)

Rules each follow-up must pass (`checkFollowup`, also run on Nik's edits): first line is exactly `{greeting}`; at most
60 words after it (`{business}` and `{demo_link}` count 1 each); only `{greeting}`, `{business}`, `{demo_link}`;
`{demo_link}` at most once and no other link; no "SEO"; no "£" or prices; no "guarantee"; at most one "?"; no "!!".
`{business}` = the cleaned business name ("SMITH ROOFING LTD - Roofer in Leeds" → "Smith Roofing"). The cold footer is
added after the body, as on the first email.

**Step 1 (day 1): buried**
```
{greeting}

In case my last email got buried: I made a new website for {business} and it's ready to look at.

{demo_link}

It takes a minute on your phone.
```

**Step 2 (day 2): it's theirs**
```
{greeting}

The site I made for {business} uses your own services, your area and your details, so you can see exactly how it would look for you.

{demo_link}

If anything on it is wrong, tell me and I'll fix it.
```

**Step 3 (day 4): phones**
```
{greeting}

Most people find a local business on their phone now, so the site I made for {business} is built for phones first.

Have a look on yours:
{demo_link}
```

**Step 4 (day 7): right person?**
```
{greeting}

I might have the wrong person. If someone else looks after the website for {business}, would you mind passing this on to them?

This is the site I made: {demo_link}

Thank you.
```

**Step 5 (day 10): the point is calls**
```
{greeting}

The point of the new site is more calls. When someone near you searches for what you do, the aim is for {business} to show up in the top 3 on Google, with a site that makes it easy to ring you.

{demo_link}
```

**Step 6 (day 17): little effort**
```
{greeting}

If you're busy, this won't take much of your time. You fill in one short form and I do the rest. The site goes live within 7 days of that.

This is what it would look like:
{demo_link}
```

**Step 7 (day 24): yes or not now (no link)**
```
{greeting}

Is a new website something you'd want for {business} this year, or not right now?

Either answer is fine. A one-word reply is plenty.
```

**Step 8 (day 30): still up, happy to change it**
```
{greeting}

The site I made for {business} is still up if you want another look:

{demo_link}

If you'd change anything on it, like the photos, colours or wording, just tell me what and I'll sort it.
```

**Step 9 (day 60): I'll leave it here**
```
{greeting}

I'll leave it here so I'm not filling up your inbox. If the timing is better later on, just reply to this email and I'll pick it up from there.

The site for {business} is here whenever you want it:
{demo_link}

All the best.
```

## A7. Voice page (`#/voice`, nav "Voice")

**Follow-up emails** (top):
- Banner while any is a draft: "Follow-ups are paused until you approve all 9 (6 of 9 approved)." Green when done:
  "All 9 approved. Follow-ups are on."
- One card per step: "Follow-up 3 · day 4", status pill **Draft** / **Approved 19 Oct**, textarea with the body, live
  word count ("38 / 60 words"), the check results in plain English, a preview rendered for a real lead (the newest
  prospect with a demo; else the sample "Hi Mark," / "Green Leaf Landscapes" / `https://aetoswebsites.com/d/green-leaf-landscapes`).
- Buttons: **Save** (any edit makes it a Draft again: "Saved as a draft. Approve it to switch follow-ups back on.")
  and **Approve** (disabled while checks fail). Follow-ups use the wording at the moment each one is queued.

**Your style** (below), read by the reply Routine (stage 7):
- Add form: **Type** (Example reply / Rule), **When** (free text, suggestions: "they ask the price", "send me more
  info", "can we have a call", "they say they're busy"), **Text**. Saved with `source` "nik_written".
- A highlighted card until Nik adds one with situation "they ask the price" (decision D-3): "How much is it? Claude
  answers from your price list until you add your own reply here." with **Write it** (prefills the form).
- List of his examples and rules with **Delete**; below it, collapsed: "First emails you've sent (12)", each
  deletable (deleted ones stop being used as examples).
- Empty state: "No examples yet. Add how you'd answer the questions you get most."

## A8. Thread view (lead drawer, once a first email exists)

- A summary line: "Follow-up 3 of 9: Mon 26 Oct 09:15" · "Follow-ups stopped: they replied" · "Follow-ups stopped:
  they opted out" · "Follow-ups finished: marked lost on Mon 28 Dec if no reply" · "Follow-ups paused: approve your
  follow-up emails on the Voice page" · "Follow-ups on hold: their demo isn't available".
- Every message, oldest first: badge **You** (nik) / **Claude** (claude) / **System** (system) / **Them** (them),
  subject, UK time, status: "Goes out Mon 07:00" / "Going out in a few minutes" (queued), "Sending…", "Sent 22 Oct
  09:15", "Didn't send: `<error>`" (failed, red), "Cancelled", "Received 23 Oct 14:02"; inbound class labels:
  "Bounced: the address doesn't work", "Auto-reply", "Asked not to be emailed". Bodies shown as plain text (escaped),
  long ones collapsed after 12 lines.
- **Cancel** on any queued outgoing message. Cancelling the first email leaves the lead `ready` (compose again).
  Cancelling a follow-up skips that step: the next one is scheduled as normal (step 9 skipped → close time = now + 7
  days). Confirm dialog: "Cancel this email? It won't be sent."
- **Try again** on a failed first email (A3).

## A9. Edge cases

- **Reply before the send is recorded** (reply lands between the SMTP send and the next `followups` run): the sync
  sees the inbound message and applies `first_sent` then the stop, so no follow-up is ever queued.
- **Two clicks / two tabs:** the second Send gets `queued_already`; only one message is queued.
- **Same address on two leads** (duplicate listing): `shared_address`.
- **Mailbox paused** (bounces, stage 0): its follow-ups stay queued and wait; they are never moved to another
  mailbox (threading). The Follow-ups light goes red after 24 h overdue.
- **Follow-up send fails** (not a bounce): retried at the next day's window start, up to 3 attempts for one step;
  after the 3rd failure the sequence stops and a `health` todo says "Follow-ups to `<business>` keep failing:
  `<error>`. Check the mailbox on Setup." **Exception:** a send that failed with stage 0's "The send was interrupted…"
  error may already have gone, so it is never retried: the sequence stops at once and the same todo
  (`health:followup-fail:<place_id>`) shows that error, which tells Nik to check the Sent folder.
- **Demo unavailable** when a follow-up is due: it waits; `health` todo "Follow-ups to `<business>` are on hold: their
  demo isn't available (`<reason>`)." Closed when it goes.
- **Template edited mid-sequence:** the next follow-up uses the new wording once it's approved again.
- **Nik replies from his own mail app:** the system can't see it; their reply to it still stops the sequence.
- **Re-scrape:** never touches `prospects` or `messages` (overview §4).

## A10. Todos and health lights

| Todo kind | Title | Dedupe | Closed when |
| --- | --- | --- | --- |
| `setup` | Approve your 9 follow-up emails | `setup:followups` | all 9 approved |
| `health` | Follow-ups to `<business>` keep failing: `<error>` | `health:followup-fail:<place_id>` | a follow-up to them is sent, or the lead closes |
| `health` | Follow-ups to `<business>` are on hold: their demo isn't available | `health:followup-demo:<place_id>` | the follow-up is queued |

Health light **Follow-ups** (`followupHealth`, shape `{name: "followups", level, detail, fix}`, registered with stage
0's `registerLight`): **red** if any follow-up is more than 24 h overdue (queued `due_at`, or `next_followup_at` with
templates approved) · **amber** if templates aren't all approved while leads are waiting · **green** otherwise.
Detail in plain English, e.g. "3 follow-ups are a day late: mailbox nik@aetoswebsites.com is paused."; `fix` says what
to do ("Open Setup → Mailboxes and fix the paused mailbox." / "Approve them on the Voice page."; empty when green).

## A11. Perfect when

1. `node --test control-room/tests/followups.test.mjs` passes, including the worked example in A4 to the minute
   (BST→GMT), a GMT→BST case (Thu 25 Mar 2027 09:00 GMT → step 3 Mon 29 Mar 08:00Z), and the Saturday collision
   (Sat 24 Oct 10:00 BST → step 1 Mon 26 Oct 10:00Z, step 2 Tue 27 Oct 10:00Z).
2. End-to-end test (`tests/email-e2e.test.mjs`, fake SMTP = the `send` option of `dispatchDue`, ticking every 15
   simulated minutes for 75 days): first email + 9 follow-ups sent at the A4 times (each within 15 min), all with the
   same mailbox, subject "Re: …", `In-Reply-To` = root, growing `References`; lead `lost` with `sequence_done` at
   28 Dec.
3. Same test, with an inbound `human` message on day 3: steps 1–2 sent, nothing after, stage `replied`, no queued
   follow-ups left. Same for `opt_out` (→ `lost`, address in `suppression`) and `bounce`; a demo view on day 1 does not
   stop anything.
4. Capacity test: one mailbox with `cap_override` 10, Nik sends whenever `roomForFirsts` says ≥ 1 for 70 days: no UK
   day ever has more than 10 cold sends, and over days 61–70 the average is between 0.8 and 1.2 new businesses a day.
   With the cap cut to 5 mid-run, follow-ups go before first emails and none is skipped.
5. Every composer check in A3 returns its exact message (`first-email.test.mjs`), and Send is refused with 400 for each.
6. Follow-ups are not queued while any template is a draft; the `setup:followups` todo exists and closes when the 9th
   is approved.
7. The `style_examples` row appears only after the first email's status is `sent`, never on queue.
8. All repo test commands in overview §9 pass; `node --check` passes on `compose.js` and `voice.js`.
9. **Live:** a test lead with Nik's Gmail address and one with his Outlook address (inserted with
   `npx wrangler d1 execute goldbarwebsites --remote`), first email sent from the real mailbox: both land in the
   **inbox** (not spam/junk), show plain text, the one link opens the demo. mail-tester.com score ≥ 9/10 on the same
   email.
10. **Live:** set `next_followup_at` of both test prospects to now (same `wrangler d1 execute`): follow-up 1 arrives
    **in the same thread** in Gmail and Outlook; "Show original" shows `In-Reply-To` = the first email's Message-ID.
11. **Live:** Nik replies from Gmail on the test thread; within one tick the drawer shows "Follow-ups stopped: they
    replied" and no follow-up is queued.

---

# First email + follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nik composes and sends first emails from the lead drawer, and a pure, tested follow-up engine sends 9
threaded follow-ups on a fixed UK-time schedule with stop rules and capacity planning.

**Architecture:** Pure modules (`_lib/followups.js` schedule/capacity/stop/copy, `_lib/mail/rules.js` first-email
checks) hold every rule; db helpers in the same files read and write `prospects`, `messages`, `followup_templates`,
`style_examples`. Sending goes through stage 0's `queueMessage`/`dispatchDue`; the tick step `followups` syncs sent
messages, applies stops, closes finished sequences and queues due follow-ups. Two front-end files: `compose.js`
(composer + thread in the drawer) and `voice.js` (Voice page).

**Tech Stack:** Cloudflare Pages Functions (plain JS ES modules, no deps), D1, `node --test` with
`tests/helpers/fakeD1.mjs`, plain JS front end.

**Spec:** Part A of this file + docs/rebuild/00-overview.md

## Global Constraints

- Overview §9 applies in full (truth, escaping, copy rules, plain-text email, UTC storage, plain-English errors).
- Cold window: Mon–Sat 07:00–19:00 UK (`COLD_WINDOW`); follow-up time of day clamped to 07:00–18:59.
- Follow-up days: `[1, 2, 4, 7, 10, 17, 24, 30, 60]`; close as `lost` 7 days after step 9 is sent.
- First email: exactly one demo link, no other link, no "SEO", under 150 words, greeting added by the system.
- Follow-up templates: ≤ 60 words after `{greeting}`, placeholders only `{greeting}`, `{business}`, `{demo_link}`.
- Every prospect stage change goes through `applyStageEvent(DB, placeId, event, now, {lost_reason})` in
  `_lib/prospects.js` (stage 0), never a direct `nextStage` write.
- The `followups` tick step queues at most 3 follow-ups and handles at most 10 rows per other sub-step per run, and
  uses at most 18 D1 round trips (each `prepare().run/all/first`, `batch` and `queueMessage` counts one; writes in
  `DB.batch`). 3 per 5-minute tick = 36 an hour, far above need. The tick wraps `DB` in a counter and hands each step
  `ctx.budget` (stage 0's `runTick`); `followupsStep` uses at most `min(18, ctx.budget)` and leaves the remaining
  sub-steps for the next run when it's spent.
- Sign-offs and cold footers use the `business:sender_name` setting (`getSetting`), never the mailbox `display_name`.
- No tracking pixels, no link rewriting, no HTML part.
- Stored times are UTC ISO strings without milliseconds (`2026-10-23T08:15:00Z`, same as `util.now()`).
- Commit messages end with the two Co-Authored-By / Claude-Session lines from common rules.

## Review Focus

1. **Weekend first email** → two follow-ups on one Monday. Test `nextDue` Saturday collision (Task 1).
2. **Reply arrives before the sent-sync runs** → stage stuck or follow-up sent after a reply. Test in Task 7
   (`syncSent` with an inbound row already present).
3. **Double Send (double-click, two tabs)** → two first emails. Test in Task 9 (`sendFirst` twice → second
   `queued_already`, one message row).
4. **Pasted text** from Gmail/Word: smart quotes, a signature with "www.", a bare "greenleaf.co.uk", an email address,
   the raw demo URL pasted instead of the placeholder. Test in Task 5 (`findLinks` / `firstEmailIssues`).
5. **D1's 50-query limit per tick** with 40 due prospects. Test in Task 8 (counting round trips: ≤ 18, exactly 3
   queued, the rest on later runs).

---

### Task 1: Follow-up schedule (pure)

**Files:** Modify `control-room/functions/_lib/followups.js` (created by stage 3's Task 3; keep `followupsDueToday`
and its test `followups-due.test.mjs` unchanged). Test `control-room/tests/followups.test.mjs`.

**Interfaces:**
Consumes: `ukParts`, `ukDate`, `ukToUtc`, `addUkDays` from `_lib/ukTime.js`; the existing `followupsDueToday(DB, now)
→ Promise<number>` stays as stage 3 wrote it.
Produces:
`FOLLOWUP_DAYS = [1, 2, 4, 7, 10, 17, 24, 30, 60]`;
`COLD_WINDOW = {start: "07:00", end: "19:00", days: [1, 2, 3, 4, 5, 6]}`;
`CLOSE_AFTER_DAYS = 7`;
`schedule(firstSentAt: Date|string, step: 1..9) → Date`;
`nextDue(firstSentAt, step, lastSentAt: Date|string|null) → Date`.

- [ ] **Step 1: Write the failing test**
```js
test("schedule keeps UK time across BST→GMT and moves Sunday to Monday", () => {
  const first = "2026-10-22T08:15:00Z"; // Thu 09:15 BST
  const want = ["2026-10-23T08:15:00Z","2026-10-24T08:15:00Z","2026-10-26T09:15:00Z","2026-10-29T09:15:00Z",
    "2026-11-02T09:15:00Z","2026-11-09T09:15:00Z","2026-11-16T09:15:00Z","2026-11-21T09:15:00Z","2026-12-21T09:15:00Z"];
  want.forEach((iso, i) => assert.equal(schedule(first, i + 1).toISOString(), iso.replace("Z", ".000Z")));
});
test("GMT→BST", () => assert.equal(schedule("2027-03-25T09:00:00Z", 3).toISOString(), "2027-03-29T08:00:00.000Z"));
test("clamps time of day into 07:00–18:59", () => {
  assert.equal(schedule("2026-10-22T05:30:00Z", 1).toISOString(), "2026-10-23T06:00:00.000Z"); // 06:30 BST → 07:00
  assert.equal(schedule("2026-10-22T18:30:00Z", 1).toISOString(), "2026-10-23T17:59:00.000Z"); // 19:30 BST → 18:59
});
test("nextDue never puts two follow-ups on one UK day", () => {
  const sat = "2026-10-24T09:00:00Z"; // Sat 10:00 BST
  assert.equal(nextDue(sat, 1, sat).toISOString(), "2026-10-26T10:00:00.000Z");
  assert.equal(nextDue(sat, 2, "2026-10-26T10:00:00Z").toISOString(), "2026-10-27T10:00:00.000Z");
  assert.equal(nextDue(sat, 3, "2026-10-27T10:00:00Z").toISOString(), "2026-10-28T10:00:00.000Z");
});
test("nextDue moves past a slipped previous step", () =>
  assert.equal(nextDue("2026-10-22T08:15:00Z", 2, "2026-10-24T08:20:00Z").toISOString(), "2026-10-26T09:15:00.000Z"));
```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/followups.test.mjs` → fails: `followups.js` does not provide an export named `schedule`.
- [ ] **Step 3: Implement `schedule` and `nextDue` in `_lib/followups.js`** — `schedule`: UK date of `firstSentAt` +
  `FOLLOWUP_DAYS[step-1]` via `addUkDays`, clamped UK "HH:MM", +1 day if that UK date is a Sunday, `ukToUtc`.
  `nextDue`: `schedule(...)`; if its UK date ≤ UK date of `lastSentAt`, use the UK day after `lastSentAt` (Sunday → +1)
  at the same clamped time.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/followups.test.mjs control-room/tests/followups-due.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/followups.js control-room/tests/followups.test.mjs` +
  `git commit -m "Follow-up schedule in UK time (days 1-60, Sunday to Monday, no doubles)"`.

### Task 2: Capacity planning (pure)

**Files:** Modify `control-room/functions/_lib/followups.js`. Test `control-room/tests/followups.test.mjs`.

**Interfaces:**
Consumes: `schedule`, `nextDue` (Task 1); `mailboxCap(mailbox, ukDay)` from `_lib/mail/capacity.js`; `ukDate`.
Produces:
`firstEmailDays(firstAt) → string[10]` (UK days of the first email and its 9 follow-ups);
`loadByDay({cold: [{mailbox_id, at}], sequences: [{mailbox_id, first_at, step_done, next_at}]}, ukToday) → {[mailbox_id]: {[ukDay]: number}}`
(`cold` = sends already fixed to a time: sent today or queued; overdue `at` counts on `ukToday`; `sequences` =
follow-ups not yet queued, steps `step_done+1..9`, the first at `next_at` (if earlier than today, counts on today), later
ones by `nextDue`);
`roomFor(load, mailbox, firstAt) → {room: number, fullDay: string|null}` (`room` = min over `firstEmailDays` of
`mailboxCap(mailbox, day) − load`, floored at 0; `fullDay` = first day where that is ≤ 0).

- [ ] **Step 1: Write the failing test**
```js
const mb = { id: "m1", role: "cold", status: "active", cap_override: 10, started_on: "2026-01-01" };
test("firstEmailDays for a Thursday first email", () => assert.deepEqual(firstEmailDays("2026-10-22T08:15:00Z"),
  ["2026-10-22","2026-10-23","2026-10-24","2026-10-26","2026-10-29","2026-11-02","2026-11-09","2026-11-16","2026-11-21","2026-12-21"]));
test("ten firsts on one day fill every follow-up day", () => {
  const seqs = Array.from({ length: 10 }, () => ({ mailbox_id: "m1", first_at: "2026-10-22T08:15:00Z", step_done: 0, next_at: "2026-10-23T08:15:00Z" }));
  const cold = seqs.map(() => ({ mailbox_id: "m1", at: "2026-10-22T08:15:00Z" }));
  const load = loadByDay({ cold, sequences: seqs }, "2026-10-22");
  assert.equal(load.m1["2026-10-23"], 10);
  assert.equal(load.m1["2026-12-21"], 10);
  assert.deepEqual(roomFor(load, mb, "2026-10-22T09:00:00Z"), { room: 0, fullDay: "2026-10-22" });
  assert.deepEqual(roomFor(load, mb, "2026-10-27T09:00:00Z"), { room: 0, fullDay: "2026-10-29" }); // its day-2 follow-up hits Thu 29
});
test("overdue follow-ups count on today", () =>
  assert.equal(loadByDay({ cold: [], sequences: [{ mailbox_id: "m1", first_at: "2026-10-20T08:00:00Z", step_done: 0, next_at: "2026-10-21T08:00:00Z" }] }, "2026-10-22").m1["2026-10-22"], 1));
test("warm-up cap 0 means no room", () =>
  assert.equal(roomFor({}, { ...mb, cap_override: null, started_on: "2026-10-20" }, "2026-10-22T09:00:00Z").room, 0));
```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/followups.test.mjs` → `firstEmailDays is not a function`.
- [ ] **Step 3: Implement `firstEmailDays`, `loadByDay`, `roomFor` in `_lib/followups.js`.**
- [ ] **Step 4: Run tests to verify they pass** — → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/followups.js control-room/tests/followups.test.mjs` + `git commit -m "Capacity planning: a first email needs room on all 10 of its days"`.

### Task 3: Stop rules (pure)

**Files:** Modify `control-room/functions/_lib/followups.js`. Test `control-room/tests/followups.test.mjs`.

**Interfaces:**
Produces: `STOP_STAGES = ["replied", "needs_nik", "call_booked", "won", "lost"]`;
`stopReason(prospect: {stage, first_sent_at}, inbound: [{class, received_at}]) → null | "replied" | "opt_out" | "bounce" | "stage:<stage>"`
(opt_out beats bounce beats human reply beats stage; inbound before `first_sent_at` and class `auto` ignored).

- [ ] **Step 1: Write the failing test**
```js
const p = { stage: "emailed", first_sent_at: "2026-10-22T08:15:00Z" };
test("stop rules", () => {
  assert.equal(stopReason(p, []), null);
  assert.equal(stopReason({ ...p, stage: "viewed" }, []), null);
  assert.equal(stopReason(p, [{ class: "auto", received_at: "2026-10-23T09:00:00Z" }]), null);
  assert.equal(stopReason(p, [{ class: "human", received_at: "2026-10-21T09:00:00Z" }]), null);
  assert.equal(stopReason(p, [{ class: "human", received_at: "2026-10-25T09:00:00Z" }]), "replied");
  assert.equal(stopReason(p, [{ class: "human", received_at: "2026-10-25T09:00:00Z" }, { class: "opt_out", received_at: "2026-10-26T09:00:00Z" }]), "opt_out");
  assert.equal(stopReason(p, [{ class: "bounce", received_at: "2026-10-22T08:16:00Z" }]), "bounce");
  for (const s of STOP_STAGES) assert.equal(stopReason({ ...p, stage: s }, []), `stage:${s}`);
});
```
- [ ] **Step 2: Run it to verify it fails** — → `stopReason is not a function`.
- [ ] **Step 3: Implement `stopReason` in `_lib/followups.js`.**
- [ ] **Step 4: Run tests to verify they pass** — → PASS.
- [ ] **Step 5: Commit** — `git add …followups.js …followups.test.mjs` + `git commit -m "Follow-up stop rules"`.

### Task 4: Follow-up copy, checks and rendering (pure)

**Files:** Create `control-room/functions/_lib/mail/rules.js` (shared text helpers). Modify `_lib/followups.js`.
Test `control-room/tests/followups.test.mjs`.

**Interfaces:**
Produces in `_lib/mail/rules.js`: `wordCount(text) → number` (whitespace-separated, `{placeholder}` = 1);
`findLinks(text) → string[]` (http(s) URLs, `www.` hosts, bare domains with a TLD like `.com/.co.uk/.uk/.net/.org/.io/.biz/.info`,
email addresses); `businessName(name) → string` (port of legacy `cleanBusiness` from `legacy/control-room/functions/_lib/outreach.js`).
Produces in `_lib/followups.js`: `DRAFTS: {[step]: string}` (the 9 bodies in A6, verbatim);
`checkFollowup(body) → string[]` (plain-English issues, rules in A6);
`renderFollowup(body, {greeting, business, demoUrl}) → string`.

- [ ] **Step 1: Write the failing test**
```js
test("all 9 drafts pass the checks", () => {
  for (let s = 1; s <= 9; s++) assert.deepEqual(checkFollowup(DRAFTS[s]), [], `step ${s}`);
  assert.equal(DRAFTS[7].includes("{demo_link}"), false);
  assert.match(DRAFTS[9], /^\{greeting\}\n\nI'll leave it here/);
});
test("checkFollowup messages", () => {
  assert.deepEqual(checkFollowup("Hi,\n\nHello"), ['The first line must be {greeting} on its own.']);
  assert.ok(checkFollowup(`{greeting}\n\n${"word ".repeat(61)}`).includes("Too long: 61 words. Keep it to 60."));
  assert.ok(checkFollowup("{greeting}\n\nGreat SEO {demo_link}").includes('Don\'t say "SEO". Say "front page of Google" instead.'));
  assert.ok(checkFollowup("{greeting}\n\n{demo_link} and {demo_link}").includes("Use the demo link once at most."));
  assert.ok(checkFollowup("{greeting}\n\nSee www.example.com").includes("Only the demo link is allowed. Remove: www.example.com"));
  assert.ok(checkFollowup("{greeting}\n\nHi {town}").includes("{town} isn't filled in. Use {greeting}, {business} or {demo_link}."));
  assert.ok(checkFollowup("{greeting}\n\nOnly £249").includes("No prices in follow-ups: they change at weekends."));
  assert.ok(checkFollowup("{greeting}\n\nIt's guaranteed").includes("No guarantees in follow-ups: they're on the order page."));
  assert.ok(checkFollowup("{greeting}\n\nA? B?").includes("One question at most."));
});
test("renderFollowup", () => assert.equal(
  renderFollowup("{greeting}\n\nFor {business}: {demo_link}", { greeting: "Hi,", business: "Smith Roofing", demoUrl: "https://aetoswebsites.com/d/smith" }),
  "Hi,\n\nFor Smith Roofing: https://aetoswebsites.com/d/smith"));
test("findLinks", () => assert.deepEqual(findLinks("see greenleaf.co.uk or www.x.com, mail me@x.org, https://a.io/b ok. e.g. fine"),
  ["greenleaf.co.uk", "www.x.com", "me@x.org", "https://a.io/b"]));
test("businessName", () => assert.equal(businessName("SMITH ROOFING LTD - Roofer in Leeds"), "Smith Roofing"));
```
- [ ] **Step 2: Run it to verify it fails** — → `Cannot find module …/mail/rules.js`.
- [ ] **Step 3: Implement** `wordCount`, `findLinks`, `businessName` in `_lib/mail/rules.js`; `DRAFTS` (copy from A6
  exactly), `checkFollowup`, `renderFollowup` in `_lib/followups.js`. Exact issue strings are the ones in the test.
- [ ] **Step 4: Run tests to verify they pass** — → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/mail/rules.js …followups.js …followups.test.mjs` + `git commit -m "Follow-up wording drafts, checks and rendering"`.

### Task 5: First-email checks and rendering (pure)

**Files:** Modify `control-room/functions/_lib/mail/rules.js`. Test `control-room/tests/rules.test.mjs`.

**Interfaces:**
Consumes: `coldFooter(nikName)` from `_lib/mail/compose.js`.
Produces: `greetingFor(owner: {first, confident}|null) → {line: "Hi Mark," | "Hi,", name: "Mark" | null}`;
`firstEmailIssues({subject, body, demoUrl}) → [{code, message}]` (text-only codes from A3: `subject_missing`,
`subject_re`, `body_missing`, `greeting`, `demo_missing`, `demo_twice`, `other_link`, `seo`, `too_long`, `placeholder`);
`renderFirstEmail({greetingLine, body, demoUrl, nikName}) → string` (greeting, blank line, body trimmed with
`{demo_link}` → URL, blank line, `coldFooter(nikName)`);
`stripFooter(text, nikName) → string`.

- [ ] **Step 1: Write the failing test**
```js
const demoUrl = "https://aetoswebsites.com/d/green-leaf";
const ok = { subject: "Your website", body: "I made you a site: {demo_link}\nHave a look.", demoUrl };
const codes = (x) => firstEmailIssues({ ...ok, ...x }).map((i) => i.code);
test("greeting rule", () => {
  assert.deepEqual(greetingFor({ first: "mark", confident: true }), { line: "Hi Mark,", name: "Mark" });
  assert.deepEqual(greetingFor({ first: "Mark", confident: false }), { line: "Hi,", name: null });
  assert.deepEqual(greetingFor(null), { line: "Hi,", name: null });
});
test("clean email passes", () => assert.deepEqual(codes({}), []));
test("each check", () => {
  assert.deepEqual(codes({ subject: " " }), ["subject_missing"]);
  assert.deepEqual(codes({ subject: "Re: your site" }), ["subject_re"]);
  assert.deepEqual(codes({ body: "Hi Mark,\nI made you a site: {demo_link}" }), ["greeting"]);
  assert.deepEqual(codes({ body: "No link here" }), ["demo_missing"]);
  assert.deepEqual(codes({ body: `{demo_link} ${demoUrl}` }), ["demo_twice"]);
  assert.deepEqual(codes({ body: `Here: ${demoUrl}` }), []);                       // raw URL pasted counts as the link
  assert.deepEqual(codes({ body: "{demo_link}\n--\nNik | www.aetoswebsites.com" }), ["other_link"]);
  assert.deepEqual(codes({ body: "{demo_link} or email nik@aetoswebsites.com" }), ["other_link"]);
  assert.deepEqual(codes({ body: "{demo_link} better seo" }), ["seo"]);
  assert.deepEqual(codes({ body: `{demo_link} ${"word ".repeat(149)}` }), ["too_long"]);
  assert.deepEqual(codes({ body: `{demo_link} ${"word ".repeat(148)}` }), []);
  assert.deepEqual(codes({ body: "{demo_link} for {business}" }), ["placeholder"]);
  assert.deepEqual(codes({ body: "I’ve made you a site “for you”: {demo_link}" }), []);
});
test("messages are plain English", () => assert.equal(
  firstEmailIssues({ ...ok, body: "{demo_link} see greenleaf.co.uk" })[0].message, "Only the demo link is allowed. Remove: greenleaf.co.uk"));
test("render + strip footer", () => {
  const text = renderFirstEmail({ greetingLine: "Hi,", body: "  Look: {demo_link}  ", demoUrl, nikName: "Nik" });
  assert.ok(text.startsWith(`Hi,\n\nLook: ${demoUrl}\n\n`));
  assert.ok(text.endsWith(coldFooter("Nik")));
  assert.equal(stripFooter(text, "Nik"), `Hi,\n\nLook: ${demoUrl}`);
});
```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/rules.test.mjs` → `greetingFor is not a function`.
- [ ] **Step 3: Implement the four functions in `_lib/mail/rules.js`** — messages exactly as in the A3 table; the demo
  URL is removed before `findLinks` so the pasted raw URL never counts as "another link".
- [ ] **Step 4: Run tests to verify they pass** — → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/mail/rules.js control-room/tests/rules.test.mjs` + `git commit -m "First email checks: one demo link, no SEO, under 150 words"`.

### Task 6: Templates and capacity from the database

**Files:** Modify `control-room/functions/_lib/followups.js`, `control-room/functions/_lib/shortlist-db.js` (stage 3's
`capacityNow`). Test `control-room/tests/followups-db.test.mjs`.

**Interfaces:**
Consumes: `fakeD1()` from `tests/helpers/fakeD1.mjs`; `mailboxCap`; `addTodo`, `closeTodos`; Task 2 functions;
stage 3's `capacityNow(DB, now)` and seed helpers (`tests/helpers/shortlistSeed.mjs`).
Produces:
`ensureTemplates(DB) → Promise<void>` (INSERT OR IGNORE the 9 `DRAFTS` with `day_offset` from `FOLLOWUP_DAYS`, status `draft`);
`followupsApproved(DB) → Promise<{approved: number, all: boolean}>`;
`planningRows(DB, now) → Promise<{cold, sequences}>` (cold: messages kind first/followup sent today (UK) or queued/sending;
sequences: prospects in `emailed`/`viewed` with `followup_step < 9` and `next_followup_at` set, plus every queued
first email projected as `{first_at: due_at, step_done: 0, next_at: null}`);
`roomForFirsts(DB, now) → Promise<{day, total, byMailbox: {[id]: {room, fullDay}}}>` (day = UK day of the next send:
today inside the window, else the next window start);
`followupsDueByMailbox(DB, now) → Promise<{total, byMailbox: {[id]: number}}>` (queued follow-ups due by end of UK
today + pending `next_followup_at` by end of today with `followup_step < 9`; stage 3's `followupsDueToday` is left as
it is);
modified stage 3 `capacityNow(DB, now)`: `room = min(<stage 3's formula>, (await roomForFirsts(DB, now)).total)`, so
the Leads banner never offers more first emails than Send allows (the banner text itself is unchanged).

- [ ] **Step 1: Write the failing test**
```js
test("ensureTemplates seeds 9 drafts once", async () => {
  const DB = fakeD1();
  await ensureTemplates(DB); await ensureTemplates(DB);
  const rows = (await DB.prepare("SELECT step, day_offset, status FROM followup_templates ORDER BY step").all()).results;
  assert.deepEqual(rows.map((r) => r.day_offset), [1, 2, 4, 7, 10, 17, 24, 30, 60]);
  assert.ok(rows.every((r) => r.status === "draft"));
  assert.deepEqual(await followupsApproved(DB), { approved: 0, all: false });
});
test("roomForFirsts and followupsDueByMailbox", async () => {
  const DB = fakeD1();
  await insertMailbox(DB, { id: "m1", cap_override: 10 });              // test helper in this file
  await insertProspect(DB, { place_id: "p1", stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-21T08:00:00Z",
    followup_step: 0, next_followup_at: "2026-10-22T08:00:00Z" });
  const now = new Date("2026-10-22T10:00:00Z");
  assert.deepEqual(await followupsDueByMailbox(DB, now), { total: 1, byMailbox: { m1: 1 } });
  assert.equal(await followupsDueToday(DB, now), 1);                    // stage 3's number is unchanged
  const r = await roomForFirsts(DB, now);
  assert.equal(r.day, "2026-10-22");
  assert.equal(r.byMailbox.m1.room, 9);
  assert.equal(r.total, 9);
});
test("outside the window the day is the next window start", async () => {
  const DB = fakeD1(); await insertMailbox(DB, { id: "m1", cap_override: 10 });
  assert.equal((await roomForFirsts(DB, new Date("2026-10-24T19:30:00Z"))).day, "2026-10-26"); // Sat 20:30 BST → Mon
});
test("capacityNow never offers more than roomForFirsts", async () => {
  const DB = fakeD1(); await insertMailbox(DB, { id: "m1", cap_override: 10 });
  for (let i = 0; i < 10; i++)                                           // Mon firsts, steps 1–2 sent, step 3 due Fri
    await insertProspect(DB, { place_id: `p${i}`, stage: "emailed", mailbox_id: "m1", first_sent_at: "2026-10-19T08:00:00Z",
      followup_step: 2, next_followup_at: "2026-10-23T08:00:00Z" });
  const now = new Date("2026-10-22T10:00:00Z");                         // Thu: nothing due today, Friday is full
  assert.equal((await roomForFirsts(DB, now)).total, 0);
  assert.equal((await capacityNow(DB, now)).room, 0);                    // stage 3's formula alone would say 10
});
```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/followups-db.test.mjs` → `ensureTemplates is not a function`.
- [ ] **Step 3: Implement the five functions** (two SELECTs for `planningRows`, then the pure Task 2 functions), then
  change `capacityNow` in `_lib/shortlist-db.js` to take `min(room, (await roomForFirsts(DB, now)).total)`.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/followups-db.test.mjs control-room/tests/followups-due.test.mjs control-room/tests/shortlist-db.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add …followups.js control-room/functions/_lib/shortlist-db.js control-room/tests/followups-db.test.mjs` + `git commit -m "Follow-up templates seed and mailbox room from the database"`.

### Task 7: Sync sent messages and stop sequences (db)

**Files:** Modify `control-room/functions/_lib/followups.js`. Test `control-room/tests/followups-db.test.mjs`.

**Interfaces:**
Consumes: `applyStageEvent(DB, placeId, event, now, {lost_reason} = {}) → Promise<{from, to}|null>` from
`_lib/prospects.js` (stage 0); `schedule`, `nextDue`, `stopReason`, `CLOSE_AFTER_DAYS`; `stripFooter`; `closeTodos`;
`getSetting` (`business:sender_name`, for `stripFooter`).
Produces:
`stopFollowups(DB, placeId, reason, now) → Promise<number>` (sets `next_followup_at` NULL, `updated_at`; cancels this
lead's `queued` follow-ups; returns how many were cancelled);
`syncSent(DB, now, {limit = 10}) → Promise<{firsts: number, followups: number, stopped: number}>`;
`sweepStops(DB, now, {limit = 10}) → Promise<number>` (prospects with `next_followup_at` set or a queued follow-up for
which `stopReason` is non-null → `stopFollowups`).

- [ ] **Step 1: Write the failing test**
```js
test("first email sent → emailed, schedule, style example", async () => {
  const DB = fakeD1(); await seedReady(DB, "p1");                       // prospect 'ready', mailbox m1, display_name "Nik"
  await insertMessage(DB, { id: "x1", place_id: "p1", kind: "first", author: "nik", status: "sent", message_id: "<a@aetoswebsites.com>",
    sent_at: "2026-10-22T08:15:00Z", body: `Hi,\n\nLook: https://d\n\n${coldFooter("Nik")}` });
  assert.deepEqual(await syncSent(DB, new Date("2026-10-22T08:20:00Z")), { firsts: 1, followups: 0, stopped: 0 });
  const p = await getProspect(DB, "p1");
  assert.equal(p.stage, "emailed");
  assert.equal(p.root_message_id, "<a@aetoswebsites.com>");
  assert.equal(p.next_followup_at, "2026-10-23T08:15:00Z");
  const ex = await DB.prepare("SELECT * FROM style_examples WHERE id = 'sent:x1'").first();
  assert.equal(ex.source, "nik_sent"); assert.equal(ex.body, "Hi,\n\nLook: https://d");
  assert.deepEqual(await syncSent(DB, new Date("2026-10-22T08:25:00Z")), { firsts: 0, followups: 0, stopped: 0 }); // idempotent
});
test("queued first email does not save a style example", async () => { /* status 'queued' → no style_examples row, stage 'ready' */ });
test("reply that landed before the sync stops at once", async () => {
  const DB = fakeD1(); await seedReady(DB, "p1");
  await insertMessage(DB, { id: "x1", place_id: "p1", kind: "first", status: "sent", sent_at: "2026-10-22T08:15:00Z", message_id: "<a@x>" });
  await insertMessage(DB, { id: "i1", place_id: "p1", direction: "in", kind: "inbound", author: "them", class: "human", status: "received", received_at: "2026-10-22T08:17:00Z" });
  const r = await syncSent(DB, new Date("2026-10-22T08:20:00Z"));
  assert.equal(r.stopped, 1);
  const p = await getProspect(DB, "p1");
  assert.equal(p.stage, "replied"); assert.equal(p.next_followup_at, null); assert.equal(p.first_sent_at, "2026-10-22T08:15:00Z");
});
test("follow-up 9 sent → close time is 7 days later", async () => { /* step 9 sent 2026-12-21T09:15:00Z → followup_step 9, next_followup_at 2026-12-28T09:15:00Z */ });
test("sweepStops cancels queued follow-ups on opt-out, not on a demo view", async () => {
  /* prospect 'viewed' with a queued step-3 follow-up: sweepStops → 0 and still queued;
     add inbound class 'opt_out' → sweepStops → 1, message status 'cancelled', next_followup_at null */
});
```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/followups-db.test.mjs` → `syncSent is not a function`.
- [ ] **Step 3: Implement `stopFollowups`, `syncSent`, `sweepStops`** — `syncSent` handles firsts (`first_sent_at IS
  NULL`) then follow-ups (`followup_step < step`), loads inbound for those leads in one query, calls
  `applyStageEvent(DB, place_id, "first_sent", now)` then the stop's stage event (`inbound_human` / `opt_out` /
  `bounce`) with `applyStageEvent` (stage 0 sets `lost_reason` to the event name for `opt_out`/`bounce`); a sent
  follow-up also closes `health:followup-fail:<place_id>`. Its own column writes (`first_sent_at`,
  `root_message_id`, `followup_step`, `next_followup_at`, the style example) go in one `DB.batch`.
- [ ] **Step 4: Run tests to verify they pass** — → PASS.
- [ ] **Step 5: Commit** — `git add …followups.js …followups-db.test.mjs` + `git commit -m "Mark leads emailed when the send succeeds; stop follow-ups on replies"`.

### Task 8: The `followups` tick step

**Files:** Modify `control-room/functions/_lib/followups.js`, `control-room/functions/_lib/tick.js`. Test
`control-room/tests/followups-db.test.mjs`.

**Interfaces:**
Consumes: `queueMessage(DB, msg)`; `demoReady(DB, placeId) → Promise<{ok, url, reason}>` (stage 4); `addTodo`,
`closeTodos`; `businessName`; `renderFollowup`; `coldFooter`; `nextUkWindowStart`, `addUkDays`, `ukToUtc`.
Produces:
`retryFailed(DB, now, {limit = 10}) → Promise<number>` (leads in `emailed`/`viewed`, `next_followup_at` NULL, whose
latest message for step `followup_step + 1` is `failed`: fewer than 3 failed attempts → `next_followup_at` = next
day's 07:00 UK (Sunday → Monday); 3 → `stopFollowups` + `health` todo `health:followup-fail:<place_id>`);
`closeFinished(DB, now, {limit = 10}) → Promise<number>` (`followup_step = 9` and `next_followup_at ≤ now` →
`sequence_done`, `lost_reason` "sequence_done");
`queueDue(DB, now, {limit = 3}) → Promise<{queued: number, held: string|null}>`;
`followupsStep(ctx: {DB, env, now}) → Promise<string>` (runs `ensureTemplates`, `syncSent`, `sweepStops`,
`retryFailed`, `closeFinished`, `queueDue`; summary like `"synced 1, stopped 0, retried 0, closed 0, queued 2"` or
`"waiting: follow-ups 6/9 approved"`);
tick.js `STEPS` entry `{name: "followups", everyMinutes: 5, run: followupsStep}` at position 3 (after `reply_fire`,
before `send`).

`queueDue` rules: if not all 9 templates approved → queue nothing, `addTodo(DB, {kind: "setup", title: "Approve your 9
follow-up emails", link: "/#/voice", dedupe: "setup:followups"})`, return `held: "templates"`. Else for each lead with
`stage IN ('emailed','viewed')`, `followup_step < 9`, `next_followup_at ≤ now` (oldest first, `limit`): `demoReady`
not ok → `health` todo `health:followup-demo:<place_id>` "Follow-ups to <business> are on hold: their demo isn't
available (<reason>)." and skip; ok → `queueMessage` with `kind "followup"`, `step`, `author "system"`, same
`mailbox_id`, `to_addr` = `prospects.email`, `subject` "Re: " + subject, `body` = `renderFollowup(...)` + "\n\n" +
`coldFooter(display_name)`, new `message_id`, `in_reply_to` = root, `refs` = root + sent follow-ups' ids,
`due_at` = `next_followup_at`; then `next_followup_at` NULL and close `health:followup-demo:<place_id>`.

- [ ] **Step 1: Write the failing test**
```js
test("nothing queued until all 9 approved; setup todo added", async () => {
  const DB = await dueLead("p1", "2026-10-23T08:15:00Z");               // emailed, step 0, next_followup_at in the past
  const out = await followupsStep({ DB, env: {}, now: new Date("2026-10-23T08:20:00Z") });
  assert.equal(out, "waiting: follow-ups 0/9 approved");
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM messages WHERE kind='followup'").first()).n, 0);
  assert.ok(await DB.prepare("SELECT 1 FROM todos WHERE dedupe='setup:followups' AND status='open'").first());
});
test("queues a threaded follow-up 1", async () => {
  const DB = await dueLead("p1", "2026-10-23T08:15:00Z"); await approveAll(DB);
  await followupsStep({ DB, env: {}, now: new Date("2026-10-23T08:20:00Z") });
  const m = await DB.prepare("SELECT * FROM messages WHERE kind='followup'").first();
  assert.equal(m.step, 1); assert.equal(m.subject, "Re: Your website"); assert.equal(m.mailbox_id, "m1");
  assert.equal(m.in_reply_to, "<root@aetoswebsites.com>"); assert.equal(m.refs, "<root@aetoswebsites.com>");
  assert.match(m.body, /^Hi Mark,\n\nIn case my last email got buried: I made a new website for Green Leaf Landscapes/);
  assert.ok(m.body.endsWith(coldFooter("Nik")));
  assert.equal((await getProspect(DB, "p1")).next_followup_at, null);
});
test("demo not ready holds the follow-up with a health todo", async () => { /* demoReady stub {ok:false, reason:"template not approved"} → 0 queued, todo health:followup-demo:p1 */ });
test("a failed follow-up is retried next day, stopped after 3", async () => { /* 1 failed → next_followup_at 07:00 UK next day; 3 failed → stopped + health todo */ });
test("step 9 + 7 days → lost/sequence_done", async () => { /* followup_step 9, next_followup_at past → stage 'lost', lost_reason 'sequence_done' */ });
test("bounded work: 40 due leads, ≤ 18 D1 round trips, 3 queued", async () => {
  const DB = await manyDue(40); await approveAll(DB);
  const counted = countingDB(DB);                                        // wraps prepare() and batch() with a counter
  await followupsStep({ DB: counted, env: {}, now: new Date("2026-10-23T08:20:00Z") });
  assert.ok(counted.calls <= 18, `used ${counted.calls}`);
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM messages WHERE kind='followup'").first()).n, 3);
});
```
(`demoReady` is injected for tests: `followupsStep(ctx, {demoReady})` defaulting to stage 4's import; one `demoReady`
call per lead queued, at most 3 per run, inside the 18-round-trip budget.)
- [ ] **Step 2: Run it to verify it fails** — → `followupsStep is not a function`.
- [ ] **Step 3: Implement `retryFailed`, `closeFinished`, `queueDue`, `followupsStep`; add the STEPS entry in `tick.js`.**
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/followups-db.test.mjs control-room/tests/tick.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add …followups.js control-room/functions/_lib/tick.js …followups-db.test.mjs` + `git commit -m "Tick step: queue due follow-ups, retry, close finished sequences"`.

### Task 9: Composer logic (db)

**Files:** Create `control-room/functions/_lib/composer.js`. Test `control-room/tests/composer.test.mjs`.

**Interfaces:**
Consumes: `greetingFor`, `firstEmailIssues`, `renderFirstEmail`, `businessName`; `roomForFirsts`, `planningRows`,
`loadByDay`, `roomFor`, `COLD_WINDOW`, `followupsApproved`; `pickMailbox`, `mailboxCap`, `rampCap`;
`makeMessageId`, `coldFooter`; `queueMessage`; `demoReady`; `inUkWindow`, `nextUkWindowStart`, `ukDate`, `addUkDays`.
Produces:
`composeContext(DB, placeId, now) → Promise<{business, to_options: [{email, where, source_url, best}], greeting: {line, name},
angle: [{fact, source_url}], opener, demo: {ok, url, reason}, due_at, mailbox: {id, address, display_name}|null,
blocking: [{code, message}], followups_approved: boolean, stage, first_message_id|null}>`
(`blocking` = the A3 db-side checks: `no_prospect`, `demo_not_ready`, `no_mailbox`, `warming_up`, `no_room`,
`already_emailed`, `queued_already`);
`previewFirst(ctx, {to, subject, body}) → {text, from, issues: [{code, message}]}` (pure on the context: text checks +
`not_in_list` + `blocking`);
`sendChecks(DB, ctx, to) → Promise<[{code, message}]>` (`suppressed`, `shared_address`);
`sendFirst(DB, placeId, {to, subject, body}, now) → Promise<{ok: true, id, due_at} | {ok: false, status: 400|409, issues}>`.

- [ ] **Step 1: Write the failing test**
```js
const input = { to: "mark@greenleaf.co.uk", subject: "Your website", body: "I made you a site: {demo_link}" };
test("send queues one first email and keeps the lead ready", async () => {
  const DB = await readyLead();                                          // research, prospect 'ready', mailbox m1 cap 10, demo ok
  const r = await sendFirst(DB, "p1", input, new Date("2026-10-22T08:15:00Z"));
  assert.equal(r.ok, true); assert.equal(r.due_at, "2026-10-22T08:15:00Z");
  const m = await DB.prepare("SELECT * FROM messages WHERE id = ?").bind(r.id).first();
  assert.equal(m.kind, "first"); assert.equal(m.author, "nik"); assert.equal(m.status, "queued"); assert.match(m.message_id, /@aetoswebsites\.com>$/);
  assert.equal(m.body, `Hi Mark,\n\nI made you a site: https://aetoswebsites.com/d/green-leaf\n\n${coldFooter("Nik")}`);
  const p = await getProspect(DB, "p1");
  assert.equal(p.stage, "ready"); assert.equal(p.subject, "Your website"); assert.equal(p.greet_name, "Mark"); assert.equal(p.mailbox_id, "m1");
  assert.equal(await DB.prepare("SELECT COUNT(*) n FROM style_examples").first().then((x) => x.n), 0);
});
test("second send is refused", async () => {
  const DB = await readyLead(); const now = new Date("2026-10-22T08:15:00Z");
  await sendFirst(DB, "p1", input, now);
  const r = await sendFirst(DB, "p1", input, now);
  assert.equal(r.status, 409); assert.equal(r.issues[0].code, "queued_already");
  assert.equal((await DB.prepare("SELECT COUNT(*) n FROM messages").first()).n, 1);
});
test("outside the window it is due at the next window start", async () =>
  assert.equal((await sendFirst(await readyLead(), "p1", input, new Date("2026-10-25T10:00:00Z"))).due_at, "2026-10-26T07:00:00Z"));
test("each db check has its exact message", async () => {
  assert.equal(await issueFor({ suppress: { value: "mark@greenleaf.co.uk", reason: "opt_out", created_at: "2026-11-03T10:00:00Z" } }),
    "mark@greenleaf.co.uk is on your do-not-email list (opted out on 3 Nov). You can't email it.");
  assert.equal(await issueFor({ suppress: { value: "greenleaf.co.uk", kind: "domain", reason: "bounce", created_at: "2026-11-03T10:00:00Z" } }),
    "mark@greenleaf.co.uk is on your do-not-email list (bounced on 3 Nov). You can't email it.");
  assert.equal(await issueFor({ to: "typo@x.com" }), "Pick an address from the list.");
  assert.equal(await issueFor({ otherProspectEmail: "mark@greenleaf.co.uk" }), "mark@greenleaf.co.uk is already being emailed as Other Ltd.");
  assert.equal(await issueFor({ stage: "emailed", first_sent_at: "2026-10-22T08:15:00Z" }), "You've already emailed Green Leaf Landscapes on 22 Oct. The thread is below.");
  assert.equal(await issueFor({ demo: { ok: false, reason: "the landscaper template isn't approved yet" } }), "Their demo isn't ready: the landscaper template isn't approved yet. Fix it on the Demo card first.");
  assert.equal(await issueFor({ mailbox: null }), "No mailbox is set up for cold email yet. Add one on Setup → Mailboxes.");
  assert.equal(await issueFor({ mailbox: { started_on: "2026-10-20", cap_override: null } }), "Your mailbox is still warming up: cold emails can start on Tue 3 Nov.");
  assert.equal(await issueFor({ fullOn: "2026-11-09" }), "Your mailboxes are full on Mon 9 Nov (follow-ups already booked that day). Send this one tomorrow.");
  assert.equal(await issueFor({ noProspect: true }), "This lead isn't ready to email yet: it needs a grade, an email and a demo first.");
});
test("greeting falls back to Hi, when the owner isn't confident", async () => { /* owner.confident false → body starts "Hi,\n\n", greet_name null */ });
```
(`issueFor(setup)` is a local helper: builds `readyLead()` with the change and returns the first issue's message.)
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/composer.test.mjs` → `Cannot find module …/composer.js`.
- [ ] **Step 3: Implement the four functions in `_lib/composer.js`** — `sendFirst` re-runs every check server-side,
  then claims the lead with `UPDATE prospects SET email, greet_name, mailbox_id, subject, updated_at WHERE place_id = ?
  AND stage = 'ready' AND NOT EXISTS (SELECT 1 FROM messages WHERE place_id = ? AND kind = 'first' AND status IN
  ('queued','sending','sent'))`; `meta.changes === 0` → 409 `queued_already`; then `queueMessage`. To options come from
  `research.emails` + `research.best_email`, lower-cased and de-duplicated.
- [ ] **Step 4: Run tests to verify they pass** — → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/composer.js control-room/tests/composer.test.mjs` + `git commit -m "Composer: checks, mailbox pick and queueing Nik's first email"`.

### Task 10: Compose routes

**Files:** Create `control-room/functions/api/compose/[id]/index.js` (GET), `control-room/functions/api/compose/[id]/preview.js`
(POST), `control-room/functions/api/compose/[id]/send.js` (POST). Test `control-room/tests/compose-routes.test.mjs`.

**Interfaces:**
Consumes: Task 9; `db`, `json`, `bad` from `_lib/util.js`; `runTick(env, reason)`.
Produces: `GET /api/compose/:place_id` → `composeContext` JSON; `POST /api/compose/:place_id/preview {to, subject,
body}` → `{text, from, issues}` (always 200); `POST /api/compose/:place_id/send {to, subject, body}` → 200 `{id,
due_at}` | 400/409 `{error: issues[0].message, issues}`; send calls `context.waitUntil(runTick(env, "compose"))`.

- [ ] **Step 1: Write the failing test**
```js
test("send route returns plain-English 400 and nudges the tick", async () => {
  const { env, waits } = await routeEnv();                               // fakeD1 + ready lead; waitUntil recorder
  const bad1 = await onRequestPost({ env, params: { id: "p1" }, request: post({ to: "mark@greenleaf.co.uk", subject: "Hi", body: "no link" }), waitUntil: waits.push.bind(waits) });
  assert.equal(bad1.status, 400);
  assert.equal((await bad1.json()).error, "Add the demo link: press Insert demo link.");
  const ok = await onRequestPost({ env, params: { id: "p1" }, request: post({ to: "mark@greenleaf.co.uk", subject: "Your website", body: "{demo_link}" }), waitUntil: waits.push.bind(waits) });
  assert.equal(ok.status, 200); assert.equal(waits.length, 1);
});
test("preview renders the full text", async () => { /* body "{demo_link}" → text "Hi Mark,\n\nhttps://aetoswebsites.com/d/green-leaf\n\n" + coldFooter("Nik"), issues [] */ });
```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/compose-routes.test.mjs` → module not found.
- [ ] **Step 3: Implement the three handlers** (`onRequestGet`, `onRequestPost` ×2), thin wrappers over Task 9.
- [ ] **Step 4: Run tests to verify they pass** — → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/api/compose control-room/tests/compose-routes.test.mjs` + `git commit -m "Compose API: context, live preview, send"`.

### Task 11: Thread, cancel and retry

**Files:** Create `control-room/functions/_lib/thread.js`, `control-room/functions/api/thread/[id].js`,
`control-room/functions/api/messages/[id]/cancel.js`, `control-room/functions/api/messages/[id]/retry.js`. Test
`control-room/tests/thread.test.mjs`.

**Interfaces:**
Consumes: `nextDue`, `CLOSE_AFTER_DAYS`, `stopReason`, `followupsApproved`; `sendChecks`, `roomForFirsts`;
`queueMessage`, `makeMessageId`.
Produces:
`threadSummary(prospect, {approved, held}) → string` (pure; the A8 summary lines verbatim);
`loadThread(DB, placeId, now) → Promise<{summary, messages: [{id, direction, kind, step, author, subject, body, status,
due_at, sent_at, received_at, error, class}]}>`;
`cancelMessage(DB, id, now) → Promise<{ok, error?}>` (only `status = 'queued'` and `direction = 'out'`; follow-up step
k → `followup_step = k`, `next_followup_at` = `nextDue(first, k+1, now)` or now + 7 days when k = 9);
`retryFirst(DB, id, now) → Promise<{ok, id?, due_at?, error?}>` (only a `failed` first email on a `ready` lead);
routes: `GET /api/thread/:place_id`, `POST /api/messages/:id/cancel`, `POST /api/messages/:id/retry`.

- [ ] **Step 1: Write the failing test**
```js
test("summary lines", () => {
  assert.equal(threadSummary({ stage: "emailed", followup_step: 2, next_followup_at: "2026-10-26T09:15:00Z" }, { approved: true }), "Follow-up 3 of 9: Mon 26 Oct 09:15");
  assert.equal(threadSummary({ stage: "replied" }, { approved: true }), "Follow-ups stopped: they replied");
  assert.equal(threadSummary({ stage: "lost", lost_reason: "opt_out" }, { approved: true }), "Follow-ups stopped: they opted out");
  assert.equal(threadSummary({ stage: "emailed", followup_step: 9, next_followup_at: "2026-12-28T09:15:00Z" }, { approved: true }), "Follow-ups finished: marked lost on Mon 28 Dec if no reply");
  assert.equal(threadSummary({ stage: "emailed", followup_step: 0, next_followup_at: "2026-10-23T08:15:00Z" }, { approved: false }), "Follow-ups paused: approve your follow-up emails on the Voice page");
});
test("cancel a queued follow-up skips that step", async () => { /* step 3 queued → cancelled; followup_step 3; next_followup_at = nextDue(first, 4, now) */ });
test("cancel refuses a sent message", async () => { /* → {ok:false, error:"This email has already gone, so it can't be cancelled."} */ });
test("cancel a queued first email leaves the lead ready", async () => { /* status cancelled, stage ready, composeContext.blocking has no queued_already */ });
test("retry re-queues a failed first email with a new Message-ID", async () => { /* new row queued, different message_id, old row still failed */ });
```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/thread.test.mjs` → module not found.
- [ ] **Step 3: Implement `_lib/thread.js` and the three routes.** UK times formatted with `ukParts`.
- [ ] **Step 4: Run tests to verify they pass** — → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/thread.js control-room/functions/api/thread control-room/functions/api/messages control-room/tests/thread.test.mjs` + `git commit -m "Thread view API, cancel queued emails, retry a failed first email"`.

### Task 12: Voice API

**Files:** Create `control-room/functions/api/voice/index.js` (GET), `control-room/functions/api/voice/followups/[step]/index.js`
(PUT), `control-room/functions/api/voice/followups/[step]/approve.js` (POST), `control-room/functions/api/voice/examples/index.js`
(POST), `control-room/functions/api/voice/examples/[id].js` (DELETE). Test `control-room/tests/voice.test.mjs`.

**Interfaces:**
Consumes: `ensureTemplates`, `checkFollowup`, `renderFollowup`, `followupsApproved`, `businessName`; `closeTodos`.
Produces: `GET /api/voice` → `{templates: [{step, day_offset, body, status, approved_at, issues, preview}], examples:
[{id, kind, situation, body, source, created_at}], has_price_reply: boolean}` (preview uses the newest prospect with a
demo, else the A7 sample); `PUT /api/voice/followups/:step {body}` → saves, status `draft`, `approved_at` NULL,
returns `{template}`; `POST …/approve` → 400 `{error}` if `checkFollowup` has issues, else `approved`, and when all 9
are approved `closeTodos(DB, "setup:followups")`; `POST /api/voice/examples {kind, situation, body}` (kind `example`
or `rule`, situation and body non-empty, body ≤ 2,000 chars) → `{example}` with `source` "nik_written";
`DELETE /api/voice/examples/:id`.

- [ ] **Step 1: Write the failing test**
```js
test("approve all 9 closes the setup todo; editing makes a draft again", async () => {
  const { env } = await voiceEnv();                                      // fakeD1 + open setup:followups todo
  for (let s = 1; s <= 9; s++) assert.equal((await approve(env, s)).status, 200);
  assert.equal((await env.DB.prepare("SELECT status FROM todos WHERE dedupe='setup:followups'").first()).status, "done");
  await put(env, 4, { body: DRAFTS[4] });
  assert.deepEqual(await followupsApproved(env.DB), { approved: 8, all: false });
});
test("approve refuses a body that fails the checks", async () => {
  const { env } = await voiceEnv(); await put(env, 1, { body: "{greeting}\n\nBetter SEO" });
  const r = await approve(env, 1);
  assert.equal(r.status, 400); assert.equal((await r.json()).error, 'Don\'t say "SEO". Say "front page of Google" instead.');
});
test("examples: add, has_price_reply, delete", async () => { /* add situation "they ask the price" → GET has_price_reply true; DELETE → gone */ });
test("bad example input", async () => { /* kind "x" → 400 "Pick Example reply or Rule."; empty body → 400 "Write the text first." */ });
```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/voice.test.mjs` → module not found.
- [ ] **Step 3: Implement the five handlers.**
- [ ] **Step 4: Run tests to verify they pass** — → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/api/voice control-room/tests/voice.test.mjs` + `git commit -m "Voice API: approve follow-ups, Nik's style examples"`.

### Task 13: Composer and thread in the lead drawer (front end)

**Files:** Create `control-room/public/js/compose.js`. Modify `control-room/public/js/leads.js` (drawer mount point
`<div id="d-email"></div>` under the demo card; call `mountEmail`), `control-room/public/style.css` (`.compose`,
`.compose-help`, `.preview-mail`, `.checks`, `.thread`, `.msg`, `.badge.you/.claude/.system/.them`). Test
`control-room/tests/compose-ui.test.mjs`.

**Interfaces:**
Consumes: `api`, `esc`, `safeUrl`, `toast`, `modal` from `public/js/lib.js`; the Task 10 and 11 routes.
Produces: `mountEmail(el: HTMLElement, placeId: string) → Promise<void>` (composer when `stage === "ready"` and no
first email queued/sent, else the thread); pure helpers exported for tests: `insertAt(text, cursor, snippet) →
{text, cursor}`, `sendLabel(dueAtIso, nowMs) → "Send now" | "Send Mon 07:00"`, `statusLine(message, nowMs) → string`
(A8 wording), `badge(author) → "You" | "Claude" | "System" | "Them"`.

- [ ] **Step 1: Write the failing test** (pure helpers only; the file must import without a DOM, so DOM access lives
  inside `mountEmail`)
```js
test("helpers", () => {
  assert.deepEqual(insertAt("ab", 1, "{demo_link}"), { text: "a{demo_link}b", cursor: 12 });
  assert.equal(sendLabel("2026-10-26T07:00:00Z", Date.parse("2026-10-25T10:00:00Z")), "Send Mon 07:00");
  assert.equal(sendLabel("2026-10-22T08:15:00Z", Date.parse("2026-10-22T08:15:00Z")), "Send now");
  assert.equal(statusLine({ status: "failed", error: "Mailbox password rejected" }, 0), "Didn't send: Mailbox password rejected");
  assert.equal(statusLine({ direction: "in", status: "received", class: "bounce", received_at: "2026-10-23T13:02:00Z" }, 0), "Bounced: the address doesn't work");
  assert.equal(badge("them"), "Them");
});
```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/compose-ui.test.mjs` → module not found.
- [ ] **Step 3: Implement `compose.js`** — layout, labels and messages exactly as A3/A8; preview via debounced (300 ms)
  POST to `/preview`; every server string through `esc()`, source links through `safeUrl()`; Send disables itself
  until the response; Cancel uses `modal` with "Cancel this email? It won't be sent."
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/compose-ui.test.mjs && node --check control-room/public/js/compose.js && node --check control-room/public/js/leads.js` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/public/js/compose.js control-room/public/js/leads.js control-room/public/style.css control-room/tests/compose-ui.test.mjs` + `git commit -m "Write and send the first email from the lead drawer; thread view"`.

### Task 14: Voice page (front end)

**Files:** Create `control-room/public/js/voice.js`. Modify `control-room/public/js/app.js` (route `voice`, nav link
"Voice"), `control-room/public/style.css` (`.voice-card`). Test `control-room/tests/voice-ui.test.mjs`.

**Interfaces:**
Consumes: `GET/PUT/POST/DELETE /api/voice…` (Task 12); `api`, `esc`, `pageHead`, `toast` from `lib.js`.
Produces: `voicePage() → Promise<void>`; pure `voiceBanner(templates) → string` and `wordsLabel(body) → "38 / 60 words"`.

- [ ] **Step 1: Write the failing test**
```js
test("banner and word label", () => {
  const t = (n) => Array.from({ length: 9 }, (_, i) => ({ status: i < n ? "approved" : "draft" }));
  assert.equal(voiceBanner(t(6)), "Follow-ups are paused until you approve all 9 (6 of 9 approved).");
  assert.equal(voiceBanner(t(9)), "All 9 approved. Follow-ups are on.");
  assert.equal(wordsLabel(DRAFTS[1]), "28 / 60 words");
});
```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/voice-ui.test.mjs` → module not found.
- [ ] **Step 3: Implement `voice.js`** with the A7 sections, labels, D-3 card and empty state; Save toast "Saved as a
  draft. Approve it to switch follow-ups back on."
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/voice-ui.test.mjs && node --check control-room/public/js/voice.js && node --check control-room/public/js/app.js` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/public/js/voice.js control-room/public/js/app.js control-room/public/style.css control-room/tests/voice-ui.test.mjs` + `git commit -m "Voice page: approve the 9 follow-ups, add your own replies and rules"`.

### Task 15: Follow-ups health light

**Files:** Modify `control-room/functions/_lib/followups.js`, `control-room/functions/_lib/health.js` (register the
light). Test `control-room/tests/followups-db.test.mjs`.

**Interfaces:**
Produces: `followupHealth({overdue: [{mailbox_address, mailbox_status}], approved: boolean, waiting: number}) →
{name: "followups", light: "green"|"amber"|"red", detail: string}` (pure);
`followupHealthFromDb(DB, now) → Promise<same>` (overdue = queued follow-ups with `due_at` < now − 24 h, plus pending
`next_followup_at` < now − 24 h when approved).

- [ ] **Step 1: Write the failing test**
```js
test("followupHealth", () => {
  assert.deepEqual(followupHealth({ overdue: [], approved: true, waiting: 0 }), { name: "followups", light: "green", detail: "Follow-ups are on time." });
  assert.deepEqual(followupHealth({ overdue: [], approved: false, waiting: 4 }), { name: "followups", light: "amber", detail: "4 follow-ups are waiting for you to approve the wording on the Voice page." });
  assert.deepEqual(followupHealth({ overdue: Array(3).fill({ mailbox_address: "nik@aetoswebsites.com", mailbox_status: "paused" }), approved: true, waiting: 0 }),
    { name: "followups", light: "red", detail: "3 follow-ups are a day late: mailbox nik@aetoswebsites.com is paused." });
  assert.equal(followupHealth({ overdue: [{ mailbox_address: "a@b", mailbox_status: "active" }], approved: true, waiting: 0 }).detail,
    "1 follow-up is a day late. Check the mailbox on Setup and the tick light.");
});
```
- [ ] **Step 2: Run it to verify it fails** — → `followupHealth is not a function`.
- [ ] **Step 3: Implement both functions; add the light to `health.js`'s list.**
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/followups-db.test.mjs control-room/tests/health.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add …followups.js control-room/functions/_lib/health.js …followups-db.test.mjs` + `git commit -m "Follow-ups health light"`.

### Task 16: End-to-end with fake SMTP

**Files:** Create `control-room/tests/email-e2e.test.mjs`.

**Interfaces:**
Consumes: `sendFirst`, `followupsStep`, `stopFollowups`, `roomForFirsts`; `dispatchDue(DB, env, now, {limit, send})`;
`nextStage`; `fakeD1`.

- [ ] **Step 1: Write the failing test** — a loop `for (t = start; t < start + 75 days; t += 15 min) { await
  followupsStep({DB, env, now: t}, {demoReady: okDemo}); await dispatchDue(DB, env, t, {limit: 2, send: fakeSend}); }`
  where `fakeSend` records `{to, headers, text, at}`.
```js
test("first email + 9 follow-ups at the right UK times across BST→GMT", async () => {
  /* sendFirst at 2026-10-22T08:15:00Z, all templates approved, run the loop */
  assert.equal(sent.length, 10);
  const want = ["2026-10-22T08:15","2026-10-23T08:15","2026-10-24T08:15","2026-10-26T09:15","2026-10-29T09:15",
    "2026-11-02T09:15","2026-11-09T09:15","2026-11-16T09:15","2026-11-21T09:15","2026-12-21T09:15"];
  want.forEach((w, i) => assert.ok(sent[i].at - Date.parse(`${w}:00Z`) < 15 * 60000, `email ${i}`));
  sent.slice(1).forEach((s, i) => {
    assert.equal(s.headers["In-Reply-To"], sent[0].headers["Message-ID"]);
    assert.equal(s.headers.References.split(" ").length, i + 1);
    assert.equal(s.headers.Subject, "Re: Your website");
  });
  const p = await getProspect(DB, "p1");
  assert.equal(p.stage, "lost"); assert.equal(p.lost_reason, "sequence_done");
});
test("a reply on day 3 stops the rest; a demo view does not", async () => { /* demo_view on day 1 → stage viewed, keeps going; inbound human on 2026-10-25 → 3 sent in total, stage replied */ });
test("opt-out and bounce stop and suppress", async () => { /* opt_out → lost + suppression row; bounce → lost */ });
test("cap respected; follow-ups before first emails; none skipped", async () => {
  /* 70 days: each morning sendFirst for a new lead whenever roomForFirsts(...).total ≥ 1;
     assert per UK day sends ≤ 10; mean new leads/day over days 61–70 in [0.8, 1.2];
     then cap_override 5 for 3 days: every follow-up still sent once, steps strictly increasing per lead,
     and on each of those days no first email went while a follow-up was waiting */
});
```
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/email-e2e.test.mjs` → fails until stage 0's
  `dispatchDue` orders follow-ups first (see Cross-stage interfaces) and Tasks 1–9 are in.
- [ ] **Step 3: Fix whatever the run exposes** in the owning task's module (and add that case to its unit test).
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/*.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/tests/email-e2e.test.mjs` + `git commit -m "End-to-end test: first email and 9 follow-ups over 75 simulated days"`.

---

## Cross-stage interfaces

**Produced here (others use):**
- `_lib/followups.js`: `COLD_WINDOW = {start: "07:00", end: "19:00", days: [1,2,3,4,5,6]}`, `FOLLOWUP_DAYS`,
  `schedule(firstSentAt, step) → Date`, `nextDue(firstSentAt, step, lastSentAt) → Date`. Stage 0's `send` step must
  use this same `COLD_WINDOW` for kinds `first` and `followup`.
- `followupsDueToday(DB, now) → Promise<{total, byMailbox: {[mailbox_id]: number}}>` — stage 3's capacity banner.
- `roomForFirsts(DB, now) → Promise<{day, total, byMailbox: {[id]: {room, fullDay}}}>` — stage 3 should use `total`
  for "you can send N first emails today" (it already accounts for future follow-up days).
- `stopFollowups(DB, placeId, reason, now) → Promise<number>` — stage 7's `inbound` step calls it on `human`,
  `opt_out`, `bounce`; stages 8/9 may call it on `call_confirmed` / `paid` (the sweep covers them anyway).
- `followupsApproved(DB) → Promise<{approved, all}>` — Setup checklist (stage 0) and the Todo board.
- `followupHealthFromDb(DB, now) → Promise<{name: "followups", light, detail}>` — stage 0's `health` step.
- `_lib/mail/rules.js`: `wordCount`, `findLinks`, `businessName`, `greetingFor`, `firstEmailIssues`,
  `renderFirstEmail`, `stripFooter` — stage 7 may reuse `findLinks`/`greetingFor` for Claude's replies.
- `_lib/thread.js` `loadThread(DB, placeId, now)` and `GET /api/thread/:place_id` — stage 7/8 todos link to the
  drawer thread.
- `public/js/compose.js` `mountEmail(el, placeId)` — whoever owns the lead drawer (stage 3) keeps a `#d-email` mount
  point and calls it.
- Data: `style_examples` rows `source "nik_sent"`, `situation "first email"`, `id "sent:<message id>"`; rows `source
  "nik_written"` from the Voice page (situation "they ask the price" = decision D-3) — read by stage 7's reply Routine.
- Tick step `followups` at position 3; todo dedupes `setup:followups`, `health:followup-fail:<place_id>`,
  `health:followup-demo:<place_id>`.

**Needed from other stages (not in the overview):**
- Stage 4: `demoReady(DB, placeId) → Promise<{ok: boolean, url: string|null, reason: string}>` (reason in plain
  English, e.g. "the landscaper template isn't approved yet"), and the stage-4 event `demo_ready` creating the
  `prospects` row (stage `ready`, `email` = `research.best_email`). The demo must stay live for every prospect in
  `emailed`/`viewed`/`replied` and for at least 30 days after the sequence closes (step 9 says "here whenever you want
  it").
- Stage 0 `dispatchDue`: (a) when a mailbox's cap is the limit, sends due `followup` messages before `first` ones,
  oldest `due_at` first; (b) leaves over-cap or paused-mailbox messages `queued` (never fails them for that); (c)
  passes `message_id`, `in_reply_to` and `refs` from the row to `composeEmail`; (d) sets `sent_at` on success and
  `status 'failed'` + a plain-English `error` on failure. `pickMailbox` returns `null` when no mailbox in the list has
  room.
- Stage 0 test helper: `fakeD1()` exported from `tests/helpers/fakeD1.mjs`, returning a D1-compatible object with
  the full schema applied.
- Stage 0 inbound (and stage 7): inbound rows carry `place_id` and `class` (`human | auto | opt_out | bounce`); the
  `opt_out`/`bounce` stage change and suppression insert stay with them.
- The `hot` tick step and hot todos are stage 4's; this stage adds nothing to it.

## Questions for Nik

1. **Send first emails before the 9 follow-ups are approved?** Default: yes, with the yellow warning; those leads get
   their follow-ups once you approve (one step at a time, nothing skipped).
2. **How long should a demo stay up after the last follow-up?** Default: 30 days after the lead is closed (step 9
   says "here whenever you want it"). This is set in stage 4.
3. **Bank holidays:** default is to send as normal (Mon–Sat), since most tradespeople work them. Say if you want them
   skipped.
