// The chat endpoint on client sites: POST /s/chat {sid, history: [{role, content}], text} → {reply, fallback,
// lead_saved} (stage 10, docs/rebuild/09-build.md section 11).
//
// Section 11's checks, in order, each answering with the fallback line "Leave your number and {business} will call
// you back." (fallback: true, chat_usage.fallbacks + 1): 1. the chat is off for this site (chatEnabled); 2. more than
// 20 messages from this visitor to this site in the UTC hour (rate_hits chat:<client_id>:<visitor>); 3. 300 messages
// for this site today (UK day); 4. 1,000 across all sites today (CHAT_DAILY_CAP_ALL); 5. a Workers AI error or no
// answer within 8 s (chat_usage.ai_errors + 1 as well). Otherwise chat_usage.messages + 1, the model is asked with the
// system prompt, the last 6 turns (each ≤ 500 characters) and the new message, and its reply goes through scrubReply
// (no prices, no < or >, ≤ 600 characters).
//
// Leads: once a visitor's message in the session holds a UK phone number or an email, the session gets one
// site_leads row (source chat, session = sid), its message made from the turns the browser sent (earlier replies
// labelled "Assistant (as shown in the visitor's browser)", dropped when they hold a price); every later message only
// adds "Visitor: <text>" and "Assistant: <this request's reply>" to it (the browser's history is never written again)
// and moves updated_at on, so tick step `sites` emails the business once the chat has been quiet for 10 minutes.
// Earlier replies holding a price or a promise are never passed back to the model. Chats without contact details are
// never stored. A lead is saved whenever checks 1 and 2 pass (a visitor who leaves their number
// when the daily cap or the AI fails is still passed on); checks 1–2 keep floods from writing rows.
//
// Visitor and model text is untrusted: the reply is JSON, shown by the widget with textContent. Responses never set
// cookies. D1: 3–4 setting reads (parallel), the rate hit and today's counts (parallel), 1–2 chat_usage upserts and
// at most 2 site_leads statements.
import { iso } from "../util.js";
import { getSetting } from "../settings.js";
import { ukDate } from "../ukTime.js";
import { cappedBytes } from "./cappedBody.js";
import {
  FALLBACK, hasPrice, PROMISE_RE, appendTranscript, chatEnabled, chatSystemPrompt, findContact, leadTranscript,
  scrubReply,
} from "./chat.js";
import { hit, visitorId } from "./rate.js";
import { CHAT_DAILY_CAP_ALL, chatConfig, runModel } from "./workersAi.js";

export const CHAT_VISITOR_LIMIT = 20; // messages per visitor per site per UTC hour
export const CHAT_SITE_DAILY_CAP = 300; // messages per site per UK day
const TURNS = 6;
const TURN_MAX = 500;
const BODY_MAX = 16 * 1024; // 6 turns of 500 characters, as JSON, with room to spare
const SID_RE = /^[a-z0-9]{16,40}$/;
const FREE_QUOTE_RULE = "offer a call back with a free quote.";
// "my name is" / "my name's" / "it's" / "I'm": findContact's name phrases (chat.js), worth a look without a digit.
const NAME_HINT = /\b(?:my name|it['’]s|i['’]m)\b/i;
const PAGE_RE = /^\/[A-Za-z0-9\-._~/%]{0,199}$/;

const headers = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cache-control": "no-store",
};
const reply = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, ...extra } });
const refuse = (error, status = 400, extra) => reply({ error }, status, extra);

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const clean = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g, "").trim();

// The first n UTF-16 units, never half an emoji.
function cut(s, n) {
  let out = String(s).slice(0, n);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/** The business name the visitor sees: the site's content, else the client's name. */
const businessOf = (site) =>
  clean(isObject(site?.content?.business) ? site.content.business.name : "") || clean(site?.name) || "";

/** The last 6 well-formed turns ({role: user|assistant, content ≤ 500}); anything else is dropped. */
function turnsOf(history) {
  return history
    .filter((t) => isObject(t) && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
    .map((t) => ({ role: t.role, content: cut(clean(t.content), TURN_MAX) }))
    .filter((t) => t.content)
    .slice(-TURNS);
}

// Adds to today's counts for one site (one row per client per UK day).
function bump(DB, client_id, day, { messages = 0, fallbacks = 0, ai_errors = 0 }) {
  return DB.prepare(
    `INSERT INTO chat_usage (client_id, day, messages, fallbacks, ai_errors) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(client_id, day) DO UPDATE SET messages = messages + excluded.messages,
       fallbacks = fallbacks + excluded.fallbacks, ai_errors = ai_errors + excluded.ai_errors`,
  )
    .bind(client_id, day, messages, fallbacks, ai_errors)
    .run();
}

// Today's messages for this site and across all sites. chat_usage is read by its primary key (client_id, day), one
// row per site: "WHERE day = ?" alone would scan every day ever kept on every chat message. CROSS JOIN keeps SQLite
// from reordering the join into that scan. Sites are counted as health.js counts them (a client's chat_usage rows go
// when its site does).
async function today(DB, client_id, day) {
  const row = await DB.prepare(
    `SELECT COALESCE(SUM(u.messages), 0) AS all_sites,
       COALESCE(SUM(CASE WHEN u.client_id = ?1 THEN u.messages ELSE 0 END), 0) AS site
     FROM client_sites cs CROSS JOIN chat_usage u ON u.client_id = cs.client_id AND u.day = ?2`,
  )
    .bind(client_id, day)
    .first();
  return { site: Number(row?.site) || 0, all: Number(row?.all_sites) || 0 };
}

/**
 * The chat lead for this session: made the first time a phone number or email appears in the visitor's messages,
 * then on every later message its message gets the new message and this request's reply added at the end, and its
 * updated_at moves on. The browser's history is untrusted (anyone can edit it), so it is only read when the lead is
 * first made (leadTranscript labels its earlier replies and drops any with a price), never once the row exists: the
 * whole chat stays in the row even after message 1 has scrolled out of the last 6 turns. Returns true when the
 * session has a lead. D1: 1 read, then at most 1 write.
 */
async function saveLead(DB, site, { sid, turns, text, answer, page, at }) {
  // No digit and no "@" means no phone number or email: findContact's email pattern costs O(n²) on long words, so
  // it only runs when there is something to find (the free plan allows 10 ms of CPU per request).
  const findIn = (texts) => (texts.some((t) => /[\d@]/.test(t)) ? findContact(texts) : {});
  const existing = await DB.prepare("SELECT id, message, name FROM site_leads WHERE client_id = ? AND session = ?")
    .bind(site.client_id, sid)
    .first();
  if (existing) {
    // A name often comes after the number ("My name is Dave"), in a message with no digit or "@".
    const contact = !existing.name && NAME_HINT.test(text) ? findContact([text]) : findIn([text]);
    await DB.prepare(
      `UPDATE site_leads SET message = ?, updated_at = ?, name = COALESCE(name, ?), phone = COALESCE(phone, ?),
         email = COALESCE(email, ?), page = COALESCE(page, ?) WHERE id = ?`,
    )
      .bind(appendTranscript(existing.message, text, answer), at, contact.name ?? null, contact.phone ?? null,
        contact.email ?? null, page, existing.id)
      .run();
    return true;
  }
  const contact = findIn([...turns.filter((t) => t.role === "user").map((t) => t.content), text]);
  if (!contact.phone && !contact.email) return false; // chats without contact details are never stored
  // Two messages of one session at once: the second insert is skipped (its turn is in the next message's append).
  await DB.prepare(
    `INSERT INTO site_leads (id, client_id, source, name, phone, email, message, page, session, created_at, updated_at)
     VALUES (?, ?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(client_id, session) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), site.client_id, contact.name ?? null, contact.phone ?? null, contact.email ?? null,
      leadTranscript(turns, text, answer, businessOf(site)), page, sid, at, at)
    .run();
  return true;
}

/**
 * The browser's turns as the model may see them: an earlier reply holding a price or a promise (hasPrice,
 * PROMISE_RE) is dropped with the visitor's turn before it, so a forged "Yes, £200, guaranteed tomorrow" is never
 * passed to the model as its own words, and the turns still take it in turns.
 */
function modelTurns(turns, business) {
  const out = [];
  for (const t of turns) {
    if (t.role === "assistant" && (hasPrice(t.content, business) || PROMISE_RE.test(t.content))) {
      if (out.at(-1)?.role === "user") out.pop();
      continue;
    }
    // Strictly user, assistant, user, …: some models' chat templates (Gemma's among them) refuse anything else, so
    // an edited history can't turn every answer into an AI error. A turn repeating the last one's role is skipped.
    if (out.length ? out.at(-1).role === t.role : t.role !== "user") continue;
    out.push(t);
  }
  // The visitor's new message comes next, so the turns end on a reply.
  if (out.at(-1)?.role === "user") out.pop();
  return out;
}

// The body, checked: {sid, turns, text, page} or {error}.
async function readBody(request) {
  if (Number(request.headers.get("content-length")) > BODY_MAX) return { error: "That message is too long.", status: 413 };
  let body;
  try {
    // A chunked body has no Content-Length: it is read only up to BODY_MAX bytes, then cancelled (cappedBody.js), and
    // the 413 comes back before anything is decoded or parsed.
    const bytes = await cappedBytes(request, BODY_MAX);
    if (bytes === null) return { error: "That message is too long.", status: 413 };
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { error: "The chat couldn't read that message. Please try again." };
  }
  if (!isObject(body)) return { error: "The chat couldn't read that message. Please try again." };
  if (typeof body.sid !== "string" || !SID_RE.test(body.sid)) {
    return { error: "The chat session isn't valid. Please reload the page and try again." };
  }
  if (body.history !== undefined && !Array.isArray(body.history)) {
    return { error: "The chat couldn't read that message. Please try again." };
  }
  const text = typeof body.text === "string" ? cut(clean(body.text), TURN_MAX) : "";
  if (!text) return { error: "Please type a message." };
  const page = typeof body.page === "string" && PAGE_RE.test(body.page) && !body.page.startsWith("//") ? body.page : null;
  return { sid: body.sid, turns: turnsOf(body.history ?? []), text, page };
}

/**
 * POST /s/chat on a client site. `site` is the client_sites row (getSite/siteByHost: content, features, is_test,
 * package, cancelled_on), `client` the clients row when the caller has it (its package and cancelled_on win), `now`
 * the request time. `fetchImpl` replaces fetch for the Workers AI call in tests. Always a JSON Response: 200
 * {reply, fallback, lead_saved}, or 400/404/405/413 {error}.
 */
export async function handleChat(request, env, site, client, now = new Date(), { fetchImpl = fetch } = {}) {
  if (request.method !== "POST") return refuse("Please use the chat on the website.", 405, { allow: "POST" });
  if (!site?.client_id || site.status !== "live") return refuse("This website isn't set up yet.", 404);
  const input = await readBody(request);
  if (input.error) return refuse(input.error, input.status ?? 400);

  const DB = env.DB;
  const client_id = site.client_id;
  const day = ukDate(now);
  const business = businessOf(site);
  const fallback = async (counts, leadSaved = false) => {
    await bump(DB, client_id, day, { fallbacks: 1, ...counts });
    return reply({ reply: FALLBACK(business), fallback: true, lead_saved: leadSaved });
  };

  // 1. Is the chat on for this site?
  const [config, offer] = await Promise.all([chatConfig(DB), getSetting(DB, "offer:chatbot_live")]);
  const enabled = chatEnabled({
    site,
    client: client ?? undefined,
    settings: { "offer:chatbot_live": offer },
    secrets: { "cf_ai:account_id": Boolean(config.account_id), "cf_ai:token": Boolean(config.token) },
  });
  if (!enabled.on) return fallback({});

  // 2–4. This visitor this hour, this site today, all sites today.
  const visitor = await visitorId(request, client_id, now);
  const [rate, counts] = await Promise.all([
    hit(DB, `chat:${client_id}:${visitor}`, now, CHAT_VISITOR_LIMIT),
    today(DB, client_id, day),
  ]);
  if (!rate.allowed) return fallback({});
  const at = iso(now);
  const lead = (answer) => saveLead(DB, site, { ...input, answer, at });
  if (counts.site >= CHAT_SITE_DAILY_CAP || counts.all >= CHAT_DAILY_CAP_ALL) {
    return fallback({}, await lead(FALLBACK(business)));
  }

  // 5. The model.
  await bump(DB, client_id, day, { messages: 1 });
  const system = chatSystemPrompt(site.content, isObject(site.form) ? site.form : undefined);
  // The price line offers a free quote exactly when the prompt's rules do (chat.js decides from the form or the
  // facts). Only the rules are looked at: a FAQ answer quoting the phrase mustn't promise a free quote.
  const freeQuotes = system.split("\nFACTS:\n")[0].includes(FREE_QUOTE_RULE);
  const messages = [{ role: "system", content: system }, ...modelTurns(input.turns, business), { role: "user", content: input.text }];
  const out = await runModel(DB, messages, { fetchImpl, config });
  if (!out.ok) {
    console.error(`The chat on ${client_id}'s site couldn't get an answer from Workers AI (${out.status || "no answer"}): ${out.error}`);
    return fallback({ ai_errors: 1 }, await lead(FALLBACK(business)));
  }
  const scrubbed = scrubReply(out.text, { business, freeQuotes });
  const leadSaved = await lead(scrubbed.text);
  if (scrubbed.fallback) {
    await bump(DB, client_id, day, { fallbacks: 1 });
    return reply({ reply: scrubbed.text, fallback: true, lead_saved: leadSaved });
  }
  return reply({ reply: scrubbed.text, fallback: false, lead_saved: leadSaved });
}
