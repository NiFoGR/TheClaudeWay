// The domain plan: which way a client's domain gets connected, and the exact click-by-click steps Nik follows
// (stage 10, Task 10; 09-build.md section 7). Run: node --test control-room/tests/sites-domain.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { domainMode, domainSteps } from "../functions/_lib/sites/domain.js";

const BASE = {
  name: "Smith Roofing", domain: "smithroofing.co.uk", registrar: "GoDaddy",
  choices: ["a.co.uk", "b.co.uk", "c.co.uk"], legalLine: "John Smith trading as Smith Roofing",
  address: "1 High St, Swindon SN1 1AA", email: "john@smithroofing.co.uk", emailOnIt: "yes",
  project: "goldbarwebsites", pagesHost: "goldbarwebsites.pages.dev",
};
const steps = (mode, extra = {}) => domainSteps({ ...BASE, mode, ...extra });
const byId = (list, id) => list.find((s) => s.id === id);
const ids = (list) => list.map((s) => s.id);

test("domainMode: no domain → buy; can log in (yes or not sure) → nameservers; can't log in → cname", () => {
  assert.equal(domainMode({ has: "no" }), "buy");
  assert.equal(domainMode({ has: "yes", can_login: "yes" }), "nameservers");
  assert.equal(domainMode({ has: "yes", can_login: "not_sure" }), "nameservers");
  assert.equal(domainMode({ has: "yes", can_login: "no" }), "cname");
});

test("each mode has its steps in order; only ns_wait ticks itself", () => {
  assert.deepEqual(ids(steps("buy")), ["buy", "pages"]);
  const ns = steps("nameservers");
  assert.deepEqual(ids(ns), ["zone", "ns_email", "ns_wait", "pages"]);
  assert.equal(byId(ns, "ns_wait").auto, true);
  for (const s of ns.filter((x) => x.id !== "ns_wait")) assert.equal(s.auto, false, s.id);
  assert.deepEqual(ids(steps("cname")), ["pages_cname", "cname_email"]);
  for (const mode of ["buy", "nameservers", "cname"]) {
    for (const s of steps(mode)) {
      assert.deepEqual(Object.keys(s).sort(), ["auto", "detail", "id", "title"], `${mode}/${s.id}`);
      assert.ok(s.title && s.detail, `${mode}/${s.id} has copy`);
    }
  }
});

test("buy step names their picks and the registrant details", () => {
  const buy = byId(steps("buy"), "buy");
  assert.equal(buy.title, "Buy a domain for Smith Roofing (their picks: a.co.uk, b.co.uk, c.co.uk)");
  assert.equal(buy.detail,
    "Cloudflare dashboard → Domain Registration → Register Domains. Search their picks in order and buy the first one "
    + "that's free (1 year, auto-renew on). On the contact details step put the registrant as John Smith trading as "
    + "Smith Roofing, 1 High St, Swindon SN1 1AA, john@smithroofing.co.uk, so it's theirs. Then type the domain on "
    + "Smith Roofing's Site page. None free? Email Smith Roofing for 3 more names.");
  // Empty picks are left out, not shown as ", ,".
  assert.equal(byId(steps("buy", { choices: ["a.co.uk", "", " "] }), "buy").title,
    "Buy a domain for Smith Roofing (their picks: a.co.uk)");
});

test("pages step: the Pages project's custom domains, www and the bare domain", () => {
  const pages = byId(steps("buy"), "pages");
  assert.equal(pages.title, "Connect smithroofing.co.uk to Smith Roofing's website");
  assert.ok(pages.detail.includes("Workers & Pages → goldbarwebsites → Custom domains"));
  assert.ok(pages.detail.includes("www.smithroofing.co.uk"));
  assert.equal(pages.detail,
    "Cloudflare dashboard → Workers & Pages → goldbarwebsites → Custom domains → Set up a custom domain → type "
    + "www.smithroofing.co.uk → Continue → Activate domain. Do the same for smithroofing.co.uk (without www). The "
    + "domain is in our Cloudflare account, so the DNS records are added for you. If Cloudflare says a record already "
    + "exists for www, delete that record in the domain's DNS page first, then try again.");
  assert.deepEqual(byId(steps("nameservers"), "pages"), pages);
});

test("zone step warns about MX records only when they (may) use email on the domain", () => {
  const zone = (emailOnIt) => byId(steps("nameservers", { emailOnIt }), "zone");
  assert.equal(zone("yes").title, "Add smithroofing.co.uk to Cloudflare");
  assert.ok(zone("yes").detail.includes("MX records"));
  assert.ok(zone("not_sure").detail.includes("MX records"));
  assert.ok(!zone("no").detail.includes("MX records"));
  assert.equal(zone("no").detail,
    "Cloudflare dashboard → Add a domain → type smithroofing.co.uk → Quick scan for DNS records → Free plan → "
    + "Continue. Cloudflare then shows two nameservers: paste them on Smith Roofing's Site page.");
  assert.equal(zone("yes").detail,
    "Cloudflare dashboard → Add a domain → type smithroofing.co.uk → Quick scan for DNS records → Free plan → "
    + "Continue. They use email on this domain: check the list has MX records (and the TXT records that start v=spf1) "
    + "before you continue, or their email will stop. Cloudflare then shows two nameservers: paste them on Smith "
    + "Roofing's Site page.");
});

test("email steps and the CNAME step", () => {
  assert.equal(byId(steps("nameservers"), "ns_email").title, "Send Smith Roofing the nameserver steps");
  assert.equal(byId(steps("cname"), "cname_email").title, "Send Smith Roofing the www steps");
  const pc = byId(steps("cname"), "pages_cname");
  assert.equal(pc.title, "Add www.smithroofing.co.uk to the Pages project");
  assert.ok(pc.detail.includes("www → goldbarwebsites.pages.dev"));
  assert.equal(pc.detail,
    "Cloudflare dashboard → Workers & Pages → goldbarwebsites → Custom domains → Set up a custom domain → "
    + "www.smithroofing.co.uk → Continue. Cloudflare shows a CNAME to add: www → goldbarwebsites.pages.dev. Leave it "
    + "waiting; it activates by itself once the record exists.");
});

test("form text can't break a step onto new lines", () => {
  const buy = byId(steps("buy", { name: "Smith\r\nRoofing" }), "buy");
  assert.ok(!/[\r\n]/.test(buy.title));
  assert.ok(buy.title.startsWith("Buy a domain for Smith Roofing "));
});

test("edge cases: unknown mode, missing form, email answer missing, typed URLs and IDN domains", () => {
  assert.deepEqual(domainSteps({ ...BASE, mode: "other" }), []);
  assert.deepEqual(domainSteps(), []);
  assert.equal(domainMode(undefined), "buy");
  assert.equal(domainMode(null), "buy");
  assert.equal(domainMode({ has: "not_sure" }), "buy");
  // No answer to "do you use email on it?" is treated as yes: the MX check is the safe side.
  assert.ok(byId(steps("nameservers", { emailOnIt: undefined }), "zone").detail.includes("MX records"));
  // The domain as typed in the form is shown as the host we store and check.
  const typed = byId(steps("buy", { domain: " https://WWW.SmithRoofing.co.uk/ " }), "pages");
  assert.equal(typed.title, "Connect smithroofing.co.uk to Smith Roofing's website");
  assert.ok(typed.detail.includes("type www.smithroofing.co.uk → Continue"));
  assert.ok(byId(steps("cname", { domain: "bücher.de" }), "pages_cname").title.includes("www.xn--bcher-kva.de"));
  // Before a domain is bought the steps say so; in the other modes it's "their domain", never "the new domain".
  assert.equal(byId(steps("buy", { domain: "" }), "pages").title, "Connect the new domain to Smith Roofing's website");
  assert.equal(byId(steps("nameservers", { domain: "" }), "zone").title, "Add their domain to Cloudflare");
  // The project and the pages.dev address each fill in the other.
  assert.ok(byId(steps("cname", { project: "", pagesHost: "other.pages.dev" }), "pages_cname").detail
    .includes("Workers & Pages → other → Custom domains"));
  assert.ok(byId(steps("cname", { project: "proj", pagesHost: "" }), "pages_cname").detail
    .includes("www → proj.pages.dev"));
  // Registrar fallbacks and a very long name are kept to one short line.
  assert.ok(byId(steps("nameservers", { registrar: "" }), "ns_email").detail
    .includes("the company they bought the domain from"));
  assert.ok(byId(steps("buy", { name: "x".repeat(500) }), "buy").title.length < 260);
});
