// GET /api/calls/<id> → {call, label, lead, research, links, offer, thread_link, after_slot}: everything the call page
// (#/call/<id>, public/js/call.js) shows, stage 8 (docs/rebuild/07-replies-calls.md). `lead` is in the shape stage 3's
// callScript takes (leadview.js's scriptLead: owner_first only when research is confident, else the name the emails
// greet; demo_url only while their demo is live), `research` is stage 3's parsed research (leadDetail in
// _lib/shortlist-db.js), `links` are the latest demo's (latestDemo + demoLink in _lib/demo-db.js, kept when it has
// ended, null with no demo), `offer` is {...offerFor(slot_at), guarantee: GUARANTEE} in pence for the call's own day
// (the weekend deal on a Saturday call), `after_slot` is true from the call's time on ("How did it go?").
// POST /api/calls/<id> {action, note?, message?} → {ok}: Nik's cancel / done / no_show / ordering / lost (updateCall
// in _lib/calls-db.js). A message (the order link, or a cancel's note) goes straight away (dispatchDue, replies only,
// one email) in waitUntil. 422 Unknown action. and the other refusals, 404 a call that isn't there, 409 a call that's
// already closed or changed meanwhile. Behind the login (_middleware.js). Tested in tests/calls-api.test.mjs.
import { slotLabel } from "../../_lib/calls.js";
import { updateCall } from "../../_lib/calls-db.js";
import { DEMO_BASE, demoLink, latestDemo } from "../../_lib/demo-db.js";
import { dispatchDue } from "../../_lib/mail/outbox.js";
import { GUARANTEE, offerFor } from "../../_lib/offer.js";
import { leadDetail } from "../../_lib/shortlist-db.js";
import { errorText } from "../../_lib/tick.js";
import { bad, db, iso, json } from "../../_lib/util.js";

const NO_CALL = "That call isn't in the database.";
const UNREADABLE = "Couldn't save: the request wasn't readable. Refresh the page and try again.";
const CLOSED = /^That call is already |^That call changed while you were saving/;
const TEXT_MAX = 20000; // characters of Nik's message (sendAsNik's limit) and of his note
const fmtCount = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const tooLong = (what, n) => `Couldn't save: ${what} is too long (${fmtCount(n)} characters, ${fmtCount(TEXT_MAX)} max).`;

const idOf = (params) => (typeof params?.id === "string" ? params.id : "");
const str = (value) => (typeof value === "string" ? value.trim() : "");
const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The lead as callScript takes it (scriptLead's fields), plus its place_id and phone.
function callLead(detail, placeId, demoUrl) {
  const d = isObj(detail) ? detail : {};
  const lead = isObj(d.lead) ? d.lead : {};
  const r = isObj(d.research) ? d.research : null;
  const owner = r && isObj(r.owner) ? r.owner : null;
  const confident = owner?.confident === true && str(owner.first) ? str(owner.first) : "";
  return {
    place_id: placeId,
    name: lead.name ?? null,
    trade: lead.trade ?? null,
    town: str(lead.town) || str(lead.search_town),
    phone: lead.phone ?? null,
    rating: lead.rating ?? null,
    review_count: lead.review_count ?? null,
    findings: Array.isArray(lead.findings) ? lead.findings : [],
    map_rank: isObj(d.map_rank) ? d.map_rank : {},
    owner_first: confident || str(d.prospect?.greet_name) || null,
    email: str(d.prospect?.email) || str(lead.email) || null,
    demo_url: demoUrl || "",
    angle: r && Array.isArray(r.angle) ? r.angle : [],
  };
}

/** `context.now` (tests) or the time now. */
export async function onRequestGet({ env, params, now }) {
  const DB = await db(env);
  const at = now ?? new Date();
  const id = idOf(params);
  const call = id ? await DB.prepare("SELECT * FROM calls WHERE id = ?").bind(id).first() : null;
  if (!call) return bad(NO_CALL, 404);
  const [detail, demo] = await Promise.all([leadDetail(DB, call.place_id, at), latestDemo(DB, call.place_id)]);
  // The links are the latest demo's even when it has ended (latestDemo's rule, as the reply Routine's links): the
  // message that carries one makes syncDemoExpiry extend it. The script says "I've built you a site" only while it's up.
  const slug = demo ? demo.slug : null;
  const live = slug && demo.expires_at > iso(at);
  const slot = new Date(call.slot_at);
  return json({
    call,
    label: slotLabel(call.slot_at),
    lead: callLead(detail, call.place_id, live ? demoLink(slug) : ""),
    research: detail?.research ?? null,
    links: { demo: slug ? demoLink(slug) : null, order: slug ? `${DEMO_BASE}/d/${slug}/order` : null },
    offer: { ...offerFor(slot), guarantee: GUARANTEE },
    thread_link: `/#/replies/${encodeURIComponent(call.place_id)}`,
    after_slot: at.getTime() >= slot.getTime(),
  });
}

/** `context.now` (tests) or the time now. */
export async function onRequestPost(context) {
  const { request, env, params } = context;
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad(UNREADABLE);
  const DB = await db(env);
  const at = context.now ?? new Date();
  const message = typeof input.message === "string" ? input.message : "";
  const note = typeof input.note === "string" ? input.note : "";
  if (message.trim().length > TEXT_MAX) return bad(tooLong("that message", message.trim().length), 422);
  if (note.trim().length > TEXT_MAX) return bad(tooLong("that note", note.trim().length), 422);
  const result = await updateCall(DB, idOf(params), typeof input.action === "string" ? input.action : "", { note, message, now: at });
  if (!result.ok) {
    const status = result.reason === NO_CALL ? 404 : CLOSED.test(result.reason) ? 409 : 422;
    return bad(result.reason, status);
  }
  if (message.trim() && typeof context.waitUntil === "function") {
    context.waitUntil(dispatchDue(DB, env, at, { limit: 1, kinds: ["reply"] }).catch((err) => {
      console.error(`Nik's message about the call couldn't be sent straight away (the tick's send step sends it): ${errorText(err, env)}`);
    }));
  }
  return json({ ok: true });
}
