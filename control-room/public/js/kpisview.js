// The KPIs page's HTML (stage 11, docs/rebuild/11-todo-kpis.md Part A "What Nik sees"), as pure functions of
// GET /api/kpis's payload ({week, label, start, prev, next, still_counting, numbers, trend, analysis}): the week bar,
// the tiles, your emails vs Claude's, every kind of email, the follow-up steps, the grades, research, the last 4 weeks
// and Claude's review. kpis.js fetches the payload and puts this on the page.
//
// Every number is computed on the server (functions/_lib/kpis.js); this file only words them. Claude's review is
// Claude-written text: mdLite escapes all of it and turns only "## " headings, "- " and "1. " lists and paragraphs
// into HTML. It imports only html.js (pure), never lib.js (it reads the page when it loads), so
// tests/kpisview.test.mjs runs it in node.
import { esc } from "./html.js";

/** Below this many in the sample a rate is "early" (functions/_lib/kpis.js MIN_SAMPLE). */
const MIN_SAMPLE = 30;
/** The follow-ups' days after the first email (stage 6's FOLLOWUP_DAYS in functions/_lib/followups.js). */
const FOLLOWUP_DAYS = [1, 2, 4, 7, 10, 17, 24, 30, 60];
const GRADES = ["A+", "A", "B", "C", "D"];
const DASH = "–";
const EARLY_TITLE = `Fewer than ${MIN_SAMPLE} emails: too early to tell`;
const EARLY_WORDS = "too early to tell";

const STILL_COUNTING = "Emails from the last 7 days are still collecting views and replies, so these rates can still go up.";
const EMPTY_WEEK = "No emails sent this week. Numbers start after your first email goes out.";
const NO_REVIEW = "Claude writes its review on Sunday evening.";
const GRADE_NOTE = "If A+ isn't doing better than B, the grading needs a tweak.";
const EARLY_NOTE = `Grey: fewer than ${MIN_SAMPLE} emails, too early to tell.`;

const GROUPS = {
  "first:nik": { label: "Your first emails", goal: "Get them to look at their demo" },
  "followup:system": { label: "Follow-ups", goal: "Get a look or a reply" },
  "reply:claude": { label: "Claude's replies", goal: "Move them to a call or an order" },
  "reply:nik": { label: "Your replies", goal: "Move them to a call or an order" },
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const listOf = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const count = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const str = (v) => (typeof v === "string" ? v.trim() : "");
const pctOf = (k, n) => (n > 0 ? Math.round((1000 * k) / n) / 10 : null);
const weekLink = (week) => `/#/kpis?week=${encodeURIComponent(week)}`;

// A rate from the server, read safely: {k, n, pct, early} with numbers, whatever arrived.
function rateOf(r) {
  const k = count(r?.k), n = count(r?.n);
  const pct = typeof r?.pct === "number" && Number.isFinite(r.pct) ? r.pct : pctOf(k, n);
  return { k, n, pct: n > 0 ? pct : null, early: typeof r?.early === "boolean" ? r.early : n < MIN_SAMPLE };
}

/** Pence as pounds, written exactly as stage 0's formatPounds writes them: commas, pennies only when there are some. */
function pounds(pence) {
  const p = Number(pence);
  if (!Number.isFinite(p)) return DASH;
  const whole = Math.round(Math.abs(p));
  const units = String(Math.floor(whole / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const pennies = whole % 100;
  const sign = p < 0 && whole > 0 ? "-" : "";
  return `${sign}£${units}${pennies ? `.${String(pennies).padStart(2, "0")}` : ""}`;
}

/** "3 of 5 (60%)", grey with "too early to tell" under 30, "–" when nothing was sent. */
export function rateHtml(rate) {
  const r = rateOf(rate);
  if (r.n === 0) return `<span class="early">${DASH}</span>`;
  const words = `${r.k} of ${r.n} (${r.pct}%)`;
  return r.early ? `<span class="early" title="${esc(EARLY_TITLE)}">${words} · ${EARLY_WORDS}</span>` : `<span>${words}</span>`;
}

// A table cell's share: "–" with nothing sent, else the percentage, grey when early.
function pctHtml(rate) {
  const r = rateOf(rate);
  if (r.n === 0) return DASH;
  return r.early ? `<span class="early" title="${esc(EARLY_TITLE)}">${r.pct}%</span>` : `${r.pct}%`;
}

// A table cell's count out of `n`: "1 (20%)", the percentage grey when early; "–" when n is 0.
function countHtml(k, n) {
  const kk = count(k), nn = count(n);
  if (nn === 0) return DASH;
  const early = nn < MIN_SAMPLE ? ` class="early" title="${esc(EARLY_TITLE)}"` : ' class="faint"';
  return `${kk} <span${early}>(${pctOf(kk, nn)}%)</span>`;
}

/** Minutes as "12 min", or "7 h" (rounded) from 60; "–" when there's nothing to time. */
function minutesWords(m) {
  if (typeof m !== "number" || !Number.isFinite(m) || m < 0) return DASH;
  const mins = Math.round(m);
  return mins >= 60 ? `${Math.round(mins / 60)} h` : `${mins} min`;
}

// "Sun 25 Oct, 18:52" in UK time for a stored UTC time, or "" when it can't be read.
function ukWritten(iso) {
  const t = new Date(/Z$|[+-]\d\d:?\d\d$/.test(String(iso ?? "")) ? iso : `${String(iso ?? "").replace(" ", "T")}Z`);
  if (Number.isNaN(t.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(t).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

// ---------------------------------------------------------------- Claude's review

const HEADING = /^##\s+(.*)$/;
const BULLET = /^\s*-\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,2})[.)]\s+(.*)$/; // not "2026. …"

/**
 * Claude's markdown as safe HTML: "## " headings (as <h3>), "- " and "1. " lists, and paragraphs; everything else is
 * text, and all of it is escaped. A blank line between items of the same list keeps the list going; an indented line
 * under an item (even after a blank line) carries on that item. A numbered list keeps Claude's first number
 * (<ol start="2">), so a suggestion list broken by a plain line never shows "1." twice.
 */
export function mdLite(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = []; // the lines of the open paragraph
  let list = null; // {tag, items, start} of the open list

  const closePara = () => {
    if (para.length) out.push(`<p>${para.map(esc).join(" ")}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) {
      const start = list.tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
      out.push(`<${list.tag}${start}>${list.items.map((i) => `<li>${i.map(esc).join(" ")}</li>`).join("")}</${list.tag}>`);
    }
    list = null;
  };
  const item = (tag, words, number = 1) => {
    closePara();
    if (list && list.tag !== tag) closeList();
    if (!list) list = { tag, items: [], start: number };
    list.items.push([words]);
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      closePara(); // a list stays open: the next item or an indented line carries on
      continue;
    }
    let m;
    if ((m = HEADING.exec(line.trim()))) {
      closePara();
      closeList();
      if (m[1].trim()) out.push(`<h3>${esc(m[1].trim())}</h3>`);
    } else if ((m = BULLET.exec(line))) item("ul", m[1].trim());
    else if ((m = NUMBERED.exec(line))) item("ol", m[2].trim(), Number(m[1]));
    else if (list && /^\s/.test(line)) list.items[list.items.length - 1].push(line.trim());
    else {
      closeList();
      para.push(line.trim());
    }
  }
  closePara();
  closeList();
  return out.join("");
}

// ---------------------------------------------------------------- sections
// Labels, headings and notes are this file's own words, put in as they are; every value from the payload goes through
// esc() (or is a number we made).

function weekBar(p, n) {
  const label = str(p.label) || str(n.label) || str(p.week);
  const end = str(n.end) || str(p.start);
  const year = /^\d{4}/.test(end) ? ` ${end.slice(0, 4)}` : "";
  const prev = str(p.prev) ? `<a class="btn secondary sm week-arrow" href="${esc(weekLink(p.prev))}" aria-label="Week before">‹</a>` : "";
  const next = str(p.next) ? `<a class="btn secondary sm week-arrow" href="${esc(weekLink(p.next))}" aria-label="Week after">›</a>` : "";
  return `<div class="week-bar">${prev}<span class="week-label">${esc(label)}${esc(year)}</span>${next}</div>`;
}

function tile(label, value, sub = "") {
  return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
}

// A tile for a rate: "40%" big, "2 of 5 · too early to tell" under it.
function rateTile(label, rate) {
  const r = rateOf(rate);
  if (r.n === 0) return tile(label, DASH, `<span class="early">No emails yet</span>`);
  const sub = r.early ? `<span class="early" title="${esc(EARLY_TITLE)}">${r.k} of ${r.n} · ${EARLY_WORDS}</span>` : `${r.k} of ${r.n}`;
  return tile(label, `<span${r.early ? ' class="early"' : ""}>${r.pct}%</span>`, sub);
}

function tiles(n) {
  const nik = n.nik ?? {}, t = n.totals ?? {};
  return `<div class="kpis kpi-tiles">
    ${tile("First emails", String(count(nik.first_sent)))}
    ${rateTile("Opened demo", nik.view_rate)}
    ${rateTile("Replied", nik.reply_rate)}
    ${tile("Calls booked", String(count(t.calls_booked)))}
    ${tile("Orders", String(count(t.orders)), esc(pounds(t.revenue_pence ?? 0)))}
  </div>`;
}

const row = (label, value) => `<div class="kv-row"><dt>${label}</dt><dd>${value}</dd></div>`;

function versusCards(n) {
  const nik = n.nik ?? {}, c = n.claude ?? {};
  return `<div class="grid-2 kpi-cards">
    <div class="card"><div class="card-head"><h2>Your first emails</h2></div><dl class="kpi-kv">
      ${row("Sent", String(count(nik.first_sent)))}
      ${row("Opened demo within 7 days", rateHtml(nik.view_rate))}
      ${row("Replied", rateHtml(nik.reply_rate))}
      ${row("Positive", rateHtml(nik.positive_rate))}
    </dl></div>
    <div class="card"><div class="card-head"><h2>Claude's replies</h2></div><dl class="kpi-kv">
      ${row("Replies sent", String(count(c.replies_sent)))}
      ${row("Moved the lead forward", rateHtml(c.moved_forward))}
      ${row("Typical time to answer", esc(minutesWords(c.median_minutes)))}
      ${row("Handed to you", String(count(c.escalated)))}
    </dl></div>
  </div>`;
}

function table(head, body, cls = "") {
  return `<div class="table-card kpi-table${cls ? ` ${cls}` : ""}"><div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}

const ths = (labels, firstLeft = 1) => labels.map((l, i) => `<th${i >= firstLeft ? ' class="r"' : ""}>${l}</th>`).join("");
const tds = (cells) => cells.map((c) => `<td class="r num">${c}</td>`).join("");

function section(title, inner, note = "") {
  return `<div class="section-title"><h2>${title}</h2></div>${inner}${note ? `<p class="hint">${note}</p>` : ""}`;
}

// A table's note, with "Grey: fewer than 30 emails, too early to tell." added when one of its cells is grey: the hover
// title never shows on a phone, so the words must be on the page under every table that holds an early number.
function tableNote(body, note = "") {
  return body.includes('class="early"') ? [note, EARLY_NOTE].filter(Boolean).join(" ") : note;
}

// The cells from Sent on: Sent · Bounced · Opened demo after · Replied · Positive · No thanks; all "–" with 0 sent.
function outcomeCells(g) {
  const sent = count(g.sent);
  if (sent === 0) return tds(Array(6).fill(DASH));
  return tds([String(sent), ...["bounced", "viewed", "replied", "positive", "opted_out"].map((f) => countHtml(g[f], sent))]);
}
const OUTCOME_HEADS = ["Sent", "Bounced", "Opened demo after", "Replied", "Positive", "No thanks"];

function groupsTable(n) {
  const groups = listOf(n.groups);
  if (!groups.length) return "";
  const body = groups.map((g) => {
    const key = `${str(g.kind)}:${str(g.author)}`;
    const name = str(g.key) || key;
    const known = Object.hasOwn(GROUPS, name) ? GROUPS[name] : null; // never Object.prototype's "constructor" etc.
    const label = known ? known.label : esc(`${str(g.kind) || "?"} (${str(g.author) || "?"})`);
    return `<tr><td class="biz">${label}</td><td class="muted">${known ? known.goal : ""}</td>${outcomeCells(g)}</tr>`;
  }).join("");
  return section("Every kind of email", table(ths(["Email", "Goal", ...OUTCOME_HEADS], 2), body), tableNote(body));
}

function stepLabel(s) {
  const step = count(s.step);
  if (step === 0) return "First email";
  const day = Number.isFinite(Number(s.day_offset)) && s.day_offset !== null && s.day_offset !== "" ? Number(s.day_offset) : FOLLOWUP_DAYS[step - 1];
  return day === undefined ? `Follow-up ${step}` : `Follow-up ${step} · day ${day}`;
}

function stepsTable(n) {
  const steps = listOf(n.steps);
  if (!steps.length) return "";
  const body = steps.map((s) => `<tr><td class="biz">${stepLabel(s)}</td>${outcomeCells(s)}</tr>`).join("");
  return section("Follow-up steps", table(ths(["Step", ...OUTCOME_HEADS]), body), tableNote(body));
}

function gradesTable(n) {
  const byGrade = new Map(listOf(n.grades).map((g) => [g.grade, g]));
  const body = GRADES.map((grade) => {
    const g = byGrade.get(grade) ?? {};
    return `<tr><td class="biz">${esc(grade)}</td>${tds([String(count(g.emailed)), pctHtml(g.viewed), pctHtml(g.replied), pctHtml(g.won)])}</tr>`;
  }).join("");
  return section("Do the grades predict sales?", table(ths(["Grade", "Emailed", "Opened demo", "Replied", "Won"]), body), tableNote(body, GRADE_NOTE));
}

function researchTable(n) {
  const r = n.research ?? {};
  const researched = count(r.researched);
  // Email found (hit rate), grey while fewer than 30 were researched, like every other early rate.
  const found = countHtml(r.with_email, researched);
  const body = `<tr>${tds([String(researched), found, String(count(r.too_big)), String(count(r.wrong_flags))])}</tr>`;
  return section("Research", table(ths(["Researched", "Email found", "Too big", "“Research is wrong” presses"], 0), body), tableNote(body));
}

function trendTable(p) {
  const rows = listOf(p.trend);
  const body = rows.length
    ? rows.map((t) => {
      const label = str(t.label) || str(t.week);
      const week = str(t.week) ? `<a href="${esc(weekLink(t.week))}">${esc(label)}</a>` : esc(label);
      return `<tr><td class="biz">${week}</td>${tds([String(count(t.first_sent)), pctHtml(t.view_rate), pctHtml(t.reply_rate),
        String(count(t.positive)), pctHtml(t.moved_forward), String(count(t.calls_booked)), String(count(t.orders))])}</tr>`;
    }).join("")
    : `<tr><td colspan="8" class="faint">Nothing yet.</td></tr>`;
  const head = ths(["Week", "First emails", "Opened demo %", "Replied %", "Positive replies", "Claude moved forward %", "Calls booked", "Orders"]);
  return section("Last 4 weeks", table(head, body), tableNote(body));
}

function reviewCard(p) {
  const a = isObj(p.analysis) ? p.analysis : null;
  const text = a ? String(a.text ?? "") : "";
  if (!text.trim()) return section("Claude's review", `<div class="card"><p class="muted review-none">${NO_REVIEW}</p></div>`);
  const when = ukWritten(a.created_at);
  return section("Claude's review", `<div class="card kpi-review">${mdLite(text)}${when ? `<p class="hint">Written ${esc(when)}</p>` : ""}</div>`);
}

// Nothing sent and nothing happened: no email, reply, bounce, opt-out, call, order or escalation that week.
function emptyWeek(n) {
  const t = n.totals ?? {};
  return ["sent", "bounced", "human_replies", "positive_replies", "opt_outs", "calls_booked", "orders"].every((k) => count(t[k]) === 0)
    && count(n.claude?.escalated) === 0;
}

/** The whole KPIs page below its title, from GET /api/kpis's payload. */
export function kpisHtml(payload) {
  const p = isObj(payload) ? payload : {};
  const n = isObj(p.numbers) ? p.numbers : {};
  const parts = [weekBar(p, n)];
  if (p.still_counting) parts.push(`<p class="still-counting muted">${STILL_COUNTING}</p>`);
  if (emptyWeek(n)) {
    parts.push(`<p class="empty-line">${EMPTY_WEEK}</p>`);
    if (listOf(n.grades).some((g) => count(g.emailed) > 0)) parts.push(gradesTable(n));
    if (count(n.research?.researched) || count(n.research?.wrong_flags)) parts.push(researchTable(n));
  } else {
    parts.push(tiles(n), section("Your emails vs Claude's", versusCards(n)), groupsTable(n), stepsTable(n), gradesTable(n), researchTable(n));
  }
  parts.push(trendTable(p), reviewCard(p));
  return `<div class="kpis-page">${parts.join("")}</div>`;
}
