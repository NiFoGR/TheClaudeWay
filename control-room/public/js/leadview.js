// The Leads page's HTML (stage 3, docs/rebuild/04-shortlist.md): grade badges, a list row, the capacity banner, the
// view tabs with the grade chips and filters, the lead panel (drawer) and its read-only conversation. Pure: it never
// reads or writes the page and imports nothing that does (html.js, researchcard.js, callscript.js), so node tests load
// it with no page at all (tests/leadview.test.mjs). leads.js fetches GET /api/leads and GET /api/leads/:id, puts this
// HTML on the page and wires the data-* hooks each function names.
// Scraped, inbound and Claude-written text is untrusted: every value goes through esc(), every outside link through
// safeUrl() (http(s) only; anything else is shown as plain text). Our own links are relative: the demo's /d/<slug> (on
// the Control Room host, so Nik's own visits never count) and in-app #/… links.

import { callScript } from "./callscript.js";
import { esc, icon, safeUrl } from "./html.js";
import { researchCard } from "./researchcard.js";

/** Stage labels for the chips and badges: the server's STAGE_LABELS (functions/_lib/shortlist.js), copied as data. */
export const STAGE_LABELS = Object.freeze({
  ready: "Ready to email", emailed: "Emailed", viewed: "Opened demo", replied: "Replied", needs_nik: "Needs you",
  call_booked: "Call booked", won: "Won", lost: "Lost", none: "Not contacted",
});
const STAGES = Object.keys(STAGE_LABELS); // the server's STAGE_TOKENS order

// Grade chips: [value as the filters hold it, label]. Ready shows only the first three.
const GRADE_CHIPS = [["A+", "A+"], ["A", "A"], ["B", "B"], ["C", "C"], ["D", "D"], ["none", "Not graded"]];
const READY_CHIPS = ["A+", "A", "B"];
const GRADE_CLASS = { "A+": "aplus", A: "a", B: "b", C: "c", D: "d" };
const STAGE_TONE = { won: "good", lost: "bad", replied: "gold", needs_nik: "warn", call_booked: "gold" };
const BANNER_TONES = ["ok", "info", "warn"];
const WHO = { nik: "You", claude: "Claude", system: "Automatic", them: "Them" };
const KIND = { first: "First email", reply: "Reply", system: "System email" };
const STATUS_NOTE = { queued: "Waiting to go", sending: "Sending", failed: "Failed", cancelled: "Cancelled" };
const CLASS_NOTE = { bounce: "Bounced", auto: "Auto-reply", opt_out: "Opted out" };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const own = (map, key) => (typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined);
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
// A count from the payload (D1 numbers): a whole number, or null when it isn't one.
const countOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

// "1 Oct 2026" / "20 Oct 2026, 09:05" in UK time, or "" when there's no readable time. One formatter for every
// message (up to 100 a panel).
const UK_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function ukParts(isoTime) {
  const d = typeof isoTime === "string" && isoTime ? new Date(isoTime) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return Object.fromEntries(UK_PARTS.formatToParts(d).map((p) => [p.type, p.value]));
}
const ukDay = (t) => { const p = ukParts(t); return p ? `${p.day} ${p.month} ${p.year}` : ""; };
const ukDayTime = (t) => { const p = ukParts(t); return p ? `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}` : ""; };

// A phone number as a tel: link target (digits and a leading +), or "" when nothing's left.
const telOf = (phone) => {
  const digits = String(phone ?? "").replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return /\d/.test(digits) ? `tel:${digits}` : "";
};
// The live demo's relative link (/d/<slug>, as leadDetail builds it), or "" for anything else.
const demoHref = (demo) => (isObj(demo) && typeof demo.url === "string" && /^\/d\/[^/?#\s]+$/.test(demo.url) ? demo.url : "");
// An in-app link (#/… or /#/…) as given; anything else only when it's http(s).
const appHref = (href) => (typeof href === "string" && /^\/?#\/\S*$/.test(href) ? href : safeUrl(href));
const outLink = (href, body, cls = "") =>
  `<a${cls ? ` class="${cls}"` : ""} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${body}</a>`;

/** The grade badge: A+ (gold), A, B, C, D, or "–" for not graded (no research, a NULL grade or anything unknown). */
export function gradeBadge(grade) {
  const cls = own(GRADE_CLASS, grade);
  if (!cls) return `<span class="grade none" title="Not graded">–</span>`;
  return `<span class="grade ${cls}" title="Grade ${esc(grade)}">${esc(grade)}</span>`;
}

// The stage badge (the payload's stage_label, else ours; "Not contacted" with no prospect) and "Hot" when hot.
function stageBadge(stage, label, hot) {
  const text = str(label) || own(STAGE_LABELS, stage ?? "none") || STAGE_LABELS.none;
  const tone = own(STAGE_TONE, stage);
  return `<span class="badge${tone ? ` ${tone}` : ""}">${esc(text)}</span>${hot === true ? ` <span class="badge gold">Hot</span>` : ""}`;
}

/**
 * One row of the leads table (GET /api/leads rows): Grade | Business | Why | Email | Stage | Score. The <tr> carries
 * data-id (the place_id) for leads.js's click → openLeadDrawer; selected adds "sel".
 */
export function leadRowHtml(row, { selected = false } = {}) {
  const r = isObj(row) ? row : {};
  const sub = [str(r.trade), str(r.town), str(r.owner_first) ? `Owner: ${str(r.owner_first)}` : ""].filter(Boolean).join(" · ");
  const why = str(r.grade_reason) || str(r.top_issue)
    || (!r.research_status ? "Not researched yet" : r.research_status === "queued" ? "Waiting for Claude" : "");
  const score = finite(Number(r.quality_score));
  return `<tr class="click${selected ? " sel" : ""}" data-id="${esc(r.place_id)}">
    <td class="c-grade">${gradeBadge(r.grade)}</td>
    <td class="c-biz"><div class="biz">${esc(r.name)}${r.excluded === true ? ` <span class="tag">Excluded</span>` : ""}</div>${sub ? `<div class="sub-line">${esc(sub)}</div>` : ""}</td>
    <td class="c-why"><div class="why">${why ? esc(why) : `<span class="faint">–</span>`}</div></td>
    <td class="c-email">${str(r.email) ? esc(r.email) : `<span class="faint">No email</span>`}${r.suppressed === true ? ` <span class="tag">Do not email</span>` : ""}</td>
    <td class="c-stage">${stageBadge(r.stage, r.stage_label, r.hot)}</td>
    <td class="c-score"><b class="num">${score === null ? "–" : esc(Math.round(score))}</b></td>
  </tr>`;
}

/** The capacity banner (capacityBanner's {tone, text, link}): tone ok | info | warn, its link only in-app or http(s). */
export function bannerHtml(banner) {
  if (!isObj(banner) || !str(banner.text)) return "";
  const tone = BANNER_TONES.includes(banner.tone) ? banner.tone : "info";
  const link = isObj(banner.link) ? banner.link : null;
  const href = link ? appHref(link.href) : "";
  return `<div class="banner ${tone}" role="status"><span>${esc(banner.text)}</span>${href && str(link.label) ? ` <a href="${esc(href)}">${esc(link.label)}</a>` : ""}</div>`;
}

const option = (value, label, picked) => `<option value="${esc(value)}"${value === picked ? " selected" : ""}>${esc(label)}</option>`;
const selectHtml = (id, label, options, picked) =>
  `<label class="filter"><span>${esc(label)}</span><select id="${id}">${options.map(([v, t]) => option(v, t, picked)).join("")}</select></label>`;
const flagValue = (v) => (v === true ? "1" : v === false ? "0" : "");

// A facet's options ([value, "value (n)"]), keeping a value from the URL that isn't in the list so it stays picked.
function facetOptions(list, picked, anyLabel) {
  const items = (Array.isArray(list) ? list : []).filter((f) => isObj(f) && str(f.value));
  const options = [["", anyLabel], ...items.map((f) => [f.value, countOf(f.n) === null ? f.value : `${f.value} (${f.n})`])];
  if (str(picked) && !items.some((f) => f.value === picked)) options.push([picked, picked]);
  return options;
}

/**
 * The view tabs, grade chips, (All leads only) stage chips, then the filters and search, for `query` (the filters as
 * parseLeadFilters gives them: grades hold grade values, "none" = not graded) and `data` (the GET /api/leads answer:
 * grade_counts, view_counts, facets, ready; the counts are null after page 1, so they're left out).
 * Hooks for leads.js: [data-view] tabs, [data-grade] and [data-stage] chips (aria-pressed), #f-trade, #f-town,
 * #f-email, #f-researched, #f-excluded, #f-search, and [data-clear-job] when the list is one scrape run's.
 * Ready shows only A+, A and B; B is greyed and disabled with "Spare room only" while today's room doesn't reach it.
 */
export function filterBarHtml(query, data) {
  const q = isObj(query) ? query : {};
  const d = isObj(data) ? data : {};
  const all = q.view === "all";
  const counts = isObj(d.grade_counts) ? d.grade_counts : null;
  const views = isObj(d.view_counts) ? d.view_counts : null;
  const grades = Array.isArray(q.grades) ? q.grades : [];
  const stages = Array.isArray(q.stages) ? q.stages : [];
  const bIncluded = isObj(d.ready) && d.ready.b_included === true;

  const tab = (view, label) => {
    const on = (view === "all") === all;
    const n = views ? countOf(views[view]) : null;
    return `<button class="${on ? "active" : ""}" role="tab" aria-selected="${on}" data-view="${view}">${label}${n === null ? "" : ` <span class="n">(${n})</span>`}</button>`;
  };
  const gradeChip = ([value, label]) => {
    const on = grades.includes(value);
    const n = counts ? countOf(counts[value]) : null;
    const spare = !all && value === "B" && !bIncluded;
    return `<button class="chip${on ? " on" : ""}${spare ? " off" : ""}" data-grade="${esc(value)}" aria-pressed="${on}"${spare
      ? ` disabled title="B leads join Ready when today's room is bigger than the A-grade leads waiting"` : ""}>${esc(label)}${n === null ? "" : ` <span class="n">${n}</span>`}${spare
      ? ` <span class="spare">Spare room only</span>` : ""}</button>`;
  };
  const stageChip = (stage) => {
    const on = stages.includes(stage);
    return `<button class="chip${on ? " on" : ""}" data-stage="${stage}" aria-pressed="${on}">${esc(STAGE_LABELS[stage])}</button>`;
  };
  const chips = GRADE_CHIPS.filter(([value]) => all || READY_CHIPS.includes(value));

  const filters = [
    selectHtml("f-trade", "Trade", facetOptions(d.facets?.trades, q.trade, "All trades"), str(q.trade) ? q.trade : ""),
    selectHtml("f-town", "Town searched", facetOptions(d.facets?.towns, q.town, "All towns"), str(q.town) ? q.town : ""),
    ...(all ? [
      selectHtml("f-email", "Has email", [["", "Any"], ["1", "Has email"], ["0", "No email"]], flagValue(q.email)),
      selectHtml("f-researched", "Researched", [["", "Any"], ["1", "Researched"], ["0", "Not researched"]], flagValue(q.researched)),
      `<label class="check"><input type="checkbox" id="f-excluded"${q.excluded === true ? " checked" : ""}> Show excluded</label>`,
    ] : []),
    `<div class="search-box">${icon("search")}<input id="f-search" type="search" maxlength="100" aria-label="Search" placeholder="Search name, town, phone, email, owner…" value="${esc(typeof q.q === "string" ? q.q : "")}"></div>`,
    str(q.job) ? `<button class="chip on" data-clear-job title="Show every lead again">From one search run ${icon("x")}</button>` : "",
  ].filter(Boolean);

  return `<div class="seg" role="tablist">${tab("ready", "Ready to email")}${tab("all", "All leads")}</div>
    <div class="chips" data-chips="grade">${chips.map(gradeChip).join("")}</div>
    ${all ? `<div class="chips" data-chips="stage">${STAGES.map(stageChip).join("")}</div>` : ""}
    <div class="toolbar filters">${filters.join("")}</div>`;
}

/**
 * The lead as callScript takes it, from a GET /api/leads/:id payload: the owner's first name only when research
 * marked it confident (else null), the address we'd write to, the demo link on `origin` (the Control Room's, from
 * leads.js) when a live demo exists, Maps only from their own town's scan ({} when none), and Claude's angle facts.
 */
export function scriptLead(detail, origin = "") {
  const d = isObj(detail) ? detail : {};
  const lead = isObj(d.lead) ? d.lead : {};
  const r = isObj(d.research) ? d.research : null;
  const owner = r && isObj(r.owner) ? r.owner : null;
  const demo = demoHref(d.demo);
  const base = typeof origin === "string" ? origin.replace(/\/+$/, "") : "";
  return {
    name: lead.name,
    trade: lead.trade,
    town: str(lead.town) || str(lead.search_town),
    rating: lead.rating,
    review_count: lead.review_count,
    findings: Array.isArray(lead.findings) ? lead.findings : [],
    map_rank: isObj(d.map_rank) ? d.map_rank : {},
    owner_first: owner?.confident === true && str(owner.first) ? str(owner.first) : null,
    email: str(d.prospect?.email) || str(lead.email) || null,
    demo_url: demo ? `${base}${demo}` : "",
    angle: r && Array.isArray(r.angle) ? r.angle : [],
  };
}

/**
 * The read-only conversation: every message as given (oldest first), plain text: who, when, what, the addresses, the
 * subject, and the body in <pre class="msg-body"> (inbound mail is never HTML). None: "Nothing sent yet."
 */
export function threadHtml(messages) {
  const list = Array.isArray(messages) ? messages.filter(isObj) : [];
  if (!list.length) return `<p class="muted">Nothing sent yet.</p>`;
  return `<div class="thread">${list.map(messageHtml).join("")}</div>`;
}

function messageHtml(m) {
  const who = own(WHO, m.author) || str(m.author) || (m.direction === "in" ? "Them" : "You");
  const when = ukDayTime(m.sent_at) || ukDayTime(m.received_at) || ukDayTime(m.created_at);
  const what = m.kind === "followup" ? `Follow-up${Number.isSafeInteger(m.step) ? ` ${m.step}` : ""}` : own(KIND, m.kind) || "";
  const note = own(STATUS_NOTE, m.status) || own(CLASS_NOTE, m.class) || "";
  const addrs = [str(m.from_addr), str(m.to_addr)].filter(Boolean).join(" → ");
  return `<div class="msg ${m.direction === "in" ? "in" : "out"}">
    <div class="msg-head"><b>${esc(who)}</b>${when ? ` · ${esc(when)}` : ""}${what ? ` · ${esc(what)}` : ""}${note ? ` <span class="badge plain">${esc(note)}</span>` : ""}</div>
    ${addrs ? `<div class="sub-line">${esc(addrs)}</div>` : ""}
    ${str(m.subject) ? `<div class="msg-subject">${esc(m.subject)}</div>` : ""}
    <pre class="msg-body">${esc(m.body)}</pre>
  </div>`;
}

// 2. Actions. Write first email only at stage ready (disabled when there's no mailbox, no room left today or the
// address is on the do-not-contact list; capacity unknown = enabled, the composer checks again); Not a fit only before
// the first email (no prospect, or ready).
function actionsHtml(d, capacity) {
  const lead = d.lead;
  const stage = isObj(d.prospect) ? d.prospect.stage : null;
  const c = isObj(capacity) ? capacity : null;
  const out = [];
  if (stage === "ready") {
    const why = d.suppressed === true ? "On the do-not-contact list"
      : c && finite(c.mailboxes) === 0 ? "Add a mailbox first"
        : c && finite(c.room) !== null && c.room <= 0 ? "No room left today" : "";
    out.push(`<button class="btn sm" data-write-email${why ? ` disabled title="${esc(why)}"` : ""}>${icon("send")} Write first email</button>${why
      ? `<span class="hint">${esc(why)}</span>` : ""}`);
  }
  const tel = telOf(lead.phone);
  if (tel) out.push(`<a class="btn secondary sm" href="${esc(tel)}">${icon("phone")} Call</a>`);
  const site = safeUrl(lead.website);
  if (site) out.push(outLink(site, `${icon("globe")} Website`, "btn secondary sm"));
  const maps = safeUrl(lead.maps_url);
  if (maps) out.push(outLink(maps, `${icon("pin")} Google`, "btn secondary sm"));
  const demo = demoHref(d.demo);
  if (demo) out.push(`<a class="btn secondary sm" href="${esc(demo)}" target="_blank" rel="noopener">${icon("external")} Open demo</a>`);
  if (!isObj(d.prospect) || stage === "ready") out.push(`<button class="btn secondary sm" data-not-a-fit>Not a fit</button>`);
  return `<div class="drawer-actions">${out.join("")}</div>`;
}

// 4. Demo: the heading, stage 4's #d-demo slot (leads.js mounts public/js/demo.js demoCardHtml there from GET
// /api/demo/lead/:id: the link, views and expiry, or why there's no demo, so they show once) and, for a live demo in a
// look, the Preview toggle (its frame waits in an inert <template> until pressed, so it's only built on demand;
// leads.js copies it into [data-preview-box]).
function demoHtml(d) {
  const template = demoHref(d.demo) ? str(d.demo.template) : "";
  const src = `/api/demo/preview?template=${encodeURIComponent(template)}&place_id=${encodeURIComponent(String(d.lead.place_id ?? ""))}`;
  const preview = template ? `<button class="btn secondary sm" data-preview-toggle aria-expanded="false">${icon("layout")} Preview</button>
    <template data-preview-frame><iframe class="demo-preview" sandbox="" loading="lazy" title="Preview of their demo site" src="${esc(src)}"></iframe></template>
    <div class="demo-preview-box" data-preview-box hidden></div>` : "";
  return `<h3>Demo site</h3>
    <div id="d-demo"></div>
    ${preview}`;
}

// 5. Google Maps (only their own town's scan reaches the payload): average rank, top-3 % of town, found %, Heatmap.
function mapsHtml(d) {
  const m = isObj(d.map_rank) ? d.map_rank : null;
  if (!m) return `<h3>Google Maps</h3><p class="muted">Not scanned yet.</p>`;
  const town = str(d.lead.search_town) || str(d.lead.town) || "town";
  const avg = finite(m.avg_rank);
  const top3 = finite(m.top3_pct);
  const found = finite(m.found_pct);
  const facts = [
    avg !== null ? `Average rank #${Math.round(avg)}` : found === 0 ? "Not in the top 20 anywhere we checked" : "",
    top3 !== null ? `Top 3 in ${Math.round(top3)}% of ${town}` : "",
    found !== null ? `Found in ${Math.round(found)}%` : "",
  ].filter(Boolean);
  const heatmap = str(m.scan_id)
    ? ` <a href="${esc(`#/maprank?scan=${encodeURIComponent(m.scan_id)}&biz=${encodeURIComponent(String(d.lead.place_id ?? ""))}`)}">${icon("grid")} Heatmap</a>`
    : "";
  return `<h3>Google Maps</h3><p>${esc(facts.join(" · ") || "Scanned, with no ranks saved.")}${str(m.keyword) ? ` <span class="muted small">(searching “${esc(m.keyword)}”)</span>` : ""}${heatmap}</p>`;
}

// 7. Top reviews: up to 3 with text (stars, author, text).
function reviewsHtml(lead) {
  const list = (Array.isArray(lead.reviews) ? lead.reviews : []).filter((r) => isObj(r) && str(r.text)).slice(0, 3);
  if (!list.length) return `<h3>Top reviews</h3><p class="muted">No Google reviews with text.</p>`;
  return `<h3>Top reviews</h3>${list.map((r) => {
    const rating = finite(r.rating);
    const n = rating === null ? 0 : Math.max(0, Math.min(5, Math.round(rating)));
    return `<div class="review"><div>${rating === null ? "" : `<span class="stars" title="${n} out of 5">${"★".repeat(n)}${"☆".repeat(5 - n)}</span> `}<b>${esc(str(r.author) || "A customer")}</b></div>
      <p>${esc(r.text)}</p></div>`;
  }).join("")}`;
}

// 8. The call script (collapsed; open when there's no email to write to), then stage 8's #d-call slot.
function scriptHtml(d, { sender, origin, now }) {
  const lead = scriptLead(d, origin);
  let sections;
  try {
    sections = callScript(lead, { sender: str(sender) || "Nik", offer: d.offer, guarantee: d.guarantee, today: now });
  } catch (err) {
    return `<h3>Call script</h3><p class="error">Couldn't fill in the call script (${esc(err?.message ?? err)}). Close this lead and open it again.</p><div id="d-call"></div>`;
  }
  const block = (s) => `<div class="script-sec"><h4>${esc(s.title)}</h4><ul>${s.lines.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
  return `<details class="script"${lead.email ? "" : " open"}><summary>${icon("phone")} Call script</summary>
      ${sections.filter((s) => !s.objection).map(block).join("")}
      <details class="script-obj"><summary>Objections and answers</summary>${sections.filter((s) => s.objection).map(block).join("")}</details>
    </details>
    <div id="d-call"></div>`;
}

// 9. Business facts: phone, address, website (a link only when it's http(s), else plain text), company number,
// rating, socials, why it's excluded, and where it was found.
function factsHtml(lead) {
  const rows = [];
  const tel = telOf(lead.phone);
  if (str(lead.phone)) rows.push(["Phone", tel ? `<a href="${esc(tel)}">${esc(lead.phone)}</a>` : esc(lead.phone)]);
  const address = [str(lead.address), str(lead.postcode) && !str(lead.address).includes(str(lead.postcode)) ? str(lead.postcode) : ""]
    .filter(Boolean).join(", ");
  if (address) rows.push(["Address", esc(address)]);
  const site = safeUrl(lead.website);
  if (str(lead.website)) rows.push(["Website", site ? outLink(site, esc(lead.website)) : esc(lead.website)]);
  if (str(lead.company_number)) rows.push(["Company", esc(lead.company_number)]);
  const rating = finite(lead.rating);
  rows.push(["Rating", rating ? `${esc(rating)}★ from ${esc(countOf(lead.review_count) ?? 0)} reviews` : "No Google reviews"]);
  const socials = Object.entries(isObj(lead.socials) ? lead.socials : {})
    .map(([name, url]) => [name, safeUrl(url)]).filter(([, url]) => url)
    .map(([name, url]) => outLink(url, `${esc(name)} ${icon("external")}`, "cap")).join(" · ");
  if (socials) rows.push(["Socials", socials]);
  if (lead.excluded === true) rows.push(["Excluded", esc(str(lead.exclude_reason) || "Yes")]);
  const town = str(lead.search_town) || str(lead.town);
  const found = ukDay(lead.first_seen_at);
  const foundLine = str(lead.trade) && town ? `Found searching ${lead.trade} in ${town}${found ? `, ${found}` : ""}` : "";
  return `<h3>Business facts</h3><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${foundLine ? `<p class="hint">${esc(foundLine)}</p>` : ""}`;
}

/**
 * The lead panel for a GET /api/leads/:id payload, top to bottom as Part A lists it: head (name, "trade · town",
 * grade, stage + Hot, Do not email, close ×), actions, stage 2's research card (unchanged, in #d-research so leads.js
 * can redraw it after "Research is wrong"), demo (the #d-demo slot for stage 4's card, and Preview), Google Maps, the #d-email slot + the read-only
 * conversation ([data-conversation], right after the slot: style.css hides it once stage 6 mounts its thread or
 * composer there, and it's back if the slot is emptied), top reviews, the call script + the #d-call slot, business facts, notes (#d-notes, #d-saved).
 * opts = {capacity (capacityNow, for Write first email), sender (the call script's name), origin (the Control Room's,
 * for the script's demo link), now (the script's month)}. Hooks: [data-x] close, [data-write-email], [data-not-a-fit],
 * [data-preview-toggle] + template[data-preview-frame] + [data-preview-box], and the research card's own.
 */
export function drawerHtml(detail, opts = {}) {
  const { capacity = null, sender = "Nik", origin = "", now = new Date() } = opts ?? {};
  const d = isObj(detail) ? { ...detail } : {};
  d.lead = isObj(d.lead) ? d.lead : {};
  const lead = d.lead;
  const p = isObj(d.prospect) ? d.prospect : null;
  const where = [str(lead.trade), str(lead.town) || str(lead.search_town)].filter(Boolean).join(" · ");
  const research = researchCard({ research: d.research ?? null, waiting: d.research_waiting }, { esc, safeUrl });
  return `<div class="scrim" data-x></div>
  <aside class="drawer" role="dialog" aria-label="${esc(lead.name)}" data-id="${esc(lead.place_id)}">
    <div class="drawer-head">${gradeBadge(isObj(d.research) ? d.research.grade : null)}
      <div class="grow"><h2>${esc(lead.name)}</h2>${where ? `<div class="sub-line cap">${esc(where)}</div>` : ""}
        <div class="head-tags">${stageBadge(p?.stage ?? null, p?.stage_label, p?.hot)}${d.suppressed === true ? ` <span class="tag">Do not email</span>` : ""}</div></div>
      <button class="icon-btn" data-x aria-label="Close">${icon("x")}</button></div>
    ${actionsHtml(d, capacity)}
    <div class="drawer-body">
      <div id="d-research">${research}</div>
      ${demoHtml(d)}
      ${mapsHtml(d)}
      <h3>Email</h3><div id="d-email"></div><div class="conversation" data-conversation><h4 class="thread-head">Conversation</h4>${threadHtml(d.messages)}</div>
      ${reviewsHtml(lead)}
      ${scriptHtml(d, { sender, origin, now: now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date() })}
      ${factsHtml(lead)}
      <h3>Notes</h3>
      <textarea id="d-notes" rows="4" placeholder="Called, said call back Friday…">${esc(lead.notes)}</textarea>
      <p class="hint" id="d-saved">Saves when you click away.</p>
    </div>
  </aside>`;
}

// ---------------------------------------------------------------- the page itself: route, query, list, Not a fit

const PAGE_SIZE = 50; // rows a page: the server's PAGE_SIZE (functions/_lib/shortlist.js)
const Q_MAX = 100; // search text, in characters: the server's cap
// Grade values (as the filters hold them) ⇄ URL tokens. A raw "+" in a query string reads as a space, so never "A+".
const GRADE_TOKEN = Object.freeze({ "A+": "ap", A: "a", B: "b", C: "c", D: "d", none: "none" });
const TOKEN_GRADE = Object.freeze({ ap: "A+", a: "A", b: "B", c: "C", d: "D", none: "none" });

const decodePart = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/**
 * The hash route → {page, params, leadId}. `page` is the first segment for any route ("home" when there's none) and
 * "leads" for #/lead/<place_id>; it holds no page list, so routes added by later stages reach app.js unchanged (app.js
 * sends an unknown page home). `params` is the query after "?"; `leadId` the decoded place_id of #/lead/<id>, else null.
 */
export function parseRoute(hash) {
  const raw = String(hash ?? "").replace(/^#\/?/, "");
  const at = raw.indexOf("?");
  const params = new URLSearchParams(at < 0 ? "" : raw.slice(at + 1));
  const [first, ...rest] = (at < 0 ? raw : raw.slice(0, at)).split("/");
  if (first === "lead") return { page: "leads", params, leadId: decodePart(rest.join("/")) || null };
  return { page: first || "home", params, leadId: null };
}

// Comma-separated tokens of every `key` param, matched exactly, in order, without repeats; none → null.
function tokenList(sp, key, map) {
  const out = [];
  for (const raw of sp.getAll(key)) {
    for (const token of raw.split(",")) {
      const value = own(map, token);
      if (value !== undefined && !out.includes(value)) out.push(value);
    }
  }
  return out.length ? out : null;
}
const STAGE_SET = Object.freeze(Object.fromEntries(STAGES.map((s) => [s, s])));
const flagOf = (v) => (v === "1" ? true : v === "0" ? false : null);
// Trimmed, at most Q_MAX characters (code points, so an emoji is never cut in half), as the server cuts it.
const searchText = (raw) => Array.from(String(raw ?? "").trim().slice(0, Q_MAX * 2)).slice(0, Q_MAX).join("").trim();

/**
 * The Leads page's query from the route's params (or a query string), read exactly as the server's
 * parseLeadFilters reads GET /api/leads (tests/leadview.test.mjs checks they agree), so the chips, filters and search
 * box show what the list was asked for: {view, grades, trade, town, email, stages, researched, q, excluded, job, page}.
 */
export function parseLeadsQuery(searchParams) {
  const sp = searchParams && typeof searchParams.get === "function" && typeof searchParams.getAll === "function"
    ? searchParams : new URLSearchParams(typeof searchParams === "string" ? searchParams : "");
  const page = sp.get("page") ?? "";
  return {
    view: sp.get("view") === "all" ? "all" : "ready",
    grades: tokenList(sp, "grade", TOKEN_GRADE),
    trade: sp.get("trade") || null,
    town: sp.get("town") || null,
    email: flagOf(sp.get("email")),
    stages: tokenList(sp, "stage", STAGE_SET),
    researched: flagOf(sp.get("researched")),
    q: searchText(sp.get("q")),
    excluded: sp.get("excluded") === "1",
    job: sp.get("job") || null,
    page: /^[0-9]{1,9}$/.test(page) ? Math.max(1, Number(page)) : 1,
  };
}

const textParam = (v) => (typeof v === "string" && v !== "" ? v : "");
// Grade values or stage tokens as a comma-separated URL value (unknown ones left out), or "" when there are none.
const tokensOut = (list, map) => [...new Set((Array.isArray(list) ? list : []).map((v) => own(map, v)).filter(Boolean))].join(",");

/**
 * The query string for GET /api/leads and the page's own #/leads?… link: only the fields that aren't the defaults,
 * grades as URL tokens (A+ → ap), commas left readable. "" for the default view (Ready to email, no filters, page 1).
 */
export function leadsQueryString(query) {
  const q = isObj(query) ? query : {};
  const sp = new URLSearchParams();
  if (q.view === "all") sp.set("view", "all");
  const grades = tokensOut(q.grades, GRADE_TOKEN);
  if (grades) sp.set("grade", grades);
  if (textParam(q.trade)) sp.set("trade", q.trade);
  if (textParam(q.town)) sp.set("town", q.town);
  if (typeof q.email === "boolean") sp.set("email", q.email ? "1" : "0");
  const stages = tokensOut(q.stages, STAGE_SET);
  if (stages) sp.set("stage", stages);
  if (typeof q.researched === "boolean") sp.set("researched", q.researched ? "1" : "0");
  const search = searchText(q.q);
  if (search) sp.set("q", search);
  if (q.excluded === true) sp.set("excluded", "1");
  if (textParam(q.job)) sp.set("job", q.job);
  if (Number.isSafeInteger(q.page) && q.page > 1) sp.set("page", String(q.page));
  return sp.toString().replace(/%2C/gi, ",");
}

// Filters that narrow the list (Show excluded only widens it). Ready ignores All's stage, email and researched, and
// its grade chips are only A+, A and B: the server ignores a C, D or Not graded token there (listLeads), so a link
// carrying one still gets Ready's own empty states.
function narrowed(q) {
  const some = (v) => Array.isArray(v) && v.length > 0;
  const all = q.view === "all";
  const grades = Array.isArray(q.grades) && q.grades.some((g) => all || READY_CHIPS.includes(g));
  const common = grades || !!textParam(q.trade) || !!textParam(q.town) || !!searchText(q.q) || !!textParam(q.job);
  if (!all) return common;
  return common || some(q.stages) || typeof q.email === "boolean" || typeof q.researched === "boolean";
}

const thousands = (n) => n.toLocaleString("en-GB");

// "Showing 1–50 of 213", then Previous / Next when there's more than one page. [data-page] holds the page to load.
function pagerHtml(d, shown) {
  const total = countOf(d.total) ?? shown;
  const page = Math.max(1, countOf(d.page) ?? 1);
  const pages = Math.max(1, countOf(d.pages) ?? 1);
  const from = (page - 1) * PAGE_SIZE + 1;
  const buttons = pages > 1 ? `<div class="actions">
      <button class="btn secondary sm" data-page="${page - 1}"${page <= 1 ? " disabled" : ""}>Previous</button>
      <button class="btn secondary sm" data-page="${page + 1}"${page >= pages ? " disabled" : ""}>Next</button></div>` : "";
  return `<div class="pager"><span class="muted">Showing ${thousands(from)}–${thousands(from + shown - 1)} of ${thousands(total)}</span>${buttons}</div>`;
}

// Part A's empty states. Hooks: [data-clear-filters]; "See all leads" is a plain in-app link.
function emptyHtml(q, d) {
  const box = (text, action = "") => `<div class="card empty-state"><p>${esc(text)}</p>${action}</div>`;
  const clear = `<button class="btn secondary sm" data-clear-filters>Clear filters</button>`;
  if (narrowed(q)) return box("No leads match these filters.", clear);
  if (q.view === "all") {
    return box("No leads yet. Find some on the Lead Scraper page.", `<a class="btn secondary sm" href="#/scraper">Open Lead Scraper</a>`);
  }
  const waiting = isObj(d.ready) ? countOf(d.ready.waiting_demo) ?? 0 : 0;
  if (waiting > 0) {
    return box(`No leads are ready to email yet. ${waiting} A-grade ${waiting === 1 ? "lead is" : "leads are"} waiting for their demo site.`);
  }
  // A+/A leads exist but none is ready or waiting (all emailed, hidden, re-checked or without an email), so "No A-grade
  // leads yet" would be untrue. ready.graded_top (readyCounts) counts them; unknown → Part A's text.
  if ((isObj(d.ready) ? countOf(d.ready.graded_top) ?? 0 : 0) > 0) {
    return box("No leads are ready to email right now. None of your A-grade leads is waiting for its demo site.",
      `<a class="btn secondary sm" href="#/leads?view=all&amp;grade=ap,a">See your A-grade leads</a>`);
  }
  return box("No A-grade leads yet. Claude grades new leads every morning at 06:47.",
    `<a class="btn secondary sm" href="#/leads?view=all">See all leads</a>`);
}

/**
 * Everything on the Leads page under its title, for `query` (parseLeadsQuery's shape) and `data` (the GET /api/leads
 * answer): the capacity banner, the tabs, chips, filters and search (filterBarHtml), then the table (Grade | Business |
 * Why | Email | Stage | Score) with "Showing 1–50 of 213" and Previous / Next, or Part A's empty state. `selected` is
 * the place_id whose panel is open. Hooks for leads.js: filterBarHtml's, tr.click[data-id], [data-page],
 * [data-clear-filters].
 */
export function leadsBodyHtml(query, data, { selected = null } = {}) {
  const q = isObj(query) ? query : parseLeadsQuery("");
  const d = isObj(data) ? data : {};
  const rows = (Array.isArray(d.rows) ? d.rows : []).filter(isObj);
  let list;
  if (rows.length) {
    list = `<div class="table-card"><div class="table-wrap"><table class="leads-table">
      <thead><tr><th>Grade</th><th>Business</th><th>Why</th><th>Email</th><th>Stage</th><th class="c-score">Score</th></tr></thead>
      <tbody>${rows.map((r) => leadRowHtml(r, { selected: selected !== null && r.place_id === selected })).join("")}</tbody>
    </table></div></div>${pagerHtml(d, rows.length)}`;
  } else if ((countOf(d.total) ?? 0) > 0) {
    // Past the last page (e.g. leads were hidden since the link was made).
    list = `<div class="card empty-state"><p>There's nothing on this page.</p><button class="btn secondary sm" data-page="1">Back to the first page</button></div>`;
  } else {
    list = emptyHtml(q, d);
  }
  return `${bannerHtml(isObj(d.capacity) ? d.capacity.banner : null)}
    ${filterBarHtml(q, d)}
    ${list}`;
}

/** The list couldn't load: the error's own plain-English text in red, and where to look. */
export function leadsErrorHtml(message) {
  const text = str(message) || "Couldn't load your leads.";
  return `<p class="error">${esc(text)}</p><p class="hint">Open <a href="#/setup">Setup</a> to see what's connected.</p>`;
}

/** Not a fit's choices, in Part A's order. "Other" needs the text box. */
export const NOT_A_FIT_REASONS = Object.freeze(["Too big (not owner-run)", "Front-desk business", "Wrong trade", "Already doing well online", "Other"]);
const FIT_REASON_MAX = 200; // the server's limit for the whole reason, in characters
/** The text box's limit: the longest choice + ": " + the box always fits in the server's 200 characters. */
export const FIT_TEXT_MAX = FIT_REASON_MAX - Math.max(...NOT_A_FIT_REASONS.map((r) => r.length)) - 2;

/**
 * The reason POST /api/leads/:id/not-a-fit gets: the choice, then ": " and the typed words when there are any; "Other"
 * (or no choice) is the typed words alone. The server checks it's 3 to 200 characters and says so when it isn't.
 */
export function notAFitReason(choice, text) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim();
  const picked = NOT_A_FIT_REASONS.includes(choice) && choice !== "Other" ? choice : "";
  if (!picked) return words;
  return words ? `${picked}: ${words}` : picked;
}

/**
 * The Not a fit dialog (lib.js modal()): "Why isn't it a fit?", the five choices, a text box and Hide this lead.
 * Hooks: form#fit-form, input[name=fit], #fit-text, [data-fit-error], [data-fit-send].
 */
export function notAFitHtml(name) {
  return `<form id="fit-form" novalidate>
    <div class="modal-head"><h2>Why isn't it a fit?</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div>
    <div class="modal-body">
      ${str(name) ? `<p class="muted" style="margin:0">${esc(name)}</p>` : ""}
      <div class="fit-options">${NOT_A_FIT_REASONS.map((r) =>
    `<label class="check-line"><input type="radio" name="fit" value="${esc(r)}"> ${esc(r)}</label>`).join("")}</div>
      <div><label for="fit-text">In a few words (needed for Other)</label>
        <textarea id="fit-text" rows="2" maxlength="${FIT_TEXT_MAX}"></textarea></div>
      <p class="error" data-fit-error hidden></p>
    </div>
    <div class="modal-foot"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn" type="submit" data-fit-send>Hide this lead</button></div>
  </form>`;
}
