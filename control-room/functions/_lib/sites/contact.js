// The contact form on client sites: POST /s/contact (stage 10, docs/rebuild/09-build.md section 9).
//
// Checks run in section 9's order: honeypot `website` filled, or `t` (ms since page load, set by the page's inline
// script) present and under 3,000 → a 303 to /contact?sent=1 with nothing stored or sent (bots see what people see);
// more than 5 posts per visitor per site per hour (rate_hits key form:<client_id>:<visitor>) → 429 with the business's
// phone number; invalid → 400 with the form refilled and plain-English errors; valid → a site_leads row (source form),
// the enquiry email queued by notifyLead, then 303 to /contact?sent=1. Raw IPs are never stored (visitorId hashes it).
// CR and LF (every line break) are stripped from the single-line fields before anything is stored or emailed, so a
// name can't add a header. Everything the visitor typed is escaped with h() when it is shown back.
//
// Responses never set cookies and carry the client-host security headers (section 7). D1: 1 rate hit, 1 insert,
// notifyLead's ≤ 6, then the send's ~8 in waitUntil (well under the 50 per invocation with the middleware's reads).
//
// The send straight away: Part A says waitUntil(runTick(env, "site_lead")), but this is a public form, so it runs
// the outbox for system mail only (dispatchDue, one email), as stage 7's reply routes do. A whole tick here would
// count only its own 50 D1 queries on top of this request's (the free plan's limit is 50 per invocation, the same
// reason stage 6's Send nudges only the send step), and it would take the tick's lease and stamp tick:last, so a
// stream of posts could keep the cron tick turned away ("locked" / "too_soon"). If the send doesn't happen here, the
// tick's send step sends it within 5 minutes.
import { h } from "../demo/text.js";
import { dispatchDue } from "../mail/outbox.js";
import { errorText } from "../tick.js";
import { iso } from "../util.js";
import { cappedBytes } from "./cappedBody.js";
import { oneLine } from "./copy.js";
import { notifyLead } from "./notify.js";
import { hit, visitorId } from "./rate.js";

export const FORM_LIMIT = 5; // posts per visitor per site per UTC hour
export const MIN_FILL_MS = 3000;
export const MESSAGE_MAX = 2000;
const BODY_MAX = 64 * 1024; // far above a 2,000-character message; anything bigger isn't a person
// Not RFC's 254: the enquiry email prints every detail through oneLine (200 characters), so a longer address would be
// cut there. No real address is that long; one over it is refused, never stored or emailed cut short.
const EMAIL_MAX = 200;
const PAGE_MAX = 200;
const SENT = "/contact?sent=1";
// The path prefix a page is served under: "" on the client's own host, "/w/<slug>" on the temporary link (Task 23).
const BASE_RE = /^(?:\/[A-Za-z0-9._~-]+)*$/;
const PAGE_PATH = /^\/[A-Za-z0-9\-._~/%]*$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
// Control characters other than tab and LF (CR is turned into LF first), C1 controls, and the bidi overrides, out of
// a message.
const MESSAGE_JUNK = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' "
  + "'unsafe-inline'; frame-src https://maps.google.com https://www.google.com; form-action 'self'; base-uri 'none'";

const headers = (extra = {}) => ({
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cache-control": "no-store",
  ...extra,
});

const htmlHeaders = () => headers({ "content-type": "text/html; charset=utf-8", "content-security-policy": CSP });

const sent = (base) => new Response(null, { status: 303, headers: headers({ location: `${base}${SENT}` }) });

const baseOf = (base) => (typeof base === "string" && BASE_RE.test(base) && !base.includes("..") ? base : "");

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The business name and phone the pages show (the content), else the client's name. */
function businessOf(site) {
  const biz = isObject(site?.content?.business) ? site.content.business : {};
  return { name: oneLine(biz.name) || oneLine(site?.name) || "this business", phone: oneLine(biz.phone) };
}

// A form value as text ("" for a missing field or a file upload).
const field = (data, key) => {
  const v = data?.get(key);
  return typeof v === "string" ? v : "";
};

const cleanMessage = (s) => String(s ?? "").replace(/\r\n?/g, "\n").replace(MESSAGE_JUNK, "").trim();

// One line: control and bidi characters out, then copy.js's oneLine (every CR/LF and run of spaces one space, ≤ 200).
const cleanLine = (s) => oneLine(String(s ?? "").replace(/[\r\n]+/g, " ").replace(MESSAGE_JUNK, ""));

// The email on one line, junk out, but never cut short (oneLine stops at 200 characters, and a cut address is a
// wrong one): contactErrors refuses one over EMAIL_MAX instead.
const cleanEmail = (s) => String(s ?? "").replace(MESSAGE_JUNK, "").replace(/\s+/g, " ").trim();

const digits = (s) => (String(s).match(/\d/g) || []).length;

// The page the visitor was on: the form's hidden `page` field when it is a plain path on this site, else null.
function pageOf(value) {
  const p = cleanLine(value);
  return p && p.length <= PAGE_MAX && PAGE_PATH.test(p) && !p.startsWith("//") ? p : null;
}

/**
 * The fields as stored: single-line ones on one line (CR/LF gone), at most 200 characters (the email is never cut:
 * a longer one is refused); the message as typed.
 */
export function contactFields(data) {
  return {
    name: cleanLine(field(data, "name")),
    phone: cleanLine(field(data, "phone")),
    email: cleanEmail(field(data, "email")),
    message: cleanMessage(field(data, "message")),
    page: pageOf(field(data, "page")),
  };
}

/** Section 9's errors, in its order (empty when the post can be stored). */
export function contactErrors(fields, business) {
  const errors = [];
  if (!fields.name) errors.push("Please add your name.");
  const email = fields.email;
  const phoneOk = digits(fields.phone) >= 7;
  if (!phoneOk && !email) errors.push(`Please add a phone number or an email so ${business} can reply.`);
  if (email && (email.length > EMAIL_MAX || !EMAIL_RE.test(email))) errors.push("That email doesn't look right.");
  if (fields.message.length > MESSAGE_MAX) errors.push("Please keep your message under 2,000 characters.");
  return errors;
}

/** A plain page on the client's host (noindex; their own name at the top, never Aetos branding). */
function page(business, title, inner, base = "") {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${h(title)} | ${h(business.name)}</title>
<style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1a1c20;background:#fff}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}
.err{border-left:4px solid #b3261e;background:#fdecea;padding:12px 16px;margin:0 0 20px}
.err p{margin:0 0 4px}
label{display:block;margin:0 0 14px;font-weight:600}
input,textarea{display:block;box-sizing:border-box;width:100%;margin-top:6px;padding:12px 14px;border:1px solid #8a9099;border-radius:8px;font:inherit;font-weight:400}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
button{min-height:48px;padding:12px 28px;border:0;border-radius:8px;background:#1a1c20;color:#fff;font:inherit;font-weight:600}
a{color:inherit}
</style>
</head>
<body>
<main>
<p><a href="${h(base)}/">${h(business.name)}</a></p>
${inner}
</main>
</body>
</html>`;
}

/** The form again, every value refilled and escaped, with the errors above it (the 400 page). */
export function contactErrorPage(business, fields, errors, base = "") {
  const lines = errors.map((e) => `<p>${h(e)}</p>`).join("\n");
  const inner = `<h1>Send a message</h1>
<div class="err" role="alert">
${lines}
</div>
<form id="cf" method="post" action="${h(base)}/s/contact">
<label>Your name<input name="name" autocomplete="name" required value="${h(fields.name)}"></label>
<label>Your phone number<input name="phone" type="tel" autocomplete="tel" value="${h(fields.phone)}"></label>
<label>Your email<input name="email" type="email" autocomplete="email" value="${h(fields.email)}"></label>
<label>What do you need?<textarea name="message" rows="5" maxlength="${MESSAGE_MAX}">${h(fields.message)}</textarea></label>
<div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
<input type="hidden" name="t" value="">
<input type="hidden" name="page" value="${h(fields.page ?? "")}">
<button type="submit">Send</button>
</form>
<script>(function(){var s=Date.now(),f=document.getElementById("cf");
f.addEventListener("submit",function(){f.elements.t.value=String(Date.now()-s);});})();</script>`;
  return page(business, "Send a message", inner, base);
}

function tooMany(business, base) {
  const text = business.phone
    ? `Too many messages from this connection. Please call ${business.phone} instead.`
    : "Too many messages from this connection. Please try again in an hour.";
  return new Response(page(business, "Too many messages", `<h1>Too many messages</h1>\n<p>${h(text)}</p>`, base), {
    status: 429,
    headers: htmlHeaders(),
  });
}

const plain = (business, status, title, text, extra = {}, base = "") =>
  new Response(page(business, title, `<h1>${h(title)}</h1>\n<p>${h(text)}</p>`, base), {
    status,
    headers: { ...htmlHeaders(), ...extra },
  });

/** The enquiry email straight away: the outbox, system mail only, at most one email (see the top of this file). */
const sendNow = (DB, env, now) => dispatchDue(DB, env, now, { limit: 1, kinds: ["system"] });

/**
 * POST /s/contact on a live client site. `site` is the client_sites row (siteByHost/getSite). With `waitUntil` (the
 * Pages context's), the enquiry email is sent after the response (the outbox, system mail only, one email) so it goes
 * out at once; `dispatch` replaces that in tests. `base` is the path prefix the site is served under ("" on its own
 * host, "/w/<slug>" on the temporary link), so the thanks redirect and the refilled form stay on that site. Always a
 * Response: 303, 400, 405, 404, 413 or 429.
 */
export async function handleContact(request, env, site, now = new Date(), { waitUntil, base = "", dispatch = sendNow } = {}) {
  const business = businessOf(site);
  const prefix = baseOf(base);
  if (!site?.client_id || site.status !== "live") {
    return plain(business, 404, "Not found", "This website isn't set up yet.", {}, prefix);
  }
  if (request.method !== "POST") {
    return plain(business, 405, "Send a message", "Please use the form on the contact page.", { allow: "POST" }, prefix);
  }
  if (Number(request.headers.get("content-length")) > BODY_MAX) {
    return plain(business, 413, "Message too long", "Please keep your message under 2,000 characters.", {}, prefix);
  }
  const DB = env.DB;
  let data = null;
  try {
    // A chunked body has no Content-Length: it is read only up to BODY_MAX, then cancelled (cappedBody.js).
    const bytes = await cappedBytes(request, BODY_MAX);
    if (bytes === null) {
      return plain(business, 413, "Message too long", "Please keep your message under 2,000 characters.", {}, prefix);
    }
    data = await new Response(bytes, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    data = null; // an unreadable body is an empty form: the errors below say what's missing
  }

  // 1. Bots: the hidden field filled, or sent faster than a person can type. They see the thanks page, nothing more.
  if (field(data, "website").trim()) return sent(prefix);
  const t = field(data, "t").trim();
  if (t && !(Number(t) >= MIN_FILL_MS)) return sent(prefix);

  // 2. One connection: 5 posts an hour per site.
  const visitor = await visitorId(request, site.client_id, now);
  const { allowed } = await hit(DB, `form:${site.client_id}:${visitor}`, now, FORM_LIMIT);
  if (!allowed) return tooMany(business, prefix);

  // 3. The fields.
  const fields = contactFields(data);
  const errors = contactErrors(fields, business.name);
  if (errors.length) {
    return new Response(contactErrorPage(business, fields, errors, prefix), { status: 400, headers: htmlHeaders() });
  }

  // 4. Store, then the email to the business.
  const at = iso(now);
  const lead = {
    id: crypto.randomUUID(),
    client_id: site.client_id,
    source: "form",
    name: fields.name,
    phone: fields.phone || null,
    email: fields.email || null,
    message: fields.message,
    page: fields.page,
    session: null,
    notified_at: null,
    message_id: null,
    created_at: at,
    updated_at: at,
  };
  const cols = Object.keys(lead);
  await DB.prepare(`INSERT INTO site_leads (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map((c) => lead[c]))
    .run();
  // The enquiry is stored (and shows on the Site page) whatever happens next, so the visitor always gets the thanks
  // page: an error page here would only make them send it again.
  let queued = false;
  try {
    ({ queued } = await notifyLead(DB, lead, site, now));
  } catch (err) {
    console.error(`A contact-form enquiry for ${site.client_id} was saved but its email couldn't be queued: ${errorText(err, env)}`);
  }
  if (queued && typeof waitUntil === "function") {
    waitUntil(Promise.resolve().then(() => dispatch(DB, env, now)).catch((err) => {
      console.error(`An enquiry email couldn't be sent straight away (the tick's send step sends it): ${errorText(err, env)}`);
    }));
  }
  return sent(prefix);
}
