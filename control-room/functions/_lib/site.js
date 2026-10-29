// The public website on the root domain (site:root_host, default aetoswebsites.com): the landing page, the privacy
// notice, the 404 page and robots.txt, plus the trader line stage 9's pages use too. The middleware routes the root
// host here (control-room/functions/_middleware.js).
//
// The render functions are pure (HTML strings); loadSiteSettings and rootHostFor read D1. The copy is exactly Part A
// of docs/rebuild/01-foundations.md, every price comes from offer.js, and every setting value goes through h().
// Look: docs/brand.md (Inter, Charcoal and Marble sections, gold only on the two "Email us" buttons, the guarantee
// line's underline and the weekend tag). All CSS is inline; the only external resource is Google Fonts' Inter.
// Tested in control-room/tests/site.test.mjs.
import { BUILD_GUARANTEE, GUARANTEE, formatPounds, offerFor } from "./offer.js";
import { getSetting } from "./settings.js";
import { ukDate, ukParts } from "./ukTime.js";

export const DEFAULT_ROOT_HOST = "aetoswebsites.com";
export const DEFAULT_CONTACT = "hello@aetoswebsites.com";

// The day the privacy notice's wording last changed (UK date). Change it whenever the notice's text changes: the page
// says "Last updated <this day>", so it must never be the day someone happens to read it.
export const PRIVACY_UPDATED = "2026-10-22";

export const ROBOTS = "User-agent: *\nDisallow: /d/\nDisallow: /onboard/\nDisallow: /s/\nDisallow: /api/\n";

const HTML_HEADERS = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=300",
  "x-frame-options": "DENY",
});

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A setting as one line of text: each line trimmed and the lines joined with ", " (an address typed over several
// lines), runs of spaces collapsed.
function oneLine(value) {
  return String(value ?? "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\s+/g, " ").trim().replace(/,+$/, "").trim())
    .filter(Boolean)
    .join(", ");
}

// For text that a sentence's own full stop follows (an address, the ICO number): no trailing ".", so never "..".
const beforeStop = (value) => oneLine(value).replace(/[\s.,]+$/, "");

// The contact address, or the default when the setting is empty or isn't a plain email address (it goes into a
// mailto: link, so nothing that could add ?cc= or break out of the attribute).
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const contactFor = (email) => {
  const e = String(email ?? "").trim();
  return EMAIL_RE.test(e) ? e : DEFAULT_CONTACT;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "2026-10-22" (or a Date, read as its UK day) → "22 October 2026".
function longDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value instanceof Date ? ukDate(value) : String(value ?? ""));
  const month = m && MONTHS[Number(m[2]) - 1];
  if (!month) throw new Error(`The privacy notice's "last updated" date must look like YYYY-MM-DD, got ${JSON.stringify(String(value).slice(0, 40))}`);
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/**
 * "Aetos Websites is a trading name of {legal_name}, {address}." when both are filled in, else "". Raw text: callers
 * escape it. The landing and privacy footers use it, and so do stage 9's pages.
 */
export function traderLine(business) {
  const name = oneLine(business?.legal_name);
  const address = beforeStop(business?.address);
  return name && address ? `Aetos Websites is a trading name of ${name}, ${address}.` : "";
}

/** The landing page and privacy notice headers (no noindex: these pages are meant to be found). */
export function siteResponse(html, status = 200) {
  return new Response(html, { status, headers: { ...HTML_HEADERS } });
}

// ---------------------------------------------------------------- the look

const FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800&amp;display=swap";

const CSS = `:root{--charcoal:#1A1C20;--white:#FFFFFF;--graphite:#2E3135;--marble:#F6F4EF;--stone:#D9D4CA;--slate:#5C6066;--gold:#C9A13B;--gold-text:#7A5C14}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--marble);color:var(--slate);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-size:17px;line-height:1.6;overflow-wrap:break-word}
.wrap{max-width:1000px;margin:0 auto;padding:0 16px}
.narrow{max-width:760px}
section,.page{padding:56px 0}
h1,h2,h3{font-weight:700;line-height:1.2;margin:0 0 16px}
h1{font-size:clamp(34px,8vw,56px);letter-spacing:-.02em}
h2{font-size:clamp(26px,5vw,34px);letter-spacing:-.01em}
h3{font-size:21px}
p,ul,ol{margin:0 0 16px}
.dark{background:var(--charcoal);color:var(--white)}
.dark h1,.dark h2,.dark h3,.dark strong{color:var(--white)}
.dark a{color:var(--white)}
.light{background:var(--marble);color:var(--slate)}
.light h1,.light h2,.light h3,.light strong{color:var(--charcoal)}
.light a{color:var(--gold-text)}
.light+.light{border-top:1px solid var(--stone)}
.btn,.dark .btn{display:inline-block;background:var(--gold);color:var(--charcoal);font-weight:700;text-decoration:none;padding:10px 18px;border-radius:8px;white-space:nowrap}
.btn:hover{filter:brightness(1.08)}
.btn-big{font-size:19px;padding:14px 28px}
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:14px;padding-bottom:14px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none}
.brand img{display:block;flex:none}
.word{display:block;font-weight:800;font-size:21px;letter-spacing:.1em;line-height:1}
.sub{display:block;font-size:10px;letter-spacing:.34em;color:var(--stone);margin-top:5px;line-height:1}
.hero{padding:48px 0 64px}
.lead{font-size:clamp(19px,3.4vw,23px);max-width:40em}
.promise{font-size:clamp(19px,3.4vw,23px);text-decoration:underline;text-decoration-color:var(--gold);text-decoration-thickness:3px;text-underline-offset:7px;margin:24px 0 28px}
.note{font-size:15px;color:var(--stone);margin-top:12px}
.trades{font-size:18px;max-width:46em}
.gets{list-style:none;padding:0;display:grid;gap:16px}
.gets li,.card{background:var(--white);border:1px solid var(--stone);border-radius:12px;padding:22px}
.cards{display:grid;gap:16px;align-items:start}
.card h3{margin-bottom:8px}
.card.main{background:var(--charcoal);border-color:var(--charcoal);color:var(--white)}
.card.main h3,.card.main strong{color:var(--white)}
.card.main s{color:var(--stone)}
.price{font-size:18px}
.tag{display:inline-block;background:var(--gold);color:var(--charcoal);font-weight:700;font-size:14px;padding:3px 10px;border-radius:999px;margin:0 0 12px}
.ticks{padding-left:20px;margin:0}
.ticks li{margin:6px 0}
.small{font-size:15px;margin-top:16px}
.steps{padding-left:24px}
.steps li{margin:8px 0}
.foot{padding:32px 0;font-size:15px;color:var(--stone)}
.foot p{margin:0 0 8px}
.doc h2{font-size:22px;margin-top:36px}
.doc ul{padding-left:22px}
.doc li{margin:6px 0}
.home{font-weight:700}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (min-width:720px){section,.page{padding:72px 0}.gets,.cards{grid-template-columns:1fr 1fr}}`;

function page({ title, description = "", landing = false, body }) {
  return `<!doctype html>
<html lang="en-GB"${landing ? " data-aetos-landing" : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${description ? `<meta name="description" content="${description}">\n` : ""}<meta name="theme-color" content="#1A1C20">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// The logo and the wordmark, linking home; the gold "Email us" button only on the landing page.
const header = (mailto = "") => `<header class="dark">
<div class="wrap bar">
<a class="brand" href="/"><img src="/logo.png" width="40" height="40" alt=""><span><span class="word">AETOS</span><span class="sub">WEBSITES</span></span></a>
${mailto ? `<a class="btn" href="${mailto}">Email us</a>\n` : ""}</div>
</header>`;

function footer(business, contact, now) {
  const trader = traderLine(business);
  return `<footer class="dark foot">
<div class="wrap">
<p>${trader ? h(trader) : "Aetos Websites"}</p>
<p><a href="/privacy">Privacy notice</a> · <a href="mailto:${h(contact)}">${h(contact)}</a> · © ${ukParts(now).y} Aetos Websites</p>
</div>
</footer>`;
}

// ---------------------------------------------------------------- the pages

/**
 * The landing page at `now` (the weekend deal on Saturday and Sunday, UK time). `extras` are the switches
 * offer:chatbot_live and offer:review_booster_live: the review lines show only while `reviews` is on, the chat
 * assistant lines (stage 10, docs/rebuild/09-build.md section 11) only while `chatbot` is on.
 */
export function renderLanding({ business, contactEmail, now = new Date(), extras = { chatbot: false, reviews: false } } = {}) {
  const contact = contactFor(contactEmail);
  const mailto = `mailto:${h(contact)}?subject=Website%20for%20my%20business`;
  const offer = offerFor(now);
  const full = offer.full;
  const reviews = Boolean(extras?.reviews);
  const chatbot = extras?.chatbot === true;
  // The struck-through price is the real weekday price (offer.js); screen readers hear "Was … now …".
  const was = full.wasBuild ? `<span class="sr">Was </span><s>${formatPounds(full.wasBuild)}</s> <span class="sr">now </span>` : "";

  const body = `${header(mailto)}
<main>
<section class="dark hero">
<div class="wrap">
<h1>More jobs from Google for local trades.</h1>
<p class="lead">A new website, live in 7 days, and your business in the top 3 on Google in your area.</p>
<p class="promise"><strong>${GUARANTEE.headline}</strong></p>
<p><a class="btn btn-big" href="${mailto}">Email us</a></p>
<p class="note">Send your business name and town. We'll build you a free preview of your new site.</p>
</div>
</section>
<section class="light">
<div class="wrap">
<h2>Built for owner-run trades</h2>
<p class="trades">Roofers, plumbers, heating engineers, electricians, landscapers, removals, mechanics, locksmiths, pest control, independent car dealers, driving schools and martial arts gyms. If your customers search Google for what you do in your town, this is for you.</p>
</div>
</section>
<section class="light">
<div class="wrap">
<h2>What you get</h2>
<ul class="gets">
<li><strong>A website that wins work.</strong> Written for your trade and your town, with your own photos, your reviews and an easy way to call or message you. Live in 7 days.</li>
<li><strong>Found on Google.</strong> We set up and look after your Google Business Profile and your site, so people searching for your service in your area find you first.</li>
${reviews ? "<li><strong>More reviews, the honest way.</strong> Your Google review link, a QR card for jobs, and ready-to-send messages to ask every customer.</li>\n" : ""}${chatbot ? "<li><strong>Never miss an enquiry.</strong> A chat assistant on your website answers questions and passes enquiries to you, day and night.</li>\n" : ""}<li><strong>Looked after every month.</strong> Hosting, updates and changes, plus a short monthly report on where you rank and how your reviews are growing.</li>
</ul>
</div>
</section>
<section class="light" id="prices">
<div class="wrap">
<h2>Prices</h2>
<div class="cards">
<div class="card main">
<h3>Full Package</h3>
${offer.weekend ? '<p class="tag">Weekend deal: ends Sunday midnight</p>\n' : ""}<p class="price">${was}<strong>${formatPounds(full.build)}</strong> to build, then <strong>${formatPounds(full.monthly)} a month</strong>. <strong>First ${full.freeDays} days free.</strong></p>
<ul class="ticks">
<li>${BUILD_GUARANTEE}</li>
<li>${GUARANTEE.headline}</li>
<li>Google Business Profile set up and looked after</li>
${reviews ? "<li>Review booster</li>\n" : ""}${chatbot ? "<li>Chat assistant on your website, day and night</li>\n" : ""}<li>Monthly care and report</li>
</ul>
</div>
<div class="card">
<h3>Website Only</h3>
<p class="price"><strong>${formatPounds(offer.website.build)}</strong> one-off. Nothing monthly.</p>
<ul class="ticks">
<li>${BUILD_GUARANTEE}</li>
<li>Yours to keep</li>
</ul>
</div>
</div>
<p class="small">The 7 days start when you've filled in our short onboarding form.</p>
</div>
</section>
<section class="dark">
<div class="wrap">
<h2>The guarantee</h2>
<p>${GUARANTEE.section}</p>
<p>We measure it on Google's results for your main service and your town, searched from your area. The map results at the top count.</p>
</div>
</section>
<section class="light">
<div class="wrap">
<h2>How it works</h2>
<ol class="steps">
<li>Email us your business name and town.</li>
<li>We build a preview of your new website, free, so you can see it before you pay anything.</li>
<li>Like it? Pay online, fill in a short form, and your site is live within 7 days.</li>
</ol>
</div>
</section>
<section class="light">
<div class="wrap">
<h2>No contract</h2>
<p>No contract and no cancellation fees. If we're not making you money, we don't want your money. If you stop paying, you keep your website and the monthly work stops.</p>
</div>
</section>
<section class="light">
<div class="wrap">
<h2>Talk to us</h2>
<p>Email <strong><a href="${mailto}">${h(contact)}</a></strong> with your business name and town, and we'll take it from there.</p>
</div>
</section>
</main>
${footer(business, contact, now)}`;

  return page({
    title: "Aetos Websites | More work from Google for local trades",
    description: "Websites for local trades, live in 7 days, and the top 3 on Google in your area in 90 days, guaranteed.",
    landing: true,
    body,
  });
}

/**
 * The privacy notice. `updated` is the day its wording last changed (PRIVACY_UPDATED); `now` only sets the footer's
 * year. With no legal name yet it says "a trading name of a sole trader", never a blank or a placeholder.
 */
export function renderPrivacy({ business, contactEmail, updated = PRIVACY_UPDATED, now = new Date() } = {}) {
  const contact = contactFor(contactEmail);
  const email = `<a href="mailto:${h(contact)}">${h(contact)}</a>`;
  const name = oneLine(business?.legal_name);
  const address = beforeStop(business?.address);
  const ico = beforeStop(business?.ico_number);
  const who = `Aetos Websites is a trading name of ${name ? `${h(name)}, a sole trader` : "a sole trader"} in the UK${address ? `, ${h(address)}` : ""}. Email: ${email}. We decide how the information below is used (we're the "controller").${ico ? ` ICO registration number: ${h(ico)}.` : ""}`;

  const body = `${header()}
<main class="light page doc">
<div class="wrap narrow">
<h1>Privacy notice</h1>
<p>Last updated ${longDate(updated)}.</p>
<h2>Who we are</h2>
<p>${who}</p>
<h2>What this covers</h2>
<p>We build websites for local trade businesses and help them get found on Google. To do that, we look for businesses we could help and email them. This notice explains what we hold about you if we've contacted you, if you've contacted us, or if you're a customer.</p>
<h2>What we collect and where from</h2>
<p>If we've contacted you, we found your business through public sources:</p>
<ul>
<li>your Google Business listing: business name, address, phone number, website, opening hours, star rating and public reviews;</li>
<li>your own website: contact email addresses, the names of the people who run the business, your services, your logo, colours and photos;</li>
<li>the Companies House register, if your business is a company: directors' names;</li>
<li>public business directories and your business's social media pages.</li>
</ul>
<p>We also keep the emails we exchange with you, and the date and time of each visit to the preview website we made for you. Our emails contain no tracking pixels.</p>
<p>If you become a customer, we also hold your contact details, your answers to our onboarding form and your payment records. Card payments are handled by Stripe; we never see your full card number.</p>
<h2>Why we use it, and our legal basis</h2>
<ul>
<li>To offer you our services by email, and to build the preview website we show you: our legitimate interest in telling local businesses about a service that can help them. We only use business contact details and information about your business. We only write about our own services, and every email lets you opt out with one reply.</li>
<li>To decide who to contact first, we score businesses on things like how easy they are to find on Google. This has no legal or similar effect on you.</li>
<li>If you're a customer: to provide the service you paid for (contract), and to keep accounts (legal obligation).</li>
</ul>
<h2>Who we share it with</h2>
<p>Only the service providers that run our business, under contracts that require them to protect it:</p>
<ul>
<li>Cloudflare: website hosting and database.</li>
<li>Namecheap: email.</li>
<li>Stripe: payments.</li>
<li>Google: business listing data.</li>
<li>Anthropic: an AI assistant that helps research businesses and draft replies.</li>
<li>GitHub: runs our software.</li>
</ul>
<p>Some of them are in the USA. Those transfers are covered by the UK's approved safeguards (the UK–US data bridge or standard contract clauses). We never sell your information.</p>
<h2>How long we keep it</h2>
<ul>
<li>If we contacted you and you didn't become a customer, we delete your details 12 months after our last contact.</li>
<li>If you ask us to stop, we delete them but keep your email address on a do-not-contact list, so we never email you again.</li>
<li>Customer records are kept for 6 years after you stop being a customer, because HMRC requires it.</li>
</ul>
<h2>Your rights</h2>
<p>You can ask us for a copy of your information, ask us to correct or delete it, or ask us to stop using it. You can object to marketing at any time: reply "no thanks" to any of our emails, or email ${email}, and we'll stop straight away. We answer any other request within one month.</p>
<h2>Cookies</h2>
<p>This website sets no cookies and uses no tracking.</p>
<h2>Complaints</h2>
<p>If you're unhappy with how we've handled your information, please tell us first at ${email}. You can also complain to the Information Commissioner's Office: <a href="https://ico.org.uk/make-a-complaint/">https://ico.org.uk/make-a-complaint/</a> or 0303 123 1113.</p>
</div>
</main>
${footer(business, contact, now)}`;

  return page({ title: "Privacy notice | Aetos Websites", body });
}

/** The root host's 404 page (send it with status 404): same look, a gold link home. */
export function renderNotFound() {
  return page({
    title: "Page not found | Aetos Websites",
    body: `${header()}
<main class="light page">
<div class="wrap">
<h1>That page doesn't exist.</h1>
<p><a class="home" href="/">Go to the home page</a></p>
</div>
</main>`,
  });
}

// ---------------------------------------------------------------- settings (db)

const SITE_KEYS = ["business:legal_name", "business:address", "business:ico_number", "site:contact_email", "offer:chatbot_live", "offer:review_booster_live"];

/**
 * What the landing page and privacy notice read, in one query: {business: {legal_name, address, ico_number},
 * contactEmail (site:contact_email, default hello@aetoswebsites.com), extras: {chatbot, reviews}} ('1' = on).
 */
export async function loadSiteSettings(DB) {
  const { results } = await DB.prepare(`SELECT key, value FROM settings WHERE key IN (${SITE_KEYS.map(() => "?").join(", ")})`)
    .bind(...SITE_KEYS)
    .all();
  const s = Object.fromEntries((results || []).map((row) => [row.key, row.value]));
  return {
    business: { legal_name: s["business:legal_name"] ?? "", address: s["business:address"] ?? "", ico_number: s["business:ico_number"] ?? "" },
    contactEmail: contactFor(s["site:contact_email"]),
    extras: { chatbot: s["offer:chatbot_live"] === "1", reviews: s["offer:review_booster_live"] === "1" },
  };
}

const ROOT_TTL_MS = 60000;
const rootCache = new WeakMap(); // database → {host, until}: one D1 read a minute per isolate

// "https://Example.ORG./" → "example.org"; anything that isn't a host name → "".
function tidyHost(value) {
  const host = String(value ?? "").trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/\.+$/, "");
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host) ? host : "";
}

/**
 * The public site's host: the setting site:root_host, default aetoswebsites.com, cached for 60 s per database. If D1
 * can't be read it's the default (not cached, so the next request tries again).
 */
export async function rootHostFor(env, DB = env?.DB) {
  if (!DB || (typeof DB !== "object" && typeof DB !== "function")) return DEFAULT_ROOT_HOST;
  const t = Date.now();
  const hit = rootCache.get(DB);
  if (hit && t < hit.until) return hit.host;
  try {
    const host = tidyHost(await getSetting(DB, "site:root_host")) || DEFAULT_ROOT_HOST;
    rootCache.set(DB, { host, until: t + ROOT_TTL_MS });
    return host;
  } catch (err) {
    const why = String(err?.message ?? err).split("\n")[0].slice(0, 300);
    console.error(`Couldn't read the site:root_host setting, so ${DEFAULT_ROOT_HOST} is the public site for now: ${why}`);
    return DEFAULT_ROOT_HOST;
  }
}
