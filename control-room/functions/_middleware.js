// Password gate for the whole Control Room. One password (CONTROL_ROOM_PASSWORD), a signed cookie for 30 days.
// Before it, host routing: the root domain (site:root_host, default aetoswebsites.com) is the public website.
import {
  DEFAULT_CONTACT, PRIVACY_UPDATED, ROBOTS, loadSiteSettings, renderLanding, renderNotFound, renderPrivacy, rootHostFor,
  siteResponse,
} from "./_lib/site.js";
import { db } from "./_lib/util.js";

const COOKIE = "cr_session";
// /api/stripe/webhook is called by Stripe, not you: it checks Stripe's signature instead of the login cookie.
// /d/<slug> are the prospects' demo sites (public, unguessable links, never indexed).
// /api/tick is called by the mail relay Worker's cron: it only does work that is already due, under a lease, and
// reads nothing but ?reason. /onboard/<token> is a paying client's onboarding form (unguessable link), and /s/* are
// the files, chat and contact form of client websites, which their visitors use without logging in.
const PUBLIC_PATHS = new Set(["/login", "/login.html", "/style.css", "/favicon.png", "/logo.png", "/apple-touch-icon.png", "/robots.txt", "/api/stripe/webhook", "/api/tick"]);
// Public on every host, the root domain included. A stage adding a public prefix adds it here (this one list serves
// both hosts) and to the root-host list in tests/site.test.mjs. Each prefix has a catch-all
// functions/<prefix>/[[path]].js that is the 404 page, so a path nothing answers yet never falls through to Pages'
// single-page-app fallback (the Control Room's index.html, with 200, without a login).
const PUBLIC_PREFIXES = ["/d/", "/onboard/", "/s/"];

async function sessionToken(password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("goldbar-control-room-session"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const match = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : "";
}

const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } });

// On the root host only these and PUBLIC_PREFIXES reach their functions (without a login); everything else there,
// the login page, the Control Room and /api/agent/* included, is the 404 page. They're public on the Control Room's
// host too (each is also in PUBLIC_PATHS).
const SITE_PATHS = new Set(["/logo.png", "/favicon.png", "/apple-touch-icon.png", "/api/tick", "/api/stripe/webhook"]);
const sitePublic = (path) => SITE_PATHS.has(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));

// HEAD gets the same status and headers, with no body.
const bodyless = (request, res) => (request.method === "HEAD" ? new Response(null, res) : res);

// Business details, contact email and the extras switches. If D1 can't be read the pages still show, with the
// defaults (no trader line, hello@aetoswebsites.com, no extras).
async function siteSettings(env) {
  try {
    return await loadSiteSettings(await db(env));
  } catch (err) {
    console.error(`The public site couldn't read its settings, so it shows the defaults: ${String(err?.message ?? err).split("\n")[0].slice(0, 300)}`);
    return { business: {}, contactEmail: DEFAULT_CONTACT, extras: { chatbot: false, reviews: false } };
  }
}

async function rootPage(request, env, path) {
  const read = request.method === "GET" || request.method === "HEAD";
  if (read && path === "/robots.txt") {
    return bodyless(request, new Response(ROBOTS, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } }));
  }
  if (read && (path === "/" || path === "/privacy")) {
    const { business, contactEmail, extras } = await siteSettings(env);
    const html = path === "/"
      ? renderLanding({ business, contactEmail, now: new Date(), extras })
      : renderPrivacy({ business, contactEmail, updated: PRIVACY_UPDATED });
    return bodyless(request, siteResponse(html));
  }
  return bodyless(request, siteResponse(renderNotFound(), 404));
}

// The public website's routing. A Response for the root host (its pages, or the 404 page) and for www.<root> (a 301
// to the root, same path and query); null for every other host, which carries on to the Control Room's gate.
// The root host costs one D1 read a minute (rootHostFor). It's skipped for *.pages.dev (always the Control Room) and
// for paths public on every host, so /api/tick keeps its whole 50-query budget: on the root host those fall through
// to the gate, which lets them through too. A www host is always looked up, so www.<root> redirects every path.
async function publicSite(request, env, url) {
  const host = url.hostname.replace(/\.$/, "");
  if (host.endsWith(".pages.dev")) return null;
  const path = url.pathname;
  const www = host.startsWith("www.");
  if (!www && sitePublic(path)) return null;
  const root = await rootHostFor(env, env.DB);
  if (host === root) return sitePublic(path) ? null : rootPage(request, env, path);
  if (host === `www.${root}`) return new Response(null, { status: 301, headers: { location: `https://${root}${path}${url.search}` } });
  return null;
}

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  const site = await publicSite(request, env, url);
  if (site) return site;
  if (!env.CONTROL_ROOM_PASSWORD) {
    return new Response("Set CONTROL_ROOM_PASSWORD in the Cloudflare Pages settings, then redeploy.", { status: 500 });
  }
  const token = await sessionToken(env.CONTROL_ROOM_PASSWORD);
  const secure = url.protocol === "https:" ? "; Secure" : "";

  if (url.pathname === "/login" && request.method === "POST") {
    const form = await request.formData();
    const attempt = await sessionToken(String(form.get("password") || ""));
    if (!safeEqual(attempt, token)) return redirect("/login?wrong=1");
    return redirect("/", { "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}` });
  }
  if (url.pathname === "/logout") {
    return redirect("/login", { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` });
  }
  if (PUBLIC_PATHS.has(url.pathname)) return next();
  // demo sites (prospects open these from our emails), onboarding forms and client-site files
  if (PUBLIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return next();
  // /api/agent/* is for Claude's Routines, which send a Bearer token instead of the login cookie: each function checks
  // it itself (requireAgent: the access key made on Setup → Claude, or a 24+ character OUTREACH_AGENT_TOKEN; the older
  // routes still use agentDenied, OUTREACH_AGENT_TOKEN only). It still goes through the catch below, so an error (e.g.
  // no database bound) reaches the Routine in plain English.
  const agent = url.pathname.startsWith("/api/agent/");
  if (!agent && !safeEqual(readCookie(request, COOKIE), token)) {
    if (url.pathname.startsWith("/api/")) return new Response(JSON.stringify({ error: "Not logged in" }), { status: 401 });
    return redirect("/login");
  }
  try {
    return await next();
  } catch (err) {
    // show the real reason in the Control Room instead of a bare "500"
    const message = err && err.message ? err.message : String(err);
    if (url.pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return new Response(`Control Room error: ${message}`, { status: 500 });
  }
}
