# Stage 9: Order and pay

> **Plain English:** A prospect who likes their demo presses "Make it mine", sees today's price and what's included,
> and pays by card on Stripe's own payment page, no call needed. The moment they've paid, they become a client on
> the Money page, get a welcome email with their onboarding form, and you get a Todo saying "New client". On the
> Full Package their card is saved and the £249 is taken automatically when the free days end; you don't chase
> anyone. If a card fails, they get a polite email with a link to pay and you get a Todo. Refunds and cancellations
> are a couple of clicks in Stripe or on the Money page.

## Goal

Turn a demo view into money with no human in the loop: one order page that tells the truth about today's offer,
one Stripe Checkout per order, and a webhook that creates the client, the onboarding row and the welcome email
exactly once, however often Stripe repeats itself.

## Trigger

- **Prospect:** opens `/d/:slug/order` (the "Make it mine" button on their demo, or the link Nik/Claude sends).
- **Prospect:** presses an order button → `POST /d/:slug/checkout` → Stripe Checkout.
- **Stripe:** calls `POST /api/stripe/webhook` for the six events below; also returns the prospect to
  `/d/:slug/thanks?session_id=…`.
- **Nik:** Setup → "Payments (Stripe)" card → paste key → **Connect Stripe** (once in test mode, once live).

## Who does what

| Who | Does |
| --- | --- |
| System | Shows today's offer, opens Stripe Checkout, records `order_page` / `order_click`, turns each paid checkout into a client + onboarding row + welcome email, records every payment, failure, cancellation and refund, adds Todos, feeds the Payments health light. |
| Stripe | Takes the card, charges the build fee now, saves the card, charges £249/month when the free days end, retries failed cards, emails receipts/invoices (Nik's Stripe settings). |
| Claude | Nothing in this stage. (Stage 7's reply Routine does not answer won clients; see Cross-stage interfaces.) |
| Nik | Connects Stripe once (test, then live), sets the Stripe account settings listed below, refunds when a client says they couldn't cancel in time, presses "Stopped paying" on Money when someone stops. |

## Rules

### Offer (from `_lib/offer.js` only; nothing else hard-codes a price)

| | Weekday (Mon–Fri UK) | Weekend (Sat 00:00 – Sun 23:59 UK) |
| --- | --- | --- |
| Full Package build fee | £1,950, charged now | £1,750, charged now (shown as ~~£1,950~~ £1,750) |
| Full Package monthly | £249/month, first 60 days free | £249/month, first 90 days free |
| Website Only | £1,750 one-off | £1,750 one-off |

- The struck-through price on the weekend is £1,950, the real weekday price. (CLAUDE.md's "£2,000 → £1,750" is the
  spoken anchor; striking through a price we never charge would be a false price comparison. See Questions.)
- Weekend banner (weekend only), exact text: `Weekend price — ends Sunday midnight`.
- **Grace:** the weekend price is honoured for a checkout started up to 30 minutes after Sunday midnight UK if the
  order page they submit from was rendered on the weekend (the form carries `seen=weekend`). After that, today's
  price applies. Stripe's own page always shows the exact amount before they pay.
- No VAT line, no coupons, no promotion codes. Currency GBP. Card only (Apple Pay / Google Pay count as card).
- First monthly charge = order date (UK) + free days, i.e. **day 61** (weekday) or **day 91** (weekend), counting
  the order day as day 1. Example: ordered Monday 19 October 2026 → first £249 on Friday 18 December 2026.

### Guarantee and fixed wording (overview §9, exact)

- Headline: `Top 3 in Google search results in 90 days. GUARANTEED.`
- Section right below it: `The guarantee: we will work for FREE if you aren't in the top 3 of Google results within 90 days.`
- Build guarantee line: `Website live in 7 days, GUARANTEED (clock starts when your onboarding form is complete)`
- Promise box: `No contract. No cancellation fees. If we're not making you money, we don't want your money.`

### Order page `/d/:slug/order` (exact copy; `{Business}` = `leads.name`, escaped with `h()`)

- `<title>`: `Order your website · {Business}`. `noindex,nofollow`.
- Top bar: `Aetos Websites · for {Business}` and a link `← Back to your site` (→ `/d/:slug`).
- H1: `Get your new website live in 7 days`
- Lead line: `Pick a plan and pay securely by card. Straight after, we email you a short form. Your website goes live within 7 days of it being complete.`
- Weekend only: the banner above, in the gold accent.
- **Full Package card** (gold border). Tag: `Recommended` (weekday) / `Weekend price` (weekend). Never "Most popular"
  (not true until we have clients).
  - Price: `£1,950` / weekend `~~£1,950~~ £1,750`
  - Under it: `then £249/month. First 60 days free.` / weekend `then £249/month. First 90 days free.`
  - Bold line: the guarantee headline.
  - What's included (each line shown only when true now):
    1. `Your new website, finished with your own logo, photos and details`
    2. the build guarantee line
    3. `We work on it every month to get you into Google's top 3 for your main service and town`
    4. only if setting `offer:chatbot_live` = `'1'`: `A chat assistant on your website that answers questions and passes enquiries to you, day and night`
    5. only if setting `offer:review_booster_live` = `'1'`: `Review booster: your own Google review link, a QR card and ready-made messages to ask every customer for a review`
    6. `Hosting included`
    7. `A plain-English report every month`
  - Button: `Order the Full Package` (form `POST /d/:slug/checkout`, `package=full`, hidden `seen=weekend|weekday`).
  - Under the button: `Nothing more to pay until day 61. Cancel any time.` / weekend `… until day 91 …`
- **Website Only card.** Price `£1,750`, under it `one-off. Nothing monthly.` Included: line 1, the build guarantee
  line, `Hosting included`. Button: `Order Website Only` (`package=website`).
- **Guarantee section** (below the cards): heading = guarantee headline; text = guarantee section; small print:
  `Full Package only. Measured on Google's results for your main service and town, searched from your area. The map results at the top count.`
- **Promise box:** the promise text, then `If you stop the monthly plan, you keep your website.`
- **Questions** (`<details>`, in this order):
  1. `What happens after I pay?` — `We email you a short form for your logo, photos, services and the areas you cover. Your 7 days start when it's complete, and your website is live within 7 days of that. Guaranteed.`
  2. `Can I cancel?` — `Yes, any time. Reply to any of our emails and we'll stop your monthly plan that day. No contract and no cancellation fees.`
  3. `Do I keep the website if I stop?` — `Yes. Your website stays live and it's yours. {Extras} switch off.` where
     `{Extras}` = `The monthly Google work and the report`, plus `, the chat assistant` / `, the review booster` when
     those lines are shown (joined so the last one is "and …").
  4. `What happens when the free days end?` — `On day {freeDays+1} we take £249 from the card you paid with, then the same each month. Don't want to carry on? Tell us before then and you won't be charged.`
  5. `How do you measure the top 3?` — `On Google's results for your main service and town (for example "roofer Leeds"), searched from your area. The map results at the top count. If you're not in the top 3 within 90 days, we work for free until you are.`
  6. `Is paying online safe?` — `Yes. Payments are taken by Stripe, which handles card payments for millions of businesses. We never see your card details.`
- Footer: `Payments are taken securely by Stripe. We count visits to this page so we know you've seen it.` plus the
  trader line from stage 0 (D-7: Nik's name, "trading as Aetos Websites", address).
- `order_page` is recorded by a 4-second beacon (same rule as demo views; scanners don't count). The buttons carry
  no beacon: `order_click` is recorded by the server when the checkout POST arrives.

**Notices** (shown in a box above the cards, exact text):

| Key | When | Text | Buttons |
| --- | --- | --- | --- |
| `back` | `?back=1` (Stripe's cancel link) | `No payment was taken. Any questions? Just reply to our email.` | shown |
| `busy` | 6th checkout for this slug within 60 min | `You've started a few payments in the last hour. Please wait a little and try again, or reply to our email and we'll help.` | shown |
| `failed` | Stripe refused to open checkout | `Sorry, the payment page didn't open. Please try again in a few minutes. If it keeps happening, reply to our email and we'll sort it.` | shown |
| `not_connected` | no Stripe key or webhook | `Online ordering is switching on shortly. Reply to our email and we'll send you a payment link.` | hidden |
| `already_client` | a non-cancelled client exists for this `place_id` | `{Business} is already with us. Check your email for your onboarding form, or reply to it with any questions.` | hidden |

- Unknown slug → stage 4's "preview ended" page, 404. Expired demo → the same page, 410 (order page and checkout
  follow the demo's live/expired rule; the thanks page doesn't).

### Checkout `POST /d/:slug/checkout`

- Body: form-encoded (the page's form) or JSON: `package` = `full` | `website`, `seen` = `weekend` | `weekday`.
  Anything else in `package` → 400 with the order page and the `failed` notice.
- Rate limit: **5** checkouts per slug per rolling **60 minutes**, counted from `demo_events` kind `order_click`.
  The 6th → 429 with the `busy` notice. `order_click` is recorded before calling Stripe (failed attempts count).
- Already a client / not connected / expired → the matching notice, no Stripe call.
- Success → `303` to the Stripe Checkout URL. Stripe errors → 502 with the `failed` notice, a `payment` Todo, and a
  red Payments light (`beat(DB, "stripe", false, …)`).
- Stripe Checkout Session parameters (form-encoded, `Stripe-Version: 2024-06-20`), exact:

```js
// common
{ client_reference_id: place_id, customer_email: prospects.email (omitted if none), locale: "en-GB",
  payment_method_types: ["card"], phone_number_collection: { enabled: true },
  metadata: { place_id, package, weekend: "1"|"0", slug, origin },
  success_url: `${origin}/d/${slug}/thanks?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${origin}/d/${slug}/order?back=1` }
// package "full"
{ mode: "subscription", payment_method_collection: "always",
  line_items: [
    { quantity: 1, price_data: { currency: "gbp", unit_amount: 24900, recurring: { interval: "month" },
      product_data: { name: "Monthly plan: Google top 3 work, hosting and report" } } },
    { quantity: 1, price_data: { currency: "gbp", unit_amount: 195000 /* 175000 weekend */,
      product_data: { name: `Website build: ${business}` } } } ],
  subscription_data: { trial_period_days: 60 /* 90 weekend */, metadata: { place_id, package: "full", weekend } } }
// package "website"
{ mode: "payment", customer_creation: "always", invoice_creation: { enabled: true },
  line_items: [ { quantity: 1, price_data: { currency: "gbp", unit_amount: 175000,
      product_data: { name: `Website build: ${business}` } } } ],
  payment_intent_data: { metadata: { place_id, package: "website" } } }
```

- `origin` = the origin of the order page request (so links match the host the prospect used).
- No `expires_at`: Stripe's default 24 hours.

### What a paid checkout does (`fulfilCheckout`, run by the webhook AND the thanks page, idempotent)

Ignored unless `payment_status` is `paid` or `no_payment_required` and `metadata.package` is `full` or `website`
(legacy payment links: `metadata.aetos_package` `full`/`weekend`/`website` is mapped the same way).

1. `client_id = "cl_" + session.id` (deterministic, so two runners can't make two clients).
2. `clients` (INSERT OR IGNORE): `name` = `leads.name` (fallback `customer_details.name`, then email, then
   "New client"), `place_id`, `package` = `full` | `weekend` | `website`, `build_fee_pence` = `amount_total`,
   `monthly_pence` and `free_days` from `termsFor`, `paid_on` = UK date of `session.created`, `notes` =
   "email · phone".
3. `client_links` (INSERT OR IGNORE): `stripe_customer`, `stripe_subscription` (full only), `email`.
4. `payments` row id `build:<stripe_customer>`, category `Website builds`, `amount_pence` = `amount_total`,
   `paid_on` as above; on conflict update `name` only. (`invoice.paid` uses the same id for the build line, so
   whichever arrives first, there is one row.)
5. `onboarding` (INSERT OR IGNORE): `token` = 24 random bytes base64url (32 chars), `status` `sent`.
   **Only the runner whose insert created this row** queues the welcome email and records the `ordered` demo event.
6. Prospect: `stage` = `nextStage(stage, "paid")` (= `won`), `stage_at`, `next_followup_at = NULL`; queued
   `followup` messages for the lead → `cancelled`. No prospect row → insert one with `stage` `won` and the
   checkout email.
7. `closeLeadTodos(DB, place_id, {exceptKinds: ["build", "payment"]})`, then the `build` Todo.
8. Another non-cancelled client already existed for this `place_id` → `payment` Todo "paid twice".

### Welcome email (kind `system`, author `system`, plain text)

From the active `system`-role mailbox; if none, the active cold mailbox with the most capacity left plus a `setup`
Todo; if no active mailbox at all, nothing is queued and a `setup` Todo carries the email as its `draft`.
Greeting: `Hi {greet_name},` when `prospects.greet_name` is set, else `Hi,`. Exact text:

```
Subject: {Business}: your onboarding form

Hi {first},

Thanks for ordering. Your payment of {£1,950} has gone through.

Next step: fill in this short form. It asks for your logo, photos, services and the areas you cover.

{origin}/onboard/{token}

Your 7 days start when the form is complete, and your website will be live within 7 days of that. GUARANTEED.

[Full Package only:]
Your first {60} days of the monthly plan are free. The first £249 is taken on {Friday 18 December 2026} from the card you used, then monthly. You can stop any time by replying to this email.

Any questions, just reply.

{mailbox display_name}
Aetos Websites
```

### Other webhook events

| Event | Does |
| --- | --- |
| `invoice.paid` | `amount_paid` 0 → nothing. Else per line: one-off lines → `build:<customer>` (`Website builds`), subscription lines → `<invoice id>:monthly` (`Monthly retainers`); split Stripe's fee pro rata from `invoice.charge` → balance transaction (missing → 0). On conflict update `fee_pence`. Clears `client_links.failed_on`. Subscription id read from `invoice.subscription` or `invoice.parent.subscription_details.subscription`. |
| `invoice.payment_failed` | Known client only. `client_links.failed_on` = UK date. `payment` Todo (dedupe `payment:failed:<invoice id>`); **only if that Todo is new**, the payment-failed email below to `client_links.email` (else `invoice.customer_email`). |
| `customer.subscription.deleted` | `clients.cancelled_on` = UK date of `ended_at` (else `canceled_at`, else now), only if NULL; `payment` Todo. |
| `charge.refunded` | `payments` row `refund:<charge id>`, category `Refunds`, `amount_pence` = −`amount_refunded` (on conflict update the amount, so partial refunds add up). |
| `checkout.session.expired` | If no client exists for `metadata.place_id`: `hot` Todo "they opened the payment page but didn't pay". |
| `checkout.session.completed` | `fulfilCheckout`. |

Payment-failed email (exact):

```
Subject: Your Aetos Websites payment didn't go through

Hi {first},

Your monthly payment of {£249} for {Business} didn't go through. This usually means a card has expired or been replaced.

You can pay or change your card here:
{hosted_invoice_url}

Stripe will try the card again over the next few days. If you'd rather stop the monthly plan, just reply and I'll sort it. You keep your website either way.

Thanks,
{mailbox display_name}
Aetos Websites
```

**Idempotency:** every processed event id is stored in `stripe_events`; a repeat returns `200 {received: true,
duplicate: true}` and changes nothing. Natural keys (client id, payment ids, Todo dedupe, onboarding insert) make
concurrent duplicates harmless too. A handler error returns 500 (Stripe retries) and does not store the event.
Bad signature → 400, no health change (the endpoint is public; junk is expected).

### Thanks page `/d/:slug/thanks?session_id=…`

Fetches the session from Stripe, checks `client_reference_id` equals the demo's `place_id` and it is paid, runs
`fulfilCheckout` (so the page works even if the webhook is late), and shows (exact):

- H1 `Thank you, you're all set`
- `Your payment of {£1,950} has gone through.`
- Button `Fill in your onboarding form →` → `{origin}/onboard/{token}`
- `Your 7 days start when the form is complete. Your website will be live within 7 days of that. GUARANTEED.`
- Full only: `Your first {60} days of the monthly plan are free. The first £249 is taken on {Friday 18 December 2026}. Cancel any time before then by replying to our email.`
- `We're also emailing you this link. Questions? Reply to any of our emails.`

Wrong/unpaid/other-slug session → H1 `We couldn't find that payment`, text `If you've just paid, your onboarding
form will arrive by email in the next few minutes. If you haven't paid yet, you can go back to your order page.`
(link), status 404. Stripe unreachable → H1 `Thank you`, text `Your payment is being confirmed. Your onboarding form
will arrive by email in the next few minutes.`, status 200.

### Stripe account settings Nik sets once (shown as a checklist on the Setup card)

1. Settings → Public details: business name `Aetos Websites`, statement descriptor `AETOS WEBSITES`, support email,
   your name and service address (trading-name rule).
2. Settings → Customer emails: **Successful payments** and **Refunds** on. Billing → Invoices: email finalised
   invoices to customers on.
3. Billing → Revenue recovery → Retries: Smart Retries on; **if all retries fail: cancel the subscription**.
4. Payment links (old system) → archive all three.

### Edge cases

- Page opened Sunday 23:58, paid Monday 00:10 → weekend price (grace). Page opened Monday 00:01 → weekday.
- Clock-change weekend (24–25 Oct 2026) → weekend from Sat 00:00 BST to Sun 23:59 GMT.
- `invoice.paid` before `checkout.session.completed` → one build payment row; the name is corrected later.
- Thanks page before webhook → thanks page fulfils; webhook later is a no-op apart from storing the event id.
- Webhook replayed from Stripe's dashboard → `duplicate: true`, nothing changes.
- Client pays twice (two tabs) → both recorded (money was taken), `payment` Todo to refund one.
- Client cancels during the free days → `customer.subscription.deleted` → Money shows "Stopped", no charge happens.
- Card fails on day 61 → one email per invoice (Stripe retries don't resend it), `payment` Todo; if all retries
  fail Stripe cancels → "Stopped".
- Prospect was `lost` and later pays → `won` (money beats a "no").
- No prospect row (e.g. ordered from a demo Nik sent by hand) → prospect row created as `won`.
- A booked call stays booked (it becomes a welcome call); only open Todos for the lead close.
- Legacy payment link used → still becomes a client.
- `leads` is never written (owned by the scraper).

## What Nik sees

- **Setup → "Payments (Stripe)" card:** rows `Secret key: saved ✓ · Test mode (no real money)` / `· Live (real
  payments)` / `not added`; `Stripe messages (webhook): connected ✓` / `not connected: press Connect Stripe` /
  `needs updating: press Connect Stripe again`; `Last message from Stripe: 2 hours ago (invoice.paid)` / `none yet`.
  Write-only field `Stripe secret key` (placeholder `sk_test_… or rk_test_…`), button **Connect Stripe**, the
  account-settings checklist above, and:
  - `Test mode first: pay with card 4242 4242 4242 4242, any future date, any 3 digits. When Stripe approves your account, paste the live key and press Connect Stripe again.`
  - `To refund: Stripe → Payments → the payment → Refund. It shows on the Money page by itself.`
  - `To stop someone's monthly: Money → their row → Stopped paying. This cancels it in Stripe too.`
  - Errors (exact): `That's the publishable key (pk_…). Paste the secret key instead: Stripe → Developers → API keys.`;
    `That doesn't look like a Stripe secret key. It starts with sk_ or rk_ (Stripe → Developers → API keys).`;
    `Stripe didn't accept that key. Copy it again from Stripe → Developers → API keys.`;
    `That key isn't allowed to create webhooks. Use the secret key, or a restricted key with "Full access – except sensitive operations".`;
    `Couldn't reach Stripe. Try again in a minute.`
- **Money page:** unchanged behaviour (card clients count actual `payments`); refunds appear as a negative
  `Refunds` line; prices for "Add client" come from the server; the old "Payment links" card is replaced by a hint:
  `To take an order, send them their order page (their demo → Make it mine).`
- **Todo:** the items below. **Health:** the Payments light.

### Todos added

| kind | dedupe | title (exact) | link |
| --- | --- | --- | --- |
| `build` | `build:new:<client_id>` | `New client: {name} — onboarding form sent` | `/#/money` |
| `payment` | `payment:failed:<invoice id>` | `Card failed: {name} ({£249}). They've been emailed a link to pay; Stripe will retry.` | `/#/money` |
| `payment` | `payment:stopped:<client_id>` | `{name} stopped the monthly plan: switch off the extras (their site stays up)` | `/#/money` |
| `payment` | `payment:double:<place_id>:<session id>` | `{name} paid twice: refund one in Stripe` | `/#/money` |
| `payment` | `payment:checkout:<place_id>` | `{name} tried to pay but Stripe refused: {error}` | `/#/setup` |
| `hot` | `hot:checkout:<place_id>` | `Call {name}: they opened the payment page but didn't pay` | `/#/lead/<place_id>` |
| `setup` | `setup:stripe` | `Connect Stripe: {name} tried to order` | `/#/setup` |
| `setup` | `setup:system_mailbox` | `Add a system mailbox for client emails (welcome emails are going from a cold mailbox)` | `/#/setup` |
| `setup` | `setup:welcome:<client_id>` | `Send {name} their onboarding link yourself (no mailbox yet)` + `draft` = the welcome email | `/#/money` |

`setup:stripe` closes when Connect Stripe succeeds. `build:new:<client_id>` is closed by stage 10 when the form is
submitted.

### Health light

`Payments (Stripe)`: grey `Not connected` (no key); amber `Press Connect Stripe on Setup` (key, no or outdated
webhook); red with the detail when the `stripe` heartbeat is `ok = 0` and less than 24 h old (webhook handler error
or checkout refused); green `Working` otherwise.

## Perfect when

1. `node --test control-room/tests/*.test.mjs mail-relay/tests/*.test.mjs` passes, including every test named in
   Part B, and `for f in control-room/public/js/*.js; do node --check "$f"; done` is clean.
2. Offer boundaries (unit): Fri 23 Oct 2026 23:59 BST → weekday; Sat 24 Oct 00:00 BST → weekend; Sun 25 Oct 23:59
   GMT → weekend; Mon 26 Oct 00:00 GMT → weekday; seen-weekend grace honoured at 00:25 and refused at 00:31.
3. **Live, test mode, Full Package on a weekday** (card 4242…): Stripe dashboard shows a £1,950 payment succeeded
   today, a subscription `trialing` whose trial ends order date + 60 days, and an upcoming invoice of £249 on that
   date. Control Room: Money shows the client as free with that first-charge date and £1,950 under Website builds;
   `SELECT status FROM onboarding` = `sent`; the welcome email is `sent` within 10 minutes and its link opens the
   onboarding page; `prospects.stage` = `won`; Todo shows `New client: … — onboarding form sent`.
4. **£249 after the trial:** `curl https://api.stripe.com/v1/subscriptions/<sub> -u <rk_test key>: -d trial_end=now`
   → Stripe charges £249; Money shows a £249 Monthly retainers payment with Stripe's fee.
5. **Live, test mode, Website Only:** £1,750 charged, no subscription, Money shows a one-off client; Stripe emailed
   an invoice.
6. **Live, test mode, weekend run** (done on a Saturday or Sunday): page shows the banner, ~~£1,950~~ £1,750 and
   "First 90 days free"; Stripe charges £1,750 now and the trial is 90 days; `clients.package` = `weekend`.
7. **Replay:** Stripe → Developers → Webhooks → the `checkout.session.completed` and `invoice.paid` events →
   Resend. Response body has `"duplicate":true`; `SELECT COUNT(*) FROM clients`, `payments`, `onboarding`,
   `messages WHERE kind='system'`, `todos` are unchanged.
8. **Thanks page without the webhook:** disable the endpoint in Stripe, pay, the thanks page shows the form link and
   creates the client; re-enable and resend → nothing doubles.
9. **Card failure:** attach `pm_card_chargeCustomerFail` to a test customer, set it as the subscription's
   `default_payment_method` with `trial_end=now` → one `payment` Todo and one email with Stripe's invoice link;
   resend the event → no second email.
10. **Cancel and refund:** Money → Stopped paying → Stripe shows the subscription cancelled and Money shows
    "Stopped"; refund £249 in Stripe → Money shows −£249 under Refunds.
11. Six checkout POSTs for one slug within an hour → the sixth shows the `busy` notice (429).
12. Setup card shows `Test mode`, key ✓, webhook ✓, and the last event; the Payments light is green.

---

# Order and Pay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prospects buy from their demo through Stripe Checkout, and each payment creates the client, onboarding row
and welcome email exactly once.
**Architecture:** Pure modules (`offer.js`, `checkout.js` params, `order-page.js`, `client-mail.js` copy) hold
prices, Stripe parameters and copy; thin db/fetch functions (`startCheckout`, `fulfilCheckout`, `handleWebhook`,
`thanksPage`, `connectStripe`) take `{now, fetchImpl}` so tests drive them with `fakeD1()` and a fake Stripe; the
Pages routes only wire requests to them.
**Tech Stack:** Cloudflare Pages Functions (plain JS ES modules), D1, Stripe REST API via `fetch`
(form-encoded, `Stripe-Version: 2024-06-20`), `node --test` with `tests/helpers/fakeD1.mjs`.
**Spec:** Part A of this file + docs/rebuild/00-overview.md

## Global Constraints

- Prices only from `_lib/offer.js` (overview §9); money in integer pence; GBP.
- Guarantee and promise wording exactly as Part A (overview §9).
- Weekend = `isWeekendUK(date)` from `_lib/ukTime.js`; 30-minute grace only with `seen=weekend`.
- `STRIPE_VERSION = "2024-06-20"` on every Stripe call and on the webhook endpoint.
- Stripe key: `secret:stripe_key` (Setup) first, else `env.STRIPE_SECRET_KEY` (legacy); webhook secret
  `secret:stripe_webhook`, else the legacy `settings.stripe` JSON `.webhook.secret`. Never returned to the browser.
- Checkout rate limit: 5 per slug per 60 minutes (`order_click` events).
- All stored times UTC ISO; `paid_on`, `failed_on`, `cancelled_on` are UK dates via `ukDate()`.
- Server HTML escapes every lead/Stripe string with the template engine's `h()`; no inline user HTML.
- Emails plain text, kind `system`, author `system`, via `queueMessage` only.
- `leads` table is never written by this stage.
- Every commit message below ends with two lines, after a blank line:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_017h4iwgwaGCvQ5f9mmF4rDY`.

## Review Focus

1. **Weekend boundary and BST:** order page rendered Sunday 23:58, POST Monday 00:10 / 00:31 → owned by Task 1
   (`checkoutWeekend` grace tests) and Task 5 (`seen=weekend` POST test).
2. **Stripe repeats and races:** `invoice.paid` before `checkout.session.completed`, thanks page and webhook both
   fulfilling, replayed event ids → one client, one build payment, one welcome email → Task 7
   (`fulfil twice` test) and Task 8 (`invoice first`, `replay` tests).
3. **Newer Stripe payload shapes:** `parent.subscription_details.subscription`, no `invoice.charge` → Task 2
   (`invoiceSubscription` test) and Task 8 (`fee missing` test).
4. **Hostile input on public routes:** `package=enterprise`, unknown slug, expired demo, a `session_id` from another
   slug, a business name containing `<script>` → Task 4 (escaping test), Task 5 (bad package / expired tests),
   Task 10 (other-slug session test).
5. **No mailbox / no system mailbox / no greet name:** welcome email fallback and `Hi,` greeting → Task 6 tests and
   Task 7 (`no mailbox` test).

---

### Task 1: Offer module

**Files:** Create `control-room/functions/_lib/offer.js` (or, if 07-replies-calls.md already created it, add the
missing exports below without renaming existing ones). Modify `control-room/functions/_lib/money.js` (re-export
`PACKAGES`, add `packages` to `summarise()`), `control-room/public/js/money.js` (use `summary.packages`, drop the
"Payment links" card for the hint text). Test `control-room/tests/offer.test.mjs`, `control-room/tests/money.test.mjs`.
**Interfaces:**
Consumes `isWeekendUK(date)` from `_lib/ukTime.js`.
Produces:
```js
PACKAGES = { full: {label: "Full Package", build: 195000, monthly: 24900, freeDays: 60},
             weekend: {label: "Full Package (weekend price)", build: 175000, monthly: 24900, freeDays: 90},
             website: {label: "Website Only", build: 175000, monthly: 0, freeDays: 0} }
WEEKEND_BANNER, GUARANTEE_HEADLINE, GUARANTEE_SECTION, BUILD_GUARANTEE, NO_CONTRACT   // exact strings, Part A
termsFor(pkg: "full"|"website", weekend: boolean) → {key: "full"|"weekend"|"website", label, build, monthly, freeDays}
offerFor(date: Date) → {weekend: boolean, banner: string|null, full: Terms, website: Terms, wasBuild: 195000|null}
checkoutWeekend(now: Date, seenWeekend: boolean) → boolean
pounds(pence: number) → "£1,950" (whole pounds) | "£1,950.50"
```

- [ ] **Step 1: Write the failing test** — `offer.test.mjs`:
  - `offerFor weekday`: `offerFor(new Date("2026-10-19T10:00:00Z"))` → `weekend false`, `banner null`,
    `full.build 195000`, `full.freeDays 60`, `full.monthly 24900`, `website.build 175000`, `wasBuild null`.
  - `offerFor weekend boundaries (BST change)`: `2026-10-23T22:59:00Z` false; `2026-10-23T23:00:00Z` true with
    `banner === "Weekend price — ends Sunday midnight"`, `full.key "weekend"`, `full.build 175000`,
    `full.freeDays 90`, `wasBuild 195000`; `2026-10-25T23:59:00Z` true; `2026-10-26T00:00:00Z` false.
  - `checkoutWeekend grace`: `(2026-10-26T00:25Z, true)` true; `(2026-10-26T00:31Z, true)` false;
    `(2026-10-26T00:25Z, false)` false; `(2026-10-24T12:00Z, false)` true.
  - `termsFor`: `termsFor("full", true).key === "weekend"`; `termsFor("website", true).build === 175000`.
  - `pounds`: `pounds(195000) === "£1,950"`, `pounds(24950) === "£249.50"`, `pounds(-24900) === "-£249"`.
  - `exact wording`: `GUARANTEE_HEADLINE === "Top 3 in Google search results in 90 days. GUARANTEED."` and the other
    four strings equal Part A.
  - `money.test.mjs` add `summary carries packages`: `summarise({today: "2026-10-19"}).packages.full.build === 195000`.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/offer.test.mjs control-room/tests/money.test.mjs`
  → `Cannot find module '…/_lib/offer.js'`.
- [ ] **Step 3: Implement `offerFor(date)` etc. in `_lib/offer.js`** — constants plus `isWeekendUK`; grace is:
  ```js
  checkoutWeekend = (now, seen) => isWeekendUK(now) || (seen && isWeekendUK(new Date(now.getTime() - 30 * 60000)));
  ```
  `money.js`: `export { PACKAGES } from "./offer.js"` (delete its own copy), `summarise` returns `packages: PACKAGES`.
  `public/js/money.js`: replace the local `PACKAGES` with `state.money.summary.packages`, delete `linksCard` /
  `paymentLinks` and the `/api/stripe/setup` fetch, add the hint card text from Part A.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS; `node --check control-room/public/js/money.js`.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/offer.js control-room/functions/_lib/money.js control-room/public/js/money.js control-room/tests/offer.test.mjs control-room/tests/money.test.mjs`
  `git commit -m "Order and pay: offer.js is the only source of prices and guarantee wording"`

### Task 2: Stripe client helpers

**Files:** Modify `control-room/functions/_lib/stripe.js`, `control-room/functions/api/money/clients/[id].js`
(use `stripeApi`). Create `control-room/tests/helpers/fakeStripe.mjs`. Test `control-room/tests/stripe.test.mjs`
(rewrite: drop payment-link/`isCurrent` tests, keep `encode` and `verifySignature` tests).
**Interfaces:**
Consumes `getSecret(DB, name)`, `getSetting(DB, key)` from `_lib/settings.js`; `parseJson` from `_lib/util.js`.
Produces:
```js
STRIPE_VERSION = "2024-06-20"
WEBHOOK_EVENTS = ["checkout.session.completed", "checkout.session.expired", "invoice.paid",
                  "invoice.payment_failed", "customer.subscription.deleted", "charge.refunded"]
encode(params) → URLSearchParams                                    // kept
stripeApi(key, method, path, params = null, fetchImpl = fetch) → Promise<object>   // throws Error {message, status}
stripeKey(env, DB) → Promise<{key, source: "setup"|"cloudflare"} | null>
stripeMode(key) → "test"|"live"
keyId(key) → Promise<string>                                        // 16 hex chars
verifySignature(body, header, secret, nowSeconds) → Promise<boolean>   // kept
webhookSecret(DB) → Promise<string|null>
invoiceSubscription(inv) → string|null
stripeLight({hasKey, webhookCurrent, beat}, now) → {name: "Payments (Stripe)", color: "grey"|"amber"|"red"|"green", text}
// tests/helpers/fakeStripe.mjs
fakeStripe(routes: {["METHOD path"]: object | ((params) => object) | {status, error}}) → {fetchImpl, calls: [{method, path, params, headers}]}
```
Keep the JSON `getSetting`/`putSetting` exports in `stripe.js` unchanged while any file still imports them
(`grep -rn "_lib/stripe.js" control-room/functions`); remove `setUpStripe`, `isCurrent`, `stripe(env…)` and update
every remaining caller.

- [ ] **Step 1: Write the failing test** — `stripe.test.mjs`:
  - `stripeApi pins version and form-encodes`: with `fakeStripe({"POST checkout/sessions": {id: "cs_1"}})`,
    `await stripeApi("sk_test_x", "POST", "checkout/sessions", {a: {b: 1}}, fetchImpl)` → `{id: "cs_1"}`;
    `calls[0].headers["stripe-version"] === "2024-06-20"`, body `a[b]=1`, auth `Bearer sk_test_x`.
  - `stripeApi errors are plain English`: 401 → message `Stripe didn't accept that key. Copy it again from Stripe → Developers → API keys.`
    with `status 401`; 400 `{error: {message: "No such price"}}` → `Stripe: No such price`.
  - `stripeKey prefers Setup`: `secret:stripe_key` set → `{key, source: "setup"}`; only env → `source: "cloudflare"`;
    neither → `null`.
  - `stripeMode`: `sk_live_…`/`rk_live_…` → `live`; `sk_test_…` → `test`.
  - `webhookSecret falls back to legacy`: no `secret:stripe_webhook`, settings `stripe` = `{"webhook":{"secret":"whsec_old"}}` → `"whsec_old"`.
  - `invoiceSubscription both shapes`: `{subscription: "sub_1"}` → `sub_1`;
    `{parent: {subscription_details: {subscription: "sub_2"}}}` → `sub_2`; `{}` → `null`.
  - `stripeLight`: no key → grey `Not connected`; key, `webhookCurrent false` → amber `Press Connect Stripe on Setup`;
    beat `{ok: 0, last_at: now-1h, detail: "x"}` → red `x`; beat `{ok: 0, last_at: now-25h}` → green `Working`.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/stripe.test.mjs` → `stripeApi is not a function`.
- [ ] **Step 3: Implement `stripeApi(key, method, path, params, fetchImpl)` in `_lib/stripe.js`** — the old
  `stripe()` body with the key and fetch passed in; 403 message is the "isn't allowed" text from Part A, network
  failure → `Couldn't reach Stripe. Try again in a minute.` `[id].js` calls
  `stripeApi((await stripeKey(env, DB))?.key, "DELETE", …)`.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/stripe.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/stripe.js control-room/functions/api/money/clients/[id].js control-room/tests/helpers/fakeStripe.mjs control-room/tests/stripe.test.mjs`
  `git commit -m "Order and pay: Stripe helpers take the key from Setup, handle both invoice shapes"`

### Task 3: Checkout Session parameters

**Files:** Create `control-room/functions/_lib/checkout.js` (pure part). Test `control-room/tests/checkout.test.mjs`.
**Interfaces:**
Consumes `termsFor`, `encode`.
Produces `checkoutParams({pkg: "full"|"website", weekend: boolean, lead: {place_id, name}, slug, email: string|null, origin}) → object`
(exactly the Part A object).

- [ ] **Step 1: Write the failing test** — `checkout.test.mjs`, decoding `encode(checkoutParams(...)).toString()`:
  - `full weekday`: contains `mode=subscription`, `payment_method_collection=always`,
    `line_items[0][price_data][unit_amount]=24900`, `line_items[0][price_data][recurring][interval]=month`,
    `line_items[1][price_data][unit_amount]=195000`, `subscription_data[trial_period_days]=60`,
    `client_reference_id=p1`, `metadata[package]=full`, `metadata[weekend]=0`, `metadata[slug]=smith-roofing`,
    `success_url=https://x.test/d/smith-roofing/thanks?session_id={CHECKOUT_SESSION_ID}`,
    `cancel_url=https://x.test/d/smith-roofing/order?back=1`, `currency]=gbp`, `locale=en-GB`.
  - `full weekend`: `line_items[1][price_data][unit_amount]=175000`, `trial_period_days]=90`, `metadata[weekend]=1`.
  - `website`: `mode=payment`, `customer_creation=always`, `invoice_creation[enabled]=true`, one line item `175000`,
    no `subscription_data`, no `recurring`.
  - `no email`: `email: null` → no `customer_email` key; with email → `customer_email=a@b.co.uk`.
  - `product name`: `line_items[1][price_data][product_data][name]=Website build: Smith Roofing`.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/checkout.test.mjs` → module not found.
- [ ] **Step 3: Implement `checkoutParams(...)` in `_lib/checkout.js`** — builds the Part A object from
  `termsFor(pkg, weekend)`; omits `customer_email` when falsy.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/checkout.js control-room/tests/checkout.test.mjs`
  `git commit -m "Order and pay: Checkout Session parameters for both packages and the weekend price"`

### Task 4: Order and thanks page HTML

**Files:** Create `control-room/functions/_lib/order-page.js`. Test `control-room/tests/order-page.test.mjs`.
**Interfaces:**
Consumes `offerFor` output, `pounds`, wording constants (Task 1); `h()` from stage 4's template engine.
Produces:
```js
ORDER_NOTICES = {back, busy, failed, not_connected, already_client}   // exact Part A text; {Business} filled in
renderOrder({lead, slug, offer, extras: {chatbot: boolean, reviews: boolean}, notice: keyof ORDER_NOTICES|null}) → string
renderThanks({lead, slug, state: "done"|"pending"|"not_found", onboardUrl?, terms?, amountPaid?, firstChargeOn?}) → string
ukLongDate("YYYY-MM-DD") → "Friday 18 December 2026"
```

- [ ] **Step 1: Write the failing test** — `order-page.test.mjs` (offer from `offerFor(new Date("2026-10-19T10:00:00Z"))`
  unless stated):
  - `weekday page`: contains `£1,950`, `then £249/month. First 60 days free.`, `Recommended`, the five exact
    wording constants, `Nothing more to pay until day 61. Cancel any time.`, `name="package" value="full"`,
    `name="seen" value="weekday"`, `action="/d/smith-roofing/checkout"`; does not contain `Weekend price — ends`
    or `Most popular`.
  - `weekend page`: offer at `2026-10-24T12:00:00Z` → contains `Weekend price — ends Sunday midnight`,
    `<s>£1,950</s>`, `£1,750`, `First 90 days free.`, `until day 91`, `value="weekend"`.
  - `extras only when live`: `extras {chatbot: false, reviews: false}` → no `chat assistant`, no `Review booster`,
    FAQ 3 reads `The monthly Google work and the report switch off.`; both true → both lines and
    `The monthly Google work, the report, the chat assistant and the review booster switch off.`
  - `notices hide buttons`: `notice: "already_client"` → contains `Smith Roofing is already with us.` and no
    `<button`; `notice: "busy"` → notice text and buttons present.
  - `escaping`: `lead.name = "<script>x</script>"` → output has no `<script>x` and has `&lt;script&gt;`.
  - `thanks done (full)`: `renderThanks({state: "done", onboardUrl: "https://x.test/onboard/T", terms: termsFor("full", false), amountPaid: 195000, firstChargeOn: "2026-12-18"})`
    contains `Thank you, you're all set`, `Your payment of £1,950 has gone through.`, `href="https://x.test/onboard/T"`,
    `The first £249 is taken on Friday 18 December 2026.`
  - `thanks website`: no `monthly plan`. `thanks not_found`: `We couldn't find that payment` and a link to
    `/d/smith-roofing/order`. `thanks pending`: `Your payment is being confirmed.`
  - `ukLongDate("2026-12-18") === "Friday 18 December 2026"`.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/order-page.test.mjs` → module not found.
- [ ] **Step 3: Implement `renderOrder(...)` / `renderThanks(...)` in `_lib/order-page.js`** — Part A copy and
  layout, charcoal `#1A1C20` / gold accent per docs/brand.md, mobile-first; the `order_page` beacon is a 4-second
  `navigator.sendBeacon("/d/<slug>/e", '{"kind":"order_page"}')`; FAQ extras joined with commas and a final "and".
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/order-page.js control-room/tests/order-page.test.mjs`
  `git commit -m "Order and pay: order page and thanks page copy"`

### Task 5: Order page and checkout routes

**Files:** Modify `control-room/functions/_lib/checkout.js` (db part), `control-room/functions/d/[slug]/order.js`.
Create `control-room/functions/d/[slug]/checkout.js`. Delete `renderOrder` from `_lib/demo.js` if stage 4 left it.
Test `control-room/tests/checkout-route.test.mjs`.
**Interfaces:**
Consumes `demoBySlug(DB, slug) → {demo, lead}|null`, `recordEvent(DB, demo, kind, at)` (stage 4's demo-db),
`getSetting`, `addTodo`, `beat`, `stripeKey`, `webhookSecret`, `stripeApi`, `checkoutParams`, `offerFor`,
`checkoutWeekend`, `renderOrder`, stage 4's expired page renderer, `page()`.
Produces:
```js
CHECKOUT_LIMIT = 5                       // per slug per 60 minutes
loadOrder(DB, env, slug, now) → Promise<null | {lead, demo, expired: boolean, prospect: {email, greet_name}|null,
          alreadyClient: boolean, connected: boolean, extras: {chatbot, reviews}}>
orderPage(DB, env, {slug, back: boolean, now}) → Promise<{status, html}>
startCheckout(DB, env, {slug, pkg, seen, origin, now, fetchImpl}) → Promise<{redirect: string} | {status, html}>
```

- [ ] **Step 1: Write the failing test** — `checkout-route.test.mjs` with `fakeD1()`, a lead `p1` "Smith Roofing",
  a live demo `smith-roofing`, `secret:stripe_key = "sk_test_x"`, `secret:stripe_webhook = "whsec_x"`,
  prospect email `mark@smithroofing.co.uk`, `fakeStripe({"POST checkout/sessions": {id: "cs_1", url: "https://checkout.stripe.com/c/cs_1"}})`:
  - `opens checkout`: `startCheckout(..., {pkg: "full", seen: "weekday", origin: "https://x.test", now: 2026-10-19T10:00Z})`
    → `{redirect: "https://checkout.stripe.com/c/cs_1"}`; one `order_click` row in `demo_events`; Stripe call
    params include `customer_email=mark@smithroofing.co.uk` and `unit_amount]=195000`.
  - `weekend grace via seen`: `now 2026-10-26T00:10Z`, `seen "weekend"` → params `unit_amount]=175000`,
    `trial_period_days]=90`; `seen "weekday"` → `195000`.
  - `rate limit`: 5 calls succeed, the 6th → `{status: 429}` with the `busy` text; Stripe called 5 times.
  - `bad package`: `pkg "enterprise"` → `{status: 400}`, no Stripe call, no `order_click`.
  - `expired demo`: demo `expires_at` in the past → `{status: 410}`, no Stripe call.
  - `already a client`: `clients` row for `p1` with `cancelled_on NULL` → `{status: 409}` with `is already with us`;
    with `cancelled_on` set → checkout opens.
  - `not connected`: no key → `{status: 503}` with the `not_connected` text, `todos` row `setup:stripe` titled
    `Connect Stripe: Smith Roofing tried to order`.
  - `Stripe refuses`: route returns `{status: 400, error: "Invalid email"}` → `{status: 502}` with the `failed`
    text, todo `payment:checkout:p1`, `heartbeats` row `stripe` with `ok 0`.
  - `order page extras`: setting `offer:chatbot_live = '1'` → `orderPage` html contains `chat assistant`;
    `back: true` → contains `No payment was taken.`; unknown slug → `status 404`.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/checkout-route.test.mjs` → `startCheckout is not a function`.
- [ ] **Step 3: Implement `startCheckout(...)` in `_lib/checkout.js`** — order of checks: package valid (400) →
  demo found (404) / live (410) → connected (503 + todo) → already client (409) → count `order_click` for the slug
  since `now − 60 min` ≥ 5 (429) → `recordEvent(order_click)` → `stripeApi("POST", "checkout/sessions", checkoutParams(...))`
  → redirect; on throw 502 + todo + `beat(DB, "stripe", false, "Checkout refused: " + message)`. The routes parse
  form or JSON, pass `origin = new URL(request.url).origin` and `fetchImpl: fetch`, return 303 / `page(html, status)`.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/checkout.js "control-room/functions/d/[slug]/order.js" "control-room/functions/d/[slug]/checkout.js" control-room/functions/_lib/demo.js control-room/tests/checkout-route.test.mjs`
  `git commit -m "Order and pay: order page and checkout route with rate limit and plain-English notices"`

### Task 6: Client emails

**Files:** Create `control-room/functions/_lib/client-mail.js`. Test `control-room/tests/client-mail.test.mjs`.
**Interfaces:**
Consumes `queueMessage(DB, msg)`, `mailboxCap`, `sentToday`, `addTodo`, `pounds`, `ukLongDate`.
Produces:
```js
welcomeEmail({business, greetName, terms, amountPaid, onboardUrl, firstChargeOn, signName}) → {subject, body}
paymentFailedEmail({business, greetName, amountDue, payUrl, signName}) → {subject, body}
systemMailbox(DB, now) → Promise<{mailbox, fallback: boolean} | null>   // system role first, else cold with most room left
sendClientMail(DB, {client_id, place_id, to, business, compose: (signName) => {subject, body}, now})
  → Promise<{queued: string|null, fallback: boolean}>
```

- [ ] **Step 1: Write the failing test** — `client-mail.test.mjs`:
  - `welcome full`: `welcomeEmail({business: "Smith Roofing", greetName: "Mark", terms: termsFor("full", false), amountPaid: 195000, onboardUrl: "https://x.test/onboard/T", firstChargeOn: "2026-12-18", signName: "Nik P"})`
    → `subject === "Smith Roofing: your onboarding form"`; body starts `Hi Mark,\n\nThanks for ordering. Your payment of £1,950 has gone through.`,
    contains `https://x.test/onboard/T`, `Your first 60 days of the monthly plan are free. The first £249 is taken on Friday 18 December 2026`,
    ends `Nik P\nAetos Websites`.
  - `welcome website, no name`: `greetName null`, `terms website` → starts `Hi,\n\n`, no `monthly plan`.
  - `failed email`: contains `Your monthly payment of £249 for Smith Roofing didn't go through.` and the pay URL on
    its own line; subject `Your Aetos Websites payment didn't go through`.
  - `uses the system mailbox`: mailboxes `sys` (role system) and `cold1` → `sendClientMail` queues one `messages`
    row `kind 'system'`, `author 'system'`, `mailbox_id 'sys'`, `client_id`, `to_addr`; `fallback false`; no todo.
  - `falls back to cold`: only `cold1` → `mailbox_id 'cold1'`, `fallback true`, todo `setup:system_mailbox`.
  - `no mailbox`: none → `queued null`, no `messages` row, todo `setup:welcome:<client_id>` whose `draft` contains
    the onboarding URL.
  - `paused mailboxes ignored`: only a paused system mailbox → behaves as `no mailbox`.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/client-mail.test.mjs` → module not found.
- [ ] **Step 3: Implement `sendClientMail(...)` in `_lib/client-mail.js`** — `systemMailbox` → `compose(mailbox.display_name)`
  → `queueMessage(DB, {place_id, client_id, mailbox_id, direction: "out", kind: "system", author: "system", to_addr, from_addr: mailbox.address, subject, body, due_at: now})`;
  todo titles exactly as Part A; for the no-mailbox draft, compose with `signName` = the cold/system display name
  if any row exists, else `"Nik"`.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/client-mail.js control-room/tests/client-mail.test.mjs`
  `git commit -m "Order and pay: welcome and payment-failed emails from the system mailbox"`

### Task 7: Fulfil a paid checkout

**Files:** Modify `control-room/functions/_lib/stripe-events.js` (rewrite), `control-room/functions/_lib/todo.js`
(add `closeLeadTodos`), `control-room/functions/_lib/stages.js` (only if `nextStage("lost", "paid")` isn't `won`).
Test `control-room/tests/stripe-fulfil.test.mjs`.
**Interfaces:**
Consumes `termsFor`, `nextStage(current, event)`, `addTodo`, `recordEvent`, `sendClientMail`, `welcomeEmail`,
`ukDate`, `addUkDays`, `now()`.
Produces:
```js
closeLeadTodos(DB, place_id, {exceptKinds = []} = {}) → Promise<number>        // in todo.js
fulfilCheckout(DB, session, {now}) → Promise<{status: "ok"|"ignored", reason?, client_id, token,
                created: boolean, terms, amountPaid, firstChargeOn: "YYYY-MM-DD"|null, place_id}>
```

- [ ] **Step 1: Write the failing test** — `stripe-fulfil.test.mjs` with `fakeD1()`, lead `p1` "Smith Roofing",
  demo `smith-roofing`, prospect `p1` stage `viewed`, `greet_name 'Mark'`, `next_followup_at` set, one queued
  `followup` message, an open `hot` todo for `p1`, a system mailbox; session
  `{id: "cs_1", mode: "subscription", payment_status: "paid", customer: "cus_1", subscription: "sub_1", amount_total: 195000, created: <2026-10-19T10:00Z>, client_reference_id: "p1", customer_details: {email: "mark@smithroofing.co.uk", phone: "+447700900000"}, metadata: {place_id: "p1", package: "full", weekend: "0", slug: "smith-roofing", origin: "https://x.test"}}`:
  - `full package`: `clients` row id `cl_cs_1`, `package 'full'`, `build_fee_pence 195000`, `monthly_pence 24900`,
    `free_days 60`, `paid_on '2026-10-19'`; `client_links` `cus_1`/`sub_1`; `payments` row `build:cus_1`
    `195000` `Website builds`; `onboarding` `status 'sent'`, token matches `/^[A-Za-z0-9_-]{32}$/`;
    one `messages` row kind `system` containing `https://x.test/onboard/<token>`; prospect `stage 'won'`,
    `next_followup_at NULL`; the follow-up message `cancelled`; the `hot` todo `done`; open todo
    `build:new:cl_cs_1` titled `New client: Smith Roofing — onboarding form sent`; `demo_events` has one `ordered`;
    result `firstChargeOn '2026-12-18'`, `created true`.
  - `fulfil twice`: second call → `created false`, same token; still 1 client, 1 payment, 1 system message,
    1 `ordered` event, `build` todo still open.
  - `weekend metadata`: `weekend "1"`, `amount_total 175000` → `package 'weekend'`, `free_days 90`.
  - `website package`: `mode "payment"`, `package "website"`, no subscription → `monthly_pence 0`, `free_days 0`,
    `stripe_subscription NULL`, `firstChargeOn null`.
  - `unpaid ignored`: `payment_status "unpaid"` → `{status: "ignored"}`, no rows.
  - `legacy link`: `metadata {aetos_package: "weekend"}`, `client_reference_id "p1"` → `package 'weekend'`.
  - `no prospect row`: delete it → a prospect `p1` is inserted with `stage 'won'`, `email 'mark@smithroofing.co.uk'`.
  - `lost then paid`: prospect stage `lost` → `won` (and `nextStage("lost", "paid") === "won"`).
  - `paid twice`: an existing client `cl_other` for `p1` → todo `payment:double:p1:cs_1`.
  - `no mailbox`: no mailboxes → no `messages` row; todo `setup:welcome:cl_cs_1`.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/stripe-fulfil.test.mjs` → `fulfilCheckout is not a function`.
- [ ] **Step 3: Implement `fulfilCheckout(DB, session, {now})` in `_lib/stripe-events.js`** — the 8 steps of
  Part A in that order: one `DB.batch` for clients/client_links/payments (payments `ON CONFLICT(id) DO UPDATE SET name = excluded.name`),
  then the onboarding `INSERT OR IGNORE … .run()` whose `meta.changes === 1` sets `created`; email + `ordered` only
  when `created`; prospect/follow-ups/todos always (idempotent). Token: 24 bytes from `crypto.getRandomValues`,
  base64url without padding.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/stripe-events.js control-room/functions/_lib/todo.js control-room/functions/_lib/stages.js control-room/tests/stripe-fulfil.test.mjs`
  `git commit -m "Order and pay: a paid checkout becomes a client, onboarding row and welcome email, once"`

### Task 8: Webhook route, idempotency and invoice.paid

**Files:** Modify `lead-manager/schema.sql` (add `stripe_events`), run `python scripts/sync_schema.py`
(regenerates `control-room/functions/_lib/schema.js`); modify `control-room/functions/_lib/stripe-events.js`,
`control-room/functions/api/stripe/webhook.js`. Test `control-room/tests/stripe-events.test.mjs` (replaces the old
webhook tests in `stripe.test.mjs`).
**Interfaces:**
Consumes `fulfilCheckout`, `verifySignature`, `webhookSecret`, `stripeKey`, `stripeApi`, `invoiceSubscription`,
`beat`.
Produces:
```sql
CREATE TABLE IF NOT EXISTS stripe_events (
  id      TEXT PRIMARY KEY,   -- Stripe event id
  type    TEXT NOT NULL,
  result  TEXT NOT NULL,      -- what the handler did, in plain English
  at      TEXT NOT NULL
);
```
```js
handleEvent(DB, env, event, {now, fetchImpl}) → Promise<string>
handleWebhook(DB, env, {body, signature, now, fetchImpl}) → Promise<{status: 200|400|500, json}>
```

- [ ] **Step 1: Write the failing test** — `stripe-events.test.mjs` (signatures made with the test's own HMAC helper
  and `secret:stripe_webhook = "whsec_x"`):
  - `bad signature`: → `{status: 400, json: {error: "Bad signature"}}`, no `stripe_events` row, no heartbeat change.
  - `replay`: the same signed `checkout.session.completed` event (id `evt_1`) twice → second
    `json.duplicate === true`; 1 client, 1 system message, 1 `stripe_events` row; heartbeat `stripe` `ok 1`.
  - `invoice first`: `invoice.paid` `{id: "in_1", customer: "cus_1", amount_paid: 195000, charge: "ch_1", lines: {data: [{type: "invoiceitem", amount: 195000}, {type: "subscription", amount: 0}]}}`
    with fake Stripe `GET charges/ch_1?expand[]=balance_transaction` → `{balance_transaction: {fee: 2950}}`, then the
    checkout → one `payments` row `build:cus_1` with `amount_pence 195000`, `fee_pence 2950`, `name 'Smith Roofing'`.
  - `monthly`: `invoice.paid` `{id: "in_2", parent: {subscription_details: {subscription: "sub_1"}}, amount_paid: 24900, lines: {data: [{type: "subscription", amount: 24900}]}}`
    → row `in_2:monthly` `Monthly retainers` `24900`; `client_links.failed_on` cleared.
  - `fee missing`: no `charge` field → row recorded with `fee_pence 0`, no throw.
  - `trial invoice`: `amount_paid 0` → result `nothing paid (free trial invoice)`, no row.
  - `handler error`: `checkout.session.completed` with a DB that throws on insert → `{status: 500}`, no
    `stripe_events` row, heartbeat `stripe` `ok 0` with the error text.
  - `money page`: after `full package` + `monthly`, `loadMoney(DB, "2026-12-20")` → `summary.clients[0].key === "paying"`,
    this-month income includes 24900 from payments (not the schedule).
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/stripe-events.test.mjs` → `handleWebhook is not a function`.
- [ ] **Step 3: Implement `handleWebhook(...)` in `_lib/stripe-events.js`** — verify → `SELECT 1 FROM stripe_events WHERE id = ?`
  (duplicate → 200) → `handleEvent` → `INSERT OR IGNORE INTO stripe_events` + `beat(DB, "stripe", true, type)` → 200;
  catch → `beat(DB, "stripe", false, message)` → 500. `invoice.paid` writes `build:<customer>` / `<invoice>:monthly`
  with `ON CONFLICT(id) DO UPDATE SET fee_pence = excluded.fee_pence`. `webhook.js` returns `json(res.json, res.status)`.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/*.test.mjs` → PASS;
  `cd lead-manager && python -m pytest -q` → PASS (schema sync test).
- [ ] **Step 5: Commit** — `git add lead-manager/schema.sql control-room/functions/_lib/schema.js control-room/functions/_lib/stripe-events.js control-room/functions/api/stripe/webhook.js control-room/tests/stripe-events.test.mjs control-room/tests/stripe.test.mjs`
  `git commit -m "Order and pay: webhook is idempotent on event id and records build fees and retainers once"`

### Task 9: Failed cards, cancellations, refunds, abandoned checkouts

**Files:** Modify `control-room/functions/_lib/stripe-events.js`. Test `control-room/tests/stripe-events.test.mjs`
(add cases).
**Interfaces:**
Consumes `sendClientMail`, `paymentFailedEmail`, `addTodo` (returns `null` when the dedupe already exists),
`invoiceSubscription`, `ukDate`.
Produces nothing new (cases inside `handleEvent`).

- [ ] **Step 1: Write the failing test** — after fulfilling `cs_1`:
  - `card failed`: `invoice.payment_failed` `{id: "in_3", customer: "cus_1", amount_due: 24900, hosted_invoice_url: "https://invoice.stripe.com/i/x", created: <2026-12-18>}`
    → `failed_on '2026-12-18'`; todo `payment:failed:in_3` titled
    `Card failed: Smith Roofing (£249). They've been emailed a link to pay; Stripe will retry.`; one new system
    message containing `https://invoice.stripe.com/i/x`. Same invoice again (new event id, `attempt_count 2`) → no
    second message.
  - `unknown customer`: `customer "cus_zz"` → result `unknown customer`, no todo, no message.
  - `stopped`: `customer.subscription.deleted` `{id: "sub_1", ended_at: <2027-01-15>}` → `cancelled_on '2027-01-15'`;
    todo `payment:stopped:cl_cs_1` titled `Smith Roofing stopped the monthly plan: switch off the extras (their site stays up)`;
    a second delete event leaves `cancelled_on` unchanged.
  - `refund`: `charge.refunded` `{id: "ch_9", customer: "cus_1", amount_refunded: 10000}` then `amount_refunded: 24900`
    → one row `refund:ch_9`, `category 'Refunds'`, `amount_pence -24900`; `summarise` this-month `in` drops by 24900.
  - `abandoned`: `checkout.session.expired` `{metadata: {place_id: "p2"}}` for lead `p2` "Green Leaf" with no client
    → todo `hot:checkout:p2` titled `Call Green Leaf: they opened the payment page but didn't pay`; for `p1`
    (already a client) → no todo.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/stripe-events.test.mjs` → the new cases fail (`ignored`).
- [ ] **Step 3: Implement the four cases in `handleEvent`** — email only when `addTodo` returned an id; refund paid_on
  = `ukDate(event.created)`, upsert `amount_pence`.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/stripe-events.js control-room/tests/stripe-events.test.mjs`
  `git commit -m "Order and pay: card failures email the client once, cancellations and refunds reach Money"`

### Task 10: Thanks page

**Files:** Modify `control-room/functions/_lib/checkout.js`. Create `control-room/functions/d/[slug]/thanks.js`.
Test `control-room/tests/thanks.test.mjs`.
**Interfaces:**
Consumes `demoBySlug`, `stripeKey`, `stripeApi`, `fulfilCheckout`, `renderThanks`.
Produces `thanksPage(DB, env, {slug, sessionId, origin, now, fetchImpl}) → Promise<{status, html}>`.

- [ ] **Step 1: Write the failing test** — `thanks.test.mjs`, fake Stripe `GET checkout/sessions/cs_1` → the paid
  session from Task 7:
  - `fulfils before the webhook`: → `status 200`, html has `Thank you, you're all set` and
    `https://x.test/onboard/<token>` where `<token>` = `onboarding.token`; one client exists.
  - `then the webhook is a no-op`: `handleWebhook` with that session → still one client, one system message.
  - `other slug`: session `client_reference_id "p9"` → `status 404`, `We couldn't find that payment`, no client.
  - `unpaid`: `payment_status "unpaid"` → 404 page. `bad id`: `sessionId "x<y"` → 404 without calling Stripe
    (ids must match `/^cs_[A-Za-z0-9_]+$/`).
  - `Stripe down`: fake returns 500 → `status 200`, `Your payment is being confirmed.`
  - `expired demo still thanks`: demo `expires_at` in the past → still 200 with the form link.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/thanks.test.mjs` → `thanksPage is not a function`.
- [ ] **Step 3: Implement `thanksPage(...)` in `_lib/checkout.js`** — validate id → `stripeApi("GET", "checkout/sessions/" + id)`
  → match `client_reference_id` to the demo's `place_id` → `fulfilCheckout` → `renderThanks` with
  `onboardUrl = origin + "/onboard/" + token`.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/checkout.js "control-room/functions/d/[slug]/thanks.js" control-room/tests/thanks.test.mjs`
  `git commit -m "Order and pay: thanks page shows the onboarding form even if Stripe's webhook is late"`

### Task 11: Setup card, Connect Stripe, health light

**Files:** Modify `control-room/functions/_lib/stripe.js` (add `connectStripe`), `control-room/functions/api/stripe/setup.js`
(rewrite), the Setup page file from stage 0 (`control-room/public/js/setup.js`; remove the old `stripeCard` from
`public/js/app.js` if still there), stage 0's `control-room/functions/_lib/health.js` (register `stripeLight`),
`docs/setup-domain-email-stripe.md` Part 4 (Connect Stripe instead of payment links; the account-settings checklist).
Test `control-room/tests/stripe-setup.test.mjs`.
**Interfaces:**
Consumes `getSecret`, `setSecret`, `getSetting`, `setSetting`, `closeTodos`, `stripeApi`, `keyId`, `stripeMode`,
`WEBHOOK_EVENTS`, `STRIPE_VERSION`, `stripeLight`.
Produces:
```js
connectStripe(DB, env, {key?: string, origin}, {fetchImpl}) → Promise<{mode, webhook_url}>   // throws Error with Part A text
stripeStatus(DB, env) → Promise<{key: boolean, key_source: "setup"|"cloudflare"|null, mode: "test"|"live"|null,
                                 webhook: boolean, webhook_current: boolean,
                                 last_event: {type, at, result}|null, last_error: string|null}>
// GET /api/stripe/setup → stripeStatus;  POST /api/stripe/setup {key?} → connectStripe then stripeStatus (400 + {error})
// settings key "stripe:webhook" = JSON {id, url, events, mode, key_id, created_at}
```

- [ ] **Step 1: Write the failing test** — `stripe-setup.test.mjs`:
  - `connect with a new key`: `fakeStripe({"POST webhook_endpoints": {id: "we_1", secret: "whsec_new", url: "https://x.test/api/stripe/webhook"}})`,
    `connectStripe(DB, {}, {key: "rk_test_abc123456789", origin: "https://x.test"})` → `{mode: "test"}`;
    the call's params have `url=https://x.test/api/stripe/webhook`, `api_version=2024-06-20` and all six
    `enabled_events`; `secret:stripe_key` and `secret:stripe_webhook` saved; `setup:stripe` todo closed.
  - `reconnect replaces the old endpoint`: saved `stripe:webhook` with the same `key_id` and `id "we_0"` → a
    `DELETE webhook_endpoints/we_0` call before the POST.
  - `key errors`: `pk_test_…` → the publishable-key text; `hello` → the "doesn't look like" text; fake 401 → the
    "didn't accept" text and nothing saved.
  - `status never leaks`: `JSON.stringify(await stripeStatus(DB, {}))` contains neither `rk_test_abc` nor `whsec_new`;
    `webhook_current false` when the saved `events` differ from `WEBHOOK_EVENTS`.
  - `last event`: a `stripe_events` row → `last_event.type` equals it.
- [ ] **Step 2: Run it to verify it fails** — `node --test control-room/tests/stripe-setup.test.mjs` → `connectStripe is not a function`.
- [ ] **Step 3: Implement `connectStripe(...)` in `_lib/stripe.js`** — validate prefix
  (`/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/`) → delete the old endpoint when `key_id` matches → create →
  save secrets/settings (key only when it came from the form) → `closeTodos(DB, "setup:stripe")`. Setup page card
  renders the rows, field, button, checklist and help text from Part A ("What Nik sees") with `esc()`.
  `health.js` adds `stripeLight` using `stripeStatus` + the `stripe` heartbeat.
- [ ] **Step 4: Run tests to verify they pass** — `node --test control-room/tests/*.test.mjs` → PASS;
  `for f in control-room/public/js/*.js; do node --check "$f"; done` → clean.
- [ ] **Step 5: Commit** — `git add control-room/functions/_lib/stripe.js control-room/functions/api/stripe/setup.js control-room/public/js/setup.js control-room/public/js/app.js control-room/functions/_lib/health.js docs/setup-domain-email-stripe.md control-room/tests/stripe-setup.test.mjs`
  `git commit -m "Order and pay: Connect Stripe on Setup, status card and Payments health light"`

Then run the live checks 3–12 of "Perfect when" in Stripe test mode before stage "Todo/KPIs" starts.

## Cross-stage interfaces

**Produced here, used elsewhere**
- `_lib/offer.js`: `PACKAGES`, `termsFor`, `offerFor`, `checkoutWeekend`, `pounds`, `WEEKEND_BANNER`,
  `GUARANTEE_HEADLINE`, `GUARANTEE_SECTION`, `BUILD_GUARANTEE`, `NO_CONTRACT`. The overview names the module but not
  its functions; stage 7 (D-3 price answers), stage 4 (demo page) and the landing page should use these names. If
  07-replies-calls.md defines different names first, reconcile before building (Task 1 only adds what's missing).
- `_lib/client-mail.js`: `sendClientMail(DB, {...})`, `systemMailbox(DB, now)` for any client email in stages 10–11.
- `todo.js`: `closeLeadTodos(DB, place_id, {exceptKinds})`.
- `onboarding` row with `status 'sent'` and `token`; link format `{origin}/onboard/{token}`, origin = the host the
  prospect ordered on (`metadata.origin`). Stage 10 owns `/onboard/:token` and must
  `closeTodos(DB, "build:new:" + client_id)` when the form is submitted.
- Settings `offer:chatbot_live` and `offer:review_booster_live` (`'1'` = shown on the order page). Stage 10 sets them.
- `clients.cancelled_on` set on Stripe cancellation: stages 10–11 switch off the chatbot, review booster and monthly
  care for those clients; the site stays up.
- `stripe_events` table (new, not in overview §4) and settings key `stripe:webhook`; secrets
  `secret:stripe_key`, `secret:stripe_webhook`.
- `heartbeats` row `stripe` and `stripeLight(...)` for stage 0's health page; `order_click` / `ordered` events and
  `hot:checkout:<place_id>` todos for the hot-lead logic and KPIs (file 11).
- `payments` ids: `build:<stripe_customer>`, `<invoice>:monthly`, `refund:<charge>`; category `Refunds` (negative).

**Needed from other stages (not fully defined in the overview)**
- Stage 0 `stages.js`: `nextStage("lost", "paid")` must return `won` (§5 says "from any open stage"; money beats a
  "no"). Task 7 amends it if not.
- Stage 0 `queueMessage`/`dispatchDue`: kind `system` must not wait for the cold send window and must not count
  against cold caps (`sentToday` already counts first/followup only), so a welcome email goes on the next tick.
- Stage 0: the D-7 trader line (Nik's name, "trading as Aetos Websites", address) as a helper or settings keys,
  for the order page footer.
- Stage 0 `tests/helpers/fakeD1.mjs` exporting `fakeD1()` whose `.run()` returns `meta.changes`.
- Stage 4: `h()` from the template engine, `demoBySlug(DB, slug)`, `recordEvent(DB, demo, kind, at)` with
  `EVENT_KINDS` including `order_page`, `order_click`, `ordered`, and the expired-preview renderer. The demo's
  "Make it mine" button links to `/d/:slug/order`.
- Stage 7: the reply Routine must not answer mail from `won` prospects or known client addresses as a sales reply;
  send it to Nik as an `escalation` (or a stage 10–11 rule).

## Questions for Nik

1. **Weekend crossed-out price:** show ~~£1,950~~ £1,750 (the real weekday price) instead of ~~£2,000~~? Crossing out
   a price we never charge breaks UK price-comparison rules. **Default: £1,950.**
2. **Website Only hosting:** keep hosting Website Only sites at no charge for as long as they want it (it costs us
   nothing on Cloudflare)? The page says "Hosting included". **Default: yes.**
3. **Reminder before the free days end:** Stripe can email clients 7 days before the first £249. You decided no
   reminder; it would cut "I couldn't cancel in time" refunds. **Default: off.**
4. **Invoices for Website Only:** Stripe makes a proper invoice for one-off payments but charges a small invoicing
   fee on them (check stripe.com/pricing). Monthly plans get invoices anyway. **Default: on.**
