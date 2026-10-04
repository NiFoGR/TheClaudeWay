// Demo sites: the page each lead's emails point to. Their business, made into a modern site, with a slim Aetos bar on
// top ("Built for you · preview until …") and one button, "Make it mine", to the order page.
// Pure (HTML strings), tested in control-room/tests/demo.test.mjs. Everything scraped is escaped.
// Truth rules: only their real name, phone, town, trade, Google rating and review count are shown as fact; anything
// we can't know (photos, their own words) is clearly a placeholder ("your photos go here").

import { PACKAGES } from "./money.js";

export const PREVIEW_DAYS = 14;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const titleCase = (s) => String(s || "").toLowerCase().replace(/(^|[\s-])\S/g, (m) => m.toUpperCase());
const pounds = (p) => `£${(p / 100).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;

export function shortName(name) {
  let n = String(name || "").split(/\s+[-|–]\s+/)[0].trim().replace(/[,.]?\s+(ltd\.?|limited|llp|plc)$/i, "").trim();
  if (n && n === n.toUpperCase() && /[A-Z]{3}/.test(n)) n = titleCase(n);
  return n;
}

/** URL-safe, unguessable: "smith-roofing-7k2p9q". */
export function slugFor(name, rand = () => Math.random()) {
  const base = shortName(name).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "your-business";
  const tail = Array.from({ length: 6 }, () => "abcdefghjkmnpqrstuvwxyz23456789"[Math.floor(rand() * 31)]).join("");
  return `${base}-${tail}`;
}

// services people search for, per trade (what the top-ranking sites in each trade list); a fallback for others
const SERVICES = {
  roof: ["New roofs", "Roof repairs", "Flat roofs", "Chimney work", "Guttering & fascias", "Emergency leaks"],
  plumb: ["Leaks & burst pipes", "Bathroom installs", "Boiler repairs", "Taps, toilets & showers", "Blocked drains", "Emergency call-outs"],
  heat: ["Boiler installs", "Boiler repairs & servicing", "Central heating", "Gas safety certificates", "Radiators", "Emergency call-outs"],
  electric: ["Rewires", "Fuse board upgrades", "EV chargers", "Lighting", "EICR safety checks", "Emergency call-outs"],
  locksmith: ["Emergency lockouts", "Lock changes", "uPVC door repairs", "Security upgrades", "Safe opening", "24/7 call-outs"],
  removal: ["House removals", "Office moves", "Packing service", "Storage", "Man & van", "Long-distance moves"],
  mechanic: ["Servicing", "MOT prep & repairs", "Brakes & clutches", "Diagnostics", "Tyres", "Air-con regas"],
  garage: ["Servicing", "MOT prep & repairs", "Brakes & clutches", "Diagnostics", "Tyres", "Air-con regas"],
  car: ["Quality used cars", "Part exchange", "Finance options", "Warranty", "Vehicle history checks", "Test drives"],
  pest: ["Rats & mice", "Wasp nests", "Bed bugs", "Moles", "Birds", "Commercial contracts"],
  driving: ["Beginner lessons", "Intensive courses", "Pass Plus", "Test preparation", "Refresher lessons", "Motorway lessons"],
  kickbox: ["Kickboxing", "Muay Thai", "Kids classes", "Beginners welcome", "Fitness & conditioning", "Personal training"],
  boxing: ["Boxing classes", "Kids classes", "Beginners welcome", "Fitness & conditioning", "Sparring", "Personal training"],
  martial: ["Adult classes", "Kids classes", "Beginners welcome", "Self-defence", "Gradings", "Personal training"],
  "muay thai": ["Muay Thai", "Kickboxing", "Kids classes", "Beginners welcome", "Fitness & conditioning", "Personal training"],
  mma: ["MMA", "Brazilian Jiu-Jitsu", "Kids classes", "Beginners welcome", "Fitness & conditioning", "Personal training"],
  gym: ["Classes", "Kids classes", "Beginners welcome", "Fitness & conditioning", "Personal training", "Open gym"],
};

export function servicesFor(trade) {
  const t = String(trade || "").toLowerCase();
  const key = Object.keys(SERVICES).find((k) => t.includes(k));
  return key ? SERVICES[key] : ["Free quotes", "Fully local service", "Fast response", "Domestic & commercial", "Repairs", "Installations"];
}

const isClass = (trade) => /kickbox|boxing|martial|muay|mma|gym|karate|judo|jiu|taekwondo|driving/i.test(String(trade || ""));

const stars = (r) => "★★★★★".slice(0, Math.round(r || 0)) + "☆☆☆☆☆".slice(0, 5 - Math.round(r || 0));

/** Saturday or Sunday in the UK (the weekend deal). */
export const isWeekendUK = (d = new Date()) => ["Sat", "Sun"].includes(new Date(d).toLocaleDateString("en-GB", { weekday: "short", timeZone: "Europe/London" }));

const fmtDay = (iso) => new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" });

const BASE_CSS = `
*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2433;background:#fff}
a{color:inherit}.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.ae-bar{position:sticky;top:0;z-index:10;background:#1A1C20;color:#fff;font-size:14px}
.ae-bar .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 20px;flex-wrap:wrap}
.ae-bar b{color:#E2C26A}.ae-btn{background:#C9A13B;color:#1A1C20;font-weight:700;text-decoration:none;padding:9px 16px;border-radius:8px;white-space:nowrap}
.ae-btn:hover{background:#E2C26A}
@media(max-width:600px){.ae-bar .wrap{flex-wrap:nowrap;padding:8px 14px}.ae-bar span{font-size:12.5px;line-height:1.35}.ae-btn{padding:8px 12px;font-size:13px}}
`;

/** The demo page for one lead. demo: {slug, expires_at}. */
export function renderDemo(lead, demo) {
  const name = shortName(lead.name);
  const trade = String(lead.trade || "").toLowerCase();
  const Trade = titleCase(trade);
  const town = titleCase(lead.town || lead.search_town || "");
  const phone = String(lead.phone || "").trim();
  const tel = phone.replace(/[^\d+]/g, "");
  const services = servicesFor(trade);
  const classes = isClass(trade);
  const rating = Number(lead.rating) || 0;
  const reviews = Number(lead.review_count) || 0;
  const cta = classes ? "Book a free trial class" : "Get a free quote";
  const headline = classes ? `${Trade} in ${town || "your area"}, for every level` : `Trusted ${trade} in ${town || "your area"}`;
  const sub = classes
    ? `Friendly, expert coaching at ${name}. Beginners welcome, no experience needed.`
    : `Fast, reliable and fairly priced. Call ${name} today for a free, no-obligation quote.`;
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(name)} · ${esc(Trade)}${town ? ` in ${esc(town)}` : ""}</title>
<style>${BASE_CSS}
.hero{background:linear-gradient(135deg,#0f2a4a,#1e4f86);color:#fff;padding:72px 0 64px}
.hero h1{font-size:clamp(30px,5vw,48px);line-height:1.15;margin:0 0 12px}.hero p{font-size:19px;opacity:.92;max-width:620px;margin:0 0 26px}
.rate{display:inline-flex;gap:8px;align-items:center;background:rgba(255,255,255,.12);padding:6px 12px;border-radius:99px;margin-bottom:18px;font-size:15px}
.rate .s{color:#ffc93c;letter-spacing:1px}.btns{display:flex;gap:12px;flex-wrap:wrap}
.b1{background:#ff7a1a;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:10px}
.b2{border:2px solid #fff;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px}
section{padding:56px 0}h2{font-size:30px;margin:0 0 8px}.lead{color:#5b6476;margin:0 0 28px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.card{border:1px solid #e6e9f0;border-radius:12px;padding:22px;background:#fff}.card h3{margin:0 0 6px;font-size:18px}.card p{margin:0;color:#5b6476;font-size:15px}
.alt{background:#f5f7fb}.why{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
.why div{padding:18px;border-left:4px solid #ff7a1a;background:#fff;border-radius:8px}
.ph{border:2px dashed #c9d1e0;border-radius:12px;min-height:150px;display:grid;place-items:center;color:#8a93a6;font-size:14px;text-align:center;padding:12px}
.quote{display:grid;gap:12px;max-width:560px}.quote input,.quote textarea{font:inherit;padding:12px 14px;border:1px solid #cfd6e3;border-radius:8px}
.quote button{background:#ff7a1a;color:#fff;border:0;font:inherit;font-weight:700;padding:14px;border-radius:10px;cursor:pointer}
.note{font-size:13px;color:#8a93a6}footer{background:#0f2a4a;color:#c9d6ea;padding:28px 0;font-size:14px}
.callfab{position:fixed;right:16px;bottom:16px;background:#ff7a1a;color:#fff;text-decoration:none;font-weight:700;padding:14px 18px;border-radius:99px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
@media(min-width:900px){.callfab{display:none}}
</style></head><body>
<div class="ae-bar"><div class="wrap"><span>Your new website, built for <b>${esc(name)}</b> · preview until ${esc(fmtDay(demo.expires_at))}</span>
<a class="ae-btn" href="/d/${esc(demo.slug)}/order" data-ev="order_page">Make it mine →</a></div></div>
<header class="hero"><div class="wrap">
${rating ? `<div class="rate"><span class="s">${stars(rating)}</span><b>${esc(rating.toFixed(1))}</b> from ${esc(reviews)} Google reviews</div>` : ""}
<h1>${esc(headline)}</h1><p>${esc(sub)}</p>
<div class="btns">${tel ? `<a class="b1" href="tel:${esc(tel)}">Call ${esc(phone)}</a>` : ""}<a class="${tel ? "b2" : "b1"}" href="#quote">${esc(cta)}</a></div>
</div></header>
<section><div class="wrap"><h2>${classes ? "Classes" : "Services"}</h2><p class="lead">${classes ? `What you can train at ${esc(name)}.` : `What ${esc(name)} can do for you${town ? ` across ${esc(town)} and nearby` : ""}.`}</p>
<div class="grid">${services.map((s) => `<div class="card"><h3>${esc(s)}</h3><p>${classes ? "Ask about times and prices." : "Free quote, no obligation."}</p></div>`).join("")}</div></div></section>
<section class="alt"><div class="wrap"><h2>Why ${esc(name)}</h2><p class="lead">Local, trusted, and easy to reach.</p><div class="why">
${rating ? `<div><b>${esc(rating.toFixed(1))}★ on Google</b><br>From ${esc(reviews)} real reviews.</div>` : ""}
<div><b>Local to ${esc(town || "you")}</b><br>${classes ? "Easy to get to, friendly faces." : "Quick to reach you when you need us."}</div>
<div><b>${classes ? "All levels welcome" : "Clear prices"}</b><br>${classes ? "From first timers to fighters." : "A proper quote before any work starts."}</div>
${tel ? `<div><b>Talk to a real person</b><br><a href="tel:${esc(tel)}">${esc(phone)}</a></div>` : ""}
</div></div></section>
<section><div class="wrap"><h2>Our work</h2><p class="lead">Your own photos go here, so customers see the real thing.</p>
<div class="grid"><div class="ph">Your photo</div><div class="ph">Your photo</div><div class="ph">Your photo</div></div></div></section>
<section class="alt" id="quote"><div class="wrap"><h2>${esc(cta)}</h2><p class="lead">On your live site, this goes straight to your phone and inbox.</p>
<form class="quote" onsubmit="event.preventDefault();this.querySelector('.note').textContent='Preview only: on your live site, this enquiry would reach you instantly.'">
<input placeholder="Your name" required><input placeholder="Phone number" required><textarea rows="3" placeholder="${classes ? "Which class are you interested in?" : "What do you need doing?"}"></textarea>
<button>${esc(cta)}</button><p class="note"></p></form></div></section>
<footer><div class="wrap">© ${new Date().getFullYear()} ${esc(name)}${town ? ` · ${esc(Trade)} in ${esc(town)}` : ""}${phone ? ` · ${esc(phone)}` : ""}</div></footer>
${tel ? `<a class="callfab" href="tel:${esc(tel)}">Call now</a>` : ""}
${beacon(demo.slug)}
</body></html>`;
}

/** Counts a view only after the page has been open for 4 seconds in a real browser (email scanners don't run this). */
function beacon(slug) {
  const url = `/d/${esc(slug)}/e`;
  return `<script>(function(){var u=${JSON.stringify(url)};function s(k){try{navigator.sendBeacon(u,JSON.stringify({kind:k}))}catch(e){}}
setTimeout(function(){if(document.visibilityState!=="hidden")s("view")},4000);
document.querySelectorAll("[data-ev]").forEach(function(a){a.addEventListener("click",function(){s(a.getAttribute("data-ev"))})});})();</script>`;
}

/** The order page: Full Package vs Website Only, weekend deal on Sat–Sun, guarantees, no contract, the usual questions. */
export function renderOrder(lead, demo, links = {}, now = new Date()) {
  const name = shortName(lead.name);
  const weekend = isWeekendUK(now);
  const full = weekend ? PACKAGES.weekend : PACKAGES.full;
  const fullLink = (weekend ? links.weekend : links.full)?.url;
  const siteLink = links.website?.url;
  const ref = (u) => (u ? `${u}${u.includes("?") ? "&" : "?"}client_reference_id=${encodeURIComponent(lead.place_id)}` : "");
  const faq = [
    ["What happens after I order?", "You get a short form for your logo, photos and details. Your website is live within 7 days of us getting them, guaranteed."],
    ["Is there a contract?", "No contract and no cancellation fees. If we're not making you money, we don't want your money. Stop the monthly plan any time and you keep the website."],
    ["What does the monthly plan do?", "We get you onto the front page of Google: your Google Business Profile, your site's pages and regular updates. Front page of Google in 90 days, or we keep working for free until you are."],
    ["Can I change things on the site?", "Yes. Tell us what you want changed before it goes live, and urgent changes (prices, phone number, opening times) are done straight away after that."],
    ["Who owns the website?", "You do. If you ever stop the monthly plan, you keep it."],
  ];
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Make it yours · ${esc(name)}</title>
<style>${BASE_CSS}
body{background:#f5f6f8}h1{font-size:clamp(26px,4vw,38px);margin:36px 0 6px}.lead{color:#5b6476;margin:0 0 26px}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}
.plan{background:#fff;border:1px solid #e3e6ec;border-radius:14px;padding:26px;display:flex;flex-direction:column}
.plan.main{border:2px solid #C9A13B;box-shadow:0 8px 30px rgba(201,161,59,.18)}.tag{align-self:flex-start;background:#1A1C20;color:#E2C26A;font-size:12px;font-weight:700;padding:4px 10px;border-radius:99px;margin-bottom:10px}
.price{font-size:34px;font-weight:800;margin:6px 0 2px}.was{text-decoration:line-through;color:#8a93a6;font-size:20px;margin-right:6px;font-weight:600}
.per{color:#5b6476;margin:0 0 14px}ul{padding-left:20px;margin:0 0 20px}li{margin-bottom:6px}
.go{margin-top:auto;display:block;text-align:center;text-decoration:none;font-weight:700;padding:14px;border-radius:10px;background:#1A1C20;color:#fff}
.plan.main .go{background:#C9A13B;color:#1A1C20}.go.off{opacity:.5;pointer-events:none}
.promise{background:#1A1C20;color:#fff;border-radius:14px;padding:22px 26px;margin:22px 0}.promise b{color:#E2C26A}
details{background:#fff;border:1px solid #e3e6ec;border-radius:10px;padding:14px 18px;margin-bottom:10px}summary{font-weight:700;cursor:pointer}
.small{font-size:13px;color:#8a93a6}
</style></head><body>
<div class="ae-bar"><div class="wrap"><span>Aetos Websites · for <b>${esc(name)}</b></span><a class="ae-btn" href="/d/${esc(demo.slug)}">← Back to your site</a></div></div>
<div class="wrap" style="padding-bottom:40px">
<h1>Make it yours</h1><p class="lead">Your website, live within 7 days. ${weekend ? "Weekend deal on now." : ""}</p>
<div class="plans">
<div class="plan main"><span class="tag">${weekend ? "Weekend deal" : "Most popular"}</span><h2 style="margin:0">Full Package</h2>
<div class="price">${weekend ? `<span class="was">${pounds(200000)}</span>` : ""}${pounds(full.build)}</div>
<p class="per">then ${pounds(full.monthly)}/month, <b>first ${full.freeDays} days free</b></p>
<ul><li>This website, made fully yours</li><li>Front page of Google in 90 days, or we work free until you are</li><li>Google Business Profile set up like the top 3</li><li>AI receptionist that answers enquiries 24/7</li><li>Monthly improvements, Google posts and a review booster</li><li>A plain-English monthly report</li></ul>
<a class="go${fullLink ? "" : " off"}" href="${esc(ref(fullLink))}" data-ev="order_click">Order the Full Package</a></div>
<div class="plan"><h2 style="margin:0">Website Only</h2><div class="price">${pounds(PACKAGES.website.build)}</div><p class="per">one-off, nothing monthly</p>
<ul><li>This website, made fully yours</li><li>Live in 7 days, guaranteed</li></ul>
<a class="go${siteLink ? "" : " off"}" href="${esc(ref(siteLink))}" data-ev="order_click">Order Website Only</a></div>
</div>
<div class="promise"><b>No contract. No cancellation fees.</b> If we're not making you money, we don't want your money. If you ever stop the monthly plan, you keep the website.</div>
<h2>Questions</h2>${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}
<p class="small">Payments are taken securely by Stripe.</p>
</div>${beacon(demo.slug).replace('s("view")', 's("order_page")')}
</body></html>`;
}

/** Shown after the preview date: no dead link, a way back in. */
export function renderExpired(lead) {
  const name = shortName(lead?.name || "");
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Preview ended</title><style>${BASE_CSS}body{background:#1A1C20;color:#fff;display:grid;place-items:center;min-height:100vh;text-align:center}
.box{max-width:520px;padding:24px}h1{font-size:28px}</style></head><body><div class="box"><h1>This preview has ended</h1>
<p>The website we built${name ? ` for ${esc(name)}` : ""} is no longer on show. Reply to our email if you'd like it back: we keep it for a little while.</p>
<p style="color:#E2C26A">Aetos Websites</p></div></body></html>`;
}
