// GET /api/replies → the Replies page (stage 7, docs/rebuild/07-replies-calls.md Part A "What Nik sees", Task 15):
// {paused, waiting, median_minutes, needs_you, conversations, last_drill}.
// - paused: setting replies:paused = '1'; waiting: the mail waiting for Claude (waitingStats in _lib/replies-db.js).
// - median_minutes: medianReplyMinutes (_lib/replies.js) over Claude's replies sent in the last 7 days, each paired
//   with the email it answered (In-Reply-To = their Message-ID; else the message it marked handled); the reply drill
//   (drill:) and Nik's test lead (test:) never count. null when there are none.
// - needs_you: the open escalation and call_time Todos, soonest due first, each with message_id (the email it's about,
//   from its dedupe, or null) and phone (the lead's, for the call-time card).
// - conversations: the 50 threads whose latest message is newest, among leads that have written back (a bounce or an
//   auto-reply isn't writing back): {place_id, business, stage, last_who ("Them" / "Claude" / "You" / "Follow-up 3" /
//   "System"), snippet (first 80 characters, quoted history off, as text), at}. An email that never went (cancelled
//   or failed) isn't the last word, except in a drill thread, where every reply is stored cancelled by design.
// - last_drill: the setting replies:last_drill ({right, total, wrong}, written by GET /api/replies/drill) or null.
// POST /api/replies {paused: true|false} → Pause Claude's replies / Turn Claude's replies back on. 200 {ok, paused}.
// Inbound and Claude-written text is untrusted: it is returned as text and the page escapes it. Behind the login
// (_middleware.js). Tested in tests/replies-page.test.mjs.
import { medianReplyMinutes, stripQuoted } from "../_lib/replies.js";
import { waitingStats } from "../_lib/replies-db.js";
import { businessName } from "../_lib/mail/rules.js";
import { DRILL_LEAD } from "../_lib/replyDrill.js";
import { setSetting } from "../_lib/settings.js";
import { bad, db, iso, json, parseJson } from "../_lib/util.js";

const CONVERSATIONS_MAX = 50;
const NEEDS_YOU_MAX = 100;
const SNIPPET_CHARS = 80;
const WEEK_MS = 7 * 86_400_000;
const BODY_CHARS = 2000; // read per last message: enough for an 80-character snippet once quoted history is off
const PAUSED_KEY = "replies:paused";
const UNREADABLE = "Couldn't save: the request wasn't readable. Refresh the page and try again.";
const NOT_BOOLEAN = 'Couldn\'t change it: send {"paused": true} or {"paused": false}.';

const SETTINGS_SQL = "SELECT key, value FROM settings WHERE key IN ('replies:paused', 'replies:last_drill')";

// Claude's replies sent since ?1, outside the drill and the test lead, with when the email it answered arrived.
const PAIRS_SQL = `SELECT r.sent_at,
    (SELECT COALESCE(m.received_at, m.created_at) FROM messages m
      WHERE m.place_id = r.place_id AND m.direction = 'in'
        AND ((r.in_reply_to IS NOT NULL AND m.message_id = r.in_reply_to)
          OR (r.in_reply_to IS NULL AND m.intent IS NOT NULL AND m.handled_at = r.created_at))
      ORDER BY COALESCE(m.received_at, m.created_at) DESC LIMIT 1) AS received_at
  FROM messages r
  WHERE r.direction = 'out' AND r.kind = 'reply' AND r.author = 'claude' AND r.status = 'sent' AND r.sent_at >= ?1
    AND COALESCE(r.place_id, '') NOT LIKE 'drill:%' AND COALESCE(r.place_id, '') NOT LIKE 'test:%'`;

const NEEDS_YOU_SQL = `SELECT t.id, t.kind, t.place_id, t.title, t.detail, t.draft, t.link, t.due_at, t.dedupe, t.created_at,
    l.phone AS phone
  FROM todos t LEFT JOIN leads l ON l.place_id = t.place_id
  WHERE t.status = 'open' AND t.kind IN ('escalation', 'call_time')
  ORDER BY COALESCE(t.due_at, t.created_at), t.created_at, t.id
  LIMIT ${NEEDS_YOU_MAX}`;

// Threads with mail from them, and each one's latest message that counts (see the header).
const CONVERSATIONS_SQL = `WITH t AS (
    SELECT DISTINCT place_id FROM messages
    WHERE direction = 'in' AND place_id IS NOT NULL AND COALESCE(class, 'human') NOT IN ('bounce', 'auto')
  ), last AS (
    SELECT m.place_id, m.direction, m.kind, m.step, m.author, substr(m.body, 1, ${BODY_CHARS}) AS body,
      COALESCE(m.sent_at, m.received_at, m.created_at) AS at,
      ROW_NUMBER() OVER (PARTITION BY m.place_id
        ORDER BY COALESCE(m.sent_at, m.received_at, m.created_at) DESC, m.created_at DESC, m.id DESC) AS n
    FROM messages m JOIN t ON t.place_id = m.place_id
    WHERE NOT (m.direction = 'out' AND m.status IN ('cancelled', 'failed') AND m.place_id NOT LIKE 'drill:%')
      AND NOT (m.direction = 'in' AND COALESCE(m.class, 'human') IN ('bounce', 'auto'))
  )
  SELECT last.*, p.stage, p.email, l.name
  FROM last LEFT JOIN prospects p ON p.place_id = last.place_id LEFT JOIN leads l ON l.place_id = last.place_id
  WHERE last.n = 1
  ORDER BY last.at DESC, last.place_id
  LIMIT ${CONVERSATIONS_MAX}`;

const isPractice = (placeId) => /^(drill|test):/.test(String(placeId ?? ""));

/**
 * The business a thread shows: the lead's name tidied; for a practice lead with no lead row the name Claude is shown
 * (DRILL_LEAD), marked so Nik can tell them apart ("Drill Test Landscapes · drill angry", "Drill Test Landscapes ·
 * your test lead"); else their address.
 */
export function threadBusiness(row) {
  const name = businessName(row?.name ?? "");
  if (name) return name;
  if (typeof row?.name === "string" && row.name.trim()) return row.name.trim();
  const placeId = String(row?.place_id ?? "");
  if (isPractice(placeId)) {
    const [prefix, ...rest] = placeId.split(":");
    return `${DRILL_LEAD.name} · ${prefix === "test" ? "your test lead" : `drill ${rest.join(":")}`.trim()}`;
  }
  return row?.email || placeId;
}

/** Who a message is from, as the thread labels it: {who, label}. */
export function whoOf(m) {
  if (m.direction === "in") {
    return ["bounce", "auto"].includes(m.class) ? { who: "system", label: "System" } : { who: "them", label: "Them" };
  }
  if (m.author === "nik") return { who: "nik", label: "You" };
  if (m.author === "claude") return { who: "claude", label: "Claude" };
  if (m.kind === "followup" && Number.isSafeInteger(m.step)) return { who: "system", label: `Follow-up ${m.step}` };
  return { who: "system", label: "System" };
}

// The first n characters, never cutting an emoji in half.
function clip(text, n) {
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** A message's first 80 characters as one line: their quoted history off, spaces collapsed. */
export function snippetOf(m) {
  const text = m.direction === "in" ? stripQuoted(m.body) : String(m.body ?? "");
  return clip(text.replace(/\s+/g, " ").trim(), SNIPPET_CHARS).trim();
}

// The inbound message a Todo is about (the reverse of replies-db.js's messageTodoKeys), or null.
function messageOfTodo(dedupe) {
  const m = /^(?:escalation:(?:client:|unknown:)?|call_time:|client-mail:|optout-mail:)(.+)$/.exec(String(dedupe ?? ""));
  return m ? m[1] : null;
}

function lastDrill(value) {
  const d = parseJson(value, null);
  if (!d || typeof d !== "object" || !Number.isFinite(d.right) || !Number.isFinite(d.total)) return null;
  const wrong = Array.isArray(d.wrong)
    ? d.wrong.filter((w) => w && typeof w === "object").map((w) => ({ key: String(w.key ?? ""), expected: String(w.expected ?? ""), got: String(w.got ?? "") }))
    : [];
  return { right: d.right, total: d.total, wrong };
}

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ env, now }) {
  const DB = await db(env);
  const at = now ?? new Date();
  const since = iso(new Date(at.getTime() - WEEK_MS));
  const [settings, stats, pairs, todos, threads] = await Promise.all([
    DB.prepare(SETTINGS_SQL).all(),
    waitingStats(DB),
    DB.prepare(PAIRS_SQL).bind(since).all(),
    DB.prepare(NEEDS_YOU_SQL).all(),
    DB.prepare(CONVERSATIONS_SQL).all(),
  ]);
  const setting = Object.fromEntries(settings.results.map((r) => [r.key, r.value]));
  const median = medianReplyMinutes(pairs.results);
  return json({
    paused: setting[PAUSED_KEY] === "1",
    waiting: stats.waiting,
    median_minutes: median === null ? null : Math.round(median * 10) / 10,
    needs_you: todos.results.map((t) => ({ ...t, message_id: messageOfTodo(t.dedupe) })),
    conversations: threads.results.map((m) => ({
      place_id: m.place_id,
      business: threadBusiness(m),
      stage: m.stage ?? null,
      last_who: whoOf(m).label,
      snippet: snippetOf(m),
      at: m.at,
    })),
    last_drill: lastDrill(setting["replies:last_drill"]),
  });
}

/** {paused: true|false}: the Replies page's switch. */
export async function onRequestPost({ request, env }) {
  const input = await request.json().catch(() => undefined);
  if (input === undefined) return bad(UNREADABLE);
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.paused !== "boolean") return bad(NOT_BOOLEAN);
  const DB = await db(env);
  await setSetting(DB, PAUSED_KEY, input.paused ? "1" : "0");
  return json({ ok: true, paused: input.paused });
}
