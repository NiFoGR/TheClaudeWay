// Weekly KPIs (pure). Weeks are ISO weeks in UK time: Monday 00:00 UK to Sunday 23:59 UK, stored as "2026-W43",
// and an event belongs to the week whose UK dates contain ukDate(event time). Rates carry their sample size so the
// page can say "too early to tell" instead of reading meaning into a handful of emails.
// computeWeek turns the week's rows into the page's numbers, crediting every inbound and demo view to the latest email
// we sent that lead before it (last touch). Spec: docs/rebuild/11-todo-kpis.md Part A, "Definitions (exact)".
import { addUkDays, ukDate, ukToUtc } from "./ukTime.js";

/** Below this many in the sample a rate is "early": shown grey with "too early to tell". */
export const MIN_SAMPLE = 30;
/** A demo view is credited to an email only within this many days of it (and counts for Nik's first emails). */
export const VIEW_WINDOW_DAYS = 7;
/** A Claude reply "moved the lead forward" if a positive reply, a booked call or an order came within this many days. */
export const FORWARD_WINDOW_DAYS = 7;
/** A human reply with one of these intents (stage 7) is positive. */
export const POSITIVE_INTENTS = ["interested", "question", "price", "more_info", "call_request", "proposes_time", "confirms_slot"];

const DAY_MS = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEK_RE = /^(\d{4})-W(\d{2})$/;
// A stored time with no zone ("2026-10-19 08:00:00") is UTC, like every time we store (see followups.js).
const NO_ZONE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

const pad = (n, width = 2) => String(n).padStart(width, "0");

// A UK date string as a UTC-midnight Date (calendar maths only, no clock). addUkDays checks the format.
const asDay = (ukDateStr) => new Date(`${addUkDays(ukDateStr, 0)}T00:00:00Z`);
const isoDay = (day) => day.getUTCDay() || 7; // Monday 1 … Sunday 7

/** The ISO week of UK day "YYYY-MM-DD": the Thursday of its Monday-to-Sunday week decides the year. */
export function isoWeekOf(ukDateStr) {
  const day = asDay(ukDateStr);
  const thursday = new Date(day.getTime() + (4 - isoDay(day)) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return `${pad(year, 4)}-W${pad(week)}`;
}

/** The UK Monday "YYYY-MM-DD" that starts ISO week "YYYY-Www". Throws in plain words on a week that doesn't exist. */
export function weekStartOf(week) {
  const m = WEEK_RE.exec(String(week));
  const bad = () => new Error(`Week should look like 2026-W43, got ${JSON.stringify(week)}`);
  if (!m) throw bad();
  const year = Number(m[1]), n = Number(m[2]);
  // 4 January is always in week 1; its Monday starts week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() + (1 - isoDay(jan4) + 7 * (n - 1)) * DAY_MS);
  const start = `${pad(monday.getUTCFullYear(), 4)}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
  if (n < 1 || isoWeekOf(start) !== `${m[1]}-W${m[2]}`) throw bad();
  return start;
}

const dayMonth = (ukDateStr) => {
  const d = asDay(ukDateStr);
  return { d: d.getUTCDate(), mon: MONTHS[d.getUTCMonth()] };
};

/** "19–25 Oct" within a month, "28 Sep – 4 Oct" across two (the page adds the year). */
export function weekLabel(week) {
  const start = weekStartOf(week);
  const a = dayMonth(start), b = dayMonth(addUkDays(start, 6));
  return a.mon === b.mon ? `${a.d}–${b.d} ${b.mon}` : `${a.d} ${a.mon} – ${b.d} ${b.mon}`;
}

/** The `n` weeks ending with `week`, oldest first. */
export function lastWeeks(week, n) {
  const start = weekStartOf(week);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(isoWeekOf(addUkDays(start, -7 * i)));
  return out;
}

// A stored UTC time (ISO, no-zone, a bare date or a Date) in ms, or NaN when it's missing or unreadable.
const timeOf = (iso) => {
  if (!iso) return NaN;
  return (iso instanceof Date ? iso : new Date(String(iso).trim().replace(NO_ZONE, "$1T$2Z"))).getTime();
};

/** Whether UTC time `iso` falls on a UK day of the week that starts on UK Monday `start`. A missing or unreadable time is in no week. */
export function inWeek(iso, start) {
  const end = addUkDays(start, 6);
  const t = timeOf(iso);
  if (Number.isNaN(t)) return false;
  const day = ukDate(new Date(t));
  return day >= start && day <= end;
}

/** k out of n as {k, n, pct, early}: pct to one decimal (null when n is 0), early while n < MIN_SAMPLE. */
export function rate(k, n) {
  // `!(n >= …)`: a missing or unreadable n is early too, never a confident-looking rate.
  return { k, n, pct: n > 0 ? Math.round((1000 * k) / n) / 10 : null, early: !(n >= MIN_SAMPLE) };
}

// ---------------------------------------------------------------- crediting and the week's numbers (Task 5)

const GRADES = ["A+", "A", "B", "C", "D"];
const KIND_RANK = { first: 0, followup: 1, reply: 2 };
const BOOKED = new Set(["confirmed", "done", "no_show"]);
const NIK_DATE = /^\s*\[Nik ([^\]]*)\]\s*/;
const NOT_A_FIT = /^not a fit\b\s*:?\s*/i; // stage 2's, as in public/js/researchcard.js
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const TALLY = ["bounced", "viewed", "replied", "positive", "opted_out"];

/** Test and drill leads (stage 7) and rows without a lead are never counted. */
const counted = (placeId) => {
  const p = typeof placeId === "string" ? placeId.trim() : "";
  return p !== "" && !p.startsWith("drill:") && !p.startsWith("test:");
};
const list = (x) => (Array.isArray(x) ? x : []);
const isHuman = (m) => m.class === "human";
const isPositive = (m) => isHuman(m) && POSITIVE_INTENTS.includes(m.intent);
const byTime = (a, b) => a.t - b.t || String(a.id ?? "").localeCompare(String(b.id ?? ""));
// A UK date: a bare "YYYY-MM-DD" as written (clients.paid_on is one), else the UK date of the stored time ("" if none).
const dayOf = (v) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (ISO_DAY.test(s)) return s;
  const t = timeOf(v);
  return Number.isNaN(t) ? "" : ukDate(new Date(t));
};
const push = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

// Each lead's sent emails, inbound mail and demo views, each sorted by time once (ties by id), so nothing depends on the
// order rows arrive in. Every entry is {t, row, id}.
function byLead(rows) {
  const leads = new Map();
  const lead = (p) => {
    if (!leads.has(p)) leads.set(p, { out: [], in: [], views: [] });
    return leads.get(p);
  };
  for (const m of list(rows?.messages)) {
    // Counted: a sent email or an inbound one, to or from a real lead, with a readable time (parsed once).
    const side = m?.direction === "out" && m.status === "sent" ? "out" : m?.direction === "in" ? "in" : null;
    if (!side || !counted(m.place_id)) continue;
    const t = timeOf(side === "out" ? m.sent_at : m.received_at);
    if (!Number.isNaN(t)) lead(m.place_id)[side].push({ t, row: m, id: m.id });
  }
  for (const v of list(rows?.views)) {
    const t = timeOf(v?.at);
    if (counted(v?.place_id) && !Number.isNaN(t)) lead(v.place_id).views.push({ t, row: v, id: v.at });
  }
  for (const l of leads.values()) for (const k of ["out", "in", "views"]) l[k].sort(byTime);
  return leads;
}

// The latest sent email in `outs` (sorted) strictly before time t, or null: a backwards scan.
function latestBefore(outs, t) {
  for (let i = outs.length - 1; i >= 0; i--) if (outs[i].t < t) return outs[i];
  return null;
}

const blank = () => ({ viewed: false, replied: false, positive: false, bounced: false, opted_out: false });

function creditLeads(leads) {
  const out = new Map();
  for (const l of leads.values()) {
    for (const o of l.out) out.set(o.id, blank());
    for (const m of l.in) {
      const o = latestBefore(l.out, m.t);
      if (!o) continue;
      const c = out.get(o.id);
      if (m.row.class === "bounce") c.bounced = true;
      else if (m.row.class === "opt_out") c.opted_out = true;
      else if (isHuman(m.row)) {
        c.replied = true;
        if (isPositive(m.row)) c.positive = true;
      }
    }
    for (const v of l.views) {
      const o = latestBefore(l.out, v.t);
      if (o && v.t - o.t <= VIEW_WINDOW_DAYS * DAY_MS) out.get(o.id).viewed = true;
    }
  }
  return out;
}

/**
 * Last-touch credit for every counted sent email (status 'sent', a real lead): Map id → {viewed, replied, positive,
 * bounced, opted_out}. Each inbound (bounce, opt-out, human) goes to the latest email sent that lead before it; each
 * demo view too, if within VIEW_WINDOW_DAYS of that email. A message counts each once, however many events it gets.
 */
export function credit(rows) {
  return creditLeads(byLead(rows));
}

// The week-independent work on `rows` (parsing times, sorting, crediting, indexing by lead), done once and reused for
// every week computed from the same rows: the page computes 4 weeks per request on the free plan's 10 ms of CPU.
// Reused only while the rows object still holds the same arrays (and grades object) at the same sizes; rows are built
// once per request and never edited in place.
const PREPARED = new WeakMap();
const KEYS = ["messages", "views", "calls", "orders", "research", "escalations", "grades", "calibration"];
const sizeOf = (x) => (Array.isArray(x) ? x.length : x && typeof x === "object" ? Object.keys(x).length : -1);

function prepare(rows) {
  const src = KEYS.map((k) => rows?.[k]);
  const lens = src.map(sizeOf);
  const cacheable = rows !== null && typeof rows === "object";
  const hit = cacheable ? PREPARED.get(rows) : undefined;
  if (hit && hit.src.every((x, i) => x === src[i]) && hit.lens.every((n, i) => n === lens[i])) return hit.data;

  const leads = byLead(rows);
  const credits = creditLeads(leads);
  const allOut = [...leads.values()].flatMap((l) => l.out).sort(byTime);
  const allIn = [...leads.values()].flatMap((l) => l.in).sort(byTime);

  const calls = [];
  const callsByLead = new Map();
  for (const c of list(rows?.calls)) {
    const t = timeOf(c?.created_at);
    if (!counted(c?.place_id) || !BOOKED.has(c.status) || Number.isNaN(t)) continue;
    calls.push(t);
    push(callsByLead, c.place_id, t);
  }
  const orders = [];
  const ordersByLead = new Map();
  for (const o of list(rows?.orders)) {
    if (!counted(o?.place_id)) continue;
    const x = { day: dayOf(o.paid_on), pence: Number(o.build_fee_pence) || 0 };
    orders.push(x);
    push(ordersByLead, o.place_id, x);
  }

  const research = [];
  const flagDays = []; // the UK dates of the "[Nik YYYY-MM-DD] …" lines that say Claude's research was wrong
  for (const r of list(rows?.research)) {
    if (!counted(r?.place_id)) continue;
    if (r.status === "done") {
      research.push({
        t: timeOf(r.researched_at),
        email: typeof r.best_email === "string" && r.best_email.trim() !== "",
        too_big: Number(r.too_big) === 1 || r.too_big === true,
      });
    }
    for (const line of String(r.notes ?? "").replace(/\r\n?/g, "\n").split("\n")) {
      const m = NIK_DATE.exec(line);
      if (!m || !ISO_DAY.test(m[1].trim())) continue;
      if (NOT_A_FIT.test(line.replace(NIK_DATE, ""))) continue; // Nik turned the lead down: not a "Research is wrong"
      flagDays.push(m[1].trim());
    }
  }

  // Escalations to Nik from Claude's replies only: not unknown senders' or clients' mail (loadKpiRows filters too).
  const escalations = [];
  for (const e of list(rows?.escalations)) {
    const d = typeof e?.dedupe === "string" ? e.dedupe : null;
    if (d !== null && (!d.startsWith("escalation:") || d.startsWith("escalation:unknown:") || d.startsWith("escalation:client:"))) continue;
    if (e?.place_id != null && !counted(e.place_id)) continue;
    const t = timeOf(e?.created_at);
    if (!Number.isNaN(t)) escalations.push(t);
  }

  // Grade calibration, counted up to now: each lead's first first-email time, and whether it ever viewed/replied/ordered.
  // loadKpiRows reads only the weeks shown, so it sends this worked out in SQL over all time as `calibration`
  // ([{grade, first_ms, viewed, replied, won}], one per graded lead with a sent first email). Without it (pure rows),
  // it's worked out here from the messages, views, orders and `grades` ({place_id: grade}).
  const g = rows?.grades && typeof rows.grades === "object" ? rows.grades : {};
  const graded = [];
  for (const c of Array.isArray(rows?.calibration) ? rows.calibration : []) {
    const firstT = Number(c?.first_ms);
    if (!GRADES.includes(c?.grade) || !Number.isFinite(firstT)) continue;
    graded.push({ grade: c.grade, firstT, viewed: Boolean(c.viewed), replied: Boolean(c.replied), won: Boolean(c.won) });
  }
  if (!Array.isArray(rows?.calibration)) for (const [p, l] of leads) {
    const grade = Object.prototype.hasOwnProperty.call(g, p) ? g[p] : null;
    if (!GRADES.includes(grade)) continue;
    const firstOut = l.out.find((o) => o.row.kind === "first");
    if (!firstOut) continue;
    graded.push({
      grade, firstT: firstOut.t, viewed: l.views.length > 0,
      replied: l.in.some((m) => isHuman(m.row)), won: ordersByLead.has(p),
    });
  }

  const data = { leads, credits, allOut, allIn, calls, callsByLead, orders, ordersByLead, research, flagDays, escalations, graded };
  if (cacheable) PREPARED.set(rows, { src, lens, data });
  return data;
}

// The lead opened its demo within VIEW_WINDOW_DAYS of email `o` (an entry of a lead's `out`), whichever email the
// view is credited to.
const viewedWithin = (P, o) => P.leads.get(o.row.place_id).views.some((v) => v.t >= o.t && v.t - o.t <= VIEW_WINDOW_DAYS * DAY_MS);

// A Claude reply `o` (an entry of a lead's `out`) moved the lead forward: within FORWARD_WINDOW_DAYS after it came a
// positive human reply, a booked call, or an order paid on a UK day from the reply's to the window's last.
function movedForward(P, o) {
  const p = o.row.place_id;
  const until = o.t + FORWARD_WINDOW_DAYS * DAY_MS;
  const within = (t) => t > o.t && t <= until;
  const fromDay = ukDate(new Date(o.t)), toDay = ukDate(new Date(until));
  return P.leads.get(p).in.some((m) => isPositive(m.row) && within(m.t))
    || (P.callsByLead.get(p) ?? []).some(within)
    || (P.ordersByLead.get(p) ?? []).some((x) => x.day >= fromDay && x.day <= toDay);
}

// The latest human inbound from the lead before Claude reply `o`, or null.
const lastHumanBefore = (P, o) => latestBefore(P.leads.get(o.row.place_id).in.filter((m) => isHuman(m.row)), o.t);

// Minutes from the latest human inbound before Claude reply `o` to the reply (overnight counts in full), or null.
function answerMinutes(P, o) {
  const last = lastHumanBefore(P, o);
  return last ? (o.t - last.t) / 60000 : null;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
};

const tally = (msgs, credits) => {
  const k = { sent: msgs.length, bounced: 0, viewed: 0, replied: 0, positive: 0, opted_out: 0 };
  for (const o of msgs) {
    const c = credits.get(o.id);
    for (const f of TALLY) if (c[f]) k[f] += 1;
  }
  return k;
};

/**
 * The numbers for the week starting on UK Monday `weekStart`, from loadKpiRows' rows (computeWeek's input shape in
 * Part B Task 5). Pure; an empty week gives zeros and `pct: null`, never NaN. Rows are prepared once per rows object,
 * so computing several weeks from the same rows costs little more than one.
 */
export function computeWeek(rows, weekStart) {
  const week = isoWeekOf(weekStart);
  if (weekStartOf(week) !== weekStart) throw new Error(`A week starts on a Monday: ${weekStart} isn't one`);
  const start = weekStart;
  const end = addUkDays(start, 6);
  // Monday 00:00 UK to the next Monday 00:00 UK, in UTC ms: the same as "ukDate(time) is one of the week's days".
  const startMs = ukToUtc(start, "00:00").getTime();
  const endMs = ukToUtc(addUkDays(start, 7), "00:00").getTime();
  const inRange = (t) => t >= startMs && t < endMs;
  const inDays = (day) => day >= start && day <= end;
  const P = prepare(rows);
  const { leads, credits } = P;

  const sent = P.allOut.filter((o) => inRange(o.t));
  const received = P.allIn.filter((m) => inRange(m.t));

  // Groups: first, followup, reply, then any other kind; within a kind (and among the others) first-seen by time.
  const groupMap = new Map();
  for (const o of sent) {
    const key = `${o.row.kind}:${o.row.author}`;
    if (!groupMap.has(key)) groupMap.set(key, { key, kind: o.row.kind, author: o.row.author, msgs: [], seen: groupMap.size });
    groupMap.get(key).msgs.push(o);
  }
  const rank = (g) => KIND_RANK[g.kind] ?? 3;
  const groups = [...groupMap.values()].sort((a, b) => rank(a) - rank(b) || a.seen - b.seen).map((g) => {
    const k = tally(g.msgs, credits);
    return {
      key: g.key, kind: g.kind, author: g.author, ...k,
      rates: { view: rate(k.viewed, k.sent), reply: rate(k.replied, k.sent), positive: rate(k.positive, k.sent) },
    };
  });

  // Steps 0 (the first email) to 9 (follow-up 9).
  const stepOf = (m) => (m.kind === "first" ? 0 : m.kind === "followup" ? Number(m.step) : NaN);
  const steps = [];
  for (let step = 0; step <= 9; step++) {
    const { sent: n, bounced, viewed, replied, positive, opted_out } = tally(sent.filter((o) => stepOf(o.row) === step), credits);
    steps.push({ step, sent: n, bounced, viewed, replied, positive, opted_out });
  }

  // Nik's first emails: a view within VIEW_WINDOW_DAYS of the first email counts, whichever email it's credited to.
  const firsts = sent.filter((o) => o.row.kind === "first" && o.row.author === "nik");
  let viewed7 = 0, replied = 0, positive = 0;
  for (const o of firsts) {
    if (viewedWithin(P, o)) viewed7 += 1;
    const c = credits.get(o.id);
    if (c.replied) replied += 1;
    if (c.positive) positive += 1;
  }
  const nik = {
    first_sent: firsts.length, view_rate: rate(viewed7, firsts.length),
    reply_rate: rate(replied, firsts.length), positive_rate: rate(positive, firsts.length),
  };

  // Claude's replies: moved forward (within FORWARD_WINDOW_DAYS after the reply), speed, escalations.
  const claudeReplies = sent.filter((o) => o.row.kind === "reply" && o.row.author === "claude");
  let moved = 0;
  const minutes = [];
  for (const o of claudeReplies) {
    if (movedForward(P, o)) moved += 1;
    const m = answerMinutes(P, o);
    if (m !== null) minutes.push(m);
  }
  const claude = {
    replies_sent: claudeReplies.length, moved_forward: rate(moved, claudeReplies.length),
    median_minutes: median(minutes), escalated: P.escalations.filter(inRange).length,
  };

  // Week totals.
  const weekOrders = P.orders.filter((o) => inDays(o.day));
  const totals = {
    sent: sent.length,
    bounced: received.filter((m) => m.row.class === "bounce").length,
    human_replies: received.filter((m) => isHuman(m.row)).length,
    positive_replies: received.filter((m) => isPositive(m.row)).length,
    opt_outs: received.filter((m) => m.row.class === "opt_out").length,
    calls_booked: P.calls.filter(inRange).length,
    orders: weekOrders.length,
    revenue_pence: weekOrders.reduce((sum, o) => sum + o.pence, 0),
  };

  // Grade calibration: leads first emailed before the week ended, everything counted up to now.
  const gradeRows = GRADES.map((grade) => {
    const leadsIn = P.graded.filter((x) => x.grade === grade && x.firstT < endMs);
    const k = (f) => leadsIn.filter((x) => x[f]).length;
    return {
      grade, emailed: leadsIn.length,
      viewed: rate(k("viewed"), leadsIn.length), replied: rate(k("replied"), leadsIn.length), won: rate(k("won"), leadsIn.length),
    };
  });

  // Research quality: rows done that week, and the week's "Research is wrong" presses.
  const done = P.research.filter((r) => inRange(r.t));
  const withEmail = done.filter((r) => r.email).length;
  const research = {
    researched: done.length, with_email: withEmail, hit_rate: rate(withEmail, done.length),
    wrong_flags: P.flagDays.filter(inDays).length, too_big: done.filter((r) => r.too_big).length,
  };

  return { week, start, end, label: weekLabel(week), groups, steps, nik, claude, totals, grades: gradeRows, research };
}

/** One row of the "Last 4 weeks" table. `positive` is the positive replies received that week. */
export function trendRow(numbers) {
  return {
    week: numbers.week, label: numbers.label, first_sent: numbers.nik.first_sent,
    view_rate: numbers.nik.view_rate, reply_rate: numbers.nik.reply_rate, positive: numbers.totals.positive_replies,
    moved_forward: numbers.claude.moved_forward, calls_booked: numbers.totals.calls_booked, orders: numbers.totals.orders,
  };
}

// ---------------------------------------------------------------- Claude's review and the Routine's samples (Task 6)

/** Claude's review: 1 to ANALYSIS_MAX characters, at most MAX_SUGGESTIONS numbered suggestions. */
export const ANALYSIS_MAX = 6000;
export const MAX_SUGGESTIONS = 3;
/** The Routine gets at most SAMPLE_MAX emails of each type, each body cut to SAMPLE_BODY_MAX characters. */
export const SAMPLE_MAX = 20;
export const SAMPLE_BODY_MAX = 1200;

const SUGGESTIONS_HEADING = /^\s*##\s+suggestions\b/i;
const NEXT_HEADING = /^\s*##\s/;
const SUGGESTION = /^\s*\d+[.)]\s/;

/**
 * The first line of each suggestion in Claude's markdown, without its number: the lines matching "1. " or "1) "
 * after the "## Suggestions" heading, up to the next "## " heading. [] when there's no such heading.
 */
export function suggestionLines(md) {
  const out = [];
  let inside = false;
  for (const line of String(md ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (SUGGESTIONS_HEADING.test(line)) inside = true;
    else if (NEXT_HEADING.test(line)) inside = false;
    else if (inside && SUGGESTION.test(line)) out.push(line.replace(SUGGESTION, "").trim());
  }
  return out;
}

/** How many numbered suggestions Claude's markdown has (see suggestionLines). */
export function countSuggestions(md) {
  return suggestionLines(md).length;
}

// An email address. The quantifiers are capped at the RFC's limits (64 for the local part, 255 for the domain), so every
// real address matches but a long unbroken word a prospect wrote costs linear time, not quadratic: uncapped, 2,400
// letters took about 7 ms, most of the free plan's 10 ms per request. outreach-report.js uses the same pattern.
const EMAIL = /[\w.+-]{1,64}@[\w.-]{1,255}/g;

// UK numbers written with dashes, dots or brackets, which outreach-report.js' pattern misses: "07700-900-123",
// "(01632) 960001", "+44 (0)7700 900123", "+44-7700-900123". A 0 or +44, then 9 to 12 more digits.
const PHONE_PUNCTUATED = /(?:\+44[\s-]*(?:\(0\)[\s-]*)?|\(0|\b0)\d(?:[\s().-]*\d){8,11}/g;

/**
 * Text for the Routine with email addresses and phone numbers taken out (the same patterns as
 * _lib/outreach-report.js, plus punctuated phone numbers), cut to SAMPLE_BODY_MAX characters.
 */
export function anonymise(text) {
  return String(text || "")
    .replace(EMAIL, "[email]")
    .replace(PHONE_PUNCTUATED, "[phone]") // first: the next pattern would take only the tail of "+44 (0)7700 900123"
    .replace(/(\+44|0)[\d\s]{9,13}/g, "[phone]")
    .slice(0, SAMPLE_BODY_MAX);
}

// loadKpiRows reads only the first 2 × SAMPLE_BODY_MAX characters of a sample body, so a body that long may end in the
// middle of a phone number ("07700 90") that anonymise no longer recognises, and that fragment reaches the cut when the
// addresses before it shrink to "[email]". Such a body loses its last word and any digits and phone punctuation just
// before it. A loop, not a regex: /\S*$/ on a long unbroken word is quadratic.
const PHONE_CHAR = /[\d\s().+-]/;
function uncut(text) {
  const t = String(text ?? "");
  if (t.length < 2 * SAMPLE_BODY_MAX) return t;
  let end = t.length;
  while (end > 0 && !/\s/.test(t[end - 1])) end--;
  while (end > 0 && PHONE_CHAR.test(t[end - 1])) end--;
  return t.slice(0, end);
}

// At most SAMPLE_MAX items: up to half of them with an outcome (`hit`), the rest filled from the others, both earliest
// first, then back in time order. A week with a few hits and many misses still shows Claude both.
function pick(items, hit) {
  if (items.length <= SAMPLE_MAX) return items;
  const hits = items.filter(hit).slice(0, SAMPLE_MAX / 2);
  const rest = items.filter((x) => !hits.includes(x)).slice(0, SAMPLE_MAX - hits.length);
  return [...hits, ...rest].sort((a, b) => byTime(a.o, b.o));
}

/**
 * The weekly-kpis Routine's samples for the week starting on UK Monday `start`, from loadKpiRows' rows: Nik's first
 * emails sent that week with how each did, and Claude's replies with what they answered, how fast and whether the
 * lead moved forward. Emails and phone numbers are removed and bodies cut (anonymise); at most SAMPLE_MAX each.
 */
export function kpiSamples(rows, start) {
  const week = isoWeekOf(start);
  if (weekStartOf(week) !== start) throw new Error(`A week starts on a Monday: ${start} isn't one`);
  const startMs = ukToUtc(start, "00:00").getTime();
  const endMs = ukToUtc(addUkDays(start, 7), "00:00").getTime();
  const P = prepare(rows);
  const sent = P.allOut.filter((o) => o.t >= startMs && o.t < endMs);

  const firsts = sent.filter((o) => o.row.kind === "first" && o.row.author === "nik").map((o) => {
    const c = P.credits.get(o.id);
    return { o, viewed7: viewedWithin(P, o), replied: c.replied, positive: c.positive, bounced: c.bounced };
  });
  const replies = sent.filter((o) => o.row.kind === "reply" && o.row.author === "claude").map((o) => {
    const last = lastHumanBefore(P, o);
    const minutes = answerMinutes(P, o);
    return { o, they_wrote: last ? anonymise(uncut(last.row.body)) : "", minutes: minutes === null ? null : Math.round(minutes), moved_forward: movedForward(P, o) };
  });

  return {
    first_emails: pick(firsts, (x) => x.viewed7 || x.replied).map(({ o, viewed7, replied, positive, bounced }) => ({
      subject: anonymise(o.row.subject), body: anonymise(uncut(o.row.body)), viewed7, replied, positive, bounced,
    })),
    claude_replies: pick(replies, (x) => x.moved_forward).map(({ o, they_wrote, minutes, moved_forward }) => ({
      they_wrote, claude_wrote: anonymise(uncut(o.row.body)), minutes, moved_forward,
    })),
  };
}
