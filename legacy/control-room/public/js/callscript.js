// The call script for one lead, filled from what we know about them (no AI, free). Built on the playbook
// (docs/playbooks/business-sales-marketing-notes.md): open → small talk → reason → qualify (SPIN, money lens) →
// PAS tailored to their answers → close smoothly (never "so, what do you think?") → objections.
// Everything said must be true: only facts the audit proved, prices from the offer, guarantees as decided.
// Pure (no DOM), so it's tested in control-room/tests/callscript.test.mjs.

const titleCase = (s) => String(s || "").toLowerCase().replace(/(^|[\s-])\S/g, (m) => m.toUpperCase());

/** "SMITH ROOFING LTD - Roofer in Leeds" → "Smith Roofing" */
export function shortName(name) {
  let n = String(name || "").split(/\s+[-|–]\s+/)[0].trim().replace(/[,.]?\s+(ltd\.?|limited|llp|plc)$/i, "").trim();
  if (n && n === n.toUpperCase() && /[A-Z]{3}/.test(n)) n = titleCase(n);
  return n;
}

const isWeekend = (d) => [0, 6].includes(d.getDay());

// how each finding is said out loud: gentle, true, never "your site is bad"
const SAY = {
  no_website: "I couldn't find a website for you, just the Google listing",
  profile_only: "when people look you up, they only find a social media page, not your own website",
  site_down: "your website wouldn't load when I tried it",
  site_broken: "your website wouldn't load properly when I tried it",
  bad_certificate: "Chrome shows a security warning before your website opens",
  not_mobile: "your website's hard to use on a phone, and that's where most people search",
  not_secure: "Chrome marks your website as \"Not secure\", which puts some people off",
  very_slow: "your website takes a while to load on a phone",
  slow: "your website takes a while to load on a phone",
  maps_invisible: "when I searched for a {trade} around {town}, you didn't come up in Google's top 20",
  maps_rarely_found: "when I searched for a {trade} around {town}, you only showed up in a few spots",
  maps_no_top3: "when I searched for a {trade} around {town}, you weren't in Google's top 3 anywhere",
  maps_some_top3: "you're in Google's top 3 in only part of {town}",
  no_title: "Google isn't being told clearly that you're a {trade} in {town}",
  title_no_trade: "Google isn't being told clearly that you're a {trade} in {town}",
  title_no_town: "Google isn't being told clearly that you're a {trade} in {town}",
  no_form: "there's no quick way to ask for a quote on your website",
  reviews_behind: "the businesses above you on Google have a lot more reviews",
};

/**
 * Sections of the script: [{title, lines: [string]}]. lead = a lead row as the Control Room has it.
 * opts: { sender: "Nik", today: Date }
 */
export function callScript(lead, opts = {}) {
  const today = opts.today || new Date();
  const me = opts.sender || "Nik";
  const business = shortName(lead.name);
  const trade = String(lead.trade || "").toLowerCase() || "business";
  const town = titleCase(lead.town || lead.search_town || "");
  const first = lead.audit?.owner_confident && lead.director_first_name ? titleCase(lead.director_first_name) : "";
  const findings = lead.findings || lead.audit?.findings || [];
  const fill = (t) => t.replace(/\{trade\}/g, trade).replace(/\{town\}/g, town || "your area");
  const problems = Object.keys(SAY).filter((k) => findings.includes(k)).map((k) => fill(SAY[k]));
  const uniq = [...new Set(problems)].slice(0, 3);
  const top = uniq[0] || "";
  const goodReviews = lead.rating >= 4.5 && lead.review_count >= 10;
  const m = lead.map_rank || lead.audit?.map_rank || {};
  const weekend = isWeekend(today);
  const month = today.toLocaleDateString("en-GB", { month: "long" });
  const demo = lead.demo_url || opts.demoUrl || ""; // only say "I've built you a site" once it exists

  const prep = [
    `Who: ${first ? `${first} (owner)` : "the owner (name not confirmed: ask for \"whoever runs the business\")"} · ${business} · ${titleCase(trade)}${town ? ` in ${town}` : ""}`,
    lead.rating ? `Google: ${lead.rating}★ from ${lead.review_count || 0} reviews${goodReviews ? " (strong: say so)" : ""}` : "Google: no reviews yet",
    m.top3_pct !== undefined ? `Google Maps: top 3 in ${Math.round(m.top3_pct)}% of ${town || "town"}${m.found_pct === 0 ? " (not in the top 20 anywhere)" : ""}` : "",
    uniq.length ? `What we found: ${uniq.join("; ")}.` : "What we found: nothing major. Lead with Google Maps and reviews instead.",
    weekend ? "Today's a weekend: the weekend deal is on (£2,000 → £1,750 and 90 days free)." : "",
    "Goal of this call: close, or book the next step. Not \"a good chat\".",
    "10 seconds first: picture it going well. You're there to help; if it's not a fit, that's fine.",
  ].filter(Boolean);

  const opener = [
    first ? `"Hi, is that ${first}?"` : `"Hi, could I speak to whoever runs ${business}?"`,
    `"It's ${me} from Aetos Websites. I'll be quick, I promise. I was looking for a ${trade}${town ? ` in ${town}` : ""} and came across you.${goodReviews ? ` ${lead.rating} stars from ${lead.review_count} reviews, that's really good going.` : ""} Have you got two minutes?"`,
    `Small talk (genuine, short): "How's business been this ${month}?" Listen. Note anything they say about being busy or quiet.`,
    `Reason: "Real quick, let me tell you what I've seen."${top ? ` "${top[0].toUpperCase() + top.slice(1)}."` : ""} Then stop and let them react.`,
  ];

  const qualify = [
    "Ask, then shut up and listen. Write their answers down: you'll use them in the pitch.",
    "\"How do most new customers find you at the moment?\"",
    "\"What's a typical job worth to you, roughly?\"",
    "\"Could you take on more work right now, if it came in?\"",
    "\"What's the hardest part about getting new work?\"",
    "\"If things stay the same for the next 6 months, what does that look like for you?\"",
    "\"If we sorted it, could you handle the extra jobs?\"",
    "Money lens: their job value × 2–3 extra jobs a month vs £249. Say the maths out loud if it helps.",
  ];

  const pitch = [
    `Problem: "So you said [their words]. And ${top || "right now you're not where people look first on Google"}."`,
    `Agitate: "Most people ring one of the first three businesses Google shows them${town ? ` around ${town}` : ""}. Every week you're not there, those calls go to someone else." Use their own answers here.`,
    "Dismiss the other options (casually, never insulting): sites like Bark charge you per lead and send the same job to several firms; directories like Checkatrade charge every month and list you next to your competitors. Cheap DIY sites look fine but don't get you found.",
    demo
      ? `Solve: "I've actually built a demo site for ${business} already. Can I send you the link while we're on the phone?" Walk them through it: their name, their reviews, the call button.`
      : `Solve: "Let me show you rather than tell you. I'll put together a demo of your new site and send it over, so you can see exactly what you'd get before you decide." Agree when you'll send it.`,
    "\"We build it, get you onto the front page of Google, and keep improving it every month. Live in 7 days, guaranteed. Front page of Google in 90 days, or we keep working for free until you are.\"",
  ];

  const close = [
    "Don't ask \"so, what do you think?\". Go straight into how it works:",
    weekend
      ? "\"It's normally around £2,000 for the build, but this weekend it's £1,750, and the monthly Google work is £249 with the first 90 days free.\""
      : "\"The build is £1,950, and the monthly Google work is £249, with the first 60 days free.\"",
    "\"There's no contract and no cancellation fees. If we're not making you money, we don't want your money.\"",
    "\"Here's what happens next: I'll send you the link, it takes a couple of minutes, then we need your logo and a few photos, and you're live within 7 days of getting them. What's the best email for the paperwork?\"",
    "After they pay: the welcome email goes out straight away. Say \"paperwork\", never \"contract\".",
  ];

  const objections = [
    ["\"It costs too much.\"", [
      "\"It costs too much?\" Then stop. Let them fill the silence.",
      "\"What makes you say that?\" / \"Compared to what?\" Find what they're really comparing it to.",
      "\"Did they guarantee you'd be on the front page of Google? We do, or we work for free until you are.\"",
      "\"The price is the same for every business we work with.\" Use their job value: \"How many extra jobs would it take to pay for itself?\"",
    ]],
    ["\"I need to think about it.\"", [
      "\"Yeah, I'm with you.\" Then a quick recap: their problem, what they've tried, how this fixes it without the downsides.",
      "\"I know you've got a thousand things on, I do too. Is there anything specific stopping us sorting it now? I'd love to get you live this week.\"",
      "If they still want to think: let it go, be friendly, agree when you'll follow up. Afterwards, work out where you lost them.",
    ]],
    ["\"Just send me some information.\"", [
      "\"Of course. So I send the right thing, what specifically do you want to know more about?\"",
      "\"I can go over it now, it'd only take a couple of minutes.\"",
      "If not: send the demo link with a short note on what it fixes for them, and the next step.",
    ]],
    ["\"I've already got a website.\"", [
      "\"That's good, most people do. The question is whether it's bringing you work.\"",
      top ? `"When I looked, ${top}. That's where the calls are going."` : "\"Are you getting calls from it each week? If not, that's what we fix.\"",
      "\"You keep the site whatever happens, and there's no contract. It's low risk to try.\"",
    ]],
    ["\"Word of mouth is enough for me.\"", [
      "\"That's great, it means you're good at what you do.\"",
      "\"When someone's recommended you, the first thing they do is Google you. What do they find?\"",
      "\"Word of mouth dries up in quiet months. This is for the people who don't know anyone to ask.\"",
    ]],
    ["\"Which other clients have you got?\"", [
      "Be honest. Never invent clients.",
      "\"We're building up in your area now, which is why everything's guaranteed: live in 7 days, and front page of Google in 90 days or we work for free.\"",
      "\"And there's no contract, so you're not taking a risk on us.\"",
    ]],
  ];

  const voicemail = [
    demo
      ? `"Hi${first ? ` ${first}` : ""}, it's ${me} from Aetos Websites. I've built a new website for ${business} to show you what it could look like. ${lead.email ? "I'll email you the link" : "Call me back on this number and I'll send you the link"}. Speak soon."`
      : `"Hi${first ? ` ${first}` : ""}, it's ${me} from Aetos Websites. I help ${trade}s${town ? ` in ${town}` : ""} get more calls from Google, and I've spotted a couple of quick wins for ${business}. Call me back on this number when you get a sec. Cheers."`,
  ];

  return [
    { title: "Before you dial", lines: prep },
    { title: "Open", lines: opener },
    { title: "Qualify (listen more than you talk)", lines: qualify },
    { title: "Pitch (problem → why it matters → the fix)", lines: pitch },
    { title: "Close", lines: close },
    ...objections.map(([q, lines]) => ({ title: `If they say ${q}`, lines, objection: true })),
    { title: "Voicemail", lines: voicemail },
  ];
}
