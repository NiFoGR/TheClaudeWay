// GET /api/sites/<client_id> → one client site for the Site page (stage 10, docs/rebuild/09-build.md section 13,
// Task 24), behind the login (_middleware.js): {…site, label, countdown, pages: [{path, title, words, preview}],
// steps: [{id, title, detail, done_at, auto}], chat: {on, reason, today, month, fallbacks_today}, leads (the last 20,
// each message cut to 120 characters), files, form, review: {url, qr_svg, card_url, messages, booster}, last_errors}.
// qr_svg is "" and card_url null when the link's QR wouldn't fit the printed card (cardQr).
// `…site` is getSite()'s row (content, domain, host_check, features parsed; the client's name and package; the
// onboarding clock) plus has_content, preview_url, temp_url, mode, nameservers, gbp, email_to and owner_first.
// 404 {error: "No client with that id."} for an unknown client.
//
// The other /api/sites/<client_id>/* routes import their shared helpers from here (statusLabel, siteCountdown,
// loadSite, planSteps, fireBuild, readBody, closeTodo): one place for the words and the rules they share.
// Everything scraped, typed by the client or written by Claude is returned as data; the page escapes it (esc()).
// Tested in control-room/tests/sites-api.test.mjs.
//
// D1: 1 (getSite) + 1 (form, contacts, settings) + 1 batch of 2 (chat usage, leads) + 1 (files).
import { fireRoutine } from "../../_lib/routines.js";
import { cardQr } from "../../_lib/sites/card.js";
import { chatEnabled } from "../../_lib/sites/chat.js";
import { wordCount } from "../../_lib/sites/content.js";
import { checkReviewLink, oneLine, reviewMessages, reviewUrl } from "../../_lib/sites/copy.js";
import { countdown } from "../../_lib/sites/countdown.js";
import { getSite } from "../../_lib/sites/db.js";
import { listFiles } from "../../_lib/sites/files.js";
import { domainMode, domainSteps, PAGES_PROJECT } from "../../_lib/sites/domain.js";
import { onboardFirst } from "../../_lib/sites/form.js";
import { canonicalHost } from "../../_lib/sites/hosts.js";
import { ukDate } from "../../_lib/ukTime.js";
import { bad, db, json, parseJson } from "../../_lib/util.js";

export const NO_CLIENT = "No client with that id.";
export const FIRE_FAILED = "Claude couldn't be reached: the build Routine's link or token on Setup is wrong. Fix it on Setup, then press Build again.";
const FIRE_LIMIT = "Claude's limit for the build Routine was hit just now: wait an hour, then press Build again.";
const NOT_STARTED = "Not started: waiting for their onboarding form";
const BODY_MAX = 64 * 1024;
const LEADS_SHOWN = 20;
const LEAD_TEXT_MAX = 120;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const objectOf = (value) => {
  const v = typeof value === "string" ? parseJson(value, null) : value;
  return isObj(v) ? v : {};
};

/** The label Nik sees for a site's status (section 3). */
export function statusLabel(site) {
  if (site?.status === "off") return "Offline";
  if (site?.status === "live") return site.live_at ? "Live" : "Approved: waiting for the domain";
  if (site?.status === "review") return "Ready to approve";
  if (site?.change_notes) return "Claude is making your changes";
  return "Waiting for Claude";
}

/** The guarantee countdown {label, level} (section 7); grey "Not started" until the form is sent. */
export function siteCountdown(site, now = new Date()) {
  if (!site?.due_live_at) return { label: NOT_STARTED, level: "grey" };
  try {
    const { label, level } = countdown(site.due_live_at, site.live_at ?? null, now);
    return { label, level };
  } catch {
    return { label: NOT_STARTED, level: "grey" };
  }
}

/** `context.now` (tests) or the time now. */
export const nowOf = (context) => (context?.now ? new Date(context.now) : new Date());

/** The client id from the route, "" when it's missing. */
export const clientIdOf = (params) => (typeof params?.client_id === "string" ? params.client_id : "");

/** The request's JSON object, {} when there's none, or null when it isn't a JSON object (or is over 64 KB). */
export async function readBody(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_MAX) return null;
  const text = await request.text().catch(() => null);
  if (text === null || text.length > BODY_MAX) return null;
  if (!text.trim()) return {};
  const body = parseJson(text, null);
  return isObj(body) ? body : null;
}

export const NOT_JSON = "That request wasn't readable. Reload the page and try again.";

// The form, where the client's emails go, their first name and the settings the Site page needs, in one select.
// Only whether the Workers AI secrets are set is read, never their values.
const EXTRAS_SQL = `SELECT
    (SELECT o.form FROM onboarding o WHERE o.client_id = ?1) AS form,
    (SELECT l.email FROM client_links l WHERE l.client_id = ?1) AS link_email,
    (SELECT p.greet_name FROM prospects p WHERE p.place_id = ?2) AS greet_name,
    (SELECT r.owner FROM research r WHERE r.place_id = ?2) AS research_owner,
    (SELECT v.value FROM settings v WHERE v.key = 'sites:pages_host') AS pages_host,
    (SELECT v.value FROM settings v WHERE v.key = 'offer:chatbot_live') AS chatbot_live,
    EXISTS (SELECT 1 FROM settings v WHERE v.key = 'secret:cf_ai:account_id' AND v.value <> '') AS has_account,
    EXISTS (SELECT 1 FROM settings v WHERE v.key = 'secret:cf_ai:token' AND v.value <> '') AS has_token`;

/**
 * The site (getSite) with what the routes need around it: `form` (the onboarding answers, {} before any),
 * `email_to` (client_links.email, else the form's business email), `first` (prospects.greet_name, else the confident
 * research name; null for "Hi,"), `owner_first` (the confident owner name for the review messages), `pages_host`
 * (the setting, else <project>.pages.dev) and `chat` (chatEnabled). null when the client has no site.
 */
export async function loadSite(DB, client_id) {
  if (!client_id) return null;
  const site = await getSite(DB, client_id);
  if (!site) return null;
  const x = (await DB.prepare(EXTRAS_SQL).bind(client_id, site.place_id ?? "").first()) ?? {};
  const form = objectOf(x.form);
  const ownerFirst = onboardFirst({ owner: parseJson(x.research_owner, null) });
  const chat = chatEnabled({
    site,
    settings: { "offer:chatbot_live": x.chatbot_live },
    secrets: { "cf_ai:account_id": Number(x.has_account) === 1, "cf_ai:token": Number(x.has_token) === 1 },
  });
  return {
    ...site,
    form,
    email_to: [x.link_email, form.business?.email].map((v) => oneLine(v)).find(Boolean) ?? null,
    first: oneLine(x.greet_name) || ownerFirst || null,
    owner_first: oneLine(x.greet_name) || ownerFirst || "",
    pages_host: oneLine(x.pages_host) || `${PAGES_PROJECT}.pages.dev`,
    chat,
  };
}

/** The bare domain a site's emails and steps name: the plan's, else the host without www. */
export function siteDomain(site) {
  return oneLine(site?.domain?.domain) || String(site?.host ?? "").replace(/^www\./, "");
}

/**
 * The domain plan's steps with Nik's ticks: {mode, steps: [{id, title, detail, done_at, auto}]}. The mode is the one
 * Send stored, else worked out from the form once it is sent; none (and no steps) before that.
 */
export function planSteps(site, domainOverride) {
  const d = domainOverride ?? site?.domain ?? {};
  const f = isObj(site?.form) ? site.form : {};
  const fd = isObj(f.domain) ? f.domain : {};
  const fb = isObj(f.business) ? f.business : {};
  const mode = typeof d.mode === "string" && d.mode ? d.mode : site?.submitted_at ? domainMode(fd) : null;
  if (!mode) return { mode: null, steps: [] };
  const typed = canonicalHost(oneLine(fd.name));
  const domain = oneLine(d.domain) || String(site?.host ?? "").replace(/^www\./, "") || (mode !== "buy" && typed.ok ? typed.domain : "");
  const done = objectOf(d.steps);
  const steps = domainSteps({
    mode, name: site?.name, domain,
    registrar: d.registrar ?? fd.registrar,
    choices: Array.isArray(d.choices) ? d.choices : fd.choices,
    legalLine: fb.legal_line, address: fb.address, email: fb.email,
    emailOnIt: d.email_on_it ?? fd.email_on_it,
    pagesHost: site?.pages_host,
  });
  return { mode, steps: steps.map((s) => ({ ...s, done_at: typeof done[s.id] === "string" ? done[s.id] : null })) };
}

/**
 * Fires the build Routine with `text` ("build: client <id>" or "changes: client <id>"). `context.fire` and
 * `context.fetchImpl` (or env.__fetch) are for tests; live it is fireRoutine with fetch. Never throws.
 */
export async function fireBuild(context, DB, text, now) {
  const fire = typeof context?.fire === "function" ? context.fire : fireRoutine;
  const fetchImpl = context?.fetchImpl ?? context?.env?.__fetch;
  try {
    return (await fire(DB, "build", text, fetchImpl ? { fetchImpl, now } : { now })) ?? { ok: false };
  } catch (err) {
    console.error(`The build Routine fire (${text}) failed: ${String(err?.message ?? err).split("\n")[0].slice(0, 300)}`);
    return { ok: false, status: null };
  }
}

/** The plain-English error for a fire that wasn't accepted; `again` names the button to press again. */
export function fireError(fired, again = "Build again") {
  const base = fired?.status === 429 ? FIRE_LIMIT : FIRE_FAILED;
  return again === "Build again" ? base : base.replace("press Build again", `press ${again} again`);
}

// done_at is part of the freed dedupe, which must stay unique: never the same millisecond twice in an isolate.
let lastDone = 0;
const doneAt = () => {
  lastDone = Math.max(Date.now(), lastDone + 1);
  return new Date(lastDone).toISOString();
};

/**
 * Closes the open todo with exactly this dedupe, freeing it as closeTodos does (closeTodos matches a prefix, and
 * build:<id>:domain:pages is a prefix of build:<id>:domain:pages_cname). 1 query.
 */
export async function closeTodo(DB, dedupe) {
  const at = doneAt();
  await DB.prepare("UPDATE todos SET status = 'done', done_at = ?1, dedupe = dedupe || '@' || ?1 WHERE status = 'open' AND dedupe = ?2")
    .bind(at, dedupe)
    .run();
}

/** The review link the site uses: the stored one, else the form's link, else Google's link for the place. */
export function siteReviewUrl(site) {
  const stored = checkReviewLink(site?.review_url ?? "");
  if (stored.ok) return stored.url;
  return reviewUrl({ formLink: site?.form?.review_link, placeId: site?.place_id ?? null });
}


const cutText = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const out = t.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
};

/** `context.now` (tests) or the time now. */
export async function onRequestGet(context) {
  const { env, params } = context;
  const now = nowOf(context);
  const DB = await db(env);
  const site = await loadSite(DB, clientIdOf(params));
  if (!site) return bad(NO_CLIENT, 404);
  const id = site.client_id;

  const today = ukDate(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [usage, leads] = await DB.batch([
    DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN day = ?2 THEN messages END), 0) AS today,
         COALESCE(SUM(messages), 0) AS month,
         COALESCE(SUM(CASE WHEN day = ?2 THEN fallbacks END), 0) AS fallbacks_today
       FROM chat_usage WHERE client_id = ?1 AND day >= ?3 AND day <= ?2`,
    ).bind(id, today, monthStart),
    DB.prepare(
      `SELECT id, source, name, phone, email, page, substr(message, 1, 400) AS message, notified_at, created_at
       FROM site_leads WHERE client_id = ? ORDER BY created_at DESC, id LIMIT ${LEADS_SHOWN}`,
    ).bind(id),
  ]);
  const files = await listFiles(DB, id);
  const u = usage.results?.[0] ?? {};

  const content = site.content;
  const base = `/c/${site.slug}`;
  const pages = (Array.isArray(content?.pages) ? content.pages : [])
    .filter((p) => isObj(p) && typeof p.path === "string")
    .map((p) => ({
      path: p.path,
      title: typeof p.title === "string" ? p.title : "",
      words: wordCount(p),
      preview: p.path === "/" ? `${base}/` : `${base}${p.path}`,
    }));

  const { mode, steps } = planSteps(site);
  const url = siteReviewUrl(site);
  // The card's own QR (cardQr): "" when the link's QR wouldn't fit the printed card (a long link stored before the
  // save checked it), and then no card button either: the page says to paste the short link instead.
  const qr = url ? cardQr(url) : "";
  const booster = site.package !== "website" && site.features.review_booster !== false;
  const business = oneLine(content?.business?.name) || oneLine(site.form.business?.name) || oneLine(site.name);
  const { chat, form, ...rest } = site;

  return json({
    ...rest,
    has_content: Boolean(content),
    preview_url: content ? `${base}/` : null,
    temp_url: site.status === "live" ? `/w/${site.slug}/` : null,
    mode,
    nameservers: Array.isArray(site.domain.nameservers) ? site.domain.nameservers : [],
    gbp: {
      answer: oneLine(form.gbp?.has) || null,
      invite_sent: form.gbp?.invite_sent === true,
      invite_accepted: objectOf(site.domain.gbp).invite_accepted ?? null,
      profile_created: objectOf(site.domain.gbp).profile_created ?? null,
    },
    label: statusLabel(site),
    countdown: siteCountdown(site, now),
    pages,
    steps,
    chat: {
      on: chat.on,
      reason: chat.on ? null : chat.reason,
      today: Number(u.today) || 0,
      month: Number(u.month) || 0,
      fallbacks_today: Number(u.fallbacks_today) || 0,
    },
    leads: (leads.results ?? []).map((l) => ({ ...l, message: cutText(l.message, LEAD_TEXT_MAX) })),
    files,
    form,
    review: {
      url,
      qr_svg: qr,
      card_url: qr && booster && site.status === "live" && site.host ? `https://${site.host}/s/review-card` : null,
      messages: url ? reviewMessages({ business, owner: site.owner_first, link: url }) : null,
      booster,
    },
    last_errors: site.last_errors ?? null,
  });
}
