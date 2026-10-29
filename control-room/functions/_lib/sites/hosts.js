// Client-site hosts (stage 10, pure): which Host headers are ours, the www twin of a host, the canonical www host of a
// domain a client typed, Cloudflare's IPv4 ranges and the plain-English DNS verdict for a client host. The lookups
// themselves (DNS-over-HTTPS) are in ./dns.js. Hosts are stored and matched lower-case, without port or trailing dot,
// in punycode (an IDN goes through new URL()). Tested in control-room/tests/sites-hosts.test.mjs.

// Hosts that never go through the client_sites lookup (the public site and local dev). Any *.pages.dev is ours too,
// and so is every other host under aetoswebsites.com (control.aetoswebsites.com included: serveClientHost skips them
// before touching D1), bar the test client's TEST_SITE_HOST. Any other host (site-test.aetoswebsites.com, a client's
// domain) is looked up; with no row it gets stage 0's routing unchanged, so there is no list of Control Room hosts and
// no variable to keep.
export const OUR_HOSTS = new Set(["aetoswebsites.com", "www.aetoswebsites.com", "localhost", "127.0.0.1"]);

// Aetos's own domain. No host under it is ever a client's (control.aetoswebsites.com is the Control Room): setHost
// refuses them, the form tells the client, and serveClientHost never looks them up, bar the one test-client host.
export const ROOT_DOMAIN = "aetoswebsites.com";
export const TEST_SITE_HOST = "site-test.aetoswebsites.com";

// Cloudflare's published IPv4 ranges (https://www.cloudflare.com/ips-v4, checked 28 Oct 2026). A host whose A records
// are all in these is served by a zone in Cloudflare (ours, once the domain is connected).
export const CF_IPV4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

const BAD_DOMAIN = "That doesn't look like a web address. Type it like smithroofing.co.uk.";
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

// Punycode for a host with non-ASCII letters (new URL() does IDNA); "" when it can't be a host at all.
function toAscii(host) {
  if (/^[\x00-\x7f]*$/.test(host)) return host;
  try {
    return new URL(`https://${host}`).hostname;
  } catch {
    return "";
  }
}

const stripDots = (s) => s.replace(/\.+$/, "");

/** A Host header as we store and match hosts: lower-case, no port, no trailing dot, punycode. "" for nothing. */
export function normaliseHost(raw) {
  let s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s) return "";
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    return end > 0 ? s.slice(0, end + 1) : s; // an IPv6 literal keeps its brackets; only the port goes
  }
  s = stripDots(s.replace(/:\d*$/, ""));
  return toAscii(s);
}

/** True for a host that skips the client-site lookup: OUR_HOSTS or any *.pages.dev (no env variable). */
export function isOurHost(host) {
  const h = normaliseHost(host);
  if (!h) return false;
  return OUR_HOSTS.has(h) || (h.endsWith(".pages.dev") && h.length > ".pages.dev".length);
}

/** True for aetoswebsites.com and any host under it (www., control., www.control., site-test., …). */
export function underOurDomain(host) {
  const h = normaliseHost(host);
  return Boolean(h) && (h === ROOT_DOMAIN || h.endsWith(`.${ROOT_DOMAIN}`));
}

/** The other half of a www pair: "smith.co.uk" ↔ "www.smith.co.uk". "" for no host. */
export function wwwTwin(host) {
  const h = normaliseHost(host);
  if (!h) return "";
  return h.startsWith("www.") ? h.slice(4) : `www.${h}`;
}

/**
 * The canonical host for a domain a client typed (" https://Smith.co.uk/ ", "www.smith.co.uk", "bücher.de"):
 * {ok: true, host: "www.<domain>", domain} with domain lower-case punycode and without www., or {ok: false, error} in
 * the onboarding form's words.
 */
export function canonicalHost(domainInput) {
  const bad = { ok: false, error: BAD_DOMAIN };
  if (typeof domainInput !== "string") return bad;
  let s = domainInput.trim();
  if (!s || /\s/.test(s) || s.includes("@")) return bad;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.split(/[/?#]/, 1)[0];
  s = stripDots(s.replace(/:\d+$/, "").toLowerCase());
  if (!s) return bad;
  s = toAscii(s);
  if (!s) return bad;
  const domain = s.startsWith("www.") ? s.slice(4) : s;
  const labels = domain.split(".");
  if (domain.length > 249 || labels.length < 2) return bad;
  if (!labels.every((l) => LABEL_RE.test(l)) || !TLD_RE.test(labels[labels.length - 1])) return bad;
  return { ok: true, host: `www.${domain}`, domain };
}

// "104.21.3.4" → its 32-bit value; null for anything that isn't a dotted-quad IPv4 address.
function ipv4(ip) {
  if (typeof ip !== "string") return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

const CF_RANGES = CF_IPV4.map((cidr) => {
  const [base, bits] = cidr.split("/");
  const size = 2 ** (32 - Number(bits));
  const start = ipv4(base);
  return { start, end: start + size - 1 };
});

/** True when `ip` (IPv4) is in one of Cloudflare's published ranges. */
export function inCloudflare(ip) {
  const n = ipv4(ip);
  return n !== null && CF_RANGES.some((r) => n >= r.start && n <= r.end);
}

const names = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === "string").map((s) => stripDots(s.trim().toLowerCase())).filter(Boolean) : []);

// DNS answers are someone else's data: the detail repeats only a plain name or address (at most 3 of them), never
// markup or a huge string, so it is safe in a todo or a log even before it is escaped on render.
const shown = (s) => (/^[a-z0-9._:-]{1,253}$/.test(s) ? s : "");

/**
 * Whether a host points at us from its DNS answers: its CNAME chain contains `pagesHost`, or it has A records and
 * every one is Cloudflare's (a zone in our account). {ok, detail} with detail in plain English, without the host
 * (checkHost puts it in front): "points at us ✓", "still points at 1.2.3.4 (their old host)", "doesn't exist in DNS".
 */
export function dnsVerdict({ cname, a } = {}, pagesHost) {
  const chain = names(cname);
  const addrs = names(a);
  const pages = normaliseHost(pagesHost);
  if (pages && chain.includes(pages)) return { ok: true, detail: "points at us ✓" };
  if (addrs.length && addrs.every(inCloudflare)) return { ok: true, detail: "points at us ✓" };
  if (addrs.length) {
    const old = addrs.filter((ip) => !inCloudflare(ip)).map(shown).filter(Boolean).slice(0, 3);
    return { ok: false, detail: `still points at ${old.length ? old.join(", ") : "somewhere else"} (their old host)` };
  }
  if (chain.length) return { ok: false, detail: `still points at ${shown(chain[chain.length - 1]) || "somewhere else"} (their old host)` };
  return { ok: false, detail: "doesn't exist in DNS" };
}

/** True when there are nameservers and every one is *.ns.cloudflare.com (the domain's DNS is now at Cloudflare). */
export function nsIsCloudflare(ns) {
  const list = names(ns);
  return list.length > 0 && list.every((n) => /^[a-z0-9-]+\.ns\.cloudflare\.com$/.test(n));
}
