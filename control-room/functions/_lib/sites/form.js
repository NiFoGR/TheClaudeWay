// The onboarding form /onboard/<token> (stage 10, pure: docs/rebuild/09-build.md section 4, exact copy).
//
// formDefaults() prefills the section 4 JSON from the lead and Claude's research; normaliseForm() turns whatever a
// browser posted into exactly that shape; validateForm() gives every problem as {field key: message} in the form's
// own words; renderOnboard / renderOnboardDone / renderBadToken are the three pages as HTML strings. The routes
// (Task 12, functions/onboard/) load the rows, store the form and set the status codes.
//
// Everything the client typed, scraped lead text and research is untrusted: h() before it goes into HTML, and the
// form JSON embedded for the autosave script has <, >, & and the line separators escaped. Our own fixed copy goes
// through t(), which escapes only what could start markup, so the wording stays exactly as written.
// The page loads nothing from anywhere else (the token is in the URL): inline CSS, one small inline script.
// Tested in control-room/tests/sites-form.test.mjs.

import { h, shortName } from "../demo/text.js";
import { ukParts } from "../ukTime.js";
import { cardQr } from "./card.js";
import { checkReviewLink } from "./copy.js";
import { ukShortDay } from "./countdown.js";
import { canonicalHost, underOurDomain } from "./hosts.js";
import { toE164UK } from "./jsonld.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
// One address (it becomes an email's To): no spaces, quotes or list separators; an apostrophe is fine before the @.
// The domain is dot-separated labels, none empty, ending in a TLD of 2+ characters.
const EMAIL_RE = /^[^\s@<>"(),;:[\]\\]+@(?:[^\s@<>"'(),;:[\]\\.]+\.)+[^\s@<>"'(),;:[\]\\.]{2,}$/;
const MAX_AREAS = 20;
// A service or town is a page name: its H1 (10–70 characters, section 5) must contain it, and the home H1 carries the
// trade and the town together, so one longer than this could never pass the content check. research.js caps the
// research copy's services and areas at the same 40.
const NAME_MAX = 40;
const ABOUT_MAX = 1500;
const NOTES_MAX = 2000;
const FIRST_YEAR = 1950;
const DUE_MS = 168 * 3600000;

/** Every message the form shows (section 4, exact copy; can_login onwards are not in section 4: see the stage report). */
export const FORM_ERRORS = Object.freeze({
  summary: "A few things to fix before we can start:",
  name: "Please add your business name.",
  phone: "Please add a UK phone number customers can call.",
  email: "Please add an email for customers.",
  show_address: "Please choose whether to show your address.",
  legal_line: "Please add your name for the footer.",
  leads_email: "Please add an email for website enquiries.",
  services: "Please tick at least one service.",
  areas: "Please add at least one town or area.",
  areas_max: "Please keep it to 20 towns or areas.",
  domain: "Please tell us about your web address.",
  domain_name: "That doesn't look like a web address. Type it like smithroofing.co.uk.",
  domain_ours: "That's our web address, not yours. Type your own, like smithroofing.co.uk.",
  choices: "Please give us at least one name you'd like.",
  gbp: "Please tell us about your Google listing.",
  review_link: "That review link isn't a Google link. Leave it empty and we'll find it.",
  free_quotes: "Please choose free quotes yes or no.",
  emergency: "Please choose emergency call-outs yes or no.",
  can_login: "Please choose whether you can log in to it.",
  email_on_it: "Please choose whether you use email on it.",
  started: (year) => `Please type the year you started as 4 digits, between ${FIRST_YEAR} and ${year}.`,
  about: "Please keep your About text to 1,500 characters.",
  notes: "Please keep this to 2,000 characters.",
  service_long: `Please keep each service to ${NAME_MAX} characters, like "Roof repairs". Untick the long one and add it again as shorter, separate services.`,
  // In the page script, under Services, when the Add a service box holds a longer one (it isn't added).
  service_add_long: `Please keep each service to ${NAME_MAX} characters, like "Roof repairs". Add more as separate services.`,
  // A Google link whose QR wouldn't fit the printed review card (cardQr): the short g.page link always does.
  review_link_long: "That review link is too long to print on your review cards. Use the short link from your Google Business Profile (tap 'Get more reviews'), or leave it empty and we'll find it.",
  area_long: `Please keep each town or area to ${NAME_MAX} characters.`,
});

const BAD_TOKEN = "This link isn't valid. Check the link in our email, or reply to it and we'll send a new one.";

// ---------------------------------------------------------------------------------------------------------------
// Data

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");
const trim = (v) => str(v).trim();
const oneOf = (v, allowed) => (allowed.includes(v) ? v : "");

/** A JSON column that may already be parsed: the object, or {} when it's missing or not JSON. */
function obj(v) {
  if (isObj(v)) return v;
  if (typeof v !== "string" || !v) return {};
  try {
    const parsed = JSON.parse(v);
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const texts = (list) => (Array.isArray(list) ? list.map(trim).filter(Boolean) : []);
/** The areas once each, ignoring case and spaces (how the site content validator counts them). */
const distinctAreas = (list) => {
  const seen = new Set();
  return texts(list).map((a) => a.replace(/\s+/g, " ")).filter((a) => {
    const k = a.toLowerCase();
    return seen.has(k) ? false : (seen.add(k), true);
  });
};
const fullPackage = (pkg) => pkg !== "website";

/** research.owner.first when Claude marked it confident, else null (the page then says "Hi there,"). */
export function onboardFirst(research) {
  const owner = obj(obj(research).owner);
  const first = trim(owner.first);
  return owner.confident === true && first ? first : null;
}

/** The empty form: section 4's JSON with every key. */
function emptyForm() {
  return {
    business: { name: "", phone: "", email: "", address: "", show_address: "", legal_line: "", leads_email: "" },
    services: [],
    free_quotes: "", emergency: "", hours: "", started: "", accreditations: "", guarantee: "",
    areas: [],
    about: "",
    photos_note: "",
    domain: { has: "", name: "", registrar: "", can_login: "", email_on_it: "", choices: ["", "", ""] },
    gbp: { has: "", invite_sent: false },
    review_link: "",
    notes: "",
  };
}

// The footer's legal line: a company number means a limited company; otherwise the owner's full name (two words at
// least: a guessed first name alone isn't a legal name) trading as the business.
function legalLine(lead, name) {
  const number = trim(lead.company_number);
  const director = trim(lead.director_name).replace(/\s+/g, " ");
  if (name && number) return `${name} Ltd, company no. ${number}`;
  if (name && director.split(" ").length >= 2) return `${director} trading as ${name}`;
  return "";
}

/** The form's first version, prefilled from the lead and research (section 4's brackets). */
export function formDefaults({ lead, research, client } = {}) {
  const l = isObj(lead) ? lead : {};
  const r = isObj(research) ? research : {};
  const copy = obj(r.copy);
  const f = emptyForm();
  const name = shortName(trim(l.name)) || shortName(trim(isObj(client) ? client.name : ""));
  const email = trim(r.best_email);
  f.business.name = name;
  f.business.phone = trim(l.phone);
  f.business.email = email;
  f.business.address = trim(l.address);
  f.business.legal_line = legalLine(l, name);
  f.business.leads_email = email;
  f.services = texts(copy.services).map((s) => ({ name: s, on: true, own: false }));
  f.areas = distinctAreas(copy.areas);
  if (!f.areas.length && trim(l.town)) f.areas = [trim(l.town)];
  f.about = trim(copy.about);
  return f;
}

/** Whatever was posted, in exactly section 4's shape: unknown keys dropped, wrong types emptied. */
export function normaliseForm(form) {
  const src = isObj(form) ? form : {};
  const f = emptyForm();
  const b = isObj(src.business) ? src.business : {};
  for (const k of Object.keys(f.business)) f.business[k] = str(b[k]);
  f.business.show_address = oneOf(b.show_address, ["yes", "no"]);
  f.services = (Array.isArray(src.services) ? src.services : [])
    .filter((s) => isObj(s) && typeof s.name === "string")
    .map((s) => ({ name: s.name, on: Boolean(s.on), own: s.own === true }));
  for (const k of ["hours", "started", "accreditations", "guarantee", "about", "photos_note", "review_link", "notes"]) {
    f[k] = str(src[k]);
  }
  f.free_quotes = oneOf(src.free_quotes, ["yes", "no"]);
  f.emergency = oneOf(src.emergency, ["yes", "no"]);
  f.areas = (Array.isArray(src.areas) ? src.areas : []).filter((a) => typeof a === "string");
  const d = isObj(src.domain) ? src.domain : {};
  f.domain.has = oneOf(d.has, ["yes", "no"]);
  f.domain.name = str(d.name);
  f.domain.registrar = str(d.registrar);
  f.domain.can_login = oneOf(d.can_login, ["yes", "no", "not_sure"]);
  f.domain.email_on_it = oneOf(d.email_on_it, ["yes", "no", "not_sure"]);
  const choices = Array.isArray(d.choices) ? d.choices : [];
  f.domain.choices = [0, 1, 2].map((i) => str(choices[i]));
  const g = isObj(src.gbp) ? src.gbp : {};
  f.gbp.has = oneOf(g.has, ["yes", "no", "not_sure"]);
  f.gbp.invite_sent = g.invite_sent === true;
  return f;
}

/**
 * Every problem with the form, as {field key: message} ("business.phone", "services", "domain.name", …).
 * `package` is the client's (full | weekend | website): Website Only has no Google listing or review link questions.
 */
export function validateForm(form, { package: pkg = "full", now = new Date() } = {}) {
  const f = normaliseForm(form);
  const errors = {};
  const need = (ok, key, msg) => {
    if (!ok) errors[key] = msg;
  };
  const E = FORM_ERRORS;
  need(trim(f.business.name), "business.name", E.name);
  need(toE164UK(f.business.phone), "business.phone", E.phone);
  need(EMAIL_RE.test(trim(f.business.email)), "business.email", E.email);
  need(f.business.show_address, "business.show_address", E.show_address);
  need(trim(f.business.legal_line), "business.legal_line", E.legal_line);
  need(EMAIL_RE.test(trim(f.business.leads_email)), "business.leads_email", E.leads_email);
  const ticked = f.services.filter((s) => s.on && trim(s.name));
  if (!ticked.length) errors.services = E.services;
  else if (ticked.some((s) => trim(s.name).replace(/\s+/g, " ").length > NAME_MAX)) errors.services = E.service_long;
  need(f.free_quotes, "free_quotes", E.free_quotes);
  need(f.emergency, "emergency", E.emergency);

  const year = ukParts(now instanceof Date ? now : new Date(now)).y;
  const started = trim(f.started);
  if (started && !(/^\d{4}$/.test(started) && Number(started) >= FIRST_YEAR && Number(started) <= year)) {
    errors.started = E.started(year);
  }

  const areas = distinctAreas(f.areas);
  if (!areas.length) errors.areas = E.areas;
  else if (areas.length > MAX_AREAS) errors.areas = E.areas_max;
  else if (areas.some((a) => a.length > NAME_MAX)) errors.areas = E.area_long;

  need(f.about.length <= ABOUT_MAX, "about", E.about);

  if (f.domain.has === "yes") {
    const host = canonicalHost(f.domain.name);
    need(host.ok, "domain.name", E.domain_name);
    // Ours is never theirs: setHost refuses it too (the backstop), so it would only leave Nik with no host.
    if (host.ok && underOurDomain(host.domain)) errors["domain.name"] = E.domain_ours;
    need(f.domain.can_login, "domain.can_login", E.can_login);
    need(f.domain.email_on_it, "domain.email_on_it", E.email_on_it);
  } else if (f.domain.has === "no") {
    need(trim(f.domain.choices[0]), "domain.choices", E.choices);
  } else {
    errors["domain.has"] = E.domain;
  }

  if (fullPackage(pkg)) {
    need(f.gbp.has, "gbp.has", E.gbp);
    const link = trim(f.review_link);
    const checked = link ? checkReviewLink(link) : { ok: true };
    need(checked.ok, "review_link", E.review_link);
    // It goes on the printed QR card: one the card couldn't print is refused here, not found out after go-live.
    if (checked.ok && link && !cardQr(checked.url)) errors.review_link = E.review_link_long;
  }

  need(f.notes.length <= NOTES_MAX, "notes", E.notes);
  return { ok: Object.keys(errors).length === 0, errors };
}

// ---------------------------------------------------------------------------------------------------------------
// HTML

/** Our own copy for a text node: only &, < and > escaped, so the wording reads exactly as written. */
const t = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** JSON that is safe inside a <script> element. */
const scriptJson = (v) => JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const idFor = (key) => `f-${key.replace(/[^a-z0-9]+/gi, "-")}`;

const CSS = `
:root{--charcoal:#1A1C20;--white:#FFFFFF;--graphite:#2E3135;--marble:#F6F4EF;--stone:#D9D4CA;--slate:#5C6066;--gold:#C9A13B;--gold-text:#7A5C14;--red:#A3261B}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--marble);color:var(--charcoal);font:16px/1.5 Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
header{background:var(--charcoal);color:var(--white);padding:16px}
.mark{font-weight:800;letter-spacing:.1em;font-size:20px;margin:0}
.mark small{display:block;font-size:11px;letter-spacing:.3em;color:var(--stone);font-weight:600}
main{max-width:640px;margin:0 auto;padding:16px 16px 48px}
h1{font-size:26px;line-height:1.2;margin:8px 0 12px}
h2{font-size:20px;margin:0 0 12px}
section{background:var(--white);border:1px solid var(--stone);border-radius:10px;padding:16px;margin:16px 0}
p{margin:0 0 12px}
.lead,.help{color:var(--slate)}
.help{font-size:15px;margin:4px 0 8px}
.field{margin:0 0 18px}
label,legend{display:block;font-weight:600;margin:0 0 6px}
fieldset{border:0;margin:0 0 18px;padding:0}
input[type=text],input[type=tel],input[type=email],textarea{display:block;width:100%;font:inherit;font-size:16px;color:var(--charcoal);background:var(--white);border:1px solid var(--stone);border-radius:8px;padding:12px;min-height:48px}
textarea{min-height:120px;resize:vertical}
input:focus,textarea:focus,button:focus{outline:3px solid var(--gold);outline-offset:1px}
.opt{display:flex;align-items:center;gap:10px;min-height:48px;font-weight:400;margin:0;padding:4px 0}
.opt input{width:22px;height:22px;margin:0;flex:none;accent-color:var(--charcoal)}
.row{display:flex;gap:8px}
.row input{flex:1}
button{font:inherit;font-size:16px;font-weight:700;min-height:48px;border-radius:8px;cursor:pointer}
.btn{background:var(--gold);color:var(--charcoal);border:0;padding:12px 20px}
.btn-line{background:var(--white);color:var(--charcoal);border:1px solid var(--charcoal);padding:12px 16px}
.send{width:100%;font-size:18px}
.chips{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0;margin:0 0 10px}
.chip{display:flex;align-items:center;gap:4px;background:var(--marble);border:1px solid var(--stone);border-radius:24px;padding:0 0 0 14px}
.chip button{background:none;border:0;min-width:44px;font-size:20px;color:var(--slate)}
.steps{padding-left:22px}
.steps li{margin-bottom:8px}
.err{color:var(--red);font-weight:600;margin:6px 0 0}
#errs{border:2px solid var(--red);border-radius:10px;background:var(--white);padding:12px 16px;margin:16px 0}
#errs ul{margin:0;padding-left:20px;color:var(--red)}
#status{min-height:24px;margin:0;color:var(--slate);font-size:15px}
dl{margin:0}
dt{font-weight:600;margin-top:10px}
dd{margin:0;color:var(--slate);white-space:pre-wrap;overflow-wrap:anywhere}
[hidden]{display:none!important}
`;

function page(title, body, { script = "" } = {}) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${t(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header><p class="mark">AETOS<small>WEBSITES</small></p></header>
<main>
${body}
</main>
${script}
</body>
</html>`;
}

// One error line under a field; filled by the script after Send (or by the server when errors are passed).
function errLine(key, errors) {
  const msg = errors[key];
  return `<p class="err" data-err="${h(key)}"${msg ? "" : " hidden"}>${msg ? h(msg) : ""}</p>`;
}

function textField(key, label, value, errors, { type = "text", required = false, help = "", placeholder = "", attrs = "" } = {}) {
  const id = idFor(key);
  return `<div class="field">
<label for="${id}">${t(label)}${required ? " *" : ""}</label>
${help ? `<p class="help" id="${id}-help">${t(help)}</p>` : ""}<input type="${type}" id="${id}" data-k="${h(key)}" value="${h(value)}"${placeholder ? ` placeholder="${h(placeholder)}"` : ""}${help ? ` aria-describedby="${id}-help"` : ""}${attrs}>
${errLine(key, errors)}
</div>`;
}

function areaField(key, label, value, errors, { help = "", placeholder = "", rows = 5 } = {}) {
  const id = idFor(key);
  return `<div class="field">
<label for="${id}">${t(label)}</label>
${help ? `<p class="help" id="${id}-help">${t(help)}</p>` : ""}<textarea id="${id}" data-k="${h(key)}" rows="${rows}"${placeholder ? ` placeholder="${h(placeholder)}"` : ""}${help ? ` aria-describedby="${id}-help"` : ""}>${h(value)}</textarea>
${errLine(key, errors)}
</div>`;
}

function radios(key, legend, options, value, errors, { required = true } = {}) {
  const id = idFor(key);
  const opts = options.map(([v, label]) => `<label class="opt"><input type="radio" name="${h(key)}" value="${h(v)}" data-k="${h(key)}"${value === v ? " checked" : ""}> ${t(label)}</label>`).join("\n");
  return `<fieldset id="${id}">
<legend>${t(legend)}${required ? " *" : ""}</legend>
${opts}
${errLine(key, errors)}
</fieldset>`;
}

const YES_NO = [["yes", "Yes"], ["no", "No"]];
const YES_NO_SURE = [["yes", "Yes"], ["no", "No"], ["not_sure", "Not sure"]];

function serviceRow(s, i) {
  const id = `svc-${i}`;
  return `<label class="opt svc" for="${id}"><input type="checkbox" id="${id}" data-name="${h(s.name)}" data-own="${s.own ? "1" : "0"}"${s.on ? " checked" : ""}> ${h(s.name)}</label>`;
}

function chip(a) {
  return `<li class="chip" data-v="${h(a)}"><span>${h(a)}</span><button type="button" class="rm" aria-label="Remove ${h(a)}">×</button></li>`;
}

function gbpSteps(gbpEmail) {
  const email = trim(gbpEmail);
  const step4 = email
    ? `Type <strong>${h(email)}</strong>, choose <strong>Manager</strong>, and tap <strong>Invite</strong>.`
    : `Type our address (we'll email you the address to invite), choose <strong>Manager</strong>, and tap <strong>Invite</strong>.`;
  return `<ol class="steps">
<li>${t("On your phone or computer, sign in to the Google account that manages your listing and search Google for your business name (or open business.google.com).")}</li>
<li>${t("Tap the three dots ⋮ next to \"Your business on Google\", then \"Business Profile settings\".")}</li>
<li>${t("Tap \"People and access\", then the \"+\" (Add) button.")}</li>
<li>${step4}</li>
</ol>
<p>${t("That's it: we'll accept the invite and get to work. You stay the owner.")}</p>`;
}

/** The UK day 168 hours after `now`, as "Sat 31 Oct". */
const dueDay = (now) => ukShortDay(new Date((now instanceof Date ? now : new Date(now)).getTime() + DUE_MS).toISOString());

// The page script: autosave 1.5 s after the last change (whole form JSON), show/hide the conditional parts, services
// and areas, Send. It only ever sets textContent, never HTML.
function onboardScript(token) {
  const save = JSON.stringify(`/onboard/${token}/save`);
  const submit = JSON.stringify(`/onboard/${token}/submit`);
  return `<script>
(function () {
  "use strict";
  var SAVE = ${save}, SUBMIT = ${submit}, DEBOUNCE = 1500, DUE_MS = ${DUE_MS}, NAME_MAX = ${NAME_MAX};
  var SVC_LONG = ${JSON.stringify(FORM_ERRORS.service_add_long)};
  var MSG = { saving: "Saving…", saved: "Saved ✓", offline: "Couldn't save. Check your connection: your answers are still here.",
    big: "Couldn't save: that's more than we can take. Please shorten your longest answers.",
    sendFail: "Couldn't send. Check your connection: your answers are still here." };
  var base = JSON.parse(document.getElementById("form-data").textContent);
  var form = document.getElementById("ob");
  var status = document.getElementById("status");
  var timer = null, sending = false;
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function setPath(obj, path, value) {
    var parts = path.split("."), o = obj;
    for (var i = 0; i < parts.length - 1; i++) { if (o[parts[i]] === null || typeof o[parts[i]] !== "object") o[parts[i]] = {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = value;
  }
  function collect() {
    var f = JSON.parse(JSON.stringify(base));
    $$("[data-k]", form).forEach(function (el) {
      var k = el.getAttribute("data-k");
      if (el.type === "radio") { if (el.checked) setPath(f, k, el.value); else if (!$("[name='" + k + "']:checked", form)) setPath(f, k, ""); }
      else if (el.type === "checkbox") setPath(f, k, el.checked);
      else if (/^domain\\.choices\\.\\d$/.test(k)) f.domain.choices[Number(k.slice(-1))] = el.value;
      else setPath(f, k, el.value);
    });
    f.services = $$(".svc input", form).map(function (el) {
      return { name: el.getAttribute("data-name"), on: el.checked, own: el.getAttribute("data-own") === "1" };
    });
    f.areas = $$(".chip", form).map(function (el) { return el.getAttribute("data-v"); });
    return f;
  }
  function say(text) { status.textContent = text; }
  function post(url, body) {
    return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  }
  function save() {
    timer = null;
    say(MSG.saving);
    post(SAVE, collect()).then(function (r) {
      if (r.status === 409) { location.reload(); return; }
      say(r.ok ? MSG.saved : r.status === 413 ? MSG.big : MSG.offline);
    }).catch(function () { say(MSG.offline); });
  }
  function changed(e) {
    toggle();
    // typing in an "Add" box changes nothing yet: the row or chip it adds does
    if (sending || (e && e.target && (e.target.id === "svc-add" || e.target.id === "area-add"))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, DEBOUNCE);
  }
  function toggle() {
    var has = $("[name='domain.has']:checked", form);
    $("#dom-yes").hidden = !(has && has.value === "yes");
    $("#dom-no").hidden = !(has && has.value === "no");
    var g = $("[name='gbp.has']:checked", form);
    ["yes", "no", "not_sure"].forEach(function (v) { var el = $("#gbp-" + v); if (el) el.hidden = !(g && g.value === v); });
  }
  function svcErr(text) { var el = $("[data-err='services']", form); if (el) { el.textContent = text; el.hidden = !text; } }
  // false when the box holds a service too long for a page name: it stays in the box with the message under Services
  function addService() {
    var input = $("#svc-add"), name = input.value.replace(/\\s+/g, " ").trim();
    if (!name) return true;
    if (name.length > NAME_MAX) { svcErr(SVC_LONG); return false; }
    svcErr("");
    // one they already have is ticked again, not added twice
    var same = $$(".svc input", form).filter(function (el) { return el.getAttribute("data-name").trim().toLowerCase() === name.toLowerCase(); })[0];
    if (same) { same.checked = true; input.value = ""; changed(); return true; }
    var i = $$(".svc input", form).length;
    var label = document.createElement("label"), box = document.createElement("input");
    label.className = "opt svc"; label.htmlFor = "svc-" + i;
    box.type = "checkbox"; box.id = "svc-" + i; box.checked = true;
    box.setAttribute("data-name", name); box.setAttribute("data-own", "1");
    label.appendChild(box); label.appendChild(document.createTextNode(" " + name));
    $("#svc-list").appendChild(label);
    input.value = ""; changed();
    return true;
  }
  function addArea() {
    var input = $("#area-add");
    if (!input.value.trim()) return;
    var have = {};
    $$(".chip", form).forEach(function (el) { have[el.getAttribute("data-v").toLowerCase()] = true; });
    input.value.split(",").map(function (s) { return s.replace(/\\s+/g, " ").trim(); }).filter(Boolean).forEach(function (name) {
      if (have[name.toLowerCase()]) return;
      have[name.toLowerCase()] = true;
      var li = document.createElement("li"), span = document.createElement("span"), rm = document.createElement("button");
      li.className = "chip"; li.setAttribute("data-v", name); span.textContent = name;
      rm.type = "button"; rm.className = "rm"; rm.textContent = "×"; rm.setAttribute("aria-label", "Remove " + name);
      li.appendChild(span); li.appendChild(rm); $("#area-list").appendChild(li);
    });
    input.value = ""; changed();
  }
  function showErrors(errors) {
    $$("[data-err]", form).forEach(function (el) { el.hidden = true; el.textContent = ""; });
    var box = $("#errs"), list = $("#errs ul");
    list.textContent = "";
    var keys = Object.keys(errors || {});
    keys.forEach(function (k) {
      var el = $("[data-err='" + k + "']", form);
      if (el) { el.textContent = errors[k]; el.hidden = false; }
      var li = document.createElement("li"); li.textContent = errors[k]; list.appendChild(li);
    });
    box.hidden = keys.length === 0;
    if (keys.length) box.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // The UK day 168 h from now, as "Sat 31 Oct" (the same names as the server's: browsers say "Sept" for September)
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dueText() {
    try {
      var parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "numeric", day: "numeric" })
        .formatToParts(new Date(Date.now() + DUE_MS));
      var p = {}; parts.forEach(function (x) { p[x.type] = Number(x.value); });
      if (!(p.year && p.month && p.day)) return;
      $("#due").textContent = DAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()] + " " + p.day + " " + MONTHS[p.month - 1];
    } catch (e) { /* keep the server's date */ }
  }
  function send() {
    if (sending) return;
    // a service or town typed but not yet added still counts (a service too long stops Send: it says why)
    var svcOk = addService(); addArea();
    if (!svcOk) { $("#svc-add").focus && $("#svc-add").focus(); return; }
    if (timer) { clearTimeout(timer); timer = null; }
    sending = true;
    var btn = $("#send"); btn.disabled = true;
    say("");
    post(SUBMIT, collect()).then(function (r) {
      if (r.ok || r.status === 409) { location.reload(); return; }
      return r.json().catch(function () { return {}; }).then(function (data) {
        sending = false; btn.disabled = false;
        if (r.status === 400 && data && data.errors) { showErrors(data.errors); save(); }
        else say(MSG.sendFail);
      });
    }).catch(function () { sending = false; btn.disabled = false; say(MSG.sendFail); });
  }
  form.addEventListener("input", changed);
  form.addEventListener("change", changed);
  form.addEventListener("submit", function (e) { e.preventDefault(); });
  form.addEventListener("click", function (e) {
    var rm = e.target.closest ? e.target.closest(".rm") : null;
    if (rm) { rm.parentNode.parentNode.removeChild(rm.parentNode); changed(); }
  });
  $("#svc-btn").addEventListener("click", addService);
  $("#area-btn").addEventListener("click", addArea);
  $("#svc-add").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addService(); } });
  $("#area-add").addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addArea(); } });
  $("#area-add").addEventListener("change", addArea);
  $("#send").addEventListener("click", send);
  toggle(); dueText(); setInterval(dueText, 60000);
})();
</script>`;
}

/**
 * The form page. `first` = the owner's confident first name (onboardFirst) or null; `package` = full | weekend |
 * website; `gbpEmail` = setting care:nik_google_email ("" until set); `errors` (optional) = validateForm's errors to
 * show straight away; `now` (optional) = the time the "live by" day is first worked out from (the browser updates it).
 * Throws when the token isn't a token (it goes into the script).
 */
export function renderOnboard({ token, form, first, package: pkg = "full", gbpEmail = "", errors = {}, now = new Date() } = {}) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new Error("renderOnboard needs the onboarding token");
  const f = normaliseForm(form);
  const errs = isObj(errors) ? errors : {};
  const full = fullPackage(pkg);
  const b = f.business;
  const name = trim(first);
  const errKeys = Object.keys(errs);

  const intro = `${name ? `Hi ${h(name)},` : "Hi there,"} ${t("this takes about 10 minutes. Your answers save as you go, so you can stop and come back. Your 7 days start when you press Send at the bottom.")}`;

  const details = `<section>
<h2>Your details on the website</h2>
${textField("business.name", "Business name", b.name, errs, { required: true, attrs: ' autocomplete="organization"' })}
${textField("business.phone", "Phone number customers should call", b.phone, errs, { type: "tel", required: true, attrs: ' autocomplete="tel"' })}
${textField("business.email", "Email for customers", b.email, errs, { type: "email", required: true, attrs: ' autocomplete="email"' })}
${textField("business.address", "Address", b.address, errs, { attrs: ' autocomplete="street-address"' })}
${radios("business.show_address", "Show your address on the website?", [["yes", "Yes"], ["no", "No, I work from home: show my town only"]], b.show_address, errs)}
${textField("business.legal_line", "Your name for the footer", b.legal_line, errs, { required: true, help: "The law says a sole trader using a business name must show their own name. For example: 'John Smith trading as Smith Roofing' or 'Smith Roofing Ltd, company no. 01234567'." })}
${textField("business.leads_email", "Where should website enquiries go?", b.leads_email, errs, { type: "email", required: true })}
</section>`;

  const what = `<section>
<h2>What you do</h2>
<fieldset id="${idFor("services")}">
<legend>Services *</legend>
<p class="help">${t("Untick anything you don't do. Each service gets its own page, which helps you show up on Google for it.")}</p>
<div id="svc-list">
${f.services.map(serviceRow).join("\n")}
</div>
<div class="row"><input type="text" id="svc-add" maxlength="${NAME_MAX}" placeholder="Add a service" aria-label="Add a service"><button type="button" class="btn-line" id="svc-btn">Add</button></div>
${errLine("services", errs)}
</fieldset>
${radios("free_quotes", "Do you give free quotes?", YES_NO, f.free_quotes, errs)}
${radios("emergency", "Do you do emergency call-outs?", YES_NO, f.emergency, errs)}
${textField("hours", "Opening hours", f.hours, errs)}
${textField("started", "Year you started", f.started, errs, { attrs: ' inputmode="numeric" maxlength="4"' })}
${textField("accreditations", "Accreditations or memberships, with numbers", f.accreditations, errs, { placeholder: "e.g. Gas Safe 123456, NICEIC, TrustMark" })}
${textField("guarantee", "Guarantee on your work", f.guarantee, errs, { placeholder: "e.g. 10-year guarantee on new roofs" })}
</section>`;

  const where = `<section>
<h2>Where you work</h2>
<p class="help">${t("List the towns and areas you cover, your main town first. The next 8 each get their own page.")}</p>
<ul class="chips" id="area-list">
${f.areas.map(chip).join("\n")}
</ul>
<div class="row"><input type="text" id="area-add" placeholder="Add a town or area" aria-label="Add a town or area"><button type="button" class="btn-line" id="area-btn">Add</button></div>
${errLine("areas", errs)}
</section>`;

  const about = `<section>
<h2>About you</h2>
${areaField("about", "About you", f.about, errs, { help: "This goes on your About page. Edit it so it sounds like you.", rows: 8 })}
</section>`;

  const photos = `<section>
<h2>Photos</h2>
<p>${t("We'll use the photos from your current website and your Google listing. Want others used, from your phone or social media? Reply to our welcome email with them attached (up to 10). You can't upload here yet.")}</p>
${areaField("photos_note", "Anything about photos we should know?", f.photos_note, errs, { rows: 3 })}
</section>`;

  const d = f.domain;
  const domainHelp = full
    ? "We'll register the first one that's free, in your name: you own it. We pay the yearly fee (about £10) while you're on the monthly plan."
    : "We'll register the first one that's free, in your name: you own it. The first year is included; after that it renews at about £10 a year.";
  const domain = `<section>
<h2>Your web address</h2>
${radios("domain.has", "Do you already have a web address (domain)?", [["yes", "Yes"], ["no", "No: buy me one"]], d.has, errs)}
<div id="dom-yes"${d.has === "yes" ? "" : " hidden"}>
${textField("domain.name", "Which one? (e.g. smithroofing.co.uk)", d.name, errs, { required: true, attrs: ' autocapitalize="off" autocorrect="off" spellcheck="false"' })}
${textField("domain.registrar", "Who is it with?", d.registrar, errs, { placeholder: "e.g. GoDaddy, 123-reg, IONOS, Namecheap, Wix. Not sure is fine" })}
${radios("domain.can_login", "Can you log in to it?", YES_NO_SURE, d.can_login, errs)}
${radios("domain.email_on_it", "Do you use email on it (like you@smithroofing.co.uk)?", YES_NO_SURE, d.email_on_it, errs)}
</div>
<div id="dom-no"${d.has === "no" ? "" : " hidden"}>
<fieldset id="${idFor("domain.choices")}">
<legend>${t("Give us 3 names you'd like, favourite first")} *</legend>
<p class="help">${t(domainHelp)}</p>
${[0, 1, 2].map((i) => `<input type="text" data-k="domain.choices.${i}" value="${h(d.choices[i])}" aria-label="Name ${i + 1}" autocapitalize="off" autocorrect="off" spellcheck="false" style="margin-bottom:8px">`).join("\n")}
${errLine("domain.choices", errs)}
</fieldset>
</div>
</section>`;

  const g = f.gbp;
  const gbp = full ? `<section>
<h2>Google Business Profile</h2>
${radios("gbp.has", "Do you have a Google Business Profile (your listing on Google Maps)?", YES_NO_SURE, g.has, errs)}
<div id="gbp-yes"${g.has === "yes" ? "" : " hidden"}>
${gbpSteps(gbpEmail)}
<label class="opt"><input type="checkbox" data-k="gbp.invite_sent"${g.invite_sent ? " checked" : ""}> ${t("I've sent the invite")}</label>
</div>
<p id="gbp-no"${g.has === "no" ? "" : " hidden"}>${t("No problem. We'll set it up with you after you send this form. Google will ask you to verify it, usually with a short video of your van, tools or premises.")}</p>
<p id="gbp-not_sure"${g.has === "not_sure" ? "" : " hidden"}>${t("We'll check for you.")}</p>
</section>` : "";

  const reviews = full ? `<section>
<h2>Reviews</h2>
${textField("review_link", "Your Google review link (optional)", f.review_link, errs, { type: "text", help: "In your Google Business Profile, tap 'Ask for reviews' (or 'Get more reviews') and copy the link. If you skip this, we'll use your listing's review link.", attrs: ' inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false"' })}
</section>` : "";

  const notes = `<section>
<h2>Anything else?</h2>
${areaField("notes", "Anything else?", f.notes, errs, { rows: 4 })}
</section>`;

  const summary = `<div id="errs" role="alert"${errKeys.length ? "" : " hidden"}>
<p><strong>${t(FORM_ERRORS.summary)}</strong></p>
<ul>${errKeys.map((k) => `<li>${h(errs[k])}</li>`).join("")}</ul>
</div>`;

  const body = `<h1>Your website, live in 7 days</h1>
<p id="status" role="status" aria-live="polite"></p>
<p class="lead">${intro}</p>
<form id="ob" novalidate>
${summary}
${details}
${what}
${where}
${about}
${photos}
${domain}
${gbp}
${reviews}
${notes}
<button type="button" class="btn send" id="send">Send: start my 7 days</button>
<p class="help">Your website will be live by <span id="due">${dueDay(now)}</span> (7 days from now), guaranteed.</p>
</form>
<script type="application/json" id="form-data">${scriptJson(f)}</script>`;

  return page("Your website, live in 7 days", body, { script: onboardScript(token) });
}

const yn = (v) => ({ yes: "Yes", no: "No", not_sure: "Not sure" })[v] || "";

/** The thanks page after Send, with a read-only summary of the answers. */
export function renderOnboardDone({ first, dueIso, form, package: pkg } = {}) {
  const f = normaliseForm(form);
  const name = trim(first);
  let day = "";
  try {
    day = dueIso ? ukShortDay(dueIso) : "";
  } catch {
    day = "";
  }
  const live = day ? `Your website will be live by ${h(day)}.` : "Your website will be live within 7 days.";
  const thanks = `${name ? `Thanks, ${h(name)}!` : "Thanks!"} ${live} ${t("We'll email you the moment it's live. Need to change an answer? Just reply to our email.")}`;

  const rows = [];
  const add = (label, value) => {
    const v = String(value ?? "").trim();
    if (v) rows.push(`<dt>${t(label)}</dt><dd>${h(v)}</dd>`);
  };
  const b = f.business;
  add("Business name", b.name);
  add("Phone number customers should call", b.phone);
  add("Email for customers", b.email);
  add("Address", b.address);
  add("Show your address on the website?", b.show_address === "yes" ? "Yes" : b.show_address === "no" ? "No, show my town only" : "");
  add("Your name for the footer", b.legal_line);
  add("Website enquiries go to", b.leads_email);
  add("Services", f.services.filter((s) => s.on && trim(s.name)).map((s) => trim(s.name)).join(", "));
  add("Free quotes", yn(f.free_quotes));
  add("Emergency call-outs", yn(f.emergency));
  add("Opening hours", f.hours);
  add("Year you started", f.started);
  add("Accreditations or memberships", f.accreditations);
  add("Guarantee on your work", f.guarantee);
  add("Where you work", texts(f.areas).join(", "));
  add("About you", f.about);
  add("Photos", f.photos_note);
  if (f.domain.has === "yes") {
    add("Your web address", f.domain.name);
    add("Who it's with", f.domain.registrar);
    add("Can you log in to it?", yn(f.domain.can_login));
    add("Email on it?", yn(f.domain.email_on_it));
  } else if (f.domain.has === "no") {
    add("Names you'd like", texts(f.domain.choices).join(", "));
  }
  if (pkg !== "website") {
    add("Google Business Profile", yn(f.gbp.has));
    if (f.gbp.has === "yes") add("Invite sent", f.gbp.invite_sent ? "Yes" : "Not yet");
    add("Google review link", f.review_link);
  }
  add("Anything else", f.notes);

  const body = `<h1>Thank you</h1>
<p class="lead">${thanks}</p>
<section>
<h2>Your answers</h2>
<dl>
${rows.join("\n")}
</dl>
</section>`;
  return page("Thank you", body);
}

/** The 404 page for a token we don't know. */
export function renderBadToken() {
  return page("Link not valid", `<h1>Link not valid</h1>
<p class="lead">${t(BAD_TOKEN)}</p>`);
}
