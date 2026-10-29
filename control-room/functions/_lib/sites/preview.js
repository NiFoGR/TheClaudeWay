// Nik's preview of a client's site and the temporary public link (stage 10, docs/rebuild/09-build.md Part A §7,
// Part B Task 23). Both draw the site with the same renderer as its own host, in live mode, under a path prefix:
//
// - /c/<slug>/… ("preview", functions/c/[slug]/[[path]].js): behind the login (the middleware's default), any status
//   with content, noindex, the slim Charcoal bar "Preview of {name}'s site · {status label} · Back to the Control
//   Room", the contact form and chat replaced by "Works once the site is live." (siteData's previewBar). Not cached.
// - /w/<slug>/… ("temporary", functions/w/[slug]/[[path]].js): public on our hosts (PUBLIC_PREFIXES), only while the
//   site is live, noindex, canonical to the client's real host, no bar. Its contact form works: it posts to
//   /w/<slug>/s/contact (contact.js with base "/w/<slug>"), and the thanks page is /w/<slug>/contact?sent=1. No chat.
//
// The slug is the only key to either link (db.js makes it unguessable). An unknown slug, a site with no content, or a
// /w/ link for a site that isn't live is a plain noindex 404 that names nobody. A trailing slash (not the home page)
// is a 301 without it. Every response carries nosniff, the referrer policy, `x-robots-tag: noindex`, and on HTML a
// CSP (the client-site one on /w/, a no-script one on /c/: PREVIEW_CSP); none sets a cookie.
//
// D1: one read for the site (the row with the client's name and package, the onboarding form and the lead joined),
// plus listFiles (sizes the content lacks) when a page is drawn. The contact POST does its own (contact.js).
// Tested in control-room/tests/sites-preview.test.mjs.
import { statusLabel } from "../../api/sites/[client_id].js";
import { renderSite } from "../demo/render.js";
import { h } from "../demo/text.js";
import { db, parseJson } from "../util.js";
import { handleContact } from "./contact.js";
import { listFiles } from "./files.js";
import { renderMissingPage, renderPrivacy } from "./pages.js";
import { CLIENT_CSP, sentData } from "./serve.js";
import { siteData } from "./sitedata.js";

export const NO_CONTENT = "Claude hasn't written this site yet.";
const NO_SITE = "There's no site at this address.";
const NOT_LIVE = "This website isn't set up yet.";
const TRY_AGAIN = "Sorry, this page can't be shown just now. Please try again in a minute.";
const SLUG_RE = /^[a-z0-9-]{3,60}$/; // db.js's slug rule
const VIEWPORT = '<meta name="viewport" content="width=device-width,initial-scale=1">';
const TEMP_CACHE = "public, max-age=300";

const SITE_SQL = `SELECT cs.*, c.name AS name, c.package AS package, c.cancelled_on AS cancelled_on,
    o.status AS onboarding_status, o.form AS form,
    l.place_id AS lead_place_id, l.rating AS lead_rating, l.review_count AS lead_review_count,
    l.maps_url AS lead_maps_url, l.trade AS lead_trade
  FROM client_sites cs
  LEFT JOIN clients c ON c.id = cs.client_id
  LEFT JOIN onboarding o ON o.client_id = cs.client_id
  LEFT JOIN leads l ON l.place_id = cs.place_id
  WHERE cs.slug = ?`;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const objectOf = (v) => {
  const out = parseJson(v, null);
  return isObj(out) ? out : null;
};

/** The site for a /c/ or /w/ slug, its JSON parsed and the lead alongside; null when there is none. */
async function siteForSlug(DB, slug) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return null;
  const row = await DB.prepare(SITE_SQL).bind(slug).first();
  if (!row) return null;
  const lead = row.lead_place_id
    ? { rating: row.lead_rating, review_count: row.lead_review_count, maps_url: row.lead_maps_url, trade: row.lead_trade }
    : null;
  return {
    ...row,
    content: objectOf(row.content),
    domain: objectOf(row.domain) ?? {},
    host_check: objectOf(row.host_check),
    features: objectOf(row.features) ?? {},
    last_errors: null,
    form: objectOf(row.form),
    lead,
  };
}

// Nik's preview is drawn on the Control Room's own origin (where his login cookie lives) from text Claude wrote, and
// has no form and no chat, so it needs no script at all: script-src 'none' (the JSON-LD block is data, never run) and
// it can't be framed. The temporary link keeps the client-site policy, since its contact form's fill timer is inline.
export const PREVIEW_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'none'; "
  + "frame-src https://maps.google.com https://www.google.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// The headers every preview and temporary-link response carries (the handler's own are kept), no cookie, no body
// for HEAD.
function finishWith(request, res, csp = CLIENT_CSP) {
  const out = new Response(request.method === "HEAD" ? null : res.body, res);
  out.headers.delete("set-cookie");
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  out.headers.set("x-robots-tag", "noindex");
  if ((out.headers.get("content-type") ?? "").startsWith("text/html") && !out.headers.has("content-security-policy")) {
    out.headers.set("content-security-policy", csp);
  }
  return out;
}

const htmlResponse = (html, status, cache) =>
  new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache } });

// A plain noindex page with one sentence (the 404s and the temporary link's 500): names nobody.
function plainPage(sentence, { back = false } = {}) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
${VIEWPORT}
<meta name="robots" content="noindex">
<title>${sentence === TRY_AGAIN ? "Please try again" : "Not here"}</title>
<style>body{display:grid;min-height:100vh;margin:0;padding:24px 16px;place-items:center;background:#fff;color:#1d2125;font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;text-align:center}h1{margin:0;font-size:24px;line-height:1.3}</style>
</head>
<body>
<main>
<h1>${sentence}</h1>
${back ? '<p><a href="/#/sites">Back to the Control Room</a></p>\n' : ""}</main>
</body>
</html>
`;
}

// The path split into the slug and the site's own page path ("/" for the home page).
function splitPath(pathname, prefix) {
  const m = new RegExp(`^/${prefix}/([^/]+)(/.*)?$`).exec(pathname);
  return m ? { slug: m[1], page: m[2] || "/" } : null;
}

/**
 * The response for /c/<slug>/… (kind "preview") or /w/<slug>/… (kind "temporary"). `context` is the Pages context
 * ({request, env, waitUntil}); the middleware has already checked the login for /c/.
 */
export async function servePreview(context, kind, now = new Date()) {
  // The preview's errors reach the middleware's catch, which shows Nik the reason. The temporary link is public, so a
  // visitor gets a plain "try again" page instead (the reason goes to the log only).
  if (kind === "preview") return draw(context, kind, now);
  try {
    return await draw(context, kind, now);
  } catch (err) {
    const path = new URL(context.request.url).pathname.slice(0, 200);
    console.error(`${path} couldn't be served: ${String(err?.message ?? err).split("\n")[0].slice(0, 300)}`);
    return finishWith(context.request, htmlResponse(plainPage(TRY_AGAIN), 500, "no-store"));
  }
}

async function draw(context, kind, now) {
  const { request, env } = context;
  const waitUntil = typeof context.waitUntil === "function" ? (p) => context.waitUntil(p) : undefined;
  const preview = kind === "preview";
  const prefix = preview ? "c" : "w";
  const url = new URL(request.url);
  const parts = splitPath(url.pathname, prefix);
  const cache = preview ? "no-store" : TEMP_CACHE;
  const finish = (req, res) => finishWith(req, res, preview ? PREVIEW_CSP : CLIENT_CSP);
  const gone = (sentence) => finish(request, htmlResponse(plainPage(sentence, { back: preview }), 404, "no-store"));
  if (!parts) return gone(preview ? NO_SITE : NOT_LIVE);

  const DB = await db(env);
  const site = await siteForSlug(DB, parts.slug);
  if (!site) return gone(preview ? NO_SITE : NOT_LIVE);
  if (!preview && site.status !== "live") return gone(NOT_LIVE);
  if (!site.content) return gone(preview ? NO_CONTENT : NOT_LIVE);

  const base = `/${prefix}/${site.slug}`;
  const page = parts.page;
  const method = request.method;
  const read = method === "GET" || method === "HEAD";

  // The temporary link's contact form (the preview has none).
  if (!preview && page === "/s/contact") {
    return finish(request, await handleContact(request, env, site, now, { waitUntil, base }));
  }
  if (!read) {
    return finish(request, new Response("This address can't take that kind of request.", {
      status: 405, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", allow: "GET, HEAD" },
    }));
  }
  if (page.length > 1 && page.endsWith("/")) {
    const to = `${base}/${page.replace(/^\/+/, "").replace(/\/+$/, "")}`;
    return finish(request, new Response(null, { status: 301, headers: { location: `${to}${url.search}`, "cache-control": "no-store" } }));
  }

  const content = site.content;
  const name = content.business?.name || site.name || "this business";
  const previewBar = preview ? `Preview of ${name}'s site · ${statusLabel(site)}` : "";
  const data = siteData(content, {
    lead: site.lead,
    host: site.host ?? "",
    base,
    reviewUrl: site.review_url ?? "",
    noindex: true,
    previewBar,
    files: await listFiles(DB, site.client_id),
    form: site.form,
  });
  // h() writes the apostrophe in "Smith Roofing's" as &#39;; in element text it needs no escaping, so the bar reads as
  // written in the HTML too.
  // A function replacement, so a "$'" or "$&" in the business name is never read as a replacement pattern.
  const barFrom = `<p>${h(data.live.preview_bar)} · `;
  const barTo = `<p>${h(data.live.preview_bar).replaceAll("&#39;", "'")} · `;
  const withBar = (html) => (previewBar ? html.replace(barFrom, () => barTo) : html);

  const pagePaths = new Set(data.live.pages.map((p) => p.path));
  if (page === "/privacy") return finish(request, htmlResponse(withBar(renderPrivacy(content, data, { now })), 200, cache));
  if (pagePaths.has(page)) {
    const sent = !preview && page === "/contact" && url.searchParams.get("sent") === "1";
    const html = renderSite(sent ? sentData(data) : data, { mode: "live", page, now });
    return finish(request, htmlResponse(withBar(html), 200, sent ? "no-store" : cache));
  }
  return finish(request, htmlResponse(withBar(renderMissingPage(data, { now })), 404, "no-store"));
}
