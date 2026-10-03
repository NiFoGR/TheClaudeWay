# Aetos: domain, email and Stripe setup

What you click, in order. About 45 minutes of clicking, plus some waiting.
Each part says what it's for. Tick them off as you go.

---

## Part 1: Move aetoswebsites.com from Namecheap to Cloudflare DNS (15 min, then wait)

You keep the domain at Namecheap (renewals stay there). Cloudflare just runs it: website, email and security, all free.

1. **Cloudflare** → dash.cloudflare.com → **Add a domain** (or "Add site") → type `aetoswebsites.com` → Continue.
2. Pick the **Free** plan → Continue. It scans for records; there won't be any yet, which is fine → Continue.
3. Cloudflare shows **two nameservers**, like `xxx.ns.cloudflare.com` and `yyy.ns.cloudflare.com`. Keep the tab open.
4. **Namecheap** → Domain List → **Manage** next to aetoswebsites.com → **Nameservers** → change "Namecheap BasicDNS" to **Custom DNS**.
   Paste the two Cloudflare nameservers → click the green ✓ to save.
   - On the same page, if **DNSSEC** is on (Advanced DNS tab), turn it **off** first. It's off by default on new domains.
5. Back in Cloudflare, click **Check nameservers**. It usually goes active within an hour; it can take up to 24 hours.
   Cloudflare emails you when it's **Active**.

☐ Domain shows **Active** in Cloudflare

> Later (optional): after 60 days you can transfer the registration itself to Cloudflare Registrar, which is cheaper to renew.
> Nothing else changes when you do.

---

## Part 2: Control Room on your own address (5 min, after Part 1 is Active)

1. Cloudflare → **Workers & Pages** → your Control Room project → **Custom domains** → **Set up a custom domain**.
2. Type `control.aetoswebsites.com` → Continue → **Activate domain**. Cloudflare adds the DNS record itself.
3. After a few minutes, `https://control.aetoswebsites.com` opens your Control Room. The old `.pages.dev` address keeps working too.

☐ control.aetoswebsites.com opens the Control Room

---

## Part 3: Email at your domain (10 min, free)

For now: **receive** email at `hello@aetoswebsites.com` and have it land in your Gmail, for free.

1. Cloudflare → aetoswebsites.com → **Email** → **Email Routing** → **Get started**.
2. Custom address: `hello` → Destination: your Gmail → **Create and continue**.
3. Open the verification email in Gmail and click verify.
4. Back in Cloudflare → **Add records and enable**. It adds the email DNS records for you.
5. Test: email hello@aetoswebsites.com from another account. It should arrive in your Gmail.

☐ An email to hello@aetoswebsites.com arrives in Gmail

> **Sending** from hello@ (and the cold-outreach mailboxes) comes when we build Outreach. That will be Google Workspace
> (about £7 per mailbox a month) plus separate sending domains, so cold email never hurts aetoswebsites.com's
> reputation. I'll give you that guide then; don't buy anything yet.

---

## Part 4: Stripe (20 min)

### 4a. Account details (stripe.com → Settings)

| Where | Set it to |
| --- | --- |
| Business details → Type | **Individual / sole trader** |
| Public details → Business name | `Aetos Websites` |
| Public details → Statement descriptor (what clients see on their bank statement) | `AETOS WEBSITES` |
| Public details → Website | `https://aetoswebsites.com` (see the note below) |
| Public details → Support email | `hello@aetoswebsites.com` |
| Public details → Support phone | your business mobile |
| Bank accounts / payouts | the account you want paid into (your separate sole-trader account if you opened one) |
| Branding → Icon and Logo | upload `docs/brand/aetos-logo.png` |
| Branding → Brand colour / Accent colour | `#1A1C20` / `#C9A13B` |
| Customer emails | turn on **Successful payments** and **Refunds** |
| Billing → Subscriptions and emails | turn on **Send reminders before free trials end** and **Smart Retries**; for failed payments, email the customer |
| Team and security | turn on **two-step authentication** |
| Tax | leave off: you don't charge VAT until your turnover passes £90,000 a year |

**Website note:** Stripe checks your website before it lets you take real payments. It needs to show:
- what you sell
- the prices
- how to contact you
- terms
- a refund and cancellation policy
- a privacy policy

**I'll build that site at aetoswebsites.com next** (see Part 5). Until then you can finish everything else and test.

### 4b. Connect it to the Control Room

1. Stripe → **Developers → API keys → Create restricted key** → choose **Full access – except sensitive operations**.
   Name it "Aetos Control Room" → create → copy it (`rk_test_…` in test mode).
2. Cloudflare → Workers & Pages → Control Room project → **Settings → Variables and Secrets → Add**:
   name `STRIPE_SECRET_KEY`, type **Secret**, paste → Save.
3. **Deployments → Retry deployment** on the latest one, or tell me and I'll redeploy.
4. Control Room → **Setup** → press **Set up Stripe**. Three payment links appear.
5. **Test it:** open the Full Package link and pay with `4242 4242 4242 4242`, any future date, any CVC.
   Check the client appears on the **Money** page. Also note what the checkout said was due today (£1,950 or £0) and tell me.
6. **Go live** once Stripe has approved the account: switch Stripe to live mode → make the same kind of key (`rk_live_…`) →
   replace `STRIPE_SECRET_KEY` in Cloudflare → retry the deployment → press **Set up Stripe** again.

☐ Test payment shows on the Money page
☐ Stripe account approved, live key in, Set up Stripe pressed in live mode

---

## Part 5: Send me these (I need them for the website and legal pages)

1. **Business address** to show on the site. UK law requires a real address on a business website. Your home works;
   if you'd rather keep it private, use a virtual office address (about £10–20 a month).
2. **Business phone number** you're happy to show publicly.
3. Your **full name** as it should appear: "Aetos Websites is a trading name of [your name]".
4. Confirm **hello@aetoswebsites.com** is the contact email.

Then I'll build **aetoswebsites.com** in the brand (white on charcoal, the eagle). It'll have:
- the offer and prices
- the guarantees
- a contact form
- terms, refund and cancellation policy, privacy policy

It will be hosted free on Cloudflare. That's what Stripe needs to approve you, and it's where your payment links and demos will point.
