// Starting versions, written to the playbook rules (docs/playbooks/business-sales-marketing-notes.md §6) and the
// System Plan: every email's job is a look at the demo site we built for them; the demo page does the selling (Order
// button). A call is never pushed in cold emails; Claude offers one only when someone replies unsure.
// "I built you a site" is true by construction: a version using {demo_link}/{demo_expiry} only goes to leads with a demo.
// SEED_VERSION goes up when these change, so old unapproved starters are swapped for the new ones.

export const SEED_VERSION = 2;

export const SEED_TEST = [
  {
    name: "Built you a site: here's the link",
    hypothesis: "Showing the finished site straight away gets the most people to look at it.",
    subject: "{business} website",
    body: `{greeting}

{problem}. So I built a new website for {business} to show you what it could look like:

{demo_link}

It's up until {demo_expiry}. If you like it, everything to make it yours is on that page.

{sender_first}`,
  },
  {
    name: "Built you a site: want the link?",
    hypothesis: "Asking before sending the link gets more replies (and better inbox placement) than putting the link in the first email.",
    subject: "{business} website",
    body: `{greeting}

{problem}. So I built a new website for {business}, made for a {trade} in {town}, to show you what it could look like.

It's ready to see until {demo_expiry}. Want me to send you the link?

{sender_first}`,
  },
];

// Fixed follow-ups (same thread). For each step the first version a lead has the facts for is used.
export const SEED_FOLLOWUPS = [
  {
    step: 2,
    name: "Did you get a chance to look?",
    body: `{greeting}

Did you get a chance to look at the site I made for {business}?

{demo_link}

If anything's not right for you, just reply and tell me. I'll change it.

{sender_first}`,
  },
  {
    step: 3,
    name: "Preview comes down soon",
    body: `{greeting}

Quick one: the preview of your new site comes down on {demo_expiry}.

{demo_link}

If you want it live, the button's on the page.

{sender_first}`,
  },
  {
    step: 4,
    name: "Polite close",
    body: `{greeting}

I haven't heard back, so I'll leave it there and won't keep emailing. The site I made for {business} is still up until {demo_expiry} if you want another look:

{demo_link}

All the best,
{sender_first}`,
  },
];
