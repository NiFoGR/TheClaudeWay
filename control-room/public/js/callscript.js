// The call script for one lead, filled from what we know about them (no AI, free). Built on the playbook
// (docs/playbooks/business-sales-marketing-notes.md): open → small talk → reason → qualify (SPIN, money lens) →
// PAS tailored to their answers → close smoothly (never "so, what do you think?") → objections.
// Everything said must be true: only facts the audit and Claude's research proved; prices and the weekend deal from the
// offer GET /api/leads/:id sends (stage 0's offerFor, in pence, so the weekend is decided by UK time on the server);
// the guarantee in its exact words (stage 0's GUARANTEE, sent with it). This file writes no price of its own (a test
// checks). Pure (no DOM), so it's tested in control-room/tests/callscript.test.mjs.

const titleCase = (s) => String(s || "").toLowerCase().replace(/(^|[\s-])\S/g, (m) => m.toUpperCase());

/** "SMITH ROOFING LTD - Roofer in Leeds" → "Smith Roofing" */
export function shortName(name) {
  let n = String(name || "").split(/\s+[-|–]\s+/)[0].trim().replace(/[,.]?\s+(ltd\.?|limited|llp|plc)$/i, "").trim();
  if (n && n === n.toUpperCase() && /[A-Z]{3}/.test(n)) n = titleCase(n);
  return n;
}

// A first name as research gave it; an all-capitals or all-lower-case one (a form or a register) in title case.
function firstName(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s && (s === s.toUpperCase() || s === s.toLowerCase()) ? titleCase(s) : s;
}

/** Pence as pounds, written exactly as stage 0's formatPounds writes them: commas, pennies only when there are some. */
export function pounds(pence) {
  if (typeof pence !== "number" || !Number.isFinite(pence) || Math.abs(pence) > Number.MAX_SAFE_INTEGER) {
    const shown = typeof pence === "string" ? JSON.stringify(pence.slice(0, 40)) : String(pence);
    throw new Error(`The call script needs an amount in pence (a number), got ${shown}`);
  }
  const whole = Math.round(Math.abs(pence));
  const units = String(Math.floor(whole / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const pennies = whole % 100;
  const sign = pence < 0 && whole > 0 ? "-" : "";
  return `${sign}£${units}${pennies ? `.${String(pennies).padStart(2, "0")}` : ""}`;
}

// The weekend's spoken anchor: the real weekday build price rounded to the nearest hundred pounds ("around" it; only
// ever said, never written). Empty when the offer has no weekday price to round.
const anchorOf = (full) => (typeof full.wasBuild === "number" ? pounds(Math.round(full.wasBuild / 10000) * 10000) : "");

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
 * Sections of the script: [{title, lines: [string], objection?}].
 * lead = {name, trade, town, rating, review_count, findings, map_rank, owner_first, email, demo_url, angle}: owner_first
 * only when research marked the owner confident (else null), map_rank {} when there's none of their own town.
 * opts = {sender = "Nik", offer, guarantee, today = new Date()}: offer = offerFor(date) and guarantee = GUARANTEE, as
 * the drawer payload (GET /api/leads/:id) carries them. Throws without them. `today` only names the month.
 */
export function callScript(lead, opts = {}) {
  const { offer, guarantee, today: day, sender, demoUrl } = opts ?? {};
  // offerFor's shape: {weekend, full: {build, monthly, freeDays, …}}; the prices are checked by pounds() below.
  if (!offer?.full || !Number.isSafeInteger(offer.full.freeDays) || offer.full.freeDays < 0
    || typeof guarantee?.headline !== "string" || typeof guarantee?.section !== "string") {
    throw new Error("callScript needs opts.offer and opts.guarantee from /api/leads/:id");
  }
  const today = day || new Date();
  const me = sender || "Nik";
  const business = shortName(lead.name);
  const trade = String(lead.trade || "").toLowerCase() || "business";
  const town = titleCase(lead.town || lead.search_town || "");
  const first = firstName(lead.owner_first);
  const findings = Array.isArray(lead.findings) ? lead.findings : [];
  const fill = (t) => t.replace(/\{trade\}/g, trade).replace(/\{town\}/g, town || "your area");
  const problems = Object.keys(SAY).filter((k) => findings.includes(k)).map((k) => fill(SAY[k]));
  const uniq = [...new Set(problems)].slice(0, 3);
  const top = uniq[0] || "";
  const goodReviews = lead.rating >= 4.5 && lead.review_count >= 10;
  const m = lead.map_rank && typeof lead.map_rank === "object" ? lead.map_rank : {};
  const weekend = offer.weekend === true; // offerFor decides, by UK time; then offer.full is the weekend package
  const build = pounds(offer.full.build);
  const monthly = pounds(offer.full.monthly);
  const freeDays = offer.full.freeDays;
  const anchor = weekend ? anchorOf(offer.full) : "";
  const month = today.toLocaleDateString("en-GB", { month: "long", timeZone: "Europe/London" });
  const demo = lead.demo_url || demoUrl || ""; // only say "I've built you a site" once it exists
  const angle = (Array.isArray(lead.angle) ? lead.angle : [])
    .find((a) => a && typeof a === "object" && typeof a.fact === "string" && a.fact.trim());

  const prep = [
    `Who: ${first ? `${first} (owner)` : "the owner (name not confirmed: ask for \"whoever runs the business\")"} · ${business} · ${titleCase(trade)}${town ? ` in ${town}` : ""}`,
    lead.rating ? `Google: ${lead.rating}★ from ${lead.review_count || 0} reviews${goodReviews ? " (strong: say so)" : ""}` : "Google: no reviews yet",
    typeof m.top3_pct === "number" && Number.isFinite(m.top3_pct) ? `Google Maps: top 3 in ${Math.round(m.top3_pct)}% of ${town || "town"}${m.found_pct === 0 ? " (not in the top 20 anywhere)" : ""}` : "",
    uniq.length ? `What we found: ${uniq.join("; ")}.` : "What we found: nothing major. Lead with Google Maps and reviews instead.",
    angle ? `Angle: ${angle.fact.trim()}` : "",
    weekend ? `Today's a weekend: the weekend deal is on (${anchor ? `around ${anchor} → ` : ""}${build} and ${freeDays} days free).` : "",
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
    `Money lens: their job value × 2–3 extra jobs a month vs ${monthly}. Say the maths out loud if it helps.`,
  ];

  const pitch = [
    `Problem: "So you said [their words]. And ${top || "right now you're not where people look first on Google"}."`,
    `Agitate: "Most people ring one of the first three businesses Google shows them${town ? ` around ${town}` : ""}. Every week you're not there, those calls go to someone else." Use their own answers here.`,
    "Dismiss the other options (casually, never insulting): sites like Bark charge you per lead and send the same job to several firms; directories like Checkatrade charge every month and list you next to your competitors. Cheap DIY sites look fine but don't get you found.",
    demo
      ? `Solve: "I've actually built a demo site for ${business} already. Can I send you the link while we're on the phone?" Walk them through it: their name, their reviews, the call button.`
      : `Solve: "Let me show you rather than tell you. I'll put together a demo of your new site and send it over, so you can see exactly what you'd get before you decide." Agree when you'll send it.`,
    `"We build it, and it's live in 7 days, guaranteed. ${guarantee.headline} ${guarantee.section}"`,
  ];

  const close = [
    "Don't ask \"so, what do you think?\". Go straight into how it works:",
    weekend
      ? `"${anchor ? `It's normally around ${anchor} for the build, but this weekend it's ${build}` : `This weekend the build is ${build}`}, and the monthly Google work is ${monthly} with the first ${freeDays} days free."`
      : `"The build is ${build}, and the monthly Google work is ${monthly}, with the first ${freeDays} days free."`,
    "\"There's no contract and no cancellation fees. If we're not making you money, we don't want your money.\"",
    "\"Here's what happens next: I'll send you the link, it takes a couple of minutes, then we need your logo and a few photos, and you're live within 7 days of getting them. What's the best email for the paperwork?\"",
    "After they pay: the welcome email goes out straight away. Say \"paperwork\", never \"contract\".",
  ];

  const objections = [
    ["\"It costs too much.\"", [
      "\"It costs too much?\" Then stop. Let them fill the silence.",
      "\"What makes you say that?\" / \"Compared to what?\" Find what they're really comparing it to.",
      `"Did they guarantee you'd get into Google's top 3? We do. ${guarantee.section}"`,
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
      `"We're building up in your area now, which is why everything's guaranteed: your website's live in 7 days. ${guarantee.section}"`,
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
