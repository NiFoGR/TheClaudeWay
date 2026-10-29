// The onboarding form's routes (stage 10, docs/rebuild/09-build.md section 4 and Task 12): GET /onboard/<token>,
// POST /onboard/<token>/save and POST /onboard/<token>/submit (functions/onboard/) are thin wrappers over this file.
//
// onboardPage: an unknown token is the 404 page; a sent form is the thanks page with the answers; otherwise the form,
// with the saved answers (or the prefill from the lead and research), and the client_sites row is made on first open.
// saveOnboarding: the whole form, normalised, until Send (409 after). submitOnboarding (Send): validates, then sets
// submitted_at and due_live_at = submitted_at + 168 h with `UPDATE … WHERE token = ? AND submitted_at IS NULL`, so
// of two presses only the one that changed the row closes stage 9's build:new:<client_id>, fires the build Routine
// (status building when Claude accepted it; a failed fire leaves it submitted, for the health light and Build again)
// and files the domain, Google and photo todos (startTodos). The client sees the thanks page either way.
//
// D1 budget: GET 1 read (+ 4 to make the site row, + 1 todo); save 1 write (+ 1 read when it's refused); Send 1 read,
// 1 batch of 2 (the clock and the build:new close), up to 4 for the site row, fireRoutine's 3–5, 1 status write,
// then startTodos: 1 read, 1 domain write, 2 for the host and at most 8 todos (about 26 in all). Tested in control-room/tests/sites-onboard.test.mjs.

import { fireRoutine } from "../routines.js";
import { setSetting } from "../settings.js";
import { addTodo, closeTodos } from "../todo.js";
import { iso, parseJson } from "../util.js";
import { cappedBytes } from "./cappedBody.js";
import { oneLine } from "./copy.js";
import { dueFrom } from "./countdown.js";
import { ensureSite, setHost, updateDomain } from "./db.js";
import { domainMode, domainSteps } from "./domain.js";
import {
  formDefaults, normaliseForm, onboardFirst, renderBadToken, renderOnboard, renderOnboardDone, validateForm,
} from "./form.js";
import { canonicalHost } from "./hosts.js";

/** The most a save or Send may post: the whole form as JSON. */
export const FORM_MAX_BYTES = 32 * 1024;

// Stage 9's tokens are 32 base64url characters; anything that can't be one is unknown without a query.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const GBP_EMAIL_KEY = "care:nik_google_email";
const PHOTOS_WANTED = 4; // fewer than this from their website → Nik saves some from their Google listing

export const ONBOARD_ERRORS = Object.freeze({
  token: "This link isn't valid. Check the link in our email, or reply to it and we'll send a new one.",
  sent: "You've already sent this form. Need to change an answer? Just reply to our email.",
  big: "Your answers are over 32 KB, which is more than we can take. Please shorten your longest answers.",
  json: "We couldn't read your answers. Please reload the page and try again.",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const objectOf = (v) => {
  const parsed = typeof v === "string" ? parseJson(v, null) : v;
  return isObj(parsed) ? parsed : null;
};
const fullPackage = (pkg) => pkg !== "website";
const siteLink = (client_id) => `/#/site/${client_id}`;

// The onboarding row with everything the pages and Send need, in one select.
const LOAD_SQL = `SELECT o.client_id, o.token, o.status, o.form, o.submitted_at, o.due_live_at,
    c.name AS client_name, c.package AS package, c.place_id AS place_id,
    cs.client_id AS site_id, cs.place_id AS site_place_id, cs.host AS site_host,
    l.name AS lead_name, l.phone AS lead_phone, l.address AS lead_address, l.town AS lead_town,
    l.search_town AS lead_search_town, l.director_name AS lead_director_name, l.company_number AS lead_company_number,
    r.best_email AS research_best_email, r.owner AS research_owner, r.copy AS research_copy,
    (SELECT v.value FROM settings v WHERE v.key = '${GBP_EMAIL_KEY}') AS gbp_email
  FROM onboarding o
  JOIN clients c ON c.id = o.client_id
  LEFT JOIN client_sites cs ON cs.client_id = o.client_id
  LEFT JOIN leads l ON l.place_id = c.place_id
  LEFT JOIN research r ON r.place_id = c.place_id
  WHERE o.token = ?`;

/** The onboarding row for a token, shaped for the pages, or null when no such token. */
async function loadOnboarding(DB, token) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const r = await DB.prepare(LOAD_SQL).bind(token).first();
  if (!r) return null;
  const client = { id: r.client_id, name: r.client_name, package: r.package, place_id: r.place_id ?? null };
  const lead = r.lead_name === null || r.lead_name === undefined ? null : {
    name: r.lead_name, phone: r.lead_phone, address: r.lead_address, town: r.lead_town || r.lead_search_town,
    director_name: r.lead_director_name, company_number: r.lead_company_number,
  };
  const research = { best_email: r.research_best_email, owner: r.research_owner, copy: r.research_copy };
  const site = r.site_id ? { client_id: r.site_id, place_id: r.site_place_id ?? null, host: r.site_host ?? null } : null;
  return {
    client, lead, research, site,
    onboarding: { status: r.status, submitted_at: r.submitted_at, due_live_at: r.due_live_at },
    form: objectOf(r.form),
    gbpEmail: oneLine(r.gbp_email),
  };
}

// The client's site row: the one loaded with the onboarding row, else made now (status draft, no content).
async function siteFor(DB, row, now) {
  if (row.site) return row.site;
  const s = await ensureSite(DB, row.client.id, { name: row.client.name, place_id: row.client.place_id }, now);
  return { client_id: s.client_id, place_id: s.place_id ?? null, host: s.host ?? null };
}

export const GBP_EMAIL_BAD = "That doesn't look like an email address.";
const GBP_EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/**
 * Nik's Google account address as typed: {ok: true, email} (trimmed, lower case; "" clears it) or {error}. Checked
 * on the raw text too: a line break inside would otherwise only be trimmed away at the ends.
 */
export function checkGbpEmail(raw) {
  if (typeof raw !== "string") return { error: GBP_EMAIL_BAD };
  const email = raw.trim();
  if (email && (email.length > 254 || !GBP_EMAIL_RE.test(email) || /[\r\n]/.test(raw))) return { error: GBP_EMAIL_BAD };
  return { ok: true, email: email.toLowerCase() };
}

/**
 * Saves `care:nik_google_email` (shared with stage 11's Care settings: whichever route saves it calls this) and,
 * when it isn't empty, closes the `setup:gbp-email` todo, so the todo closes wherever Nik fills the address in.
 * "" deletes the setting. → {ok: true, email} | {error} (nothing saved). D1: 1 write, + 1 when it closes the todo.
 */
export async function saveGbpEmail(DB, raw) {
  const checked = checkGbpEmail(raw);
  if (checked.error) return checked;
  if (checked.email) {
    await setSetting(DB, GBP_EMAIL_KEY, checked.email);
    await closeTodos(DB, "setup:gbp-email");
  } else {
    await DB.prepare("DELETE FROM settings WHERE key = ?").bind(GBP_EMAIL_KEY).run();
  }
  return checked;
}

// The setup todo while the Google account clients invite isn't set: the form's GBP steps can't name it yet.
// Saving care:nik_google_email (saveGbpEmail, from Setup or stage 11's Care settings) closes it.
function gbpEmailTodo(DB) {
  return addTodo(DB, {
    kind: "setup",
    dedupe: "setup:gbp-email",
    title: "Add the Google account clients invite as Manager",
    detail: "Setup → Client sites → \"Your Google account for client profiles\". Until it's set, the onboarding form "
      + "tells clients we'll email them the address to invite.",
    link: "/#/setup",
  });
}

// section 14: "Connect the chatbot (Cloudflare Workers AI) on Setup", only once a Full Package client exists. Filed at
// Send while the last chatbot Test hasn't passed; Setup's passing Test closes it (api/setup/sites.js).
function chatbotTodo(DB) {
  return addTodo(DB, {
    kind: "setup",
    dedupe: "setup:chatbot",
    title: "Connect the chatbot (Cloudflare Workers AI) on Setup",
    detail: "Setup → Client sites: paste the Cloudflare account ID and a Workers AI token, then press Test. "
      + "Until the Test passes, Full Package sites have no chatbot.",
    link: "/#/setup",
  });
}

/** chat:last_test's text → true only when it's readable and passed. */
function chatTestPassed(text) {
  const last = parseJson(text, null);
  return Boolean(last && typeof last === "object" && last.ok === true);
}

/**
 * GET /onboard/<token> → {status, html}: 404 for an unknown token; the thanks page (with the answers) once sent;
 * else the form. The first open makes the client_sites row.
 */
export async function onboardPage(DB, token, now = new Date()) {
  const row = await loadOnboarding(DB, token);
  if (!row) return { status: 404, html: renderBadToken() };
  const first = onboardFirst(row.research);
  const pkg = row.client.package;
  if (row.onboarding.submitted_at) {
    return {
      status: 200,
      html: renderOnboardDone({ first, dueIso: row.onboarding.due_live_at, form: row.form ?? {}, package: pkg }),
    };
  }
  await siteFor(DB, row, now);
  if (fullPackage(pkg) && !row.gbpEmail) await gbpEmailTodo(DB);
  const form = row.form ?? formDefaults({ lead: row.lead, research: row.research, client: row.client });
  return { status: 200, html: renderOnboard({ token, form, first, package: pkg, gbpEmail: row.gbpEmail, now }) };
}

/**
 * The posted body of a save or Send → {ok: true, form} | {ok: false, status: 413|400, error}. Over FORM_MAX_BYTES is
 * 413 (checked on Content-Length first, then on the bytes read); anything but a JSON object is 400.
 */
export async function readFormBody(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FORM_MAX_BYTES) return { ok: false, status: 413, error: ONBOARD_ERRORS.big };
  let text;
  try {
    // Read only up to the limit, then cancelled (cappedBody.js): a chunked post is never held in memory or decoded.
    const bytes = await cappedBytes(request, FORM_MAX_BYTES);
    if (bytes === null) return { ok: false, status: 413, error: ONBOARD_ERRORS.big };
    text = new TextDecoder().decode(bytes);
  } catch {
    return { ok: false, status: 400, error: ONBOARD_ERRORS.json };
  }
  const form = parseJson(text, null);
  if (!isObj(form)) return { ok: false, status: 400, error: ONBOARD_ERRORS.json };
  return { ok: true, form };
}

/**
 * Autosave: the whole form (normalised to section 4's shape) replaces the stored one, until Send.
 * → {status: 200} | {status: 404|409|400, error}. Two tabs: the last save wins.
 */
export async function saveOnboarding(DB, token, form) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return { status: 404, error: ONBOARD_ERRORS.token };
  if (!isObj(form)) return { status: 400, error: ONBOARD_ERRORS.json };
  const r = await DB.prepare("UPDATE onboarding SET form = ? WHERE token = ? AND submitted_at IS NULL")
    .bind(JSON.stringify(normaliseForm(form)), token)
    .run();
  if (r.meta?.changes === 1) return { status: 200 };
  const known = await DB.prepare("SELECT 1 AS yes FROM onboarding WHERE token = ?").bind(token).first();
  return known ? { status: 409, error: ONBOARD_ERRORS.sent } : { status: 404, error: ONBOARD_ERRORS.token };
}

/**
 * Send. Validates the form for the client's package, then starts the 7-day clock once: of two presses, the second
 * (and any later one) is 409 and never fires the Routine again. On the press that set submitted_at: closes stage 9's
 * build:new:<client_id>, fires the build Routine ("build: client <client_id>") and files the todos (startTodos).
 * A failed fire keeps onboarding.status = submitted and still answers 200: the client's part is done.
 * → {status: 200, due_live_at} | {status: 400, errors} | {status: 404|409, error}
 */
export async function submitOnboarding(DB, env, token, form, now = new Date(), { fire = fireRoutine } = {}) {
  const row = await loadOnboarding(DB, token);
  if (!row) return { status: 404, error: ONBOARD_ERRORS.token };
  if (row.onboarding.submitted_at) return { status: 409, error: ONBOARD_ERRORS.sent };
  const { ok, errors } = validateForm(form, { package: row.client.package, now });
  if (!ok) return { status: 400, errors };

  const f = normaliseForm(form);
  const at = iso(now);
  const due = dueFrom(at);
  const id = row.client.id;
  // One batch (one transaction), so stage 9's build:new:<client_id> closes in the same step as onboarding leaves
  // 'sent' (stage 9 files it only while it is 'sent'). It is closed by its exact dedupe, freed as closeTodos does:
  // closeTodos matches a prefix, and "build:new:c1" is a prefix of "build:new:c10". The close runs only when this
  // press's submitted_at is the stored one; a losing press finds the todo already done.
  const [clock] = await DB.batch([
    DB.prepare(
      `UPDATE onboarding SET form = ?, submitted_at = ?, due_live_at = ?, status = 'submitted'
       WHERE token = ? AND submitted_at IS NULL`,
    ).bind(JSON.stringify(f), at, due, token),
    DB.prepare(
      `UPDATE todos SET status = 'done', done_at = ?1, dedupe = dedupe || '@' || ?1
       WHERE status = 'open' AND dedupe = ?2
         AND EXISTS (SELECT 1 FROM onboarding WHERE token = ?3 AND submitted_at = ?4)`,
    ).bind(new Date(now).toISOString(), `build:new:${id}`, token, at),
  ]);
  if (clock.meta?.changes !== 1) return { status: 409, error: ONBOARD_ERRORS.sent };

  // From here on the clock has started and a second press is 409, so nothing below may turn this press into an error:
  // the client would be told to press Send again and only ever see the thanks page, while the Routine fire or the
  // todos were skipped. Each part is tried on its own and logged (the build API makes a missing site row itself).
  const log = (what, err) => console.error(`Send for client ${id}: ${what} failed: ${String(err?.message ?? err).split("\n")[0].slice(0, 300)}`);
  let site = null;
  try {
    site = await siteFor(DB, row, now);
  } catch (err) {
    log("making the site row", err);
  }

  let fired;
  try {
    fired = await fire(DB, "build", `build: client ${id}`, { now });
  } catch (err) {
    // fireRoutine never throws for a failed fire; anything else is logged and counts as one (Nik presses Build again)
    log("the build Routine fire", err);
    fired = { ok: false };
  }
  // Guarded on 'submitted': content Claude posted in the meantime has already moved it to review.
  if (fired?.ok === true) {
    try {
      await DB.prepare("UPDATE onboarding SET status = 'building' WHERE client_id = ? AND status = 'submitted'").bind(id).run();
    } catch (err) {
      log("the building status", err);
    }
  }

  try {
    await startTodos(DB, site ?? { client_id: id, place_id: row.client.place_id, host: null }, f, row.client, now);
  } catch (err) {
    log("filing the domain and Google todos", err);
  }
  return { status: 200, due_live_at: due };
}

// GBP todo titles (section 14) and what Nik does next, by the client's answer.
const GBP_TODOS = {
  yes: (name, sent) => ({
    title: `Accept ${name}'s Google Business Profile invite`,
    detail: sent
      ? `${name} ticked "I've sent the invite" on the form. Accept it from Google's email, then tick "Invite accepted" on their Site page.`
      : `${name} has a profile but hadn't ticked "I've sent the invite" yet. Once Google's email arrives, accept it, then tick "Invite accepted" on their Site page.`,
  }),
  no: (name) => ({
    title: `Create a Google Business Profile with ${name}`,
    detail: `${name} has no Google listing yet. Set it up with them; Google will ask them to verify it, usually with a short video. Then tick "Profile created" on their Site page.`,
  }),
  not_sure: (name) => ({
    title: `Check whether ${name} has a Google Business Profile`,
    detail: `${name} wasn't sure. Search Google Maps for the business: if it's there, ask them to invite you as Manager; if not, create one with them.`,
  }),
};

/**
 * The todos Send files (all link to /#/site/<client_id>): one per domain step (build:<client_id>:domain:<step>, the
 * plan stored on client_sites.domain), the Google listing (build:<client_id>:gbp, Full Package), photos from their
 * Google listing when their website gave fewer than 4 (build:<client_id>:gphotos), and setup:gbp-email while the
 * Google account isn't set and setup:chatbot while the chatbot Test hasn't passed (both Full Package). A client with their own domain gets www.<domain> as the site's host,
 * unless the site has one or another site uses it (Nik types it on the Site page then). Safe to run again: every
 * todo has a dedupe. → {mode, steps: [step ids]}
 */
export async function startTodos(DB, site, form, client, now = new Date()) {
  const f = normaliseForm(form);
  const id = site?.client_id ?? client?.id;
  if (!id) throw new TypeError("startTodos needs the client's site row or the client.");
  const place_id = site?.place_id ?? client?.place_id ?? null;
  const name = oneLine(client?.name) || oneLine(f.business.name) || "This client";
  const ctx = await DB.prepare(
    `SELECT (SELECT value FROM settings WHERE key = 'sites:pages_host') AS pages_host,
       (SELECT value FROM settings WHERE key = '${GBP_EMAIL_KEY}') AS gbp_email,
       (SELECT value FROM settings WHERE key = 'chat:last_test') AS chat_test,
       (SELECT audit FROM leads WHERE place_id = ?) AS audit`,
  )
    .bind(place_id)
    .first();

  const mode = domainMode(f.domain);
  const host = mode === "buy" ? { ok: false } : canonicalHost(f.domain.name);
  const domain = host.ok ? host.domain : "";
  const steps = domainSteps({
    mode, name, domain, registrar: f.domain.registrar, choices: f.domain.choices, legalLine: f.business.legal_line,
    address: f.business.address, email: f.business.email, emailOnIt: f.domain.email_on_it, pagesHost: ctx?.pages_host,
  });
  await updateDomain(DB, id, {
    mode, domain, registrar: oneLine(f.domain.registrar), email_on_it: f.domain.email_on_it,
    choices: f.domain.choices.map((c) => oneLine(c)),
  }, now);
  if (host.ok && !site?.host) await setHost(DB, id, host.host, now); // refused (in use): Nik types it on the Site page

  const todo = (what, title, detail) => addTodo(DB, {
    kind: "build", dedupe: `build:${id}:${what}`, title, detail, link: siteLink(id), client_id: id, place_id,
  });
  for (const step of steps) await todo(`domain:${step.id}`, step.title, step.detail);

  const full = fullPackage(client?.package);
  const gbp = full ? GBP_TODOS[f.gbp.has] : null;
  if (gbp) {
    const { title, detail } = gbp(name, f.gbp.invite_sent);
    await todo("gbp", title, detail);
  }
  if (full && !oneLine(ctx?.gbp_email)) await gbpEmailTodo(DB);
  if (full && !chatTestPassed(ctx?.chat_test)) await chatbotTodo(DB);

  const photos = objectOf(objectOf(ctx?.audit)?.brand)?.photos;
  if (!Array.isArray(photos) || photos.filter(Boolean).length < PHOTOS_WANTED) {
    await todo("gphotos", `Save up to 5 photos from ${name}'s Google listing and add them on the Site page`,
      `${name}'s website gave us fewer than ${PHOTOS_WANTED} photos. Open their Google listing, save up to 5 of their own photos of their work, and add them with "Add photos" on the Site page.`);
  }
  return { mode, steps: steps.map((s) => s.id) };
}
