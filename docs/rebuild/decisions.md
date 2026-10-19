# Rebuild: decisions so far (step 1)

The owner's plan: (1) agree the order, (2) write one detailed spec and implementation plan, stage by stage,
(3) build it top to bottom when he says go. The old code stays in the repo untouched. The new build starts from scratch
and copies in old parts only where they're proven.

## Agreed (19 Oct)

- **Order:** 0 Foundations (mailbox, DNS, warm-up, ICO fee, landing page) → 1 Find (filter 1, automatic) →
  2 Research and grade A+ to D (Claude) → 3 Shortlist (grade filter) → 4 Demo → 5 First email (Nik writes it,
  sent from the Control Room) → 6 Follow-ups, day 3 and day 10 (automatic) → 7 Replies (Claude, fast) → 8 Calls →
  9 Order and pay → 10 Build → 11 Monthly care. Running alongside: the Todo board with health lights, weekly email KPIs
  (Nik's emails vs Claude's, grade check), Money, and Map Rank.
- **Sending capacity:** about 10 emails a day per domain, follow-ups included. After the first sale, Nik buys about
  3 domains with 4 mailboxes each, so sending is built for many mailboxes from day one (a daily cap and warm-up per
  mailbox).
- **Who gets emailed:** A+ and A always. B only when the mailboxes have spare room. C and D are held back.
- **Demo:** built before the first email, and the link goes in email 1. It's one great template per trade
  (landscapers first) filled automatically with the business's own logo, colours, photos and reviews, plus a little
  business-specific copy Claude writes during research. The final site is built from the same template, so it
  looks like the demo.
- **Replies:** Claude replies on its own, copying Nik's style (learned from the emails he sends and the guidance he
  gives). Super angry or legal replies go to Nik through Todo.
- **Fast replies:** Namecheap forwards a copy of every incoming email to a Cloudflare Email Worker on a subdomain,
  which wakes Claude's reply Routine. No hourly backup check (Nik: replies to his own
  emails are unlikely to be filed as spam).
- **Calls:** Nik's call slots are 11am on Tue, Wed, Fri, Sat and Sun, one a day. If a day is
  already booked, Claude offers the next free day. Each booking appears on Todo with the email link.
- **Chatbot on client sites:** a standard third-party website chatbot, not Claude, paid for out of the retainer.
  Claude picks the tool in the spec.
- **Monthly payment:** Stripe takes the card at checkout and charges it automatically on day 61. If a client says
  they couldn't cancel in time, we refund them.
- **Old code:** keep it, improve it, and reuse proven parts (scraper engine, demo, Stripe, Money, Map Rank, call
  script). Delete the email version-testing engine, Today's picks, autopilot, SITREP, the "What to do" checklist,
  Roadmap, plan.md and funnel.md, but only in the new build. The old code isn't deleted.

- **SEO guarantee:** "We'll get you into the top 3 on Google in your area, or we work for free until we do." It's
  measured as the Google Maps top 3, using Map Rank's grid around their business. Still to settle: is there a
  time limit (90 days)?
- **Review booster:** part of the plan. It gets their customers to leave Google reviews. The spec defines exactly
  what we deliver.
- **Old system paused (19 Oct):** the `daily.yml` schedule is commented out and the "Aetos lead research (daily)"
  Routine is disabled. Its last run researched 15 leads but found only 1 email: a shallow pass. Stage 2 has to fix
  the research quality, not just the scheduling.
