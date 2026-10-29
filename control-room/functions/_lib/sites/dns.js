// DNS checks for client-site hosts (stage 10, fetch only): does www.<domain> point at us yet, and has the domain moved
// its nameservers to Cloudflare. Lookups use Cloudflare's DNS-over-HTTPS JSON API (the same DOH_URL as the email DNS
// checks in ../dns.js); the verdicts are pure, in ./hosts.js. Tested in control-room/tests/sites-hosts.test.mjs.
import { DOH_URL } from "../dns.js";
import { dnsVerdict, normaliseHost, nsIsCloudflare } from "./hosts.js";

export const HOST_CHECK_FAILED = "Couldn't check DNS just now: will try again.";

const DOH_TIMEOUT_MS = 5000;
const TYPE = { A: 1, NS: 2, CNAME: 5 };

// One DoH query: its answers as [{type, data}] (NXDOMAIN and an empty answer are []). Throws when there is no answer
// to read (the fetch failed or timed out, an HTTP error, SERVFAIL or another status, a body that isn't JSON).
async function doh(name, type, fetchImpl = fetch) {
  const res = await fetchImpl(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DNS-over-HTTPS answered HTTP ${res.status}`);
  const body = await res.json();
  const status = body?.Status ?? 0;
  if (status === 3) return [];
  if (status !== 0) throw new Error(`DNS lookup status ${status}`);
  const answers = Array.isArray(body?.Answer) ? body.Answer : [];
  return answers.filter((x) => typeof x?.data === "string").map((x) => ({ type: x.type, data: x.data }));
}

const isIpv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s.trim());

/**
 * Whether `host` points at us (a CNAME to `pagesHost`, or only Cloudflare A records): DoH CNAME first, then A when
 * the CNAME isn't ours. {ok, detail}: "www.x.co.uk points at us ✓" / "Not yet: www.x.co.uk still points at 1.2.3.4
 * (their old host)" / "Not yet: www.x.co.uk doesn't exist in DNS"; a lookup that fails is {ok: false, detail:
 * HOST_CHECK_FAILED}, never a verdict.
 */
export async function checkHost(host, pagesHost, { fetchImpl = fetch } = {}) {
  const name = normaliseHost(host);
  const said = (v) => ({ ok: v.ok, detail: v.ok ? `${name} ${v.detail}` : `Not yet: ${name} ${v.detail}` });
  try {
    const cname = (await doh(name, "CNAME", fetchImpl))
      .filter((x) => x.type === undefined || x.type === TYPE.CNAME)
      .map((x) => x.data);
    const first = dnsVerdict({ cname, a: [] }, pagesHost);
    if (first.ok) return said(first);
    // The A answer also carries the CNAME chain the resolver followed (type 5); an answer without a type is read by
    // its shape.
    const a = [];
    for (const x of await doh(name, "A", fetchImpl)) {
      if (x.type === TYPE.A || (x.type === undefined && isIpv4(x.data))) a.push(x.data);
      else if (x.type === TYPE.CNAME || x.type === undefined) cname.push(x.data);
    }
    return said(dnsVerdict({ cname, a }, pagesHost));
  } catch (err) {
    console.error(`DNS check for ${name} failed: ${String(err?.message ?? err).split("\n")[0].slice(0, 200)}`);
    return { ok: false, detail: HOST_CHECK_FAILED };
  }
}

/** True when `domain`'s NS answer is only *.ns.cloudflare.com. false when it isn't, or the lookup fails. */
export async function checkNs(domain, { fetchImpl = fetch } = {}) {
  const name = normaliseHost(domain);
  try {
    const ns = (await doh(name, "NS", fetchImpl))
      .filter((x) => x.type === undefined || x.type === TYPE.NS)
      .map((x) => x.data);
    return nsIsCloudflare(ns);
  } catch (err) {
    console.error(`Nameserver check for ${name} failed: ${String(err?.message ?? err).split("\n")[0].slice(0, 200)}`);
    return false;
  }
}
