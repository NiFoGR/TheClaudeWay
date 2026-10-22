// GET /api/setup/dns?domain=<domain> → {domain, at, ok, checks, mx_note}: check a mailbox domain's email records
// (Setup → DNS for <domain> → Check again). Five DNS-over-HTTPS lookups, side by side (root TXT for SPF,
// privateemail._domainkey for DKIM, or default._domainkey for subscriptions bought before 2 June 2026, _dmarc for
// DMARC, and MX), judged by dnsVerdicts. The verdicts are cached as dns:last:<domain>
// ({at, ok, checks, mx_note}), which the Setup status and the health step's dns:<domain> gap read. A lookup that
// doesn't answer is a 502 with the plain-English text, and the last good check is kept.
import { DKIM_LEGACY_SELECTOR, DKIM_SELECTOR, DnsLookupError, dnsVerdicts, dohMx, dohTxt } from "../../_lib/dns.js";
import { getSetting, setSetting } from "../../_lib/settings.js";
import { bad, db, json, now } from "../../_lib/util.js";

const DOMAIN_ERROR = "Say which domain to check: the part of your mailbox address after the @, e.g. aetoswebsites.com.";
// A host name with at least two labels, each 1–63 letters, digits or hyphens (not at either end), 253 at most.
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The domain lower-cased, without a trailing dot, or null when it isn't a domain name. */
export function domainOrNull(value) {
  const d = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
  return DOMAIN_RE.test(d) ? d : null;
}

export async function onRequestGet({ request, env }) {
  const domain = domainOrNull(new URL(request.url).searchParams.get("domain"));
  if (!domain) return bad(DOMAIN_ERROR);
  const DB = await db(env);
  const opts = { fetchImpl: env.__fetch }; // tests only; undefined live, so the lookups use fetch

  let records;
  try {
    const [root, dkim, dkimLegacy, dmarc, mx] = await Promise.all([
      dohTxt(domain, opts),
      dohTxt(`${DKIM_SELECTOR}.${domain}`, opts),
      dohTxt(`${DKIM_LEGACY_SELECTOR}.${domain}`, opts),
      dohTxt(`_dmarc.${domain}`, opts),
      dohMx(domain, opts),
    ]);
    records = { root, dkim, dkimLegacy, dmarc, mx };
  } catch (err) {
    if (err instanceof DnsLookupError) return bad(err.message, 502);
    throw err;
  }

  const contactEmail = await getSetting(DB, "site:contact_email");
  const { ok, checks, mx_note } = dnsVerdicts({ domain, ...records, contactEmail });
  const at = now();
  await setSetting(DB, `dns:last:${domain}`, JSON.stringify({ at, ok, checks, mx_note }));
  return json({ domain, at, ok, checks, mx_note });
}
