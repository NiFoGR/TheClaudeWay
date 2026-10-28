// Todo items (db) and the board grouping (pure): everything Nik has to do, in one `todos` table (overview §6).
//
// A dedupe stops the same item being added twice. It stays taken while the todo is open, after Nik dismisses it, and
// after Nik marks it done, so none of those come back. Only closeTodos (the system closing a todo because the problem
// went away) frees it, by adding "@<done_at>", so the same problem can come back later as a new item.
//
// The Todo page's board (stage 11, docs/rebuild/11-todo-kpis.md Part A "Todo page") is loaded here too: loadBoard reads
// the lights, the open todos, the pipeline and the clients, and board.js turns the rows into cards and words.
import { clientCards, leadLink, pipelineColumns, threadLink } from "./board.js";
import { healthFromDb } from "./health.js";
import { addUkDays, ukDate, ukDayStartUtc, ukToUtc } from "./ukTime.js";
import { iso, now as nowIso } from "./util.js";

// due_at is stored as UTC ISO text without milliseconds, like util.now(), so every row sorts and compares the same
// way as text (the todos_open index). It takes a Date or ISO text with a zone (Z or ±HH:MM). Anything else is refused:
// "2026-10-26 08:00" has no zone (Workers would read it as UTC, an hour out in BST), and groupBoard would show a time
// it can't read under Today.
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// A real day and time of day. Date.parse would roll 30 Feb over to 2 Mar, and read 24:00 as the next day.
function realDayAndTime([, y, mo, d, hh, mm, ss = "0"]) {
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return day.getUTCMonth() === Number(mo) - 1 && day.getUTCDate() === Number(d)
    && Number(hh) < 24 && Number(mm) < 60 && Number(ss) < 60;
}

function dueText(value) {
  if (value === null || value === undefined || value === "") return null;
  const parts = typeof value === "string" ? ISO_WITH_ZONE.exec(value) : null;
  const t = value instanceof Date ? value.getTime()
    : parts && realDayAndTime(parts) ? Date.parse(value)
    : NaN;
  if (Number.isNaN(t)) {
    const got = value instanceof Date ? "an invalid Date" : typeof value === "string" ? JSON.stringify(value) : typeof value;
    throw new TypeError(`A todo's due_at must be a Date or UTC ISO text like 2026-10-26T08:00:00Z, got ${got}.`);
  }
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Add a todo. With a dedupe, it's added only when no todo holds that dedupe yet (INSERT OR IGNORE).
 * Returns the new id, or null when it was already there.
 */
export async function addTodo(DB, { kind, title, detail, link, place_id, client_id, draft, due_at, dedupe } = {}) {
  // INSERT OR IGNORE also skips a row that breaks NOT NULL, so a missing kind or title would vanish without a word.
  if (typeof kind !== "string" || !kind || typeof title !== "string" || !title) {
    throw new TypeError("A todo needs a kind and a title.");
  }
  // An empty dedupe would be taken by the first such todo and silently swallow every later one.
  if (dedupe !== undefined && dedupe !== null && (typeof dedupe !== "string" || !dedupe)) {
    throw new TypeError("A todo's dedupe must be text like \"health:tick\" (leave it out for no dedupe).");
  }
  const due = dueText(due_at);
  const id = crypto.randomUUID();
  const { meta } = await DB.prepare(
    `INSERT OR IGNORE INTO todos (id, kind, place_id, client_id, title, detail, link, draft, due_at, status, dedupe, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  )
    .bind(id, kind, place_id ?? null, client_id ?? null, title, detail ?? "", link ?? null, draft ?? null,
      due, dedupe ?? null, nowIso())
    .run();
  return meta.changes === 0 ? null : id;
}

// done_at is part of the freed dedupe ("<dedupe>@<done_at>"), which must stay unique: a todo re-added and closed
// again within the same millisecond would collide, so done_at never repeats within an isolate.
let lastDoneMs = 0;
function doneAt() {
  lastDoneMs = Math.max(Date.now(), lastDoneMs + 1);
  return new Date(lastDoneMs).toISOString();
}

/**
 * Close every open todo whose dedupe starts with `dedupePrefix`, freeing each dedupe (dedupe || '@' || done_at).
 * Returns how many were closed. The match is exact text (substr, not LIKE, so % and _ are literal), but it is a
 * prefix: "health:tick" also closes "health:tickle". Use it only when no other key starts with the prefix.
 * Dismissed and done todos are left alone.
 */
export async function closeTodos(DB, dedupePrefix) {
  if (typeof dedupePrefix !== "string" || !dedupePrefix) {
    throw new TypeError("closeTodos needs a dedupe prefix, e.g. \"health:tick\" (an empty one would close everything).");
  }
  const at = doneAt();
  const { meta } = await DB.prepare(
    `UPDATE todos SET status = 'done', done_at = ?, dedupe = dedupe || '@' || ?
     WHERE status = 'open' AND substr(dedupe, 1, length(?)) = ?`,
  )
    .bind(at, at, dedupePrefix, dedupePrefix)
    .run();
  return meta.changes;
}

/**
 * Close every open todo about the lead `place_id` (its place_id, no client_id), except those whose kind is in
 * `exceptKinds`, freeing each dedupe as closeTodos does (dedupe || '@' || done_at; a todo without one keeps NULL).
 * Todos that carry a client_id are about the client the lead became (a welcome-email draft, their email handed to
 * Nik), not the lead, so they stay. Dismissed and done todos are left alone. Stage 9 runs it when a lead pays.
 * Returns how many were closed. 1 D1 query.
 */
export async function closeLeadTodos(DB, place_id, { exceptKinds = [] } = {}) {
  if (typeof place_id !== "string" || !place_id) throw new TypeError("closeLeadTodos needs the lead's place_id.");
  if (!Array.isArray(exceptKinds) || !exceptKinds.every((k) => typeof k === "string")) {
    throw new TypeError('closeLeadTodos: exceptKinds must be a list of todo kinds, e.g. ["build", "payment"].');
  }
  const at = doneAt();
  const { meta } = await DB.prepare(
    `UPDATE todos SET status = 'done', done_at = ?1, dedupe = dedupe || '@' || ?1
     WHERE status = 'open' AND place_id = ?2 AND client_id IS NULL
       AND kind NOT IN (SELECT value FROM json_each(?3))`,
  )
    .bind(at, place_id, JSON.stringify(exceptKinds))
    .run();
  return meta.changes;
}

// Milliseconds since 1970, or null for no time (a time that can't be read counts as none, so the item still shows).
function ms(value) {
  if (value === null || value === undefined || value === "") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// Earlier first, no time last.
function byTime(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * The board's three groups, from open todos only (pure). Overdue: due before today started (UK). Today: no due time,
 * or due during today (UK). Later: due after today ends (UK). Each group is sorted by due_at (none last), then
 * created_at.
 */
export function groupBoard(rows, now) {
  const at = now instanceof Date ? now : new Date(now);
  const start = ukDayStartUtc(at).getTime();
  const end = ukToUtc(addUkDays(ukDate(at), 1), "00:00").getTime();
  const groups = { today: [], overdue: [], later: [] };
  for (const row of rows) {
    if (row.status !== "open") continue;
    const due = ms(row.due_at);
    const group = due === null || (due >= start && due < end) ? "today" : due < start ? "overdue" : "later";
    groups[group].push(row);
  }
  const order = (a, b) => byTime(ms(a.due_at), ms(b.due_at)) || byTime(ms(a.created_at), ms(b.created_at));
  for (const list of Object.values(groups)) list.sort(order);
  return groups;
}

// ---------------------------------------------------------------- the Todo page's board (stage 11)

/** Today's rows sort by kind in this order (unknown kinds last), then due_at (none last), then id. */
export const KIND_ORDER = Object.freeze([
  "escalation", "health", "call_time", "call", "hot", "payment", "build", "care", "kpi", "pick", "setup",
]);
const KIND_RANK = new Map(KIND_ORDER.map((kind, i) => [kind, i]));
// Kinds whose draft is a reply to one of their emails (stage 7's sendAsNik sends it).
const SENDABLE = new Set(["escalation", "call_time"]);
const STATUSES = new Set(["done", "dismissed"]);
const LIGHT_RANK = Object.freeze({ red: 0, amber: 1, green: 2, grey: 3 });

const textCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A sorted copy of `items` (pure): KIND_ORDER, then due_at ascending with no due_at last, then id. */
export function sortTodos(items) {
  const rank = (t) => KIND_RANK.get(t?.kind) ?? KIND_ORDER.length;
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => rank(a) - rank(b)
    || byTime(ms(a?.due_at), ms(b?.due_at))
    || textCmp(String(a?.id ?? ""), String(b?.id ?? "")));
}

/**
 * The rows Today shows (pure): every row but a `health` todo whose dedupe is `health:<name>` of one of `lights` (the
 * light already shows it). Other health todos (health:find:towns, health:stale:…, health:followup-…) stay.
 */
export function visibleTodos(rows, lights) {
  const shown = new Set((Array.isArray(lights) ? lights : []).filter(Boolean).map((l) => `health:${l.name}`));
  return (Array.isArray(rows) ? rows : []).filter((r) => r && !(r.kind === "health" && shown.has(r.dedupe)));
}

/**
 * The inbound message an escalation or call_time todo answers (pure): "escalation:<id>" / "call_time:<id>" → "<id>",
 * with any "@…" suffix (a freed dedupe) stripped. Stage 0's "escalation:client:…" and "escalation:unknown:…" (no
 * thread to reply in) and every other dedupe → null.
 */
export function messageIdFromDedupe(dedupe) {
  const m = /^(?:escalation|call_time):([^@]+)/.exec(typeof dedupe === "string" ? dedupe : "");
  if (!m || /^(?:client|unknown):/.test(m[1])) return null;
  return m[1];
}

// "The soonest confirmed call" of a lead: the next one still to come, else the latest one already past (a call that
// happened but isn't marked done yet). ?1 = now.
const SOONEST_CALL = "c.slot_at < ?1, CASE WHEN c.slot_at >= ?1 THEN c.slot_at END, c.slot_at DESC LIMIT 1";

// The open todos, with their lead's name and phone and, for a call, the phone on the soonest confirmed call
// (SOONEST_CALL). Drill and test leads never show; a todo without a lead (setup, kpi, payment) always does. ?1 = now.
const TODO_ROWS_SQL = `SELECT t.id, t.kind, t.place_id, t.client_id, t.title, t.detail, t.link, t.draft, t.due_at, t.status,
    t.dedupe, t.created_at, l.place_id AS lead_id, l.name AS business, l.phone AS lead_phone,
    CASE WHEN t.kind = 'call' THEN (SELECT c.phone FROM calls c
        WHERE c.place_id = t.place_id AND c.status = 'confirmed' AND trim(COALESCE(c.phone, '')) <> ''
        ORDER BY ${SOONEST_CALL}) END AS call_phone
  FROM todos t LEFT JOIN leads l ON l.place_id = t.place_id
  WHERE t.status = 'open' AND (t.place_id IS NULL OR NOT (t.place_id LIKE 'drill:%' OR t.place_id LIKE 'test:%'))`;

// Every prospect with what its card needs (board.js's pipeline row): the lead's name, the research grade, the latest
// sent outbound email and the soonest confirmed call (SOONEST_CALL). followup_step rides with next_followup_at so
// nextLine can tell a follow-up from the close time. ?1 = now.
const PIPELINE_SQL = `SELECT p.place_id, p.stage, p.stage_at, p.views, p.last_view_at, p.last_inbound_at, p.next_followup_at,
    p.followup_step, p.lost_reason, l.name, r.grade,
    o.sent_at AS last_out_at, o.kind AS last_out_kind, o.step AS last_out_step, o.author AS last_out_author,
    (SELECT c.slot_at FROM calls c WHERE c.place_id = p.place_id AND c.status = 'confirmed'
      ORDER BY ${SOONEST_CALL}) AS call_at
  FROM prospects p
  LEFT JOIN leads l ON l.place_id = p.place_id
  LEFT JOIN research r ON r.place_id = p.place_id
  LEFT JOIN messages o ON o.id = (SELECT m.id FROM messages m
      WHERE m.place_id = p.place_id AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at IS NOT NULL
      ORDER BY m.sent_at DESC, m.id DESC LIMIT 1)
  WHERE NOT (p.place_id LIKE 'drill:%' OR p.place_id LIKE 'test:%')`;

// Every client with what its card needs (board.js's client row): onboarding, a failed card, the Map Rank row of their
// place_id and their earliest open care/build todo. The CTE isn't called `care`: that name is stage 10's table, which
// its Task 15 LEFT JOINs in this same statement (a CTE of the same name would hide it). Exported for that test.
export const CLIENTS_SQL = `WITH next_task AS (
    SELECT client_id, title, due_at,
      ROW_NUMBER() OVER (PARTITION BY client_id ORDER BY due_at IS NULL, due_at, id) AS n
    FROM todos WHERE status = 'open' AND kind IN ('care', 'build') AND client_id IS NOT NULL)
  SELECT c.id, c.name, c.place_id, c.package, c.build_fee_pence, c.monthly_pence, c.free_days, c.paid_on, c.cancelled_on,
    o.status AS ob_status, o.created_at AS ob_created_at, o.due_live_at, o.live_at, cl.failed_on,
    r.scan_id, r.top3_pct, r.avg_rank, r.updated_at AS rank_updated_at,
    k.title AS care_title, k.due_at AS care_due_at
  FROM clients c
  LEFT JOIN onboarding o ON o.client_id = c.id
  LEFT JOIN client_links cl ON cl.client_id = c.id
  LEFT JOIN lead_map_rank r ON r.place_id = c.place_id
  LEFT JOIN next_task k ON k.client_id = c.id AND k.n = 1
  WHERE c.place_id IS NULL OR NOT (c.place_id LIKE 'drill:%' OR c.place_id LIKE 'test:%')`;

function boardNow(now) {
  const at = now instanceof Date ? new Date(now.getTime()) : new Date(now ?? NaN);
  if (Number.isNaN(at.getTime())) throw new TypeError("The Todo board needs the time now, as a Date or an ISO time.");
  return at;
}

// The lights, red → amber → green → grey, then by name; {lights: [], error} when they can't be worked out, so the
// rest of the board still loads (the page says "Couldn't check the system lights: <error>").
async function lightsOf(DB, env, at) {
  try {
    const { lights } = await healthFromDb(DB, env, at);
    const rank = (l) => LIGHT_RANK[l?.level] ?? 4;
    const list = (Array.isArray(lights) ? lights : []).filter(Boolean)
      .sort((a, b) => rank(a) - rank(b) || textCmp(String(a.name ?? ""), String(b.name ?? "")));
    return { lights: list, error: null };
  } catch (err) {
    const text = String(err?.message ?? err ?? "").replace(/\s+/g, " ").trim();
    return { lights: [], error: text || "unknown error" };
  }
}

// A todo row as the board shows it. Links and the lead's name and phone only when the lead is still there.
function todoItem(row) {
  const lead = row.lead_id !== null && row.lead_id !== undefined;
  const leadPhone = lead ? (row.lead_phone ?? null) : null;
  const phone = row.kind === "call" ? (row.call_phone ?? leadPhone)
    : row.kind === "hot" || SENDABLE.has(row.kind) ? leadPhone
    : null;
  return {
    id: row.id, kind: row.kind, title: row.title, detail: row.detail ?? "", link: row.link ?? null,
    draft: row.draft ?? null, due_at: row.due_at ?? null, place_id: row.place_id ?? null, client_id: row.client_id ?? null,
    business: lead ? (row.business ?? null) : null, phone,
    lead_link: lead ? leadLink(row.place_id) : null, thread_link: lead ? threadLink(row.place_id) : null,
    can_send: SENDABLE.has(row.kind) && !!row.draft && messageIdFromDedupe(row.dedupe) !== null,
  };
}

// Open rows → Today's three groups of board items, each sorted by sortTodos.
function todayGroups(rows, lights, at) {
  const groups = groupBoard(visibleTodos(rows, lights), at);
  return {
    overdue: sortTodos(groups.overdue).map(todoItem),
    today: sortTodos(groups.today).map(todoItem),
    later: sortTodos(groups.later).map(todoItem),
  };
}

const countsOf = (today, lights) => ({
  due: today.overdue.length + today.today.length,
  red: lights.filter((l) => l.level === "red").length,
});

/**
 * Everything the Todo page shows, from one call: {now, health (the lights, red first), health_error (null, or why the
 * lights couldn't be worked out; scrub it with tick.js's errorText before it leaves the server), today: {overdue,
 * today, later} (board items), pipeline (board.js pipelineColumns), clients (board.js clientCards), counts: {due,
 * red}}. counts.due is overdue + today; counts.red the red lights. Drill and test leads are left out.
 * D1: healthFromDb's queries plus one batch of 3.
 */
export async function loadBoard(DB, env, now) {
  const at = boardNow(now);
  const stamp = iso(at);
  const [health, [todoRows, pipelineRows, clientRows]] = await Promise.all([
    lightsOf(DB, env, at),
    DB.batch([
      DB.prepare(TODO_ROWS_SQL).bind(stamp),
      DB.prepare(PIPELINE_SQL).bind(stamp),
      DB.prepare(CLIENTS_SQL),
    ]),
  ]);
  const today = todayGroups(todoRows.results ?? [], health.lights, at);
  return {
    now: stamp,
    health: health.lights,
    health_error: health.error,
    today,
    pipeline: pipelineColumns(pipelineRows.results ?? [], at),
    clients: clientCards(clientRows.results ?? [], at),
    counts: countsOf(today, health.lights),
  };
}

/** The nav badge's numbers, the same as loadBoard's counts without the pipeline and clients: {due, red}. */
export async function todoCounts(DB, env, now) {
  const at = boardNow(now);
  const [health, todoRows] = await Promise.all([
    lightsOf(DB, env, at),
    DB.prepare(TODO_ROWS_SQL).bind(iso(at)).all(),
  ]);
  return countsOf(todayGroups(todoRows.results ?? [], health.lights, at), health.lights);
}

/**
 * Nik's Done or Dismiss: an open todo becomes `status` ("done" or "dismissed") with done_at = now. Its dedupe is kept,
 * so addTodo never adds the same item again. A todo that's already closed is left as it is ("ok": a second tap is
 * harmless). → "ok", or "missing" when there's no such todo. 1 D1 query (2 when it was already closed or missing).
 */
export async function setTodoStatus(DB, id, status, now) {
  if (!STATUSES.has(status)) throw new TypeError("Status must be done or dismissed.");
  const key = typeof id === "string" ? id : "";
  if (!key) return "missing";
  const { meta } = await DB.prepare("UPDATE todos SET status = ?, done_at = ? WHERE id = ? AND status = 'open'")
    .bind(status, iso(boardNow(now)), key)
    .run();
  if (meta.changes > 0) return "ok";
  const there = await DB.prepare("SELECT 1 AS found FROM todos WHERE id = ?").bind(key).first();
  return there ? "ok" : "missing";
}
