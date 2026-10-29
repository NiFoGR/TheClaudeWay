// Client-site hosts and their DNS (stage 10, Task 6): which Host headers are ours, the canonical www host of a typed
// domain, Cloudflare's IPv4 ranges, the DNS verdict in plain English, and the DNS-over-HTTPS checks behind it. Fake
// fetches stand in for Cloudflare's DoH, so nothing here touches the network.
// Run: node --test control-room/tests/sites-hosts.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  CF_IPV4, OUR_HOSTS, canonicalHost, dnsVerdict, inCloudflare, isOurHost, normaliseHost, nsIsCloudflare, underOurDomain, wwwTwin,
} from "../functions/_lib/sites/hosts.js";
import { checkHost, checkNs } from "../functions/_lib/sites/dns.js";

const PAGES = "goldbarwebsites.pages.dev";
const BAD_DOMAIN = "That doesn't look like a web address. Type it like smithroofing.co.uk.";
const DNS_DOWN = "Couldn't check DNS just now: will try again.";

// A fake DoH: `answers` maps "name|TYPE" to the JSON body (a missing key is an empty answer). Every call is kept.
function fakeDoh(answers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(String(url));
    const body = answers[`${u.searchParams.get("name")}|${u.searchParams.get("type")}`] ?? { Status: 0 };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/dns-json" } });
  };
  return { calls, fetchImpl };
}

test("normaliseHost lower-cases and drops the port and the trailing dot", () => {
  assert.equal(normaliseHost("WWW.Smith.co.uk.:443"), "www.smith.co.uk");
  assert.equal(normaliseHost("  smith.co.uk:8788 "), "smith.co.uk");
  assert.equal(normaliseHost("smith.co.uk.."), "smith.co.uk");
  assert.equal(normaliseHost("xn--bcher-kva.de"), "xn--bcher-kva.de");
  assert.equal(normaliseHost("bücher.de"), "xn--bcher-kva.de");
  assert.equal(normaliseHost(""), "");
  assert.equal(normaliseHost(undefined), "");
  assert.equal(normaliseHost(null), "");
});

test("isOurHost: the root domain, www, localhost, 127.0.0.1 and any *.pages.dev; nothing else", () => {
  assert.deepEqual([...OUR_HOSTS].sort(), ["127.0.0.1", "aetoswebsites.com", "localhost", "www.aetoswebsites.com"]);
  assert.equal(isOurHost("goldbarwebsites.pages.dev"), true);
  assert.equal(isOurHost("abc.goldbarwebsites.pages.dev"), true);
  assert.equal(isOurHost("localhost"), true);
  assert.equal(isOurHost("aetoswebsites.com"), true);
  assert.equal(isOurHost("www.aetoswebsites.com"), true);
  assert.equal(isOurHost("127.0.0.1"), true);
  assert.equal(isOurHost("WWW.AetosWebsites.com.:443"), true, "an odd Host header is normalised first");
  assert.equal(isOurHost("localhost:8788"), true);
  // Both go through the client_sites lookup (no row → the Control Room as today).
  assert.equal(isOurHost("site-test.aetoswebsites.com"), false);
  assert.equal(isOurHost("control.aetoswebsites.com"), false);
  for (const h of ["aetoswebsites.com", "www.aetoswebsites.com", "control.aetoswebsites.com", "WWW.Control.AetosWebsites.com.", "site-test.aetoswebsites.com"]) {
    assert.equal(underOurDomain(h), true, h);
  }
  for (const h of ["myaetoswebsites.com", "www.smithroofing.co.uk", "aetoswebsites.com.evil.co.uk", "", null]) {
    assert.equal(underOurDomain(h), false, String(h));
  }
  assert.equal(isOurHost("www.smith.co.uk"), false);
  assert.equal(isOurHost("pages.dev"), false);
  assert.equal(isOurHost("evilpages.dev"), false);
  assert.equal(isOurHost("aetoswebsites.com.evil.co.uk"), false);
  assert.equal(isOurHost(""), false);
});

test("wwwTwin adds www. and takes it away", () => {
  assert.equal(wwwTwin("smith.co.uk"), "www.smith.co.uk");
  assert.equal(wwwTwin("www.smith.co.uk"), "smith.co.uk");
  assert.equal(wwwTwin(wwwTwin("smith.co.uk")), "smith.co.uk");
  assert.equal(wwwTwin("WWW.Smith.co.uk."), "smith.co.uk");
  assert.equal(wwwTwin(""), "");
});

test("canonicalHost: www.<domain> from whatever the client typed", () => {
  assert.deepEqual(canonicalHost(" https://Smith.co.uk/ "), { ok: true, host: "www.smith.co.uk", domain: "smith.co.uk" });
  assert.deepEqual(canonicalHost("www.smith.co.uk"), { ok: true, host: "www.smith.co.uk", domain: "smith.co.uk" });
  assert.deepEqual(canonicalHost("http://www.Smith.co.uk:80/contact?x=1#top"), { ok: true, host: "www.smith.co.uk", domain: "smith.co.uk" });
  assert.deepEqual(canonicalHost("smithroofing.co.uk."), { ok: true, host: "www.smithroofing.co.uk", domain: "smithroofing.co.uk" });
  assert.equal(canonicalHost("bücher.de").host, "www.xn--bcher-kva.de");
  assert.equal(canonicalHost("bücher.de").domain, "xn--bcher-kva.de");
  assert.deepEqual(canonicalHost("smith"), { ok: false, error: BAD_DOMAIN });
  for (const bad of ["", "   ", "www.", "smith .co.uk", "you@smith.co.uk", "smith.c", "-smith.co.uk", "smith..co.uk",
    "1.2.3.4", "smith_roofing.co.uk", "smith.co.uk/ page", null, undefined, 42]) {
    assert.deepEqual(canonicalHost(bad), { ok: false, error: BAD_DOMAIN }, `refuses ${JSON.stringify(bad)}`);
  }
});

test("CF_IPV4 is Cloudflare's 15 published IPv4 ranges; inCloudflare matches them", () => {
  assert.equal(CF_IPV4.length, 15);
  for (const cidr of CF_IPV4) assert.match(cidr, /^\d+\.\d+\.\d+\.\d+\/\d+$/);
  assert.ok(CF_IPV4.includes("104.16.0.0/13") && CF_IPV4.includes("172.64.0.0/13") && CF_IPV4.includes("131.0.72.0/22"));
  assert.equal(inCloudflare("104.21.3.4"), true);
  assert.equal(inCloudflare("172.67.1.1"), true);
  assert.equal(inCloudflare("188.114.97.3"), true);
  assert.equal(inCloudflare("104.23.255.255"), true, "last address of 104.16.0.0/13");
  assert.equal(inCloudflare("104.15.255.255"), false, "just before 104.16.0.0/13");
  assert.equal(inCloudflare("1.2.3.4"), false);
  assert.equal(inCloudflare("8.8.8.8"), false);
  for (const bad of ["", "104.21.3", "104.21.3.256", "104.21.3.4.5", "abc", "2606:4700::1", null, undefined]) {
    assert.equal(inCloudflare(bad), false, `not an IPv4 address: ${JSON.stringify(bad)}`);
  }
});

test("dnsVerdict: a CNAME to the Pages host or every A in Cloudflare points at us", () => {
  assert.equal(dnsVerdict({ cname: ["goldbarwebsites.pages.dev."], a: [] }, PAGES).ok, true);
  assert.equal(dnsVerdict({ cname: ["GoldbarWebsites.pages.dev"], a: ["104.21.2.2"] }, PAGES).ok, true);
  assert.equal(dnsVerdict({ cname: [], a: ["172.67.1.1", "104.21.2.2"] }, PAGES).ok, true);
  assert.deepEqual(dnsVerdict({ cname: [], a: ["172.67.1.1", "104.21.2.2"] }, PAGES), { ok: true, detail: "points at us ✓" });
  assert.deepEqual(dnsVerdict({ cname: [], a: ["1.2.3.4"] }, PAGES), { ok: false, detail: "still points at 1.2.3.4 (their old host)" });
  assert.equal(dnsVerdict({ cname: [], a: ["1.2.3.4"] }, PAGES).detail, "still points at 1.2.3.4 (their old host)");
  assert.deepEqual(dnsVerdict({ cname: [], a: ["104.21.2.2", "1.2.3.4"] }, PAGES), { ok: false, detail: "still points at 1.2.3.4 (their old host)" });
  assert.deepEqual(dnsVerdict({ cname: ["oldhost.example.com."], a: [] }, PAGES), { ok: false, detail: "still points at oldhost.example.com (their old host)" });
  assert.deepEqual(dnsVerdict({ cname: [], a: [] }, PAGES), { ok: false, detail: "doesn't exist in DNS" });
  assert.equal(dnsVerdict({}, PAGES).detail, "doesn't exist in DNS");
  assert.equal(dnsVerdict(undefined, PAGES).detail, "doesn't exist in DNS");
  assert.equal(dnsVerdict({ cname: ["abc.goldbarwebsites.pages.dev."], a: ["1.2.3.4"] }, PAGES).ok, false, "a preview alias isn't the Pages host");
  // DNS answers are untrusted: markup or junk is never repeated in the detail, and a long list is cut to 3.
  assert.deepEqual(dnsVerdict({ cname: ["<script>x</script>.evil."], a: [] }, PAGES), { ok: false, detail: "still points at somewhere else (their old host)" });
  assert.equal(dnsVerdict({ cname: [], a: ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"] }, PAGES).detail, "still points at 1.1.1.1, 2.2.2.2, 3.3.3.3 (their old host)");
  assert.equal(dnsVerdict({ cname: [], a: ["<b>1.2.3.4</b>"] }, PAGES).detail, "still points at somewhere else (their old host)");
  assert.equal(dnsVerdict({ cname: ["goldbarwebsites.pages.dev."], a: [] }, "").ok, false, "no Pages host set: the CNAME rule can't match");
});

test("nsIsCloudflare: only when every nameserver is Cloudflare's", () => {
  assert.equal(nsIsCloudflare(["ada.ns.cloudflare.com.", "bob.ns.cloudflare.com."]), true);
  assert.equal(nsIsCloudflare(["ADA.NS.CLOUDFLARE.COM", "bob.ns.cloudflare.com"]), true);
  assert.equal(nsIsCloudflare(["ada.ns.cloudflare.com.", "ns1.123-reg.co.uk."]), false);
  assert.equal(nsIsCloudflare(["ns.cloudflare.com.evil.net."]), false);
  assert.equal(nsIsCloudflare([]), false);
  assert.equal(nsIsCloudflare(undefined), false);
});

test("checkHost asks Cloudflare's DoH for the CNAME, then the A records", async () => {
  const doh = fakeDoh({ "www.smithroofing.co.uk|A": { Answer: [{ data: "1.2.3.4" }] } });
  const r = await checkHost("www.smithroofing.co.uk", PAGES, { fetchImpl: doh.fetchImpl });
  assert.deepEqual(r, { ok: false, detail: "Not yet: www.smithroofing.co.uk still points at 1.2.3.4 (their old host)" });
  assert.equal(doh.calls[0].url, "https://cloudflare-dns.com/dns-query?name=www.smithroofing.co.uk&type=CNAME");
  assert.equal(doh.calls[0].init.headers.accept, "application/dns-json");
  assert.equal(doh.calls[1].url, "https://cloudflare-dns.com/dns-query?name=www.smithroofing.co.uk&type=A");
  assert.equal(doh.calls[1].init.headers.accept, "application/dns-json");
  assert.equal(doh.calls.length, 2);
});

test("checkHost: a CNAME to the Pages host is enough (no A lookup)", async () => {
  const doh = fakeDoh({ "www.smithroofing.co.uk|CNAME": { Status: 0, Answer: [{ type: 5, data: "goldbarwebsites.pages.dev." }] } });
  assert.deepEqual(await checkHost("WWW.SmithRoofing.co.uk.", PAGES, { fetchImpl: doh.fetchImpl }), { ok: true, detail: "www.smithroofing.co.uk points at us ✓" });
  assert.equal(doh.calls.length, 1);
});

test("checkHost: Cloudflare A records (our zone) point at us; a CNAME met in the A answer counts as the chain", async () => {
  const ours = fakeDoh({ "www.smith.co.uk|A": { Status: 0, Answer: [{ type: 1, data: "104.21.3.4" }, { type: 1, data: "172.67.1.1" }] } });
  assert.deepEqual(await checkHost("www.smith.co.uk", PAGES, { fetchImpl: ours.fetchImpl }), { ok: true, detail: "www.smith.co.uk points at us ✓" });
  const chain = fakeDoh({
    "www.smith.co.uk|A": { Status: 0, Answer: [{ type: 5, data: "goldbarwebsites.pages.dev." }, { type: 1, data: "172.66.44.1" }] },
  });
  assert.equal((await checkHost("www.smith.co.uk", PAGES, { fetchImpl: chain.fetchImpl })).ok, true);
});

test("checkHost: no records (or NXDOMAIN) doesn't exist in DNS", async () => {
  const nx = fakeDoh({ "www.smith.co.uk|CNAME": { Status: 3 }, "www.smith.co.uk|A": { Status: 3 } });
  assert.deepEqual(await checkHost("www.smith.co.uk", PAGES, { fetchImpl: nx.fetchImpl }), { ok: false, detail: "Not yet: www.smith.co.uk doesn't exist in DNS" });
});

test("checkHost: a failed lookup says it will try again, never a verdict", async () => {
  const throws = async () => { throw new Error("network down"); };
  assert.deepEqual(await checkHost("www.smithroofing.co.uk", PAGES, { fetchImpl: throws }), { ok: false, detail: DNS_DOWN });
  const http500 = async () => new Response("oops", { status: 500 });
  assert.deepEqual(await checkHost("www.smithroofing.co.uk", PAGES, { fetchImpl: http500 }), { ok: false, detail: DNS_DOWN });
  const servfail = fakeDoh({ "www.smithroofing.co.uk|CNAME": { Status: 2 } });
  assert.deepEqual(await checkHost("www.smithroofing.co.uk", PAGES, { fetchImpl: servfail.fetchImpl }), { ok: false, detail: DNS_DOWN });
  const garbage = async () => new Response("not json", { status: 200 });
  assert.deepEqual(await checkHost("www.smithroofing.co.uk", PAGES, { fetchImpl: garbage }), { ok: false, detail: DNS_DOWN });
});

test("checkNs: true only when the domain answers only Cloudflare nameservers", async () => {
  const cf = fakeDoh({ "smith.co.uk|NS": { Status: 0, Answer: [{ type: 2, data: "ada.ns.cloudflare.com." }, { type: 2, data: "bob.ns.cloudflare.com." }] } });
  assert.equal(await checkNs("Smith.co.uk.", { fetchImpl: cf.fetchImpl }), true);
  assert.equal(cf.calls[0].url, "https://cloudflare-dns.com/dns-query?name=smith.co.uk&type=NS");
  assert.equal(cf.calls[0].init.headers.accept, "application/dns-json");
  const mixed = fakeDoh({ "smith.co.uk|NS": { Status: 0, Answer: [{ data: "ada.ns.cloudflare.com." }, { data: "ns1.123-reg.co.uk." }] } });
  assert.equal(await checkNs("smith.co.uk", { fetchImpl: mixed.fetchImpl }), false);
  const none = fakeDoh({});
  assert.equal(await checkNs("smith.co.uk", { fetchImpl: none.fetchImpl }), false);
  assert.equal(await checkNs("smith.co.uk", { fetchImpl: async () => { throw new Error("down"); } }), false);
});
