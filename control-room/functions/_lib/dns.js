// Email DNS checks for a mailbox domain (Setup → DNS for <domain>): look up the records over Cloudflare's
// DNS-over-HTTPS (fetch only), then judge SPF, DKIM and DMARC and describe where the domain's mail goes (pure).
//
// Namecheap Private Email needs: SPF with include:spf.privateemail.com (plus Cloudflare's include when Cloudflare
// Email Routing receives the domain's mail), DKIM at the selector privateemail._domainkey (default._domainkey for
// subscriptions bought before 2 June 2026), and a DMARC record. Every
// failed check carries the exact record to add or edit in Cloudflare (Part A, "DNS for <domain>"). Record values are
// DNS text, so the Setup page escapes them like any other untrusted text.

export const DOH_URL = "https://cloudflare-dns.com/dns-query";
export const DNS_UNREACHABLE = "Couldn't check DNS right now (Cloudflare's DNS lookup didn't answer). Try again in a minute.";
export const DKIM_SELECTOR = "privateemail._domainkey";
// Namecheap's DKIM selector for subscriptions bought before 2 June 2026 (later ones use DKIM_SELECTOR).
export const DKIM_LEGACY_SELECTOR = "default._domainkey";

const DOH_TIMEOUT_MS = 5000;
const TYPE_CODES = { TXT: 16, MX: 15 };
const DEFAULT_CONTACT_EMAIL = "hello@aetoswebsites.com";
// The contact address shape site.js accepts for its mailto: link (anything else is shown as the default there).
const CONTACT_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const NAMECHEAP_INCLUDE = "include:spf.privateemail.com";
const CLOUDFLARE_INCLUDE = "include:_spf.mx.cloudflare.net";
const DKIM_CONTENT = "the DKIM value Namecheap shows for your domain (Namecheap → Private Email → Manage → DNS records)";

/** A DNS lookup that didn't get an answer (a timeout, an HTTP error, SERVFAIL, an unreadable reply). */
export class DnsLookupError extends Error {
  constructor(cause) {
    super(DNS_UNREACHABLE, { cause });
    this.name = "DnsLookupError";
  }
}

// One DoH JSON query: the `data` of each answer of `type` (a CNAME met on the way is skipped). NXDOMAIN and an empty
// answer are []; anything else that isn't an answer throws DnsLookupError.
async function doh(name, type, { fetchImpl = fetch, timeoutMs = DOH_TIMEOUT_MS } = {}) {
  let body;
  try {
    const res = await fetchImpl(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`DNS-over-HTTPS answered HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new DnsLookupError(err);
  }
  const status = body?.Status ?? 0;
  if (status === 3) return []; // NXDOMAIN: the name doesn't exist
  if (status !== 0) throw new DnsLookupError(new Error(`DNS lookup status ${status}`));
  const answers = Array.isArray(body?.Answer) ? body.Answer : [];
  return answers
    .filter((a) => typeof a?.data === "string" && (a.type === undefined || a.type === TYPE_CODES[type]))
    .map((a) => a.data);
}

// A TXT answer's text: its quoted chunks joined (a 2048-bit DKIM key comes in several), with \" \\ and \DDD read.
// An answer that isn't quoted is taken as it is.
function txtText(data) {
  const s = data.trim();
  if (!s.startsWith('"')) return s;
  const chunks = [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return chunks.join("").replace(/\\(\d{3}|.)/g, (_, c) => (/^\d{3}$/.test(c) ? String.fromCharCode(Number(c)) : c));
}

/** The TXT records at `name`, each as one string (chunks joined, quotes removed). [] when there are none. */
export async function dohTxt(name, opts = {}) {
  return (await doh(name, "TXT", opts)).map(txtText);
}

// "10 mx1.privateemail.com." → {pref: 10, host: "mx1.privateemail.com"}. A null MX ("0 .") has the host "".
function mxRecord(data) {
  const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(data);
  const host = (m ? m[2] : data).trim().toLowerCase().replace(/\.+$/, "");
  return { pref: m ? Number(m[1]) : 0, host };
}

/** The mail hosts for `name`, most preferred first, lower-cased, without the trailing dot. [] when there are none. */
export async function dohMx(name, opts = {}) {
  return (await doh(name, "MX", opts))
    .map(mxRecord)
    .sort((a, b) => a.pref - b.pref)
    .map((r) => r.host);
}

// ---------------------------------------------------------------- verdicts (pure)

const isNamecheapMx = (host) => /(^|\.)privateemail\.com$/.test(host);
const isCloudflareMx = (host) => /(^|\.)mx\.cloudflare\.net$/.test(host);
const texts = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === "string").map((s) => s.trim()) : []);
const addFix = (domain, name, content) => `In Cloudflare → ${domain} → DNS → Add record: type TXT, name ${name}, content ${content}`;

function mxNote(domain, hosts) {
  if (!hosts.length) return "No MX records";
  if (hosts.every(isNamecheapMx)) return `Mail to ${domain} goes to Namecheap (mx1/mx2.privateemail.com)`;
  if (hosts.every(isCloudflareMx)) return `Mail to ${domain} goes to Cloudflare Email Routing`;
  return `Mail to ${domain} goes to ${hosts.join(", ")}`;
}

// SPF terms are case-insensitive; a mechanism with no qualifier (or "+") passes, so only those authorise a sender.
const spfTerms = (record) => record.split(/\s+/).slice(1).filter(Boolean);
const passes = (terms, include) => terms.some((t) => t.toLowerCase().replace(/^\+/, "") === include);
const isAllTerm = (t) => /^[+~?-]?all$/i.test(t);

function spfCheck(domain, root, cloudflareMx) {
  const records = root.filter((r) => /^v=spf1(\s|$)/i.test(r));
  const needed = cloudflareMx ? [NAMECHEAP_INCLUDE, CLOUDFLARE_INCLUDE] : [NAMECHEAP_INCLUDE];
  const want = `v=spf1 ${needed.join(" ")} ~all`;
  const found = records.join("\n");
  const result = (ok, fix, content = want) => ({ name: "SPF", ok, found, fix, record: { type: "TXT", name: "@", content } });
  if (!records.length) return result(false, addFix(domain, "@", want));
  if (records.length > 1) return result(false, `You have ${records.length} SPF records. Merge them into one.`);
  const terms = spfTerms(records[0]);
  if (needed.every((inc) => passes(terms, inc))) return result(true, "");

  // Edit the one record. Whatever else it authorises (another sender's include, ip4:…, a redirect=) stays, and so
  // does its own "all", so the edit never stops other mail. The content to paste is always the fix's last words (no
  // full stop after it, so it can't be copied into the record).
  const others = terms.filter((t) => !isAllTerm(t) && !needed.includes(t.toLowerCase().replace(/^[+~?-]/, "")));
  const all = terms.find(isAllTerm)?.toLowerCase() ?? (others.some((t) => /^redirect=/i.test(t)) ? "" : "~all");
  const content = ["v=spf1", ...needed, ...others, all].filter(Boolean).join(" ");
  const head = `In Cloudflare → ${domain} → DNS, edit your SPF record (TXT, name @). Never add a second SPF record.`;
  if (content === want) return result(false, `${head} Its content should be: ${want}`);
  const keep = others.length ? `keep the other senders it already lists (${others.join(" ")})` : `keep its ${all}`;
  return result(false, `${head} The record you need is ${want}, but ${keep}, so its content should be: ${content}`, content);
}

// DKIM tags ("v=DKIM1; k=rsa; p=…"): v is optional but must be DKIM1 when present, and p must hold a key (an empty p
// means the key was revoked).
function dkimValid(text) {
  const tags = Object.fromEntries(
    text.split(";").map((part) => part.split("=")).filter((kv) => kv.length >= 2)
      .map(([k, ...v]) => [k.trim().toLowerCase(), v.join("=").replace(/\s+/g, "")]),
  );
  return (tags.v === undefined || tags.v === "DKIM1") && Boolean(tags.p);
}

// The selector is chosen first: privateemail._domainkey whenever it has a record (valid or not: a broken one is never
// passed over), else default._domainkey when that has one (an older subscription). With neither, the fix says to
// add privateemail._domainkey, the name new subscriptions use.
function dkimCheck(domain, dkim, dkimLegacy) {
  const useLegacy = !dkim.length && dkimLegacy.length > 0;
  const sel = useLegacy ? DKIM_LEGACY_SELECTOR : DKIM_SELECTOR;
  const list = useLegacy ? dkimLegacy : dkim;
  const record = { type: "TXT", name: sel, content: DKIM_CONTENT };
  const found = list.join("\n");
  if (!list.length) return { name: "DKIM", ok: false, found, fix: addFix(domain, DKIM_SELECTOR, DKIM_CONTENT), record };
  if (list.length > 1) {
    const fix = `You have ${list.length} DKIM records at ${sel}. In Cloudflare → ${domain} → DNS, keep only the one with ${DKIM_CONTENT} and delete the others.`;
    return { name: "DKIM", ok: false, found, fix, record };
  }
  if (dkimValid(list[0])) return { name: "DKIM", ok: true, found, fix: "", record };
  const fix = `The DKIM record at ${sel} has no valid key. In Cloudflare → ${domain} → DNS, edit it so its content is ${DKIM_CONTENT}.`;
  return { name: "DKIM", ok: false, found, fix, record };
}

// A DMARC record starts "v=DMARC1" (the tag name in any case, the value exactly) and needs a p= policy (RFC 7489).
const isDmarc = (text) => /^[vV]\s*=\s*DMARC1\s*(;|$)/.test(text);
const hasPolicy = (text) => /(^|;)\s*p\s*=\s*(none|quarantine|reject)\s*(;|$)/i.test(text);

function dmarcCheck(domain, dmarc, contactEmail) {
  const want = `v=DMARC1; p=none; rua=mailto:${contactEmail}`;
  const record = { type: "TXT", name: "_dmarc", content: want };
  const records = dmarc.filter(isDmarc);
  const found = (records.length ? records : dmarc).join("\n");
  if (!records.length) return { name: "DMARC", ok: false, found, fix: addFix(domain, "_dmarc", want), record };
  if (records.length > 1) {
    return { name: "DMARC", ok: false, found, fix: `You have ${records.length} DMARC records. Merge them into one: ${want}`, record };
  }
  if (hasPolicy(records[0])) return { name: "DMARC", ok: true, found, fix: "", record };
  const fix = `Your DMARC record has no p= policy. In Cloudflare → ${domain} → DNS, edit it (TXT, name _dmarc) so it reads: ${want}`;
  return { name: "DMARC", ok: false, found, fix, record };
}

/**
 * The verdicts for one domain from its records (pure). `root` is the TXT records at the domain itself, `mx` its mail
 * hosts (dohMx's form; "10 host." is read too), `dkim` the TXT records at privateemail._domainkey, `dkimLegacy`
 * those at default._domainkey (judged only when privateemail._domainkey has none; left out means none), `dmarc` those
 * at _dmarc. Returns {ok, checks: [{name: "SPF"|"DKIM"|"DMARC", ok, found, fix, record: {type, name, content}}],
 * mx_note}: ok when all three pass, found the records seen (one per line, "" for none), fix "" when it passes, and
 * record the record Setup tells Nik to add (for an existing SPF record that needs editing, the content it should end up
 * with, keeping the senders it already lists). The MX line is information only, never a check. contactEmail is the
 * DMARC report address; blank or not a plain address means hello@aetoswebsites.com, as on the landing page.
 */
export function dnsVerdicts({ domain, root, mx, dkim, dkimLegacy, dmarc, contactEmail } = {}) {
  const hosts = texts(mx).map((m) => mxRecord(m).host).filter(Boolean);
  const cloudflareMx = hosts.some(isCloudflareMx);
  // The address the landing page shows (site.js falls back the same way), so DMARC reports go where mail is read.
  const typed = typeof contactEmail === "string" ? contactEmail.trim() : "";
  const contact = CONTACT_RE.test(typed) ? typed : DEFAULT_CONTACT_EMAIL;
  const checks = [
    spfCheck(domain, texts(root), cloudflareMx),
    dkimCheck(domain, texts(dkim), texts(dkimLegacy)),
    dmarcCheck(domain, texts(dmarc), contact),
  ];
  return { ok: checks.every((c) => c.ok), checks, mx_note: mxNote(domain, hosts) };
}
