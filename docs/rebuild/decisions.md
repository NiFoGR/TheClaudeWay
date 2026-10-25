# Rebuild: decisions

Nik's process:
1. Agree the order.
2. Write one detailed spec and implementation plan, stage by stage.
3. Nik says go, and it's built top to bottom.

Research behind these decisions is in [research.md](research.md).

## The stages

0. **Foundations:** domain, DNS, mailbox, ICO fee, landing page.
1. **Find (filter 1):** automatic.
2. **Research and grade A+ to D (filter 2):** Claude.
3. **Shortlist:** with a grade filter.
4. **Demo.**
5. **First email:** Nik writes it and it's sent from the Control Room.
6. **Follow-ups:** automatic.
7. **Replies:** Claude, fast, in Nik's style.
8. **Calls.**
9. **Order and pay.**
10. **Build.**
11. **Monthly care.**

Running alongside the stages: the Todo board (with health lights), weekly email KPIs (Nik's emails vs Claude's,
plus a check on whether the grades predict sales), Money and Map Rank.

## Decided

**The offer**
- **Guarantee wording on the site:** "Top 3 in Google search results in 90 days. GUARANTEED." A section right below
  says: "The guarantee: we will work for FREE if you aren't in the top 3 of Google results within 90 days."
- **What we measure it against:** Google's results for "[main service] [their town]", searched from their area.
  The map results at the top of the page count, because that's what's realistically winnable. Map Rank tracks it.
- **Review booster:** included in the plan. Their customers get asked for Google reviews:
  - Google's own review link and QR code.
  - A message sent when each job finishes, plus one reminder.
  - A QR card.
  - A monthly report on reviews.
  - No review gating and no incentives, because both are banned.
- **Chatbot on client sites:** paid for out of the retainer. Recommendation: build our own on Cloudflare Workers AI
  (about $5/month total, against $25–45 per client for ready-made tools). Fallback: Elfsight at $30/month for up
  to 50 sites.
- **Monthly payment:** the card is taken at checkout and charged automatically when the free days end. If a client
  says they couldn't cancel in time, we refund them.
- **Client domains:** if a client has none, we buy one for them. It's registered in their name and they keep it.
- **Invoices:** Nik handles them through Stripe.

**Sending**
- **Volume:** about 10 emails a day per domain, follow-ups included. After the first sale Nik buys about 3 domains
  with 4 mailboxes each, so the sending side is built for many mailboxes from day one (each with its own daily cap
  and warm-up).
  - Measured (stage 6's capacity test, 06 A11 #4): with the follow-up days 1, 2, 4, 7, 10, 17, 24, 30 and 60 and a cap
    of 10 a day, one mailbox starts about **0.5 new businesses a day** (0.4 over days 61–70, about 3.5 a week), not
    the ~1 a day first assumed: each business takes 10 emails over 60 days, and Sunday follow-ups move to Monday,
    which fills first. 12 mailboxes ≈ 6 a day. Even with planned start days these days allow at most ~0.85 a day.
    Other follow-up days would give more (06 Q-K: up to ~0.8); that's Nik's call.
- **Who gets emailed:**
  - A+ and A always.
  - B only when the mailboxes have spare room.
  - C and D are held back.
- **Demo:** built before the first email, and email 1 carries the link.
  - One great template per trade, landscapers first.
  - It's filled automatically with the business's own logo, colours, photos and reviews, plus a little
    business-specific copy Claude writes during research.
  - The final site comes from the same template, so it looks like what they were shown.
- **Template look:** Nik will send example sites later.

**Replies**
- **Who writes them:** Claude replies on its own, in Nik's style, using Sonnet only. Super angry or legal replies
  go to Nik through Todo.
- **Reply hours:** 7:00am to 11:30pm UK time, answered within minutes. Anything that arrives overnight is answered
  at 7:00am.
- **Nik's example replies:**
  - "Send me more info": "Sure. Click the link below to go to our website and browse around. [link] If you have any
    further questions, feel free to ask here."
  - "Can we have a call?": "Yes of course. Soonest I am available for a phone call is [time and day]. If that doesn't
    work let me know a day and time if you can. Thank you."

**Calls**
- **Slots:** 11am on Tue, Wed, Fri, Sat and Sun, one call a day.
- **Offering a time:** Claude offers the soonest free slot. If they propose a time that isn't a free slot, it goes
  to Todo for Nik and Claude says he'll confirm by the end of the day.
- **Phone:** Nik calls from his own number.
- **Todo:** each booking shows there with a link to the email thread.

**Infrastructure**
- **Same keys and setup:** the same Cloudflare Pages project, D1 database (`goldbarwebsites`), variables and
  secrets. Nik doesn't have to change anything in Cloudflare that already exists.
  - The new Control Room is rebuilt in place in `control-room/` and `lead-manager/`.
  - The old code is kept: copied to `legacy/` and tagged `old-system` in git.
  - New tables are added to the same database, and the 287 leads stay.
- **Cloudflare plan:** start on the free plan. If the email-sending test shows the free plan's 10 ms CPU limit
  isn't enough, Nik decides then on the $5/month plan.
- **Mailbox:** Namecheap Private Email, a normal inbox Nik reads and sends from. Nik buys it when everything is
  set up. The build needs it to test sending, and cold emails start about 2 weeks after buying, once it's warmed
  up.
- **Old system paused (19 Oct):** the `daily.yml` schedule is commented out and the "Aetos lead research (daily)"
  Routine is disabled. Its last run found only 1 email in 15 leads, so stage 2 has to fix research quality.

## Waiting on Nik

1. **Follow-up schedule.** Nik wants days 1, 2, 4, 7, 10, 17, 24, 30 and 60. That leaves room for about 1 new
   business a day at 10 emails a day. Claude's case for fewer is in the chat; Nik decides.
2. **Receiving replies.** A cheap receive-only domain, so Namecheap stays the real inbox and forwards a copy to
   Cloudflare.
3. **"How much is it?" reply** in Nik's words.
4. **"Send me more info" link:** our website or their demo?
