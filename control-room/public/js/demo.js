// The Demo page (#/demo, no nav item) and the lead drawer's Demo site card (stage 4, docs/rebuild/05-demo.md Task 14
// and Part A "What Nik sees"). The page: one card per look (GET /api/demo templates) with three phone-sized previews
// of real graded leads and "Approve this look" (POST /api/demo/approve {template, version}), then the Demo sites
// table. The card (demoCardHtml, from GET /api/demo/lead/:id) is mounted by leads.js into stage 3's #d-demo slot: the
// link, views and expiry, or why there's no demo yet.
// "Open demo" / "Open" are always the relative /d/<slug> (a slug the server could have made), so they open on the
// Control Room host with Nik's login cookie and his own views never count; "Copy link" copies the https link the
// first email carries. Preview frames are sandboxed (nothing in them runs) and lazy.
// The renderers are pure (they never read the page, and this file imports nothing that does when it loads), so
// tests/demo-ui.test.mjs runs them in node; demoPage() loads lib.js (which reads the page) only when it's called.
// Every value from the server (lead names, towns, reasons, quality problems) goes through esc().

import { esc, safeUrl } from "./html.js";
import { STAGE_LABELS, gradeBadge } from "./leadview.js";

const SLUG = /^[a-z0-9-]{3,60}$/; // as slugFor makes them (functions/_lib/demo/text.js)
const NO_DEMO = "No demo yet: "; // demoReady's reasons (functions/_lib/demo-db.js)
const WAITING = /^Waiting for you to approve the (.+) look on the Demo page$/;
const RECENT_MS = 6 * 86400000; // a view within this long shows its weekday ("Tue 14:05"); older ones their date
const TITLE = "Demo"; // "the Demo page" in the todo, the lead panel and demoReady's reason, and its PAGES label
const SUB = "Approve each look once. No first email can link to a demo until its look is approved.";
const EMPTY = "No demo sites yet. One is made automatically when Claude grades a lead A+, A or B and finds an email.";
const NO_GRADED = "No graded leads for this look yet. Previews appear once research grades one.";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const countOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const slugOf = (demo) => (isObj(demo) && typeof demo.slug === "string" && SLUG.test(demo.slug) ? demo.slug : "");
// The https link (Copy link copies it), or "" for anything else.
const httpsOf = (url) => {
  const u = typeof url === "string" ? safeUrl(url) : "";
  return u.startsWith("https://") ? u : "";
};
const openHref = (slug) => `/d/${slug}`;

// ---------------------------------------------------------------- UK dates and times

const UK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const msOf = (iso) => (typeof iso === "string" && iso ? Date.parse(iso) : NaN);
function ukParts(iso) {
  const ms = msOf(iso);
  if (!Number.isFinite(ms)) return null;
  return Object.fromEntries(UK.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}
const nowOf = (now) => (now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date());
/** "17 Apr 2027" (UK), or "" when the time can't be read. */
const ukDay = (iso) => { const p = ukParts(iso); return p ? `${p.day} ${p.month} ${p.year}` : ""; };
/** "21 Oct" (UK), or "". */
const ukDayMonth = (iso) => { const p = ukParts(iso); return p ? `${p.day} ${p.month}` : ""; };
/** When a view was: "Tue 14:05" within the last 6 days, else "3 Oct" ("30 Dec 2025" in another year); "" unreadable. */
function ukSeen(iso, now) {
  const p = ukParts(iso);
  if (!p) return "";
  const at = nowOf(now);
  if (at.getTime() - msOf(iso) < RECENT_MS) return `${p.weekday} ${p.hour}:${p.minute}`;
  return p.year === ukParts(at.toISOString()).year ? `${p.day} ${p.month}` : `${p.day} ${p.month} ${p.year}`;
}

// ---------------------------------------------------------------- the lead drawer's Demo site card

// The demo's facts: the link (as the email carries it), views, when it ends (never for a won prospect: Part A §2),
// Open demo and Copy link.
function factsHtml(info, demo, slug, now) {
  const url = httpsOf(demo.url);
  const views = countOf(info.views);
  const last = views ? ukSeen(info.last_view_at, now) : "";
  const seen = views ? `Viewed ${views}×${last ? ` · last ${last}` : ""}` : "Not viewed yet";
  const ends = info.stage === "won" ? "" : ukDay(demo.expires_at);
  return `${url ? `<div class="demo-url">${esc(url.replace(/^https:\/\//, ""))}</div>` : ""}
    <div class="demo-meta"><span class="badge${views ? " gold" : ""}">${esc(seen)}</span>${ends ? `<span>Ends ${esc(ends)}</span>` : ""}</div>
    <div class="actions"><a class="btn secondary sm" href="${esc(openHref(slug))}" target="_blank" rel="noopener">Open demo</a>${url
      ? `<button class="btn secondary sm" type="button" data-copy-demo="${esc(url)}">Copy link</button>` : ""}</div>`;
}

/**
 * The lead drawer's "Demo site" card for a GET /api/demo/lead/:id answer {demo: {slug, url, expires_at} | null, views,
 * last_view_at, stage, ready: demoReady's {ok, reason}}. Ready: the link, "Viewed 3× · last Tue 14:05" or "Not viewed
 * yet", "Ends 17 Apr 2027" (none when stage is won), Open demo (relative, new tab) and Copy link (the https link).
 * Waiting for the look: "Demo made · waiting for you to approve the <Label> look" with a link to the Demo page, then
 * the same facts. Not ready: "No demo: <reason>" (demoReady's "No demo yet: <reason>"), or its expired line as it says
 * it. opts.now: the views' clock.
 * Hooks: [data-copy-demo] (bindCopyLinks).
 */
export function demoCardHtml(info, { now = new Date() } = {}) {
  const i = isObj(info) ? info : {};
  const ready = isObj(i.ready) ? i.ready : {};
  const reason = str(ready.reason);
  const demo = isObj(i.demo) ? i.demo : null;
  const slug = slugOf(demo);
  const waiting = ready.ok === true ? null : reason.match(WAITING);
  const card = (inner) => `<div class="demo-card">${inner}</div>`;
  if (waiting) {
    const line = `<p class="demo-wait">Demo made · waiting for you to approve the ${esc(waiting[1])} look on the <a href="#/demo">Demo page</a>.</p>`;
    return card(`${line}${slug ? factsHtml(i, demo, slug, now) : ""}`);
  }
  if (ready.ok === true && slug) return card(factsHtml(i, demo, slug, now));
  if (reason.startsWith(NO_DEMO)) return card(`<p class="muted">No demo: ${esc(reason.slice(NO_DEMO.length))}</p>`);
  if (reason && ready.ok !== true) return card(`<p class="muted">${esc(reason)}</p>`);
  return card(`<p class="muted">No demo yet.</p>`);
}

/** The card's place when GET /api/demo/lead/:id fails: what went wrong and what to do. */
export function demoCardErrorHtml(message) {
  const why = String(message ?? "").trim().replace(/[.\s]+$/, "") || "no answer";
  return `<p class="error">Couldn't load this lead's demo site (${esc(why)}). Close this lead and open it again.</p>`;
}

/** Copy link: every [data-copy-demo] button in `el` copies its link (toast from lib.js; no clipboard: a prompt). */
export function bindCopyLinks(el, toast) {
  el.querySelectorAll("[data-copy-demo]").forEach((btn) => btn.onclick = async () => {
    const url = btn.dataset.copyDemo;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied.");
    } catch {
      prompt("Copy the link:", url);
    }
  });
}

// ---------------------------------------------------------------- the Demo page: a look's card

const waitingLine = (n) => (n === 1
  ? "1 lead is waiting for this look before their first email can go."
  : `${n} leads are waiting for this look before their first email can go.`);

// One preview: titled with the lead's name and town, the page in a sandboxed lazy frame, the check's problems in red.
function shotHtml(id, label, p) {
  const name = str(p.name);
  const town = str(p.town);
  const placeId = typeof p.place_id === "string" ? p.place_id : "";
  const src = `/api/demo/preview?template=${encodeURIComponent(id)}&place_id=${encodeURIComponent(placeId)}`;
  const problems = Array.isArray(p.problems) ? p.problems.filter((x) => typeof x === "string" && x) : [];
  const title = `${label} look for ${[name, town].filter(Boolean).join(" · ")}`;
  return `<figure class="demo-shot">
      <figcaption><b>${esc(name)}</b>${town ? ` · ${esc(town)}` : ""}</figcaption>
      <iframe class="demo-frame" sandbox="" loading="lazy" title="${esc(title)}" src="${esc(src)}"></iframe>
      ${problems.length ? `<ul class="demo-problems">${problems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="hint">Passes every check.</p>`}
    </figure>`;
}

/**
 * One look's card on the Demo page, for a GET /api/demo template {id, label, version, approved, approved_at,
 * approved_version, waiting, previews: [{place_id, name, town, photos, problems}]}. Not approved: "Needs your OK" (or
 * "Changed: look again" with "This look changed since you approved version <n>." when an older version was approved),
 * how many leads wait for it, the previews (or "No graded leads for this look yet…") and Approve this look (only with
 * something previewed: the server refuses it otherwise). Approved: "Approved 21 Oct", "Leads can get their first
 * email." and Look again, whose previews wait in an inert <template> until pressed (a hidden frame would still load).
 * Hooks: [data-approve="<id>"], [data-look-again] + template[data-look-frames] + [data-look-box].
 */
export function lookCardHtml(t) {
  const look = isObj(t) ? t : {};
  const id = str(look.id);
  const label = str(look.label) || id || "This";
  const previews = Array.isArray(look.previews) ? look.previews.filter(isObj) : [];
  const approved = look.approved === true;
  const before = Number.isSafeInteger(look.approved_version) ? look.approved_version : null;
  const changed = !approved && before !== null && before !== look.version;
  const waiting = countOf(look.waiting);
  const shots = previews.length ? `<div class="demo-previews">${previews.map((p) => shotHtml(id, label, p)).join("")}</div>` : "";

  let badge;
  const lines = [];
  let body;
  if (approved) {
    const at = ukDayMonth(look.approved_at);
    badge = `<span class="badge good">Approved${at ? ` ${esc(at)}` : ""}</span>`;
    lines.push("Leads can get their first email.");
    body = shots ? `<button class="btn secondary sm" type="button" data-look-again aria-expanded="false">Look again</button>
      <template data-look-frames>${shots}</template><div class="demo-look-box" data-look-box hidden></div>` : "";
  } else {
    badge = changed ? `<span class="badge warn">Changed: look again</span>` : `<span class="badge warn">Needs your OK</span>`;
    if (changed) lines.push(`This look changed since you approved version ${before}.`);
    if (waiting) lines.push(waitingLine(waiting));
    if (!shots) lines.push(NO_GRADED);
    body = shots ? `${shots}<div class="actions"><button class="btn" type="button" data-approve="${esc(id)}">Approve this look</button></div>` : "";
  }
  return `<section class="card demo-look" data-look="${esc(id)}">
    <div class="card-head"><h2>${esc(label)} look</h2>${badge}</div>
    ${lines.map((l) => `<p class="muted">${esc(l)}</p>`).join("")}
    ${body}
  </section>`;
}

// ---------------------------------------------------------------- the Demo page: the Demo sites table

function demoRowHtml(d, now) {
  const id = typeof d.place_id === "string" ? d.place_id : "";
  const name = str(d.name) || "(no name)";
  const stage = typeof d.stage === "string" && d.stage
    ? (Object.hasOwn(STAGE_LABELS, d.stage) ? STAGE_LABELS[d.stage] : d.stage) : STAGE_LABELS.none;
  const last = ukSeen(d.last_view_at, now);
  // A won prospect's page never ends (Part A §2), whatever expires_at says.
  const won = d.stage === "won";
  const ends = won ? "" : ukDay(d.expires_at);
  const ended = ends && msOf(d.expires_at) <= nowOf(now).getTime();
  const slug = slugOf(d);
  const url = httpsOf(d.url);
  return `<tr>
      <td><div class="demo-biz">${gradeBadge(d.grade)}${id ? `<a href="#/lead/${esc(encodeURIComponent(id))}">${esc(name)}</a>` : esc(name)}</div></td>
      <td>${esc(stage)}</td>
      <td class="r num">${countOf(d.views)}</td>
      <td>${last ? esc(last) : `<span class="faint">–</span>`}</td>
      <td>${won ? "Never (won)" : ends ? esc(ended ? `Ended ${ends}` : ends) : `<span class="faint">–</span>`}</td>
      <td class="r"><div class="demo-row-actions">${slug ? `<a class="btn secondary sm" href="${esc(openHref(slug))}" target="_blank" rel="noopener">Open</a>` : ""}${url
        ? `<button class="btn secondary sm" type="button" data-copy-demo="${esc(url)}">Copy link</button>` : ""}</div></td>
    </tr>`;
}

/**
 * The Demo sites table for GET /api/demo's demos [{place_id, name, grade, stage, slug, url, views, last_view_at,
 * expires_at}], in the server's order (last viewed first, then newest): Business (grade badge + name, opening its lead
 * panel), Stage, Views, Last viewed, Ends ("Ended …" once it has; "Never (won)" for a won prospect, whose page stays
 * up), Open (relative /d/<slug>) and Copy link. None:
 * Part A's empty line. Hooks: [data-copy-demo].
 */
export function demosTableHtml(demos, { now = new Date() } = {}) {
  const list = Array.isArray(demos) ? demos.filter(isObj) : [];
  if (!list.length) return `<div class="card empty-state"><p>${esc(EMPTY)}</p></div>`;
  return `<div class="table-card"><div class="table-wrap"><table class="demos-table">
    <thead><tr><th>Business</th><th>Stage</th><th class="r">Views</th><th>Last viewed</th><th>Ends</th><th></th></tr></thead>
    <tbody>${list.map((d) => demoRowHtml(d, now)).join("")}</tbody>
  </table></div></div>`;
}

/** Everything under the page title for a GET /api/demo answer: the looks, then the Demo sites table. */
export function demoBodyHtml(data, { now = new Date() } = {}) {
  const d = isObj(data) ? data : {};
  const looks = Array.isArray(d.templates) ? d.templates.filter(isObj) : [];
  return `<div class="section-title"><h2>Looks</h2></div>
    <div class="stack">${looks.map((t) => lookCardHtml(t)).join("")}</div>
    <div class="section-title"><h2>Demo sites</h2></div>
    ${demosTableHtml(d.demos, { now })}`;
}

// ---------------------------------------------------------------- the page itself (needs a page: lib.js)

let lib = null; // lib.js, loaded by the first demoPage()
let pageAsk = 0; // the newest load: an older answer is never drawn over a newer one or another page

const pageBody = () => document.getElementById("demo-body");

/** The Demo page (#/demo): title, then GET /api/demo's looks and demo sites. */
export async function demoPage() {
  lib ??= await import("./lib.js");
  const { pageHead, view } = lib;
  const ask = ++pageAsk;
  view.innerHTML = `${pageHead(TITLE, SUB)}<div id="demo-body"><p class="muted">Loading your looks and demo sites…</p></div>`;
  await load(ask);
}

async function load(ask) {
  let data;
  try {
    data = await lib.api("/api/demo");
  } catch (err) {
    const el = pageBody();
    if (ask === pageAsk && el) el.innerHTML = loadErrorHtml(err.message);
    return;
  }
  const el = pageBody();
  if (ask !== pageAsk || !el) return;
  el.innerHTML = demoBodyHtml(data);
  bindPage(el, data);
}

const loadErrorHtml = (message) => `<p class="error">${esc(message)}</p>
  <p class="hint">Refresh the page to try again. <a href="#/setup">Setup</a> shows what's connected.</p>`;

function bindPage(el, data) {
  const looks = Array.isArray(data?.templates) ? data.templates.filter(isObj) : [];
  el.querySelectorAll("[data-approve]").forEach((btn) => {
    const look = looks.find((t) => t.id === btn.dataset.approve);
    if (look) btn.onclick = () => approve(btn, look);
  });
  el.querySelectorAll("[data-look-again]").forEach((btn) => {
    const card = btn.closest("[data-look]");
    const box = card?.querySelector("[data-look-box]");
    if (!box) return;
    btn.onclick = () => {
      const frames = card.querySelector("template[data-look-frames]");
      if (!box.firstElementChild && frames) box.append(frames.content.cloneNode(true));
      box.hidden = !box.hidden;
      btn.setAttribute("aria-expanded", String(!box.hidden));
      btn.textContent = box.hidden ? "Look again" : "Hide the previews";
    };
  });
  bindCopyLinks(el, lib.toast);
}

/** Approve this look: the version this page showed; a refusal (the look changed, nothing to preview) in a toast. */
async function approve(btn, look) {
  btn.disabled = true;
  try {
    await lib.api("/api/demo/approve", { method: "POST", body: JSON.stringify({ template: look.id, version: look.version }) });
  } catch (err) {
    lib.toast(err.message);
    btn.disabled = false;
    return;
  }
  lib.toast(`${str(look.label) || "This"} look approved. Its leads can get their first email.`);
  await load(++pageAsk);
}
