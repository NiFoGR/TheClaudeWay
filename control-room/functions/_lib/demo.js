// The order page (and its ended page) for each lead's demo, until stage 9 moves them: GET /d/:slug/order. The demo
// page itself is drawn by the template engine in _lib/demo/ (GET /d/:slug, d/[slug]/index.js).
// Pure (HTML strings), tested in control-room/tests/demo.test.mjs. Everything shown is escaped.

import { PACKAGES } from "./money.js";
import { BUILD_GUARANTEE, GUARANTEE } from "./offer.js";
import { shortName, slugFor } from "./demo/text.js";

// shortName and slugFor live in demo/text.js now; re-exported here until stage 9 deletes this file.
export { shortName, slugFor };

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pounds = (p) => `£${(p / 100).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;

/** Saturday or Sunday in the UK (the weekend deal). */
export const isWeekendUK = (d = new Date()) => ["Sat", "Sun"].includes(new Date(d).toLocaleDateString("en-GB", { weekday: "short", timeZone: "Europe/London" }));

const BASE_CSS = `
*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2433;background:#fff}
a{color:inherit}.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.ae-bar{position:sticky;top:0;z-index:10;background:#1A1C20;color:#fff;font-size:14px}
.ae-bar .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 20px;flex-wrap:wrap}
.ae-bar b{color:#E2C26A}.ae-btn{background:#C9A13B;color:#1A1C20;font-weight:700;text-decoration:none;padding:9px 16px;border-radius:8px;white-space:nowrap}
.ae-btn:hover{background:#E2C26A}
@media(max-width:600px){.ae-bar .wrap{flex-wrap:nowrap;padding:8px 14px}.ae-bar span{font-size:12.5px;line-height:1.35}.ae-btn{padding:8px 12px;font-size:13px}}
`;

/** The order page's beacon: "order_page" after 4 seconds open in a real browser, and its [data-ev] clicks. (The demo
 * page's own beacon is render.js's.) */
function beacon(slug) {
  const url = `/d/${esc(slug)}/e`;
  return `<script>(function(){var u=${JSON.stringify(url)};function s(k){try{navigator.sendBeacon(u,JSON.stringify({kind:k}))}catch(e){}}
setTimeout(function(){if(document.visibilityState!=="hidden")s("view")},4000);
document.querySelectorAll("[data-ev]").forEach(function(a){a.addEventListener("click",function(){s(a.getAttribute("data-ev"))})});})();</script>`;
}

/**
 * The order page: Full Package vs Website Only, weekend deal on Sat–Sun, guarantees, no contract, the usual questions.
 * `extras` are the switches offer:chatbot_live and offer:review_booster_live (site.js loadSiteSettings): an extra is
 * offered only once its switch is on (truth rule). The chatbot gets its line in stage 10, so it's never listed here.
 */
export function renderOrder(lead, demo, links = {}, now = new Date(), extras = { chatbot: false, reviews: false }) {
  const name = shortName(lead.name);
  const weekend = isWeekendUK(now);
  const full = weekend ? PACKAGES.weekend : PACKAGES.full;
  const fullLink = (weekend ? links.weekend : links.full)?.url;
  const siteLink = links.website?.url;
  const ref = (u) => (u ? `${u}${u.includes("?") ? "&" : "?"}client_reference_id=${encodeURIComponent(lead.place_id)}` : "");
  const faq = [
    ["What happens after I order?", "You get a short form for your logo, photos and details. Your website is live within 7 days of us getting them, guaranteed."],
    ["Is there a contract?", "No contract and no cancellation fees. If we're not making you money, we don't want your money. Stop the monthly plan any time and you keep the website."],
    ["What does the monthly plan do?", `We get you into the top 3 on Google: your Google Business Profile, your site's pages and regular updates. ${GUARANTEE.section}`],
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
<div class="price">${weekend ? `<span class="was">${pounds(full.wasBuild)}</span>` : ""}${pounds(full.build)}</div>
<p class="per">then ${pounds(full.monthly)}/month, <b>first ${full.freeDays} days free</b></p>
<ul><li>This website, made fully yours</li><li>${esc(GUARANTEE.headline)}</li><li>Google Business Profile set up like the top 3</li><li>Monthly improvements and Google posts</li>${extras?.reviews ? "<li>Review booster</li>" : ""}<li>A plain-English monthly report</li></ul>
<a class="go${fullLink ? "" : " off"}" href="${esc(ref(fullLink))}" data-ev="order_click">Order the Full Package</a></div>
<div class="plan"><h2 style="margin:0">Website Only</h2><div class="price">${pounds(PACKAGES.website.build)}</div><p class="per">one-off, nothing monthly</p>
<ul><li>This website, made fully yours</li><li>${esc(BUILD_GUARANTEE)}</li></ul>
<a class="go${siteLink ? "" : " off"}" href="${esc(ref(siteLink))}" data-ev="order_click">Order Website Only</a></div>
</div>
<div class="promise"><b>No contract. No cancellation fees.</b> If we're not making you money, we don't want your money. If you ever stop the monthly plan, you keep the website.</div>
<h2>Questions</h2>${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}
<p class="small">Payments are taken securely by Stripe.</p>
</div>${beacon(demo.slug).replace('s("view")', 's("order_page")')}
</body></html>`;
}

/** The order page's ended page (the demo page's own is render.js's renderExpired): no dead link, a way back in. */
export function renderExpired(lead) {
  const name = shortName(lead?.name || "");
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Preview ended</title><style>${BASE_CSS}body{background:#1A1C20;color:#fff;display:grid;place-items:center;min-height:100vh;text-align:center}
.box{max-width:520px;padding:24px}h1{font-size:28px}</style></head><body><div class="box"><h1>This preview has ended</h1>
<p>The website we built${name ? ` for ${esc(name)}` : ""} is no longer on show. Reply to our email if you'd like it back: we keep it for a little while.</p>
<p style="color:#E2C26A">Aetos Websites</p></div></body></html>`;
}
