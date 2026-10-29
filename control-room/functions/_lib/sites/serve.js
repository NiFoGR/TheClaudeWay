// Client websites served by hostname from the Control Room's own Pages project (stage 10, docs/rebuild/09-build.md
// Part A §7–12, Part B Task 22). _middleware.js calls serveClientHost first for every host that isn't ours
// (isOurHost: aetoswebsites.com, www., localhost, 127.0.0.1, any *.pages.dev; and no other host under aetoswebsites.com
// but the test client's site-test.aetoswebsites.com is looked up either). It looks the host up in client_sites
// (the host or its www twin); no row → null, and the request carries on into stage 0's routing unchanged (that is how
// the Control Room keeps working on control.aetoswebsites.com, with no list of hosts and no variable).
//
// Section 7's routing table, top to bottom:
//   status not live → 404 "This website isn't set up yet." · http: → 301 https · the www twin → 301 to the stored host
//   · a trailing slash → 301 without it · a page → 200 (public, max-age=300) · an old path in `redirects` → 301 ·
//   /sitemap.xml, /robots.txt, /privacy → 200 · /s/contact, /s/chat, /s/chat.js, /s/review-card, /s/f/<id> →
//   sections 9–12 · anything else → the site's own 404 page.
//
// Every response carries nosniff and the referrer policy, HTML also CLIENT_CSP; none sets a cookie (any set-cookie is
// dropped) and none loads a third-party script. The first GET served on the canonical host over https stamps seen_at
// (markSeen, in waitUntil), which the tick needs before it puts the site live.
//
// D1 budget per request: one read for the site (the row with the client, onboarding form, lead and research owner
// joined), plus one settings read (SELECT key, value FROM settings WHERE key IN (…)) only where the chat switch
// matters: pages, the 404 page, /privacy and /s/chat.js. The contact form and the chat endpoint do their own reads
// (contact.js, chatHandler.js). /api/* never does the lookup: client sites have no /api/ paths, and the tick
// (/api/tick, on whatever host the relay calls) keeps its whole 50-query budget. Tested in
// control-room/tests/sites-serve.test.mjs.
import { renderSite } from "../demo/render.js";
import { parseJson } from "../util.js";
import { renderReviewCard } from "./card.js";
import { chatEnabled } from "./chat.js";
import { handleChat } from "./chatHandler.js";
import { handleContact } from "./contact.js";
import { markSeen } from "./db.js";
import { serveFile } from "./files.js";
import { onboardFirst } from "./form.js";
import { TEST_SITE_HOST, isOurHost, normaliseHost, underOurDomain, wwwTwin } from "./hosts.js";
import { renderMissingPage, renderNotSetUp, renderPrivacy, renderRobots, renderSitemap } from "./pages.js";
import { siteData } from "./sitedata.js";
import { chatWidgetJs } from "./widget.js";

/** The Content-Security-Policy on every HTML page of a client host (section 7, exact). */
export const CLIENT_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' "
  + "'unsafe-inline'; frame-src https://maps.google.com https://www.google.com; form-action 'self'; base-uri 'none'";

const PAGE_CACHE = "public, max-age=300";
// Redirects are permanent, but a browser keeps a 301 for ever unless told otherwise: an hour lets a fix get through.
const REDIRECT_CACHE = "public, max-age=3600";
const SETTING_KEYS = ["offer:chatbot_live", "secret:cf_ai:account_id", "secret:cf_ai:token"];
const FILE_PATH = /^\/s\/f\/([^/]*)$/;
const SENT_H1 = "Thanks for your message";

// The site row and everything its pages need, in one read: the client (name, package, cancelled), the onboarding
// clock and form, the lead (Google rating, maps link, trade) and the owner's first name from Claude's research.
const SITE_SQL = `SELECT cs.*, c.name AS name, c.package AS package, c.cancelled_on AS cancelled_on,
    o.submitted_at AS submitted_at, o.due_live_at AS due_live_at, o.status AS onboarding_status, o.form AS form,
    l.place_id AS lead_place_id, l.rating AS lead_rating, l.review_count AS lead_review_count,
    l.maps_url AS lead_maps_url, l.trade AS lead_trade, r.owner AS research_owner
  FROM client_sites cs
  LEFT JOIN clients c ON c.id = cs.client_id
  LEFT JOIN onboarding o ON o.client_id = cs.client_id
  LEFT JOIN leads l ON l.place_id = cs.place_id
  LEFT JOIN research r ON r.place_id = cs.place_id
  WHERE cs.host IN (?, ?) ORDER BY cs.host = ? DESC LIMIT 1`;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const objectOf = (v) => {
  const out = parseJson(v, null);
  return isObj(out) ? out : null;
};
const why = (err) => String(err?.message ?? err).split("\n")[0].slice(0, 300);

/** The client_sites row for a request host, with its JSON parsed (db.js's shape plus form, lead and owner); or null. */
async function siteFor(DB, host) {
  const row = await DB.prepare(SITE_SQL).bind(host, wwwTwin(host), host).first();
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
    owner_first: onboardFirst({ owner: objectOf(row.research_owner) }),
  };
}

// The chat switch's inputs, in one read. Secrets become true/false straight away: their values never go further.
async function chatSettings(DB) {
  const { results } = await DB.prepare(`SELECT key, value FROM settings WHERE key IN (${SETTING_KEYS.map(() => "?").join(", ")})`)
    .bind(...SETTING_KEYS)
    .all();
  const got = Object.fromEntries((results ?? []).map((r) => [r.key, r.value]));
  return {
    settings: { "offer:chatbot_live": got["offer:chatbot_live"] ?? null },
    secrets: { "cf_ai:account_id": Boolean(got["secret:cf_ai:account_id"]), "cf_ai:token": Boolean(got["secret:cf_ai:token"]) },
  };
}

// Section 7's headers on any response (the handlers' own are kept), no cookie, and no body for HEAD.
function finish(request, res, { html = false } = {}) {
  const out = new Response(request.method === "HEAD" ? null : res.body, res);
  out.headers.delete("set-cookie");
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  const type = out.headers.get("content-type") ?? "";
  if ((html || type.startsWith("text/html")) && !out.headers.has("content-security-policy")) {
    out.headers.set("content-security-policy", CLIENT_CSP);
  }
  return out;
}

const htmlResponse = (html, status = 200, cache = PAGE_CACHE) =>
  new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache } });

const textResponse = (body, type, status = 200, cache = PAGE_CACHE, extra = {}) =>
  new Response(body, { status, headers: { "content-type": type, "cache-control": cache, ...extra } });

const moved = (location) => new Response(null, { status: 301, headers: { location, "cache-control": REDIRECT_CACHE } });

const notAllowed = (allow) => textResponse("This address can't take that kind of request.", "text/plain; charset=utf-8", 405, "no-store", { allow });

// The old-site redirect for a path: exact first, then ignoring case (old sites often did).
function redirectFor(content, path) {
  const list = Array.isArray(content?.redirects) ? content.redirects.filter((r) => isObj(r) && typeof r.from === "string" && typeof r.to === "string") : [];
  const hit = list.find((r) => r.from === path) ?? list.find((r) => r.from.toLowerCase() === path.toLowerCase());
  return hit && /^\/(?!\/)/.test(hit.to) ? hit.to : null;
}

// /contact?sent=1: the contact page with the thanks line in place of the form (the visitor's name isn't carried
// over: no cookie, no name in the address), noindex. Also the /w/ temporary link's thanks page (preview.js).
export function sentData(data) {
  const pages = data.live.pages.map((p) => (p.path === "/contact"
    ? { ...p, h1: SENT_H1, intro: `Thanks, ${data.business.name || "the team"} has your message and will be in touch soon.`, canonical_url: "", ld: [] }
    : p));
  return { ...data, live: { ...data.live, pages, form_action: "", noindex: true } };
}

/**
 * The response for a request on a client's own host (section 7), or null when the host isn't a client site (one of
 * ours, no client_sites row, an /api/ path, no database, or the lookup failed): the middleware then carries on into
 * stage 0's routing. `context` is the Pages context ({request, env, waitUntil}); its `waitUntil` runs the seen_at
 * stamp, the photo cache write and the enquiry email after the answer.
 */
export async function serveClientHost(context = {}, now = new Date()) {
  const { request, env } = context;
  // Called as a method: a Workers ExecutionContext's waitUntil throws "Illegal invocation" when it is called unbound.
  const waitUntil = typeof context.waitUntil === "function" ? (p) => context.waitUntil(p) : undefined;
  const url = new URL(request.url);
  const host = normaliseHost(url.hostname);
  if (!host || isOurHost(host) || url.pathname.startsWith("/api/")) return null;
  // Nothing under aetoswebsites.com is a client's (setHost refuses them), so a bad row that slipped in can never take
  // control.aetoswebsites.com, the Control Room's own host, offline. The test client's host is the one exception.
  if (underOurDomain(host) && host !== TEST_SITE_HOST) return null;
  const DB = env?.DB;
  if (!DB) return null;
  let site;
  try {
    site = await siteFor(DB, host);
  } catch (err) {
    // Not a client site as far as we can tell (e.g. the table isn't made yet): the Control Room's routing carries on.
    console.error(`Couldn't look up ${host} in client_sites, so it gets the Control Room's routing: ${why(err)}`);
    return null;
  }
  if (!site) return null;
  try {
    return await route(request, env, site, host, url, now, waitUntil);
  } catch (err) {
    console.error(`${host}${url.pathname.slice(0, 200)} couldn't be served: ${why(err)}`);
    return finish(request, htmlResponse(`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Please try again</title></head>
<body><main><h1>Sorry, this page can't be shown just now. Please try again in a minute.</h1></main></body></html>
`, 500, "no-store"), { html: true });
  }
}

async function route(request, env, site, host, url, now, waitUntil) {
  const path = url.pathname;
  const search = url.search;
  const method = request.method;
  const read = method === "GET" || method === "HEAD";

  if (site.status !== "live" || !site.content) return finish(request, htmlResponse(renderNotSetUp(), 404, "no-store"), { html: true });
  if (url.protocol === "http:") return finish(request, moved(`https://${host}${path}${search}`));
  if (site.host !== host) return finish(request, moved(`https://${site.host}${path}${search}`));
  if (path.length > 1 && path.endsWith("/")) {
    // One leading slash only, so "//evil.example/" can never become a redirect to another site.
    return finish(request, moved(`/${path.replace(/^\/+/, "").replace(/\/+$/, "")}${search}`));
  }

  // Served on the canonical host over https: the first GET stamps seen_at (the go-live waits for it).
  if (method === "GET" && !site.seen_at) {
    const stamp = markSeen(env.DB, site.client_id, now).catch((err) => {
      console.error(`Couldn't stamp seen_at for ${site.client_id}: ${why(err)}`);
    });
    if (typeof waitUntil === "function") waitUntil(stamp);
    else await stamp;
  }

  const content = site.content;
  const pagePaths = new Set((Array.isArray(content.pages) ? content.pages : []).map((p) => p?.path));

  // The endpoints that don't draw a page (and don't need the settings read).
  if (path === "/s/contact") return finish(request, await handleContact(request, env, site, now, { waitUntil }));
  if (path === "/s/chat") return finish(request, await handleChat(request, env, site, null, now));
  const file = FILE_PATH.exec(path);
  if (file) {
    if (!read) return finish(request, notAllowed("GET, HEAD"));
    const res = await serveFile(env.DB, file[1], {
      cache: globalThis.caches?.default, origin: `https://${host}`, client_id: site.client_id, waitUntil,
    });
    return finish(request, res);
  }
  if (path === "/robots.txt" && read) {
    return finish(request, textResponse(renderRobots(host, Number(site.is_test) === 1), "text/plain; charset=utf-8"));
  }
  if (path === "/sitemap.xml" && read) {
    return finish(request, textResponse(renderSitemap(content, host, site.content_at), "application/xml; charset=utf-8"));
  }
  if (path === "/s/review-card" && read) {
    const reviewUrl = typeof site.review_url === "string" ? site.review_url.trim() : "";
    if (site.package !== "website" && site.features.review_booster !== false && reviewUrl) {
      const b = isObj(content.business) ? content.business : {};
      const html = renderReviewCard({
        business: b.name || site.form?.business?.name || site.name,
        phone: b.phone || site.form?.business?.phone || "",
        owner: site.owner_first ?? "",
        reviewUrl,
      });
      return finish(request, htmlResponse(html), { html: true });
    }
  } else if (!pagePaths.has(path) && path !== "/privacy" && path !== "/s/chat.js") {
    const to = redirectFor(content, path);
    if (to) return finish(request, moved(to));
  }

  // Pages, /privacy, /s/chat.js and the 404 page: these depend on whether the chat is on.
  const { settings, secrets } = await chatSettings(env.DB);
  const chat = chatEnabled({ site, settings, secrets }).on;
  if (path === "/s/chat.js" && read && chat) {
    const services = content.pages.filter((p) => isObj(p) && p.key === "service").map((p) => p.name);
    const js = chatWidgetJs({ business: content.business?.name || site.name, services });
    return finish(request, textResponse(js, "application/javascript; charset=utf-8"));
  }
  const data = siteData(content, {
    lead: site.lead, host: site.host, base: "", reviewUrl: site.review_url ?? "", chat, noindex: Number(site.is_test) === 1,
    form: site.form,
  });
  if (pagePaths.has(path) || path === "/privacy") {
    if (!read) return finish(request, notAllowed("GET, HEAD"));
    if (path === "/privacy") return finish(request, htmlResponse(renderPrivacy(content, data, { now })), { html: true });
    const sent = path === "/contact" && url.searchParams.get("sent") === "1";
    return finish(request, htmlResponse(renderSite(sent ? sentData(data) : data, { mode: "live", page: path, now })), { html: true });
  }
  return finish(request, htmlResponse(renderMissingPage(data, { now }), 404, "no-store"), { html: true });
}
