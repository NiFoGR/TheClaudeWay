// The order page (GET /d/:slug/order) and the thanks page (GET /d/:slug/thanks) as HTML strings: pure, no D1, no
// Stripe. Copy is docs/rebuild/08-order-pay.md Part A word for word; every price comes from the offer it's given
// (offer.js's offerFor / termsFor) and is printed with formatPounds, so nothing here writes a price down.
// Lead and trader strings are untrusted: h() before they go into HTML. Our own fixed copy goes through t(), which
// escapes only what could start markup, so the wording stays exactly as written (apostrophes and quotes included).
// The routes (Task 5 order.js / checkout.js, Task 10 thanks.js) load the data and send these with their status.
// Tested in control-room/tests/order-page.test.mjs.
import { h } from "./demo/text.js";
import { BUILD_GUARANTEE, BUILD_GUARANTEE_NOTE, GUARANTEE, NO_CONTRACT, formatPounds } from "./offer.js";

const SLUG = /^[a-z0-9-]{3,60}$/;

/**
 * The notices shown in a box above the plans (Part A, exact text). `{Business}` in already_client is filled in with
 * the lead's name by renderOrder. not_connected and already_client hide the order buttons.
 */
export const ORDER_NOTICES = Object.freeze({
  back: "No payment was taken. Any questions? Just reply to our email.",
  busy: "You've started a few payments in the last hour. Please wait a little and try again, or reply to our email and we'll help.",
  failed: "Sorry, the payment page didn't open. Please try again in a few minutes. If it keeps happening, reply to our email and we'll sort it.",
  not_connected: "Online ordering is switching on shortly. Reply to our email and we'll send you a payment link.",
  already_client: "{Business} is already with us. Check your email for your onboarding form, or reply to it with any questions.",
});

const HIDES_BUTTONS = new Set(["not_connected", "already_client"]);

const LINES = Object.freeze({
  site: "Your new website, finished with your own logo, photos and details",
  build: `${BUILD_GUARANTEE} ${BUILD_GUARANTEE_NOTE}`,
  monthly: "We work on it every month to get you into Google's top 3 for your main service and town",
  chatbot: "A chat assistant on your website that answers questions and passes enquiries to you, day and night",
  reviews: "Review booster: your own Google review link, a QR card and ready-made messages to ask every customer for a review",
  hosting: "Hosting included",
  report: "A plain-English report every month",
});

const STRIPE_LINE = "Payments are taken securely by Stripe. We count visits to this page so we know you've seen it.";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];

/** A UK calendar date "YYYY-MM-DD" as people read it: "Friday 18 December 2026". Throws on anything else. */
export function ukLongDate(ymd) {
  const m = typeof ymd === "string" ? ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!d || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    const shown = typeof ymd === "string" ? JSON.stringify(ymd.slice(0, 40)) : String(ymd);
    throw new Error(`ukLongDate needs a real date written YYYY-MM-DD, got ${shown}`);
  }
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Our own copy for a text node: only &, < and > escaped, so the wording reads exactly as written. */
const t = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** The business name, one line (h() is applied where it's printed). */
const nameOf = (lead) => String(lead?.name ?? "").replace(/\s+/g, " ").trim();

/** The slug, checked before it goes into a link or the script; throws when it isn't one slugFor makes. */
function checkedSlug(slug) {
  if (typeof slug !== "string" || !SLUG.test(slug)) {
    throw new Error("This demo's slug isn't valid: it must be 3 to 60 lower-case letters, digits or hyphens.");
  }
  return slug;
}

/** "A and B", "A, B and C". */
function andList(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A plain http(s) URL for an href (no spaces, quotes, angle brackets, brackets or backslashes), else "". */
function linkUrl(u) {
  const s = typeof u === "string" ? u.trim() : "";
  return s.length <= 2048 && /^https?:\/\/[^\s"'<>()\\]+$/.test(s) ? s : "";
}

const CSS = `:root{--charcoal:#1A1C20;--white:#FFFFFF;--graphite:#2E3135;--marble:#F6F4EF;--stone:#D9D4CA;--slate:#5C6066;--gold:#C9A13B;--gold-text:#7A5C14}
*{box-sizing:border-box}
body{margin:0;background:var(--marble);color:var(--slate);font:16px/1.6 Inter,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:break-word}
h1,h2,h3{color:var(--charcoal);font-weight:700;line-height:1.2}
a{color:var(--gold-text)}
.wrap{max-width:1000px;margin:0 auto;padding:0 16px}
.bar{background:var(--charcoal);color:var(--white);font-size:14px}
.bar .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding-top:10px;padding-bottom:10px}
.bar a{color:var(--gold);font-weight:700;text-decoration:none;white-space:nowrap}
main{padding:28px 0 40px}
h1{margin:0 0 8px;font-size:clamp(26px,6vw,38px)}
.lead{margin:0 0 20px;font-size:17px}
.banner{margin:0 0 18px;padding:12px 16px;border-radius:10px;background:var(--charcoal);color:var(--gold);font-weight:700;text-align:center}
.notice{margin:0 0 18px;padding:14px 16px;border:1px solid var(--stone);border-left:4px solid var(--gold);border-radius:10px;background:var(--white);color:var(--charcoal)}
.plans{display:grid;gap:16px}
@media(min-width:760px){.plans{grid-template-columns:3fr 2fr;align-items:start}}
.plan{display:flex;flex-direction:column;padding:22px;border:1px solid var(--stone);border-radius:14px;background:var(--white)}
.plan.main{border:2px solid var(--gold)}
.plan h2{margin:0;font-size:22px}
.tag{align-self:flex-start;margin:0 0 10px;padding:3px 10px;border-radius:99px;background:var(--charcoal);color:var(--gold);font-size:12px;font-weight:700;letter-spacing:.04em}
.price{margin:8px 0 0;color:var(--charcoal);font-size:36px;font-weight:800;line-height:1.1}
.price s{margin-right:6px;color:var(--slate);font-size:22px;font-weight:600}
.per{margin:4px 0 14px}
.headline{margin:0 0 12px;color:var(--charcoal);font-weight:700}
.plan ul{margin:0 0 18px;padding-left:20px}
.plan li{margin-bottom:6px}
.plan form{margin:0}
.plan button{display:block;width:100%;padding:15px 16px;border:0;border-radius:10px;background:var(--charcoal);color:var(--white);font:inherit;font-weight:700;cursor:pointer}
.plan.main button{background:var(--gold);color:var(--charcoal)}
.plan button:focus-visible{outline:3px solid var(--charcoal);outline-offset:2px}
.after{margin:10px 0 0;font-size:14px;text-align:center}
.guarantee{margin:28px 0 0;padding:22px;border-radius:14px;background:var(--charcoal);color:var(--white)}
.guarantee h2{margin:0 0 8px;color:var(--gold);font-size:22px}
.guarantee p{margin:0 0 8px}
.small{font-size:13px;color:var(--stone)}
.promise{margin:16px 0 0;padding:18px 22px;border:1px solid var(--stone);border-radius:14px;background:var(--white);color:var(--charcoal)}
.promise p{margin:0}
.promise p+p{margin-top:6px;color:var(--slate)}
.faq{margin:28px 0 0}
.faq h2{font-size:22px}
details{margin:0 0 10px;padding:14px 16px;border:1px solid var(--stone);border-radius:10px;background:var(--white)}
summary{color:var(--charcoal);font-weight:700;cursor:pointer}
details p{margin:10px 0 0}
footer{padding:20px 0 32px;border-top:1px solid var(--stone);font-size:13px}
footer p{margin:0 0 4px}
.thanks{max-width:620px}
.go{display:block;margin:20px 0;padding:15px 16px;border-radius:10px;background:var(--gold);color:var(--charcoal);font-weight:700;text-align:center;text-decoration:none}
.go:focus-visible{outline:3px solid var(--charcoal);outline-offset:2px}`;

function page({ title, bar, body, footer = "", script = "" }) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
${[bar, `<main><div class="wrap">\n${body}\n</div></main>`, footer, script].filter(Boolean).join("\n")}
</body>
</html>
`;
}

function topBar(name, slug) {
  const who = name ? `Aetos Websites · for ${h(name)}` : "Aetos Websites";
  const back = slug ? `<a href="/d/${slug}">${t("← Back to your site")}</a>` : "";
  return `<div class="bar"><div class="wrap"><span>${who}</span>${back}</div></div>`;
}

const li = (s) => `<li>${t(s)}</li>`;

function orderButton({ slug, pkg, seen, label }) {
  return `<form method="post" action="/d/${slug}/checkout"><input type="hidden" name="package" value="${pkg}"><input type="hidden" name="seen" value="${seen}"><button type="submit">${t(label)}</button></form>`;
}

// The order_page beacon: once, after the page has been open 4 seconds in a real, visible tab (the demo views' rule).
const beacon = (slug) => `<script>(function(){if(navigator.webdriver)return;setTimeout(function(){if(document.visibilityState!=="visible")return;try{navigator.sendBeacon("/d/${slug}/e", '{"kind":"order_page"}')}catch(e){}},4000);})();</script>`;

/**
 * The order page. `offer` is offerFor(now) ({weekend, full, website, banner}); `extras` are the live switches
 * (offer:chatbot_live / offer:review_booster_live, true only when exactly true); `notice` a key of ORDER_NOTICES or
 * null; `trader` stage 0's traderLine (printed in the footer when not ""). Throws when the slug isn't valid.
 */
export function renderOrder({ lead, slug, offer, extras = {}, notice = null, trader = "" } = {}) {
  const s = checkedSlug(slug);
  if (!offer?.full || !offer?.website) throw new TypeError("renderOrder needs today's offer: build it with offerFor (offer.js).");
  const name = nameOf(lead);
  const full = offer.full;
  const site = offer.website;
  const weekend = offer.weekend === true;
  const seen = weekend ? "weekend" : "weekday";
  const chatbot = extras?.chatbot === true;
  const reviews = extras?.reviews === true;
  const key = typeof notice === "string" && Object.hasOwn(ORDER_NOTICES, notice) ? notice : null;
  const buttons = !HIDES_BUTTONS.has(key);
  const monthly = formatPounds(full.monthly);
  const firstPaidDay = full.freeDays + 1;

  const noticeBox = key
    ? `<p class="notice" role="status">${ORDER_NOTICES[key].split("{Business}").map(t).join(h(name || "Your business"))}</p>`
    : "";
  const banner = weekend && offer.banner ? `<p class="banner">${t(offer.banner)}</p>` : "";

  const price = weekend && Number.isInteger(full.wasBuild)
    ? `<s>${formatPounds(full.wasBuild)}</s> ${formatPounds(full.build)}`
    : formatPounds(full.build);
  const fullLines = [LINES.site, LINES.build, LINES.monthly, ...(chatbot ? [LINES.chatbot] : []),
    ...(reviews ? [LINES.reviews] : []), LINES.hosting, LINES.report];
  const fullCard = [
    '<section class="plan main">',
    `<p class="tag">${weekend ? "Weekend price" : "Recommended"}</p>`,
    "<h2>Full Package</h2>",
    `<p class="price">${price}</p>`,
    `<p class="per">${t(`then ${monthly}/month. First ${full.freeDays} days free.`)}</p>`,
    `<p class="headline"><b>${t(GUARANTEE.headline)}</b></p>`,
    `<ul>${fullLines.map(li).join("")}</ul>`,
    buttons ? orderButton({ slug: s, pkg: "full", seen, label: "Order the Full Package" }) : "",
    buttons ? `<p class="after">${t(`Nothing more to pay until day ${firstPaidDay}. Cancel any time.`)}</p>` : "",
    "</section>",
  ];
  const siteCard = [
    '<section class="plan">',
    "<h2>Website Only</h2>",
    `<p class="price">${formatPounds(site.build)}</p>`,
    `<p class="per">${t("one-off. Nothing monthly.")}</p>`,
    `<ul>${[LINES.site, LINES.build, LINES.hosting].map(li).join("")}</ul>`,
    buttons ? orderButton({ slug: s, pkg: "website", seen, label: "Order Website Only" }) : "",
    "</section>",
  ];

  const extrasOff = andList(["The monthly Google work", "the report", ...(chatbot ? ["the chat assistant"] : []),
    ...(reviews ? ["the review booster"] : [])]);
  const faq = [
    ["What happens after I pay?", "We email you a short form for your logo, photos, services and the areas you cover. Your 7 days start when it's complete, and your website is live within 7 days of that. Guaranteed."],
    ["Can I cancel?", "Yes, any time. Reply to any of our emails and we'll stop your monthly plan that day. No contract and no cancellation fees."],
    ["Do I keep the website if I stop?", `Yes. Your website stays live and it's yours. ${extrasOff} switch off.`],
    ["What happens when the free days end?", `On day ${firstPaidDay} we take ${monthly} from the card you paid with, then the same each month. Don't want to carry on? Tell us before then and you won't be charged.`],
    ["How do you measure the top 3?", `On Google's results for your main service and town (for example "roofer Leeds"), searched from your area. The map results at the top count. ${GUARANTEE.section}`],
    ["Is paying online safe?", "Yes. Payments are taken by Stripe, which handles card payments for millions of businesses. We never see your card details."],
  ];

  const body = [
    `<h1>${t("Get your new website live in 7 days")}</h1>`,
    `<p class="lead">${t("Pick a plan and pay securely by card. Straight after, we email you a short form. Your website goes live within 7 days of it being complete.")}</p>`,
    banner,
    noticeBox,
    `<div class="plans">\n${fullCard.filter(Boolean).join("\n")}\n${siteCard.filter(Boolean).join("\n")}\n</div>`,
    `<section class="guarantee"><h2>${t(GUARANTEE.headline)}</h2><p>${t(GUARANTEE.section)}</p><p class="small">${t("Full Package only. Measured on Google's results for your main service and town, searched from your area. The map results at the top count.")}</p></section>`,
    `<section class="promise"><p><b>${t(NO_CONTRACT)}</b></p><p>${t("If you stop the monthly plan, you keep your website.")}</p></section>`,
    `<section class="faq"><h2>Questions</h2>\n${faq.map(([q, a]) => `<details><summary>${t(q)}</summary><p>${t(a)}</p></details>`).join("\n")}\n</section>`,
  ].filter(Boolean).join("\n");

  const traderLine = typeof trader === "string" ? trader.trim() : "";
  const footer = `<footer><div class="wrap"><p>${t(STRIPE_LINE)}</p>${traderLine ? `<p>${h(traderLine)}</p>` : ""}</div></footer>`;

  return page({
    title: name ? `Order your website · ${h(name)}` : "Order your website",
    bar: topBar(name, s),
    body,
    footer,
    script: beacon(s),
  });
}

/**
 * The thanks page after Stripe Checkout. outcome "done": paid and fulfilled (`onboardUrl` the onboarding form,
 * `terms` the package it was charged at (termsFor), `amountPaid` pence, `firstChargeOn` "YYYY-MM-DD" for the Full
 * Package); "pending": Stripe couldn't be reached; "not_found": wrong, unpaid or another demo's session (needs
 * `slug` for its link back to the order page; the other two don't). Throws when a slug is given and isn't valid.
 */
export function renderThanks({ lead, slug, outcome, onboardUrl, terms, amountPaid, firstChargeOn } = {}) {
  // The slug is only printed on the not_found page (its order-page link); a slug that's given is always checked.
  const s = slug === undefined && outcome !== "not_found" ? "" : checkedSlug(slug);
  const name = nameOf(lead);
  const title = (words) => (name ? `${words} · ${h(name)}` : words);
  let heading;
  let lines;
  if (outcome === "done") {
    heading = "Thank you, you're all set";
    const paid = Number.isInteger(amountPaid) && amountPaid > 0 ? `Your payment of ${formatPounds(amountPaid)} has gone through.` : "Your payment has gone through.";
    const url = linkUrl(onboardUrl);
    lines = [
      `<p>${t(paid)}</p>`,
      url ? `<a class="go" href="${h(url)}">${t("Fill in your onboarding form →")}</a>` : "",
      `<p>${t("Your 7 days start when the form is complete. Your website will be live within 7 days of that. GUARANTEED.")}</p>`,
    ];
    if (Number.isInteger(terms?.monthly) && terms.monthly > 0 && Number.isInteger(terms?.freeDays)) {
      let when = "";
      try {
        when = ` The first ${formatPounds(terms.monthly)} is taken on ${ukLongDate(firstChargeOn)}.`;
      } catch {
        when = ""; // no date to show: the rest of the line is still true
      }
      lines.push(`<p>${t(`Your first ${terms.freeDays} days of the monthly plan are free.${when} Cancel any time before then by replying to our email.`)}</p>`);
    }
    lines.push(`<p>${t("We're also emailing you this link. Questions? Reply to any of our emails.")}</p>`);
  } else if (outcome === "pending") {
    heading = "Thank you";
    lines = [`<p>${t("Your payment is being confirmed. Your onboarding form will arrive by email in the next few minutes.")}</p>`];
  } else {
    heading = "We couldn't find that payment";
    lines = [`<p>${t("If you've just paid, your onboarding form will arrive by email in the next few minutes. If you haven't paid yet, you can ")}<a href="/d/${s}/order">${t("go back to your order page")}</a>.</p>`];
  }
  const body = `<div class="thanks">\n<h1>${t(heading)}</h1>\n${lines.filter(Boolean).join("\n")}\n</div>`;
  return page({ title: title(t(heading)), bar: topBar(name, ""), body });
}
