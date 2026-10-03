// Starting versions, written to the playbook rules (docs/playbooks/business-sales-marketing-notes.md §6).
// Loaded once into an empty database. Everything claimed is true today: we have the heatmap and the audit; we offer to
// make the demo or send the map, we never say we already have.

export const SEED_TEST = [
  {
    name: "Maps rank vs the local leader",
    hypothesis: "A true, specific comparison with the business beating them on Google Maps makes the problem real without insulting their site.",
    subject: "{business} on Google",
    body: `{greeting}

I searched "{trade}" from {spots} spots around {town}. {competitor} shows in Google's top 3 in {competitor_top3}% of them, {business} in {top3}%.

Most of that gap comes down to the website and how the Google profile is set up, and both are fixable.

Want me to send you the map and what I'd change?

{sender_first}`,
  },
  {
    name: "Their biggest problem, then a demo offer",
    hypothesis: "Leading with the one concrete problem we found, plus a low-effort yes (seeing a mock-up), gets more replies than a ranking story.",
    subject: "website for {business}",
    body: `{greeting}

{problem}. People looking for a {trade} in {town} will usually call whoever they find first on Google.

I build websites for trades that fix exactly this. I can mock up a homepage for {business} so you can see what it'd look like.

Want me to?

{sender_first}`,
  },
];

// Fixed follow-ups (same thread). For each step the first version a lead has the facts for is used.
export const SEED_FOLLOWUPS = [
  {
    step: 2,
    name: "Top 3 is where the calls go (with map)",
    body: `{greeting}

One more thought: most people call one of the first three businesses Google shows them. Around {town} that's usually {competitor}, not {business}.

Worth a 10-minute call this week to show you how we'd change that?

{sender_first}`,
  },
  {
    step: 2,
    name: "Top 3 is where the calls go",
    body: `{greeting}

One more thought: when someone in {town} needs a {trade}, most call one of the first three they see on Google. Getting {business} into that three is what we do.

Worth a 10-minute call this week?

{sender_first}`,
  },
  {
    step: 3,
    name: "Short and respectful of their time",
    body: `{greeting}

I know you're busy, so I'll keep it short. In 10 minutes I can show you, using your own Google results, how {business} could get more calls.

Is that worth a look?

{sender_first}`,
  },
  {
    step: 4,
    name: "Polite close",
    body: `{greeting}

I haven't heard back, so I'll assume now isn't the right time and won't keep emailing. If that changes, just reply here and I'll pick it up.

All the best with {business},
{sender_first}`,
  },
];
