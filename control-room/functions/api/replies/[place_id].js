// GET /api/replies/:place_id → one conversation on the Replies page (#/replies/<place_id>; stage 7,
// docs/rebuild/07-replies-calls.md Part A "What Nik sees", Task 15): {place_id, business, stage, phone, reply_to,
// messages: [{id, who, label, at, intent, status, text}]}, oldest first (the newest 200).
// - who: them | claude | nik | system; label: "Them", "Claude", "You", "Follow-up 3", "System" (a bounce or an
//   auto-reply is "System").
// - at: when it went (sent_at), came in (received_at) or was written; intent: on theirs only (what Claude decided);
//   status: queued | sending | sent | failed | cancelled | received, so the page can say what never went.
// - text: their words with the quoted history taken off (4,000 characters at most); ours as stored. Untrusted text:
//   the page escapes it.
// - reply_to: their latest email (not a bounce or an auto-reply), which "Reply as me" answers; null when there's none.
// 404 {error} when the lead has neither a prospect nor any email. The place_id may come URL-encoded ("drill%3A1").
// /api/replies/send and /api/replies/dismiss are their own files, so they win over this one. Behind the login
// (_middleware.js). Tested in tests/replies-page.test.mjs.
import { stripQuoted } from "../../_lib/replies.js";
import { db, json } from "../../_lib/util.js";
import { threadBusiness, whoOf } from "../replies.js";

const MESSAGES_MAX = 200;
const BODY_CHARS = 20000;
const NOT_THERE = "That conversation isn't in the database any more. Go back to Replies and refresh the page.";

const LEAD_SQL = `SELECT x.place_id, p.stage, p.email, l.name, l.phone, p.place_id AS prospect_id
  FROM (SELECT ?1 AS place_id) x
  LEFT JOIN prospects p ON p.place_id = x.place_id LEFT JOIN leads l ON l.place_id = x.place_id`;
const MESSAGES_SQL = `SELECT * FROM (
    SELECT id, direction, kind, step, author, class, status, intent, substr(body, 1, ${BODY_CHARS}) AS body,
      COALESCE(sent_at, received_at, created_at) AS at, created_at
    FROM messages WHERE place_id = ?1
    ORDER BY COALESCE(sent_at, received_at, created_at) DESC, created_at DESC, id DESC
    LIMIT ${MESSAGES_MAX}
  ) ORDER BY at, created_at, id`;

function placeIdOf(raw) {
  const s = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("/") : "";
  if (!s.includes("%")) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export async function onRequestGet({ env, params }) {
  const DB = await db(env);
  const placeId = placeIdOf(params?.place_id);
  const [lead, messages] = placeId
    ? await Promise.all([DB.prepare(LEAD_SQL).bind(placeId).first(), DB.prepare(MESSAGES_SQL).bind(placeId).all()])
    : [null, { results: [] }];
  const rows = messages.results;
  if (!lead || (lead.prospect_id == null && !rows.length)) return json({ error: NOT_THERE }, 404);

  const theirs = rows.filter((m) => m.direction === "in" && !["bounce", "auto"].includes(m.class));
  return json({
    place_id: placeId,
    business: threadBusiness(lead),
    stage: lead.stage ?? null,
    phone: typeof lead.phone === "string" && lead.phone.trim() ? lead.phone.trim() : null,
    reply_to: theirs.length ? theirs[theirs.length - 1].id : null,
    messages: rows.map((m) => {
      const { who, label } = whoOf(m);
      return {
        id: m.id,
        who,
        label,
        at: m.at,
        intent: m.direction === "in" ? m.intent ?? null : null,
        status: m.status,
        text: m.direction === "in" ? stripQuoted(m.body) : String(m.body ?? ""),
      };
    }),
  });
}
