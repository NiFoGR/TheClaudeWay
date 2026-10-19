# Rebuild: research facts (19 Oct 2026)

Sourced facts the spec relies on. UNKNOWN means it isn't documented and has to be tested.

## Claude Code Routines

Sources: code.claude.com/docs/en/routines, platform.claude.com/docs/en/api/claude-code/routines-fire,
code.claude.com/docs/en/cloud-environments.

**Limits**
- No daily cap is documented, only hourly ones:
  - **API fires:** 30/hour per Routine, a count shared with "Run now" and re-arms; 100/hour per account.
  - **Scheduled runs:** 100/hour per account.
  - Over the limit, `/fire` returns HTTP 429 with a Retry-After header.
- Runs use the subscription's usage. When the usage limit is hit, runs are rejected until the window resets.
- A run's maximum duration is UNKNOWN. Single commands can run up to 10 minutes in the foreground (another
  30 in the background).

**The `/fire` call**
- `POST https://api.anthropic.com/v1/claude_code/routines/{trig_id}/fire`.
- Headers: `Authorization: Bearer sk-ant-oat01-…`, `anthropic-version: 2023-06-01`, `content-type:
  application/json`, and `anthropic-beta: experimental-cc-routine-2026-04-01` (harmless).
- Body: `{"text": "…"}`, up to 65,536 characters. It returns 200 with the session id once the session is created.
- There's no idempotency key, so a retry starts a second session.
- A paused Routine returns 400.

**Payload, tokens and settings**
- The payload arrives wrapped in `<routine-fire-payload>` and is marked untrusted. The saved prompt must tell Claude
  to act on it.
- An API token is made only in the web UI (Routine → Edit → Add trigger → API → Generate token) and is shown once.
  Making a new one revokes the old one.
- Each Routine has its own model. Its effort setting is UNKNOWN. Subagents can run on another model through the
  Agent tool.

**Secrets**
- Store them as an environment **network secret**: name, allowed host(s), header `Authorization` with prefix
  `Bearer`. The proxy adds the header to matching requests and the session never sees the value.
- Plain environment variables are readable by anyone using the environment.
- If the network level is "Trusted", other hosts get a 403 unless they're allowed or have a network secret.

**Durability**
- Nothing documented says a Routine lasts forever.
- Documented ways one stops: paused, GitHub disconnected for 72 hours, the organisation turns Routines off, or a
  one-off Routine finishing.
- There's no export. Keep every prompt in the repo and recreate the Routine from the web UI.
- Startup time after `/fire` is UNKNOWN.

**Old research Routine, last run (19 Oct)**
- It posted 15 leads but found only 1 email.
- It did 16 web searches in total, about one per lead, so it was a shallow pass.

## Chatbot, review booster, client hosting

**Chatbot**
- Recommendation: build our own on Cloudflare Workers AI.
  - 10,000 free "neurons" (Cloudflare's usage unit) a day, then $0.011 per 1,000.
  - Roughly 130 neurons per chat on Gemma 4 26B, so about 2,300 chats a month are free across all clients.
  - It's one Worker for every client, and adding it to a site is one script tag.
  - It needs rate limiting and a bot check, must never quote prices, and emails leads to the business.
- Fallback: Elfsight Enterprise T1 at $30/month for 50 bots and 6,000 messages, shared across all clients. Going over
  the cap hides every client's bot.
- Rejected:
  - Tidio: $32.50+/month per site for AI, and white-label from $300.
  - Chatbase: about $25/month per extra bot.
  - Crisp: $45+ per site.
  - tawk.to AI Assist: $29 per site.
  - Botpress: $150.

**Review booster**
- **Allowed:**
  - Google's own review link and QR code (Google Business Profile → Get more reviews).
  - Ask every customer the same way: a text, WhatsApp or email on the day the job ends, plus one reminder 3–5 days
    later.
  - A QR card or sticker, and a review link on the website and invoices.
- BrightLocal's 2026 survey: 83% of people who are asked leave a review, and 74% look at reviews from the last
  3 months.
- **Forbidden:**
  - Asking only happy customers ("review gating", e.g. "were you happy? yes → Google").
  - Any incentive.
  - Pressure.
  - Reviews from staff or family.
  - UK law (the DMCC Act, since 6 Apr 2025) bans fake reviews and hidden incentives.
- **What we deliver:**
  - Setup: the review link, QR code, card design and message templates.
  - Monthly:
    - drafted replies to every new review, for the owner to approve;
    - a report of review count, average rating and new reviews against target, compared with the top 3 competitors.
- **Measuring it:** the Places API "Place Details Enterprise" tier gives the rating and count. It costs $20 per
  1,000 calls, with 1,000 free a month.

**Client sites**
- Host them on Cloudflare Pages: one project per client, uploaded directly. That's free, with up to 100 projects.
- The root domain only works if the domain is managed in our Cloudflare account.
  - If we buy the domain through Cloudflare, it works with no extra setup.
  - If the client owns one already, either they move its nameservers to a free zone in our account, or they only
    point `www` at the site.
- Workers' custom domains also need the zone to be in our account.
- Cloudflare for SaaS includes 100 custom hostnames, but it's overkill for us.

## Deliverability and UK law

**Warm-up (manual ramp, no paid tool needed at this volume)**
- Spamhaus lists any domain registered in the last 24 hours, so never send from or link to one that new.
- **Weeks 0–2:** domain, website and DNS live; send 2–5 genuine emails a day.
- **Ramp per mailbox:**
  - Week 3: 3 cold emails a day.
  - Week 4: 5 a day.
  - Week 5: 8 a day.
  - Week 6 on: 10 a day. The most a mailbox should ever send is about 20–30 a day.

**Before the first send**
- SPF and DKIM (2048-bit). DMARC `p=none` with a `rua=` reporting address.
- mail-tester score of 9/10 or more (3 free tests a day).
- Check Spamhaus DBL and MXToolbox. Google Postmaster shows nothing below about 100 emails a day to Gmail.

**Email content**
- Plain text, one link on our own domain, no images, no link shorteners, no click redirects.
- **No tracking pixels:** the ICO's April 2026 guidance puts email pixels under PECR regulation 6, so they need
  consent.
- Counting views on the demo page itself is first-party analytics. Tell visitors on the page.

**Timing and follow-ups**
- Mid-week mornings, 7–11am, do best. Fridays and weekends are weakest. A guess for tradespeople: 7am or 6–7pm.
- **Threading:** the follow-up's `In-Reply-To` and `References` headers carry the original Message-ID, and the
  subject is "Re: " plus the original subject.
- One independent study of 1,857 cold-email replies:

  | Email | Share of replies |
  | --- | --- |
  | First email | 61.7% |
  | Follow-up 1 | 20.9% |
  | Follow-up 2 | 12.5% |
  | Follow-up 3 or later | 4.9% |

**When to pause a mailbox**
- Gmail and Yahoo: spam complaint rate under 0.3% (aim for under 0.1%). DMARC and one-click unsubscribe are only
  required above 5,000 emails a day.
- No mailbox provider publishes a bounce limit. At 10 a day, use absolute triggers: pause on 2 hard bounces in
  7 days, any complaint, or any blocklist hit.

**UK law: PECR**
- **Regulation 22:** sole traders and some partnerships count as individuals, and emailing them needs prior
  consent. Limited companies, LLPs and Scottish partnerships can be emailed. Nik accepts the risk on sole traders.
- **Regulation 23 (every marketing email):** the sender can't be disguised, and there must be a valid address for
  opting out.
- **E-Commerce Regulations 2002, regs 7–8:** the email must be identifiable as commercial, along with who it's
  from.
- **Fines:** the Data (Use and Access) Act, in force from 5 Feb 2026, raised the PECR maximum to £17.5m or 4% of
  turnover.

**UK law: other**
- **Business names:** a sole trader trading under a name other than their own surname must show their own name
  and an address for service on business letters, invoices and the website. A home address isn't required; a
  service address works.
- **ICO fee:** tier 1 is £52 (£47 by direct debit). The exemption almost certainly doesn't apply, because we
  process third parties' data.
- **UK GDPR Article 14:** privacy information must be given at the first contact at the latest. Public data gets
  no exemption. Publish a privacy notice.

**Namecheap Private Email**
- Plans from 2 June 2026 are Launch, Expand and Scale. Launch is $14.88 a year; extra mailboxes are $8.88 a year.
- 500 emails an hour per mailbox; the trial allows 20 an hour, so don't cold-email during the trial.
- Forwarding and filters are on all plans. Mail it files as spam isn't forwarded.
- DKIM selector: `privateemail._domainkey`. Add it by hand in Cloudflare DNS.
- Namecheap's hosting help says it is "zero tolerant" on spam; whether that covers one-to-one cold email is
  unverified.
