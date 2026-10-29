// The Sites list (#/sites) and one client's Site page (#/site/<client_id>) as pure HTML builders (stage 10,
// docs/rebuild/09-build.md section 13, Part B Task 25): sitesRows(list) draws GET /api/sites, siteView(detail) draws
// GET /api/sites/<client_id>. sites.js puts them on the page and wires the buttons through data-* attributes:
//   data-act="approve|rebuild|offline|online|check"   the buttons
//   data-form="changes|host|nameservers|review"         the forms
//   data-step="<id>", data-gbp="<tick>", data-feature="chatbot|review_booster"   the checkboxes
//   data-send-email="nameservers|cname", data-copy="sms|email|reminder", data-add-photos, data-del-photo="<id>"
//
// The business's answers, Claude's content and errors, visitors' enquiries and DNS details are untrusted: every value
// goes through esc(), links only through linkHref() (our own "/…" paths or http(s), else no link), photos only from
// /s/f/<id>, and the QR code only as an <img> (an SVG in an image can't run anything). This file imports only html.js
// (never lib.js, which reads the page when it loads), so tests/sites-page.test.mjs runs it in node.
import { esc, safeUrl } from "./html.js";

const EMPTY = "No client sites yet. When a client sends their onboarding form, their site appears here.";
const GBP_NOT_LIVE = "Tick this once the site is live: the day you tick it starts the 90 days.";
const LEVELS = new Set(["red", "amber", "green", "grey"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const listOf = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const count = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Our own path ("/c/…", "/w/…": one leading slash, no spaces or backslashes) or an http(s) link; else "". */
function linkHref(value) {
  const s = str(value);
  if (/^\/(?!\/)[^\s\\"'<>]*$/.test(s)) return s;
  return safeUrl(s);
}

/** "due due-red" etc.: the countdown's colour (unknown levels are grey). */
const dueClass = (level) => `due due-${LEVELS.has(level) ? level : "grey"}`;

function countdownHtml(cd) {
  const c = isObj(cd) ? cd : {};
  const label = str(c.label);
  return label ? `<span class="${dueClass(c.level)}">${esc(label)}</span>` : "";
}

function statusBadge(status, liveAt, label) {
  const cls = status === "live" && liveAt ? "good" : status === "review" ? "gold" : status === "off" ? "bad" : status === "live" ? "warn" : "";
  return `<span class="badge${cls ? ` ${cls}` : ""}">${esc(label)}</span>`;
}

const testTag = (isTest) => (isTest === true || Number(isTest) === 1 ? ' <span class="tag">Test</span>' : "");

const UK_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
const UK_WHEN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});

/** Today's UK date "YYYY-MM-DD" (the day stage 11's access action stores as gbp_access_on). */
export function ukToday(now = new Date()) {
  const p = Object.fromEntries(UK_DAY.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** "Tue 27 Oct, 10:05" in UK time; "" for anything that isn't a date. */
function whenUk(isoStr) {
  const d = new Date(String(isoStr ?? ""));
  if (!isoStr || Number.isNaN(d.getTime())) return "";
  return UK_WHEN.format(d).replace(/^(\w{3}),? /, "$1 ");
}

// ---------------------------------------------------------------- the Sites list

function siteRow(s) {
  const id = str(s.client_id);
  const href = `#/site/${encodeURIComponent(id)}`;
  const name = str(s.name) || "Unnamed client";
  const host = str(s.host);
  const address = host ? `${esc(host)}${s.live === true ? ' <span class="ok-text">✓</span>' : ""}` : '<span class="muted">No address yet</span>';
  return `<tr class="click" data-href="${esc(href)}">
  <td><a class="biz" href="${esc(href)}">${esc(name)}</a>${testTag(s.is_test)}</td>
  <td>${esc(str(s.status_label))}</td>
  <td>${countdownHtml(s.countdown)}</td>
  <td class="site-host">${address}</td>
  <td class="r num">${count(s.enquiries_30d)}</td>
</tr>`;
}

/** GET /api/sites → the list's table (Client · Status · Due · Address · Enquiries in 30 days), or the empty state. */
export function sitesRows(list) {
  const rows = listOf(list).filter((s) => str(s.client_id));
  if (!rows.length) return `<div class="empty-state"><p>${esc(EMPTY)}</p></div>`;
  return `<div class="table-card"><div class="table-wrap"><table class="sites-table">
<thead><tr><th>Client</th><th>Status</th><th>Due</th><th>Address</th><th class="r">Enquiries</th></tr></thead>
<tbody>${rows.map(siteRow).join("")}</tbody>
</table></div></div>`;
}

// ---------------------------------------------------------------- the Site page

// One section of the Site page; `key` (data-card) is where sites.js shows that section's messages after a redraw.
const card = (key, title, body) => `<section class="card site-card" data-card="${key}"><div class="card-head"><h2>${esc(title)}</h2></div>${body}</section>`;

function checkSection(d) {
  const pages = listOf(d.pages).filter((p) => typeof p.path === "string");
  const rows = pages.map((p) => {
    const href = linkHref(p.preview);
    const path = esc(p.path);
    const link = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${path}</a>` : path;
    return `<tr><td>${link}</td><td>${esc(str(p.title))}</td><td class="r num">${count(p.words)}</td></tr>`;
  });
  const table = rows.length
    ? `<div class="table-wrap"><table class="site-pages"><thead><tr><th>Page (opens the preview)</th><th>Title</th><th class="r">Words</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<p class="muted">${d.submitted_at ? "Claude hasn't posted the site yet." : "Waiting for their onboarding form: there's nothing to build until they press Send."}</p>`;

  const temp = linkHref(d.temp_url);
  const links = temp
    ? `<p class="site-links"><a class="btn secondary sm" href="${esc(temp)}" target="_blank" rel="noopener">Open the temporary link</a> <span class="hint">Send this to the client if their domain is slow: it works now.</span></p>`
    : "";

  const buttons = [];
  if (d.status === "review") buttons.push('<button class="btn" data-act="approve">Approve and put live</button>');
  if (d.status === "draft" && !d.has_content && d.submitted_at) buttons.push('<button class="btn secondary" data-act="rebuild">Build again</button>');
  if (d.status === "off") buttons.push('<button class="btn secondary" data-act="online">Put back online</button>');
  else buttons.push('<button class="btn danger sm" data-act="offline">Take offline</button>');

  const changes = d.has_content
    ? `<details class="site-changes-wrap"><summary class="btn secondary">Ask Claude for changes</summary><form class="site-changes" data-form="changes">
  <label for="site-notes">What should Claude change?</label>
  <textarea id="site-notes" name="notes" rows="3" maxlength="4000" placeholder="e.g. Make the phone number bigger on the home page"></textarea>
  <div class="actions"><button class="btn secondary" type="submit">Send to Claude</button></div>
  <p class="hint">${d.status === "live" ? "The site stays live and gets the change when Claude posts it." : "The site goes back to Claude, then comes back here to approve."}</p>
</form></details>`
    : "";

  return card("check", "Check the site", `${table}${links}<div class="actions site-buttons">${buttons.join("")}</div>${changes}`);
}

const MODE_WORDS = {
  buy: "They need a domain: buy one for them.",
  nameservers: "They have a domain and can log in: move it to Cloudflare.",
  cname: "They have a domain but can't log in: whoever runs it points www at us.",
};

function stepHtml(s) {
  const id = str(s.id);
  const done = Boolean(s.done_at);
  const send = id === "ns_email" ? "nameservers" : id === "cname_email" ? "cname" : "";
  const sendBtn = send ? ` <button class="btn secondary sm" type="button" data-send-email="${send}">Write the email</button>` : "";
  const auto = s.auto ? '<div class="hint">Ticks itself once the domain\'s nameservers have switched to Cloudflare.</div>' : "";
  const when = done && whenUk(s.done_at) ? `<div class="hint">Done ${esc(whenUk(s.done_at))}</div>` : "";
  return `<li class="site-step${done ? " done" : ""}">
  <label class="check-line"><input type="checkbox" data-step="${esc(id)}"${done ? " checked" : ""}${s.auto ? " disabled" : ""}> <span>${esc(str(s.title))}</span></label>
  <div class="step-detail">${esc(str(s.detail))}${sendBtn}</div>${auto}${when}
</li>`;
}

function domainSection(d) {
  const host = str(d.host);
  const bare = host.replace(/^www\./, "");
  const mode = str(d.mode);
  const choices = (Array.isArray(d.form?.domain?.choices) ? d.form.domain.choices : []).map(str).filter(Boolean);
  const intro = MODE_WORDS[mode]
    ? `<p>${esc(MODE_WORDS[mode])}${mode === "buy" && choices.length ? ` Their picks: ${esc(choices.join(", "))}.` : ""}</p>`
    : '<p class="muted">The steps appear once they send their onboarding form.</p>';

  const hostForm = `<form class="site-inline" data-form="host">
  <label for="site-host">Website address</label>
  <div class="site-inline-row"><input id="site-host" name="host" value="${esc(bare)}" placeholder="smithroofing.co.uk" autocomplete="off" spellcheck="false"><button class="btn secondary" type="submit">Save</button></div>
  <p class="hint">Type it like smithroofing.co.uk${host ? `. The site is served on ${esc(host)}.` : "."}</p>
</form>`;

  const steps = listOf(d.steps);
  const stepList = steps.length ? `<ol class="site-steps">${steps.map(stepHtml).join("")}</ol>` : "";

  let ns = "";
  if (mode === "nameservers") {
    const list = Array.isArray(d.nameservers) ? d.nameservers.map(str) : [];
    ns = `<form class="site-inline" data-form="nameservers">
  <label>Cloudflare's two nameservers for ${esc(bare || "the domain")}</label>
  <div class="site-inline-row"><input name="ns1" aria-label="First nameserver" value="${esc(list[0] ?? "")}" placeholder="ada.ns.cloudflare.com" autocomplete="off" spellcheck="false"><input name="ns2" aria-label="Second nameserver" value="${esc(list[1] ?? "")}" placeholder="bob.ns.cloudflare.com" autocomplete="off" spellcheck="false"><button class="btn secondary" type="submit">Save</button></div>
</form>`;
  }

  const hc = isObj(d.host_check) ? d.host_check : null;
  let check = "";
  if (host) {
    const line = hc && str(hc.detail)
      ? `<p class="dns-line ${hc.ok ? "ok-text" : "bad-text"}" data-dns-detail>${esc(str(hc.detail))}${whenUk(hc.at) ? ` <span class="hint">checked ${esc(whenUk(hc.at))}</span>` : ""}</p>`
      : '<p class="muted" data-dns-detail>Not checked yet.</p>';
    const openUrl = safeUrl(`https://${host}/`);
    // The first https visit on the host stamps seen_at, but only once the site is approved (status live): before
    // that the host shows "This website isn't set up yet." and opening it finishes nothing (section 7).
    const ready = hc?.ok === true && !d.seen_at;
    const open = ready && d.status === "live" && openUrl
      ? `<div class="banner info site-open">${esc(`DNS is ready. Open https://${host} once to finish.`)} <a class="btn sm" href="${esc(openUrl)}" target="_blank" rel="noopener" data-open-host>${esc(`Open ${host}`)}</a></div>`
      : ready && (d.status === "review" || d.status === "draft")
        ? '<p class="hint site-open">DNS is ready: the site goes public once you approve it.</p>'
        : "";
    check = `<div class="site-check">${line}<button class="btn secondary sm" data-act="check">Check now</button></div>${open}`;
  }
  return card("domain", "Domain", `${intro}${hostForm}${stepList}${ns}${check}`);
}

const GBP_WORDS = {
  yes: "Yes: they have one.",
  no: "No: create one with them.",
  not_sure: "Not sure: check whether they have one.",
};

function gbpSection(d) {
  const g = isObj(d.gbp) ? d.gbp : {};
  const answer = GBP_WORDS[g.answer] || "Not answered yet.";
  const sent = g.answer === "yes" ? (g.invite_sent ? " They say they've sent the invite." : " They haven't sent the invite yet.") : "";
  const live = Boolean(d.live_at);
  const invite = `<label class="check-line"><input type="checkbox" data-gbp="invite_accepted"${g.invite_accepted ? " checked" : ""}${live ? "" : " disabled"}> <span>Invite accepted</span></label>
<p class="hint">${esc(live ? "The day you tick it starts the 90 days." : GBP_NOT_LIVE)}</p>`;
  const created = `<label class="check-line"><input type="checkbox" data-gbp="profile_created"${g.profile_created ? " checked" : ""}> <span>Profile created</span></label>`;
  return card("gbp", "Google Business Profile", `<p>${esc(answer + sent)}</p><div class="site-ticks">${invite}${created}</div>`);
}

function qrImg(svg) {
  const s = typeof svg === "string" ? svg.trim() : "";
  if (!s.startsWith("<svg")) return "";
  return `<img class="site-qr" src="${esc(`data:image/svg+xml,${encodeURIComponent(s)}`)}" width="160" height="160" alt="QR code for their Google review link">`;
}

function messageBlock(key, label, text) {
  return `<div class="site-msg-block"><div class="site-msg-head"><b>${esc(label)}</b><button class="btn secondary sm" type="button" data-copy="${key}">Copy</button></div>
<pre class="site-msg" data-copy-text="${key}">${esc(text)}</pre></div>`;
}

const QR_TOO_LONG = "This link is too long to print as a QR code, so there's no printable card. Paste the short link from their Google Business Profile (Get more reviews) above, e.g. https://g.page/r/...";

function reviewSection(d) {
  const r = isObj(d.review) ? d.review : {};
  const url = safeUrl(str(r.url));
  const form = `<form class="site-inline" data-form="review">
  <label for="site-review">Their Google review link</label>
  <div class="site-inline-row"><input id="site-review" name="review_url" value="${esc(url)}" placeholder="https://g.page/r/…/review" autocomplete="off" spellcheck="false"><button class="btn secondary" type="submit">Save</button></div>
  <p class="hint">Leave it empty to use the link from their form, else Google's own link for their listing.</p>
</form>`;
  const booster = r.booster === true;
  const cardUrl = safeUrl(str(r.card_url));
  // A link whose QR wouldn't fit the printed card (the API's cardQr gives no QR then): say what to paste instead.
  const tooLong = Boolean(url) && !str(r.qr_svg);
  const cardLine = !booster
    ? '<p class="muted">The printable review card is switched off for this client, and their emails don\'t mention it.</p>'
    : tooLong
      ? `<p class="muted">${esc(QR_TOO_LONG)}</p>`
      : cardUrl
      ? `<p><a class="btn secondary sm" href="${esc(cardUrl)}" target="_blank" rel="noopener">Open the printable card</a></p>`
      : '<p class="muted">The printable card opens once the site is live.</p>';
  const m = isObj(r.messages) ? r.messages : null;
  const email = isObj(m?.email) ? `Subject: ${str(m.email.subject)}\n\n${String(m.email.body ?? "")}` : "";
  const messages = url && m
    ? [
      messageBlock("sms", "Text or WhatsApp, the day the job finishes", String(m.sms ?? "")),
      messageBlock("email", "Email, the day the job finishes", email),
      messageBlock("reminder", "Reminder, 3–5 days later (text or email)", String(m.reminder ?? "")),
    ].join("")
    : '<p class="muted">No review link yet: paste their Google review link above.</p>';
  const toggle = `<label class="check-line"><input type="checkbox" data-feature="review_booster"${booster ? " checked" : ""}> <span>Printable review card for this client</span></label>`;
  return card("review", "Review booster", `${form}<div class="site-qr-row">${url ? qrImg(r.qr_svg) : ""}<div>${cardLine}${toggle}</div></div>${messages}`);
}

function chatSection(d) {
  const c = isObj(d.chat) ? d.chat : {};
  // Website Only never has the chat (section 11), whatever the answer says.
  const state = c.on === true && d.package !== "website"
    ? '<span class="badge good" data-chat-state="on">On</span>'
    : `<span class="badge plain" data-chat-state="off">${esc(`Off: ${str(c.reason) || "not switched on"}`)}</span>`;
  const nums = `<p class="muted">Messages today: <b class="num">${count(c.today)}</b> · this month: <b class="num">${count(c.month)}</b> · fallbacks today: <b class="num">${count(c.fallbacks_today)}</b></p>`;
  const on = !(isObj(d.features) && d.features.chatbot === false);
  const toggle = d.package === "website"
    ? ""
    : `<label class="check-line"><input type="checkbox" data-feature="chatbot"${on ? " checked" : ""}> <span>Chatbot for this client</span></label>`;
  return card("chat", "Chatbot", `<p>${state}</p>${nums}${toggle}`);
}

function leadsSection(d) {
  const leads = listOf(d.leads);
  if (!leads.length) return card("leads", "Enquiries", '<p class="muted">No enquiries yet.</p>');
  const rows = leads.map((l) => `<tr>
  <td class="nowrap">${esc(whenUk(l.created_at))}</td>
  <td>${esc(l.source === "chat" ? "Chat" : l.source === "form" ? "Form" : str(l.source))}</td>
  <td>${esc(str(l.name))}</td><td class="nowrap">${esc(str(l.phone))}</td><td>${esc(str(l.email))}</td>
  <td class="site-lead-msg">${esc(Array.from(str(l.message)).slice(0, 120).join(""))}</td>
</tr>`).join("");
  return card("leads", "Enquiries", `<div class="table-wrap"><table class="site-leads"><thead><tr><th>When</th><th>From</th><th>Name</th><th>Phone</th><th>Email</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

const FILE_URL = /^\/s\/f\/[A-Za-z0-9_-]{1,64}$/;

function photosSection(d) {
  const files = listOf(d.files).filter((f) => FILE_URL.test(str(f.url)));
  const thumbs = files.map((f) => {
    const w = count(f.width) || 160;
    const h = count(f.height) || 120;
    return `<figure class="site-photo">
  <img src="${esc(f.url)}" alt="${esc(str(f.alt))}" width="${w}" height="${h}" loading="lazy">
  <figcaption><span>${esc(str(f.alt) || "No alt text")}${f.kind === "logo" ? ' <span class="tag">Logo</span>' : ""}</span><button class="icon-btn" type="button" title="Delete this photo" aria-label="Delete this photo" data-del-photo="${esc(str(f.id))}">×</button></figcaption>
</figure>`;
  }).join("");
  const add = `<div class="site-add-photos">
  <label for="site-photo-alt">Add photos</label>
  <div class="site-inline-row"><input id="site-photo-alt" data-photo-alt placeholder="What's in the photo, e.g. A new slate roof in Swindon"><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple data-add-photos></div>
  <p class="hint">Shrunk on this device before upload. Up to 12 photos per site, 400 KB each.</p>
</div>`;
  return card("photos", "Photos", `${thumbs ? `<div class="site-photos">${thumbs}</div>` : '<p class="muted">No photos yet.</p>'}${add}`);
}

const YN = { yes: "Yes", no: "No", not_sure: "Not sure" };

function answersSection(d) {
  const f = isObj(d.form) ? d.form : {};
  const b = isObj(f.business) ? f.business : {};
  const rows = [];
  const add = (label, value) => {
    const v = String(value ?? "").trim();
    if (v) rows.push(`<dt>${esc(label)}</dt><dd>${esc(v)}</dd>`);
  };
  add("Business name", b.name);
  add("Phone number customers should call", b.phone);
  add("Email for customers", b.email);
  add("Address", b.address);
  add("Show the address on the website?", b.show_address === "yes" ? "Yes" : b.show_address === "no" ? "No, town only" : "");
  add("Name for the footer", b.legal_line);
  add("Website enquiries go to", b.leads_email);
  add("Services", listOf(f.services).filter((s) => s.on && str(s.name)).map((s) => str(s.name)).join(", "));
  add("Free quotes", YN[f.free_quotes]);
  add("Emergency call-outs", YN[f.emergency]);
  add("Opening hours", f.hours);
  add("Year they started", f.started);
  add("Accreditations or memberships", f.accreditations);
  add("Guarantee on their work", f.guarantee);
  add("Where they work", (Array.isArray(f.areas) ? f.areas : []).map(str).filter(Boolean).join(", "));
  add("About them", f.about);
  add("Photos", f.photos_note);
  const dom = isObj(f.domain) ? f.domain : {};
  if (dom.has === "yes") {
    add("Their web address", dom.name);
    add("Who it's with", dom.registrar);
    add("Can they log in to it?", YN[dom.can_login]);
    add("Email on it?", YN[dom.email_on_it]);
  } else if (dom.has === "no") {
    add("Names they'd like", (Array.isArray(dom.choices) ? dom.choices : []).map(str).filter(Boolean).join(", "));
  }
  if (d.package !== "website") {
    const g = isObj(f.gbp) ? f.gbp : {};
    add("Google Business Profile", YN[g.has]);
    if (g.has === "yes") add("Invite sent", g.invite_sent ? "Yes" : "Not yet");
    add("Google review link", f.review_link);
  }
  add("Anything else", f.notes);
  const body = rows.length ? `<dl class="kv site-answers">${rows.join("")}</dl>` : '<p class="muted">They haven\'t filled in the form yet.</p>';
  return card("answers", "Their answers", body);
}

/** GET /api/sites/<client_id> → the whole Site page. */
export function siteView(detail) {
  const d = isObj(detail) ? detail : {};
  const name = str(d.name) || str(d.form?.business?.name) || "This client";
  const head = `<div class="page-head"><div><h1>${esc(name)}${testTag(d.is_test)}</h1>
<p class="site-head-line">${statusBadge(d.status, d.live_at, str(d.label))} ${countdownHtml(d.countdown)}</p></div>
<div class="actions"><a class="btn ghost sm" href="#/sites">All client sites</a></div></div>`;

  const notes = str(d.change_notes) && d.status !== "review"
    ? `<div class="banner info">Claude is making these changes: ${esc(str(d.change_notes))}</div>`
    : "";
  const errs = Array.isArray(d.last_errors) ? d.last_errors.map((e) => str(typeof e === "string" ? e : e?.error ?? "")).filter(Boolean) : [];
  const refused = errs.length
    ? `<div class="banner warn site-refused"><b>${esc("Claude's last try was refused:")}</b><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
    : "";

  const full = d.package !== "website";
  const sections = [
    checkSection(d),
    domainSection(d),
    full ? gbpSection(d) : "",
    full ? reviewSection(d) : "",
    chatSection(d),
    leadsSection(d),
    photosSection(d),
    answersSection(d),
  ].filter(Boolean);
  return `<div class="site-page" data-client="${esc(str(d.client_id))}">${head}${notes}${refused}<div class="stack">${sections.join("")}</div></div>`;
}
