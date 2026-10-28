// The reply drill (stage 7, docs/rebuild/07-replies-calls.md Task 17): practice conversations on place_ids starting
// "drill:" that check the reply Routine picks the right intent. Their replies are stored cancelled ("drill: not
// sent") and never sent; KPIs ignore them.
//
// DRILL_LEAD is the made-up business every drill lead (and Nik's own "test:" lead, which has no leads row either) is
// shown to Claude as, in GET /api/agent/inbox. DRILL_CASES are the 14 practice emails, one per intent (its key is the
// intent, so the drill lead of a case is "drill:<key>"), and gradeDrill marks what the Routine did with them. The
// routes are api/replies/drill.js (seed + fire, grade) and api/replies/test-prospect.js (Nik's own test lead).
// Pure. Run: node --test control-room/tests/reply-drill.test.mjs

/** The lead Claude is shown for a drill:/test: prospect that has no leads row. */
export const DRILL_LEAD = Object.freeze({ name: "Drill Test Landscapes", trade: "Landscaper", town: "Warrington", phone: "07700 900123" });

const drillCase = (key, text, expect) => Object.freeze({ key, text, expect: Object.freeze({ intent: key, ...expect }) });

/**
 * The 14 practice emails (Task 17's table). expect.action: "reply" (a reply row answering it), "escalate" (an
 * escalation:<message id> Todo) or "none" (nothing queued, as for an opt-out); call: the case's call status
 * afterwards; todo: the open Todo it must leave ("call_time", or "checkback" = kind pick).
 */
export const DRILL_CASES = Object.freeze([
  drillCase("interested", "This looks great, how do I get it?", { action: "reply" }),
  drillCase("question", "Do I keep the website if I stop paying?", { action: "reply" }),
  drillCase("price", "How much is it?", { action: "reply" }),
  drillCase("more_info", "Send me more info", { action: "reply" }),
  drillCase("call_request", "Can we have a call?", { action: "reply", call: "offered" }),
  drillCase("proposes_time", "Can you ring me Thursday at 3pm?", { action: "reply", todo: "call_time" }),
  drillCase("confirms_slot", "That works, my number is 07700 900123", { action: "reply", call: "confirmed" }),
  drillCase("not_now", "Not right now, maybe next year", { action: "reply", todo: "checkback" }),
  drillCase("not_interested", "Not interested thanks", { action: "reply" }),
  drillCase("opt_out", "Take me off your list please", { action: "none" }),
  drillCase("angry", "Stop spamming me you idiots, this is the third email", { action: "escalate" }),
  drillCase("legal", "Under GDPR, tell me what data you hold on me and where you got it", { action: "escalate" }),
  drillCase("unclear", "Is this about the van?", { action: "escalate" }),
  drillCase("other", "I'm not the owner, you want Dave on dave@drilltest.co.uk", { action: "escalate" }),
]);

// The Todo kind each expected Todo is stored as (todo.js kinds): the check-back is a `pick` Todo.
const TODO_KINDS = Object.freeze({ call_time: "call_time", checkback: "pick" });
const TODO_NAMES = Object.freeze({ call_time: "call_time", pick: "checkback" });

const str = (v) => (typeof v === "string" ? v : "");

// "escalate angry", "reply call_request, call offered", "reply not_now, checkback Todo".
function expectedText(expect) {
  return [
    `${expect.action} ${expect.intent}`,
    ...(expect.call ? [`call ${expect.call}`] : []),
    ...(expect.todo ? [`${expect.todo} Todo`] : []),
  ].join(", ");
}

// What happened, in the same words: "reply not_interested", "none" (nothing done yet), "reply price, call offered".
function gotText(got) {
  const head = [got.action, got.intent].filter(Boolean).join(" ");
  const todos = [...new Set(got.todo_kinds.filter((k) => Object.hasOwn(TODO_NAMES, k)).map((k) => TODO_NAMES[k]))];
  return [head, ...(got.call_status ? [`call ${got.call_status}`] : []), ...todos.map((t) => `${t} Todo`)].join(", ");
}

// An outcome as read from the database; anything missing (a case Claude never touched) is "none".
function readOutcome(o) {
  const action = ["reply", "escalate", "none"].includes(o?.action) ? o.action : "none";
  return {
    action,
    intent: str(o?.intent) || null,
    call_status: str(o?.call_status) || null,
    todo_kinds: Array.isArray(o?.todo_kinds) ? o.todo_kinds.map(str).filter(Boolean) : [],
  };
}

// Right when the action and intent match, the call is the one expected (and there is none when none is expected),
// and the expected Todo is open (and no call-time or check-back Todo is open when none is expected).
function isRight(expect, got) {
  if (got.action !== expect.action || got.intent !== expect.intent) return false;
  if ((got.call_status ?? null) !== (expect.call ?? null)) return false;
  const kinds = new Set(got.todo_kinds);
  for (const [name, kind] of Object.entries(TODO_KINDS)) {
    if (kinds.has(kind) !== (expect.todo === name)) return false;
  }
  return true;
}

/**
 * Marks the drill. outcomes: {[key]: {action, intent, call_status, todo_kinds}} (what the database shows per case).
 * → {right, total, wrong: [{key, expected, got}]}, e.g. {key: "angry", expected: "escalate angry", got: "reply
 * not_interested"}, in the cases' order.
 */
export function gradeDrill(cases, outcomes) {
  const list = Array.isArray(cases) ? cases : [];
  const wrong = [];
  for (const c of list) {
    const got = readOutcome(outcomes && Object.hasOwn(outcomes, c.key) ? outcomes[c.key] : null);
    if (!isRight(c.expect, got)) wrong.push({ key: c.key, expected: expectedText(c.expect), got: gotText(got) });
  }
  return { right: list.length - wrong.length, total: list.length, wrong };
}
