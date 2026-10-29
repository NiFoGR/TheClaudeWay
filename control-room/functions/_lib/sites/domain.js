// The domain plan (pure, stage 10: docs/rebuild/09-build.md section 7, exact copy).
//
// Three ways a client's domain gets connected to their site, picked from the onboarding form's `domain` answers:
//   buy          they have no domain: Nik buys one in our Cloudflare account, then adds it to the Pages project.
//   nameservers  they have one and can (or might) log in: the domain moves to Cloudflare (preferred).
//   cname        they have one and can't log in: their DNS stays put, whoever runs it points www at us.
// Each step becomes a `build:<client_id>:domain:<id>` todo and a checkbox on the Site page. `auto` steps are ticked
// by the tick step's DNS check, never by Nik. Every value comes from the form, so it is squeezed onto one line: the
// steps are plain text and are escaped where they are shown.

import { canonicalHost } from "./hosts.js";

export const PAGES_PROJECT = "goldbarwebsites";

// One line, at most 200 characters (a todo title is one line; form text can hold CR/LF or be very long).
// Cut by code point, so an emoji or other astral character at the cut is never split into half a pair.
const line = (s) => Array.from(String(s ?? "").replace(/\s+/g, " ").trim()).slice(0, 200).join("").trim();

// The bare domain as hosts are stored and matched (lower-case punycode, no scheme, path or www.), so the steps name
// exactly the host the client_sites row and the DNS check use. Input that isn't a domain is shown as typed.
function bareDomain(raw) {
  const c = canonicalHost(line(raw));
  return c.ok ? c.domain : line(raw).toLowerCase().replace(/^www\./, "");
}

/** "buy" | "nameservers" | "cname" from the form's `domain` object. Can log in "yes" or "not_sure" → nameservers. */
export function domainMode(formDomain) {
  const d = formDomain && typeof formDomain === "object" ? formDomain : {};
  if (d.has !== "yes") return "buy";
  return d.can_login === "no" ? "cname" : "nameservers";
}

// The Pages project and its address: either one gives the other (goldbarwebsites ↔ goldbarwebsites.pages.dev).
function pagesNames(project, pagesHost) {
  const host = line(pagesHost).toLowerCase().replace(/\.$/, "");
  const fromHost = /^([a-z0-9-]+)\.pages\.dev$/.exec(host)?.[1];
  const proj = line(project) || fromHost || PAGES_PROJECT;
  return { project: proj, pagesHost: host || `${proj}.pages.dev` };
}

/**
 * The steps for one client's domain, in order: [{id, title, detail, auto}].
 * `domain` is the bare domain (e.g. smithroofing.co.uk); empty while a domain is still to be bought.
 */
export function domainSteps({
  mode, name, domain, registrar, choices, legalLine, address, email, emailOnIt, project, pagesHost,
} = {}) {
  const biz = line(name) || "the client";
  const dom = bareDomain(domain);
  // Empty only while a domain is still to be bought (or, in the other modes, before the form names it).
  const none = mode === "buy" ? "the new domain" : "their domain";
  const d = dom || none;
  const www = dom ? `www.${dom}` : `www. plus ${none}`;
  const p = pagesNames(project, pagesHost);
  const step = (id, title, detail, auto = false) => ({ id, title, detail, auto });

  const pages = step("pages", `Connect ${d} to ${biz}'s website`,
    `Cloudflare dashboard → Workers & Pages → ${p.project} → Custom domains → Set up a custom domain → type ${www} → `
    + `Continue → Activate domain. Do the same for ${d} (without www). The domain is in our Cloudflare account, so the `
    + `DNS records are added for you. If Cloudflare says a record already exists for www, delete that record in the `
    + `domain's DNS page first, then try again.`);

  if (mode === "buy") {
    const picks = (Array.isArray(choices) ? choices : []).map(line).filter(Boolean);
    const registrant = [legalLine, address, email].map(line).filter(Boolean).join(", ") || "their own details";
    return [
      step("buy", `Buy a domain for ${biz}${picks.length ? ` (their picks: ${picks.join(", ")})` : ""}`,
        `Cloudflare dashboard → Domain Registration → Register Domains. Search their picks in order and buy the first `
        + `one that's free (1 year, auto-renew on). On the contact details step put the registrant as ${registrant}, `
        + `so it's theirs. Then type the domain on ${biz}'s Site page. None free? Email ${biz} for 3 more names.`),
      pages,
    ];
  }

  if (mode === "nameservers") {
    const mx = line(emailOnIt) !== "no"
      ? " They use email on this domain: check the list has MX records (and the TXT records that start v=spf1) before "
        + "you continue, or their email will stop."
      : "";
    const reg = line(registrar) || "the company they bought the domain from";
    return [
      step("zone", `Add ${d} to Cloudflare`,
        `Cloudflare dashboard → Add a domain → type ${d} → Quick scan for DNS records → Free plan → Continue.${mx} `
        + `Cloudflare then shows two nameservers: paste them on ${biz}'s Site page.`),
      step("ns_email", `Send ${biz} the nameserver steps`,
        `Once the two nameservers are on ${biz}'s Site page, press Send there. It emails ${biz} how to put them in at `
        + `${reg}; you can edit the email first.`),
      step("ns_wait", `Wait for ${d} to switch to Cloudflare`,
        `This ticks itself when ${d}'s nameservers are Cloudflare's. It can take a few hours after ${biz} saves the `
        + `change.`, true),
      pages,
    ];
  }

  if (mode === "cname") {
    const reg = line(registrar) || "whoever looks after their domain";
    return [
      step("pages_cname", `Add ${www} to the Pages project`,
        `Cloudflare dashboard → Workers & Pages → ${p.project} → Custom domains → Set up a custom domain → ${www} → `
        + `Continue. Cloudflare shows a CNAME to add: www → ${p.pagesHost}. Leave it waiting; it activates by itself `
        + `once the record exists.`),
      step("cname_email", `Send ${biz} the www steps`,
        `Press Send on ${biz}'s Site page. It emails ${biz} the two changes for ${reg} to make: a CNAME record www → `
        + `${p.pagesHost}, and forwarding ${d} to https://${www}. You can edit the email first.`),
    ];
  }

  return [];
}
