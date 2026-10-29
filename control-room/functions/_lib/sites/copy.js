// Review link, review-request templates and client site emails (pure, stage 10: docs/rebuild/09-build.md sections 7
// and 12, exact copy).
//
// Everything here is plain text for email or the client's own messages. Names, hosts and addresses come from the
// onboarding form, visitors and Claude, so every single-line value goes through oneLine() (a name can't break a line
// or a header), and every subject does too before it is queued: stage 0's composeEmail refuses CR/LF outright.
// `nik` is always the sign name sendClientMail passes to compose (the business:sender_name setting, else "Nik").
// Review requests never gate ("were you happy?"), never offer anything for a review and never pressure.

import { ukParts } from "../ukTime.js";

const NOT_GOOGLE = "That isn't a Google review link.";
const REVIEW_HOSTS = new Set(["g.page", "search.google.com", "www.google.com", "google.com", "maps.app.goo.gl"]);
// google.com's redirectors (and ad/image click-throughs) would send a "Google" link anywhere: not review links.
const REDIRECT_PATH = /^\/(url|amp|aclk|imgres|linkredirect|interstitial|travel\/clk)(\/|$)/i;
const DEFAULT_SIGN = "Nik";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ONE_LINE_MAX = 200;

const pad = (n) => String(n).padStart(2, "0");

/** One line of text: line breaks (and runs of spaces) become one space, trimmed, at most 200 characters. */
export function oneLine(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, ONE_LINE_MAX).trim();
}

// A link for a message: whitespace removed, never cut short (a long Google Maps link must still work).
const link1 = (s) => String(s ?? "").replace(/\s+/g, "");

const sign = (nik) => oneLine(nik) || DEFAULT_SIGN;
const hi = (first) => (oneLine(first) ? `Hi ${oneLine(first)},` : "Hi,");

/**
 * A Google review link a client or Nik pasted: `https://` on g.page, search.google.com, www.google.com, google.com
 * or maps.app.goo.gl (section 4). {ok: true, url} with the URL as the browser reads it, or {ok: false, error}.
 */
export function checkReviewLink(url) {
  const bad = { ok: false, error: NOT_GOOGLE };
  const text = typeof url === "string" ? url.trim() : "";
  if (!text || /\s/.test(text) || !/^https:\/\//i.test(text)) return bad;
  let u;
  try {
    u = new URL(text);
  } catch {
    return bad;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return bad;
  if (!REVIEW_HOSTS.has(u.hostname.toLowerCase())) return bad;
  if (u.hostname.toLowerCase().endsWith("google.com") && REDIRECT_PATH.test(u.pathname)) return bad;
  return { ok: true, url: u.href };
}

/**
 * The site's review link (section 12): the form's review_link if it passes checkReviewLink, else Nik's pasted one
 * (same check), else Google's write-a-review link for the place id; null when there is none of these.
 */
export function reviewUrl({ formLink, nikLink, placeId } = {}) {
  for (const link of [formLink, nikLink]) {
    const checked = checkReviewLink(link);
    if (checked.ok) return checked.url;
  }
  const id = typeof placeId === "string" ? placeId.trim() : "";
  return id ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(id)}` : null;
}

/**
 * The ready-made review requests (section 12, exact). `{customer}` stays for the client to fill in. `owner` is the
 * owner's first name when confident; blank signs with the business name.
 */
export function reviewMessages({ business, owner, link } = {}) {
  const name = oneLine(business);
  const who = oneLine(owner) || name;
  const url = link1(link);
  return {
    sms: `Hi {customer}, thanks for choosing ${name}. If you have a minute, could you leave us a Google review? It really helps a small local business: ${url} Thanks, ${who}`,
    email: {
      subject: oneLine(`Thanks from ${name}`),
      body: `Hi {customer},\n\nThanks for choosing ${name}. If you have a minute, could you leave us a Google review? It really helps a small local business, and it only takes a minute:\n\n${url}\n\nThanks,\n${who}`,
    },
    reminder: `Hi {customer}, just a quick reminder in case you missed it: if you could leave ${name} a Google review, it would mean a lot. ${url} No worries if not. ${who}`,
  };
}

// "Wed 28 Oct, 14:05" in UK time; "" when `when` isn't a date.
function ukStamp(when) {
  const date = when instanceof Date ? when : new Date(String(when ?? ""));
  if (Number.isNaN(date.getTime())) return "";
  const { d, m, hh, mm, weekday } = ukParts(date);
  return `${DAYS[weekday]} ${d} ${MONTHS[m - 1]}, ${pad(hh)}:${pad(mm)}`;
}

/**
 * The enquiry email to the business (section 12) for a site_leads row `lead` ({name, phone, email, message, page,
 * created_at}): the form message or the chat transcript. Details the visitor didn't give are left out (never an empty
 * "Email:" line). `when` (Date or ISO) defaults to the lead's created_at. `site` and `business` are accepted for the
 * callers' convenience; the copy doesn't name the business (it is their own inbox).
 */
export function enquiryEmail({ lead = {}, site, business, when } = {}) {
  const name = oneLine(lead.name);
  // A chat lead has no page: say "your website" rather than claim a page they weren't on.
  const page = oneLine(lead.page) || "your website";
  const stamp = ukStamp(when ?? lead.created_at ?? new Date());
  const details = [
    name && `Name: ${name}`,
    oneLine(lead.phone) && `Phone: ${oneLine(lead.phone)}`,
    oneLine(lead.email) && `Email: ${oneLine(lead.email)}`,
  ].filter(Boolean);
  const message = String(lead.message ?? "").replace(/\r\n?/g, "\n").trim();
  const parts = [`${name || "Someone"} sent this from ${page}${stamp ? ` on ${stamp}` : ""}:`];
  if (details.length) parts.push(details.join("\n"));
  if (message) parts.push(message);
  parts.push("Reply to them directly (not to this email). Sent by your website, built by Aetos Websites.");
  return { subject: oneLine(`New enquiry from your website: ${name || "someone"}`), body: parts.join("\n\n") };
}

/**
 * The go-live email to the client (section 12, exact). The chat sentence only when `chatOn`; the review paragraph
 * only for a Full Package site with a review URL (pass reviewUrl null when features.review_booster is false, which
 * drops it from emails).
 */
export function goLiveEmail({ first, host, leadsEmail, chatOn, fullPackage, reviewUrl: review, nik } = {}) {
  const site = oneLine(host);
  const leads = oneLine(leadsEmail);
  const enquiries = [
    leads && `Website enquiries go to ${leads}.`,
    chatOn && "The chat assistant on your site answers questions day and night and sends you anyone who leaves their number.",
  ].filter(Boolean).join(" ");
  const parts = [
    hi(first),
    `Your new website is live: https://${site}`,
    "Have a look and tell me anything you'd like changed: just reply to this email.",
  ];
  if (enquiries) parts.push(enquiries);
  if (fullPackage && oneLine(review)) {
    parts.push(`The quickest way up Google Maps is a steady stream of reviews. Ask every customer when you finish a job. Your review link, a printable QR card and ready-made text messages are here: https://${site}/s/review-card`);
  }
  parts.push(`${sign(nik)}\nAetos Websites`);
  return { subject: oneLine(`Your website is live: ${site}`), body: parts.join("\n\n") };
}

// The client's domain, or a plain-English error: an email saying "shows on ." helps nobody.
function needDomain(domain) {
  const name = oneLine(domain);
  if (!name) throw new Error("The domain email needs the client's domain: type it on the Site page first.");
  return name;
}

/**
 * The nameserver steps email (section 7, B.2, exact). `ns` is Cloudflare's two nameservers; without exactly two (or
 * without a domain) the email would be useless or untrue ("these two"), so it throws a plain-English Error for the
 * route to return as a 400. The "Your email keeps working" sentence is left out when emailOnIt is "no".
 */
export function nameserverEmail({ first, domain, registrar, ns, emailOnIt, nik } = {}) {
  const servers = [...new Set((Array.isArray(ns) ? ns : []).map(oneLine).filter(Boolean))];
  if (servers.length !== 2) {
    throw new Error("The nameserver email needs Cloudflare's two nameservers: paste them on the Site page first.");
  }
  const name = needDomain(domain);
  const company = oneLine(registrar) || "the company you bought your domain from";
  const keepsEmail = emailOnIt === "no" ? "" : " Your email keeps working: we've copied its settings across.";
  const body = [
    hi(first),
    `One quick job so your new website shows on ${name}. Log in to ${company}, open ${name}, find "Nameservers" (sometimes under DNS or Advanced), choose "custom" and replace what's there with these two:`,
    servers.join("\n"),
    `Save, and that's it.${keepsEmail} It can take a few hours to switch over.`,
    "If you'd rather I talk you through it, reply with a good time to call.",
    sign(nik),
  ].join("\n\n");
  return { subject: oneLine("One quick job for your new website"), body };
}

/**
 * The "point www at us" email for clients who can't log in to their domain (section 7, C.2, exact). Throws a
 * plain-English Error without a domain or the Pages address (sites:pages_host): the record would point nowhere.
 */
export function cnameEmail({ first, domain, registrar, pagesHost, nik } = {}) {
  const name = needDomain(domain);
  const target = oneLine(pagesHost);
  if (!target) throw new Error("The www email needs your Pages address: add it on Setup → Client sites first.");
  const who = oneLine(registrar) || "the company you bought it from, or the person who built your old site";
  const body = [
    hi(first),
    `One quick job so your new website shows on ${name}. Whoever looks after your domain (${who}) needs to make two changes in its DNS settings:`,
    `1. Add a CNAME record: name "www", target "${target}" (remove any old "www" record first).\n2. Forward ${name} to https://www.${name}`,
    "Your email isn't affected. Forward this email to them if that's easiest.",
    sign(nik),
  ].join("\n\n");
  return { subject: oneLine("One quick job for your new website"), body };
}
