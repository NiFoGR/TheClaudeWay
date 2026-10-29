// Todo board words and cards (pure, no D1): the pipeline columns, each card's last event and next follow-up line,
// the client cards, and the UK "when" words they use. Rules are docs/rebuild/11-todo-kpis.md Part A ("Pipeline",
// "Clients").
//
// Owned by the Todo stage. `_lib/todo.js`'s loadBoard feeds it rows; other stages' todo links use leadLink/threadLink.

import { clientStatus } from "./money.js";
import { formatPounds } from "./offer.js";
import { isHot, STAGE_LABELS } from "./shortlist.js";
import { ukDate, ukParts } from "./ukTime.js";

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

export const COLUMN_STAGES = Object.freeze(["ready", "emailed", "viewed", "replied", "needs_nik", "call_booked", "won"]);
export const CARD_CAP = 50;
export const LOST_WORDS = Object.freeze({
  opt_out: "Said no thanks", bounce: "Email bounced", sequence_done: "No reply to any email", not_now: "Not right now",
  not_interested: "Not interested", call: "Said no on the call",
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FOLLOWUP_STAGES = new Set(["emailed", "viewed"]);
const LAST_FOLLOWUP = 9;

const pad = (n) => String(n).padStart(2, "0");

/** In-app link to a lead's drawer (the id is URL-encoded, like every other stage's links; the router decodes it). */
export const leadLink = (id) => `/#/lead/${encodeURIComponent(id)}`;
/** In-app link to a lead's email thread. */
export const threadLink = (id) => `/#/replies/${encodeURIComponent(id)}`;

// A stored time (ISO string, Date or ms) as a Date, or null when it's missing or unreadable.
function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Milliseconds of a stored time, or null.
const msOf = (value) => toDate(value)?.getTime() ?? null;

// UTC midnight (ms) of a real UK day "YYYY-MM-DD", or null when it isn't one ("2026-02-31" is null, not 3 Mar).
function dayMs(ukDateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ukDateStr ?? ""));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? ms : null;
}

// UK clock offset (whole hours, 0 or 1) at UTC noon of each UTC day, by day number. UK clocks change at 01:00 UTC, so
// the offset at noon is the one in force from 01:00 UTC to the end of that UTC day; before 01:00 UTC the UK date is
// the UTC date whatever the offset. So the UK day of any instant is the UTC day of (instant + that day's offset): the
// same day ukDate gives (board.test checks both sides of both changes). One Intl call per day instead of one per hour
// keeps a cold board well inside the free plan's 10 ms of CPU.
const noonOffset = new Map();

// The UK calendar day of `date` as a day number (UTC midnight of that UK date / DAY_MS).
function ukDayNumber(date) {
  const ms = date.getTime();
  const day = Math.floor(ms / DAY_MS);
  let off = noonOffset.get(day);
  if (off === undefined) {
    off = ukParts(new Date(day * DAY_MS + 12 * HOUR_MS)).hh - 12;
    if (noonOffset.size >= 4096) noonOffset.clear();
    noonOffset.set(day, off);
  }
  return Math.floor((ms + off * HOUR_MS) / DAY_MS);
}

const shortOf = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
const dayDateOf = (d) => `${WEEKDAYS[d.getUTCDay()]} ${shortOf(d)}`;

/** "15 Oct" for a UK day "YYYY-MM-DD" ("" when it isn't one). */
export function ukShortDate(ukDateStr) {
  const ms = dayMs(ukDateStr);
  return ms === null ? "" : shortOf(new Date(ms));
}

/** "Sat 24 Oct" for a UK day "YYYY-MM-DD" ("" when it isn't one). */
export function ukDayDate(ukDateStr) {
  const ms = dayMs(ukDateStr);
  return ms === null ? "" : dayDateOf(new Date(ms));
}

/** A past time in words (UK days): "today", "yesterday", "<n> days ago" (2–6), else "15 Oct". "" when unreadable. */
export function pastWhen(iso, now) {
  const at = toDate(iso), today = toDate(now);
  if (!at || !today) return "";
  const day = ukDayNumber(at);
  const days = ukDayNumber(today) - day;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days >= 2 && days <= 6) return `${days} days ago`;
  return shortOf(new Date(day * DAY_MS));
}

/** A future time in words (UK days): "today", "tomorrow", else "Sat 24 Oct". "" when unreadable. */
export function futureWhen(iso, now) {
  const at = toDate(iso), today = toDate(now);
  if (!at || !today) return "";
  const day = ukDayNumber(at);
  const days = day - ukDayNumber(today);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return dayDateOf(new Date(day * DAY_MS));
}

// "<text> · <when>", or just the text when there's no readable time.
const withWhen = (text, when) => (when ? `${text} · ${when}` : text);

function count(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The words for the latest sent outbound email, by kind (and author for replies).
function outboundWords(row) {
  const kind = row.last_out_kind;
  if (kind === "first") return "You emailed";
  if (kind === "followup") {
    const step = count(row.last_out_step);
    return step ? `Follow-up ${step} sent` : "Follow-up sent";
  }
  if (kind === "reply" && row.last_out_author === "claude") return "Claude replied";
  if (kind === "reply" && row.last_out_author === "nik") return "You replied";
  return "Email sent";
}

/**
 * A pipeline card's last event in words, first match wins: won, lost (with its reason), a booked call, else the
 * newest of view / inbound / outbound, else "Demo ready".
 */
export function lastEvent(row, now) {
  const r = row || {};
  if (r.stage === "won") return withWhen("Paid", pastWhen(r.stage_at, now));
  if (r.stage === "lost") {
    const reason = Object.hasOwn(LOST_WORDS, r.lost_reason ?? "") ? LOST_WORDS[r.lost_reason] : "Lost";
    return withWhen(reason, pastWhen(r.stage_at, now));
  }
  const call = r.stage === "call_booked" ? toDate(r.call_at) : null;
  if (call) {
    const { hh, mm } = ukParts(call);
    return `Call ${futureWhen(call, now)} ${pad(hh)}:${pad(mm)}`;
  }
  // Newest of the three; on an exact tie the earlier one in this list wins.
  const events = [
    { at: msOf(r.last_view_at), text: () => (count(r.views) > 1 ? `Viewed site ${count(r.views)}×` : "Viewed site once"), iso: r.last_view_at },
    { at: msOf(r.last_inbound_at), text: () => "Replied", iso: r.last_inbound_at },
    { at: msOf(r.last_out_at), text: () => outboundWords(r), iso: r.last_out_at },
  ].filter((e) => e.at !== null);
  if (events.length) {
    const newest = events.reduce((a, b) => (b.at > a.at ? b : a));
    return withWhen(newest.text(), pastWhen(newest.iso, now));
  }
  return withWhen("Demo ready", pastWhen(r.stage_at, now));
}

/**
 * The next follow-up line, only for `emailed`/`viewed` cards with `next_followup_at` set. It branches on
 * `followup_step` (a missing step is 0): below 9 it's the next email; at 9 `next_followup_at` is the close time.
 */
export function nextLine(row, now) {
  const r = row || {};
  if (!FOLLOWUP_STAGES.has(r.stage)) return null;
  const when = futureWhen(r.next_followup_at, now);
  if (!when) return null;
  return count(r.followup_step) < LAST_FOLLOWUP ? `Next email ${when}` : `No more emails · closes ${when}`;
}

// Test and drill leads never show (stage 7's rule; SQL LIKE is case-insensitive for ASCII, so this is too).
const isTestLead = (id) => /^(drill|test):/i.test(String(id ?? ""));

// A card for one pipeline row; `hot` is already worked out by the caller.
function card(row, hot, now) {
  const id = row.place_id;
  return {
    place_id: id,
    business: row.name ?? null,
    grade: row.grade || "–",
    hot,
    event: lastEvent(row, now),
    next: nextLine(row, now),
    lead_link: leadLink(id),
    thread_link: row.stage === "ready" ? null : threadLink(id),
  };
}

// Hot first, then newest stage_at first (missing last), then place_id so the order never wobbles.
function byBoardOrder(a, b) {
  if (a.hot !== b.hot) return a.hot ? -1 : 1;
  if (a.at !== b.at) {
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return b.at - a.at;
  }
  const ia = String(a.row.place_id), ib = String(b.row.place_id);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

// Up to CARD_CAP sorted cards, with the full count and how many didn't fit. Only the cards shown get their words
// worked out (UK dates cost CPU, and lost leads pile up), so a big pipeline stays inside the 10 ms CPU limit.
function bucket(entries, now) {
  const sorted = entries.sort(byBoardOrder);
  return {
    count: sorted.length,
    cards: sorted.slice(0, CARD_CAP).map((e) => card(e.row, e.hot, now)),
    more: Math.max(0, sorted.length - CARD_CAP),
  };
}

/**
 * Pipeline rows → one column per COLUMN_STAGES stage ({stage, label, count, cards, more}, at most CARD_CAP cards)
 * and the lost section ({count, cards, more}). Test/drill leads and rows of any other stage are left out.
 */
export function pipelineColumns(rows, now) {
  const by = new Map([...COLUMN_STAGES, "lost"].map((s) => [s, []]));
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || isTestLead(row.place_id) || !by.has(row.stage)) continue;
    by.get(row.stage).push({ row, hot: isHot(row, now), at: msOf(row.stage_at) });
  }
  return {
    columns: COLUMN_STAGES.map((stage) => ({ stage, label: STAGE_LABELS[stage], ...bucket(by.get(stage), now) })),
    lost: bucket(by.get("lost"), now),
  };
}

// ---------------------------------------------------------------- clients

const GUARANTEE_DAYS = 90;
const NOT_FOUND_RANK = 21; // lead-manager/aetos_leads/maprank.py NOT_FOUND
const PHASES = Object.freeze({ sent: "onboarding", submitted: "building", building: "building", review: "building", live: "live" });
const PHASE_RANK = Object.freeze({ building: 0, onboarding: 1, live: 2 });

// The Monthly line, by clientStatus key. Stage 11 adds `working_free` here; a key not listed gives no line.
const MONTHLY_WORDS = Object.freeze({
  free: (status) => (ukShortDate(status.firstCharge) ? `Free until ${ukShortDate(status.firstCharge)}` : null),
  paying: (status, c) => `${formatPounds(Number(c.monthly_pence) || 0)} a month`,
  "one-off": () => "Website only",
});

/**
 * The guarantee line for a client live since `liveAtIso`, on UK day `ukToday` ("YYYY-MM-DD"): day = UK days since
 * going live + 1. Up to day 90 "Guarantee day <d> of 90", then "90-day guarantee ended <live + 89 days>".
 * Stage 11 swaps this for guaranteeLabel(care, ukToday) on clients with a `care` row. null when a date is unreadable.
 */
export function guaranteeWords(liveAtIso, ukToday) {
  const live = toDate(liveAtIso), today = dayMs(ukToday);
  if (!live || today === null) return null;
  const liveDay = ukDayNumber(live);
  const day = Math.max(1, today / DAY_MS - liveDay + 1);
  if (day <= GUARANTEE_DAYS) return `Guarantee day ${day} of ${GUARANTEE_DAYS}`;
  return `90-day guarantee ended ${shortOf(new Date((liveDay + GUARANTEE_DAYS - 1) * DAY_MS))}`;
}

/**
 * The Rank line and its link from the client's lead_map_rank row (`scan_id, top3_pct, avg_rank, rank_updated_at`,
 * by the client's `place_id`). Stage 11 swaps in its latest scored care_scans row for clients with a `care` row.
 */
export function rankWords(row, now) {
  const r = row || {};
  if (r.scan_id === null || r.scan_id === undefined || r.scan_id === "") {
    return { rank: "No Map Rank scan yet", rank_link: "/#/maprank" };
  }
  const top3 = Math.round(Number(r.top3_pct) || 0);
  const avg = Number(r.avg_rank);
  // A business found at no grid point averages NOT_FOUND (21, maprank.py), which is no real position: the Map Rank
  // page shows it as "20+", and so does the card.
  const position = !Number.isFinite(avg) ? "–" : avg >= NOT_FOUND_RANK ? "20+" : avg.toFixed(1);
  const words = `Top 3 in ${top3}% of their area · average position ${position}`;
  const checked = pastWhen(r.rank_updated_at, now);
  return {
    rank: checked ? `${words} · checked ${checked}` : words,
    rank_link: `/#/maprank?scan=${encodeURIComponent(r.scan_id)}&biz=${encodeURIComponent(r.place_id ?? "")}`,
  };
}

// The build line, and whether it is late. `today` is the UK day number.
function buildLine(row, phase, today, now) {
  if (phase === "live") return { build: null, late: false };
  if (phase === "onboarding") {
    if (row.ob_status === null || row.ob_status === undefined) return { build: "Onboarding form not sent yet", late: false };
    if (row.ob_status === "sent") {
      const sent = pastWhen(row.ob_created_at, now);
      return { build: withWhen("Waiting for their onboarding form", sent && `sent ${sent}`), late: false };
    }
    return { build: null, late: false };
  }
  const due = toDate(row.due_live_at);
  if (!due) return { build: null, late: false };
  const dueDay = ukDayNumber(due);
  const days = dueDay - today;
  if (days >= 2) return { build: `Live by ${dayDateOf(new Date(dueDay * DAY_MS))} · ${days} days left`, late: false };
  if (days === 1) return { build: "Live by tomorrow", late: false };
  if (days === 0) return { build: "Due live today", late: false };
  return { build: `${-days} ${days === -1 ? "day" : "days"} late`, late: true };
}

function clientCard(row, status, today, todayStr, now) {
  const phase = row.ob_status === null || row.ob_status === undefined ? "onboarding" : (PHASES[row.ob_status] ?? "onboarding");
  const { build, late } = buildLine(row, phase, today, now);
  const card_failed = Boolean(row.failed_on);
  const monthly = card_failed
    ? `Card failed ${ukShortDate(String(row.failed_on).slice(0, 10))}`.trim()
    : (Object.hasOwn(MONTHLY_WORDS, status.key) ? MONTHLY_WORDS[status.key](status, row) : null);
  const guarantee = Number(row.monthly_pence) > 0 && row.live_at ? guaranteeWords(row.live_at, todayStr) : null;
  const { rank, rank_link } = rankWords(row, now);
  const care = row.care_title ? withWhen(row.care_title, futureWhen(row.care_due_at, now)) : null;
  return {
    client_id: row.id ?? row.client_id, name: row.name ?? null, place_id: row.place_id ?? null, phase, build, late,
    guarantee, rank, rank_link, monthly, card_failed, attention: late || card_failed, care,
  };
}

const textCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Late builds, then failed cards, then building (soonest due first), onboarding, live; then name, then id.
function byClientOrder(a, b) {
  if (a.card.late !== b.card.late) return a.card.late ? -1 : 1;
  if (a.card.card_failed !== b.card.card_failed) return a.card.card_failed ? -1 : 1;
  const pa = PHASE_RANK[a.card.phase], pb = PHASE_RANK[b.card.phase];
  if (pa !== pb) return pa - pb;
  if (a.card.phase === "building" && a.due !== b.due) {
    if (a.due === null) return 1;
    if (b.due === null) return -1;
    return a.due - b.due;
  }
  return textCmp(String(a.card.name ?? "").toLowerCase(), String(b.card.name ?? "").toLowerCase())
    || textCmp(String(a.card.client_id), String(b.card.client_id));
}

/**
 * Client rows (a `clients` row joined with onboarding `ob_status, ob_created_at, due_live_at, live_at`,
 * `client_links.failed_on`, lead_map_rank `scan_id, top3_pct, avg_rank, rank_updated_at` and the next care todo
 * `care_title, care_due_at`) → the Todo page's client cards, in order, and how many past (stopped) clients there are.
 */
export function clientCards(rows, now) {
  // `now` may be a Date or an ISO string, like the pipeline's; ukDate needs a Date (and throws on an unreadable one).
  const todayStr = ukDate(toDate(now) ?? new Date(NaN));
  const today = dayMs(todayStr) / DAY_MS;
  const shown = [];
  let past = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const status = clientStatus(row, todayStr);
    if (status.key === "stopped") { past += 1; continue; }
    shown.push({ card: clientCard(row, status, today, todayStr, now), due: msOf(row.due_live_at) });
  }
  return { cards: shown.sort(byClientOrder).map((e) => e.card), past };
}
