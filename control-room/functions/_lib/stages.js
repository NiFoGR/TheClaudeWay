// The prospect stage machine (pure; overview §5). nextStage says where an event takes a prospect; prospects.js's
// applyStageEvent is the only code that writes the result to prospects.stage. Later stages don't edit this file.

export const STAGES = Object.freeze(["ready", "emailed", "viewed", "replied", "needs_nik", "call_booked", "won", "lost"]);

// Every stage except won and lost.
export const OPEN_STAGES = Object.freeze(["ready", "emailed", "viewed", "replied", "needs_nik", "call_booked"]);

// prospects.lost_reason: opt_out, bounce and sequence_done are the event's own name; said_no carries not_now,
// not_interested or call (said no on the call).
export const LOST_REASONS = Object.freeze(["opt_out", "bounce", "sequence_done", "not_now", "not_interested", "call"]);

const NO_ROW = null; // no prospects row yet
const NOT_WON = STAGES.filter((s) => s !== "won");

// event → the stages it moves a prospect from, and where to. Anything not listed leaves the stage as it is.
const TRANSITIONS = new Map(
  [
    ["demo_ready", [NO_ROW, "ready"], "ready"],
    ["first_sent", ["ready"], "emailed"],
    ["demo_view", ["emailed"], "viewed"],
    ["inbound_human", ["emailed", "viewed", "call_booked"], "replied"],
    // only when lost_reason is not_now, not_interested, sequence_done or call: checked by the caller (stage 7)
    ["reopen", ["lost"], "replied"],
    ["escalate", OPEN_STAGES, "needs_nik"],
    ["nik_handled", ["needs_nik"], "replied"],
    ["call_confirmed", OPEN_STAGES.filter((s) => s !== "ready"), "call_booked"],
    ["call_cancelled", ["call_booked"], "replied"], // also a no-show
    ["said_no", OPEN_STAGES, "lost"],
    ["sequence_done", OPEN_STAGES, "lost"],
    ["paid", [NO_ROW, ...STAGES], "won"],
    ["opt_out", NOT_WON, "lost"],
    ["bounce", NOT_WON, "lost"],
  ].map(([event, from, to]) => [event, { from: new Set(from), to }]),
);

/**
 * The stage `event` moves a prospect in stage `current` to (null or undefined = no row yet). An event that doesn't
 * apply to `current`, or isn't an event at all, returns `current`. It doesn't know lost_reason: the "reopen only
 * after not_now, not_interested, sequence_done or call" rule is checked by its caller.
 */
export function nextStage(current, event) {
  const rule = TRANSITIONS.get(event);
  return rule && rule.from.has(current ?? NO_ROW) ? rule.to : current;
}
