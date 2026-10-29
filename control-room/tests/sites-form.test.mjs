// Onboarding form: defaults, validation and the pages (stage 10, Task 11).
// Run: node --test control-room/tests/sites-form.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  FORM_ERRORS, formDefaults, normaliseForm, onboardFirst, renderBadToken, renderOnboard, renderOnboardDone, validateForm,
} from "../functions/_lib/sites/form.js";

const TOKEN = "t".repeat(32);
const LEAD = { place_id: "p1", name: "SMITH ROOFING LTD", phone: "01793 123456", address: "1 High St, Swindon SN1 1AA", town: "Swindon" };
const RESEARCH = {
  best_email: "mark@smithroofing.co.uk",
  owner: JSON.stringify({ first: "Mark", full: "Mark Smith", confident: true }),
  copy: JSON.stringify({ services: ["Roof repairs", "Flat roofs"], areas: ["Swindon", "Wroughton"], about: "Family firm." }),
};

const SECTION4 = {
  "business.name": "Please add your business name.",
  "business.phone": "Please add a UK phone number customers can call.",
  "business.email": "Please add an email for customers.",
  "business.show_address": "Please choose whether to show your address.",
  "business.legal_line": "Please add your name for the footer.",
  "business.leads_email": "Please add an email for website enquiries.",
  services: "Please tick at least one service.",
  areas: "Please add at least one town or area.",
  "domain.has": "Please tell us about your web address.",
  "gbp.has": "Please tell us about your Google listing.",
  free_quotes: "Please choose free quotes yes or no.",
  emergency: "Please choose emergency call-outs yes or no.",
};

function goodForm() {
  const f = formDefaults({ lead: { ...LEAD, director_name: "Mark Smith" }, research: RESEARCH });
  f.business.show_address = "no";
  f.free_quotes = "yes";
  f.emergency = "no";
  f.domain.has = "yes";
  f.domain.name = "smithroofing.co.uk";
  f.domain.can_login = "yes";
  f.domain.email_on_it = "not_sure";
  f.gbp.has = "yes";
  return f;
}

test("formDefaults prefills from the lead and research (section 4 JSON, exact keys)", () => {
  const f = formDefaults({ lead: { ...LEAD, director_name: "John Smith" }, research: RESEARCH, client: { id: "c1" } });
  assert.deepEqual(Object.keys(f), ["business", "services", "free_quotes", "emergency", "hours", "started", "accreditations",
    "guarantee", "areas", "about", "photos_note", "domain", "gbp", "review_link", "notes"]);
  assert.deepEqual(Object.keys(f.business), ["name", "phone", "email", "address", "show_address", "legal_line", "leads_email"]);
  assert.deepEqual(Object.keys(f.domain), ["has", "name", "registrar", "can_login", "email_on_it", "choices"]);
  assert.deepEqual(Object.keys(f.gbp), ["has", "invite_sent"]);
  assert.deepEqual(f.services, [{ name: "Roof repairs", on: true, own: false }, { name: "Flat roofs", on: true, own: false }]);
  assert.deepEqual(f.areas, ["Swindon", "Wroughton"]);
  assert.equal(f.business.name, "Smith Roofing");
  assert.equal(f.business.phone, "01793 123456");
  assert.equal(f.business.email, "mark@smithroofing.co.uk");
  assert.equal(f.business.leads_email, "mark@smithroofing.co.uk");
  assert.equal(f.business.address, "1 High St, Swindon SN1 1AA");
  assert.equal(f.business.show_address, "");
  assert.equal(f.business.legal_line, "John Smith trading as Smith Roofing");
  assert.equal(f.about, "Family firm.");
  assert.deepEqual(f.domain.choices, ["", "", ""]);
  assert.equal(f.gbp.invite_sent, false);
  assert.equal(f.free_quotes, "");
  assert.equal(f.emergency, "");
});

test("formDefaults: company number gives the Ltd line; nothing known gives an empty one", () => {
  const ltd = formDefaults({ lead: { ...LEAD, company_number: "01234567" }, research: RESEARCH });
  assert.equal(ltd.business.legal_line, "Smith Roofing Ltd, company no. 01234567");
  // A company number means it's a company: the Ltd line wins over "trading as".
  const both = formDefaults({ lead: { ...LEAD, company_number: "01234567", director_name: "John Smith" }, research: RESEARCH });
  assert.equal(both.business.legal_line, "Smith Roofing Ltd, company no. 01234567");
  assert.equal(formDefaults({ lead: LEAD, research: RESEARCH }).business.legal_line, "");
  // A single guessed first name isn't a legal name.
  assert.equal(formDefaults({ lead: { ...LEAD, director_name: "Mark" } }).business.legal_line, "");
});

test("formDefaults copes with nothing, parsed research objects and a client name", () => {
  const f = formDefaults({});
  assert.equal(f.business.name, "");
  assert.deepEqual(f.services, []);
  assert.deepEqual(f.areas, []);
  const g = formDefaults({ client: { name: "Jones Plumbing" }, lead: { town: "Bath" }, research: { copy: { services: ["Boilers", " ", 5] } } });
  assert.equal(g.business.name, "Jones Plumbing");
  assert.deepEqual(g.services, [{ name: "Boilers", on: true, own: false }]);
  assert.deepEqual(g.areas, ["Bath"]);
});

test("onboardFirst: the owner's first name only when confident", () => {
  assert.equal(onboardFirst(RESEARCH), "Mark");
  assert.equal(onboardFirst({ owner: { first: "Mark", confident: false } }), null);
  assert.equal(onboardFirst({ owner: "not json" }), null);
  assert.equal(onboardFirst(null), null);
});

test("validateForm on an empty form returns every section 4 message under its field key", () => {
  for (const empty of [{}, null, formDefaults({})]) {
    const r = validateForm(empty, { package: "full" });
    assert.equal(r.ok, false);
    for (const [key, msg] of Object.entries(SECTION4)) assert.equal(r.errors[key], msg, key);
    assert.equal(r.errors["business.phone"], "Please add a UK phone number customers can call.");
    assert.equal(r.errors.review_link, undefined);
  }
  assert.equal(FORM_ERRORS.summary, "A few things to fix before we can start:");
});

test("validateForm: a complete form passes; Website Only needs no gbp", () => {
  assert.deepEqual(validateForm(goodForm(), { package: "full" }), { ok: true, errors: {} });
  assert.deepEqual(validateForm(goodForm(), { package: "weekend" }), { ok: true, errors: {} });
  const w = goodForm();
  w.gbp = { has: "", invite_sent: false };
  w.review_link = "https://bit.ly/x";
  assert.deepEqual(validateForm(w, { package: "website" }), { ok: true, errors: {} });
  assert.equal(validateForm(w, { package: "full" }).errors["gbp.has"], "Please tell us about your Google listing.");
});

test("validateForm: web address, names, review link, areas, phone and emails", () => {
  const f = goodForm();
  f.domain.name = "smith";
  assert.equal(validateForm(f, { package: "full" }).errors["domain.name"], "That doesn't look like a web address. Type it like smithroofing.co.uk.");
  f.domain.name = "";
  assert.equal(validateForm(f, { package: "full" }).errors["domain.name"], "That doesn't look like a web address. Type it like smithroofing.co.uk.");
  // Our own domain (or any host under it) is never theirs: the Control Room lives on control.aetoswebsites.com.
  const OURS = "That's our web address, not yours. Type your own, like smithroofing.co.uk.";
  for (const ours of ["control.aetoswebsites.com", "https://www.control.aetoswebsites.com/login", "AetosWebsites.com",
    "www.aetoswebsites.com", "site-test.aetoswebsites.com"]) {
    f.domain.name = ours;
    assert.equal(validateForm(f, { package: "full" }).errors["domain.name"], OURS, ours);
  }
  f.domain.name = "myaetoswebsites.com"; // only the same letters at the end: theirs
  assert.equal(validateForm(f, { package: "full" }).errors["domain.name"], undefined);
  f.domain.name = "https://www.SmithRoofing.co.uk/";
  assert.equal(validateForm(f, { package: "full" }).ok, true);
  f.domain.can_login = "";
  f.domain.email_on_it = "maybe";
  const dom = validateForm(f, { package: "full" }).errors;
  assert.equal(dom["domain.can_login"], "Please choose whether you can log in to it.");
  assert.equal(dom["domain.email_on_it"], "Please choose whether you use email on it.");

  const n = goodForm();
  n.domain = { has: "no", name: "", registrar: "", can_login: "", email_on_it: "", choices: ["", "smithroofing.co.uk", ""] };
  assert.equal(validateForm(n, { package: "full" }).errors["domain.choices"], "Please give us at least one name you'd like.");
  n.domain.choices[0] = "smithroofing.co.uk";
  assert.equal(validateForm(n, { package: "full" }).ok, true);

  const r = goodForm();
  r.review_link = "https://bit.ly/x";
  assert.equal(validateForm(r, { package: "full" }).errors.review_link, "That review link isn't a Google link. Leave it empty and we'll find it.");
  r.review_link = "https://g.page/r/abc/review";
  assert.equal(validateForm(r, { package: "full" }).ok, true);

  const a = goodForm();
  a.areas = Array.from({ length: 21 }, (_, i) => `Town ${i}`);
  assert.equal(validateForm(a, { package: "full" }).errors.areas, "Please keep it to 20 towns or areas.");
  a.areas = a.areas.slice(0, 20);
  assert.equal(validateForm(a, { package: "full" }).ok, true);
  a.areas = ["  ", ""];
  assert.equal(validateForm(a, { package: "full" }).errors.areas, "Please add at least one town or area.");

  const p = goodForm();
  p.business.phone = "+1 212 555 0100";
  p.business.email = "not an email";
  p.business.leads_email = "x@";
  p.services = [{ name: "Roof repairs", on: false, own: false }, { name: " ", on: true, own: true }];
  const e = validateForm(p, { package: "full" }).errors;
  assert.equal(e["business.phone"], "Please add a UK phone number customers can call.");
  assert.equal(e["business.email"], "Please add an email for customers.");
  assert.equal(e["business.leads_email"], "Please add an email for website enquiries.");
  assert.equal(e.services, "Please tick at least one service.");
});

test("validateForm: optional fields have limits", () => {
  const f = goodForm();
  const now = new Date("2026-10-28T12:00:00Z");
  f.started = "2008";
  assert.equal(validateForm(f, { package: "full", now }).ok, true);
  for (const bad of ["1949", "2027", "08", "two thousand"]) {
    f.started = bad;
    assert.equal(validateForm(f, { package: "full", now }).errors.started, "Please type the year you started as 4 digits, between 1950 and 2026.", bad);
  }
  f.started = "";
  f.about = "x".repeat(1500);
  f.notes = "y".repeat(2000);
  assert.equal(validateForm(f, { package: "full", now }).ok, true);
  f.about += "x";
  f.notes += "y";
  const e = validateForm(f, { package: "full", now }).errors;
  assert.equal(e.about, "Please keep your About text to 1,500 characters.");
  assert.equal(e.notes, "Please keep this to 2,000 characters.");
});

test("normaliseForm gives the exact shape whatever was posted", () => {
  const n = normaliseForm({ business: { name: 5, phone: "x", extra: "y" }, services: [{ name: "A", on: 1 }, "junk"], areas: ["A", 3, "B"],
    domain: { has: "yes", choices: ["a"] }, gbp: { has: "no", invite_sent: "true" }, hacker: 1 });
  assert.deepEqual(Object.keys(n), Object.keys(formDefaults({})));
  assert.equal(n.business.name, "");
  assert.equal(n.business.extra, undefined);
  assert.deepEqual(n.services, [{ name: "A", on: true, own: false }]);
  assert.deepEqual(n.areas, ["A", "B"]);
  assert.deepEqual(n.domain.choices, ["a", "", ""]);
  assert.equal(n.gbp.invite_sent, false);
  assert.equal(n.hacker, undefined);
});

test("renderOnboard: every heading, GBP steps, Send button, escaping, noindex and the autosave script", () => {
  const form = goodForm();
  form.business.name = "<b>x";
  form.services.push({ name: "<img src=x onerror=alert(1)>", on: true, own: true });
  form.areas.push("</script><script>alert(1)</script>");
  const html = renderOnboard({ token: TOKEN, form, first: "Mark", package: "full", gbpEmail: "nik@aetoswebsites.com",
    now: new Date("2026-10-24T22:30:00Z") });
  for (const heading of ["Your details on the website", "What you do", "Where you work", "About you", "Photos",
    "Your web address", "Google Business Profile", "Reviews", "Anything else?"]) {
    assert.ok(html.includes(`>${heading}</h2>`), heading);
  }
  assert.ok(html.includes("Your website, live in 7 days"));
  assert.ok(html.includes("Hi Mark, this takes about 10 minutes. Your answers save as you go, so you can stop and come back. Your 7 days start when you press Send at the bottom."));
  assert.ok(html.includes("Type <strong>nik@aetoswebsites.com</strong>, choose <strong>Manager</strong>, and tap <strong>Invite</strong>."));
  assert.ok(html.includes("Tap \"People and access\", then the \"+\" (Add) button.") || html.includes("Tap &quot;People and access&quot;, then the &quot;+&quot; (Add) button."));
  assert.ok(html.includes("That's it: we'll accept the invite and get to work. You stay the owner."));
  assert.ok(html.includes("I've sent the invite"));
  assert.ok(html.includes("Send: start my 7 days"));
  assert.ok(html.includes("Your website will be live by <span id=\"due\">Sat 31 Oct</span> (7 days from now), guaranteed."));
  assert.ok(html.includes("A few things to fix before we can start:"));
  assert.ok(html.includes("We pay the yearly fee (about £10) while you're on the monthly plan."));
  // escaping: nothing the client typed becomes markup, in the page or in the embedded JSON
  assert.ok(html.includes("&lt;b&gt;x"));
  assert.ok(!html.includes("<b>x"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("</script><script>alert(1)"));
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(html.includes(`"/onboard/${TOKEN}/save"`));
  assert.ok(html.includes(`"/onboard/${TOKEN}/submit"`));
  assert.ok(html.includes("DEBOUNCE = 1500"));
  assert.ok(html.includes("Saved ✓") && html.includes("Saving…"));
  assert.ok(html.includes("Couldn't save. Check your connection: your answers are still here."));
  // no third-party anything (the token is in the URL)
  assert.ok(!/<script[^>]+src=|<link[^>]+href="https?:/i.test(html));
  assert.ok(html.includes("#1A1C20") && html.includes("#C9A13B") && html.includes("#F6F4EF"));
  // the inline script is valid JavaScript
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  const data = html.match(/<script type="application\/json" id="form-data">([\s\S]*?)<\/script>/);
  assert.ok(data);
  assert.equal(JSON.parse(data[1]).business.name, "<b>x");
});

test("renderOnboard: no confident name, no Google email yet, Website Only", () => {
  const full = renderOnboard({ token: TOKEN, form: formDefaults({}), first: null, package: "full", gbpEmail: "" });
  assert.ok(full.includes("Hi there, this takes about 10 minutes."));
  assert.ok(full.includes("we'll email you the address to invite"));
  assert.ok(!full.includes("<strong></strong>"));
  const site = renderOnboard({ token: TOKEN, form: formDefaults({}), first: "Mark", package: "website", gbpEmail: "nik@x.test" });
  assert.ok(!site.includes(">Google Business Profile</h2>"));
  assert.ok(!site.includes(">Reviews</h2>"));
  assert.ok(site.includes("The first year is included; after that it renews at about £10 a year."));
  assert.ok(!site.includes("while you're on the monthly plan"));
  assert.throws(() => renderOnboard({ token: "../x", form: {}, package: "full" }));
});

test("renderOnboard shows server errors next to fields and in the summary", () => {
  const { errors } = validateForm({}, { package: "full" });
  const html = renderOnboard({ token: TOKEN, form: {}, package: "full", errors });
  assert.ok(html.includes("Please add your business name."));
  assert.ok(html.includes("Please choose emergency call-outs yes or no."));
});

test("renderOnboardDone: thanks page with the UK due day and a read-only summary", () => {
  const form = goodForm();
  form.business.name = "<b>x";
  const html = renderOnboardDone({ first: "Mark", dueIso: "2026-10-31T22:30:00Z", form });
  assert.ok(html.includes("Thanks, Mark! Your website will be live by Sat 31 Oct. We'll email you the moment it's live. Need to change an answer? Just reply to our email."));
  assert.ok(html.includes("Your website will be live by Sat 31 Oct"));
  assert.ok(html.includes("&lt;b&gt;x") && !html.includes("<b>x"));
  assert.ok(html.includes("Roof repairs") && html.includes("Wroughton") && html.includes("smithroofing.co.uk"));
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(!html.includes("<script"));
  assert.ok(renderOnboardDone({ first: null, dueIso: "2026-10-31T22:30:00Z", form }).includes("Thanks! Your website will be live by Sat 31 Oct."));
});

test("renderBadToken: the 404 page", () => {
  const html = renderBadToken();
  assert.ok(html.includes("This link isn't valid. Check the link in our email, or reply to it and we'll send a new one."));
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
});

// ---------------------------------------------------------------------------------------------------------------
// The page script, run against a tiny fake DOM built from the page's own HTML (no npm packages): it must really
// save the whole form 1.5 s after the last change, show/hide the domain parts, add services and towns, and send.

const VOID = new Set(["meta", "input", "br", "img", "link"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39|#96);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#96": "`" })[e]);

class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag;
    this.attrs = attrs;
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.text = "";
    this.value = attrs.value !== undefined ? attrs.value : "";
    this.checked = "checked" in attrs;
    this.hidden = "hidden" in attrs;
    this.disabled = false;
  }
  get id() { return this.attrs.id || ""; }
  set id(v) { this.attrs.id = v; }
  get type() { return this.attrs.type || ""; }
  set type(v) { this.attrs.type = v; }
  get className() { return this.attrs.class || ""; }
  set className(v) { this.attrs.class = v; }
  set htmlFor(v) { this.attrs.for = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.children = []; this.text = String(v); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  closest(sel) { for (let n = this; n; n = n.parentNode) if (n.tagName && matches(n, sel)) return n; return null; }
  scrollIntoView() {}
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) { return this.all().filter((n) => matches(n, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
class TextNode extends El {
  constructor(t) { super("#text"); this.text = t; }
}

// Compound selectors (tag, #id, .class, [attr], [attr='v'], :checked) joined by descendant spaces.
function simple(n, part) {
  const re = /^([a-z]+)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:='([^']*)')?\]|:(checked)/gy;
  let m, at = 0;
  re.lastIndex = 0;
  while (at < part.length && (m = re.exec(part))) {
    at = re.lastIndex;
    if (m[1] && n.tagName !== m[1]) return false;
    if (m[2] && n.id !== m[2]) return false;
    if (m[3] && !n.className.split(/\s+/).includes(m[3])) return false;
    if (m[4] && (m[5] === undefined ? n.getAttribute(m[4]) === null : n.getAttribute(m[4]) !== m[5])) return false;
    if (m[6] && !n.checked) return false;
  }
  if (at !== part.length) throw new Error(`fake DOM can't read selector ${part}`);
  return true;
}
function matches(n, sel) {
  if (n.tagName === "#text") return false;
  const parts = sel.trim().split(/\s+/);
  if (!simple(n, parts.at(-1))) return false;
  let i = parts.length - 2;
  for (let p = n.parentNode; p && i >= 0; p = p.parentNode) if (p.tagName && simple(p, parts[i])) i--;
  return i < 0;
}

function parse(html) {
  const doc = new El("#document");
  let cur = doc;
  const re = /<!doctype[^>]*>|<\/([a-z0-9]+)>|<([a-z0-9]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*>|([^<]+)/giy;
  let m;
  while (re.lastIndex < html.length && (m = re.exec(html))) {
    if (m[1]) { cur = cur.parentNode; continue; }
    if (m[4] !== undefined) { cur.appendChild(new TextNode(unesc(m[4]))); continue; }
    if (!m[2]) continue;
    const attrs = {};
    for (const a of m[3].matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? "" : unesc(a[2]);
    const el = cur.appendChild(new El(m[2].toLowerCase(), attrs));
    if (RAW.has(el.tagName)) {
      const end = html.indexOf(`</${el.tagName}>`, re.lastIndex);
      el.text = el.tagName === "textarea" ? unesc(html.slice(re.lastIndex, end)) : html.slice(re.lastIndex, end);
      if (el.tagName === "textarea") el.value = el.text;
      re.lastIndex = end + el.tagName.length + 3;
    } else if (!VOID.has(el.tagName)) cur = el;
  }
  assert.equal(re.lastIndex, html.length, "fake DOM parsed the whole page");
  return doc;
}

function fire(el, type, extra = {}) {
  const ev = { type, target: el, key: extra.key, preventDefault() { this.defaultPrevented = true; } };
  for (let n = el; n; n = n.parentNode) for (const fn of n.listeners[type] || []) fn(ev);
  return ev;
}

/** Runs the page's script; returns the DOM, the posts it made, a clock to move, and the reload count. */
function runPage(html, { respond = () => ({ status: 200 }), nowMs = Date.parse("2026-10-24T22:30:00Z") } = {}) {
  const doc = parse(html);
  const document = { getElementById: (id) => doc.querySelector(`#${id}`), querySelector: (s) => doc.querySelector(s),
    querySelectorAll: (s) => doc.querySelectorAll(s), createElement: (t) => new El(t), createTextNode: (t) => new TextNode(t) };
  let clock = nowMs, seq = 0;
  const timers = new Map();
  const posts = [];
  const page = { reloads: 0 };
  const fetch = (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    const r = respond(url, posts.length);
    return Promise.resolve({ status: r.status, ok: r.status >= 200 && r.status < 300, json: () => Promise.resolve(r.body || {}) });
  };
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  }
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  new Function("document", "fetch", "location", "setTimeout", "clearTimeout", "setInterval", "Date", script)(
    document, fetch, { reload: () => { page.reloads++; } },
    (fn, ms) => { timers.set(++seq, { fn, at: clock + ms }); return seq; },
    (id) => timers.delete(id),
    () => 0,
    FakeDate,
  );
  const tick = async (ms) => {
    clock += ms;
    for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); }
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { doc, posts, tick, page, status: () => doc.querySelector("#status").textContent };
}

test("the page script saves the whole form 1.5 s after the last change, to /onboard/<token>/save", async () => {
  const form = goodForm();
  form.domain = { has: "", name: "", registrar: "", can_login: "", email_on_it: "", choices: ["", "", ""] };
  const html = renderOnboard({ token: TOKEN, form, first: "Mark", package: "full", gbpEmail: "nik@aetoswebsites.com" });
  const p = runPage(html);
  const { doc } = p;
  assert.equal(doc.querySelector("#due").textContent, "Sat 31 Oct");
  assert.equal(doc.querySelector("#dom-yes").hidden, true);
  assert.equal(doc.querySelector("#dom-no").hidden, true);

  const name = doc.querySelector("[data-k='business.name']");
  name.value = "Smith Roofing & Sons";
  fire(name, "input");
  await p.tick(1000);
  name.value = "Smith Roofing and Sons";
  fire(name, "input");
  await p.tick(1499);
  assert.equal(p.posts.length, 0, "nothing saved before 1.5 s after the last change");
  await p.tick(1);
  assert.equal(p.posts.length, 1);
  assert.equal(p.posts[0].url, `/onboard/${TOKEN}/save`);
  const saved = p.posts[0].body;
  assert.deepEqual(Object.keys(saved), Object.keys(formDefaults({})));
  assert.equal(saved.business.name, "Smith Roofing and Sons");
  assert.deepEqual(saved.areas, ["Swindon", "Wroughton"]);
  assert.deepEqual(saved.services, form.services);
  assert.equal(p.status(), "Saved ✓");

  // domain: "No: buy me one" shows the three names
  const no = doc.querySelectorAll("[name='domain.has']").find((r) => r.value === "no");
  no.checked = true;
  fire(no, "change");
  assert.equal(doc.querySelector("#dom-no").hidden, false);
  assert.equal(doc.querySelector("#dom-yes").hidden, true);
  const c0 = doc.querySelector("[data-k='domain.choices.0']");
  c0.value = "smithroofing.co.uk";
  fire(c0, "input");
  // a ticked service and a town (a duplicate town is skipped)
  const svc = doc.querySelector("#svc-add");
  svc.value = "Chimneys";
  fire(svc, "input");
  fire(doc.querySelector("#svc-btn"), "click");
  const area = doc.querySelector("#area-add");
  area.value = "Highworth, swindon";
  fire(area, "input");
  fire(doc.querySelector("#area-btn"), "click");
  // remove Wroughton
  fire(doc.querySelectorAll(".chip").find((c) => c.getAttribute("data-v") === "Wroughton").querySelector(".rm"), "click");
  await p.tick(1500);
  const s2 = p.posts.at(-1).body;
  assert.equal(p.posts.length, 2);
  assert.equal(s2.domain.has, "no");
  assert.deepEqual(s2.domain.choices, ["smithroofing.co.uk", "", ""]);
  assert.deepEqual(s2.services.at(-1), { name: "Chimneys", on: true, own: true });
  assert.deepEqual(s2.areas, ["Swindon", "Highworth"]);
  assert.deepEqual(validateForm(s2, { package: "full" }), { ok: true, errors: {} });

  // typing in an "Add" box alone doesn't save
  svc.value = "Gut";
  fire(svc, "input");
  await p.tick(3000);
  assert.equal(p.posts.length, 2);
});

test("the page script: failed saves say so; Send posts to submit, shows errors, reloads when done", async () => {
  const html = renderOnboard({ token: TOKEN, form: formDefaults({}), first: null, package: "full", gbpEmail: "" });
  let answer = { status: 500 };
  const p = runPage(html, { respond: () => answer });
  const phone = p.doc.querySelector("[data-k='business.phone']");
  phone.value = "01793 123456";
  fire(phone, "input");
  await p.tick(1500);
  assert.equal(p.status(), "Couldn't save. Check your connection: your answers are still here.");

  // Send with a town typed but not added: it's sent with it, and the errors come back next to the fields
  const { errors } = validateForm({}, { package: "full" });
  delete errors.areas;
  answer = { status: 400, body: { errors } };
  const area = p.doc.querySelector("#area-add");
  area.value = "Swindon";
  fire(p.doc.querySelector("#send"), "click");
  fire(p.doc.querySelector("#send"), "click"); // a double press sends once
  await p.tick(0);
  const sent = p.posts.filter((x) => x.url === `/onboard/${TOKEN}/submit`);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.areas, ["Swindon"]);
  assert.equal(sent[0].body.business.phone, "01793 123456");
  assert.equal(p.doc.querySelector("#errs").hidden, false);
  assert.ok(p.doc.querySelector("#errs ul").textContent.includes("Please add your business name."));
  const err = p.doc.querySelector("[data-err='business.name']");
  assert.equal(err.hidden, false);
  assert.equal(err.textContent, "Please add your business name.");
  assert.equal(p.doc.querySelector("[data-err='areas']").hidden, true);
  assert.equal(p.posts.at(-1).url, `/onboard/${TOKEN}/save`, "the answers sent are saved too");

  answer = { status: 200 };
  fire(p.doc.querySelector("#send"), "click");
  await p.tick(0);
  assert.equal(p.page.reloads, 1, "reloads to the thanks page");
  // a save refused because it was already sent (another tab) reloads too
  const q = runPage(html, { respond: () => ({ status: 409 }) });
  const qPhone = q.doc.querySelector("[data-k='business.phone']");
  qPhone.value = "01793 123456";
  fire(qPhone, "input");
  await q.tick(1500);
  assert.equal(q.page.reloads, 1);
  // too big for the server: the message says so
  const r = runPage(html, { respond: () => ({ status: 413 }) });
  fire(r.doc.querySelector("[data-k='business.phone']"), "input");
  await r.tick(1500);
  assert.equal(r.status(), "Couldn't save: that's more than we can take. Please shorten your longest answers.");
});

test("the page script's live-by day uses the server's month names", () => {
  const html = renderOnboard({ token: TOKEN, form: goodForm(), package: "full", now: new Date("2026-08-29T12:00:00Z") });
  assert.ok(html.includes('<span id="due">Sat 5 Sep</span>'));
  const p = runPage(html, { nowMs: Date.parse("2026-08-29T12:00:00Z") });
  assert.equal(p.doc.querySelector("#due").textContent, "Sat 5 Sep");
  // 23:30 UTC on Sat 24 Oct (BST) + 168 h = 22:30 UTC on Sat 31 Oct (GMT): still Sat 31 Oct in the UK
  const q = runPage(html, { nowMs: Date.parse("2026-10-24T23:30:00Z") });
  assert.equal(q.doc.querySelector("#due").textContent, "Sat 31 Oct");
});

test("validateForm: towns once each, emails with an apostrophe, no header tricks", () => {
  const f = goodForm();
  f.areas = [...Array.from({ length: 20 }, (_, i) => `Town ${i}`), "town 0", " Town  1 "];
  assert.equal(validateForm(f, { package: "full" }).ok, true, "repeats aren't counted");
  f.business.email = "o'neill@smithroofing.co.uk";
  assert.equal(validateForm(f, { package: "full" }).ok, true);
  for (const bad of ["a@b.co\r\nBcc: x@y.z", "a@b.co, c@d.co", "Mark <a@b.co>", "a@b"]) {
    f.business.leads_email = bad;
    assert.equal(validateForm(f, { package: "full" }).errors["business.leads_email"], "Please add an email for website enquiries.", bad);
  }
  assert.deepEqual(formDefaults({ research: { copy: { areas: ["Swindon", "swindon", "Wroughton"] } } }).areas, ["Swindon", "Wroughton"]);
});

test("validateForm: a service or town too long for a page heading is refused (section 5: H1 ≤ 70 must contain it)", () => {
  const f = goodForm();
  f.services.push({ name: "Roof repairs, guttering, fascias, soffits and chimney work", on: true, own: true });
  assert.equal(validateForm(f, { package: "full" }).errors.services,
    'Please keep each service to 40 characters, like "Roof repairs". Untick the long one and add it again as shorter, separate services.');
  f.services.at(-1).on = false; // an unticked one gets no page: fine
  assert.equal(validateForm(f, { package: "full" }).ok, true);
  f.services.push({ name: "x".repeat(40), on: true, own: true });
  assert.equal(validateForm(f, { package: "full" }).ok, true);
  f.areas.push("Swindon, Wroughton, Highworth, Purton and the villages");
  assert.equal(validateForm(f, { package: "full" }).errors.areas, "Please keep each town or area to 40 characters.");
  f.areas[f.areas.length - 1] = "Stratton  St Margaret"; // spaces collapse
  assert.equal(validateForm(f, { package: "full" }).ok, true);
});

test("validateForm: an email domain with an empty part or a one-letter ending is refused", () => {
  const f = goodForm();
  for (const bad of ["a@b..co", "a@.co.uk", "a@b.c", "a@b.co.", "a@b"]) {
    f.business.email = bad;
    assert.equal(validateForm(f, { package: "full" }).errors["business.email"], "Please add an email for customers.", bad);
  }
  for (const good of ["info@smithroofing.co.uk", "mark.smith+site@mail.example.com", "o'neill@bt.com"]) {
    f.business.email = good;
    assert.equal(validateForm(f, { package: "full" }).errors["business.email"], undefined, good);
  }
});

test("the page script: adding a service they already have ticks it instead of adding it twice", async () => {
  const form = goodForm();
  form.services[0].on = false;
  const p = runPage(renderOnboard({ token: TOKEN, form, first: null, package: "full" }));
  const svc = p.doc.querySelector("#svc-add");
  svc.value = "  roof   REPAIRS ";
  fire(p.doc.querySelector("#svc-btn"), "click");
  await p.tick(1500);
  const saved = p.posts.at(-1).body;
  assert.deepEqual(saved.services, [{ name: "Roof repairs", on: true, own: false }, { name: "Flat roofs", on: true, own: false }]);
  assert.equal(svc.value, "");
});

test("validateForm: a review link too long for the printed QR card is refused with the short-link hint", () => {
  const f = goodForm();
  // a long Google Maps link: a Google link (passes checkReviewLink) but its QR is too dense for the card
  f.review_link = `https://www.google.com/maps/place/Smith+Roofing/@51.5,-1.7,17z/data=${"x".repeat(700)}`;
  assert.equal(validateForm(f, { package: "full" }).errors.review_link, FORM_ERRORS.review_link_long);
  assert.equal(FORM_ERRORS.review_link_long,
    "That review link is too long to print on your review cards. Use the short link from your Google Business Profile (tap 'Get more reviews'), or leave it empty and we'll find it.");
  f.review_link = "https://g.page/r/CabcDEF123/review";
  assert.equal(validateForm(f, { package: "full" }).ok, true);
  // Website Only has no review link question
  f.review_link = `https://www.google.com/maps/place/x/data=${"x".repeat(700)}`;
  assert.equal(validateForm(f, { package: "website" }).errors.review_link, undefined);
});

test("validateForm: a 41-character own service says how to fix it; unticked it is fine", () => {
  const f = goodForm();
  f.services.push({ name: "x".repeat(41), on: true, own: true });
  assert.equal(validateForm(f, { package: "full" }).errors.services, FORM_ERRORS.service_long);
  assert.equal(FORM_ERRORS.service_long,
    'Please keep each service to 40 characters, like "Roof repairs". Untick the long one and add it again as shorter, separate services.');
  f.services.at(-1).on = false;
  assert.equal(validateForm(f, { package: "full" }).errors.services, undefined);
  assert.equal(validateForm(f, { package: "full" }).ok, true);
});

test("the page script: the Add a service box takes at most 40 characters and never adds a longer one", async () => {
  const html = renderOnboard({ token: TOKEN, form: goodForm(), first: null, package: "full" });
  assert.match(html, /<input type="text" id="svc-add" maxlength="40"/);
  const p = runPage(html);
  const before = p.doc.querySelectorAll(".svc input").length;
  const svc = p.doc.querySelector("#svc-add");
  // pasted text can get past maxlength in some browsers; spaces collapse first, so 40 after collapsing is fine
  svc.value = "  " + "y".repeat(41) + " ";
  fire(p.doc.querySelector("#svc-btn"), "click");
  assert.equal(p.doc.querySelectorAll(".svc input").length, before, "not added");
  assert.equal(svc.value, "  " + "y".repeat(41) + " ", "their text stays in the box");
  const err = p.doc.querySelector("[data-err='services']");
  assert.equal(err.hidden, false);
  assert.equal(err.textContent, FORM_ERRORS.service_add_long);
  assert.equal(FORM_ERRORS.service_add_long, 'Please keep each service to 40 characters, like "Roof repairs". Add more as separate services.');
  // Send doesn't add it either, and doesn't send without it
  fire(p.doc.querySelector("#send"), "click");
  await p.tick(0);
  assert.equal(p.posts.filter((x) => /submit$/.test(x.url)).length, 0);
  assert.equal(p.doc.querySelectorAll(".svc input").length, before);
  // a 40-character one (after the spaces collapse) is added and the message goes
  svc.value = " " + "z".repeat(20) + "   " + "z".repeat(19) + " ";
  fire(p.doc.querySelector("#svc-btn"), "click");
  assert.equal(p.doc.querySelectorAll(".svc input").length, before + 1);
  assert.equal(err.hidden, true);
});
