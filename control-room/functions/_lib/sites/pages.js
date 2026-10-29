// A client site's fixed pages (stage 10, docs/rebuild/09-build.md Part A §7–8, Part B Task 5): /sitemap.xml,
// /robots.txt, /privacy, the site's own 404 page and the "isn't set up yet" page for a host whose site isn't live.
//
// /privacy and the 404 page are drawn by stage 4's engine in live mode (renderSite with client-site data from
// sitedata.js), so they carry the site's header, nav, NAP footer and call bar: each is one extra page put in place of
// the site's own pages. The privacy copy is fixed (section 8) with only the business's details filled in, and it says
// only what is true of this page's site: the chat lines only when chat is on, the Google Maps line only when the site
// shows a map. Everything from the content goes through h() when printed (the renderer does it). Stage 4's
// renderNotFound() stays the 404 for demos. Pure. Tested in control-room/tests/sites-pages.test.mjs.
import { renderSite } from "../demo/render.js";
import { cleanText, h } from "../demo/text.js";
import { ukDate } from "../ukTime.js";
import { normaliseHost } from "./hosts.js";

// A host the sitemap and robots.txt may name (sitedata.js's rule): lower-case labels with at least one dot.
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// A page path the validator allows: "/", "/about", "/services/roof-repairs".
const PAGE_PATH = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?)?$/;
const PRIVACY_PATH = "/privacy";
const VIEWPORT = '<meta name="viewport" content="width=device-width,initial-scale=1">';

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => cleanText(typeof v === "string" ? v : "");
// Their text put into the fixed copy, which is drawn as body text (sites/body.js): "](" is broken up so a name or legal
// line can never turn into a link.
const plain = (v) => text(v).replace(/\]\s*\(/g, "] (");
const MISSING_H1 = "Sorry, that page isn't here.";
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function checkContent(content) {
  if (!isObj(content) || !isObj(content.business) || !Array.isArray(content.pages)) {
    throw new TypeError("This needs a site's SiteContent (client_sites.content, parsed).");
  }
}

function checkData(data) {
  if (!isObj(data) || !isObj(data.live) || !Array.isArray(data.live.pages) || !isObj(data.business)) {
    throw new TypeError("This needs the site's data from siteData (sites/sitedata.js).");
  }
}

// The canonical host, normalised; throws in plain English when there isn't a real one.
function hostOf(host, what) {
  const h = normaliseHost(typeof host === "string" ? host : "");
  if (!HOST.test(h)) {
    throw new Error(`${what} needs the site's host (like www.smithroofing.co.uk): set it on the client's Site page first.`);
  }
  return h;
}

// content_at as a Date: an ISO time (what sites/db.js stores), a Date or epoch ms. SQLite's own "YYYY-MM-DD HH:MM:SS"
// has no zone and is UTC, so it is read as UTC (new Date() would read it as local time); null for anything else.
function timeOf(v) {
  if (v instanceof Date) return v;
  if (typeof v === "number") return Number.isFinite(v) ? new Date(v) : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  return new Date(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s) ? `${s.replace(" ", "T")}Z` : s);
}

/**
 * /sitemap.xml: every page in the content (never /privacy), `<loc>https://{host}{path}</loc>` and, when `contentAt`
 * (client_sites.content_at) is a real time, `<lastmod>` = its UK date. Paths that aren't page paths, and repeats, are
 * left out. Throws when there's no real host.
 */
export function renderSitemap(content, host, contentAt) {
  checkContent(content);
  const origin = `https://${hostOf(host, "The sitemap")}`;
  const at = timeOf(contentAt);
  const lastmod = at && Number.isFinite(at.getTime()) ? `<lastmod>${ukDate(at)}</lastmod>` : "";
  const paths = [];
  for (const p of content.pages) {
    const path = isObj(p) ? p.path : null;
    if (typeof path === "string" && PAGE_PATH.test(path) && path !== PRIVACY_PATH && !paths.includes(path)) paths.push(path);
  }
  const urls = paths.map((path) => `<url><loc>${xml(`${origin}${path}`)}</loc>${lastmod}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `${u}\n`).join("")}</urlset>
`;
}

/** /robots.txt: everything but /s/ open (its photos and logo at /s/f/ stay open: the longer Allow wins), with the sitemap;
 *  a test site (`isTest`) shuts everything out. */
export function renderRobots(host, isTest) {
  if (isTest) return "User-agent: *\nDisallow: /\n";
  return `User-agent: *\nAllow: /\nAllow: /s/f/\nDisallow: /s/\nSitemap: https://${hostOf(host, "robots.txt")}/sitemap.xml\n`;
}

// The site's data with `page` as its only page (so renderSite draws it with the site's header, nav and footer). The
// Google rating isn't repeated in these pages' headers.
function withPage(data, page, { noindex }) {
  return {
    ...data,
    rating: null,
    review_count: null,
    live: { ...data.live, pages: [page], page, ld: page.ld, canonical_url: page.canonical_url, noindex },
  };
}

// One extra page in sitedata.js's page shape.
const extraPage = (fields) => ({ name: "", meta: "", intro: "", sections: [], faq: [], photo: null, canonical_url: "", ld: [], ...fields });

/**
 * /privacy (section 8), noindex,follow: who runs the site (legal line, the address or only the town, email), what
 * the contact form (and the chat, when on) collects and why, that chats aren't kept unless a visitor leaves their
 * details, that enquiries are kept for 12 months, no cookies and no tracking, "Website by Aetos Websites, which
 * processes enquiries for {name}." and how to ask for their data to be deleted. `data` is the site's siteData(...)
 * (the one its other pages are drawn with); `now` only sets the footer's © year.
 */
export function renderPrivacy(content, data, { now = new Date() } = {}) {
  checkContent(content);
  checkData(data);
  const b = content.business;
  const addr = isObj(b.address) ? b.address : {};
  const name = plain(b.name) || plain(data.business.name);
  const town = plain(addr.town);
  const address = b.show_address === true
    ? [plain(addr.street), [town, plain(addr.postcode)].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    : town;
  const email = plain(b.email);
  const phone = plain(b.phone);
  const runBy = [plain(b.legal_line) || name, address].filter(Boolean).join(", ");
  const chat = data.live.chat === true;
  const map = Boolean(text(data.live.map_query));
  const ask = email ? `email ${email}` : phone ? `call ${phone}` : "use the details on the contact page";

  const sections = [
    { h2: "Who runs this website", body: `This website is run by ${runBy}.${email ? ` You can email ${email}.` : ""}` },
    {
      h2: "What we collect and why",
      body: [
        `If you use the contact form${chat ? " or the chat" : ""}, we get what you give us: your name, phone number, email and message. We use it only to reply to you.`,
        chat ? "Chats are not kept unless you leave your details." : "",
        "Enquiries are kept for 12 months.",
      ].filter(Boolean).join(" "),
    },
    {
      h2: "Cookies and tracking",
      body: [
        "This website sets no cookies and uses no tracking.",
        // True of widget.js: its random session id lives in sessionStorage, which the browser clears with the tab.
        chat ? "The chat keeps a random code in your browser until you close the tab, so it can follow your conversation." : "",
        map ? "The map on this website is from Google Maps, which works under Google's own privacy policy." : "",
      ].filter(Boolean).join(" "),
    },
    { h2: "Who handles your enquiry", body: `Website by Aetos Websites, which processes enquiries for ${name}.` },
    { h2: "Your data", body: `To ask for your data to be deleted, ${ask}.` },
  ];
  const home = data.live.pages.find((p) => isObj(p) && p.path === "/");
  const canonical = typeof home?.canonical_url === "string" && home.canonical_url.endsWith("/")
    ? `${home.canonical_url.slice(0, -1)}${PRIVACY_PATH}` : "";
  const business = Array.isArray(home?.ld) ? home.ld.filter((n) => isObj(n) && typeof n["@id"] === "string" && n["@id"].endsWith("/#business")) : [];
  const page = extraPage({
    key: "privacy",
    path: PRIVACY_PATH,
    title: `Privacy · ${name}`,
    h1: "Privacy",
    intro: `How ${name} uses what you send through this website.`,
    sections,
    canonical_url: canonical,
    ld: business,
  });
  const html = renderSite(withPage(data, page, { noindex: false }), { mode: "live", page: PRIVACY_PATH, now });
  if (!html.includes(VIEWPORT)) throw new Error("The privacy page couldn't be drawn: the page shell has changed.");
  return html.replace(VIEWPORT, `${VIEWPORT}\n<meta name="robots" content="noindex,follow">`);
}

/**
 * The site's own 404 page (send it with status 404): its header and nav, "Sorry, that page isn't here." and a link to
 * the home page (under the site's base). noindex, no canonical, no JSON-LD. `data` is the site's siteData(...).
 */
export function renderMissingPage(data, { now = new Date() } = {}) {
  checkData(data);
  const page = extraPage({
    key: "missing",
    path: "/404",
    title: `Page not found · ${text(data.business.name)}`,
    h1: MISSING_H1,
    sections: [{ h2: "", body: "[Go to the home page](/)" }],
  });
  const html = renderSite(withPage(data, page, { noindex: true }), { mode: "live", page: page.path, now });
  // h() writes the apostrophe as &#39;; in element text it needs no escaping, so the sentence reads as written in the
  // HTML too (the host routing test looks for it there).
  return html.replace(`>${h(MISSING_H1)}</h1>`, `>${MISSING_H1}</h1>`);
}

/** The page a client host shows while its site isn't live (send it with status 404). Plain, noindex, names nobody. */
export function renderNotSetUp() {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
${VIEWPORT}
<meta name="robots" content="noindex">
<title>Not set up yet</title>
<style>body{display:grid;min-height:100vh;margin:0;padding:24px 16px;place-items:center;background:#fff;color:#1d2125;font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;text-align:center}h1{margin:0;font-size:24px;line-height:1.3}</style>
</head>
<body>
<main>
<h1>This website isn't set up yet.</h1>
</main>
</body>
</html>
`;
}
