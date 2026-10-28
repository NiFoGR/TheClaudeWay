// The Todo page's HTML (stage 11, docs/rebuild/11-todo-kpis.md Part A "Todo page"), as pure functions of GET /api/todo's
// board: the health lights, Today's rows (Overdue, today, Coming up), the pipeline columns and the client cards.
// todo.js puts them on the page and wires the buttons (Done, Dismiss, Send, Edit).
//
// Business names, todo titles and details, Claude's drafts and every other value come from scraped sites, inbound mail
// or Claude: all of it goes through esc(), and a link is used only when it's an in-app "/#/…" link or an http(s) page
// (safeUrl). This file imports only pure modules (html.js, leadview.js), never lib.js (it reads the page when it loads),
// so tests/todoview.test.mjs runs it in node.
import { esc, icon, safeUrl } from "./html.js";
import { gradeBadge } from "./leadview.js";

const EMPTY_TODAY = "Nothing for you right now. New things show up here the moment they need you.";
const EMPTY_BOARD = "No one in the pipeline yet. Pick today's leads on the Leads page.";
const EMPTY_COLUMN = "Nobody here";
const EMPTY_CLIENTS = "No clients yet. Your first one shows up here the minute they pay.";
const ALL_FINE = "✓ Everything is running.";
const NO_CARE = "No care tasks due";

const LEVEL_RANK = { red: 0, amber: 1, green: 2, grey: 3 };
const SENDABLE = new Set(["escalation", "call_time"]);
const PHASE_WORDS = { onboarding: "Onboarding", building: "Building", live: "Live" };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const listOf = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const count = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * A link as {href, external}, or null: in-app links ("/#/…", or "#/…" made "/#/…") as they are, other pages only
 * when they're http(s) (safeUrl). Anything else (javascript:, data:, junk) gives no link at all.
 */
function linkOf(value) {
  const s = str(value);
  if (!s) return null;
  if (s.startsWith("/#/")) return { href: s, external: false };
  if (s.startsWith("#/")) return { href: `/${s}`, external: false };
  const url = safeUrl(s);
  return url ? { href: url, external: true } : null;
}

function linkButton(value, label, cls = "btn secondary sm") {
  const link = linkOf(value);
  if (!link) return "";
  const out = link.external ? ' target="_blank" rel="noopener"' : "";
  return `<a class="${cls}" href="${esc(link.href)}"${out}>${esc(label)}</a>`;
}

// ---------------------------------------------------------------- 1. Health lights

function lightRow(l) {
  const level = l.level === "red" ? "red" : "amber";
  const detail = str(l.detail) || str(l.name);
  const fix = str(l.fix) ? `<div class="fix">${esc(l.fix)}</div>` : "";
  return `<div class="light ${level}"><span class="light-dot" role="img" aria-label="${level}"></span>
    <div><div class="detail"><b>${esc(detail)}</b></div>${fix}</div></div>`;
}

function okItem(l) {
  const text = str(l.detail) || str(l.name);
  if (l.level === "grey") return `<li class="grey">${esc(text)} <span class="faint">· not in use</span></li>`;
  return `<li>${esc(text)}</li>`;
}

/**
 * The lights (stage 0's {name, level, detail, fix}): each red or amber one a full-width row, its detail in bold and
 * its fix under it, red first; the greens folded into one chip ("✓ 3 checks fine") whose list also names the grey
 * lights as "not in use"; with no red or amber, one chip "✓ Everything is running.". `error` (GET /api/todo's
 * health_error) → "Couldn't check the system lights: <error>. Refresh the page."
 */
export function lightsHtml(lights, error = null) {
  const all = listOf(lights);
  const rank = (l) => LEVEL_RANK[l.level] ?? LEVEL_RANK.grey;
  const sorted = [...all].sort((a, b) => rank(a) - rank(b) || String(a.name ?? "").localeCompare(String(b.name ?? "")));
  const problems = sorted.filter((l) => l.level === "red" || l.level === "amber");
  const greens = sorted.filter((l) => l.level === "green");
  const greys = sorted.filter((l) => rank(l) === LEVEL_RANK.grey);
  const why = str(error).replace(/[.\s]+$/, "");
  const failed = why ? `<p class="error">${esc(`Couldn't check the system lights: ${why}. Refresh the page.`)}</p>` : "";

  let chip = "";
  const label = problems.length ? (greens.length ? `✓ ${plural(greens.length, "check fine", "checks fine")}` : "") : (why ? "" : ALL_FINE);
  if (label) {
    const items = [...greens, ...greys].map(okItem).join("");
    chip = items
      ? `<details class="lights-ok" data-key="lights"><summary class="ok-chip">${esc(label)}</summary><ul class="lights-list">${items}</ul></details>`
      : `<div class="lights-ok"><span class="ok-chip">${esc(label)}</span></div>`;
  }
  return `<div class="lights">${failed}${problems.map(lightRow).join("")}${chip}</div>`;
}

// ---------------------------------------------------------------- 2. Today

const UK_CALL = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "Tue 11:00" (UK) for a call's due_at, or "" when it can't be read. */
function callTime(value) {
  const d = typeof value === "string" && value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(UK_CALL.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.hour}:${p.minute}`;
}

/** The Call button (tel:, spaces and punctuation stripped), or "" when there's no number to ring. */
function callButton(phone) {
  const shown = str(phone);
  const dial = shown.replace(/[^\d+]/g, "");
  if (!/\d/.test(dial)) return "";
  return `<a class="btn sm" href="tel:${esc(dial)}">${icon("phone")}${esc(`Call ${shown}`)}</a>`;
}

const STATUS_BUTTONS = `<button type="button" class="btn secondary sm" data-status="done">Done</button>`
  + `<button type="button" class="btn ghost sm" data-status="dismissed">Dismiss</button>`;

/**
 * One open todo (a GET /api/todo item) with the words and buttons of its kind (Part A's table): escalation and
 * call_time show Claude's draft read-only, with Send and Edit only when `can_send`; call has Call <phone>; hot has Call
 * (with a phone) and Open lead; the rest have Open. Done and Dismiss on every row.
 */
export function todoItemHtml(item) {
  const t = isObj(item) ? item : {};
  const kind = str(t.kind) || "setup";
  const sendable = SENDABLE.has(kind);
  const canSend = sendable && t.can_send === true && typeof t.draft === "string" && t.draft !== "";

  const meta = [];
  if (kind === "call") {
    const when = callTime(t.due_at);
    if (when) meta.push(when);
  }
  if ((kind === "call" || kind === "hot") && str(t.phone)) meta.push(str(t.phone));

  const parts = [`<div class="todo-title">${esc(t.title)}</div>`];
  if (meta.length) parts.push(`<div class="todo-meta">${esc(meta.join(" · "))}</div>`);
  if (str(t.detail)) parts.push(`<div class="todo-detail">${esc(t.detail)}</div>`);
  if (sendable && typeof t.draft === "string" && t.draft !== "") parts.push(`<div class="draft-box" data-draft>${esc(t.draft)}</div>`);

  const buttons = [];
  const thread = linkOf(t.thread_link) ? linkButton(t.thread_link, "Open email thread") : "";
  const sameAs = (a, b) => linkOf(a) && linkOf(b) && linkOf(a).href === linkOf(b).href;
  if (sendable) {
    if (canSend) buttons.push(`<button type="button" class="btn sm" data-send>Send</button>`, `<button type="button" class="btn secondary sm" data-edit>Edit</button>`);
    buttons.push(thread);
    if (!canSend && !sameAs(t.link, t.thread_link)) buttons.push(linkButton(t.link, "Open"));
  } else if (kind === "call") {
    buttons.push(callButton(t.phone), thread);
    if (!sameAs(t.link, t.thread_link)) buttons.push(linkButton(t.link, "Open call"));
  } else if (kind === "hot") {
    buttons.push(callButton(t.phone), linkButton(t.lead_link, "Open lead"));
  } else {
    buttons.push(linkButton(t.link, "Open"));
  }
  buttons.push(STATUS_BUTTONS);

  return `<div class="todo-item" data-todo="${esc(t.id)}" data-kind="${esc(kind)}">
    <div class="todo-main">${parts.join("")}</div>
    <div class="todo-actions">${buttons.filter(Boolean).join("")}</div>
  </div>`;
}

/**
 * Today's three groups ({overdue, today, later}, already sorted by the server): Overdue under a red label, today with
 * no label, Coming up collapsed as "Coming up (<n>)". Nothing overdue or due today → the empty line.
 */
export function todoListHtml(today) {
  const g = isObj(today) ? today : {};
  const overdue = listOf(g.overdue), now = listOf(g.today), later = listOf(g.later);
  const rows = (items) => items.map(todoItemHtml).join("");
  const out = [];
  if (overdue.length) out.push(`<div class="todo-group overdue" data-group="overdue"><div class="group-label late">Overdue</div>${rows(overdue)}</div>`);
  if (now.length) out.push(`<div class="todo-group" data-group="today">${rows(now)}</div>`);
  if (!overdue.length && !now.length) out.push(`<p class="empty-line">${esc(EMPTY_TODAY)}</p>`);
  if (later.length) {
    out.push(`<details class="todo-later" data-key="later" data-group="later"><summary>Coming up (${later.length})</summary>${rows(later)}</details>`);
  }
  return `<div class="todo-list">${out.join("")}</div>`;
}

// ---------------------------------------------------------------- 3. Pipeline

function pcardHtml(card) {
  const c = isObj(card) ? card : {};
  const name = str(c.business) || "Unknown business";
  const hot = c.hot === true ? ` <span class="tag hot">Hot</span>` : "";
  const body = `<span class="pcard-top"><span class="biz">${esc(name)}</span>${gradeBadge(c.grade)}${hot}</span>
      ${str(c.event) ? `<span class="pcard-event">${esc(c.event)}</span>` : ""}
      ${str(c.next) ? `<span class="pcard-next">${esc(c.next)}</span>` : ""}`;
  const lead = linkOf(c.lead_link);
  const main = lead && !lead.external ? `<a class="pcard-link" href="${esc(lead.href)}">${body}</a>` : `<div class="pcard-link">${body}</div>`;
  const thread = linkOf(c.thread_link);
  const threadLink = thread && !thread.external ? `<a class="pcard-thread" href="${esc(thread.href)}">Email thread</a>` : "";
  return `<div class="pcard${c.hot === true ? " hot" : ""}">${main}${threadLink}</div>`;
}

function cardsHtml(cards, more) {
  const list = listOf(cards);
  const extra = count(more) ? `<a class="more" href="/#/leads?view=all">${esc(`+${count(more)} more on the Leads page`)}</a>` : "";
  return list.length ? `${list.map(pcardHtml).join("")}${extra}` : `<p class="faint empty-col">${esc(EMPTY_COLUMN)}</p>${extra}`;
}

/**
 * The pipeline ({columns: [{stage, label, count, more, cards}], lost: {count, more, cards}}): one column per stage
 * with its label and count, at most the cards the server sent and "+<n> more on the Leads page"; Lost collapsed
 * under them. Each column is a <details>, open when it has cards (on a phone they stack; todo.js keeps them all open
 * on a wide screen). No one at all → the empty line with a link to today's leads.
 */
export function pipelineHtml(pipeline) {
  const p = isObj(pipeline) ? pipeline : {};
  const columns = listOf(p.columns);
  const lost = isObj(p.lost) ? p.lost : {};
  const total = columns.reduce((n, c) => n + count(c.count), 0) + count(lost.count);
  if (!total) {
    return `<div class="empty-state"><p>${esc(EMPTY_BOARD)}</p><a class="btn secondary sm" href="/#/leads?view=ready">Open the Leads page</a></div>`;
  }
  const col = (c) => {
    const n = count(c.count);
    const open = listOf(c.cards).length ? " open" : "";
    return `<details class="col" data-key="col:${esc(c.stage)}"${open}>
      <summary><span class="col-label">${esc(c.label || c.stage)}</span><span class="n">${n}</span></summary>
      <div class="col-cards">${cardsHtml(c.cards, c.more)}</div>
    </details>`;
  };
  return `<div class="board">${columns.map(col).join("")}</div>
    <details class="lost" data-key="lost"><summary>Lost (${count(lost.count)})</summary><div class="lost-cards">${cardsHtml(lost.cards, lost.more)}</div></details>`;
}

// ---------------------------------------------------------------- 4. Clients

function ccardHtml(card) {
  const c = isObj(card) ? card : {};
  const phase = Object.hasOwn(PHASE_WORDS, c.phase ?? "") ? PHASE_WORDS[c.phase] : "";
  const line = (text, late = false) => (str(text) ? `<li${late ? ' class="late"' : ""}>${esc(text)}</li>` : "");
  const rankLink = linkOf(c.rank_link);
  const rank = str(c.rank)
    ? `<li>${rankLink && !rankLink.external ? `<a href="${esc(rankLink.href)}">${esc(c.rank)}</a>` : esc(c.rank)}</li>`
    : "";
  return `<div class="ccard${c.attention === true ? " attention" : ""}">
    <div class="ccard-head"><span class="biz">${esc(str(c.name) || "Unnamed client")}</span>${phase ? `<span class="badge plain${c.phase === "live" ? " good" : ""}">${esc(phase)}</span>` : ""}</div>
    <ul class="ccard-lines">
      ${line(c.build, c.late === true)}${line(c.guarantee)}${rank}${line(c.monthly, c.card_failed === true)}${line(str(c.care) || NO_CARE)}
    </ul>
  </div>`;
}

/**
 * The client cards ({cards, past}, already in order): phase, build, guarantee, rank (linked to Map Rank), monthly and
 * the next care task; late builds and failed cards in red. Under them "<n> past clients on the Money page".
 */
export function clientsHtml(clients) {
  const c = isObj(clients) ? clients : {};
  const cards = listOf(c.cards);
  const past = count(c.past);
  const pastLine = past ? `<p class="hint"><a href="/#/money">${esc(`${plural(past, "past client", "past clients")} on the Money page`)}</a></p>` : "";
  if (!cards.length) {
    return past ? `<p class="empty-line">No current clients.</p>${pastLine}` : `<p class="empty-line">${esc(EMPTY_CLIENTS)}</p>`;
  }
  return `<div class="ccards">${cards.map(ccardHtml).join("")}</div>${pastLine}`;
}
